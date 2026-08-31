/**
 * 集群外的被管数据库舰队（几百台不平铺）：按环境/引擎分组的节点矩阵 + 搜索与筛选 + 「需要关注」清单 +
 * 选中项卡片（架构图上只有它与集群连线）。分组键取节点名前缀（prod- / stg- / test- 之类），取不到就按引擎分组。
 */
import { useMemo, useState } from 'react';
import { T, mono, LVCN, RANK, BAD } from './format.ts';
import type { Db } from './types.ts';

/** 分组：优先用名字里的环境段（prod/stg/test/dev/uat），否则按引擎 */
export function groupOf(d: Db): string {
  const m = /(?:^|[-_])(prod|prd|stg|stage|pre|uat|test|dev|qa)(?:[-_]|$)/i.exec(d.name);
  if (m !== null) {
    const k = m[1].toLowerCase();
    return ({ prod: '生产', prd: '生产', stg: '预发', stage: '预发', pre: '预发', uat: '预发', test: '测试', dev: '开发', qa: '测试' } as Record<string, string>)[k] ?? k;
  }
  return d.engine;
}
const ORDER = ['生产', '预发', '测试', '开发'];

export function Fleet({ fleet, selected, onSelect, boxRef }: {
  fleet: { total: number; counts: Record<string, number>; items: Db[] };
  selected: string; onSelect: (id: string) => void;
  boxRef: React.MutableRefObject<HTMLDivElement | null>;
}) {
  const [q, setQ] = useState('');
  const [eng, setEng] = useState('');
  const [env, setEnv] = useState('');
  const [onlyBad, setOnlyBad] = useState(false);

  const engines = useMemo(() => [...new Set(fleet.items.map((d) => d.engine))].sort(), [fleet.items]);
  const groups = useMemo(() => {
    const set = [...new Set(fleet.items.map(groupOf))];
    return set.sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
  }, [fleet.items]);
  const vis = useMemo(() => fleet.items.filter((d) =>
    (q === '' || d.name.includes(q) || d.addr.includes(q))
    && (eng === '' || d.engine === eng)
    && (env === '' || groupOf(d) === env)
    && (!onlyBad || BAD.has(d.level))), [fleet.items, q, eng, env, onlyBad]);
  const attn = useMemo(() => fleet.items.filter((d) => BAD.has(d.level))
    .sort((a, b) => RANK[a.level] - RANK[b.level] || a.name.localeCompare(b.name)), [fleet.items]);
  const picked = fleet.items.find((d) => d.id === selected) ?? fleet.items[0];

  const pill = (on: boolean): any => ({ border: `1px solid ${on ? T.blue : T.line}`, borderRadius: 6, padding: '0 8px', fontSize: 12, color: on ? '#fff' : T.sub, background: on ? T.blue : '#fff', cursor: 'pointer', whiteSpace: 'nowrap' });
  const dist = ['ok', 'notice', 'warn', 'crit', 'off', 'unknown'].filter((k) => (fleet.counts[k] ?? 0) > 0);

  return (
    <div ref={boxRef} style={{ position: 'relative', zIndex: 1, marginTop: 40, border: '1.5px dashed #E4D3B4', borderRadius: 12, background: 'rgba(255,253,249,.9)', padding: '10px 14px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: T.sub, marginBottom: 9, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 13.5, fontWeight: 600, color: T.ink }}>被管数据库</b>
        <span>共 {fleet.total} 个节点 · 集群外，平台只读连接{fleet.total > 1 ? ` · ${dist.map((k) => `${LVCN[k]} ${fleet.counts[k]}`).join(' ')}` : ''}</span>
      </div>
      {fleet.total === 0 ? (
        <div style={{ fontSize: 13.5, color: T.dim, padding: '6px 2px' }}>还没有纳管任何数据库节点——在会话里说一句即可纳管。</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 190px', gap: 14, alignItems: 'start' }}>
          <div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
              <input value={q} onChange={(e) => setQ(e.target.value.trim())} placeholder="搜索节点名 / 地址"
                style={{ font: 'inherit', fontSize: 12.5, border: `1px solid ${T.line}`, borderRadius: 7, padding: '3px 9px', width: 150, background: '#fff' }} />
              <span onClick={() => setEng('')} style={pill(eng === '')}>全部引擎</span>
              {engines.map((e) => <span key={e} onClick={() => setEng(e)} style={pill(eng === e)}>{e}</span>)}
              {groups.length > 1 ? <span onClick={() => setEnv('')} style={pill(env === '')}>全部环境</span> : null}
              {groups.length > 1 ? groups.map((g) => <span key={g} onClick={() => setEnv(g)} style={pill(env === g)}>{g}</span>) : null}
              <span onClick={() => setOnlyBad(!onlyBad)} style={pill(onlyBad)}>只看告警</span>
              <span style={{ fontSize: 12, color: T.dim }}>{vis.length === fleet.total ? `${fleet.total} 个` : `筛出 ${vis.length} / ${fleet.total} 个`}</span>
            </div>
            <div style={{ maxHeight: 250, overflow: 'auto', padding: '2px 1px' }}>
              {groups.filter((g) => vis.some((d) => groupOf(d) === g)).map((g) => {
                const list = vis.filter((d) => groupOf(d) === g).sort((a, b) => RANK[a.level] - RANK[b.level] || a.name.localeCompare(b.name));
                const bad = list.filter((d) => BAD.has(d.level)).length;
                return (
                  <div key={g} style={{ marginBottom: 9 }}>
                    <div style={{ fontSize: 11.5, color: T.dim, display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
                      {g}<b style={{ color: T.sub, fontWeight: 600, fontFamily: mono }}>{list.length}</b>
                      {bad > 0 ? <span style={{ color: T.lv.warn }}>需关注 {bad}</span> : null}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                      {list.map((d) => (
                        <span key={d.id} onClick={() => onSelect(d.id)}
                          title={`${d.name} · ${d.engine} · ${LVCN[d.level]}${d.lastCollectedAt === null ? '（未巡检）' : ''}`}
                          style={{
                            width: 13, height: 13, borderRadius: 3, cursor: 'pointer', flex: 'none', background: T.lv[d.level] ?? T.lv.unknown,
                            outline: d.id === selected ? `2px solid ${T.ink}` : 'none', outlineOffset: 1,
                          }} />
                      ))}
                    </div>
                  </div>
                );
              })}
              {vis.length === 0 ? <div style={{ fontSize: 12.5, color: T.dim, padding: '8px 2px' }}>没有符合条件的节点</div> : null}
            </div>
            <div style={{ display: 'flex', height: 7, borderRadius: 4, overflow: 'hidden', margin: '8px 0 6px' }}>
              {dist.map((k) => <i key={k} title={`${LVCN[k]} ${fleet.counts[k]}`} style={{ display: 'block', height: '100%', width: `${((fleet.counts[k] ?? 0) / fleet.total * 100).toFixed(2)}%`, background: T.lv[k] }} />)}
            </div>
            <div style={{ display: 'flex', gap: 12, fontSize: 11.5, color: T.sub, flexWrap: 'wrap' }}>
              {dist.map((k) => <span key={k}><i style={{ width: 8, height: 8, borderRadius: 2, display: 'inline-block', marginRight: 4, verticalAlign: 'middle', background: T.lv[k] }} />{LVCN[k]}</span>)}
              <span style={{ color: T.dim }}>一格 = 一个被管节点 · 悬停看名字 · 点选看详情</span>
            </div>
          </div>
          <div>
            <div style={{ border: `1px solid ${T.line}`, borderRadius: 8, background: '#fff', padding: '8px 10px' }}>
              <div style={{ fontSize: 11.5, color: T.dim, marginBottom: 5 }}>已选中（连到集群）</div>
              {picked === undefined ? <div style={{ fontSize: 12, color: T.dim }}>未选中</div> : (
                <div data-picked onClick={() => onSelect(picked.id)}
                  style={{ border: `1px solid ${T.ext}`, borderRadius: 8, background: '#fff', padding: '7px 9px', cursor: 'pointer', boxShadow: `0 0 0 2px ${T.ext}1f` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 17, height: 17, borderRadius: 4, background: T.ext, color: '#fff', fontSize: 9.5, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>db</span>
                    <span style={{ fontSize: 12.5, fontWeight: 600, fontFamily: mono }}>{picked.name}</span>
                  </div>
                  <div style={{ fontSize: 10.5, color: T.dim, marginTop: 3, fontFamily: mono }}>{picked.engine}</div>
                  <div style={{ fontSize: 10.5, color: T.dim, fontFamily: mono }}>{picked.addr}</div>
                  <div style={{ marginTop: 4 }}>
                    <span style={{ fontSize: 11.5, borderRadius: 6, padding: '1px 8px', fontWeight: 500, background: T.soft[picked.level] ?? T.fill2, color: T.lv[picked.level] ?? T.sub }}>{LVCN[picked.level]}</span>
                  </div>
                </div>
              )}
            </div>
            <div style={{ border: `1px solid ${T.line}`, borderRadius: 8, background: '#fff', padding: '8px 10px', marginTop: 8 }}>
              <div style={{ fontSize: 11.5, color: T.dim, marginBottom: 5 }}>需要关注 · 按严重度排序</div>
              {attn.length === 0 ? <div style={{ fontSize: 12, color: T.dim }}>全部正常</div> : (
                <>
                  {attn.slice(0, 6).map((d) => (
                    <div key={d.id} onClick={() => onSelect(d.id)}
                      style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, padding: '2px 4px', borderRadius: 5, cursor: 'pointer', background: d.id === selected ? '#EEF3FF' : undefined }}>
                      <i style={{ width: 7, height: 7, borderRadius: 4, flex: 'none', background: T.lv[d.level] }} />
                      <span style={{ fontFamily: mono, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</span>
                      <span style={{ marginLeft: 'auto', color: T.dim, whiteSpace: 'nowrap' }}>{LVCN[d.level]}</span>
                    </div>
                  ))}
                  {attn.length > 6 ? <div style={{ fontSize: 11, color: T.dim, marginTop: 5 }}>另 {attn.length - 6} 个，用「只看告警」查看全部</div> : null}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
