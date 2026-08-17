# P0 可行性验证：Host 派发 + Runtime 接力 —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用最少的代码证明：在不改 dsh 内核的前提下，dsh Web UI（Host 进程）发出的 turn 可以由另一个进程/pod（Runtime，跑原版 `dsh-agent-loop`）执行、事件经 PostgreSQL 回灌到 Host 让原生 UI 实时显示、Runtime 被杀后另一个 Runtime 能接力、以及跨进程 `ask_user` 回路可用。

**Architecture:** 三个 dsh 插件包 + 两个 profile 补丁：`session-persistence-pg`（`PersistenceBackend` 的 PG 实现，`(session_id, seq)` 幂等）、`agent-loop-dispatch`（Host 侧替换 `agent-loop` 的 `AgentFactory` 代理：写队列、tail PG 并对 Host 进程内 live `Session` 逐条 `append` 回灌）、`runtime-worker`（Runtime 侧 sweeper：claim → `ctx.agents.resume` → `agent.followup` → `whenIdle` → 释放；心跳；stale 回收；`UserQuestionProvider` 写 PG）。先以两个本地进程验证，再打进一个 Docker 镜像部署到 mac 上的 k8s。

**Tech Stack:** Node 22、TypeScript 5（`tsc` → ESM `lib/*.js` + `lib/types/*.d.ts`）、pnpm workspace、`pg` 8、`@deepseek-ai/dsh@0.1.0-rc.6`（钉版）、`node:test`、PostgreSQL 16、Docker、kind/OrbStack k8s。

**Spec:** `docs/2026-08-16-opendb-dsh-platform-design.md`（v0.5）§3.5、§4.1 成立前提、§8.1、§9、§12 P0、§13（源码核实修正三条）。

## Global Constraints

- dsh 版本钉死 `@deepseek-ai/dsh@0.1.0-rc.6`；**不改 dsh 任何包的代码**，只写 patch 行与新插件包。
- 所有新包 scope `@opendb-dsh/*`，`"type": "module"`，`main: lib/index.js`，`types: lib/types/index.d.ts`；seam 包与 `@deepseek-ai/cordis` 作 `peerDependencies`（照抄 `dsh-session-persistence-jsonl/package.json` 形状）。
- patch 语义：按 `id` 覆写时 **`config` 整体替换**；`name` 是断言不是可覆写字段——"替换一行"= `disabled: true` 原行 + `insert` 新行。
- `!!js` 表达式里 helper 是裸名：`dshHomePath('x')`、`process.env.X`；只有 Cordis 服务才写 `ctx.xxx`。
- `DSH_*`、`DEEPSEEK_BASE_URL` 只能用真实环境变量注入（写进 `.env` 会让启动失败）；`DEEPSEEK_API_KEY` 用 env。
- Host 进程内的 Session **只允许镜像回灌，绝不本地 append**（否则与 Runtime 的 seq 分叉）；P0 不支持 `session.updateQueue`/`agentPreset.select` 这类会本地写会话的 RPC。
- PG 表统一前缀 `dsh_`；`session_events` 主键 `(session_id, seq)`，插入一律 `ON CONFLICT DO NOTHING`。
- 每个 Task 结束都要 `git commit`；提交信息格式 `<type>: <description>`，不加 Co-Authored-By。
- 运行环境：本会话所在机器**没有** node/pnpm/docker/kubectl；一切构建与运行在 mac（`ssh admin@192.168.128.1`，需先授权本机公钥 `~/.ssh/id_ed25519.pub`）或 user 本机执行。

---

## 文件结构（本计划创建/修改的全部文件）

```
opendb-dsh/                                   （本地目录仍是 ~/dsh-k8s，远端 github.com/sqlrush/opendb-dsh）
├── package.json                              pnpm workspace 根：devDeps typescript/@types/node/@deepseek-ai/dsh；scripts build/test
├── pnpm-workspace.yaml                       packages/* + profiles/*
├── tsconfig.base.json                        ESM/NodeNext、declaration、outDir lib
├── dsh.lock                                  dsh 版本与 integrity（P0 只钉 dsh 主包版本）
├── .gitignore                                + profiles/*/cordis.yml, .dsh-home/, lib/, node_modules/
├── packages/
│   ├── session-persistence-pg/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── sql/001_p0.sql                    全部 P0 表（sessions/events/threads/queue/questions）
│   │   ├── src/index.ts                      PgSessionPersistence（extends SessionPersistence, implements PersistenceBackend<number>）
│   │   ├── src/pool.ts                       createPool(connectionString) 单例
│   │   ├── src/schema.ts                     runMigrations(pool)（执行 sql/*.sql，幂等）
│   │   ├── src/invariant.ts                  照抄 jsonl 的 invariant 伴生插件
│   │   └── test/backend.test.ts              需 PG_URL；conformance：create/append/load/readFrom/list/repair/幂等
│   ├── agent-loop-dispatch/
│   │   ├── package.json  tsconfig.json
│   │   ├── src/index.ts                      DispatchAgentLoop（Service，AgentFactory）：createAgent/resume
│   │   ├── src/proxy-agent.ts                ProxyAgent（implements Agent）：Session+Inbox+scope、followup→队列、tail 回灌、questions 桥
│   │   ├── src/queue.ts                      enqueue/interrupt/ensureThread SQL
│   │   ├── src/tailer.ts                     每 400ms readFrom → session.append 回灌；questions 轮询
│   │   └── test/proxy-agent.test.ts          需 PG_URL；用真实 Cordis Context + dsh-session + persistence-pg 跑
│   ├── runtime-worker/
│   │   ├── package.json  tsconfig.json
│   │   ├── src/index.ts                      RuntimeWorker（Service）：sweeper/claim/heartbeat/stale/drain/healthz
│   │   ├── src/claim.ts                      claimNext/heartbeat/release/markStale SQL（事务）
│   │   ├── src/questions-provider.ts         UserQuestionProvider：写 dsh_questions 并轮询答案
│   │   └── test/claim.test.ts                需 PG_URL；claim 互斥、stale 回收
│   ├── bundle-host/
│   │   ├── package.json                      dsh.bundle.patch → ./cordis.patch.yml；deps: agent-loop-dispatch, session-persistence-pg
│   │   └── cordis.patch.yml                  禁 agent-loop/session-persistence-jsonl；插 dispatch/pg；webserver 0.0.0.0
│   └── bundle-runtime/
│       ├── package.json                      dsh.bundle.patch；deps: runtime-worker, session-persistence-pg
│       └── cordis.patch.yml                  禁 jsonl/hmr/工具行；插 pg/runtime-worker/tool-ask-user
├── profiles/
│   ├── host/{package.json,cordis.patch.yml,pnpm-workspace.yaml}     bundles: dsh-base, dsh-web-app, @opendb-dsh/bundle-host
│   └── runtime/{package.json,cordis.patch.yml,pnpm-workspace.yaml}  bundles: dsh-base, @opendb-dsh/bundle-runtime
├── scripts/
│   ├── dev-pg.sh                             docker run postgres:16 + 建库
│   ├── run-host.sh / run-runtime.sh          DSH_HOME=$PWD/.dsh-home 启动两个本地进程
│   └── e2e-p0.sh                             验收脚本（curl /api：create/prompt/history；杀 runtime 再发）
├── deploy/
│   ├── docker/dsh.Dockerfile                 node:22 + npm i -g dsh + 本仓库包 + 预烘焙 profiles
│   └── k8s/p0/{namespace,postgres,host,runtime,secret.example}.yaml
└── docs/superpowers/plans/2026-08-17-p0-host-dispatch-runtime-relay.md（本文件）
```

---

### Task 0: 环境前置（mac）与仓库脚手架

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `dsh.lock`, `.gitignore`（追加）
- Create: `scripts/dev-pg.sh`

**Interfaces:**
- Produces: workspace 根 `pnpm build`（递归 tsc）、`pnpm test`（递归 `node --test`）、`pnpm dsh`（= `dsh` bin）；`PG_URL` 约定 `postgres://dsh:dsh@127.0.0.1:5433/dsh`。

- [ ] **Step 1: 授权 SSH 公钥并确认 mac 工具链**

在 mac 上（user 执行一次）：把本机公钥追加到 `~admin/.ssh/authorized_keys`：
```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE34Wp68lI4nuZvQxQmVDJvLAob3I0b5ExZ3c3DwB515
```
然后从本会话验证：
```bash
ssh -o BatchMode=yes admin@192.168.128.1 'node -v; pnpm -v; docker version --format "{{.Server.Version}}"; kubectl config current-context'
```
Expected: `v22.x`、`9.x`/`10.x`、docker 版本号、一个 k8s context（kind 或 orbstack）。缺什么装什么：`brew install node@22 pnpm kind kubectl`；docker 用 OrbStack 或 Docker Desktop。

- [ ] **Step 2: 克隆仓库到 mac 并写根配置**

```bash
ssh admin@192.168.128.1 'git clone git@github.com:sqlrush/opendb-dsh.git ~/opendb-dsh'
```
`package.json`：
```json
{
  "name": "opendb-dsh",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.15" },
  "scripts": {
    "build": "pnpm -r --filter './packages/**' run build",
    "test": "pnpm -r --filter './packages/**' run test",
    "dsh": "dsh"
  },
  "devDependencies": {
    "@deepseek-ai/dsh": "0.1.0-rc.6",
    "@types/node": "^22.15.0",
    "@types/pg": "^8.11.0",
    "typescript": "^5.6.0"
  }
}
```
`pnpm-workspace.yaml`：
```yaml
packages:
  - packages/*
  - profiles/*
```
`tsconfig.base.json`：
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "declarationDir": "lib/types",
    "outDir": "lib",
    "rootDir": "src",
    "skipLibCheck": true,
    "esModuleInterop": true,
    "types": ["node"]
  }
}
```
`dsh.lock`：
```
@deepseek-ai/dsh 0.1.0-rc.6
```
`.gitignore` 追加：
```
lib/
profiles/*/cordis.yml
profiles/*/node_modules/
.dsh-home/
```

- [ ] **Step 3: PG 开发实例脚本**

`scripts/dev-pg.sh`：
```bash
#!/usr/bin/env bash
set -euo pipefail
docker rm -f opendb-dsh-pg 2>/dev/null || true
docker run -d --name opendb-dsh-pg -e POSTGRES_USER=dsh -e POSTGRES_PASSWORD=dsh -e POSTGRES_DB=dsh -p 5433:5432 postgres:16
for i in $(seq 1 30); do docker exec opendb-dsh-pg pg_isready -U dsh >/dev/null 2>&1 && break; sleep 1; done
echo "PG_URL=postgres://dsh:dsh@127.0.0.1:5433/dsh"
```

- [ ] **Step 4: 安装并验证 dsh 可用**

```bash
cd ~/opendb-dsh && chmod +x scripts/dev-pg.sh && pnpm install && pnpm exec dsh --version
```
Expected: 打印 `0.1.0-rc.6`。

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json dsh.lock .gitignore scripts/dev-pg.sh pnpm-lock.yaml
git commit -m "chore: workspace 脚手架、dsh 钉版 rc.6、开发 PG 脚本"
```

---

### Task 1: `@opendb-dsh/session-persistence-pg` —— PG 持久化后端

**Files:**
- Create: `packages/session-persistence-pg/package.json`, `tsconfig.json`, `sql/001_p0.sql`, `src/pool.ts`, `src/schema.ts`, `src/index.ts`, `src/invariant.ts`
- Test: `packages/session-persistence-pg/test/backend.test.ts`

**Interfaces:**
- Consumes（dsh，逐字来自 `dsh-session-persistence/lib/types/coordinator.d.ts`）：
  ```ts
  interface PersistenceBackend<TornMarker> {
    readonly name: string;
    loadStored(id, signal?): Promise<StoredPrefix<TornMarker> | undefined>;   // {meta, events, revision, tornMarker?}
    readStoredRevision(id, signal?): Promise<SessionPersistenceRevision | undefined>;
    loadStoredFrom?(id, fromSeq, signal?): Promise<StoredSuffix | undefined>; // {meta, events}
    appendBatch(meta, events, isMaterialized): Promise<void>;
    commitRepair(meta, tornMarker | undefined, closers): Promise<void>;
    list(signal?): Promise<SessionHeader[]>;
    locate?(meta): SessionLocation | undefined;
    close?(): Promise<void>;
  }
  class PersistenceCoordinator { constructor(ctx, backend, {preparedSessionCacheSize, writeBatchMaxDelayMs}); create/append/prepare/load/inspect/readFrom }
  abstract class SessionPersistence extends Service { constructor(ctx) /* key 'sessionPersistence' */; abstract locate/create/append/load/inspect/readFrom/list/listSnapshots; supportsRawArtifacts }
  ```
- Produces：默认导出类 `PgSessionPersistence`（class plugin，`static inject = ['sessions']`，`static Config = { connectionString, schema?, preparedSessionCacheSize?, writeBatchMaxDelayMs? }`），命名导出 `createPool(connectionString)`、`runMigrations(pool)`、`SQL_DIR`。表：`dsh_sessions`、`dsh_session_events`、`dsh_threads`、`dsh_thread_queue`、`dsh_questions`（后三张给 Task 2/3 用，放在同一迁移里以便一次建全）。

- [ ] **Step 1: package.json / tsconfig / SQL**

`packages/session-persistence-pg/package.json`：
```json
{
  "name": "@opendb-dsh/session-persistence-pg",
  "version": "0.0.1",
  "description": "PostgreSQL durable session persistence backend for the DeepSeek Harness (opendb-dsh)",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./invariant": { "types": "./lib/types/invariant.d.ts", "default": "./lib/invariant.js" },
    "./package.json": "./package.json"
  },
  "files": ["lib", "sql"],
  "scripts": { "build": "tsc -p tsconfig.json", "test": "node --test --test-concurrency=1 test/*.test.ts" },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-invariants": "^0.1.0-rc.6",
    "@deepseek-ai/dsh-session": "^0.1.0-rc.6",
    "@deepseek-ai/dsh-session-persistence": "^0.1.0-rc.6"
  },
  "dependencies": { "@deepseek-ai/schemastery": "^3.18.1", "pg": "^8.13.0" },
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-invariants": "^0.1.0-rc.6",
    "@deepseek-ai/dsh-session": "^0.1.0-rc.6",
    "@deepseek-ai/dsh-session-persistence": "^0.1.0-rc.6"
  }
}
```
`tsconfig.json`：`{ "extends": "../../tsconfig.base.json", "include": ["src"] }`。（`node --test` 直接跑 `.ts` 依赖 Node 22.6+ 的类型剥离：在根 `package.json` scripts 里给 test 加 `NODE_OPTIONS=--experimental-strip-types`；若版本不支持则先 `tsc` 再测 `lib`。）

`sql/001_p0.sql`：
```sql
CREATE TABLE IF NOT EXISTS dsh_sessions (
  id           text PRIMARY KEY,
  header       jsonb NOT NULL,
  repair_gen   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS dsh_session_events (
  session_id        text NOT NULL REFERENCES dsh_sessions(id),
  seq               integer NOT NULL,
  type              text NOT NULL,
  time              bigint NOT NULL,
  data              jsonb NOT NULL,
  ignorable         boolean,
  surface_op        text,
  source_event_seqs integer[],
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS dsh_threads (
  session_id    text PRIMARY KEY REFERENCES dsh_sessions(id),
  runtime_class text NOT NULL DEFAULT 'default',
  status        text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','running','interrupted')),
  running_pod   text,
  heartbeat_at  timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS dsh_thread_queue (
  id          bigserial PRIMARY KEY,
  session_id  text NOT NULL REFERENCES dsh_sessions(id),
  kind        text NOT NULL CHECK (kind IN ('queued','interrupt')),
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  admitted_at timestamptz,
  admitted_by text
);
CREATE INDEX IF NOT EXISTS dsh_thread_queue_pending ON dsh_thread_queue (id) WHERE admitted_at IS NULL;
CREATE TABLE IF NOT EXISTS dsh_questions (
  id          uuid PRIMARY KEY,
  session_id  text NOT NULL REFERENCES dsh_sessions(id),
  questions   jsonb NOT NULL,
  answer      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz
);
```

- [ ] **Step 2: 写失败的 conformance 测试**

`test/backend.test.ts`：
```ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import PgSessionPersistence, { createPool, runMigrations } from '../src/index.ts';

const PG_URL = process.env.PG_URL;
const ctx = new Context();
let persistence: PgSessionPersistence;

before(async () => {
  if (!PG_URL) return;
  const pool = createPool(PG_URL);
  await runMigrations(pool);
  await pool.query('TRUNCATE dsh_questions, dsh_thread_queue, dsh_threads, dsh_session_events, dsh_sessions');
  await pool.end();
  ctx.plugin(SessionStore);
  await ctx.plugin(PgSessionPersistence, { connectionString: PG_URL, writeBatchMaxDelayMs: 1 });
  persistence = ctx.get('sessionPersistence') as PgSessionPersistence;
});
after(async () => { await ctx.root.fiber.dispose(); });

const header = (id: string) => ({ version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd: '/tmp/opendb-dsh-test' });

test('append then load round-trips events with contiguous seq', { skip: !PG_URL }, async () => {
  const id = `s-${Date.now()}-a`;
  await persistence.create(header(id) as any);
  await persistence.append(id as any, [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } as any,
    { type: 'user/message', seq: 1, time: 2, data: { message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }, surfaceOp: 'append' } as any,
  ]);
  const loaded = await persistence.load(id as any);
  assert.equal(loaded.events.length, 2);
  assert.deepEqual(loaded.events.map(e => e.seq), [0, 1]);
  assert.equal((loaded.events[1] as any).surfaceOp, 'append');
});

test('readFrom returns only the suffix', { skip: !PG_URL }, async () => {
  const id = `s-${Date.now()}-b`;
  await persistence.create(header(id) as any);
  await persistence.append(id as any, [0, 1, 2].map(seq => ({ type: 'turn/start', seq, time: seq, data: { turn: seq } })) as any);
  const suffix = await persistence.readFrom(id as any, 2);
  assert.deepEqual(suffix.events.map(e => e.seq), [2]);
});

test('duplicate (session_id, seq) inserts are ignored (idempotent mirror)', { skip: !PG_URL }, async () => {
  const id = `s-${Date.now()}-c`;
  const events = [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }] as any;
  await persistence.appendBatch(header(id) as any, events, false);
  await persistence.appendBatch(header(id) as any, events, true);   // 第二次同 seq → 不报错、不重复
  const loaded = await persistence.load(id as any);
  assert.equal(loaded.events.length, 1);
});

test('list returns headers of materialized sessions; revision changes on append', { skip: !PG_URL }, async () => {
  const id = `s-${Date.now()}-d`;
  await persistence.appendBatch(header(id) as any, [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }] as any, false);
  const r1 = await persistence.readStoredRevision(id as any);
  await persistence.appendBatch(header(id) as any, [{ type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: 'completed' } }] as any, true);
  const r2 = await persistence.readStoredRevision(id as any);
  assert.notEqual(r1, r2);
  assert.ok((await persistence.list()).some(h => h.id === id));
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `PG_URL=postgres://dsh:dsh@127.0.0.1:5433/dsh pnpm --filter @opendb-dsh/session-persistence-pg test`
Expected: FAIL（`Cannot find module '../src/index.ts'`）。

- [ ] **Step 4: 实现 pool / schema**

`src/pool.ts`：
```ts
import pg from 'pg';
export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
}
```
`src/schema.ts`：
```ts
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
export const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql');
export async function runMigrations(pool: pg.Pool): Promise<void> {
  const files = (await readdir(SQL_DIR)).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) await pool.query(await readFile(join(SQL_DIR, f), 'utf8'));
}
```

- [ ] **Step 5: 实现 provider**

`src/index.ts`：
```ts
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session';
import {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE, DEFAULT_WRITE_BATCH_MAX_DELAY_MS, MAX_WRITE_BATCH_DELAY_MS,
  PersistenceCoordinator, SessionPersistence, SessionPersistenceRevision,
  type PersistenceBackend, type StoredPrefix, type StoredSuffix, type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence';
import type pg from 'pg';
import { createPool } from './pool.ts';
import { runMigrations } from './schema.ts';
export { createPool } from './pool.ts';
export { runMigrations, SQL_DIR } from './schema.ts';

type Row = { seq: number; type: string; time: string; data: unknown; ignorable: boolean | null; surface_op: string | null; source_event_seqs: number[] | null };

function rowToEvent(r: Row): SessionEvent {
  const ev: Record<string, unknown> = { type: r.type, seq: r.seq, time: Number(r.time), data: r.data };
  if (r.ignorable) ev.ignorable = true;
  if (r.surface_op) ev.surfaceOp = r.surface_op;
  if (r.source_event_seqs) ev.sourceEventSeqs = r.source_event_seqs;
  return ev as SessionEvent;
}

/** PostgreSQL persistence backend; TornMarker = 起始 seq（与 SQLite 后端同法）。 */
export default class PgSessionPersistence extends SessionPersistence implements PersistenceBackend<number> {
  static inject = ['sessions'];
  static Config = z.object({
    connectionString: z.string().required(),
    preparedSessionCacheSize: z.number().step(1).min(1).default(DEFAULT_PREPARED_SESSION_CACHE_SIZE),
    writeBatchMaxDelayMs: z.number().step(1).min(1).max(MAX_WRITE_BATCH_DELAY_MS).default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS),
  });
  name = 'session-persistence-pg';
  supportsRawArtifacts = false;
  readonly pool: pg.Pool;
  private readonly coordinator: PersistenceCoordinator<number>;
  private ready: Promise<void>;
  private sourceId = 'pg';

  constructor(ctx: Context, config: { connectionString: string; preparedSessionCacheSize?: number; writeBatchMaxDelayMs?: number }) {
    super(ctx);
    this.pool = createPool(config.connectionString);
    this.ready = runMigrations(this.pool).then(async () => {
      const r = await this.pool.query<{ oid: string }>('SELECT oid::text FROM pg_database WHERE datname = current_database()');
      this.sourceId = `pg:${r.rows[0]?.oid ?? '0'}`;
    });
    this.coordinator = new PersistenceCoordinator<number>(this.ctx, this, {
      preparedSessionCacheSize: config.preparedSessionCacheSize ?? DEFAULT_PREPARED_SESSION_CACHE_SIZE,
      writeBatchMaxDelayMs: config.writeBatchMaxDelayMs ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
    });
  }

  // ---- SessionPersistence（服务面）：转发给 coordinator；create 额外落 header 让 Runtime 能 resume 空会话
  locate() { return undefined; }
  async create(meta: SessionHeader) {
    await this.ready;
    await this.coordinator.create(meta);
    await this.pool.query('INSERT INTO dsh_sessions (id, header) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [meta.id, meta]);
  }
  append(id: SessionId, events: readonly SessionEvent[]) { return this.coordinator.append(id, events); }
  prepare(id: SessionId, signal?: AbortSignal) { return this.coordinator.prepare(id, signal); }
  load(id: SessionId) { return this.coordinator.load(id); }
  inspect(id: SessionId, signal?: AbortSignal) { return this.coordinator.inspect(id, signal); }
  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal) { return this.coordinator.readFrom(id, fromSeq, signal); }
  async listSnapshots(): Promise<SessionPersistenceSnapshot[]> {
    await this.ready;
    const r = await this.pool.query<{ header: SessionHeader; max_seq: number | null; repair_gen: number }>(
      `SELECT s.header, s.repair_gen, (SELECT max(seq) FROM dsh_session_events e WHERE e.session_id = s.id) AS max_seq FROM dsh_sessions s`);
    return r.rows.map(row => ({ header: row.header, revision: this.revision(row.header.id, row.max_seq, row.repair_gen) }));
  }

  // ---- PersistenceBackend（后端面）
  private revision(id: string, maxSeq: number | null, repairGen: number) {
    return SessionPersistenceRevision(`${this.sourceId}:${id}:${maxSeq ?? -1}:${repairGen}`);
  }
  async loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<number> | undefined> {
    signal?.throwIfAborted(); await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const s = await client.query<{ header: SessionHeader; repair_gen: number }>('SELECT header, repair_gen FROM dsh_sessions WHERE id = $1', [id]);
      if (s.rowCount === 0) { await client.query('COMMIT'); return undefined; }
      const e = await client.query<Row>('SELECT seq, type, time, data, ignorable, surface_op, source_event_seqs FROM dsh_session_events WHERE session_id = $1 ORDER BY seq', [id]);
      await client.query('COMMIT');
      const events = e.rows.map(rowToEvent);
      const maxSeq = events.length ? events[events.length - 1].seq : null;
      return { meta: s.rows[0].header, events, revision: this.revision(id, maxSeq, s.rows[0].repair_gen) };
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
  }
  async readStoredRevision(id: SessionId, signal?: AbortSignal) {
    signal?.throwIfAborted(); await this.ready;
    const r = await this.pool.query<{ repair_gen: number; max_seq: number | null }>(
      'SELECT s.repair_gen, (SELECT max(seq) FROM dsh_session_events e WHERE e.session_id = s.id) AS max_seq FROM dsh_sessions s WHERE s.id = $1', [id]);
    if (r.rowCount === 0) return undefined;
    return this.revision(id, r.rows[0].max_seq, r.rows[0].repair_gen);
  }
  async loadStoredFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<StoredSuffix | undefined> {
    signal?.throwIfAborted(); await this.ready;
    const s = await this.pool.query<{ header: SessionHeader }>('SELECT header FROM dsh_sessions WHERE id = $1', [id]);
    if (s.rowCount === 0) return undefined;
    const e = await this.pool.query<Row>('SELECT seq, type, time, data, ignorable, surface_op, source_event_seqs FROM dsh_session_events WHERE session_id = $1 AND seq >= $2 ORDER BY seq', [id, fromSeq]);
    return { meta: s.rows[0].header, events: e.rows.map(rowToEvent) };
  }
  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], _isMaterialized: boolean) {
    await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO dsh_sessions (id, header) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [meta.id, meta]);
      for (const ev of events) {
        const e = ev as SessionEvent & { surfaceOp?: string; sourceEventSeqs?: number[]; ignorable?: true };
        await client.query(
          `INSERT INTO dsh_session_events (session_id, seq, type, time, data, ignorable, surface_op, source_event_seqs)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (session_id, seq) DO NOTHING`,
          [meta.id, e.seq, e.type, e.time, JSON.stringify(e.data), e.ignorable ?? null, e.surfaceOp ?? null, e.sourceEventSeqs ?? null]);
      }
      await client.query('UPDATE dsh_sessions SET updated_at = now() WHERE id = $1', [meta.id]);
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
  }
  async commitRepair(meta: SessionHeader, tornMarker: number | undefined, closers: readonly SessionEvent[]) {
    await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (tornMarker !== undefined) await client.query('DELETE FROM dsh_session_events WHERE session_id = $1 AND seq >= $2', [meta.id, tornMarker]);
      for (const e of closers as Array<SessionEvent & { surfaceOp?: string; sourceEventSeqs?: number[]; ignorable?: true }>) {
        await client.query(
          `INSERT INTO dsh_session_events (session_id, seq, type, time, data, ignorable, surface_op, source_event_seqs) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (session_id, seq) DO NOTHING`,
          [meta.id, e.seq, e.type, e.time, JSON.stringify(e.data), e.ignorable ?? null, e.surfaceOp ?? null, e.sourceEventSeqs ?? null]);
      }
      await client.query('UPDATE dsh_sessions SET repair_gen = repair_gen + 1, updated_at = now() WHERE id = $1', [meta.id]);
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
  }
  async list(): Promise<SessionHeader[]> {
    await this.ready;
    const r = await this.pool.query<{ header: SessionHeader }>('SELECT header FROM dsh_sessions ORDER BY created_at');
    return r.rows.map(x => x.header);
  }
  async close() { await this.pool.end(); }
}
export { PgSessionPersistence };
```
`src/invariant.ts`（照抄 jsonl 的形状）：
```ts
const PACKAGE_NAME = '@opendb-dsh/session-persistence-pg';
export const name = 'session-persistence-pg-invariant';
export const inject = ['invariants'];
export const apply = (ctx: any) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, () => {}));
```

- [ ] **Step 6: 构建 + 跑测试**

Run: `pnpm --filter @opendb-dsh/session-persistence-pg build && PG_URL=postgres://dsh:dsh@127.0.0.1:5433/dsh pnpm --filter @opendb-dsh/session-persistence-pg test`
Expected: 4 tests PASS。若 `Session`/`SessionHeader` 校验拒绝测试里的最小 header（例如要求 `delegationDepth`），按报错补齐字段（对照 `dsh-session/lib/types/types.d.ts:40-78`），不要放宽实现。

- [ ] **Step 7: Commit**

```bash
git add packages/session-persistence-pg
git commit -m "feat(session-persistence-pg): PostgreSQL PersistenceBackend（幂等 (session_id, seq)、repair、readFrom）"
```

---

### Task 2: `@opendb-dsh/runtime-worker` —— 领取 / 心跳 / stale / 提问桥

**Files:**
- Create: `packages/runtime-worker/package.json`, `tsconfig.json`, `src/claim.ts`, `src/questions-provider.ts`, `src/index.ts`
- Test: `packages/runtime-worker/test/claim.test.ts`

**Interfaces:**
- Consumes：`dsh_threads` / `dsh_thread_queue` / `dsh_questions`（Task 1 建表）；dsh：`ctx.agents.resume({resumeSessionId})` → `AgentHandle{agent, dispose}`；`agent.followup(msg)`、`agent.whenIdle()`、`agent.cancel({kind:'user'})`；`createUserMessage({content, source})` 来自 `@deepseek-ai/dsh-llm`；`ctx.userQuestions.registerProvider({ask})` 来自 `@deepseek-ai/dsh-user-questions`。
- Produces：`claimNext(pool, runtimeClass, podName): Promise<{queueId, sessionId, payload}|undefined>`；`heartbeat(pool, sessionId, podName)`；`release(pool, sessionId, podName, status:'idle'|'interrupted')`；`markStale(pool, olderThanMs)`；`pendingInterrupts(pool, sessionId)`；`PgUserQuestionProvider`；默认导出 `RuntimeWorker`（Service，`static inject = ['agents','sessionPersistence','userQuestions']`，Config `{connectionString, runtimeClass:'default', podName: env HOSTNAME, pollMs:2000, heartbeatMs:5000, staleMs:30000}`）。队列 payload 约定：`{ content: PromptContentPart[], source: {kind:'user'} }`。

- [ ] **Step 1: 失败测试（claim 互斥 + stale 回收）**

`test/claim.test.ts`：
```ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, runMigrations } from '@opendb-dsh/session-persistence-pg';
import { claimNext, heartbeat, release, markStale } from '../src/claim.ts';
const PG_URL = process.env.PG_URL; let pool: any;
before(async () => { if (!PG_URL) return; pool = createPool(PG_URL); await runMigrations(pool);
  await pool.query('TRUNCATE dsh_questions, dsh_thread_queue, dsh_threads, dsh_session_events, dsh_sessions'); });
after(async () => { await pool?.end(); });
async function seed(sid: string) {
  await pool.query('INSERT INTO dsh_sessions (id, header) VALUES ($1, $2)', [sid, { version: 1, id: sid, createdAt: 1 }]);
  await pool.query('INSERT INTO dsh_threads (session_id, runtime_class) VALUES ($1, $2)', [sid, 'default']);
  await pool.query('INSERT INTO dsh_thread_queue (session_id, kind, payload) VALUES ($1, $2, $3)', [sid, 'queued', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }]);
}
test('two workers cannot claim the same queued item', { skip: !PG_URL }, async () => {
  await seed('t1');
  const [a, b] = await Promise.all([claimNext(pool, 'default', 'podA'), claimNext(pool, 'default', 'podB')]);
  assert.equal([a, b].filter(Boolean).length, 1);
  const t = await pool.query('SELECT status, running_pod FROM dsh_threads WHERE session_id = $1', ['t1']);
  assert.equal(t.rows[0].status, 'running');
});
test('release sets idle; stale running threads become interrupted', { skip: !PG_URL }, async () => {
  await release(pool, 't1', (await pool.query('SELECT running_pod FROM dsh_threads WHERE session_id=$1', ['t1'])).rows[0].running_pod, 'idle');
  await seed('t2'); const c = await claimNext(pool, 'default', 'podC'); assert.ok(c);
  await pool.query("UPDATE dsh_threads SET heartbeat_at = now() - interval '2 minutes' WHERE session_id = 't2'");
  const n = await markStale(pool, 30_000); assert.equal(n, 1);
  assert.equal((await pool.query("SELECT status FROM dsh_threads WHERE session_id='t2'")).rows[0].status, 'interrupted');
});
```

- [ ] **Step 2: 运行确认失败** —— `PG_URL=... pnpm --filter @opendb-dsh/runtime-worker test` → FAIL（module not found）。

- [ ] **Step 3: 实现 `src/claim.ts`**

```ts
import type pg from 'pg';
export interface Claimed { queueId: string; sessionId: string; payload: { content: unknown[]; source: unknown } }
export async function claimNext(pool: pg.Pool, runtimeClass: string, podName: string): Promise<Claimed | undefined> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const q = await c.query<{ id: string; session_id: string; payload: Claimed['payload'] }>(
      `SELECT q.id, q.session_id, q.payload FROM dsh_thread_queue q JOIN dsh_threads t USING (session_id)
       WHERE q.admitted_at IS NULL AND q.kind = 'queued' AND t.runtime_class = $1 AND t.status IN ('idle','interrupted')
       ORDER BY q.id LIMIT 1 FOR UPDATE OF q, t SKIP LOCKED`, [runtimeClass]);
    if (q.rowCount === 0) { await c.query('COMMIT'); return undefined; }
    const row = q.rows[0];
    await c.query(`UPDATE dsh_threads SET status = 'running', running_pod = $2, heartbeat_at = now(), updated_at = now() WHERE session_id = $1`, [row.session_id, podName]);
    await c.query(`UPDATE dsh_thread_queue SET admitted_at = now(), admitted_by = $2 WHERE id = $1`, [row.id, podName]);
    await c.query('COMMIT');
    return { queueId: row.id, sessionId: row.session_id, payload: row.payload };
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
export async function heartbeat(pool: pg.Pool, sessionId: string, podName: string) {
  await pool.query(`UPDATE dsh_threads SET heartbeat_at = now() WHERE session_id = $1 AND status = 'running' AND running_pod = $2`, [sessionId, podName]);
}
export async function release(pool: pg.Pool, sessionId: string, podName: string, status: 'idle' | 'interrupted') {
  await pool.query(`UPDATE dsh_threads SET status = $3, running_pod = NULL, updated_at = now() WHERE session_id = $1 AND running_pod = $2`, [sessionId, podName, status]);
}
export async function markStale(pool: pg.Pool, olderThanMs: number): Promise<number> {
  const r = await pool.query(`UPDATE dsh_threads SET status = 'interrupted', running_pod = NULL, updated_at = now()
     WHERE status = 'running' AND heartbeat_at < now() - ($1 || ' milliseconds')::interval`, [String(olderThanMs)]);
  return r.rowCount ?? 0;
}
export async function pendingInterrupts(pool: pg.Pool, sessionId: string): Promise<number> {
  const r = await pool.query(`UPDATE dsh_thread_queue SET admitted_at = now(), admitted_by = 'interrupt' WHERE session_id = $1 AND kind = 'interrupt' AND admitted_at IS NULL`, [sessionId]);
  return r.rowCount ?? 0;
}
```

- [ ] **Step 4: 运行测试** → 2 PASS。

- [ ] **Step 5: 实现提问桥 `src/questions-provider.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
/** Runtime 侧 UserQuestionProvider：把问题写 PG，轮询答案；由 Host 侧代理 Agent 弹给 UI。 */
export class PgUserQuestionProvider {
  constructor(private readonly pool: pg.Pool, private readonly pollMs = 500) {}
  async ask(request: { questions: unknown[]; agent?: { id: string }; signal?: AbortSignal }): Promise<{ answers: unknown }> {
    const sessionId = request.agent?.id;
    if (!sessionId) throw new Error('ask_user requires an agent-owned session');
    const id = randomUUID();
    await this.pool.query('INSERT INTO dsh_questions (id, session_id, questions) VALUES ($1, $2, $3)', [id, sessionId, JSON.stringify(request.questions)]);
    for (;;) {
      request.signal?.throwIfAborted();
      const r = await this.pool.query<{ answer: unknown }>('SELECT answer FROM dsh_questions WHERE id = $1 AND answer IS NOT NULL', [id]);
      if (r.rowCount) return r.rows[0].answer as { answers: unknown };
      await new Promise(res => setTimeout(res, this.pollMs));
    }
  }
}
```
（返回值形状 `AskUserQuestionAnswer` 以 `dsh-user-questions/lib/types/index.d.ts` 为准；Host 侧写回的就是 `ctx.userQuestions.ask()` 的返回对象，原样透传即可。）

- [ ] **Step 6: 实现 `src/index.ts`（RuntimeWorker）**

```ts
import z from '@deepseek-ai/schemastery';
import { Service, type Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createPool, runMigrations } from '@opendb-dsh/session-persistence-pg';
import { claimNext, heartbeat, release, markStale, pendingInterrupts, type Claimed } from './claim.ts';
import { PgUserQuestionProvider } from './questions-provider.ts';
import { createServer } from 'node:http';

export default class RuntimeWorker extends Service {
  static inject = ['agents', 'sessionPersistence', 'userQuestions'];
  static Config = z.object({
    connectionString: z.string().required(),
    runtimeClass: z.string().default('default'),
    podName: z.string().default(process.env.HOSTNAME ?? `runtime-${process.pid}`),
    pollMs: z.number().default(2000),
    heartbeatMs: z.number().default(5000),
    staleMs: z.number().default(30000),
    healthPort: z.number().default(9090),
  });
  private stopping = false;
  private inFlight = new Set<Promise<void>>();
  constructor(ctx: Context, private readonly config: any) {
    super(ctx, 'runtimeWorker');
    const pool = createPool(config.connectionString);
    ctx.effect(() => ctx.userQuestions.registerProvider(new PgUserQuestionProvider(pool)), 'runtimeWorker.questions');
    const server = createServer((req, res) => { res.statusCode = this.stopping ? 503 : 200; res.end(this.stopping ? 'draining' : 'ok'); }).listen(config.healthPort);
    let timer: NodeJS.Timeout | undefined;
    ctx.effect(() => {
      const start = async () => {
        await runMigrations(pool);
        const tick = async () => {
          if (this.stopping) return;
          try {
            await markStale(pool, config.staleMs);
            const claimed = await claimNext(pool, config.runtimeClass, config.podName);
            if (claimed) { const p = this.run(pool, claimed).finally(() => this.inFlight.delete(p)); this.inFlight.add(p); }
          } catch (err) { ctx.logger?.warn?.('runtime-worker tick failed: %s', String(err)); }
          timer = setTimeout(tick, config.pollMs);
        };
        void tick();
      };
      void start();
      return async () => {           // drain：停领取，等在飞 turn，再关连接
        this.stopping = true; if (timer) clearTimeout(timer);
        await Promise.allSettled([...this.inFlight]);
        server.close(); await pool.end();
      };
    }, 'runtimeWorker.loop');
  }
  private async run(pool: any, claimed: Claimed) {
    const { sessionId, payload } = claimed;
    const hb = setInterval(() => void heartbeat(pool, sessionId, this.config.podName), this.config.heartbeatMs);
    let handle: { agent: any; dispose(): Promise<void> } | undefined;
    try {
      handle = await this.ctx.agents.resume({ resumeSessionId: sessionId as any });
      const agent = handle.agent;
      const interruptPoll = setInterval(async () => { if ((await pendingInterrupts(pool, sessionId)) > 0) agent.cancel({ kind: 'user' }); }, 1000);
      try {
        agent.followup(createUserMessage({ content: payload.content as any, source: payload.source as any }));
        await agent.whenIdle();
      } finally { clearInterval(interruptPoll); }
      await release(pool, sessionId, this.config.podName, 'idle');
    } catch (err) {
      this.ctx.logger?.error?.('runtime-worker run failed for %s: %s', sessionId, String(err));
      await release(pool, sessionId, this.config.podName, 'interrupted');
    } finally {
      clearInterval(hb);
      await handle?.dispose().catch(() => {});
    }
  }
}
export { RuntimeWorker };
```
`package.json` 同 Task 1 形状：`peerDependencies` 加 `@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-user-questions`；`dependencies` 加 `@opendb-dsh/session-persistence-pg: workspace:*`、`pg`、`@deepseek-ai/schemastery`。

- [ ] **Step 7: 构建通过** —— `pnpm --filter @opendb-dsh/runtime-worker build`，Expected: 无 TS 错误（`ctx.logger` 若类型缺失用 `(ctx as any).logger`）。

- [ ] **Step 8: Commit** —— `git commit -m "feat(runtime-worker): PG 队列领取/心跳/stale/中断与 ask_user 提问桥"`

---

### Task 3: `@opendb-dsh/agent-loop-dispatch` —— Host 侧代理工厂

**Files:**
- Create: `packages/agent-loop-dispatch/package.json`, `tsconfig.json`, `src/queue.ts`, `src/tailer.ts`, `src/proxy-agent.ts`, `src/index.ts`
- Test: `packages/agent-loop-dispatch/test/proxy-agent.test.ts`

**Interfaces:**
- Consumes（dsh，逐字来自 `dsh-agent/lib/types/*.d.ts`）：`AgentFactory { createAgent(ownerCtx, {sessionId, meta?, seed?, agentOptions?, signal?, setup?}): Promise<AgentHandle>; resume(ownerCtx, {resumeSessionId, agentOptions?, signal?, setup?}) }`；`Agent { id, options, session, inbox, status, ctx, cancel, whenIdle, runMaintenance, send, followup, steer, inject }`；`Inbox(session, {inserted, discarded, claimed})`；`emitAgentEvent(ctx, agent, name, payload)`；`createScope(ctx, key)` 来自 `dsh-scope`；`ctx.sessions.prepare(id, {meta, seed, seedSource}) / enter / announce`；`ctx.agents.enter(agent, owner) / announce(agent) / setFactory(this)`；`ctx.sessionPersistence.prepare(id) → SessionPreparation{session}` 与 `readFrom(id, fromSeq)`；`session.append(type, data, {surfaceOp, sourceEventSeqs})`；`ctx.userQuestions.ask({questions, agent})`。
- Produces：默认导出 `DispatchAgentLoop`（Service `agentLoop`，`static inject = ['agents','sessions','sessionPersistence','userQuestions']`，Config `{connectionString, runtimeClass:'default', tailMs:400}`）；`ProxyAgent`。

- [ ] **Step 1: 失败测试**

`test/proxy-agent.test.ts`（用真实 Cordis + dsh-session + dsh-agent + persistence-pg；模拟"Runtime"直接往 PG 写事件，断言 Host 侧 Session 收到 `session/event`）：
```ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { UserQuestionService } from '@deepseek-ai/dsh-user-questions';
import PgSessionPersistence, { createPool, runMigrations } from '@opendb-dsh/session-persistence-pg';
import DispatchAgentLoop from '../src/index.ts';
const PG_URL = process.env.PG_URL; const ctx = new Context(); let pool: any;
before(async () => { if (!PG_URL) return; pool = createPool(PG_URL); await runMigrations(pool);
  await pool.query('TRUNCATE dsh_questions, dsh_thread_queue, dsh_threads, dsh_session_events, dsh_sessions');
  ctx.plugin(SessionStore); ctx.plugin(AgentRegistry); ctx.plugin(UserQuestionService);
  await ctx.plugin(PgSessionPersistence, { connectionString: PG_URL, writeBatchMaxDelayMs: 1 });
  await ctx.plugin(DispatchAgentLoop, { connectionString: PG_URL, tailMs: 50 }); });
after(async () => { await ctx.root.fiber.dispose(); await pool?.end(); });

test('followup enqueues; events written by another writer are mirrored into the live session', { skip: !PG_URL }, async () => {
  const seen: string[] = [];
  ctx.on('session/event', (_s: any, e: any) => { seen.push(e.type); });
  const handle = await ctx.agents.create({ sessionId: 'p0-1' as any, meta: { cwd: '/tmp/opendb-dsh-test' } });
  handle.agent.followup({ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello' }] } as any);
  const q = await pool.query("SELECT kind, payload FROM dsh_thread_queue WHERE session_id = 'p0-1'");
  assert.equal(q.rows[0].kind, 'queued'); assert.equal(q.rows[0].payload.content[0].text, 'hello');
  // 模拟 Runtime：直接写 PG 事件 seq 0..1
  await pool.query(`INSERT INTO dsh_session_events (session_id, seq, type, time, data) VALUES
    ('p0-1', 0, 'turn/start', 1, '{"turn":1}'), ('p0-1', 1, 'turn/end', 2, '{"turn":1,"reason":"completed"}')`);
  await pool.query("UPDATE dsh_threads SET status = 'idle' WHERE session_id = 'p0-1'");
  await handle.agent.whenIdle();
  assert.deepEqual(seen.filter(t => t.startsWith('turn/')), ['turn/start', 'turn/end']);
  assert.equal(handle.agent.session.seq, 2);
  await handle.dispose();
});
```

- [ ] **Step 2: 运行确认失败** → module not found。

- [ ] **Step 3: 实现 `src/queue.ts`**

```ts
import type pg from 'pg';
export async function ensureThread(pool: pg.Pool, sessionId: string, runtimeClass: string) {
  await pool.query(`INSERT INTO dsh_threads (session_id, runtime_class) VALUES ($1, $2) ON CONFLICT (session_id) DO NOTHING`, [sessionId, runtimeClass]);
}
export async function enqueue(pool: pg.Pool, sessionId: string, payload: unknown) {
  await pool.query(`INSERT INTO dsh_thread_queue (session_id, kind, payload) VALUES ($1, 'queued', $2)`, [sessionId, JSON.stringify(payload)]);
}
export async function interrupt(pool: pg.Pool, sessionId: string) {
  await pool.query(`INSERT INTO dsh_thread_queue (session_id, kind) VALUES ($1, 'interrupt')`, [sessionId]);
}
export async function threadStatus(pool: pg.Pool, sessionId: string): Promise<'idle' | 'running' | 'interrupted' | undefined> {
  const r = await pool.query<{ status: any }>('SELECT status FROM dsh_threads WHERE session_id = $1', [sessionId]);
  return r.rows[0]?.status;
}
export async function pendingQueue(pool: pg.Pool, sessionId: string): Promise<number> {
  const r = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM dsh_thread_queue WHERE session_id = $1 AND kind = 'queued' AND admitted_at IS NULL`, [sessionId]);
  return Number(r.rows[0].n);
}
```

- [ ] **Step 4: 实现 `src/tailer.ts`**

```ts
import type { Session } from '@deepseek-ai/dsh-session';
import type pg from 'pg';
/** 把 PG 里比本地 Session 更新的事件逐条 append 进 live Session（Host 侧只镜像、不本地写）。 */
export async function mirrorOnce(persistence: { readFrom(id: any, fromSeq: number): Promise<{ events: any[] }> }, session: Session): Promise<number> {
  const { events } = await persistence.readFrom(session.id, session.seq);
  let n = 0;
  for (const ev of events) {
    if (ev.seq !== session.seq) break;                       // 只接受严格连续
    if (ev.surfaceOp !== undefined) session.append(ev.type, ev.data, { surfaceOp: ev.surfaceOp, ...(ev.sourceEventSeqs ? { sourceEventSeqs: ev.sourceEventSeqs } : {}) });
    else (session as any).append(ev.type, ev.data);
    n++;
  }
  return n;
}
/** 轮询 dsh_questions：把 Runtime 提出的问题交给 Host 的 ctx.userQuestions（dsh 原生 UI 弹问），答案写回。 */
export async function bridgeQuestionsOnce(pool: pg.Pool, ctx: any, agent: any, inFlight: Set<string>) {
  const r = await pool.query<{ id: string; questions: unknown[] }>('SELECT id, questions FROM dsh_questions WHERE session_id = $1 AND answer IS NULL', [agent.id]);
  for (const row of r.rows) {
    if (inFlight.has(row.id)) continue;
    inFlight.add(row.id);
    void ctx.userQuestions.ask({ questions: row.questions, agent })
      .then((answer: unknown) => pool.query('UPDATE dsh_questions SET answer = $2, answered_at = now() WHERE id = $1', [row.id, JSON.stringify(answer)]))
      .catch(() => pool.query('UPDATE dsh_questions SET answer = $2, answered_at = now() WHERE id = $1', [row.id, JSON.stringify({ answers: [] })]))
      .finally(() => inFlight.delete(row.id));
  }
}
```

- [ ] **Step 5: 实现 `src/proxy-agent.ts`**

```ts
import { Inbox, emitAgentEvent } from '@deepseek-ai/dsh-agent';
import { createScope } from '@deepseek-ai/dsh-scope';
import type { Session } from '@deepseek-ai/dsh-session';
import type pg from 'pg';
import { enqueue, interrupt, threadStatus, pendingQueue } from './queue.ts';
import { mirrorOnce, bridgeQuestionsOnce } from './tailer.ts';

export class ProxyAgent {
  readonly id: any; readonly options: any; readonly session: Session; readonly inbox: Inbox; readonly ctx: any;
  status: 'idle' | 'running' = 'idle';
  private idleWaiters: Array<() => void> = [];
  private tailTimer?: NodeJS.Timeout;
  private questionsInFlight = new Set<string>();
  constructor(loopCtx: any, session: Session, options: any, private readonly pool: pg.Pool, private readonly runtimeClass: string, private readonly tailMs: number, private readonly persistence: any) {
    this.id = session.id; this.session = session; this.options = options;
    const scope = createScope(loopCtx, this);
    this.ctx = scope.ctx.extend({ agent: this });
    this.inbox = new Inbox(session, {
      inserted: (m) => emitAgentEvent(this.ctx, this, 'agent/inbox/inserted', { message: m }),
      discarded: (m) => emitAgentEvent(this.ctx, this, 'agent/inbox/discarded', { message: m }),
      claimed: (m, turn) => emitAgentEvent(this.ctx, this, 'agent/inbox/claimed', { message: m, turn }),
    });
  }
  private setStatus(s: 'idle' | 'running') {
    if (this.status === s) return; this.status = s;
    emitAgentEvent(this.ctx, this, 'agent/status', { status: s });
    if (s === 'idle') { const w = this.idleWaiters; this.idleWaiters = []; w.forEach(f => f()); }
  }
  /** Host 侧不写会话：入队 + 开始 tail。seq 由 Runtime 决定，Host 只镜像。 */
  send(message: any, _target: any, _wakeup: boolean) {
    void enqueue(this.pool, this.id, { content: message.content, source: message.source ?? { kind: 'user' } });
    this.setStatus('running'); this.startTail();
  }
  followup(m: any) { this.send(m, 'next-turn', true); }
  steer(m: any) { this.send(m, 'next-step', true); }
  inject(m: any) { this.send(m, 'next-step', false); }
  cancel(_cause: any, _opts?: any) { void interrupt(this.pool, this.id); }
  whenIdle(): Promise<void> { return this.status === 'idle' ? Promise.resolve() : new Promise(res => this.idleWaiters.push(res)); }
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> { return task(new AbortController().signal); }
  startTail() {
    if (this.tailTimer) return;
    const tick = async () => {
      try {
        await mirrorOnce(this.persistence, this.session);
        await bridgeQuestionsOnce(this.pool, this.ctx, this, this.questionsInFlight);
        const st = await threadStatus(this.pool, this.id);
        const pending = await pendingQueue(this.pool, this.id);
        if (st !== 'running' && pending === 0) {
          await mirrorOnce(this.persistence, this.session);      // 收尾再镜像一次
          this.setStatus('idle'); this.tailTimer = undefined; return;
        }
      } catch { /* 下轮重试 */ }
      this.tailTimer = setTimeout(tick, this.tailMs);
    };
    this.tailTimer = setTimeout(tick, 0);
  }
  stopTail() { if (this.tailTimer) clearTimeout(this.tailTimer); this.tailTimer = undefined; }
}
```

- [ ] **Step 6: 实现 `src/index.ts`（AgentFactory）**

```ts
import z from '@deepseek-ai/schemastery';
import { Service, type Context } from '@deepseek-ai/cordis';
import { emitAgentEvent } from '@deepseek-ai/dsh-agent';
import { createPool, runMigrations } from '@opendb-dsh/session-persistence-pg';
import { ProxyAgent } from './proxy-agent.ts';
import { ensureThread } from './queue.ts';

export default class DispatchAgentLoop extends Service {
  static inject = ['agents', 'sessions', 'sessionPersistence', 'userQuestions'];
  static Config = z.object({ connectionString: z.string().required(), runtimeClass: z.string().default('default'), tailMs: z.number().default(400) });
  private pool; private ready: Promise<void>;
  constructor(ctx: Context, private readonly config: any) {
    super(ctx, 'agentLoop');
    this.pool = createPool(config.connectionString);
    this.ready = runMigrations(this.pool);
    ctx.effect(() => ctx.agents.setFactory(this as any), 'dispatch.setFactory()');
    ctx.effect(() => () => this.pool.end(), 'dispatch.pool');
    ctx.systemPrompt?.variable?.('cwd', (c: any) => c.agent?.session.header.cwd);
  }
  async createAgent(ownerCtx: any, options: any) {
    await this.ready;
    const meta = { ...options.meta };
    const session = this.ctx.sessions.prepare(options.sessionId, { meta, seed: options.seed ?? [], seedSource: 'construction' });
    await this.ctx.sessionPersistence.create(session.header);           // 落 header 让 Runtime 可 resume
    await ensureThread(this.pool, session.id, this.config.runtimeClass);
    return this.publish(ownerCtx, session, options, 'startup');
  }
  async resume(ownerCtx: any, options: any) {
    await this.ready;
    const preparation = await this.ctx.sessionPersistence.prepare(options.resumeSessionId, options.signal);
    try {
      await ensureThread(this.pool, options.resumeSessionId, this.config.runtimeClass);
      return await this.publish(ownerCtx, preparation.session, options, 'resume');
    } finally { preparation[Symbol.dispose](); }
  }
  private async publish(ownerCtx: any, session: any, options: any, source: 'startup' | 'resume') {
    const agent = new ProxyAgent(this.ctx, session, options.agentOptions ?? {}, this.pool, this.config.runtimeClass, this.config.tailMs, this.ctx.sessionPersistence);
    const commit = await options.setup?.(agent.ctx);
    const detachSession = agent.ctx.sessions.enter(session);
    const detachAgent = this.ctx.agents.enter(agent, ownerCtx.agent);
    agent.ctx.sessions.announce(session);
    this.ctx.agents.announce(agent);
    commit?.commit?.();
    emitAgentEvent(this.ctx, agent, 'agent/session-start', { source });
    if (source === 'resume') agent.startTail();     // 可能有 Runtime 正在跑
    return { agent, dispose: async () => { agent.stopTail(); detachAgent(); detachSession(); } };
  }
}
export { DispatchAgentLoop, ProxyAgent };
```

- [ ] **Step 7: 构建 + 测试** → 1 PASS。常见失败与处置：`sessions.prepare` 选项名不对 → 对照 `dsh-session/lib/types/index.d.ts:290-416` 的 `PrepareSessionOptions`；`session.append` 因 data 校验失败 → 检查测试插入的 `data` 是否符合 `SessionEventMap[type]`；`AgentRegistry.enter` 参数 → 对照 `index.d.ts:209-383`。**不要**为绕过校验放宽 provider。

- [ ] **Step 8: Commit** —— `git commit -m "feat(agent-loop-dispatch): Host 侧 AgentFactory 代理（入队 + PG tail 镜像回灌 + ask_user 桥）"`

---

### Task 4: bundle 与 profile —— 两棵 dsh 树跑起来（本地两个进程）

**Files:**
- Create: `packages/bundle-host/{package.json,cordis.patch.yml}`, `packages/bundle-runtime/{package.json,cordis.patch.yml}`
- Create: `profiles/host/{package.json,cordis.patch.yml,pnpm-workspace.yaml}`, `profiles/runtime/{...}`
- Create: `scripts/run-host.sh`, `scripts/run-runtime.sh`

**Interfaces:**
- Produces：`DSH_HOME=$PWD/.dsh-home pnpm exec dsh --profile host` 起 Web（0.0.0.0:3080）；`--profile runtime` 起 worker。环境变量：`OPENDB_PG_URL`、`DEEPSEEK_API_KEY`、`OPENDB_RUNTIME_CLASS`（默认 default）、`OPENDB_POD_NAME`。

- [ ] **Step 1: bundle-host**

`packages/bundle-host/package.json`：
```json
{ "name": "@opendb-dsh/bundle-host", "version": "0.0.1", "private": false, "type": "module",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "dependencies": { "@opendb-dsh/agent-loop-dispatch": "workspace:*", "@opendb-dsh/session-persistence-pg": "workspace:*" },
  "files": ["cordis.patch.yml"] }
```
`packages/bundle-host/cordis.patch.yml`：
```yaml
# opendb-dsh Host 层：叠在 dsh-base + dsh-web-app 之后。config 整体替换；name 是断言，替换一行 = disable + insert。
- id: agent-loop
  disabled: true
- id: session-persistence-jsonl
  disabled: true
- id: hmr
  disabled: true
- id: webserver
  config:
    host: '0.0.0.0'
    port: 3080
- insert:
    - id: session-persistence-pg
      name: '@opendb-dsh/session-persistence-pg'
      config:
        connectionString: !!js process.env.OPENDB_PG_URL
    - id: agent-loop-dispatch
      name: '@opendb-dsh/agent-loop-dispatch'
      config:
        connectionString: !!js process.env.OPENDB_PG_URL
        runtimeClass: !!js process.env.OPENDB_RUNTIME_CLASS ?? 'default'
        tailMs: 400
```
- [ ] **Step 2: bundle-runtime**

`packages/bundle-runtime/cordis.patch.yml`：
```yaml
# opendb-dsh Runtime 层：叠在 dsh-base 之后（无 web-app）。P0：零本地工具，只保留 ask_user。
- id: session-persistence-jsonl
  disabled: true
- id: hmr
  disabled: true
- id: session-title-llm
  disabled: true
- id: tool-bash
  disabled: true
- id: tool-fs
  disabled: true
- id: tool-fs-search
  disabled: true
- id: tool-str-replace-editor
  disabled: true
- id: tool-jobs
  disabled: true
- id: tool-web
  disabled: true
- id: tool-workflow
  disabled: true
- id: tool-ralph
  disabled: true
- id: workflow-worker-thread
  disabled: true
- id: bash-sandbox
  disabled: true
- id: fs-sandbox
  disabled: true
- insert:
    - id: session-persistence-pg
      name: '@opendb-dsh/session-persistence-pg'
      config:
        connectionString: !!js process.env.OPENDB_PG_URL
    - id: tool-ask-user
      name: '@deepseek-ai/dsh-tool-ask-user'
    - id: runtime-worker
      name: '@opendb-dsh/runtime-worker'
      config:
        connectionString: !!js process.env.OPENDB_PG_URL
        runtimeClass: !!js process.env.OPENDB_RUNTIME_CLASS ?? 'default'
        podName: !!js process.env.OPENDB_POD_NAME ?? process.env.HOSTNAME ?? 'runtime-local'
        pollMs: 2000
        heartbeatMs: 5000
        staleMs: 30000
        healthPort: !!js Number(process.env.OPENDB_HEALTH_PORT ?? 9090)
```
`packages/bundle-runtime/package.json` 同上，deps 为 `runtime-worker` + `session-persistence-pg`。

- [ ] **Step 3: profiles**

`profiles/host/package.json`：
```json
{ "name": "dsh-profile-host", "private": true,
  "dependencies": { "@opendb-dsh/bundle-host": "workspace:*" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@opendb-dsh/bundle-host"] } } }
```
`profiles/host/cordis.patch.yml`：`[]`；`profiles/host/pnpm-workspace.yaml`：照抄 dsh 的（`packages: [.]`, `nodeLinker: hoisted`, `autoInstallPeers: false`）。
`profiles/runtime/package.json` bundles：`["@deepseek-ai/dsh-base", "@opendb-dsh/bundle-runtime"]`。

`scripts/run-host.sh`：
```bash
#!/usr/bin/env bash
set -euo pipefail
export DSH_HOME="${DSH_HOME:-$PWD/.dsh-home}"; mkdir -p "$DSH_HOME/profiles"
ln -sfn "$PWD/profiles/host" "$DSH_HOME/profiles/host"
export OPENDB_PG_URL="${OPENDB_PG_URL:-postgres://dsh:dsh@127.0.0.1:5433/dsh}"
export DSH_TELEMETRY_DISABLED=1 DSH_PERMISSION_MODE=read-only
exec pnpm exec dsh --profile host "$@"
```
`scripts/run-runtime.sh` 同上，profile 改 `runtime`，另 `export OPENDB_POD_NAME="${OPENDB_POD_NAME:-runtime-$$}" OPENDB_HEALTH_PORT="${OPENDB_HEALTH_PORT:-9090}"`。

- [ ] **Step 4: 组合校验（不启动）**

```bash
pnpm install && pnpm build
DSH_HOME=$PWD/.dsh-home OPENDB_PG_URL=x scripts/run-host.sh --dump-config | grep -E "id: (agent-loop|agent-loop-dispatch|session-persistence-(jsonl|pg)|webserver)" -A3
DSH_HOME=$PWD/.dsh-home OPENDB_PG_URL=x scripts/run-runtime.sh --dump-config | grep -E "id: (runtime-worker|session-persistence-pg|tool-ask-user|agent-loop)" -A3
```
Expected：host 里 `agent-loop`/`session-persistence-jsonl` 带 `disabled: true`，`agent-loop-dispatch`/`session-persistence-pg` 存在，`webserver.config.host: 0.0.0.0`；runtime 里 `runtime-worker` 存在、`agent-loop` 未禁用。若 dump 里出现 `patch: entry ... not found` 警告，说明 id 写错。

- [ ] **Step 5: 本地双进程冒烟**

终端 1：`scripts/dev-pg.sh`；终端 2：`DEEPSEEK_API_KEY=... scripts/run-host.sh`（打印 URL）；终端 3：`DEEPSEEK_API_KEY=... scripts/run-runtime.sh`。
浏览器打开 `http://127.0.0.1:3080` → 新建会话 → 发 "你好，请回复一句话"。
Expected：Runtime 终端出现 claim 日志；UI 里出现助手回复；PG `dsh_session_events` 里有该会话 `turn/start … turn/end`；`dsh_threads.status` 回到 `idle`。
排障：启动末尾报 PENDING → 看缺哪个服务（`inject` 拼错或包未解析）；`--dump-config` 无警告但插件不加载 → 检查 profile 目录 `node_modules/@opendb-dsh/*` 是否存在（pnpm workspace 链接）。

- [ ] **Step 6: Commit** —— `git commit -m "feat: host/runtime bundle 与 profile；本地双进程脚本"`

---

### Task 5: 验收脚本（接力 + 中断 + ask_user）

**Files:**
- Create: `scripts/e2e-p0.sh`

**Interfaces:**
- Consumes：dsh Web `/api` RPC（`POST /api/session.create` `{}`、`POST /api/session.prompt` `{sessionId, mode:'queue', content:[{type:'text',text}]}`、`POST /api/session.history` `{sessionId}`——方法名与 payload 以 `dsh-host-apiproxy/lib/types/api/sessions.d.ts` 为准，脚本开头 `grep` 一次确认）；`dsh_threads` / `dsh_session_events`。

- [ ] **Step 1: 写脚本**

```bash
#!/usr/bin/env bash
# 前置：dev-pg 已起；host 已起在 :3080；runtime A、B 已起（OPENDB_POD_NAME=A / B, 端口 9090/9091）。
set -euo pipefail
API=${API:-http://127.0.0.1:3080/api}; PG=${OPENDB_PG_URL:-postgres://dsh:dsh@127.0.0.1:5433/dsh}
sql() { docker exec -i opendb-dsh-pg psql -U dsh -d dsh -tAc "$1"; }
SID=$(curl -s -X POST "$API/session.create" -H 'content-type: application/json' -H "origin: http://127.0.0.1:3080" -d '{}' | sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p')
echo "session=$SID"
curl -s -X POST "$API/session.prompt" -H 'content-type: application/json' -H "origin: http://127.0.0.1:3080" \
  -d "{\"sessionId\":\"$SID\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"只回复 OK\"}]}" >/dev/null
for i in $(seq 1 60); do [ "$(sql "select status from dsh_threads where session_id='$SID'")" = idle ] && [ "$(sql "select count(*) from dsh_session_events where session_id='$SID' and type='turn/end'")" -ge 1 ] && break; sleep 1; done
POD1=$(sql "select admitted_by from dsh_thread_queue where session_id='$SID' order by id desc limit 1"); echo "turn1 ran on $POD1"
echo "kill $POD1 ..."; pkill -f "OPENDB_POD_NAME=$POD1" || kill "$(cat .dsh-home/$POD1.pid)"
curl -s -X POST "$API/session.prompt" -H 'content-type: application/json' -H "origin: http://127.0.0.1:3080" \
  -d "{\"sessionId\":\"$SID\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"再回复一次 OK\"}]}" >/dev/null
for i in $(seq 1 60); do [ "$(sql "select count(*) from dsh_session_events where session_id='$SID' and type='turn/end'")" -ge 2 ] && break; sleep 1; done
POD2=$(sql "select admitted_by from dsh_thread_queue where session_id='$SID' order by id desc limit 1"); echo "turn2 ran on $POD2"
[ "$POD1" != "$POD2" ] && echo "RELAY OK" || { echo "RELAY FAILED"; exit 1; }
sql "select seq, type from dsh_session_events where session_id='$SID' order by seq" | tail -20
```
（`run-runtime.sh` 里补一行 `echo $$ > "$DSH_HOME/$OPENDB_POD_NAME.pid"` 便于 kill。）

- [ ] **Step 2: 手工验收 ask_user**

在 UI 里发："在回答前先用 ask_user 工具问我今天想检查哪个库，然后按我的回答回复"。
Expected：dsh 原生提问 UI 弹出（来自 Host 的 `question/requested`）；作答后 Runtime 继续并回复；`dsh_questions` 有 `answer` 非空的一行。

- [ ] **Step 3: 中断验收**：发一条会长回答的消息，UI 点停止 → `dsh_thread_queue` 出现 `kind=interrupt` 且 Runtime 日志显示 cancel，`turn/end` 的 reason 为中断类。

- [ ] **Step 4: Commit** —— `git commit -m "test: P0 验收脚本（接力/中断/ask_user）"`

---

### Task 6: 镜像 + mac 上的 k8s 部署

**Files:**
- Create: `deploy/docker/dsh.Dockerfile`, `deploy/k8s/p0/{namespace,postgres,host,runtime,secret.example}.yaml`, `scripts/k8s-p0.sh`

**Interfaces:**
- Produces：镜像 `opendb-dsh:p0`；命名空间 `opendb-dsh`；`host` Deployment（1 副本，Service NodePort 30080）；`runtime` Deployment（2 副本，`OPENDB_POD_NAME` = `metadata.name`）；`postgres` StatefulSet（1）。

- [ ] **Step 1: Dockerfile**

```dockerfile
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates git && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && rm -rf /var/lib/apt/lists/*
ENV DSH_HOME=/var/lib/dsh
WORKDIR /app
COPY --from=build /src /app
# 预烘焙 profile 目录与 profiles/node_modules 符号链接（dsh 每次启动会重写 cordis.yml，目录需可写）
RUN mkdir -p $DSH_HOME/profiles && ln -s /app/profiles/host $DSH_HOME/profiles/host && ln -s /app/profiles/runtime $DSH_HOME/profiles/runtime \
 && OPENDB_PG_URL=x node_modules/.bin/dsh --profile host --dump-config >/dev/null \
 && OPENDB_PG_URL=x node_modules/.bin/dsh --profile runtime --dump-config >/dev/null \
 && chown -R node:node /app $DSH_HOME
USER node
ENV DSH_TELEMETRY_DISABLED=1 DSH_PERMISSION_MODE=read-only
ENTRYPOINT ["tini","--","node_modules/.bin/dsh"]
CMD ["--profile","host"]
```
（构建期跑一次 `--dump-config` 让 `profiles/node_modules` 符号链接落盘。）

- [ ] **Step 2: k8s 清单（要点）**

`postgres.yaml`：`postgres:16` StatefulSet + Service `postgres:5432`，env `POSTGRES_USER/PASSWORD/DB=dsh`，`emptyDir`（P0 不要求持久）。
`secret.example.yaml`：`DEEPSEEK_API_KEY`（user 填）。
`host.yaml`：Deployment 1 副本，image `opendb-dsh:p0`，args `["--profile","host"]`，env `OPENDB_PG_URL=postgres://dsh:dsh@postgres:5432/dsh`、`DEEPSEEK_API_KEY` from secret；`readinessProbe` TCP 3080；Service NodePort 30080。
`runtime.yaml`：Deployment 2 副本，args `["--profile","runtime"]`，env 同上 + `OPENDB_POD_NAME` valueFrom `metadata.name`、`OPENDB_HEALTH_PORT=9090`；`readinessProbe` HTTP `/` 9090；`terminationGracePeriodSeconds: 60`。
`scripts/k8s-p0.sh`：`docker build -t opendb-dsh:p0 -f deploy/docker/dsh.Dockerfile . && kind load docker-image opendb-dsh:p0 --name <cluster>`（OrbStack 直接可用本地镜像）`&& kubectl apply -f deploy/k8s/p0/`。

- [ ] **Step 3: 在 mac 上部署并跑验收**

```bash
ssh admin@192.168.128.1 'cd ~/opendb-dsh && scripts/k8s-p0.sh && kubectl -n opendb-dsh get pods -w'
```
然后浏览器打开 `http://192.168.128.1:30080`（或 kind 需 port-forward：`kubectl -n opendb-dsh port-forward svc/host 3080:3080`），重复 Task 5 的三项验收，其中"杀 Runtime"改为 `kubectl -n opendb-dsh delete pod <runtime-a>`。
Expected：与本地双进程一致；`kubectl get pods` 显示新的 runtime pod 拉起并接力。

- [ ] **Step 4: 记录结果并提交**

在 `docs/2026-08-16-opendb-dsh-platform-design.md` §12 P0 行填写"验收结果 + 日期 + 发现的问题"，若 §9 备选被触发也在此记录。
```bash
git add deploy scripts docs && git commit -m "feat: P0 镜像与 k8s 清单；记录 P0 验收结果" && git push
```

---

## 计划自检（已完成）

- **规格覆盖**：§12 P0 的四条验收（UI 发消息在 Runtime 执行并实时显示 / 杀 A 由 B 接力 / 跨 pod ask_user / `--dump-config` 无 PENDING）分别落在 Task 4-5-6；§13 三条源码修正（真实目录 cwd、Host 只镜像不本地写、ask_user 经 PG）落在 Task 3/4；§9 备选路径在 Task 6 Step 4 留了记录口。
- **占位符扫描**：无 TBD；所有 dsh API 名称均在源码核对（`createUserMessage`@dsh-llm、`Inbox`/`emitAgentEvent`@dsh-agent、`createScope`@dsh-scope、`SessionPreparation`@dsh-session、`PersistenceBackend` 8 hook、`session.append(type,data,{surfaceOp,sourceEventSeqs})`）；两处以"以 .d.ts 为准"标注的是参数选项名（`PrepareSessionOptions`、`AskUserQuestionAnswer` 形状），并给了文件路径。
- **类型一致性**：`claimNext/heartbeat/release/markStale/pendingInterrupts` 在 Task 2 定义、Task 2 index 使用；`ensureThread/enqueue/interrupt/threadStatus/pendingQueue` 在 Task 3 内部一致；`createPool/runMigrations` 由 Task 1 导出、Task 2/3 导入；队列 payload `{content, source}` 在 Task 2 test/Task 3 send/Task 2 run 三处一致。
- **已知不确定点（P0 就是为验证它们）**：① `sessions.prepare` 的 seed 选项名与 header 必填字段；② `Session.append` 对镜像事件 `data` 的运行时校验是否有额外要求（如 `assistant/message` 的 `sourceEventSeqs` 非空约束）；③ agent-loop `resume` 一个"header 有、事件为空"的会话是否被接受；④ `AgentRegistry.enter` 是否要求 owner 为 `undefined` 以外的值。任一不成立 → 按 §9 备选（Host 对交互 thread 本进程跑真 loop）记录并调整。
