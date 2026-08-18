/** Compact monospace table rendering for model-facing tool output. */

const MAX_CELL = 60;

export function cell(value: unknown): string {
  if (value === null || value === undefined) return '∅';
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const flat = s.replace(/\s+/g, ' ');
  return flat.length > MAX_CELL ? `${flat.slice(0, MAX_CELL - 1)}…` : flat;
}

export function renderTable(fields: string[], rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '(0 rows)';
  const cols = fields.length > 0 ? fields : Object.keys(rows[0]);
  const grid = [cols, ...rows.map((r) => cols.map((c) => cell(r[c])))];
  const widths = cols.map((_, i) => Math.max(...grid.map((row) => row[i].length)));
  const line = (row: string[]) => row.map((v, i) => v.padEnd(widths[i])).join(' | ').trimEnd();
  return [line(grid[0]), widths.map((w) => '-'.repeat(w)).join('-|-'), ...grid.slice(1).map(line)].join('\n');
}

export function clampText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  return `${Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')}\n[输出超过 ${maxBytes} 字节已截断，请缩小查询范围]`;
}
