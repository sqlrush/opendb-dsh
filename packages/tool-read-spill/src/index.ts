import type { Context } from '@deepseek-ai/cordis';
import { defineReadSpillTool } from '@opendb-dsh/spill-s3';

export const name = 'tool-read-spill';
export const inject = ['spillStore', 'tools'];

/**
 * read_spill 工具注册（function plugin，已验证模式）。原先在 S3SpillStore 构造器内的
 * inject(['tools']) 注册静默不生效——W4 事故复盘时发现模型工具列表里从未有过 read_spill。
 */
export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  const spill = anyCtx.spillStore;
  if (typeof spill?.readerDeps !== 'function') {
    process.stderr.write('[tool-read-spill] spill service is not S3SpillStore; tool not registered\n');
    return;
  }
  ctx.effect(() => anyCtx.tools.register(defineReadSpillTool(spill.readerDeps())), 'tool-read-spill.read_spill');
}
