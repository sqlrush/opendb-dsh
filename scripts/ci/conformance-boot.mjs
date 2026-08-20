#!/usr/bin/env node
/**
 * Conformance：真实 Loader e2e + assertEntriesActivated（横切工作两小件，P3 补齐）。
 * 用 dsh-app-boot 的编程式 boot 把 profile 的 cordis 树真正拉起（真实 Loader、真实插件激活），
 * 然后断言每个 enabled entry 都 ACTIVE——比 dump-config（静态解析）多出一整层运行期保障。
 * 依赖：PG（必须，OPENDB_PG_URL）；redis/qdrant/minio/ollama 缺失时相关插件降级但仍须 ACTIVE
 * （这本身就是韧性断言：外设缺失不允许炸 boot）。
 * 用法：OPENDB_PG_URL=... node scripts/ci/conformance-boot.mjs [host|runtime|collector]
 */
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const profile = process.argv[2] ?? 'host';
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const profileDir = join(repoRoot, 'profiles', profile);
const req = createRequire(join(profileDir, 'package.json'));

const appBootEntry = pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot', { paths: [req.resolve('@deepseek-ai/dsh/package.json')] })).href;
const { boot, assertEntriesActivated } = await import(appBootEntry);

// cordis.yml 由 dsh 启动期从 profile 模板+patch 合成——先经 CLI dump-config 让它生成（幂等）
const { spawnSync } = await import('node:child_process');
const { existsSync } = await import('node:fs');
const configPath = join(profileDir, 'cordis.yml');
if (!existsSync(configPath)) {
  const home = process.env.DSH_HOME ?? join(repoRoot, '.dsh-conformance-home');
  const { mkdirSync, symlinkSync, rmSync } = await import('node:fs');
  mkdirSync(join(home, 'profiles'), { recursive: true });
  rmSync(join(home, 'profiles', profile), { force: true });
  symlinkSync(profileDir, join(home, 'profiles', profile));
  const r = spawnSync(join(repoRoot, 'node_modules', '.bin', 'dsh'), ['--profile', profile, '--dump-config'], {
    env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (r.status !== 0 || !existsSync(configPath)) {
    process.stderr.write(`conformance FAIL: dump-config 未能生成 ${configPath}\n`);
    process.exit(1);
  }
}
const timeout = setTimeout(() => {
  process.stderr.write(`conformance FAIL: ${profile} boot did not reach active within 120s\n`);
  process.exit(1);
}, 120_000);

try {
  const ctx = await boot('dsh', configPath);
  await assertEntriesActivated(ctx, 'dsh');
  clearTimeout(timeout);
  process.stdout.write(`conformance OK: profile=${profile} all enabled entries ACTIVE\n`);
  process.exit(0);
} catch (cause) {
  clearTimeout(timeout);
  process.stderr.write(`conformance FAIL (${profile}): ${String(cause?.message ?? cause)}\n`);
  process.exit(1);
}
