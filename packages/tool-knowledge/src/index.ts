import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolvePlatformAgent, clampText } from '@opendb-dsh/tool-db';

export const name = 'tool-knowledge';
export const inject = ['opendbKnowledge', 'opendbRegistry', 'tools'];

/** 图谱实体名上限：超过就在 kb_import 里让模型向用户提议短名词（图谱按实体名匹配，整句实体日后查不到）。 */
const KB_ENTITY_MAX_LEN = 16;
const strOrUndef = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { content: { type: 'string', required: true } },
  },
  render: (_args: unknown, value: any) => [{ type: 'text', text: value.content }],
} as const;

function defineSearchTool(deps: { knowledge: any; registry: any }) {
  return defineTool({
    name: 'knowledge_search',
    description: '在知识库里语义检索（运维手册/SOP/架构文档等外部资料；与记忆不同——记忆是平台自身经历用 memory_search）。返回最相关的文档片段。',
    parameters: {
      query: { type: 'string', description: '检索问题或关键词。', required: true },
      top_k: { type: 'integer', description: '返回片段数（默认 5，最多 20）。' },
    },
    output: TEXT_OUTPUT,
    async execute(args: any, exec: any) {
      const agent = await resolvePlatformAgent(deps.registry, exec?.agent);
      const hits: any[] = await deps.knowledge.search({ agentId: agent?.id, query: String(args.query ?? ''), topK: Number(args.top_k ?? 5) });
      if (hits.length === 0) return { content: '知识库没有相关内容（可以让用户提供资料后用 knowledge_ingest 灌入）' };
      const blocks = hits.map((h, i) => `【${i + 1}】《${h.title}》第 ${h.seq + 1} 段${h.source ? `（来源 ${h.source}）` : ''}\n${h.content}`);
      return { content: clampText(blocks.join('\n\n---\n\n'), 18000) };
    },
  } as any);
}

function defineIngestTool(deps: { knowledge: any; registry: any }) {
  return defineTool({
    name: 'knowledge_ingest',
    description: '把一篇资料灌入知识库（自动切块+向量化，之后可用 knowledge_search 检索）。适用：用户粘贴的手册/SOP/架构说明等值得长期沉淀的外部资料。同 source 重灌会替换旧版本。',
    parameters: {
      title: { type: 'string', description: '文档标题。', required: true },
      text: { type: 'string', description: '文档正文（纯文本/markdown）。', required: true },
      source: { type: 'string', description: '来源标识（URL/文件名/工单号）；同源重灌替换旧版。' },
      global: { type: 'boolean', description: 'true = 全局知识（所有智能体可检索）；默认只归本智能体。' },
    },
    output: TEXT_OUTPUT,
    async execute(args: any, exec: any) {
      const agent = await resolvePlatformAgent(deps.registry, exec?.agent);
      const doc = await deps.knowledge.ingest({
        agentId: args.global === true ? undefined : agent?.id,
        title: String(args.title ?? ''),
        source: typeof args.source === 'string' && args.source !== '' ? args.source : undefined,
        text: String(args.text ?? ''),
      });
      return { content: `已入库：《${doc.title}》切成 ${doc.chunks} 段（${args.global === true ? '全局知识' : `归属 ${agent?.name ?? '本智能体'}`}${doc.source ? `，来源 ${doc.source}` : ''}）` };
    },
  } as any);
}

/**
 * kb_import（会话式导入的第一步）：用户说"把 xxx 导入知识库"时，模型读材料、判类型、抽候选关系，调本工具。
 * 本工具只做「向量线确定性入库 + 候选关系落暂存」，**不入图**；返回候选清单与待确认问题，
 * 由模型逐条问用户，确认后再调 kb_commit 入图。模型只 propose，绝不自行写图。拓扑/依赖/变更史不走这里（采集器直写）。
 */
function defineImportTool(deps: { knowledge: any }) {
  return defineTool({
    name: 'kb_import',
    description: '会话式导入知识库第一步：用户说"把这份 X 导入知识库"时调用。把材料切块向量化（直接入库）并登记你抽取的关系候选（暂存、未入图）。返回候选清单和需要向用户确认的问题——你要据此逐条问用户，用户确认后再调 kb_commit。适用：用户提供的规范/工单/故障总结/预案，尽力抽出 现象→根因、条款→约束对象、故障→处置 这类关系。',
    parameters: {
      title: { type: 'string', description: '材料标题。', required: true },
      text: { type: 'string', description: '材料正文（纯文本/markdown）。', required: true },
      material_kind: { type: 'string', description: '材料类型：规范 / 工单 / 故障总结 / 手册 / 预案。' },
      source: { type: 'string', description: '来源标识（文件名/工单号）；同源重灌替换旧版。' },
      engine: { type: 'string', description: '适用数据库引擎，如 openGauss。' },
      env: { type: 'string', description: '适用环境，如 生产。' },
      edges: {
        type: 'array',
        description: '你从材料里抽取的关系候选（三元组）。只提议，人审确认后才入确定性图。抽不出就传空数组。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            src: { type: 'string', description: '源实体名：短名词或编号（≤12 字），如「核心库锁等待」「BATCH_EOD 日终批」「P1 事故」。条件、动作、分机号等细节放 locator 或拆成多条边，不要把整句当实体（图谱按实体名匹配，长句日后查不到）。', required: true },
            rel: { type: 'string', description: '关系类型：constrains(约束)/causes(导致)/handled_by(处置为)/depends_on(依赖)/references(引用)/triggers(触发)。', required: true },
            dst: { type: 'string', description: '目标实体名：同样是短名词（≤12 字），如「交易超时」「运行值班室」「禁止杀会话」。', required: true },
            locator: { type: 'string', description: '出自材料哪一段（如 §4.2 第3页 / 现象段）。' },
            confidence: { type: 'number', description: '你的置信度 0~1。' },
          },
        },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args: any) {
      const edges = Array.isArray(args.edges) ? args.edges.map((e: any) => ({
        src: String(e.src ?? ''), rel: String(e.rel ?? ''), dst: String(e.dst ?? ''),
        locator: typeof e.locator === 'string' ? e.locator : undefined,
        confidence: typeof e.confidence === 'number' ? e.confidence : undefined,
      })).filter((e: any) => e.src !== '' && e.rel !== '' && e.dst !== '') : [];
      const mk = typeof args.material_kind === 'string' && args.material_kind !== '' ? args.material_kind : '';
      const eng = typeof args.engine === 'string' && args.engine !== '' ? args.engine : '';
      const env = typeof args.env === 'string' && args.env !== '' ? args.env : '';
      const r = await deps.knowledge.createImport({
        title: String(args.title ?? ''), text: String(args.text ?? ''),
        source: typeof args.source === 'string' && args.source !== '' ? args.source : undefined,
        materialKind: mk || undefined, engine: eng || undefined, env: env || undefined, edges,
      });
      const rows = await deps.knowledge.stagingOrdered(r.importId);
      const REL: Record<string, string> = { constrains: '约束', causes: '导致', handled_by: '处置为', depends_on: '依赖', references: '引用', triggers: '触发' };
      const listed = rows.map((e: any, i: number) => `${i + 1}. ${e.src_name} —${REL[e.rel_type] ?? e.rel_type}→ ${e.dst_name}（置信 ${Number(e.confidence).toFixed(2)}${e.source_locator ? `，出处 ${e.source_locator}` : ''}）`).join('\n');
      const lowConf = rows.map((e: any, i: number) => (Number(e.confidence) < 0.7 ? i + 1 : 0)).filter((n: number) => n > 0);
      const longNames = rows.map((e: any, i: number) => (String(e.src_name).length > KB_ENTITY_MAX_LEN || String(e.dst_name).length > KB_ENTITY_MAX_LEN ? i + 1 : 0)).filter((n: number) => n > 0);
      const asks: string[] = [];
      if (mk === '') asks.push('材料类型（规范 / 工单 / 故障总结 / 手册 / 预案）你判定为什么？');
      if (longNames.length > 0) asks.push(`第 ${longNames.join('、')} 条的实体名超过 ${KB_ENTITY_MAX_LEN} 字（图谱按实体名匹配，长句日后查不到）：请给出短名词改法（如「BATCH_EOD 日终批」「运行值班室」）并与用户确认，确认后通过 kb_commit 的 rename 按编号改名。`);
      if (eng === '' || env === '') asks.push('适用范围（数据库引擎 / 环境）材料没写全，请与用户确认。');
      if (lowConf.length > 0) asks.push(`第 ${lowConf.join('、')} 条置信度偏低，请逐条与用户确认是否保留。`);
      asks.push('是否有实体名重复/歧义需要合并或改名。');
      return { content: [
        `已解析《${String(args.title ?? '')}》：向量线切成 ${r.vectorChunks} 段（已入库、可检索）。`,
        `抽到 ${rows.length} 条关系候选（**尚未入图，等你和用户确认**）：`,
        listed || '（未抽到关系候选）',
        ``,
        `【必须先向用户逐条确认，再入库】请就以下问题向用户提问，等用户回答/确认后再调用 kb_commit：`,
        ...asks.map((a, i) => `${i + 1}) ${a}`),
        ``,
        `确认完成后调用 kb_commit(import_id="${r.importId}"，reject=[要剔除的候选编号，没有就空]，rename=[用户同意改名/修正的候选，按编号只填要改的字段])。`,
        `不要跳过确认、不要自行 kb_commit——先把上面的问题抛给用户并结束本轮。`,
      ].join('\n') };
    },
  } as any);
}

/** kb_commit：用户确认后把该批次未剔除的候选边写进强类型图（confidence=1.0）。会话导入的收尾一步。 */
function defineCommitTool(deps: { knowledge: any }) {
  return defineTool({
    name: 'kb_commit',
    description: '把一次导入（kb_import 返回的 import_id）里用户已确认的关系候选写进确定性知识图谱。必须在向用户逐条确认过分类/范围/低置信关系之后才调用。reject 传用户明确要剔除的候选编号（对应 kb_import 列出的序号）。',
    parameters: {
      import_id: { type: 'string', description: 'kb_import 返回的批次号（imp-xxxxxxxx）。', required: true },
      reject: { type: 'array', description: '用户要剔除的候选编号（1 基，对应 kb_import 列表）；全部保留就传空数组。', items: { type: 'integer' } },
      rename: {
        type: 'array',
        description: '用户同意改名/修正的候选（按编号），只填要改的字段。用它把过长的实体名改成短名词，或按用户指正修正关系。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            number: { type: 'integer', description: '候选编号（1 基，对应 kb_import 列表）。', required: true },
            src: { type: 'string', description: '新的源实体名。' },
            rel: { type: 'string', description: '新的关系类型（constrains/causes/handled_by/depends_on/references/triggers）。' },
            dst: { type: 'string', description: '新的目标实体名。' },
          },
        },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args: any) {
      const reject = Array.isArray(args.reject) ? args.reject.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n)) : [];
      const rename = Array.isArray(args.rename) ? args.rename
        .filter((e: any) => e !== null && typeof e === 'object' && Number.isFinite(Number(e.number)))
        .map((e: any) => ({ number: Number(e.number), src: strOrUndef(e.src), rel: strOrUndef(e.rel), dst: strOrUndef(e.dst) })) : [];
      const r = await deps.knowledge.commitWithReject(String(args.import_id ?? ''), reject, rename);
      const notes = [r.rejected > 0 ? `按用户意见剔除 ${r.rejected} 条` : '', r.edited > 0 ? `改名/修正 ${r.edited} 条` : ''].filter((s) => s !== '');
      return { content: `✅ 导入完成：${r.edges} 条关系已进入确定性知识图谱（confidence=1.0）${notes.length > 0 ? `，${notes.join('，')}` : ''}（候选共 ${r.total} 条）。向量已在解析阶段入库。` };
    },
  } as any);
}

/**
 * kg_query（P3）：查客户专属知识图谱——从一个实体出发沿强类型关系多跳，返回可追溯路径。
 * 与 knowledge_search 的区别：search 找"相关文本片段"，kg_query 给"现象→根因→处置、对象→约束条款"这类**关系链**。
 * 只走人确认过（confidence=1.0）且在生效期内的边——即"确定性"的那部分知识。
 */
function defineKgQueryTool(deps: { knowledge: any }) {
  return defineTool({
    name: 'kg_query',
    description: '查客户专属知识图谱：给定实体（如「核心库锁等待」「BATCH_EOD」「P1」），返回它沿强类型关系（约束/导致/处置/依赖）多跳到达的关系链，每条带来源。起点按实体名模糊匹配（精确→包含→相似）并回显实际匹配到的实体；查不到就换更短的核心名词再试。适合"这个现象的根因与本行处置""改这张表受哪些规范约束"类推理。只返回人确认过的确定性关系。',
    parameters: {
      entity: { type: 'string', description: '起点实体名。', required: true },
      max_hops: { type: 'integer', description: '最大跳数（默认 2，最多 4）。' },
    },
    output: TEXT_OUTPUT,
    async execute(args: any) {
      const entity = String(args.entity ?? '');
      const r = await deps.knowledge.kgQuery(entity, Number(args.max_hops ?? 2));
      if (r.paths.length === 0) return { content: `知识图谱里没有与「${entity}」相关的确定性关系（起点已按精确/包含/相似三档匹配仍未命中：可能尚未导入相关规范/案例；可换更短的核心名词再试，或改用 knowledge_search 找文本）。` };
      const REL: Record<string, string> = { constrains: '约束', causes: '导致', handled_by: '处置为', depends_on: '依赖', references: '引用', triggers: '触发' };
      const lines = r.paths.map((p: any) => p.hops.map((h: any) => `${h.src} —${REL[h.rel] ?? h.rel}→ ${h.dst}${h.source ? `（出处：${h.source}）` : ''}`).join('；'));
      const matched = (r.matched ?? []).map((m: any) => `${m.name}${Number(m.score) < 1 ? `（相似 ${Number(m.score).toFixed(2)}）` : ''}`).join('、');
      return { content: `「${entity}」匹配到起点实体：${matched}\n确定性关系（${r.paths.length} 条，涉及 ${r.nodes} 个实体）：\n${lines.map((l: string, i: number) => `${i + 1}. ${l}`).join('\n')}` };
    },
  } as any);
}

/** 知识库读写工具（function plugin 顶层 inject——W4 教训的正确姿势）。 */
export function apply(ctx: Context): void {
  const anyCtx = ctx as any;
  anyCtx.inject(['tools'], (c: any) => {
    const deps = { knowledge: anyCtx.opendbKnowledge, registry: anyCtx.opendbRegistry };
    c.effect(() => c.tools.register(defineSearchTool(deps)), 'tool-knowledge.search');
    c.effect(() => c.tools.register(defineIngestTool(deps)), 'tool-knowledge.ingest');
    c.effect(() => c.tools.register(defineImportTool(deps)), 'tool-knowledge.import');
    c.effect(() => c.tools.register(defineCommitTool(deps)), 'tool-knowledge.commit');
    c.effect(() => c.tools.register(defineKgQueryTool(deps)), 'tool-knowledge.kgquery');
  });
}
