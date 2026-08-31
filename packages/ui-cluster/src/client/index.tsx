/**
 * ui-cluster client：资源 › k8s 集群状态（R4，2026-08-31 user 通过 docs/prototypes/cluster-r4.html）。
 * 摘要卡 → 架构图（k8s 边界框：Pod 全量展示、按类型着色、每层居中、Pod 间调用关系连线；框外被管数据库舰队矩阵）
 * → 节点视图 → 事件；点 Pod 或节点格出右侧详情（资源计量 + 运行信息 + 部署）。
 * 数据来自 platform-status 的 /opendb-status cluster 端点（k8s 只读 API + metrics-server + 平台注册表）；纯展示，无写操作。
 */
import { Component, useEffect, useMemo, useRef, useState } from 'react';
import { Diagram, Meter } from './diagram.tsx';
import { Fleet } from './fleet.tsx';
import { T, FONT, mono, tnum, LVCN, RANK, BAD, fmtCpu, fmtMem, fmtPct, fmtInt, mmddhhmm, age, displayNames } from './format.ts';
import type { Cluster, Pod, Node, Db } from './types.ts';

export const inject = ['connection', 'slots'];

const card: any = { background: '#fff', border: `1px solid ${T.line}`, borderRadius: 10, padding: '12px 14px', boxShadow: '0 4px 12px rgba(0,0,0,.02),0 2px 8px rgba(0,0,0,.04)', minWidth: 0 };

class Boundary extends Component<{ children: any }, { err?: string }> {
  state: { err?: string } = {};
  static getDerivedStateFromError(e: unknown) { return { err: String((e as Error)?.message ?? e) }; }
  render() { return this.state.err !== undefined ? <div style={{ fontSize: 14, color: T.lv.crit, padding: 12 }}>集群状态面板渲染失败：{this.state.err}</div> : this.props.children; }
}

function Stat({ l, v, unit, d, color }: { l: string; v: string; unit?: string; d: string; color?: string }) {
  return (
    <div style={{ background: T.fill, borderRadius: 8, padding: '10px 13px', minWidth: 0 }}>
      <div style={{ fontSize: 12.5, color: T.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l}</div>
      <div style={{ fontSize: 21, fontWeight: 600, lineHeight: 1.3, marginTop: 1, whiteSpace: 'nowrap', color, ...tnum }}>
        {v}{unit !== undefined ? <span style={{ fontSize: 12.5, fontWeight: 500, color: T.dim, marginLeft: 4 }}>{unit}</span> : null}
      </div>
      <div style={{ fontSize: 12, color: T.dim, lineHeight: 1.45 }}>{d}</div>
    </div>
  );
}

function Detail({ pod, db, name }: { pod?: Pod; db?: Db; name?: string }) {
  const sec = (t: string) => <div style={{ fontSize: 12, color: T.dim, fontWeight: 600, margin: '13px 0 6px', display: 'flex', alignItems: 'center', gap: 6 }}>{t}<i style={{ flex: 1, height: 1, background: T.line }} /></div>;
  const kv = (rows: [string, string][]) => (
    <div style={{ display: 'grid', gridTemplateColumns: '78px minmax(0,1fr)', gap: '3px 10px', fontSize: 12.5 }}>
      {rows.map(([k, v]) => <div key={k} style={{ display: 'contents' }}><span style={{ color: T.dim }}>{k}</span><span style={{ fontFamily: mono, fontSize: 12, wordBreak: 'break-all' }}>{v}</span></div>)}
    </div>
  );
  const live = (rows: [string, string][]) => (
    <div style={{ border: `1px solid ${T.line}`, borderRadius: 8, padding: '8px 10px', fontSize: 12.5, background: T.fill }}>
      {rows.map(([k, v]) => <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '2px 0' }}><span>{k}</span><b style={{ fontWeight: 600, ...tnum }}>{v}</b></div>)}
    </div>
  );
  if (pod !== undefined) {
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <span style={{ width: 22, height: 22, borderRadius: 6, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#fff', fontWeight: 700, background: pod.hue }}>{pod.comp.slice(0, 1).toUpperCase()}</span>
          <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0, wordBreak: 'break-all' }}>{pod.name}</h3>
        </div>
        <div style={{ fontSize: 12.5, color: T.dim, marginBottom: 10 }}>{name} · {pod.owner || 'Pod'} · {pod.role}</div>
        {sec('资源')}
        <Meter label="CPU" used={pod.cpu} req={pod.cpuReq} lim={pod.cpuLim} unit="m" />
        <Meter label="内存" used={pod.mem} req={pod.memReq} lim={pod.memLim} unit="Mi" />
        {sec('运行信息')}
        {live([
          ['状态', `${pod.phase}${pod.ready ? ' · 就绪' : ' · 未就绪'}`],
          ['运行时长', age(pod.startedAt)],
          ['重启次数', String(pod.restarts)],
          ['所在节点', pod.node],
        ])}
        {sec('部署')}
        {kv([
          ['镜像', pod.images.join(', ')],
          ['Pod IP', pod.podIP ?? '—'],
          ['启动', mmddhhmm(pod.startedAt)],
          ['控制器', pod.owner || '—'],
        ])}
      </>
    );
  }
  if (db !== undefined) {
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <span style={{ width: 22, height: 22, borderRadius: 6, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#fff', fontWeight: 700, background: T.ext }}>db</span>
          <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0, wordBreak: 'break-all' }}>{db.name}</h3>
        </div>
        <div style={{ fontSize: 12.5, color: T.dim, marginBottom: 10 }}>
          被管数据库 · 集群外 · {db.engine} · 最近判定 <span style={{ color: T.lv[db.level] ?? T.sub }}>{LVCN[db.level]}</span>
        </div>
        {sec('运行信息')}
        {live([
          ['连接状态', db.status === 'online' ? '在线' : db.status === 'offline' ? '离线' : db.status],
          ['最近判定', LVCN[db.level]],
          ['最近一次巡检', db.lastCollectedAt === null ? '尚未巡检' : mmddhhmm(db.lastCollectedAt)],
        ])}
        {sec('纳管信息')}
        {kv([['引擎', db.engine], ['地址', db.addr], ['节点 id', db.id]])}
        <div style={{ fontSize: 12.5, color: T.dim, marginTop: 12, lineHeight: 1.6 }}>平台以只读账号连接；权限完全由数据库侧授权决定，平台不做 SQL 过滤。</div>
      </>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 420, gap: 8, color: T.dim, fontSize: 13.5, textAlign: 'center', padding: '0 24px' }}>
      <div style={{ fontSize: 34, opacity: 0.25 }}>◲</div>
      <div>点 k8s 框里的任意 Pod，或框外的任意数据库节点<br />看角色、资源占用与正在运行的信息</div>
    </div>
  );
}

function NodeView({ nodes, pods, names, onPick }: { nodes: Node[]; pods: Pod[]; names: Map<string, string>; onPick: (n: string) => void }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 12 }}>
      {nodes.map((n) => {
        const on = pods.filter((p) => p.node === n.name && p.phase !== 'Succeeded');
        return (
          <div key={n.name} style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14.5, fontWeight: 600 }}>
              <span style={{ width: 9, height: 9, borderRadius: 5, background: n.ready ? T.lv.ok : T.lv.crit, display: 'inline-block' }} />{n.name}
              <span style={{ marginLeft: 'auto', fontSize: 13, borderRadius: 6, padding: '1px 9px', background: T.fill2, color: T.sub, fontWeight: 500 }}>{n.role}</span>
            </div>
            <div style={{ fontSize: 12.5, color: T.dim, marginTop: 4 }}>{fmtCpu(n.cpuCapacity)} · {fmtMem(n.memCapacity)} · {n.version} · {n.ready ? 'Ready' : 'NotReady'}</div>
            {[['CPU', n.cpu, n.cpuCapacity, fmtCpu] as const, ['内存', n.mem, n.memCapacity, fmtMem] as const].map(([label, used, cap, fmt]) => (
              <div key={label} style={{ margin: '7px 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: T.sub, marginBottom: 3 }}>
                  <span>{label}</span><span><b style={{ fontWeight: 600, color: T.ink, ...tnum }}>{fmt(used)}</b> / {fmt(cap)}</span>
                </div>
                <div style={{ height: 7, borderRadius: 4, background: T.fill2, position: 'relative', overflow: 'hidden' }}>
                  <i style={{ position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 4, width: `${Math.max(cap > 0 ? (used / cap) * 100 : 0, 0.6).toFixed(1)}%`, background: T.lv.ok }} />
                </div>
              </div>
            ))}
            <div style={{ fontSize: 12, color: T.dim, marginTop: 8 }}>承载 {on.length} 个 Pod</div>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 6 }}>
              {on.map((p) => (
                <span key={p.name} onClick={() => onPick(p.name)}
                  style={{ fontSize: 11.5, borderRadius: 5, padding: '1px 7px', background: T.fill, color: T.sub, cursor: 'pointer', fontFamily: mono }}>{names.get(p.name) ?? p.name}</span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Events({ events }: { events: Cluster['events'] }) {
  if (events === null) return <div style={{ fontSize: 13.5, color: T.dim }}>事件不可读：Host 的 ServiceAccount 缺 events 的 get/list 权限。</div>;
  if (events.length === 0) return <div style={{ fontSize: 13.5, color: T.dim }}>最近没有集群事件。</div>;
  const th: any = { textAlign: 'left', fontSize: 12.5, color: T.dim, fontWeight: 500, padding: '9px 12px', borderBottom: `1px solid ${T.line}`, whiteSpace: 'nowrap' };
  const td: any = { padding: '8px 12px', borderTop: `1px solid ${T.line}` };
  return (
    <>
      <div style={{ border: `1px solid ${T.line}`, borderRadius: 10, overflow: 'hidden', boxShadow: '0 4px 12px rgba(0,0,0,.02),0 2px 8px rgba(0,0,0,.04)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
          <thead><tr><th style={th}>时间</th><th style={th}>级别</th><th style={th}>对象</th><th style={th}>原因</th><th style={th}>说明</th></tr></thead>
          <tbody>
            {events.map((e, i) => (
              <tr key={i}>
                <td style={{ ...td, fontFamily: mono, fontSize: 12.5, whiteSpace: 'nowrap' }}>{mmddhhmm(e.time)}</td>
                <td style={td}><span style={{ fontSize: 13, borderRadius: 6, padding: '1px 9px', fontWeight: 500, background: e.type === 'Warning' ? T.soft.warn : T.soft.ok, color: e.type === 'Warning' ? T.lv.warn : T.lv.ok }}>{e.type === 'Warning' ? '警告' : '正常'}</span></td>
                <td style={{ ...td, fontFamily: mono, fontSize: 12.5 }}>{e.object}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{e.reason}</td>
                <td style={{ ...td, color: T.sub }}>{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 13, color: T.dim, border: `1px dashed ${T.line}`, borderRadius: 8, padding: '8px 14px', marginTop: 16 }}>
        事件取 k8s API 的 events（只读，最近 30 条）；Warning 级别用橙色徽标并置顶——滚动更新、镜像拉取失败、OOMKilled、探针失败都会出现在这里。
      </div>
    </>
  );
}

export function makePanel(call: (endpoint: string, payload?: unknown) => Promise<any>) {
  return function ClusterPanel() {
    const [d, setD] = useState<Cluster | null>(null);
    const [err, setErr] = useState('');
    const [tab, setTab] = useState<'arch' | 'node' | 'event'>('arch');
    const [selPod, setSelPod] = useState('');
    const [selDb, setSelDb] = useState('');
    const poolRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
      let live = true;
      const load = () => call('cluster').then((v) => { if (live) { setD(v); setErr(''); } }).catch((e) => { if (live) setErr(String(e?.message ?? e)); });
      load();
      const t = setInterval(load, 30_000);
      return () => { live = false; clearInterval(t); };
    }, []);

    const pods = d?.pods ?? null;
    const names = useMemo(() => displayNames(pods ?? []), [pods]);
    useEffect(() => { if (selDb === '' && d !== null && d.fleet.items.length > 0) setSelDb(d.fleet.items[0].id); }, [d, selDb]);

    if (err !== '') return <div style={{ fontSize: 14, color: T.lv.crit, padding: 12 }}>加载失败：{err}</div>;
    if (d === null) return <div style={{ color: T.dim, fontSize: 14, padding: 12 }}>加载中…</div>;
    if (pods === null || d.nodes === null) {
      return (
        <div style={{ fontFamily: FONT, color: T.ink, padding: 12 }}>
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>k8s 集群状态</div>
          <div style={{ fontSize: 13.5, color: T.lv.notice, background: T.soft.notice, borderRadius: 8, padding: '8px 14px' }}>
            集群数据不可读：Host 的只读 ServiceAccount 未获授权（需要 pods / events 的 get·list，以及 nodes 与 metrics.k8s.io 的 get·list）。RBAC 生效后本页自动恢复。
          </div>
        </div>
      );
    }

    const running = pods.filter((p) => p.phase !== 'Succeeded');
    const cpuCap = d.nodes.reduce((a, n) => a + n.cpuCapacity, 0);
    const memCap = d.nodes.reduce((a, n) => a + n.memCapacity, 0);
    const cpuUse = d.nodes.reduce((a, n) => a + n.cpu, 0);
    const memUse = d.nodes.reduce((a, n) => a + n.mem, 0);
    const cpuReq = running.reduce((a, p) => a + p.cpuReq, 0);
    const memReq = running.reduce((a, p) => a + p.memReq, 0);
    const restarts = running.reduce((a, p) => a + p.restarts, 0);
    const notReady = running.filter((p) => !p.ready).length;
    const badNodes = d.nodes.filter((n) => !n.ready).length;
    const f = d.fleet;
    const fleetBad = (f.counts.crit ?? 0) + (f.counts.warn ?? 0) + (f.counts.off ?? 0);
    const healthy = badNodes === 0 && notReady === 0;
    const pod = running.find((p) => p.name === selPod);
    const db = f.items.find((x) => x.id === selDb);

    return (
      <Boundary>
        <div style={{ fontFamily: FONT, color: T.ink, lineHeight: 1.75 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
            <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>k8s 集群状态</h1>
            <span style={{ fontSize: 13, borderRadius: 6, padding: '1px 9px', fontWeight: 500, background: healthy ? T.soft.ok : T.soft.warn, color: healthy ? T.lv.ok : T.lv.warn }}>
              {healthy ? '集群健康' : `${badNodes > 0 ? `${badNodes} 节点异常 ` : ''}${notReady > 0 ? `${notReady} Pod 未就绪` : ''}`}
            </span>
            <span style={{ fontSize: 13.5, color: T.dim }}>
              {d.nodes[0]?.version ?? ''} · {d.nodes.length} 节点{badNodes === 0 ? '全 Ready' : ''} · 命名空间 opendb-dsh · {running.length} 个 Pod{running.length - notReady === running.length ? ' 全就绪' : ''} · 采集 {mmddhhmm(d.collectedAt)}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 22, margin: '10px 0 16px', borderBottom: `1px solid ${T.line}`, fontSize: 14 }}>
            {([['arch', '架构图'], ['node', '节点视图'], ['event', '事件']] as const).map(([k, label]) => (
              <span key={k} onClick={() => setTab(k)}
                style={{ padding: '6px 0 8px', cursor: 'pointer', color: tab === k ? T.blue : T.sub, borderBottom: tab === k ? `2px solid ${T.blue}` : 'none', marginBottom: -1 }}>{label}</span>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(148px, 1fr))', gap: 10, marginBottom: 16 }}>
            <Stat l="k8s 节点" v={String(d.nodes.length)} unit={badNodes === 0 ? '全 Ready' : `${badNodes} 异常`} d={`${d.nodes.filter((n) => n.role === 'control-plane').length} control-plane · ${d.nodes.filter((n) => n.role !== 'control-plane').length} worker`} color={badNodes > 0 ? T.lv.warn : undefined} />
            <Stat l="Pod" v={String(running.length)} unit={`/ ${running.length - notReady} 就绪`} d={`${new Set(running.map((p) => p.comp)).size} 个组件`} color={notReady > 0 ? T.lv.warn : undefined} />
            <Stat l="集群 CPU" v={fmtCpu(cpuUse)} unit={`/ ${fmtCpu(cpuCap)}`} d={`用量 ${fmtPct(cpuCap > 0 ? cpuUse / cpuCap : 0)} · 请求 ${fmtCpu(cpuReq)}`} />
            <Stat l="集群内存" v={fmtMem(memUse)} unit={`/ ${fmtMem(memCap)}`} d={`用量 ${fmtPct(memCap > 0 ? memUse / memCap : 0)} · 请求 ${fmtMem(memReq)}`} />
            <Stat l="重启累计" v={`${fmtInt(restarts)} 次`} d={running.filter((p) => p.restarts > 0).sort((a, b) => b.restarts - a.restarts).slice(0, 3).map((p) => `${names.get(p.name) ?? p.comp} ${p.restarts}`).join(' · ') || '无重启'} color={restarts > 0 ? T.lv.notice : undefined} />
            <Stat l="被管数据库" v={String(f.total)} unit="个节点" d={f.total === 0 ? '尚未纳管' : fleetBad > 0 ? `需关注 ${fleetBad} · 正常 ${f.counts.ok ?? 0}` : `全部正常${(f.counts.unknown ?? 0) > 0 ? ` · 未巡检 ${f.counts.unknown}` : ''}`} color={fleetBad > 0 ? T.lv.warn : undefined} />
          </div>

          {tab === 'arch' ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 360px', gap: 0, border: `1px solid ${T.line}`, borderRadius: 10, background: '#fff', boxShadow: '0 4px 12px rgba(0,0,0,.02),0 2px 8px rgba(0,0,0,.04)', overflow: 'hidden' }}>
              <Diagram
                pods={running} names={names} selected={selPod} poolRef={poolRef}
                onSelectPod={(n) => { setSelPod(n); setSelDb(''); }}
                fleetSlot={<Fleet fleet={f} selected={selDb} boxRef={poolRef} onSelect={(id) => { setSelDb(id); setSelPod(''); }} />}
              />
              <div style={{ borderLeft: `1px solid ${T.line}`, padding: '14px 16px 18px', background: '#fff', minWidth: 0, alignSelf: 'start', position: 'sticky', top: 0, maxHeight: 'calc(100vh - 120px)', overflow: 'auto' }}>
                <Detail pod={pod} db={pod === undefined ? db : undefined} name={pod === undefined ? undefined : names.get(pod.name)} />
              </div>
            </div>
          ) : null}
          {tab === 'node' ? <NodeView nodes={d.nodes} pods={running} names={names} onPick={(n) => { setSelPod(n); setSelDb(''); setTab('arch'); }} /> : null}
          {tab === 'event' ? <Events events={d.events} /> : null}

          <div style={{ fontSize: 13, color: T.dim, border: `1px dashed ${T.line}`, borderRadius: 8, padding: '8px 14px', marginTop: 16 }}>
            口径：Pod 的 CPU/内存实时值取 metrics-server，条底色为该 Pod 的 limit（无 limit 时按节点容量折算并标注）；请求/限制取自 Deployment spec；重启次数为容器累计。
            集群数据经 Host 的只读 ServiceAccount 读 k8s API（只给 pods·events·nodes·metrics 的 get/list）。被管数据库来自平台注册表 + 每个节点最近一次巡检判定；几百台时只画矩阵与选中项，不平铺卡片。
          </div>
        </div>
      </Boundary>
    );
  };
}

/** 注册资源面板：桥已在就直接注册，否则排进 __pending 由后到的 ui-harness 兑现（与 platform-status 同款，避免加载顺序竞争）。 */
function registerResourcePanelSafe(key: string, Comp: any): void {
  if (typeof window === 'undefined') return;
  const w = window as any;
  if (w.__opendbHarness__?.registerResourcePanel !== undefined) { w.__opendbHarness__.registerResourcePanel(Comp, key); return; }
  w.__opendbHarness__ = w.__opendbHarness__ ?? {};
  w.__opendbHarness__.__pending = [...(w.__opendbHarness__.__pending ?? []), { kind: 'resource', key, comp: Comp }];
}

export function apply(ctx: any): void {
  const call = async (endpoint: string, payload: unknown = {}): Promise<any> => {
    const r = await ctx.connection.rpc.call('/opendb-status', endpoint, payload);
    if (!r.ok) throw new Error(r.error?.message ?? 'request failed');
    return r.value;
  };
  registerResourcePanelSafe('cluster', makePanel(call));
}

export { RANK, BAD };
