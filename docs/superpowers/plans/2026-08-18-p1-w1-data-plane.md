# P1 W1：数据面打底（Helm/Ingress + storage-pg + attachment-s3 + spill-s3 + tenant 骨架）—— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Host/Runtime pod 做到零本地持久状态：dsh 的 `storage`（工作区/投影缓存/评分）→ PostgreSQL，`attachments` → S3(MinIO)，`spill` → S3 + `read_spill` 工具；全套用 Helm 一条命令部署，浏览器经 Ingress 访问；我们的表带 `tenant_id`。

**Architecture:** 三个新 provider 都是 dsh seam 的替换实现（design §6.3）：`storage-pg` 实现 `StorageBackend.kv`（`open/loadAll/putRecord/deleteRecord/setGlobal/close`），注册名 `pg` 并 `ctx.provide('storage.backend.pg')`；`attachment-s3` extends `AttachmentStore`，复用 `dsh-attachment-local` 导出的 `validateImageFile/detectImage`（准入语义不变，`sha256:<hex>` ref 不变）；`spill-s3` extends `SpillStore`，locator `s3://bucket/key`，`retrievalHint` 指向新工具 `read_spill`（同包注册，输出上限 20KB 防再溢出）。

**Tech Stack:** TS/ESM、`pg`、`@aws-sdk/client-s3`、`sharp`（经 dsh-attachment-local 间接）、node:test + PG（`dsh_test`）+ MinIO（本地 docker）。

**Spec:** `docs/2026-08-16-opendb-dsh-platform-design.md` v0.8 §6.3、§7、§8.2、§13.1；研究报告要点见本文各 Task 的 Interfaces。

## Global Constraints
- 与 P0 计划相同（dsh 钉 rc.6、不改 dsh 代码、`@opendb-dsh/*`、包形状照 `session-persistence-pg`、patch = disable + insert、`!!js` 裸 helper、测试串行 + `dsh_test` 库、每 Task 提交）。
- **P0 经验（§13.1）为硬约束**：工厂/服务在构造期捕获 ctx；可选服务 `ctx.get`；迁移 advisory lock；k8s 迭代 `imagePullPolicy: Always`。
- storage 单元/表名受 `/^[a-z][a-z0-9_]*$/` 约束；kv 后端**不负责**并发序列化，只需"单次调用原子且 resolve 即持久"（COMMIT 后再 resolve）。
- `domain/changed` 是进程内事件，backend 不得自行 emit（invariant 会失败）；多 Host 副本的 domain 一致性是已知缺口（P3 处理），W1 只支持单 Host。
- S3 客户端从 env 读：`OPENDB_S3_ENDPOINT` / `OPENDB_S3_BUCKET` / `OPENDB_S3_ACCESS_KEY` / `OPENDB_S3_SECRET_KEY`（chart 已注入）；`forcePathStyle: true`。

---

### Task 1: Helm chart + Ingress ✅（已完成 2026-08-18，提交 d0079c5/后续）
`deploy/charts/opendb-dsh`：postgres(StatefulSet+PVC) / minio(+bucket init Job) / host / runtime 池(按 `runtime.classes`) / ingress(traefik, `opendb.local`) / wait-for-pg init；`helm upgrade --install opendb-dsh deploy/charts/opendb-dsh -n opendb-dsh` 已在 4 节点集群跑通，`/api` 经 Ingress 可用。

---

### Task 2: `@opendb-dsh/storage-pg` ✅（3/3 测试通过）
**Files:** `packages/storage-pg/{package.json,tsconfig.json,src/index.ts,src/unit.ts,sql/001_kv.sql,test/kv.test.ts}`
**Interfaces（dsh，逐字来自 `dsh-storage/lib/types/backend.d.ts`）:**
```ts
interface StorageBackend { readonly kv?: KvFacet; close(): Promise<void>; }
interface KvFacet { open(descriptor: { name: string; version: number; tables: readonly string[]; hasGlobal: boolean }): Promise<KvUnit>; }
interface KvUnit { loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }>; putRecord(table, key, value): Promise<void>; deleteRecord(table, key): Promise<void>; setGlobal(value): Promise<void>; close(): Promise<void>; }
// 错误：StorageError(code) code ∈ 'version-mismatch'|'malformed-medium'|'closed'|…（从 '@deepseek-ai/dsh-storage' 导出 StorageError、UNIT_NAME_RE、storageBackendServiceKey）
// 注册：ctx.storage.backend.register('pg', backend) 返回 disposer；且 ctx.provide(storageBackendServiceKey('pg'), backend)
```
**Produces:** function plugin `{ name:'storage-pg', inject:['storage'], Config:{connectionString}, apply }`；PG 表 `dsh_kv_units(unit pk, version, has_global, global jsonb)`、`dsh_kv_records(unit, tbl, key, value jsonb, pk(unit,tbl,key))`。
- [ ] SQL + package 脚手架（照 session-persistence-pg）
- [ ] 失败测试：open 新 unit → loadAll 空形状；put/load 往返；同名再 open reject；version 不同 → `version-mismatch`；close 后调用 → `closed`；global null 哨兵；两个 backend 实例先后打开同一 unit（模拟 Host 重启）数据仍在
- [ ] 实现 `PgKvUnit`（loadAll: `SELECT tbl,key,value` + `SELECT global`；putRecord: `INSERT … ON CONFLICT (unit,tbl,key) DO UPDATE`；deleteRecord；setGlobal: `UPDATE dsh_kv_units SET global=$2`；open: advisory lock + upsert unit 行 + version 校验）与 `PgStorageBackend`（open 去重表、close）
- [ ] 测试通过 → commit `feat(storage-pg): dsh storage kv facet 的 PostgreSQL 后端`

### Task 3: `@opendb-dsh/attachment-s3` ✅（2/2）
**Files:** `packages/attachment-s3/{package.json,tsconfig.json,src/index.ts,src/s3.ts,test/attachment.test.ts}`
**Interfaces（dsh）:** `abstract class AttachmentStore extends Service { abstract imageLimits; abstract validateImage(input); abstract saveImage(input): Promise<ImageAttachmentRef>; abstract readImage(ref, signal?): Promise<{ref,data}> }`（服务键 `attachments`）；`SaveImageAttachment{data:Uint8Array, mediaType, name?}`；`ImageAttachmentRef{attachmentId:'sha256:<hex>', mediaType, bytes, width, height, name?}`；从 `@deepseek-ai/dsh-attachment-local` 导入 `validateImageFile(input, limits)`、`detectImage(data, maxPixels)`；从 `@deepseek-ai/dsh-attachment` 导入 `AttachmentStore`、`AttachmentId`、`AttachmentError`（若未导出则自定义同码错误）。
**Produces:** `export default class S3AttachmentStore extends AttachmentStore`，`static Config = { endpoint, bucket, accessKey, secretKey, region='us-east-1', prefix='attachments/v1', maxImageBytes…同 local }`；对象 key `${prefix}/${sha[0..2]}/${sha}`；`saveImage`：validate → sha256 → `HeadObject`（存在则 `GetObject` 校验摘要）否则 `PutObject`（ContentType=mediaType）；`readImage`：`GetObject` → 摘要校验 → `detectImage` 元数据比对 ref → 不符抛 `ATTACHMENT_CORRUPT`；abort 传 signal。
- [ ] 失败测试（需 MinIO：`S3_ENDPOINT` env；`scripts/dev-minio.sh` 起 `quay.io/minio/minio` 于 9002/9003 并建桶 `dsh-test`）：save→read 往返（用一张 1×1 PNG 字节）；重复 save 幂等同 ref；坏 ref 抛 `INVALID_ATTACHMENT_REF`；缺对象抛 `ATTACHMENT_NOT_FOUND`
- [ ] 实现 → 测试通过 → commit

### Task 4: `@opendb-dsh/spill-s3`（含 `read_spill` 工具）✅（1/1）
**Files:** `packages/spill-s3/{package.json,tsconfig.json,src/index.ts,src/tool.ts,test/spill.test.ts}`
**Interfaces（dsh）:** `abstract class SpillStore extends Service { abstract saveText(input:{owner:{sessionId}, source:{toolName,callId,label}, suggestedName, content}): Promise<{locator, bytes, retrievalHint}> }`（服务键 `spillStore`，`SpillLocator` 品牌 string）；工具注册走 `ctx.tools.register(...)`（形状照 `dsh-tool-ask-user`：`{ name, description, parameters(schema), execute(args, exec) }`——实现前 `grep -n "tools.register" node_modules/@deepseek-ai/dsh-tool-ask-user/lib/index.js` 核对一次签名）。
**Produces:** `export default class S3SpillStore extends SpillStore`，key `spill/<sha256(sessionId).slice(0,12)>/<rand6>-<encodeSegment(name)>`，locator `s3://<bucket>/<key>`，`retrievalHint = "Use the read_spill tool with this locator (supports offset/limit lines)."`；同包 `apply` 时若 `ctx.get('tools')` 存在则注册 `read_spill{locator, offset?, limit?}`（默认 200 行，输出 ≤ 20000 字节，超出截断并提示 offset）。
- [ ] 失败测试：saveText 返回 `s3://` locator + hint；read_spill 读回同内容并支持 offset/limit；非本平台 locator 拒绝
- [ ] 实现 → 通过 → commit

### Task 5: `@opendb-dsh/tenant-context`（骨架）+ 迁移 002 ✅
**Files:** `packages/tenant-context/{package.json,src/index.ts}`, `packages/session-persistence-pg/sql/002_tenant.sql`
- [ ] 002：给 `dsh_sessions/dsh_threads/dsh_thread_queue/dsh_questions/dsh_kv_units/dsh_kv_records` 加 `tenant_id text NOT NULL DEFAULT 'default'` + 索引；建 RLS policy `tenant_isolation`（`ENABLE ROW LEVEL SECURITY`，**不 FORCE**，policy 用 `current_setting('app.tenant_id', true) IS NULL OR tenant_id = current_setting('app.tenant_id', true)`）
- [ ] `tenant-context` Service `ctx.tenantContext`：`current(): { tenantId }`（W1 恒 `default`），`withTenant(id, fn)`（AsyncLocalStorage），供 W2 registry/RLS 使用
- [ ] commit

### Task 6: 接线 + 端到端验收 ✅（2026-08-18）：k8s 上 read_spill 工具可调用；Host 重启后 session.list 完全一致（storage-pg：workspace/projcache 落 PG）；`--dump-config` 无 PENDING。注：端到端"自然大输出溢出"未在集群复跑（LLM 生成 >50KB 耗时），S3 写读由单测覆盖，W3 tool-db 大结果将自然覆盖
- [ ] `bundle-host`：`- id: storage-json disabled: true`；insert `storage-pg`；`- id: storage-domain config: { backend: pg }`；`- id: attachment-local disabled: true`；insert `attachment-s3`；insert `tenant-context`
- [ ] `bundle-runtime`：`attachment-local` → `attachment-s3`；`spill-local` → `spill-s3`（含 read_spill）；insert `tenant-context`
- [ ] profiles 加直接依赖；`pnpm build && pnpm test`（本地 PG `dsh_test` + `scripts/dev-minio.sh`）
- [ ] 镜像 `dev` 重建推送；`helm upgrade`；验收：① 经 Ingress 在 dsh UI 新建工作区/会话 → `kubectl rollout restart deploy/opendb-dsh-host` → 工作区与会话列表仍在（storage-pg）；② 上传一张图片让 agent 描述 → 重启后仍能打开（attachment-s3）；③ 让 agent 生成 >50KB 输出（如"列出 1 到 5000"）→ 出现 `s3://` spill 提示 → agent 用 `read_spill` 读回（spill-s3）；④ `--dump-config` 无 PENDING；⑤ PG 中 `dsh_kv_records` 有 `workspace/session_projcache` 行
- [ ] 更新 `deploy/k8s/CLUSTER.md`、设计 §12 P1 W1 状态；commit `feat: P1 W1 数据面打底`
