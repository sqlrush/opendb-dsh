import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolvePlatformAgent, clampText } from '@opendb-dsh/tool-db';

export const name = 'tool-knowledge';
export const inject = ['opendbKnowledge', 'opendbRegistry', 'tools'];

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
 * kb_import（P2 导入工具的模型半边）：模型读一份材料，判类型 + 抽候选关系三元组，调本工具入库。
 * 写入纪律——向量线自动入库（确定性切块+embed）；图线只落「待确认」暂存(staging)，人审确认后才进强类型图。
 * 模型只 propose 候选边，绝不直接写图。拓扑/依赖/变更史不走这里（采集器直写）。
 */
function defineImportTool(deps: { knowledge: any }) {
  return defineTool({
    name: 'kb_import',
    description: '把一份文本材料导入知识库：自动切块向量化（向量线，直接入库）+ 登记你抽取的关系三元组为候选边（图线，进人审队列，确认后才入图）。适用：用户提供的规范/工单/故障总结/预案。你要判材料类型并尽力抽出 现象→根因、条款→约束对象、故障→处置 这类关系。',
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
            src: { type: 'string', description: '源实体名，如「核心库锁等待」。', required: true },
            rel: { type: 'string', description: '关系类型：constrains(约束)/causes(导致)/handled_by(处置为)/depends_on(依赖)/references(引用)/triggers(触发)。', required: true },
            dst: { type: 'string', description: '目标实体名，如「交易超时」。', required: true },
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
      const r = await deps.knowledge.createImport({
        title: String(args.title ?? ''), text: String(args.text ?? ''),
        source: typeof args.source === 'string' && args.source !== '' ? args.source : undefined,
        materialKind: typeof args.material_kind === 'string' ? args.material_kind : undefined,
        engine: typeof args.engine === 'string' ? args.engine : undefined,
        env: typeof args.env === 'string' ? args.env : undefined,
        edges,
      });
      return { content: `已受理导入《${String(args.title ?? '')}》：向量线切成 ${r.vectorChunks} 段（已入库）；图线登记 ${r.edgeCandidates} 条候选关系（进人审队列，确认后才入图）。批次 ${r.importId}。` };
    },
  } as any);
}

/**
 * kb_extract（导入向导的图线）：向导已在服务端确定性完成向量入库并给出批次号，模型只负责从材料抽关系
 * 候选边、写进该批次的人审队列。与 kb_import 的区别：不再切块入库，只补候选边——向量线不依赖模型是否配合。
 */
function defineExtractTool(deps: { knowledge: any }) {
  return defineTool({
    name: 'kb_extract',
    description: '为一个已存在的知识导入批次补充关系候选边（图线人审队列）。向导已完成向量入库并给你 import_id；你从材料里抽取明确写到的关系三元组填 edges。抽不出就传空数组。',
    parameters: {
      import_id: { type: 'string', description: '导入批次号（向导在提示词里给出，形如 imp-xxxxxxxx）。', required: true },
      edges: {
        type: 'array',
        description: '关系候选三元组，只抽材料明确写到的（不要凭常识编造）。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            src: { type: 'string', description: '源实体名。', required: true },
            rel: { type: 'string', description: 'constrains(约束)/causes(导致)/handled_by(处置为)/depends_on(依赖)/references(引用)/triggers(触发)。', required: true },
            dst: { type: 'string', description: '目标实体名。', required: true },
            locator: { type: 'string', description: '出自材料哪一段。' },
            confidence: { type: 'number', description: '置信度 0~1。' },
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
      const r = await deps.knowledge.stageEdges(String(args.import_id ?? ''), edges);
      return { content: `已为批次 ${String(args.import_id ?? '')} 登记 ${r.added} 条候选关系（进人审队列，确认后入图）。` };
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
    c.effect(() => c.tools.register(defineExtractTool(deps)), 'tool-knowledge.extract');
  });
}
