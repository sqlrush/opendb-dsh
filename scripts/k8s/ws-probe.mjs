const H = process.env.OPENDB_HOST ?? '192.168.139.164', P = process.env.OPENDB_HOST_PORT ?? '30080';
const url = `ws://${H}:${P}/api/events.mux`;
for (const variant of ['headers', 'plain']) {
  await new Promise((resolve) => {
    const ws = variant === 'headers' ? new WebSocket(url, { headers: { origin: `http://${H}:${P}` } }) : new WebSocket(url);
    const t0 = Date.now(); let frames = 0;
    ws.addEventListener('open', () => console.log(variant, 'open', Date.now() - t0, 'ms'));
    ws.addEventListener('message', () => { frames++; });
    ws.addEventListener('error', (e) => console.log(variant, 'error', e.message ?? e.type));
    ws.addEventListener('close', (e) => { console.log(variant, 'close', e.code, e.reason, 'frames', frames); resolve(); });
    setTimeout(() => { console.log(variant, 'timeout; readyState', ws.readyState, 'frames', frames); ws.close(); }, 5000);
  });
}
