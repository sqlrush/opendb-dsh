/**
 * ui-cluster — k8s 集群状态（client-only 插件，2026-08-31 user 通过 docs/prototypes/cluster-r4.html 后开发）。
 * server 半边在 platform-status（/opendb-status 的 cluster 端点）；本包只承载面板的浏览器 bundle，
 * 经 window 桥 registerResourcePanel('cluster', Panel) 进驻 ui-harness 的「资源 › k8s 集群状态」。
 */
import type { Context } from '@deepseek-ai/cordis';

export const name = 'ui-cluster';

/** Host 半边无逻辑（同 ui-node-monitor）——但 apply 必须有：cordis 只接受函数或带 apply 的对象，缺了会拒绝加载整棵插件树。 */
export function apply(_ctx: Context): void { /* client-only plugin */ }
