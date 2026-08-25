/**
 * 排队投影同步器（2026-08-25 中毒 Runtime 复盘，Q2/Q3）。
 *
 * 原生 dsh 的 queue dock 只吃 Host 推的 `session/queue` 帧，而那帧只在 `agent/inbox/spliced` 落日志时才发；
 * opendb 的 Host 不写日志（单写者：Runtime 分配 seq），所以帧永远不来。这里每秒向 `/opendb queue/list`
 * 拉一次 PG 队列投影，合成同形状的帧经 `ctx.sessions.handleMuxEnvelope` 喂给客户端运行时——展示 / 编辑 /
 * 移除 / 插队全部沿用原生 dock 与 `session.updateQueue`，零自研 UI。
 *
 * 推送规则：投影变化即推；非空时每秒重推（`session/subscribed` 帧会把原生镜像清空，重推即恢复）。
 */

type Call = (endpoint: string, payload?: unknown) => Promise<any>;

interface QueueItem { id: string; placement: 'queued' | 'steering' | 'context'; message: unknown }

const POLL_MS = 1000;

/** Current session id as the dsh client runtime tracks it (undefined when nothing is open). */
function currentSessionId(ctx: any): string | undefined {
  try {
    const current = ctx.sessions?.list?.getSnapshot?.()?.current;
    return typeof current === 'string' && current !== '' ? current : undefined;
  } catch {
    return undefined;
  }
}

function keyOf(items: readonly QueueItem[]): string {
  return items.map((i) => `${i.id}:${i.placement}`).join('|');
}

/** Start polling; returns a stop function. Never throws — a failing tick just waits for the next one. */
export function startQueueSync(ctx: any, call: Call): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let lastKey = '';
  let lastSession: string | undefined;

  const push = (sessionId: string, items: readonly QueueItem[]): void => {
    ctx.sessions.handleMuxEnvelope({ rpcId: 0, payload: { type: 'session/queue', sessionId, items } });
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
        const sessionId = currentSessionId(ctx);
        if (sessionId !== lastSession) { lastSession = sessionId; lastKey = ''; }
        if (sessionId !== undefined) {
          const value = await call('queue/list', { sessionId });
          const items: QueueItem[] = Array.isArray(value?.items) ? value.items : [];
          const key = keyOf(items);
          if (key !== lastKey || items.length > 0) {
            lastKey = key;
            push(sessionId, items);
          }
        }
      }
    } catch {
      /* 瞬时失败（Host 滚动、网络抖动）：下一秒再来 */
    } finally {
      if (!stopped) timer = setTimeout(() => void tick(), POLL_MS);
    }
  };

  timer = setTimeout(() => void tick(), POLL_MS);
  return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
}
