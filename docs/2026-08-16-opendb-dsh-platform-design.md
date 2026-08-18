# opendb-dsh：基于 DeepSeek Harness 二次开发的 PostgreSQL 集群自动化管理平台 —— 方案 v0.8

> 类型：架构设计（v0.8，2026-08-17；P0 已通过（§12、§13.1 经验）；v0.6 + MVP 以 openGauss 为原型（C1 更新、D19 `ctx.db` 方言 seam、`tool-db`）；v0.5 + §8.4 时序与数据字典（TimescaleDB 同栈、collector class）+ D18；v0.4 + 记忆/知识子系统 §8.3（借鉴 airush：PG 真相 + Redis 缓存 + 图 + 向量）+ D16 镜像全量/按需加载 + D17 + 源码核实的三条修正（§13）；P0 已获准，进入实施计划）
> 依据：
> - dsh 本地安装源码 `~/.dsh/profiles/node_modules/@deepseek-ai/*`（**v0.1.0-rc.6**，195 包，逐包 README/patch/package.json 核对）
> - dsh 插件机制分析 `~/airush/docs/deepseek-harness-plugin-analysis.md`（rc.5 @ 47f9438；rc.6 未见结构性变化）
> - airush 仅作**设计模板**参考（逻辑有状态/进程无状态、PG 行状态机、记忆按实体归属），**不复用其代码**
>
> 在线版（图文排版）：https://claude.ai/code/artifact/fc856ca5-931a-4e18-b659-84636330c0b7
>
> 原则（user）：**能借用 dsh 功能和源码的就完全借用，不开发；需要开发的在其上改。**内核全部拿过来。§6 是完整的插件迁移清单。
>
> 阅读指南：结论看 §1；概念澄清看 §3；pod 形态裁决看 §4；**插件清单看 §6**；剩余待确认看 §14。

---

## 1. 一句话方案

**每个 pod 都是一棵完整的 dsh 树，pod 模板由 dsh profile 生成，跨 pod 只发生在 dsh 自己定义的 seam 上；所有 pod 只通过 PostgreSQL 会合，彼此没有接口调用。**

- dsh 的 Cordis 内核 + 全部策略插件 + 平台自研插件保持在同一进程里（它们是组合单元，不是部署单元）；
- 沿 dsh 的 capability seam 把**状态**（持久化 seam → PG/S3）、**turn 执行**（agent 工厂槽位 → 队列派发）、**主机操作**（fs/shell seam → SSH provider 组）切出 pod；
- 三种 pod 角色、同一镜像不同 profile：**Host pod**（dsh-web-app + 平台插件 = 统一控制台，复用 dsh Web UI）、**Runtime pod**（按 runtime class 分池、KEDA 伸缩、无状态）、**可选 Skill pod**（MCP）；
- agent 只是 PG 里一行逻辑身份，被管 PG 节点是 agent 的绑定关系；一个 agent 的 N 个 thread 由 N 个 Runtime pod 并行"扮演"；
- 记忆按**租户 + 数据库实体**归属持久化在 PG(+pgvector)，作为 `ctx.memory` seam 的 provider。

```
                    ┌──────────── Host pod（dsh-base + dsh-web-app + 平台插件；复用 dsh Web UI）────────────┐
  浏览器 ──Ingress──► │ 注册表(agent/节点/组) · 排程 · 审批(控制台+IM 插件) · preset 管理 · 会话 UI(dsh 原生) │
  (oauth2-proxy)     │ agent-loop 槽位 = 派发工厂：session.prompt → 写 thread_queue，事件从 PG tail 回灌   │
                    └───────────────────────────────┬──────────────────────────────────────────────┘
                                                    │ PostgreSQL = 唯一真相源（+ S3 大对象）
   ┌────────── Runtime 池（同一 dsh 镜像，profile = runtime class，Deployment ×N，KEDA）──────────────┐
   │ pool: pg-ops   [worker: 领取 turn → ctx.agents.resume → 真 agent-loop 执行 → 事件落 PG → 释放]  │
   │ pool: pg-rac … 进程内：内核 + 策略插件 + persistence-pg + memory-pg + tool-pg + exec-ssh + …    │
   └──────┬────────────────────────────┬─────────────────────────────┬────────────────────────────┘
          │ SSH（fs+shell 同一世界）     │ libpq（只读诊断/指标）        │ 可选 MCP（重型/隔离技能）
   ┌──────▼──────────────────────┐ ┌───▼──────────────────────┐ ┌───▼──────────┐
   │ k8s 外的 PostgreSQL 主机 ×N │ │ 同上（数据库端口）         │ │ Skill pods   │
   │ 只需 sshd + 平台专用账号     │ │                          │ │ 0→N（可选）  │
   └─────────────────────────────┘ └──────────────────────────┘ └──────────────┘
          LLM：runtime/host 内 dsh 自带 llm-deepseek / llm-pi-ai 直连（key 由 Secret 注入）
```

---

## 2. 目标与已确认决策

### 2.1 目标

- 管理**上千个 PostgreSQL 节点**（含 pgrac 类多活集群）：巡检、诊断、容量、故障处置建议与（经审批的）执行、变更编排、知识沉淀。
- 每个 PG 节点归属一个 **agent**（逻辑概念）；一个 agent 管多个节点/集群/组。
- agent ↔ 多个 Runtime pod，由 k8s 按被管节点规模自动伸缩。
- 平台能力以 dsh 插件方式扩展；用户选插件 → 生成不同的 pod 模板（profile）。
- 记忆保存在持久化组件里，pod 可随时销毁重建。

### 2.2 已确认决策（user 2026-08-16）

| # | 决策 | 对方案的影响 |
|---|---|---|
| C1 | 只管 PostgreSQL 系；**MVP 以 openGauss（og）为原型，先开发 og 插件**（user 2026-08-17） | 数据库能力层引入方言 seam `ctx.db`：MVP provider `db-opengauss`，P2 `db-postgres`；runtime class 首批 `og-ops`、`assistant`，P2 加 `pg-ops`/`pg-rac`；平台自身存储仍是 PostgreSQL |
| C2 | 被管节点在 k8s **外**；k8s 只承载 agent 集群本身 | 主机操作走 SSH，数据库操作走 libpq；不引入 connector 网关、sidecar |
| C3 | 与 airush 不同：**完全基于 dsh 已有代码二次开发** | 控制面 = dsh Host pod 上的插件；不引入 Go 控制面 |
| C4 | **复用 dsh Web UI** 作为平台统一控制台 | Host pod 跑 dsh-web-app；认证由 Ingress + `connection` 行替换解决；平台页面用 `ctx.slots.register` 挂进同一 app-shell |
| C5 | LLM 复用 dsh 已有能力 | 直接用 `llm-deepseek` / `llm-pi-ai`，不引入 LiteLLM；key 由 Secret → env → dsh `credentials`（env 层最高优先级） |
| C6 | MVP **预留**多租户框架 | 所有表带 `tenant_id`；scope 链携带 tenant；RLS 策略先建后开 |
| C7 | 上千节点 | 每 class 副本上限、分区、KEDA 参数按 2000 节点设计 |
| C8 | 审批：控制台 + IM 都支持，走插件 | `ctx.approval` provider + `approval-ui`（slots）+ `approval-im-*`（webhook 路由经 `ctx.webServer.register`） |
| C9 | 借用优先：能用 dsh 的就不开发 | §6 清单：195 包中约 150 原样、~10 只改配置、~12 换 provider、~20 禁用；自研 ~20 个新包 |

### 2.3 非目标（本期）

- 不改 dsh 内核源码、不 fork；只写 bundle patch + 插件包（dsh 版本钉死 `dsh.lock`）。
- 不做"可脱离 k8s 运行"的抽象。
- 不实现 Graphiti/Neo4j 记忆（留 `ctx.memory` seam）。
- 不做多 Host pod 水平扩展（MVP 单 Host；扩展路径见 §5.3）。

---

## 3. 核心概念（问答澄清汇总）

### 3.1 seam 是什么

**seam（接缝）= 系统里预留的可替换接口点**：换掉一侧的实现，另一侧不用改。在 dsh 里 seam 有精确定义——**三角色拆包**：

```
        ┌──────────────────────┐
        │  Service Definition  │  只定义"这个能力长什么样"（Cordis Service 抽象类/注册表），占一个 ctx.key
        └──────────┬───────────┘
        inject     │     inject
   ┌───────────────┴───────────────┐
   ▼                               ▼
┌──────────────┐            ┌──────────────┐
│   Provider   │            │   Consumer   │      Provider 与 Consumer 互不依赖，都只依赖 Definition
│ 真正实现能力  │            │ 使用这个能力  │
└──────────────┘            └──────────────┘
```

| seam（ctx key） | 定义了什么 | dsh 现有 Provider | 我们换成 |
|---|---|---|---|
| `ctx.shell` / `ctx.fs` / `ctx.subprocess` | 跑命令 / 读写文件 / 子进程 | `bash-local` / `fs-local` / `subprocess-local` | `exec-ssh`（成组，SSH 到 PG 主机） |
| `ctx.sessionPersistence` | 保存/读取会话事件 | `session-persistence-jsonl` | `session-persistence-pg` |
| `ctx.storage` | kv 存储 | `storage-json` | `storage-pg` |
| `ctx.attachments` / `ctx.spillStore` | 附件 / 大文本溢出 | `attachment-local` / `spill-local` | `attachment-s3` / `spill-s3` |
| `ctx.agents` 工厂槽位 | 创建/恢复一个 agent | `agent-loop`（本进程跑） | Host：`agent-loop-dispatch`；Runtime：原版 |
| `ctx.approval` | 一次性权限决策 | （web UI 应答者） | `approval-platform`（PG + 控制台 + IM） |
| `ctx.directoryPicker` | 选工作区目录 | native / browse | `directory-picker-agent`（选 agent） |
| `ctx.memory`（新增） | 记忆检索/写入 | — | `memory-pg`，将来 `memory-graphiti` |

**推论**：只在 seam 处跨 pod（换 Provider，Consumer 一行不改）；不在 seam 处的插件（`compaction`、`plan-mode` 等 waterfall 监听器）不能拆到别的 pod——它们没有"接缝"，硬拆要自造跨进程事件协议。

### 3.2 用户 / 数据库实例 / agent / pod / 插件的关系（三条轴）

```
 ┌── 授权轴（Host 侧，PG 里的关系，connection-auth / registry 判断）───────────────────────────────────┐
 │  用户 ──属于──► 租户 ──拥有──► agent（逻辑身份，PG 一行）──绑定──► 数据库实例 db_node（k8s 外 PG 主机）  │
 │    │ 被授权操作哪些 agent / 选哪些模板 / 批哪类动作      │ 五元组：class · preset · instruction_doc · model · skills │
 │    ▼                                                  ▼                                              │
 │  浏览器（dsh 原生 UI + slots 页）                    thread（= dsh session）：agent 的一次工作           │
 └───────────────────────────────────────────────────────┬────────────────────────────────────────────┘
                                                         │ PG：threads / thread_queue / rollout_events
 ═══════════════ 运行轴（谁来干活）═══════════════════════╪═════════════════════════════════════════════
   Host pod ×1（共享）──派发──► Runtime 池 <class>（同 class 所有 agent 共享）：任意空闲 pod 领走任意 thread
   agent 不"拥有"任何 pod；同一 agent 的 8 个 thread 可能散在 3 个 pod 上；池按队列 + 节点数伸缩
 ═══════════════ 插件轴（一个 Runtime pod 里面）═══════════╪═════════════════════════════════════════════
   镜像装全部包 → profile(class) 决定实例化哪些包（进程级，全池共享一份）
   → preset roster（每进程 mount 一次，多棵子树共存、各自 isolate）→ thread 按 agents.preset 绑到一棵子树（scope 可见性）
   → 再注入 agent 的 instruction_doc / 记忆 / 绑定节点（数据级）
```

| 轴 | 回答的问题 | 由谁决定 |
|---|---|---|
| 授权轴 | 这个**用户**能碰哪些 agent、选哪些模板、批哪类动作 | PG 里 user→tenant→agent 关系；Host 侧 `connection-auth` + `registry` |
| 运行轴 | 这个 agent 的活由**哪个 pod** 干 | 不指定——class 池里任意空闲 Runtime pod 领走 |
| 插件轴 | 这个 agent 的会话里**能用哪些插件** | 镜像装全集 → profile 决定池加载什么 → preset 决定会话绑哪棵工具子树 → agent 记录选 preset |

### 3.3 "不同模板插件不同"怎么处理：三层

| 差异类型 | 落到哪一层 | 需要新 pod 吗 |
|---|---|---|
| 开关/组合不同（要不要 `plan-mode`、只读 `tool-db` 还是给 `tool-bash`） | **preset**（`.agent-presets/<name>/agent.cordis.yml`） | 不需要，同一个池 |
| 提示词、模型、挂哪些 skill、管哪些节点 | **数据**（`agents` 表） | 不需要 |
| 需要**不同的 Provider 包**或**资源/安全隔离** | **class**（一份 profile → 一个池） | 需要，新开一个池 |

关键：**一个镜像装全部包，profile 只决定加载哪些行**——新建 preset、甚至新建 class 都不用重新构建镜像，只是多一份 YAML；只有引入全新的 npm 包才出新镜像。Runtime worker 领 thread 时查 `agents.preset`，用 dsh 的 `bindScopeParent`/`recompose` 把会话绑到池里对应 preset（dsh web 模式已有行为）。dsh 约束：preset 里只放"模型可见行"，注册表留进程层；preset 发布的服务必须在自己 `isolate` realm 内（`leakedServices()` 检查）。

### 3.4 一个逻辑 agent 包含几个 pod

**0 个自有的。** Host pod 全平台共享 1 个；Runtime pod 属于 class 池，agent 的每个 thread 在跑的那一刻由池里任意空闲 pod 领走。"agent 管的库越多 pod 越多"体现为：节点多 → 排程巡检 thread 多 → 队列深 → KEDA 给**它所在 class 的池**扩副本。要独占算力 → 给它单开一个 class（"拥有一个池"而非固定几个 pod）。

### 3.5 Host 与 Runtime 的关系：只经 PG，无接口调用

```
  Host #1 ─┐                                        ┌─ Runtime pg-ops #1
  Host #2 ─┼──► PG（thread_queue / rollout_events）◄─┼─ Runtime pg-ops #2
  Host #3 ─┘         唯一的会合点                     └─ Runtime pg-rac  #1
```

| 交互 | Host | Runtime | 表 |
|---|---|---|---|
| 派 turn | `INSERT thread_queue` | sweeper 轮询 → `UPDATE threads` 抢占 | `thread_queue` / `threads` |
| 进度 | tail `rollout_events` 推浏览器 | `appendBatch` 落库 | `rollout_events`（大 payload 落 S3） |
| 中断 | `INSERT queue(kind=interrupt)` | 每步检查 | `thread_queue` |
| 活性 | 读 `running_pod`/`heartbeat_at` | 定期心跳 | `threads` |
| 审批 | 用户/IM 决策写 `approvals` | `tools/pre-execute` 挂起后监听 | `approvals` |

推论：新 Host 无需向 Runtime 注册；Host 数与 Runtime 数无比例（各自 HPA/KEDA）；用户换 Host 不影响在跑的 turn；Host 全挂 Runtime 继续跑完手里的活；唯一耦合 = 同一 PG schema 版本 + 同一 `dsh.lock`。延迟：轮询 2s + tail 400ms，上量后加 `LISTEN/NOTIFY`（仍是 PG）。


### 3.6 产品模型：工作区 = agent，agent 下两类任务（user 2026-08-17）

opendb-dsh 不面向编码，**没有"文件夹/目录"概念**：dsh 侧栏里原本的"工作区（目录）"在这里就是一个个 **agent**（图标换成 agent）；agent 上配置**使用的插件（preset/class）**和**管理的数据库节点**；agent 下面有两类任务：

```
▣ agent-A（pg-ops · 12 个节点 · preset: 巡检只读）        ← 工作区 = agent；点开可配插件与节点
   💬 对话                                                ← 普通对话 thread（用户随时发起）
      · 2026-08-17 慢查询分析
      · 主库 WAL 堆积排查
   ⚙ 任务                                                ← 插件式任务：每类任务由一个"任务插件"支撑
      · [SQL 审核]   每日 02:00 · 最近一次 ✓ 3 条建议       ← task-sql-audit
      · [监控大盘]   实时 · 12/12 节点在线                   ← task-monitor-dashboard
      · [巡检]       每小时 · 最近一次 ⚠ 2 项               ← task-inspection
```

| 概念 | 落到 dsh 的哪里 | 我们做什么 |
|---|---|---|
| **agent 工作区** | dsh `workspaceRegistry`（原样）+ `ctx.directoryPicker` seam | `directory-picker-agent`（Host provider：选 agent 即选工作区，虚拟路径 `agent://<id>`）；`ui-agent-workspace`（客户端插件，替换 `dsh-client-ui-workspace`：agent 图标、agent 名称/节点数/preset 徽标、"配置 agent"入口） |
| **agent 配置页** | `ctx.slots.register` 挂进 dsh app-shell；表单用 dsh 自带的 `client-schema-form`（schemastery） | `registry` 插件的 slots 页：绑定节点/组、选 class + preset、instruction_doc、模型、启用的任务插件 |
| **普通对话** | dsh 原生 session（`thread.kind = chat`） | 不改：dsh 对话视图/工具树/计划/子代理 UI 全部照用 |
| **插件式任务** | `thread.kind = task:<type>`；每类任务是一个 **任务插件**（Cordis 插件，Host 半 + Runtime 半） | 新增 `ctx.tasks` seam（`@opendb-dsh/tasks`）：任务类型注册表；每个任务插件注册一种类型 |

**任务插件（task plugin）契约**：

```ts
ctx.tasks.registerType({
  id: 'sql-audit',                       // 任务类型
  name: 'SQL 审核', icon: '…',
  configSchema: Schema.object({...}),    // schemastery，Host 用 client-schema-form 直接渲染配置表单
  trigger: { kind: 'cron' | 'event' | 'continuous', ... },  // 定时 / 事件（告警 webhook）/ 常驻
  preset: 'sql-audit',                   // Runtime 侧用哪棵 preset 子树（工具集）
  buildPrompt(config, ctx) {...},        // 每次运行的输入（可引用绑定节点、上次结果）
  resultProjection: {...},               // 结构化结果落 PG（task_runs / task_results），供大盘与列表用
  ui: { list: Component, detail: Component, dashboard?: Component },  // 挂进 slots
})
```

- **Host 半**：任务列表/配置/结果页（slots）、`scheduler` 按 `trigger` 建 run（= 往 `thread_queue` 投一个 `task:<type>` thread）、事件型任务由告警 webhook 触发、常驻型任务（监控大盘）= 采集器 job + 异常时才拉起 agent 分析；
- **Runtime 半**：run 就是一个普通 thread，绑定该任务类型的 preset，跑完把结构化结果写 `task_results`（rollout 里存指针）；
- 任务与对话共享同一套持久化/审批/记忆，任务的一次运行可以"转成对话"继续追问（`fork` 已有 thread）。

首批任务插件（P1 起）：`task-inspection`（巡检，cron）、`task-sql-audit`（SQL 审核，cron）、`task-monitor-dashboard`（监控大盘，continuous，P2）、`task-incident`（告警处置，event，P2）。

### 3.7 P1 关闭项展开：`workflow` / `code-runtime` / `terminal`

| | `dsh-workflow`（+ worker-thread、tool-workflow、tool-ralph） | `dsh-code-runtime`（+ worker-thread、agent-tool-presentation） | `dsh-terminal`（+ terminal-bash、tool-bash-persistent） |
|---|---|---|---|
| **是什么** | 模型自己写 JS 编排脚本，`agent()` 桥接到 `ctx.subagents`，做多子代理编排；`tool-ralph` 在其上跑 Ralph 循环 | Code Mode：把全部工具暴露成代码运行时，模型写一段代码一次调很多工具 | 持久 PTY seam：给 agent 一个跨多轮存活的交互 shell；后端 node-pty（本地原生模块） |
| **执行在哪** | Runtime pod 内 worker thread（`env: {}`、`execArgv: []`，dsh 明说不是安全边界） | 同上 | Runtime pod 本地进程 |
| **P1 关的原因** | ① 模型写的 JS 在 worker thread 里仍能 `require('fs')`/`net`，而 Runtime pod 持有 PG DSN / SSH 私钥——真实越权面；② 依赖 `ctx.subagents`，P1 只有进程内 spawn/fork；③ 平台的插件式任务不需要模型写脚本 | 同 ①；P1 工具少，省往返收益不明显 | ① node-pty 只能开在 Runtime 本地，而 Runtime 零本地执行；② 持久 PTY 会把 thread 钉在 pod 上，与"任意 pod 领任意 thread"冲突 |
| **回来的方式** | **P2**：`subagent-queue` 后编排才有意义；引擎换进程外 provider `workflow-sandbox-job`（dsh workflow seam 明示可换引擎不改工具）：脚本投 sandbox Job pod，`agent()` 经队列回 Runtime 池，无凭据、限时限资源 | **P3**：`ctx.codeRuntime` 描述符已预留 `isolation: 'container'` → `code-runtime-sandbox-job` provider，同一 sandbox Job pod，工具调用经受控回程通道 | **P3**：`terminal-ssh` provider 实现 `ctx.terminals`（ssh2 shell channel = 远端 PTY），`tool-bash-persistent` 一行不改即得目标 PG 主机上跨轮存活的 `psql` 会话；配套：thread 有打开终端时 `ClaimTurn` 对 `running_pod` 软亲和（原 pod 不在才换并关终端、写事件告知模型）；排水先关终端 |
| **与插件式任务的关系** | 无依赖；是"高级 agent 临场编排多子代理"的加分能力 | 无依赖；P3 后适合"对 200 个节点各查一遍"类批量任务优化 | 无依赖；P3 后监控类任务可借远端 PTY 做 `\watch` 式持续采集（可选） |

一句话：三者 P1 关都因为"在持有凭据的 Runtime 进程里跑模型写的代码 / 开本地进程"与 D5 冲突；回来的方式都是 dsh 已给的 seam——换进程外/远端 provider，工具层不动。
**业界对照**：① Kubernetes 自己（scheduler 写 etcd、kubelet watch，互不调用）；② "PG 当队列"流派（Graphile Worker、pg-boss、River、Oban、GoodJob、Procrastinate，`SKIP LOCKED` + `LISTEN/NOTIFY`）；③ Temporal/Cadence（事件历史为真相源，任意 worker replay 接力）；④ LangGraph Platform（PG checkpoint + worker 池）。边界：PG 队列在每秒数千消息以上才吃亏，我们是每分钟几十个 turn。

---

## 4. pod 形态裁决与核心决策

### 4.1 裁决（user 提出的二选一）

**问题**：A) 尽量复用 dsh 架构，功能尽可能放一个 pod，用户选插件生成不同的 agent pod 模板；B) 把 dsh 拆开，runtime 与各插件跑在不同 pod。

**裁决：A 的精神 + 在 dsh seam 处有限拆分。**

| 方案 | 不能照字面做的原因 |
|---|---|
| 纯 A：每 agent 一个常驻全功能 pod | ① agent 需横跨多 Runtime pod，常驻 pod 做不到；② 状态落 pod 本地 → 升级/漂移丢会话，agent 数与算力绑死；③ 每 pod 一份 web 宿主，而宿主无认证/单宿主/粘性 |
| 纯 B：runtime 与各插件分 pod | dsh 插件是 Cordis fiber（注册即 effect、waterfall 进程内中间件、scope/isolate 同一棵树）；dsh **没有跨进程插件传输**，硬拆 = 自造协议，已不是 dsh |

落地：① 每 pod = 一棵完整 dsh 树 = `dsh-base` + 一份 profile 补丁（同一镜像）；② 只在 4 个 seam 跨 pod：持久化 → PG/S3、工厂槽位 → 队列派发、执行 → SSH、MCP/子代理（可选）；③ 三种角色 Host / Runtime / Skill（可选）；④ 平台自研能力全部是进程内 Cordis 插件。

**成立前提（P0 验证）**：`ctx.agents.setFactory` 槽位可替换；`sessionPersistence` 有可替换 `PersistenceBackend`；`readFrom(id, fromSeq)` 可 tail；agent 的 `session/event` 由持久化事件驱动 → Host 回灌远端事件即可让 dsh 原生 UI 无感显示。

### 4.2 决策清单

| ID | 决策 | 否决的备选 |
|---|---|---|
| D1 | agent = 逻辑身份（PG 一行），pod = 无差别扮演者 | 每 agent 固定 pod |
| D2 | Runtime 池按 runtime class 分池；同 class 的 agent 共享；大 agent 可独占 class | 单一全局池 / 每 agent 一池 |
| D3 | PG 唯一真相源；S3 大对象；Redis 只做可丢缓存（不承担正确性）；图/向量库是 PG 之上可重建的派生索引 | 消息中间件 / 多真相源 |
| D4 | 跨 pod 协调 = PG 行状态机（claim + heartbeat + stale 扫描） | leader election / 分布式锁 |
| D5 | Runtime 零本地执行：主机 → `exec-ssh`，数据库 → `tool-db`；动作类过审批 | 本地 `danger-full-access` |
| D6 | 审批三件套从旁介入：`tools/pre-execute` waterfall → `ctx.approval` → 一次性令牌 → provider 内白名单；无只读标注 fail-closed | 改 agent-loop |
| D7 | 记忆双层、按租户+实体归属；`ctx.memory` seam，MVP `memory-pg` | per-agent 命名空间 |
| D8 | 控制面 = dsh Host pod 上的插件；统一 Web = dsh 原生 UI + slots | Go 控制面 / 自建前端 |
| D9 | 伸缩双信号：runtime 按（队列 + 活跃线程/20），下限 `ceil(节点数/N)`；Host 按 WS 连接数 | 单信号 |
| D10 | 不 fork dsh：`dsh.lock` 钉版，只写 patch + 插件；CI：`--dump-config` + 真实 Loader e2e + PENDING 审计 | fork |
| D11 | pod 形态 = §4.1 | — |
| D12 | 主机执行走 SSH provider 组（平台专用账号 + 受限 sudo/命令白名单，密钥 Secret） | 在 PG 主机装 agent |
| D13 | 平台能力默认进程内插件；只有重型/隔离/非 TS 才出 MCP pod | 默认出 pod |
| D14 | Host 水平扩 = 按用户 cookie 粘性 + PG 共享注册表 + `NOTIFY` 桥接（自动，按用户摊）；租户分池 = 人工治理决策 | 自动搬迁租户 |
| D15 | 借用优先：dsh 有的原样用（含 `credentials-local` env 层、`settings-file` + initContainer 拷贝、`agent-presets` 文件源），不重写 | 全部替换 |
| D16 | **镜像装全部 195 个 dsh 包**，profile/preset 决定加载哪些行；"原样"是处理策略不等于加载（约 100 个 A+B 档实际加载，30 个按 class/阶段开，10 个不用） | 按需裁剪镜像 |
| D17 | 记忆/知识借鉴 airush 四分法：PG = 真相（rollout/Episode/指令）；Redis = 可丢热缓存；图库 = 逻辑知识（时序事实）；向量 = 语义知识（MVP pgvector，图谱向量随图走，不设统一向量库）；dsh 有 seam 的直接用（persistence/checkpoint/projection-cache/storage/system-prompt/skill），没有的新增（memory/knowledge/embeddings 三个 seam + provider） | 自研整套 / 全放 PG |
| D18 | 时序与字典：TimescaleDB 扩展装同一 PG（同备份域/RLS，预加载、钉版）；`ctx.metrics`/`ctx.dictionary` seam；采集器 = 无 LLM 的 `collector` runtime class 按节点数伸缩；字典用版本化快照 + 变更事件 | 独立时序库 / 采集塞进 agent 池 |
| D19 | 数据库能力层方言化：`ctx.db` seam（连接 + 方言元数据 + 目录/性能视图查询）；provider `db-opengauss`（MVP：`dbe_perf.*`/`gs_*` 视图、SHA256 认证适配、`gsql`/`gs_ctl` 工具链）→ `db-postgres`（P2）；`tool-db`/`collector`/`dictionary-pg`/任务插件只经 `ctx.db`，不直接依赖某一方言 | 每种数据库各写一套工具 |

---

## 5. 部署拓扑与伸缩

### 5.1 组件

| 组件 | Workload | 副本/伸缩 | 状态 | profile | 说明 |
|---|---|---|---|---|---|
| **host** | StatefulSet（MVP 1 副本） | HPA 按 WS 连接数（P3） | 无持久状态（`$DSH_HOME` emptyDir） | `host` | 统一 Web 入口：dsh 原生 UI + 平台 slots 页；注册表、排程、审批、`agent-loop-dispatch`；Ingress + oauth2-proxy 前置 |
| **runtime-\<class\>** | Deployment ×每 class | KEDA | 无 | `og-ops` / `assistant`（P2 加 `pg-ops` / `pg-rac`） | 队列 worker + 真 agent-loop；`exec-ssh`、`tool-db`、`memory-pg` |
| **collector** | Deployment | KEDA 按被管节点数 | 无 | `collector`（无 agent-loop、不接 LLM） | 采集 `pg_stat_*`/主机指标/数据字典 → TimescaleDB；异常 → incident |
| **skill-\<name\>**（可选） | Deployment / Job | 0→N | 无 | — | 仅重型/隔离技能（MCP） |
| **postgres**（+pgvector +timescaledb） | StatefulSet 或云托管 | 固定 | PVC Retain | — | 唯一真相源 + 时序（hypertable）；`shared_preload_libraries=timescaledb,pg_stat_statements`；本地部署走 CloudNativePG 主备 |
| **minio / S3** | StatefulSet 或云 | 固定 | PVC | — | attachments、spill、大 payload、冷归档 |
| **otel-collector**（可选） | Deployment | 1 | 无 | — | 脱敏 processor |
| **redis** | Deployment | 1 | 无 PVC（可丢） | — | 投影缓存/检索缓存（`storage-redis`）；不承担正确性；P2 默认 |
| **graph-db**（P3） | StatefulSet 或云托管 | 固定 | PVC | — | 逻辑知识（Entity/Relation/时序事实），`memory-graph` provider；PG 原文可重建 |

命名空间：`dsh-system`（host）、`dsh-runtime`（各池）、`dsh-skills`（可选）、`dsh-data`。

### 5.2 伸缩

| 组件 | 信号 | 公式/范围 |
|---|---|---|
| runtime-\<class\> | KEDA `postgresql` scaler ×2 | `desired = max(ceil((pending_queue + running_threads)/20), ceil(managed_nodes_of_class / nodes_per_replica))`；min 1（assistant 2）；冷却扩 60s/缩 300s；PDB maxUnavailable 1。2000 节点、每小时巡检一次、每次 ~2 min → 稳态 ~70 并发 → 4–6 副本，峰值 20 |
| host | HPA：每 pod WS 连接数（如 2000/副本） | MVP 固定 1；P3 打开 |
| skill | KEDA HTTP/并发 | 0→N |
| 存储类 | 不自动伸缩 | 容量告警 + 人工垂直扩 |

### 5.3 Host 水平扩展路径

```
 阶段 0（MVP）    阶段 1（榨干单 pod）        阶段 2（水平扩，P3）                 阶段 3（按租户分池）
 Host×1     ───► Host×1 + 静态资源交 CDN ───► Ingress cookie 粘性 → Host×N        租户 A ► Host 池 a
                 + 垂直加资源                 └── PG 共享注册表 + LISTEN/NOTIFY ──┘  租户 B ► Host 池 b
```

- Host 很薄（不跑 turn、不调 LLM），单 pod 撑几千 WS 长连接是常规量。
- 水平扩要处理的 dsh 约束：WS 只下行、断开整代重建 → **按用户 cookie 粘性**（不能随机分发）；会话/工作区注册表已换到 `storage-pg`/`persistence-pg` → 多 Host 读同一份；dsh 明说 `domain/changed` 是进程内事件 → 写 PG 顺带 `NOTIFY`，其它 Host `LISTEN` 后重发。
- **池内加减 pod 自动**（HPA，按用户摊：新登录/重连落到新 pod，旧连接不搬）；**跨池分租户人工**（注册表 `tenant → host_pool` + Ingress 路由，系统建议、人批准、留审计）。

---

## 6. dsh 插件迁移清单（rc.6，195 包）

分类含义：
- **原样**：不改代码，按 dsh 默认或 base/web-app 的 patch 行使用；
- **配置**：不改代码，只在我们的 profile patch 里改该行 `config`/`disabled`；
- **替换**：保留 Definition/Consumer，写我们的 Provider 整行替换（列出新包名）；
- **改造**：在 dsh 包基础上做小改（fork 单个包或 wrapper），非内核；
- **禁用**：不加载；
- **调试**：仅 `host-debug` profile 加载。

pod 列：H = Host，R = Runtime，HR = 两者，— = 不加载。

### 6.1 vendored 框架与启动基座（21）

| 包 | 作用 | 处理 | pod |
|---|---|---|---|
| `cordis` `cosmokit` `schemastery` `cordis-plugin-loader` `cordis-plugin-include` `cordis-plugin-group` `cordis-plugin-timer` | Cordis 内核、Loader、include、group、timer | 原样 | HR |
| `cordis-plugin-hmr` | 热重载 | 配置：`disabled: true` | — |
| `node-addon-landlock-run` | Linux Landlock 沙箱原生插件（可选依赖） | 禁用（Runtime 无本地执行） | — |
| `dsh` | launcher CLI（`--profile/--patch/--dump-config`） | 原样（容器 entrypoint） | HR |
| `dsh-base` | 78 行基础组合，每个 profile 的第一层 patch | 原样 | HR |
| `dsh-app-boot` `dsh-cmdline` `dsh-launch-environment` `dsh-home-paths` `dsh-atomic-write` `dsh-invariants` `dsh-brand` `dsh-timeout` `dsh-output-retention` `dsh-native-command` | 启动胶水、命令行、环境快照、路径、原子写、不变量注册表、类型/超时/保留原语、无 shell execFile | 原样 | HR |

### 6.2 内核：agent / session / tools / prompt / scope / llm（40）

| 包 | 作用 | 处理 | pod |
|---|---|---|---|
| `dsh-agent` | Agent 接口、注册表、`setFactory` 槽位、事件词汇 | 原样 | HR |
| `dsh-agent-loop` | 具体 agent 循环（AgentFactory 实现） | Runtime **原样**；Host **替换** → `@opendb-dsh/agent-loop-dispatch`（派发工厂，P0） | R 原样 / H 替换 |
| `dsh-agent-default-model` | 默认模型选择 | 配置（默认 deepseek 模型、reasoningEffort） | HR |
| `dsh-agent-tool-presentation` | 工具呈现选择（native / Code Mode / both） | 配置：`native` | R |
| `dsh-agent-presets` | 每会话 preset 组合（`agent.cordis.yml`） | 原样；preset 目录 P1 由 ConfigMap 挂载；P2 增 `@opendb-dsh/agent-presets-pg` provider | HR |
| `dsh-agent-instructions` | 读取工作区 AGENTS.md/CLAUDE.md | 替换 → `@opendb-dsh/instructions-pg`（从 PG 读 agent/租户 instruction_doc） | R |
| `dsh-session` | 事件溯源会话存储 | 原样 | HR |
| `dsh-session-checkpoint-policy` | 模型请求/工具副作用前的持久化检查点 | 原样 | R |
| `dsh-session-projection` `dsh-session-projection-cache` | 会话投影注册表 / 投影缓存 | 原样（缓存走 `storage-pg`） | HR |
| `dsh-session-stats` `dsh-session-reference` | 会话统计投影 / 跨会话引用 | 原样 | HR |
| `dsh-session-title` `dsh-session-title-llm` `dsh-session-title-first-prompt-llm` | 会话标题服务 + LLM 生成 | 原样，Host 启用；Runtime 配置禁用 LLM 生成 | H |
| `dsh-tools` | 工具注册表 + 执行流水线（pre/execute/post waterfall） | 原样 | HR |
| `dsh-system-prompt` | system prompt 组装注册表 | 原样 | HR |
| `dsh-scope` | scope 标签、scope 过滤事件分发 | 原样 | HR |
| `dsh-llm` `dsh-llm-deepseek` `dsh-llm-pi-ai` `dsh-llm-retry` | LLM seam、DeepSeek 适配器、pi-ai 适配器、重试策略 | 原样（key 由 env） | HR |
| `dsh-token-meter` | 回放感知 token 计量 | 原样 | R |
| `dsh-compaction` `dsh-compaction-basic` `dsh-compaction-tool-result-pruner` | 压缩 seam / token 驱动压缩 + LLM 摘要 / 工具结果裁剪 | 原样 | R |
| `dsh-persona` | 部署级 persona section | 配置（PG 运维平台 persona 文案） | R |
| `dsh-time-context` | 每步注入当前时间/耗时 | 配置：启用 | R |
| `dsh-repeat-tool-reminder` `dsh-tool-call-timeout-policy` | 重复调用提醒 / 工具超时 | 原样 | R |
| `dsh-plan-mode` | 每 agent 计划模式（含 /plan 命令） | 原样（由 preset 决定是否挂） | R |
| `dsh-goal` `dsh-goal-round-driver` `dsh-tool-goal` `dsh-command-goal` | 会话内目标状态/驱动/工具/命令 | 原样 | R（命令 H） |
| `dsh-schedule` | agent 内 after/at/固定频率提醒（事件溯源） | 原样（agent 自用；平台排程另见 `@opendb-dsh/scheduler`） | R |
| `dsh-commands` `dsh-command-compact` `dsh-command-feedback` `dsh-message-feedback` | 人类命令注册表 / compact / feedback / 消息评分 | 原样 | H（compact 也 R） |
| `dsh-user-questions` `dsh-tool-ask-user` | 向人提问 seam + 工具 | 原样（Host UI 应答；Runtime 上的提问经 rollout 回到 Host UI——P0 验证跨 pod 提问回路） | HR |
| `dsh-user-approval` | `ctx.approval` seam（一次性权限决策） | 原样 Definition；provider = `@opendb-dsh/approval-platform` | HR |
| `dsh-permission-presets` | 用户可见的权限预设 | 原样（Host 设置页） | H |
| `dsh-anonymous-user-id` | 遥测匿名 id | 禁用 | — |

### 6.3 持久化 seam（22）

| 包 | 作用 | 处理 | pod |
|---|---|---|---|
| `dsh-session-persistence` | 会话持久化 seam（含 `PersistenceCoordinator`） | 原样 | HR |
| `dsh-session-persistence-jsonl` | JSONL 后端 | **替换** → `@opendb-dsh/session-persistence-pg`（实现 `PersistenceBackend` 7 hook；>32KB payload 落 S3）**P0** | HR |
| `dsh-session-query` | 会话查询契约 | 原样 | H |
| `dsh-session-query-sqlite` | SQLite FTS5 后端（明确不支持多进程共享） | P1 配置 `openAt: never`；P2 替换 → `@opendb-dsh/session-query-pg` | H |
| `dsh-storage` `dsh-storage-domain` | 存储 hub / 领域数据形态（schema 校验 KV + 事件） | 原样 | HR |
| `dsh-storage-json` | JSON 文件 KV 后端 | **替换** → `@opendb-dsh/storage-pg`（`kv` facet backend；`NOTIFY` 桥接 `domain/changed`） | HR |
| `dsh-workspace` | 工作区实体注册表（走 storage domain） | 原样；**工作区 = agent** 的映射由 `registry` 维护 | H |
| `dsh-attachment` / `dsh-attachment-local` | 附件 seam / 本地内容寻址存储 | Definition 原样；local **替换** → `@opendb-dsh/attachment-s3` | HR |
| `dsh-spill` `dsh-spill-policy` / `dsh-spill-local` | 溢出 seam + 策略 / 本地文件 | 前两者原样；local **替换** → `@opendb-dsh/spill-s3`（locator `spill://` + 检索工具） | R |
| `dsh-settings` / `dsh-settings-file` | 设置 seam / settings.yaml 文件后端（带跨进程 .lock） | 原样：initContainer 把 ConfigMap 拷到可写 emptyDir，`watch: false`（写入不持久；P2 若需持久用户偏好再做 `settings-pg`） | HR |
| `dsh-credentials` / `dsh-credentials-local` | 凭据 seam / 四层来源（env > .credentials.yaml > .env） | 原样：Secret 注 env（最高优先级、只读） | HR |
| `dsh-jobs` / `dsh-jobs-local` | 后台任务注册表 / 进程内实现 | 原样（job 生命周期 ≤ turn） | R |
| `dsh-session-log-export` | Web 会话日志导出 | 原样 | H |
| `dsh-session-telemetry` / `dsh-session-telemetry-otel` | 遥测 seam / OTel 后端 | 原样，配置 `DISABLED`（开启只指向集群内 collector） | HR |

### 6.4 执行 seam 与沙箱（26）

| 包 | 作用 | 处理 | pod |
|---|---|---|---|
| `dsh-fs` `dsh-shell` `dsh-subprocess` | fs / shell / subprocess 三个 seam 的 Definition | 原样 | R |
| `dsh-fs-local` `dsh-bash-local` `dsh-subprocess-local` | 本地实现 | **替换** → `@opendb-dsh/exec-ssh`（一个包成组 provide `ctx.fs`+`ctx.shell`+`ctx.subprocess`，目标 = thread 绑定节点的 `ssh_target`）**P2** | R |
| `dsh-fs-observation-policy` | 读后写、版本守卫（叠在 ctx.fs 上） | 原样（对 ssh provider 同样生效） | R |
| `dsh-fs-sandbox` `dsh-bash-sandbox` `dsh-sandbox` `dsh-sandbox-local` `dsh-sandbox-policy` `dsh-sandbox-windows-acl` | 沙箱 seam 与后端 | 禁用（Runtime 无本地执行；bwrap/Landlock 在容器内 fail-closed） | — |
| `dsh-pwsh-local` `dsh-pwsh-sandbox` `dsh-tool-pwsh` | PowerShell | 禁用（Linux 目标） | — |
| `dsh-shell-env` | 托管 `DSH_*` shell 环境注册表 | 原样（`exec-ssh` 决定是否注入远端） | R |
| `dsh-terminal` `dsh-terminal-bash` `dsh-tool-bash-persistent` | 持久 PTY seam / node-pty 后端 / 持久 bash 工具 | P1 禁用；P3 可选（远端 PTY provider） | — |
| `dsh-code-runtime` / `dsh-code-runtime-worker-thread` | 代码执行 seam / worker-thread 实现（非安全边界） | P1 禁用；P3 可选 sandbox Job provider | — |
| `dsh-workflow` `dsh-workflow-worker-thread` `dsh-tool-workflow` `dsh-tool-ralph` | 工作流 seam / worker-thread 引擎 / 工具 / Ralph 循环 | 原样但 P1 由 preset 关闭；P2 随 `subagent-queue` 开启 | R |
| `dsh-mcp-client` | MCP 客户端桥（把远端工具注册到 ctx.tools） | 原样（endpoints 由 preset/PG 给出；仅重型技能） | R |
| `dsh-web` `dsh-web-search-deepseek` `dsh-tool-web` | web seam / DeepSeek 搜索 / web 工具 | 原样，按 class 可选（`assistant` 开） | R |
| `dsh-tool-cordis` `dsh-cordis-host-runner` `dsh-cordis-client-runner` | 模型热挂插件（自引用） | 调试 profile；生产禁用 | 调试 |

### 6.5 模型可见工具（13）

| 包 | 作用 | 处理 | pod |
|---|---|---|---|
| `dsh-tool-fs` `dsh-tool-str-replace-editor` | read/write/edit、view/replace/insert（over ctx.fs） | 原样（provider 换 ssh 后透明生效） | R |
| `dsh-tool-fs-search` | glob/grep（**依赖本机打包的 ripgrep**） | **改造** → `@opendb-dsh/tool-fs-search-ssh`（远端 `rg`/`grep`）或由 `exec-ssh` 提供远端 rg | R |
| `dsh-tool-bash` | bash 工具（over ctx.shell，含后台 job/升权字段） | 原样 | R |
| `dsh-tool-todo` `dsh-tool-skill` `dsh-tool-jobs` | todo / 加载技能 / 后台任务控制 | 原样 | R |
| `dsh-tool-subagent` `dsh-tool-subagent-control` `dsh-tool-subagent-report` | 子代理委派/控制/汇报 | 原样 | R |
| `dsh-tool-goal` `dsh-tool-ask-user` `dsh-tool-web` `dsh-tool-workflow` `dsh-tool-ralph` `dsh-tool-pwsh` `dsh-tool-cordis` `dsh-tool-bash-persistent` | 见 6.2/6.4 | 见对应行 | — |

### 6.6 技能与子代理（8）

| 包 | 作用 | 处理 | pod |
|---|---|---|---|
| `dsh-skill` `dsh-skill-filesystem` | 技能注册表 / 文件系统技能源 | 原样（技能目录由镜像/ConfigMap 提供；P2 可加 `skill-pg`） | R |
| `dsh-skill-badge` | 内置 badge 技能 | 禁用（base 默认也禁） | — |
| `dsh-subagent` `dsh-subagent-in-process-driver` `dsh-subagent-spawn-in-process` `dsh-subagent-fork-in-process` | 子代理 seam / 进程内驱动 / spawn / fork | 原样；P2 增 `@opendb-dsh/subagent-queue` provider | R |

### 6.7 Host / Web 宿主（22）

| 包 | 作用 | 处理 | pod |
|---|---|---|---|
| `dsh-web-app` | 浏览器面 bundle（web-app patch 层 + 运行时胶水） | 原样（Host profile 第二层 patch） | H |
| `dsh-web-frontend` | vite 构建的前端 dist | 原样 | H |
| `dsh-host-webserver` | HTTP/upgrade 路由注册、静态兜底 | 配置：`host: 0.0.0.0, port: 3080`（CLI 拒绝 0.0.0.0，profile patch 不受限） | H |
| `dsh-host-frontend-static` `dsh-host-apiproxy` `dsh-api-gateway` `dsh-api-remotes` `dsh-typert-loader` `dsh-typert-protocol` `dsh-typert-registry` | SPA 服务、API 网关、Remote BFF、typert RPC 契约 | 原样 | H |
| `dsh-client-connection` | 客户端连接层 + trust fence（无认证；特权 RPC 仅 loopback） | **替换/改造** → `@opendb-dsh/connection-auth`（保留 fence；读 Ingress 身份头 → 用户/租户上下文；特权 RPC 按角色） | H |
| `dsh-host-plugin-inventory` | 只读 Loader 插件清单 Remote | 原样（管理员） | H |
| `dsh-host-directory-picker` / `-auto` `-browse` `-native` | 工作区目录选择 seam / 三种后端 | Definition 原样；三个后端禁用；**替换** → `@opendb-dsh/directory-picker-agent`（"选目录"= 选 agent，工作区 = agent） | H |
| `dsh-headless` | 一次性 CLI bundle | 原样，可选 CronJob 形态 | Job |
| `dsh-workspace`（见 6.3）`dsh-session-log-export`（6.3）`dsh-message-feedback`（6.2） | — | — | H |

### 6.8 浏览器 UI 插件（38）

| 包 | 作用 | 处理 |
|---|---|---|
| `dsh-client-web` `dsh-client-web-react` `dsh-client-runtime` `dsh-client-modules` `dsh-client-locale` `dsh-client-schema-form` | Web 壳内核、React 胶水、Slot 注册/会话运行时、模块系统、中英文、设置表单模型 | 原样 |
| `dsh-client-hmr` | 开发热重载 | 禁用 |
| `dsh-client-ui-slots` `dsh-client-ui-layout` `dsh-client-ui-primitives` `dsh-client-ui-theme` | 插槽核心 / 三栏布局 / 原子组件 / 主题 | 原样（平台页面用 `ctx.slots.register` 挂进同一 app-shell） |
| `dsh-client-ui-sidebar` | 会话树侧栏（多级树/分组/搜索） | 原样；分组改为"agent → 对话 / 任务"（配置或小改造，P1 验证） |
| `dsh-client-ui-workspace` | 工作区（目录）选择器 | 替换 → `@opendb-dsh/ui-agent-workspace`（agent 图标、名称/节点数/preset 徽标、配置入口） |
| `dsh-client-ui-conversation` `dsh-client-ui-tool` `dsh-client-ui-trajectory` `dsh-client-ui-plan` `dsh-client-ui-goal` `dsh-client-ui-jobs` `dsh-client-ui-subagent` `dsh-client-ui-skill` `dsh-client-ui-workflow-run` `dsh-client-ui-deliverables` `dsh-client-ui-attachment` `dsh-client-ui-user-questions` `dsh-client-ui-message-feedback` | 对话、工具调用树、轨迹、计划、目标、任务、子代理、技能、工作流、产出文件、附件、提问、评分 | 原样（远端 turn 事件回灌后全部照常渲染） |
| `dsh-client-ui-commands` `dsh-client-ui-input-trigger` `dsh-client-ui-model-selection` `dsh-client-ui-permission-presets` `dsh-client-ui-agent-preset` | 命令面板、`/` `@` 触发、模型选择、权限预设、preset 编辑 | 原样（preset 编辑 P2 接 `agent-presets-pg`） |
| `dsh-client-ui-settings` `-general` `-models` `-plugins` `-plugin-inventory` | 设置域 | 原样（settings/credentials 页在远程浏览器受 dsh loopback 限制——由 `connection-auth` 按管理员角色放行或隐藏） |
| `dsh-client-ui-directory-picker-browse` `-native` | 目录选择 UI | 禁用（由 `directory-picker-agent` 的 UI 替代） |
| `dsh-client-ui-cordis` | 动态插件卡片 | 调试 |

### 6.9 汇总

| 处理 | 数量（约） | 说明 |
|---|---|---|
| 原样 | ~150 | 含全部内核、全部策略插件、全部 UI、Host 宿主、LLM、技能、子代理 |
| 配置 | ~10 | `hmr`、`webserver` host、`agent-tool-presentation`、`persona`、`time-context`、`session-title-llm`（R 关）、`telemetry`、`session-query-sqlite openAt`、`agent-default-model` |
| 替换（写 provider） | 13 | `agent-loop`(H)、`session-persistence-jsonl`、`storage-json`、`attachment-local`、`spill-local`、`session-query-sqlite`(P2)、`fs-local`+`bash-local`+`subprocess-local`（合为 `exec-ssh`）、`agent-instructions`、`client-connection`、`directory-picker-*`、`client-ui-workspace` |
| 改造 | 1 | `tool-fs-search`（远端 rg） |
| 禁用 | ~20 | 沙箱全家、pwsh、terminal/PTY、code-runtime、cordis runner、directory-picker 后端、client-hmr、anonymous-user-id、skill-badge、landlock |
| 新增（自研） | ~40 | 见 §11（含记忆/知识族 ~15 个、时序/字典族 6 个） |

---

## 7. 两个 profile 的组成

### 7.1 `host` profile（dsh-base + dsh-web-app 之上）

| 动作 | 行 | 说明 |
|---|---|---|
| 替换 | `agent-loop` → `@opendb-dsh/agent-loop-dispatch` | AgentFactory 代理：`prompt` 写队列；tail PG 回灌 session/event |
| 替换 | 持久化：`session-persistence-jsonl`→pg、`storage-json`→pg、`attachment-local`→s3、`session-query-sqlite`→（P1 `openAt: never`） | 与 Runtime 共享同一后端 |
| 替换 | `connection` → `@opendb-dsh/connection-auth`；`directory-picker` → `@opendb-dsh/directory-picker-agent` | 认证 / 工作区=agent |
| 配置 | `webserver` → `{host:'0.0.0.0', port:3080}`；`connection.trustedHosts` 列 Ingress 权威；`hmr`/`client-hmr` disabled | — |
| 保留 | `settings-file`（initContainer 拷 ConfigMap 到 emptyDir）、`credentials-local`（env） | 不开发 |
| 插入 | `registry`、`scheduler`、`approval-platform`、`approval-ui`、`approval-im-feishu`/`-dingtalk`、`agent-presets-pg`(P2)、`tenant-context` | 全部进程内插件 |
| 禁用 | `directory-picker-auto/browse/native`、`plugin-inventory`（或仅管理员）、`anonymous-user-id`、`cordis-host-runner`（调试 profile 开） | — |

### 7.2 `runtime-<class>` profile（dsh-base 之上，不含 web-app）

| 动作 | 行 | 说明 |
|---|---|---|
| 保留 | `agent-loop`（原包）、全部策略插件、`llm-*`、`jobs-local`、`credentials-local`、`schedule`、`skill-filesystem` | 真执行 |
| 替换 | 持久化五件套 → PG/S3；`spill-local` → `spill-s3` | — |
| 替换 | `subprocess`/`bash-sandbox`/`fs-sandbox`/`shell-env` 相关 → `@opendb-dsh/exec-ssh`（P2；P1 无执行 provider，工具集只含 `tool-db`） | 同一执行世界 |
| 替换 | `agent-instructions` → `instructions-pg`；`tool-fs-search` → `tool-fs-search-ssh`（P2） | — |
| 禁用 | `sandbox`/`sandbox-policy`/`sandbox-local`、`hmr`、`session-title-llm`、`web`（除 assistant class）、`terminal*`、`code-runtime*` | — |
| 插入 | `runtime-worker`（sweeper/claim/heartbeat/drain/healthz）、`tenant-context`、`approval-platform`（`tools/pre-execute` 半边）、`memory` + `memory-pg`、`instructions-pg`、`tool-db`、`subagent-queue`(P2) | — |
| preset | `.agent-presets/<preset>/agent.cordis.yml` 定义模型可见行；`isolate: {planMode: true}`；P1 ConfigMap → P2 `agent-presets-pg` | — |

**环境面**：`DSH_HOME=/var/lib/dsh`（emptyDir，镜像预烘焙 `profiles/node_modules`）、`DSH_PERMISSION_MODE=read-only`、`DSH_TELEMETRY_MODE=DISABLED`、`DEEPSEEK_API_KEY` / `PG_DSN` / `S3_*` / `SSH_KEY_PATH` 由 Secret；`terminationGracePeriodSeconds: 330`。

---

## 8. 数据与持久化

### 8.1 PostgreSQL schema 概要

| 表 | 关键列 | 说明 |
|---|---|---|
| `tenants` / `users` / `agents` / `db_nodes` / `db_groups` | `agents.runtime_class, preset, instruction_doc, instruction_version`；`db_nodes.agent_id, group_id, group_role, host, port, ssh_target`；用户→租户→agent 授权 | 注册表（Host `registry` 插件维护） |
| `threads` | `(tenant_id,id) PK, agent_id, kind, parent_thread_id, status(idle\|running\|interrupted\|archived), running_pod, heartbeat_at, last_seq, model, metadata` | dsh session 元数据 |
| `rollout_events` | `(tenant_id, thread_id, seq, created_at) PK`，按月 RANGE 分区；`payload ≤32KB`，超出 `payload_ref → s3://`；只授 SELECT/INSERT | dsh 持久会话事件 |
| `thread_queue` | `kind(steer\|queued\|interrupt), admitted_turn_id NULL=待接纳, runtime_class` | 唯一入口 |
| `approvals` | `thread_id, tool_call_id, action_kind, target_node, token_hash, expires_at, channel, decided_by, decided_at, result` | 控制台/IM 共用 |
| `kv_store` | `(tenant_id, domain, key) PK, value jsonb` | dsh `storage` kv facet 后端（含 workspace 注册表、投影缓存） |
| `memory_episodes` / `memory_facts` | `entity_type, entity_id, text, embedding vector, valid_at, invalid_at, source_thread, tsv` | pgvector + FTS；RRF 混合检索 |
| `presets` / `skills` | preset yaml + version；`skill_id → endpoint/read_only` | P2 |
| `metrics.*` | `tenant_id, node_id, ts, …`（可选 timescaledb） | `tool-db` 采集；rollout 只存指针 |

租户隔离：全部业务表带 `tenant_id`，P1 建 RLS 策略不 FORCE；`tenant-context` 保证访问在 `InTenantTx` 内；P3 FORCE。

### 8.2 对象存储

`attachments/v1/<sha256>`、`spill/<tenant>/<thread>/<name>`、`rollout/<tenant>/<thread>/<seq>`、`archive/`；S3 生命周期策略 GC。

### 8.3 记忆与知识子系统（借鉴 airush：PG 真相 + Redis 可丢缓存 + 图 = 逻辑知识 + 向量 = 语义知识）

**dsh 本身没有记忆管理/知识库插件**：它把"记忆"外包给工作目录里的 markdown（`agent-instructions` 读、`tool-fs` 写）和追加式会话日志（persistence + compaction + spill + `@` 引用 + 全文检索）。这些机制**全部保留**，只在"读文件"的接口处换成读 PG，并新增一套按 dsh seam 方式设计的记忆/知识插件族。

**airush 记忆设计 → dsh 对应 → 我们的处理**：

| airush 设计 | 目的 | dsh 是否已有 | 处理 |
|---|---|---|---|
| rollout 事件流落 PG（SSOT，pod 宕机不丢） | 持久化上下文 | ✅ seam：`dsh-session-persistence` + `session-checkpoint-policy` | provider → `session-persistence-pg`（P0）；checkpoint 原样；宕机 → PG 行状态机标 interrupted → 任意 Runtime `resume` |
| Redis 热缓存（装配好的上下文、检索缓存；**可丢，RPO=∞**） | 换 pod 不必从头重放/重检索 | ✅ seam：`dsh-session-projection-cache`（每会话投影检查点，write-behind，走 `storage`）+ `dsh-storage` `kv` facet | 新增 `storage-redis`（`kv` backend），投影缓存/检索缓存指向它；PG 仍是真相；P1 可选、P2 默认 |
| Redis 幂等键 / 会话锁 | 防重、单写者 | dsh 无 | **不用 Redis 承担正确性**：会话锁 = PG 行状态机（claim/heartbeat）；幂等 = `(thread_id, seq)` 唯一约束 |
| 常驻指令层（agent/租户 markdown 存 PG，每 turn 注入） | 确定性记忆 | ✅ 对应物 `dsh-agent-instructions`（读文件） | 替换 → `instructions-pg`（`agents.instruction_doc` + `instruction_version`） |
| 图数据库（Neo4j + Graphiti：Entity/Relation/Episode，`valid_at/invalid_at`；**逻辑知识**） | 结构化、带时间的事实；矛盾不删只失效 | ❌ 无 | 新增 `memory` Definition + `memory-graph` provider（经 Graphiti 写入管道：去重、实体合并、时序失效；业务代码禁止绕过直写图库） |
| 向量：图谱内 embedding 跟图走（Neo4j 向量索引），文档 embedding 走 pgvector；**不设统一向量库**；**语义知识** | 语义检索 | ❌ 无 | `memory-pg`（pgvector：episode 向量 + FTS，MVP）、`knowledge-pg`（文档 chunk 向量）；P3 图谱向量随 `memory-graph` 进图库；`knowledge-vector`（Qdrant 等）仅在 pgvector 不够时替换 |
| Episode 原文即 SSOT；LLM 只在摄入侧；检索三路混合（向量 + BM25 + 图）RRF | 质量 + 成本 | ❌ 无 | `memory-ingest`（Runtime 侧抽取）+ `memory-context`（每 turn `systemPrompt.section('memory')`）+ `embeddings` seam |
| 记忆按租户 + 实体归属，不按 agent | agent 重划分零搬迁 | — | D7 |
| 租户记忆 → 平台知识：脱敏 → 泛化 → 审核，禁止自动流动 | 合规 | — | `knowledge-ingest` 审核流（P2） |

**插件族（seam 形态）**：

```
                 ┌──────────────── Definition（seam，进程内抽象类）────────────────────────┐
                 │ ctx.memory      情景/事实记忆：remember(episode) · facts(entity) ·        │
                 │                 search(query,{entity,kinds,k}) · invalidate(fact)        │
                 │ ctx.knowledge   知识库：addDocument · chunks · search(query,{ns,k})       │
                 │ ctx.embeddings  向量化：embed(texts) → float[][]（模型可换）             │
                 └──────────┬───────────────────────┬──────────────────────┬────────────────┘
   Providers（可换）        │                       │                      │
   ┌──────────────────┐ ┌──▼──────────────┐ ┌──────▼─────────┐ ┌──────────▼───────────┐
   │ memory-pg (MVP)  │ │ memory-graph    │ │ knowledge-pg   │ │ embeddings-openai-   │
   │ episodes/facts   │ │ Neo4j/Graphiti  │ │ (MVP) 文档+chunk│ │ compat / -local      │
   │ + pgvector + FTS │ │ 实体/关系/时序   │ │ + pgvector      │ │ (bge via vLLM/Ollama)│
   └──────────────────┘ └─────────────────┘ └────────────────┘ └──────────────────────┘
   缓存：storage-redis（kv backend）← session-projection-cache / 检索缓存（可丢）
   Consumers（不随后端变）：
   memory-context   每 turn systemPrompt.section('memory')：按 thread 绑定节点/组 + 当前问题做混合检索注入
   tool-memory      memory_search / memory_note / knowledge_search（模型可见工具）
   memory-ingest    Runtime：agent/turn-stopping + task 结果 → 抽取候选事实（LLM）→ ctx.memory.remember
   knowledge-ingest Host：上传/抓取（md/pdf/html/故障报告）→ 分块 → embed → ctx.knowledge.addDocument；审核流
   ui-memory / ui-knowledge  slots 页：按节点/集群看记忆时间线；知识库上传/标签/命名空间/审核
```

**数据放哪**（真相源全部在 PG；图与向量是可重建的派生索引；磁盘上不再有记忆文件）：

| 数据 | 后端 |
|---|---|
| 常驻指令（agent/租户 markdown，仍是 md 文本） | PG（`agents.instruction_doc`） |
| Episode 原文（对话摘要、巡检结论、事故报告、人工录入） | PG（SSOT） |
| Fact / Entity / Relation（`valid_at/invalid_at`） | 图数据库（P3）；MVP 先 PG 表 |
| Episode / chunk 向量 | MVP pgvector（同一 PG）；上量后专用向量库 |
| 知识库文档 | 元数据 + 原文 PG，向量在向量库；命名空间 `tenant:{id}` / `platform` |
| 程序性知识（SOP） | dsh skill（文件；P2 `skill-pg`） |
| 装配好的上下文 / 检索缓存 | Redis（可丢） |
| 会话日志（短期记忆） | PG（`session-persistence-pg`） |

**保留不动的 dsh 记忆机制**：会话日志 + `resume`、`compaction-basic`/`tool-result-pruner`（遗忘策略）、`spill`（大结果外置）、`skill`（程序性知识）、`session-reference`（`@` 引用）、`session-query`（全文检索历史会话，P2 → pg）、`fork`。

**分阶段**：P1 = 三个 Definition + `memory-pg` + `knowledge-pg` + `embeddings-openai-compat` + `memory-context` + `tool-memory` + `memory-ingest`（规则/轻量 LLM）+ `instructions-pg`；P2 = `knowledge-ingest` 完整版 + `ui-memory`/`ui-knowledge` + `storage-redis` 默认开 + `skill-pg` + `session-query-pg`；P3 = `memory-graph` + `knowledge-vector`（只换 provider 行）。

**待定**：embedding 模型来源（DeepSeek 无 embedding API → 默认 OpenAI 兼容接口，指向 vLLM/Ollama 的 bge-m3 或云端服务）；图数据库选型（Neo4j vs 其它，P3 前定）。

---

### 8.4 时序与数据字典（借鉴 airush：TimescaleDB 同栈；指标 + 字典变化）

dsh 同样没有指标/字典类插件，按 seam 新增：

```
                 ┌──────────── Definition（seam）─────────────────────────────────────┐
                 │ ctx.metrics     write(series[]) · query(node, metric, range, agg)         │
                 │ ctx.dictionary  snapshot(node) · diff(node, from, to) · history           │
                 └──────────┬────────────────────────────────┬─────────────────────────┘
   Providers（可换）        │                                │
   ┌────────────────────────▼──────┐              ┌──────────▼───────────────────────┐
   │ metrics-timescale (MVP)       │              │ dictionary-pg (MVP)              │
   │ 同一 PG 加 timescaledb 扩展    │              │ 版本化快照表 + 变更事件 hypertable │
   │ hypertable(tenant, node, ts)  │              │ (表/列/索引/参数/扩展/角色…)      │
   │ 连续聚合 + 压缩 + 分级保留     │              └──────────────────────────────────┘
   └───────────────────────────────┘   将来：metrics-victoria（>5000 实例时换 provider）
   Producers：collector（纯代码、不调 LLM；按节点周期拉 pg_stat_* / 系统指标 / 数据字典；异常规则 → task-incident；DDL 变化 → 变更事件）
   Consumers：tool-metrics（metrics_query / dictionary_diff）· task-monitor-dashboard（读连续聚合）· task-inspection / task-sql-audit（基线）· memory-ingest（异常/字典变化摘要 → Episode）
```

- **采集器 = `collector` runtime class**：一棵没有 agent-loop、不接 LLM 的 dsh 树（只装 `collector` + `metrics-timescale` + `dictionary-pg` + PG 连接层），Deployment 按被管节点数伸缩；`scheduler` 按节点/组投 `kind=collect` 任务，不占 agent 池与 LLM 配额。
- **数据放哪**：

| 数据 | 后端 | 说明 |
|---|---|---|
| 监控样本（`pg_stat_database/activity/replication/bgwriter`、锁等待、WAL、连接数、慢查询计数、主机 CPU/内存/磁盘） | TimescaleDB hypertable `metrics_samples(tenant_id, node_id, metric, ts, value, labels)` | `(tenant_id, node_id)` 空间分区 + 时间分块；连续聚合 1m/1h；7 天后压缩；原始保留 90 天、聚合 1 年 |
| 数据字典快照（表/列/索引/约束/序列/函数/扩展/角色/`pg_settings`） | PG 常规表 `dict_snapshots(node_id, taken_at, kind, object_key, definition_hash, definition jsonb)` | 只存变化的对象（hash 去重），首次全量 |
| 字典变更事件（DDL diff、参数变更） | hypertable `dict_changes(tenant_id, node_id, ts, kind, object_key, change, before_ref, after_ref)` | 供 `dictionary_diff` 与告警 |
| rollout 引用 | `rollout_events` 只存指针（查询参数 + 结果摘要 + 时间范围） | 控制 rollout 体量 |

- **D18**：MVP 用 TimescaleDB 扩展装在同一 PG 集群（同一备份域、同一 RLS；`shared_preload_libraries=timescaledb,pg_stat_statements` 必须预加载；镜像版本钉死不用 `latest`——三条 airush 踩过的坑）；`ctx.metrics` 留 seam，>5000 实例或写入吃紧换 `metrics-victoria`。字典变化用"版本化快照 + 变更事件"而非指标模型（稀疏、结构化、需 diff）。
- **阶段**：P1 = `metrics`/`dictionary` Definition + `metrics-timescale` + `dictionary-pg` + `collector`（核心十余指标 + 字典快照）+ `tool-metrics`；P2 = 大盘读连续聚合、异常规则 → incident、DDL 告警；P3 = `metrics-victoria`（可选）。

---

## 9. Turn 生命周期

```
用户在 dsh UI 发消息 / scheduler 触发
  Host: agent-loop-dispatch.prompt() → INSERT thread_queue(kind=queued, runtime_class)   ─┐
  Runtime-worker(sweeper 2s): SELECT … WHERE admitted_turn_id IS NULL AND class=$mine     │
    → ClaimTurn: UPDATE threads SET status=running, running_pod=$me, heartbeat_at=now()    │ PG
        WHERE status IN (idle,interrupted)  → 否则跳过                                       │ 行状态机
    → 查 agents.preset → bindScopeParent 到对应 preset 子树                                  │
    → ctx.agents.resume(threadId)（真 agent-loop 从 persistence-pg 重放）                   │
    → 提交输入 → 跑 turn → 事件经 persistence-pg appendBatch 落库                             │
    → heartbeat（WHERE running_pod=$me）                                                   │
    → turn/end → status=idle, running_pod=NULL, admitted_turn_id=turn_id                   ─┘
  Host: persistence-pg.readFrom(threadId, last_seq) tail → 回灌 session/event → dsh UI 实时显示
中断: Host INSERT queue(kind=interrupt) → 持有该 thread 的 worker 下一 step 检查 → agent/pre-step reject
排水: preStop → 停领取 → 等在飞 turn ≤300s → 超时先让 agent 自中止 3s → 仍不响应写 turn_aborted 释放
孤儿: 任一 worker 周期性 MarkStaleRunningInterrupted(heartbeat < now-2×间隔) → 可被重新领取
```

**P0 备选**：若 dsh `Agent` 接口面太宽、代理成本高，则 Host 对**交互式 chat thread 在本进程跑真 loop**（Host 也装 `exec-ssh`/`tool-db`），只有排程/批量 thread 走 Runtime 池；UI 完全不变。

---

## 10. 执行与安全

| 面 | 机制 |
|---|---|
| Host 认证 | Ingress + oauth2-proxy（或企业 IdP）→ 身份头 → `connection-auth` 建立用户/租户上下文；未认证在 Ingress 层即拒 |
| Runtime 零本地执行 | 不装本地 shell/fs/sandbox；`DSH_PERMISSION_MODE=read-only`；`readOnlyRootFilesystem`、drop ALL、nonroot |
| 主机操作 | `exec-ssh` → 每节点 `ssh_target`；平台专用账号、密钥在 Secret、`authorized_keys` 加 `command=`/`from=` 限制；动作类命令需一次性令牌 + 命令白名单（provider 内校验） |
| 数据库操作 | `tool-db`：只读工具（`readOnly: true`）直放；动作类 SQL 单独工具，过审批 + 令牌 + SQL 类型白名单 |
| 审批 | `tools/pre-execute` waterfall → `ctx.approval`（PG approvals）→ 控制台（slots）或 IM（webhook 回调）决策 → 一次性令牌（32B/TTL/哈希落库）→ 执行 → 全量审计（rollout 事件） |
| 凭据 | PG 连接串/SSH 密钥只在 Runtime pod Secret；LLM key 经 env；不落 `$DSH_HOME` |
| 网络 | NetworkPolicy：Runtime 只允许到 PG/S3/LLM 出口/PG 主机网段；Host 只允许到 PG/S3/IM 出口 |
| 租户 | `tenant_id` 全表；`tenant-context` 注入 scope；MCP `_meta` 租户身份只能来自 ctx |
| 遥测 | 默认 DISABLED；开启只允许 OTLP 到集群内 collector（脱敏） |

---

## 11. 自研包清单与仓库结构

| 包 | 职责 | 阶段 | pod |
|---|---|---|---|
| `@opendb-dsh/bundle-host` / `bundle-runtime` | 两份 `cordis.patch.yml` 组合层 | P0 | H / R |
| `@opendb-dsh/session-persistence-pg` | `PersistenceBackend` 7 hook；S3 大 payload | P0 | HR |
| `@opendb-dsh/agent-loop-dispatch` | Host 侧 AgentFactory 代理：写队列、tail 回灌 | P0 | H |
| `@opendb-dsh/runtime-worker` | sweeper / claim / heartbeat / drain / healthz / preset 绑定 | P0 | R |
| `@opendb-dsh/storage-pg` | `kv` facet backend + `NOTIFY` 桥接 | P1 | HR |
| `@opendb-dsh/attachment-s3` / `spill-s3` | S3 provider | P1 | HR / R |
| `@opendb-dsh/connection-auth` | 替换 `client-connection`：身份头 → 用户/租户；特权 RPC 按角色 | P1 | H |
| `@opendb-dsh/directory-picker-agent` | `ctx.directoryPicker` provider：选 agent 即选工作区 | P1 | H |
| `@opendb-dsh/tenant-context` | tenant/agent/thread/节点 注入 scope；`InTenantTx` | P1 | HR |
| `@opendb-dsh/registry` | agents / db_nodes / groups / users：PG + typert RPC + slots 页面 | P1 | H |
| `@opendb-dsh/scheduler` | cron → `thread_queue`（按节点/组的巡检） | P1 | H |
| `@opendb-dsh/approval-platform` | `ctx.approval` provider + PG approvals + 一次性令牌 + `tools/pre-execute` waterfall | P1 | HR |
| `@opendb-dsh/approval-ui` | 审批中心 slots 页 | P1 | H |
| `@opendb-dsh/memory` / `knowledge` / `embeddings` | 三个 Definition（`ctx.memory` / `ctx.knowledge` / `ctx.embeddings`） | P1 | HR |
| `@opendb-dsh/memory-pg` / `knowledge-pg` / `embeddings-openai-compat` | pgvector+FTS 记忆 / 文档 chunk 检索 / OpenAI 兼容 embedding provider | P1 | HR |
| `@opendb-dsh/memory-context` / `tool-memory` / `memory-ingest` | 每 turn section 注入 / `memory_search`+`memory_note`+`knowledge_search` 工具 / turn 结束抽取写入 | P1 | R |
| `@opendb-dsh/storage-redis` | dsh `storage` `kv` facet 的 Redis backend（投影缓存、检索缓存；可丢） | P2 | HR |
| `@opendb-dsh/knowledge-ingest` / `ui-memory` / `ui-knowledge` / `skill-pg` | 知识库上传/抓取/审核流；记忆与知识库 slots 页；SOP 从 PG 来 | P2 | H |
| `@opendb-dsh/memory-graph` / `knowledge-vector` | 图数据库 provider（Neo4j/Graphiti）/ 专用向量库 provider（可选） | P3 | R |
| `@opendb-dsh/metrics` / `dictionary` | 两个 Definition（`ctx.metrics` / `ctx.dictionary`） | P1 | HR |
| `@opendb-dsh/metrics-timescale` / `dictionary-pg` | TimescaleDB hypertable provider / 版本化字典快照 + 变更事件 | P1 | HR |
| `@opendb-dsh/collector` / `tool-metrics` | 采集器（`collector` class）/ `metrics_query` + `dictionary_diff` 工具 | P1 | collector / R |
| `@opendb-dsh/metrics-victoria` | VictoriaMetrics provider（>5000 实例可选） | P3 | — |
| `@opendb-dsh/instructions-pg` | 替换 `agent-instructions`：从 PG 注入 instruction_doc | P1 | R |
| `@opendb-dsh/db` / `db-opengauss` | `ctx.db` 方言 seam / openGauss provider（MVP）；`db-postgres` P2 | P1 | HR |
| `@opendb-dsh/tool-db` | 只读诊断/指标/元数据（经 `ctx.db`）；动作类 SQL 单独工具（P2） | P1 | R |
| `@opendb-dsh/tasks` | `ctx.tasks` seam：任务类型注册表（Host 半：列表/配置/结果 slots + scheduler 接入；Runtime 半：run = `task:<type>` thread + 结果投影） | P1 | HR |
| `@opendb-dsh/task-inspection` / `task-sql-audit` | 首批任务插件：巡检（cron）、SQL 审核（cron） | P1 | HR |
| `@opendb-dsh/ui-agent-workspace` | 客户端插件，替换 `dsh-client-ui-workspace`：agent 图标/徽标/配置入口；侧栏分组"对话 / 任务" | P1 | H |
| `@opendb-dsh/task-monitor-dashboard` / `task-incident` | 监控大盘（continuous：采集器 + 异常拉起 agent）、告警处置（event） | P2 | HR |
| `@opendb-dsh/workflow-sandbox-job` | `ctx.workflowEngine` 进程外 provider（sandbox Job pod） | P2 | R |
| `@opendb-dsh/terminal-ssh` | `ctx.terminals` 远端 PTY provider（ssh2 shell channel）+ claim 软亲和 | P3 | R |
| `@opendb-dsh/code-runtime-sandbox-job` | `ctx.codeRuntime` `isolation: container` provider | P3 | R |
| `@opendb-dsh/exec-ssh` | `ctx.fs`+`ctx.shell`+`ctx.subprocess` 同世界 SSH provider | P2 | R |
| `@opendb-dsh/tool-fs-search-ssh` | 远端 rg/grep | P2 | R |
| `@opendb-dsh/approval-im-feishu` / `-dingtalk` | webhook 路由 + 出站通知 | P2 | H |
| `@opendb-dsh/subagent-queue` | 子代理 = 队列新 thread，跨 pod 扇出 | P2 | R |
| `@opendb-dsh/agent-presets-pg` | preset 来源改 PG；UI 编辑落库 | P2 | HR |
| `@opendb-dsh/session-query-pg` | PG FTS 会话搜索 | P2 | H |

```
opendb-dsh/
├── packages/            # 上表全部（TypeScript，Cordis 插件包，pnpm workspace）
├── profiles/            # host / pg-ops / pg-rac / assistant / host-debug（package.json bundles + patch + .agent-presets）
├── deploy/
│   ├── charts/opendb-dsh/  # 单 chart：host / runtime pools / storage.builtin / KEDA
│   ├── docker/dsh.Dockerfile   # 一个镜像：dsh rc.6 钉版 + 本仓库包 + 预烘焙 profiles/node_modules
│   └── kind/
├── dsh.lock             # dsh 各包版本 + integrity
└── docs/
```

CI 门：`dsh --profile <name> --dump-config` 快照；至少一条 e2e 走真实 Loader；启动末尾 `assertEntriesActivated`；patch 覆盖行必须重述全部 config 的 lint；每个替换 provider 与 dsh 原生 provider 跑同一套 conformance 用例。

---

## 12. 分阶段路线

| 阶段 | 目标 | 交付 | 验收 |
|---|---|---|---|
| **P0 可行性验证** ✅ **已通过（2026-08-17，G0 门：代理方案成立，不走备选）** | 证明"Host 派发 + Runtime 接力"在 dsh 上成立 | `session-persistence-pg` / `agent-loop-dispatch` / `runtime-worker` / `bundle-host` / `bundle-runtime` + 两个 profile + 一个镜像；mac 上 OrbStack 4 VM + k3s（1 cp + 3 worker）+ 本地 registry；提交 `04256b8`…| **本地双进程与 4 节点 k3s 均通过**：① UI/API 发消息 → Runtime 真 LLM 执行 → Host 会话实时镜像（Host seq == PG seq）；② 删掉 Runtime pod → 另一 pod 接力（k8s 自动补 pod）；③ 跨 pod `ask_user`（PG 中转 → dsh 原生提问 UI → 作答 → 继续）；④ 中断（`turn/end aborted/user`）；⑤ `--dump-config` 无 PENDING。4 个不确定点全部成立：`sessions.prepare` 可造会话；`session.append` 镜像可行（需带 `surfaceOp`）；Runtime 可 resume 只有 header + `session/end-seed` 的会话；`agents.enter(agent, undefined)` 可用。**踩坑记录见 §13 P0 经验** |
| **P1 MVP**（W1 ✅ 2026-08-18：Helm+Ingress、storage-pg/attachment-s3/spill-s3+read_spill、tenant 骨架、连接卫生修复） | 单租户可用的 og 巡检/诊断平台 | `registry` + agent 配置页、`ui-agent-workspace`、`tasks` + `task-inspection` + `task-sql-audit`、`scheduler`、`tool-db`（只读）、`metrics-timescale` + `dictionary-pg` + `collector` + `tool-metrics`、`memory-pg`、`approval-platform` + `approval-ui`、`storage-pg/attachment-s3/spill-s3`、`directory-picker-agent`、preset ConfigMap、Helm chart（本地多硬件节点 k8s）、KEDA；**认证/IM 暂不做** | 100 节点 / 5 agent 排程巡检跑通；审批链路端到端；随机杀 runtime pod 不丢会话 |
| **P2 执行与扇出** | 经审批的主机/数据库动作；子代理跨 pod；IM 审批 | `exec-ssh`、`tool-fs-search-ssh`、`tool-db` 动作类、一次性令牌、`approval-im-*`、`subagent-queue`、`workflow-sandbox-job`、`task-monitor-dashboard`、`task-incident`、`agent-presets-pg`、`session-query-pg`、`connection-auth` + Ingress 认证 | 一次经审批的变更在目标 PG 主机执行并全量审计；父 agent 扇出 10 子代理跨 pod |
| **P3 规模与多租户** | 上千节点；RLS；Host 水平扩；冷归档 | KEDA 调参、rollout 分区归档、RLS FORCE、租户配额、Host 粘性多副本 + `NOTIFY`、`terminal-ssh`、`code-runtime-sandbox-job`、可选 Skill pod 与 `memory-graphiti` | 2000 节点压测；租户越权集成用例全绿 |

---

## 13. 风险与已知坑

| 风险 | 缓解 |
|---|---|
| dsh `Agent` 接口面宽，Host 侧代理成本高 | P0 首先验证；备选：交互 thread 在 Host 本进程跑真 loop |
| Host 单副本：粘性 WS、进程内 session 注册表 | MVP 接受；P3 按 §5.3 扩 |
| dsh 特权 RPC 硬编码 loopback（settings/credentials/preset 编辑） | settings/credentials 由 ConfigMap/Secret 提供；preset 编辑走 `agent-presets-pg`；`connection-auth` 按角色放行或隐藏 |
| dsh 工作区 = 目录路径的假设（源码核实：`workspaceRegistry.create/resolveByPath` 做 `realpath`+`isDirectory`，`session.create` 会 `mkdir -p cwd`；`agent://` 连 `isAbsolute` 都过不了） | 每个 agent 对应一个真实可自动创建的绝对目录 `$DSH_HOME/agents/<agent-id>/`，`directory-picker-agent` 返回该路径；语义不变 |
| Host 回灌远端事件（源码核实：dsh 无 tail/ingest API；`/api/events.mux` 推的是 in-memory Session 的 `session/event`；构造种子不 emit） | Host tail PG（`loadStoredFrom`）→ 对 Host 进程内 live `Session` 逐条 `session.append(type,data,surfaceOp)` 重放（seq 由本地分配、必须从 0 严格按序）→ UI 自然更新；Host 上的 `session-persistence-pg` 以 `(session_id, seq)` 幂等去重避免双写；`AgentFactory` 仅 `createAgent/resume` 两方法可代理，但代理 Agent 须持有真 `Session` + `Inbox` + `createScope` 并复刻 enter/announce 发布序 |
| `ask_user` 是纯内存 Promise（不进 session log），跨 pod 答不了 | Runtime 注册把问题写 PG 的 `UserQuestionProvider`；Host 读到后对代理 Agent 调 `ctx.userQuestions.ask()` 让 dsh 原生 UI 弹问，答案写回 PG；`approval` 有持久化事件（`approval/asked`/`decided`）相对好办 |
| `tool-fs-search` 依赖本机 ripgrep | P2 `tool-fs-search-ssh` |
| dsh 仍是 rc（rc.6），接口可能变 | `dsh.lock` 钉版；只依赖 README 明示的 Service Definition；conformance 测试 |
| `PersistenceBackend` 无跨进程写者互斥；Host 读 + Runtime 写 | PG 行状态机保证同一 thread 单写者；`(thread_id, seq)` 唯一约束兜底 |
| patch 整体替换 config、PENDING 静默 | lint + `--dump-config` 快照 + `assertEntriesActivated` |
| SSH 到上千主机的连接数与密钥管理 | provider 内连接池 + 每 pod 并发上限；密钥轮换走 Secret；`authorized_keys` 限制来源 |
| spill/attachment 永不清理 | 全落 S3 + 生命周期策略 |
| dsh 遥测无脱敏、`x-deepseek-harness-user-id` 头 | 默认关；接受或经 `llm-pi-ai` 自定义 provider |
| sweeper 2s 轮询与全表扫描 | 按 `runtime_class` 部分索引；上量后 `LISTEN/NOTIFY` |

---

### 13.1 P0 经验（2026-08-17，实测得出，P1 起为硬约束）

| 现象 | 根因 | 处置 |
|---|---|---|
| Host 侧 `this.ctx.sessionPersistence` 报 "without inject" | `ctx.agents.create()` 会把调用 re-trace 到调用方 ctx | 工厂在构造期捕获自身 ctx 与服务成字段（`loopCtx`/`svc`），方法里只用字段；可选服务一律 `ctx.get` |
| Runtime 收尾丢 `turn/end`（中断尤甚） | dsh 在 `agent/turn-stopping`（serial、可含 LLM 调用如标题生成）之后才追加 `turn/end`，可能晚于 `whenIdle`；随后 dispose 丢掉写后置批次 | `whenIdle` 后等待日志中本轮 `turn/end`（上限 60s）→ `sessions.flush()` → release/dispose |
| Host 镜像少最后几十个事件 | Host 看到 idle 立即停 tail，Runtime 最后一批未落库 | idle 后连续两轮空镜像才停 |
| Host 与 Runtime 写同一会话 seq 分叉 | Host 创建会话本地就有 seq 0（`session/end-seed`） | Host 入队前 `sessions.flush()`；Runtime 从 PG 前缀续写；PG `(session_id, seq)` 幂等 |
| Runtime 启动 PENDING | `permission`（permission-presets）依赖 `shell` 服务，而 Runtime 无 shell provider | Runtime bundle 禁 `permission` 行；`assertEntriesActivated` 是好门神 |
| 多 pod 同时建表报 `pg_type_typname_nsp_index` | `CREATE TABLE IF NOT EXISTS` 并发竞态 | 迁移用 `pg_advisory_lock` 串行 |
| 同 tag 重推镜像不生效 | `imagePullPolicy: IfNotPresent` | 迭代期 `Always`；正式按 git sha 打 tag |
| NodePort `/api` 403 | dsh trust fence 只认 loopback / 绑定 LAN 字面量 / `trustedHosts` | `connection.trustedHosts` 经 `OPENDB_TRUSTED_HOSTS` 追加节点/Service/Ingress 权威 |
| mac→NodePort 的 mux WebSocket 帧滞后 | OrbStack/k3s NodePort 长连接问题（集群内 mux 完整） | 浏览器走 Ingress/traefik 或 `kubectl port-forward`；不是平台问题 |
| 测试互相污染 | 各包测试并发 + 与本地 host/runtime 共库 | 测试串行（`--workspace-concurrency=1`）+ 独立 `dsh_test` 库 |
| 开发机 3080 端口 | mac 上跑着个人 `dsh web` | Host 端口经 `OPENDB_HOST_PORT`（本地默认 3090） |
| dsh 事件 data 形状 | `user/message` data 即 UserMessage（需 `id/role/source/content`）；`turn/end.reason` 是 `{kind}` 对象 | conformance 测试按此构造 |

## 14. 待确认项与 user 回复（2026-08-17）

| # | 问题 | user 回复 | 落地 |
|---|---|---|---|
| 1 | Host 认证方式 | **MVP 暂不考虑**；先做一个本地多个硬件节点部署的 k8s 服务 | `connection-auth` + Ingress 认证移到 P2；MVP 内网使用；Helm chart 以本地多节点 k8s 为目标形态 |
| 2 | SSH 账号 / 测试环境 | **在 mac 上部署 k8s 测试环境**：`ssh admin@192.168.128.1` | P0/P1 的目标集群与被管 PG 测试节点都在这台 mac 上；SSH 账号策略随测试环境定 |
| 3 | IM 优先级 | **MVP 暂不考虑** | `approval-im-*` 移到 P2 |
| 4 | §6 插件清单处理 | user 待审 | 清单保持 v0.3 分类；§3.7 已展开 workflow/code-runtime/terminal 的关闭理由与回归路径 |
| 5 | 是否开始 P0 | **可以做 P0 验证** | 进入实施计划（P0：Host 派发 + Runtime 接力 resume + 跨 pod `ask_user` 回路 + `agent://` 虚拟工作区） |

**产品模型补充（user 2026-08-17，已入 §3.6）**：工作区 = agent（图标换 agent，无文件夹概念）；agent 上配置插件与被管节点；agent 下两类任务——普通对话、插件式任务（如定期 SQL 审核、实时监控大盘），每类任务由一个任务插件支撑。
