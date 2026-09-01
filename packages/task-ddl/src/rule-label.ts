/**
 * DDL 规范规则 → 短标签。单独一个零依赖模块：面板要用（client 打包不能碰 ddl.ts，
 * 那边 import 了 thresholds-pg/cordis），单测也要用（拿它和 scanDdlRules 真能吐出的规则码对账）。
 *
 * 2026-08-31 校正：面板原本自己维护一份标签表 + 另一份手写的"通过项"数组，两份都没跟上实现——
 * 表里留着平台从未实现的 DDLR06「账号权限提升」、把 DDLR07 标成"无主键新表"（实为 DROP 无 IF EXISTS），
 * 通过项数组则漏了 DDLR07：这条真会扫，没命中时却从不出现在"通过"里，读报告的人会以为没查过幂等性。
 * 现在通过项 = 本表的键减去命中的，改一处两边一起变。
 * DDLR90 由 tool-ddl-collect 在审计不可用时补，不在 scanDdlRules 里。
 */
export const DDL_RULE_LABEL: Record<string, string> = {
  DDLR00: 'DROP SCHEMA', DDLR01: '表被删除', DDLR02: 'TRUNCATE', DDLR03: 'DROP COLUMN / CONSTRAINT',
  DDLR04: '业务时段变更', DDLR05: '同一对象反复变更', DDLR07: 'DROP 无 IF EXISTS', DDLR90: '归因缺失',
};
