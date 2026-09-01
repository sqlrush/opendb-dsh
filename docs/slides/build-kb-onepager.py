#!/usr/bin/env python3
"""opendb-harness 客户知识库一页 PPT（user 2026-09-01 要的；R2：压字数 + 突出"最懂工行"的效果）：
   把工行多年 GaussDB 实战沉淀（规范 / 工单 / 故障总结）自动构建成可判定的知识资产，
   并说清三类存储（关系型 / 向量 / 图）各自角色与相互配合。刻意只写存储**类型**，不出现产品名。

   /usr/bin/python3 docs/slides/build-kb-onepager.py  →  docs/slides/opendb-harness-知识库一页.pptx
   预览：qlmanage -t -s 2400 -o /tmp/ql <pptx>（macOS QuickLook 渲染成 PNG）
"""
from pathlib import Path
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE, MSO_CONNECTOR
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.oxml.ns import qn

OUT = Path(__file__).with_name('opendb-harness-知识库一页.pptx')
FONT = 'PingFang SC'
INK, SUB, DIM, BLUE, LINE = '0F1115', '61666B', '81858C', '4176E6', 'D9DCE1'
GREEN, AMBER, PURPLE, WARN, RED = '3FA552', 'C9862D', '8B6BE0', 'E07A1F', 'D64545'
FILL = {'src': 'FFFFFF', 'make': 'E8F5EC', 'rel': 'F2F3F5', 'vec': 'FDF0E3',
        'graph': 'F3EEFC', 'search': 'EEF3FF', 'loop': 'F7F8FA'}
EDGE = {'src': 'C9CED6', 'make': GREEN, 'rel': '8A9099', 'vec': AMBER,
        'graph': PURPLE, 'search': BLUE, 'loop': 'B8BCC4'}

prs = Presentation()
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
slide = prs.slides.add_slide(prs.slide_layouts[6])


def rgb(h):
    return RGBColor.from_string(h)


def text(x, y, w, h, runs, size=10, color=INK, bold=False, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, line_spacing=1.15):
    tb = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.margin_left = tf.margin_right = Inches(0.04)
    tf.margin_top = tf.margin_bottom = Inches(0.02)
    tf.vertical_anchor = anchor
    first = True
    for para in runs:
        p = tf.paragraphs[0] if first else tf.add_paragraph()
        first = False
        p.alignment = align
        p.line_spacing = line_spacing
        parts = [(para, {})] if isinstance(para, str) else para
        for t, st in parts:
            r = p.add_run()
            r.text = t
            r.font.name = FONT
            r.font.size = Pt(st.get('size', size))
            r.font.bold = st.get('bold', bold)
            r.font.color.rgb = rgb(st.get('color', color))
    return tb


def box(x, y, w, h, kind, title, badge=None, lines=(), title_size=11.5, body_size=9, radius=0.08, badge_size=9):
    shp = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(x), Inches(y), Inches(w), Inches(h))
    shp.adjustments[0] = radius
    shp.fill.solid(); shp.fill.fore_color.rgb = rgb(FILL[kind])
    shp.line.color.rgb = rgb(EDGE[kind]); shp.line.width = Pt(1.25)
    shp.shadow.inherit = False
    shp.text_frame.text = ''
    text(x + 0.08, y + 0.04, w - 0.16, 0.3,
         [[(title, {'bold': True, 'size': title_size, 'color': INK})]
          + ([('  ' + badge, {'bold': True, 'size': badge_size, 'color': EDGE[kind]})] if badge else [])])
    if lines:
        text(x + 0.08, y + 0.32, w - 0.16, h - 0.36, ['· ' + ln for ln in lines], size=body_size, color=SUB, line_spacing=1.14)
    return shp


def arrow(x1, y1, x2, y2, color=SUB, dashed=False, both=False, width=1.25, plain=False):
    c = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(x1), Inches(y1), Inches(x2), Inches(y2))
    c.line.color.rgb = rgb(color); c.line.width = Pt(width)
    ln = c.line._get_or_add_ln()
    if dashed:
        ln.append(ln.makeelement(qn('a:prstDash'), {'val': 'dash'}))
    if plain:
        return c
    if both:
        ln.append(ln.makeelement(qn('a:headEnd'), {'type': 'triangle', 'w': 'med', 'len': 'med'}))
    ln.append(ln.makeelement(qn('a:tailEnd'), {'type': 'triangle', 'w': 'med', 'len': 'med'}))
    return c


def label(x, y, w, t, color=DIM, size=8, align=PP_ALIGN.LEFT):
    tb = text(x, y, w, 0.16, [t], size=size, color=color, align=align, anchor=MSO_ANCHOR.MIDDLE)
    tb.text_frame.margin_top = tb.text_frame.margin_bottom = 0
    return tb


def chip(x, y, w, h, fill, color, t, size=8.5):
    shp = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(x), Inches(y), Inches(w), Inches(h))
    shp.adjustments[0] = 0.3
    shp.fill.solid(); shp.fill.fore_color.rgb = rgb(fill)
    shp.line.fill.background(); shp.shadow.inherit = False
    tf = shp.text_frame
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf.paragraphs[0]; p.alignment = PP_ALIGN.CENTER
    r = p.add_run(); r.text = t; r.font.name = FONT; r.font.size = Pt(size); r.font.bold = True; r.font.color.rgb = rgb(color)
    return shp


# ── 标题 ──────────────────────────────────────────────────────────────
text(0.5, 0.28, 12.3, 0.5, [[('客户知识库：让平台"懂工行"', {'bold': True, 'size': 24, 'color': INK}),
                             ('   把多年 GaussDB 实战沉淀，变成平台的判断力', {'size': 14, 'color': SUB})]])
text(0.5, 0.80, 12.3, 0.3, ['规范 · 工单 · 故障总结  →  自动结构化  →  三类存储各司其职  →  每条结论都按工行口径给方案'],
     size=12, color=BLUE)

L, W = 0.5, 7.5

# ── ① 工行既有资料 ───────────────────────────────────────────────────
sw = (W - 0.24) / 3
for i, (t, n) in enumerate([('使用规范', '几十篇'), ('处理工单', '上千条'), ('故障总结', '上百份')]):
    box(L + i * (sw + 0.12), 1.30, sw, 0.44, 'src', t, badge=n, title_size=11, badge_size=9)
label(L, 1.14, 4.0, '① 工行既有资料 · 多来源 · 无统一结构')

# ── ② 自动加工成可判定的知识 ─────────────────────────────────────────
box(L, 1.96, W, 1.00, 'make', '② 自动加工成"可判定"的知识', badge='模型抽取 + 人工确认后方可引用',
    title_size=12, badge_size=9)
mw = (W - 0.30) / 3
for i, (t, b) in enumerate([
    ('规范 → 条款卡', '约束对象 · 要求值 · 强制/建议'),
    ('工单 → 处置卡', '现象 · 动作 · 耗时'),
    ('故障 → 案例卡', '根因 · 处置 · 防复发'),
]):
    x = L + 0.10 + i * (mw + 0.05)
    text(x, 2.24, mw, 0.44, [[(t, {'bold': True, 'size': 9.5, 'color': INK})], b], size=8.6, color=SUB, line_spacing=1.1)
label(L + 0.10, 2.66, W - 0.2, '统一打标：适用引擎与环境 · 生效期 · 版本（重灌出新版，引用可追溯）', color=SUB, size=8.4)

# ── ③ 三类存储各司其职 ───────────────────────────────────────────────
label(L, 2.94, 5.5, '③ 三类存储各司其职：真相只有一份，能力互补，任一层不可用都能降级')
by, bh, GAP = 3.26, 1.26, 0.30
bw = (W - 2 * GAP) / 3
box(L, by, bw, bh, 'rel', '关系型数据库', badge='唯一真相',
    lines=['三种卡片 · 版本 · 引用台账', '记忆：这套库我们做过什么', '按引擎/环境/生效期精确过滤'],
    title_size=11, body_size=8.6, badge_size=8.5)
box(L + bw + GAP, by, bw, bh, 'vec', '向量数据库', badge='语义召回',
    lines=['说法不同、意思相同也能召回', '"连接打满" ↔ "连接超阈值"', '只加速，不存真相，可重建'],
    title_size=11, body_size=8.6, badge_size=8.5)
box(L + 2 * (bw + GAP), by, bw, bh, 'graph', '图数据库', badge='关系推理',
    lines=['现象 → 根因 → 处置 多跳串联', '条款 ↔ 对象、案例 ↔ 条款', '一条结论牵出规范与历史全链'],
    title_size=11, body_size=8.6, badge_size=8.5)
mid = by + bh / 2
arrow(L + bw, mid, L + bw + GAP, mid, both=True, color=AMBER, width=1.3)
arrow(L + 2 * bw + GAP, mid, L + 2 * bw + 2 * GAP, mid, both=True, color=PURPLE, width=1.3)
label(L + bw + GAP / 2 - 0.70, by + bh + 0.02, 1.4, '同步向量 / 回表取原文', color=AMBER, size=7.5, align=PP_ALIGN.CENTER)
label(L + 2 * bw + 1.5 * GAP - 0.75, by + bh + 0.02, 1.5, '抽实体与边 / 回表取证据', color=PURPLE, size=7.5, align=PP_ALIGN.CENTER)

# ── ④ 混合检索 ───────────────────────────────────────────────────────
box(L, 4.86, W, 0.66, 'search', '④ 混合检索：由平台按"发现"发起', badge='语义 + 词法 + 范围过滤 + 图扩展 → 重排',
    lines=['检索键 = 规则码 + 对象 + 现象词；命中条款卡 / 处置卡 / 案例卡，连同出处一起交给模型'],
    title_size=12, body_size=8.8, badge_size=9)

# ── ⑤ 闭环 ───────────────────────────────────────────────────────────
box(L, 5.76, W, 0.58, 'loop', '⑤ 越用越懂', badge='缺口驱动',
    lines=['查不到规范的发现自动排队提示补料；DBA 点"有用 / 无关"回写排序权重'],
    title_size=11.5, body_size=8.8, badge_size=9)

cx = L + W / 2
arrow(cx, 1.74, cx, 1.96, color=BLUE)
arrow(cx, 2.96, cx, 3.26, color=GREEN)
arrow(cx, by + bh, cx, 4.86, color=BLUE)
arrow(cx, 5.52, cx, 5.76, color=SUB)

# ── 右栏：效果 ───────────────────────────────────────────────────────
R, RW = 8.25, 4.6
panel = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(R), Inches(1.10), Inches(RW), Inches(5.24))
panel.adjustments[0] = 0.03
panel.fill.solid(); panel.fill.fore_color.rgb = rgb('FFFFFF')
panel.line.color.rgb = rgb(BLUE); panel.line.width = Pt(1.5)
panel.shadow.inherit = False
text(R + 0.18, 1.20, RW - 0.36, 0.36, [[('效果：最懂工行的那一版建议', {'bold': True, 'size': 15, 'color': INK})]])
text(R + 0.18, 1.58, RW - 0.36, 0.46,
     [[('知识库 = 工行多年 GaussDB 实战经验的结构化沉淀', {'bold': True, 'size': 10.5, 'color': BLUE})],
      [('平台判定仍归脚本，知识库负责"按工行的规矩和习惯"给方案', {'size': 9.5, 'color': SUB})]], line_spacing=1.2)

# 示例卡
cy = 2.15
cardh = 2.20
card = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(R + 0.18), Inches(cy), Inches(RW - 0.36), Inches(cardh))
card.adjustments[0] = 0.04
card.fill.solid(); card.fill.fore_color.rgb = rgb('F7F8FA')
card.line.color.rgb = rgb(LINE); card.line.width = Pt(1)
card.shadow.inherit = False
label(R + 0.26, cy + 0.06, 2.4, '示例 · 报告里的一条结论', color=DIM, size=8)
chip(R + 0.26, cy + 0.30, 0.46, 0.20, 'FDF0E3', WARN, 'warn')
text(R + 0.76, cy + 0.27, RW - 0.94, 0.26, [[('系统表膨胀 · 全量 SQL 追踪表 16GB', {'bold': True, 'size': 10.5, 'color': INK})]])
rows = [
    ('贵行规范', '全量 SQL 追踪仅在诊断窗口开启（强制）', GREEN),
    ('历史相似', '同类问题曾降追踪级别后重建，2 小时恢复', PURPLE),
    ('建议 · 工行口径', '提变更单 → 23:00–06:00 窗口 → 双人复核', BLUE),
]
ry = cy + 0.62
for t, b, c in rows:
    text(R + 0.26, ry, 1.30, 0.24, [[(t, {'bold': True, 'size': 9, 'color': c})]])
    text(R + 1.58, ry, RW - 1.76, 0.5, [b], size=9, color=SUB, line_spacing=1.15)
    ry += 0.60

# 三条要点
py = cy + cardh + 0.26
for i, (t, b) in enumerate([
    ('说工行的话', '用贵行的术语与流程给建议，不给通用套话'),
    ('每条有出处', '引用可追到哪一版哪一条；查不到就写"无对应规范"'),
    ('口径按工行', '客户标准与平台默认不一致 → 差异清单，人确认后生效'),
]):
    num = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(R + 0.20), Inches(py + 0.03), Inches(0.26), Inches(0.26))
    num.fill.solid(); num.fill.fore_color.rgb = rgb(BLUE); num.line.fill.background(); num.shadow.inherit = False
    tf = num.text_frame; tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf.paragraphs[0]; p.alignment = PP_ALIGN.CENTER
    r = p.add_run(); r.text = str(i + 1); r.font.size = Pt(9); r.font.bold = True; r.font.color.rgb = rgb('FFFFFF'); r.font.name = FONT
    text(R + 0.54, py, RW - 0.72, 0.28, [[(t, {'bold': True, 'size': 11, 'color': INK}), ('   ' + b, {'size': 9.3, 'color': SUB})]])
    py += 0.46

# 流水线 → 效果
arrow(L + W, 5.19, R, 5.19, color=BLUE, width=1.5)

text(0.5, 6.62, 8.2, 0.18, ['图例：实线 = 主流程；框间双向箭头 = 存储层之间的同步与回表；三类存储只写类型，不绑定具体产品'], size=7.5, color=DIM)
text(9.0, 6.62, 3.9, 0.18, ['opendb-harness · 客户知识库一页 · 2026-09'], size=7.5, color=DIM, align=PP_ALIGN.RIGHT)

prs.save(OUT)
print('saved', OUT)
