# SVG 插图导出为可编辑形状 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 导出 pptx 时，内联 `<svg>`（插图、图标、笔迹）变成一个 PowerPoint 组合，里面每个元素是可编辑的原生对象；转不了的单个元素才转图片。

**Architecture:** 浏览器端 `ppt/export.js` 新增 `svgGroup(svg)`：用 `getScreenCTM()` 把每个 SVG 元素换算到画布坐标，产出 `{k:'group', items:[…]}`，子项用已有的 `shape`/`text`/`raster` 加一个新的 `path`。Python 端 `ppt/exporter.py` 把 group 交给 python-pptx 的组合对象（它和页面一样有 `.shapes`），子项复用已有的 `add_*`；`path` 写成 `custGeom` 任意多边形。

**Tech Stack:** 浏览器 DOM/SVG API、html-to-image（已有）、python-pptx 0.6.23（已有）、Node 22 测试。

**Spec:** `docs/superpowers/specs/2026-10-26-ppt-maker-svg-export-design.md`

## Global Constraints
- 不加新依赖：浏览器端只用标准 DOM/SVG API；Python 端只用已有的 python-pptx。
- 只改导出：页面编辑、`deck.html` 格式、agent 规则不动。`.obj` 形状和箭头（`data-kind="shape"/"arrow"`）照旧。
- 生成的 XML 要能被 PowerPoint 直接打开、不弹"修复"提示（元素顺序遵守 schema）。
- 位置：pptx 里的坐标、尺寸与浏览器量到的相差 ≤ 1px；颜色值相同。
- 箭头颜色跟线同色；任何 marker 都当三角箭头；大小取 sm/med/lg 最接近的。
- 转不了的只限那一个元素转图片；整张 SVG 一个可转换元素都没有时整张转图片（同现在）。
- 一项失败不拖垮整份：子元素失败只跳过它并记入 `skipped`。
- TDD：先写失败的测试；测试不碰 `decks/试用` 和真实的 `~/.ppt-maker`。
- 命令：`PYTHONIOENCODING=utf-8 python -m unittest ppt.test_server.ExporterTests`；`node tests/svgpath.test.mjs`；`node tests/e2e.mjs > "$TEMP/ppt-logs/e2e.log"`（约 6 分钟，读 tail）。

## Review Focus
1. `cut()` 转图片失败时用 `items.indexOf(it)` 删除——子项在 group 的列表里，`indexOf` 为 -1 会误删页面最后一项。必须从它所在的列表里删（Task 3 的 e2e 检查覆盖）。
2. viewBox 与元素框比例不同（默认 `xMidYMid meet` 留白）时位置要对——靠 `getScreenCTM()`，e2e 用一张非等比 viewBox 的 SVG 检查。
3. 隐藏元素（`display:none`、`visibility:hidden`、`opacity:0`）和不可见容器（`defs`、`marker`、`clipPath`、`linearGradient`、`title`…）不导出（Task 3）。
4. 空的 `d`、零尺寸 `rect`、只有一个点的路径：跳过，不报错不崩（Task 1、Task 2）。
5. 图标 `stroke="currentColor"` 与 `fill="none"`：导出后线色是块的文字色、无填充（Task 3）。

---

### Task 1: exporter.py 支持 group、path 和形状的新字段

**Files:**
- Modify: `ppt/exporter.py`（`build()` 内：`add_shape`、`add_text`、`set_line`，新增 `add_path`、`add_group`，把主循环里"放一项、失败就回滚"抽成 `place(container, it)`）
- Test: `ppt/test_server.py`（`ExporterTests`）

**Interfaces:**
- Produces（Task 3 产出这些 item，Task 1 消费）：
  - `{"k":"group","id":str,"items":[item…]}` — 子项可为 `shape`/`text`/`path`/`raster`；不嵌套 group。
  - `{"k":"path","id":str,"segs":[["M",x,y],["L",x,y],["C",x1,y1,x2,y2,x,y],["Z"]…],"fill":hex|None,"fa":float,"line":hex|None,"la":float,"lw":float,"dash":None|"sysDot"|"sysDash"|"dash","start":None|"sm"|"med"|"lg","end":同上}`，坐标是画布像素（绝对值）。
  - `shape` 新增可选：`"r"`（圆角像素，同 `box`）、`"la"`（线透明度）、`"dash"`；`text` 新增可选 `"rot"`（度）。
- 报告：group 本身不计数；子项按种类计入 `text`/`shape`/`image`，`raster` 子项进 `raster` 列表；`path` 计入 `shape`。

- [ ] **Step 1: 写失败的测试**

```python
def svg_group():
    run = {"t": "框选", "size": 20, "color": "112233", "font": "Microsoft YaHei"}
    return {"k": "group", "id": "b-fig", "items": [
        {"k": "shape", "shape": "round", "id": "b-fig:rect1", "x": 100, "y": 100, "w": 200, "h": 100, "r": 10, "rot": 0,
         "fill": "38bdf8", "fa": 0.5, "line": "112233", "la": 1, "lw": 3, "dash": "dash", "paras": []},
        {"k": "path", "id": "b-fig:path2", "segs": [["M", 400, 100], ["C", 450, 50, 500, 150, 550, 100], ["L", 550, 200], ["Z"]],
         "fill": "ff0000", "fa": 1, "line": None, "la": 1, "lw": 0, "dash": None, "start": None, "end": None},
        {"k": "path", "id": "b-fig:line3", "segs": [["M", 100, 300], ["L", 500, 300]],
         "fill": None, "fa": 1, "line": "4874cb", "la": 1, "lw": 2, "dash": None, "start": None, "end": "med"},
        {"k": "text", "id": "b-fig:text4", "x": 100, "y": 400, "w": 120, "h": 30, "rot": 15, "wrap": False, "paras": [{"align": "c", "runs": [run]}]},
        {"k": "raster", "id": "b-fig:image5", "x": 600, "y": 100, "w": 50, "h": 50, "src": "data:image/png;base64," + PNG_1PX, "why": "SVG 里的图片"},
    ]}

def test_an_svg_group_becomes_one_editable_group(self):
    out = self.tmp / "g.pptx"
    rep = exporter.build({"slides": [{"id": "s", "bg": None, "items": [svg_group()]}]}, out)
    self.assertEqual({k: rep[k] for k in ("text", "shape", "image")}, {"text": 1, "shape": 3, "image": 0})
    self.assertEqual(rep["raster"], [{"id": "b-fig:image5", "why": "SVG 里的图片"}])
    shapes = Presentation(str(out)).slides[0].shapes
    self.assertEqual(len(shapes), 1)
    g = shapes[0]
    self.assertEqual(g.shape_type, MSO_SHAPE_TYPE.GROUP)
    kids = list(g.shapes)
    self.assertEqual(len(kids), 5)                                   # document order kept
    rect, path, line, text, pic = kids
    self.assertEqual((rect.left, rect.top, rect.width), (E(100), E(100), E(200)))
    self.assertAlmostEqual(rect.adjustments[0], 0.1, places=3)       # 10 / min(200, 100)
    self.assertIn('<a:alpha val="50000"/>', rect._element.xml)
    self.assertIn('<a:prstDash val="dash"/>', rect._element.xml)
    self.assertIn("<a:custGeom>", path._element.xml)
    self.assertIn("<a:cubicBezTo>", path._element.xml)
    self.assertIn("<a:close/>", path._element.xml)
    self.assertEqual((path.left, path.top, path.width, path.height), (E(400), E(50), E(150), E(150)))  # frame = bounds of all points
    self.assertIn('<a:tailEnd type="triangle" w="med" len="med"/>', line._element.xml)
    self.assertNotIn("headEnd", line._element.xml)
    self.assertIn('fill="none"', line._element.xml)                  # open path: <a:path … fill="none">
    self.assertEqual((text.text_frame.text, text.rotation, text.text_frame.word_wrap), ("框选", 15.0, False))
    self.assertEqual(pic.shape_type, MSO_SHAPE_TYPE.PICTURE)

def test_svg_shapes_xml_is_in_schema_order(self):  # PowerPoint repairs out-of-order spPr / ln children
    exporter.build({"slides": [{"id": "s", "bg": None, "items": [svg_group()]}]}, self.tmp / "o.pptx")
    g = Presentation(str(self.tmp / "o.pptx")).slides[0].shapes[0]
    for sh in list(g.shapes)[:3]:
        sp = [c.tag.split("}")[1] for c in sh._element.spPr]
        self.assertEqual(sp[:2], ["xfrm", "custGeom" if "custGeom" in sp else "prstGeom"], sp)
        ln = sh._element.spPr.find(qn("a:ln"))
        order = ["noFill", "solidFill", "prstDash", "round", "headEnd", "tailEnd"]
        tags = [c.tag.split("}")[1] for c in ln]
        self.assertEqual(tags, sorted(tags, key=order.index), tags)
    cg = list(g.shapes)[1]._element.spPr.find(qn("a:custGeom"))
    self.assertEqual([c.tag.split("}")[1] for c in cg], ["avLst", "gdLst", "ahLst", "cxnLst", "rect", "pathLst"])

def test_a_bad_child_is_skipped_and_the_group_kept(self):
    grp = svg_group()
    grp["items"].insert(1, {"k": "path", "id": "b-fig:bad", "segs": [["M", 1, 1]], "fill": "000000"})  # one point: nothing to draw
    grp["items"].insert(1, {"k": "nope", "id": "b-fig:odd"})
    rep = exporter.build({"slides": [{"id": "s", "bg": None, "items": [grp]}]}, self.tmp / "b.pptx")
    self.assertEqual([s["id"] for s in rep["skipped"]], ["b-fig:odd", "b-fig:bad"])
    self.assertEqual(len(list(Presentation(str(self.tmp / "b.pptx")).slides[0].shapes[0].shapes)), 5)

def test_a_group_with_no_child_left_leaves_nothing(self):
    grp = {"k": "group", "id": "b-e", "items": [{"k": "path", "id": "b-e:p", "segs": []}]}
    rep = exporter.build({"slides": [{"id": "s", "bg": None, "items": [grp]}]}, self.tmp / "e.pptx")
    self.assertEqual(len(Presentation(str(self.tmp / "e.pptx")).slides[0].shapes), 0)
    self.assertEqual([s["id"] for s in rep["skipped"]], ["b-e:p"])
```
（`Presentation`、`MSO_SHAPE_TYPE`、`qn`、`E` 在测试里从 `pptx` / `exporter` 导入，按 ExporterTests 现有写法放在方法内。）

- [ ] **Step 2: 跑测试确认失败**

Run: `PYTHONIOENCODING=utf-8 python -m unittest ppt.test_server.ExporterTests`
Expected: 4 个新测试 FAIL/ERROR（`KeyError: 'group'`），其余原有测试通过。

- [ ] **Step 3: 实现**
- `place(container, it, rep) -> None`：`container` 有 `.shapes`（页面或组合）；记下 `container.shapes._spTree` 长度，调用 `add[it["k"]](container, it)`，异常时删掉新增的 XML 节点并记 `skipped`（`"无法生成：{e}"`）；成功按返回的种类计数。主循环改成调用它。未知 `k` 走同一个异常分支。
- `add_group(s, it)`：`grp = s.shapes.add_group_shape()`；对每个子项 `place(grp, child, rep)`；子项一个都没成功就把 `grp._element` 从父树删掉；返回 `None`（不计数）。
- `add_path(s, it)`：点数（`M/L/C` 的终点和控制点）少于 2 个就 `raise ValueError("没有可画的路径")`。外框 = 所有点的最小/最大值（宽高至少 1px）。先 `add_shape(矩形)` + `plain()`，把 `spPr` 里的 `prstGeom` 原位替换成 `custGeom`（子元素顺序 `avLst gdLst ahLst cxnLst rect pathLst`；`<a:path w h>` 用外框 EMU，坐标减去外框左上角；`M→moveTo`、`L→lnTo`、`C→cubicBezTo`（3 个点）、`Z→close`；没有 `Z` 的子路径整条 `path` 加 `fill="none"`，只有在 `fill` 为空时才加——有填充的开放路径照 SVG 隐式闭合填充）。然后 `set_fill`、`set_line`、端点。返回 `"shape"`。
- `set_line(line, hexv, w, a=1, dash=None)`：在现有基础上加线透明度（`alpha(line.fill, a)`）和 `prstDash`（`<a:prstDash val=…>`，插在填充之后）。
- 端点 `ends(ln, start, end)`：`headEnd`/`tailEnd` 带 `type="triangle" w=size len=size`，追加在 `ln` 末尾（在 `prstDash` 之后）。现有 `add_line` 的 `True` 值保持旧写法（无 w/len）以免改动旧测试。
- `add_shape`：支持 `r`（圆角 adj，同 `add_box` 的算法）、`la`、`dash`。
- `add_text`：支持 `rot`。

- [ ] **Step 4: 跑测试确认通过**

Run: `PYTHONIOENCODING=utf-8 python -m unittest ppt.test_server.ExporterTests`
Expected: 全部 OK。

- [ ] **Step 5: 提交**

```bash
git add ppt/exporter.py ppt/test_server.py
git commit -m "feat(export): groups, freeform paths, dashes, line alpha and arrow sizes in the pptx builder"
```

---

### Task 2: 路径数据标准化 `pathSegs(d)`

**Files:**
- Modify: `ppt/export.js`（新增 `pathSegs`，并从 IIFE 的返回值里导出：`return { measure, pathSegs }`）
- Create: `tests/svgpath.test.mjs`（Node 直接跑：`globalThis.window = globalThis`，读入并 `eval` `ppt/export.js`，测 `window.PPTExport.pathSegs`）

**Interfaces:**
- Produces: `pathSegs(d: string) -> Array<['M',x,y] | ['L',x,y] | ['C',x1,y1,x2,y2,x,y] | ['Z']>`，全部为绝对坐标（SVG 用户坐标，未经变换）。`H/V/h/v/l/m/c/s/S/q/Q/t/T/a/A/z` 全部化成这四种：二次曲线升阶为三次；弧线按 SVG 规范 F.6 转端点到中心参数后每 ≤90° 一段三次贝塞尔；`m` 后的隐式坐标对视为 `l`；`Z` 后当前点回到子路径起点。坏数据：在第一个解析不了的位置停下，返回已解析部分（同浏览器行为）。

- [ ] **Step 1: 写失败的测试**（`tests/svgpath.test.mjs`，用 `node:assert/strict`，打印 `n/n passed`，失败时非零退出）

```js
const near = (a, b) => a.length === b.length && a.every((s, i) => s[0] === b[i][0] && s.slice(1).every((v, j) => Math.abs(v - b[i][j + 1]) < 1e-6));
t('absolute and relative lines', pathSegs('M10 10 h20 v10 l-5 5 H0 Z'), [['M',10,10],['L',30,10],['L',30,20],['L',25,25],['L',0,25],['Z']]);
t('implicit lineto after moveto', pathSegs('m1 1 2 0 0 2z'), [['M',1,1],['L',3,1],['L',3,3],['Z']]);
t('after Z the pen is back at the subpath start', pathSegs('M5 5 L9 5 Z l1 1'), [['M',5,5],['L',9,5],['Z'],['L',6,6]]);
t('quadratic becomes cubic', pathSegs('M0 0 Q3 3 6 0'), [['M',0,0],['C',2,2,4,2,6,0]]);
t('smooth cubic reflects the last control point', pathSegs('M0 0 C1 1 2 1 3 0 S5 -1 6 0'), [['M',0,0],['C',1,1,2,1,3,0],['C',4,-1,5,-1,6,0]]);
t('compact numbers', pathSegs('M.5.5L1e1-2'), [['M',0.5,0.5],['L',10,-2]]);
// a half circle arc of radius 10: 2 cubic segments, ends exactly at the end point, mid point on the circle
const arc = pathSegs('M0 0 A10 10 0 0 1 20 0');
ok('arc splits into ≤90° cubics', arc.length === 3 && arc.slice(1).every((s) => s[0] === 'C'));
ok('arc ends at its end point', Math.abs(arc[2][5] - 20) < 1e-6 && Math.abs(arc[2][6]) < 1e-6);
ok('arc passes through the circle top', Math.abs(arc[1][5] - 10) < 1e-6 && Math.abs(Math.abs(arc[1][6]) - 10) < 1e-6);
t('zero-radius arc is a line', pathSegs('M0 0 A0 5 0 0 1 4 4'), [['M',0,0],['L',4,4]]);
t('garbage stops parsing, keeps what came before', pathSegs('M0 0 L5 5 X 9 9'), [['M',0,0],['L',5,5]]);
t('empty', pathSegs(''), []);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/svgpath.test.mjs`
Expected: 报错 `pathSegs is not a function`。

- [ ] **Step 3: 在 `ppt/export.js` 实现 `pathSegs`**（一个分词正则 `/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g`；弧线的旗标可紧挨着写（`a1 1 0 01 2 2`），解析旗标时只取一个字符）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/svgpath.test.mjs`
Expected: `12/12 passed`

- [ ] **Step 5: 提交**

```bash
git add ppt/export.js tests/svgpath.test.mjs
git commit -m "feat(export): normalise SVG path data to absolute M/L/C/Z"
```

---

### Task 3: 浏览器端把 SVG 量成 group

**Files:**
- Modify: `ppt/export.js`（`rasterWhy` 拆成"标签原因"和"样式原因"；`walkOne` 遇到 `svg` 且无样式原因时走 `svgGroup`；`obj()` 里 `icon`/`ink` 走 `svgGroup`；`raster()` 加一个"放进哪个列表"的参数；`cut()` 失败时从各自的列表删除）
- Modify: `tests/e2e.mjs`（导出段：新 SVG fixture + 检查；把原来 "raster for the svg" 的检查改成 group）

**Interfaces:**
- Consumes: Task 1 的 item 形状；Task 2 的 `pathSegs`。
- Produces: `svgGroup(svg: SVGSVGElement, id: string) -> void`，往页面 `items` 推一个 `{k:'group', id, items}`，或在没有可转换元素时 `raster(svg, 'SVG 插图')`。

规则（来自 spec，实现时照做）：
- 坐标：`M = 画布 ← 屏幕`（减 `slide` 左上角再除以 `k`）× `el.getScreenCTM()`。`rect`/`circle`/`ellipse`：用 `M` 变换中心点，宽高乘各自方向的缩放（`hypot(a,b)`、`hypot(c,d)`），旋转 = `atan2(b,a)`；有斜切（`|a·c+b·d| > 1e-6·sx·sy`）、或 `rx>0` 且两方向缩放不等时，该元素转图片（`why: '变形'`）。`line`/`polyline`/`polygon`/`path`：把点（含控制点）逐个乘 `M`，所以任何变换都能表达；`line`/`polyline` 先化成 `M/L`，`polygon` 末尾加 `Z`。
- 文字 `<text>`：`getBBox()` 的中心乘 `M` 定位，宽高乘缩放，`rot` 同上；一个 `<text>` 一个 text item（`wrap:false`），每个文本节点用已有 `run()`，但颜色取计算后的 `fill`（不是 `color`），字号乘纵向缩放；带 `x`/`y`/`dy` 的 `tspan`（非第一个）前插 `{br:true}`；对齐来自 `text-anchor`：`start→l`、`middle→c`、`end→r`。非等比缩放的文字不转图片。
- 样式（计算后的）：`fill`/`stroke` 经 `col()`；`fill-opacity`、`stroke-opacity`、颜色自带 alpha、以及元素到 `svg` 之间每一层的 `opacity` 相乘；`stroke-width × sqrt(|det M|)`（`vector-effect: non-scaling-stroke` 时只除以 `k`）；`stroke-dasharray` 首段 ÷ 线宽：≤1.5 `sysDot`、≤3.5 `sysDash`、否则 `dash`；`marker-start/end` 不是 `none` 就有箭头，大小按 marker 的 `markerWidth`（默认 3，`markerUnits=strokeWidth`）：≤2.5 `sm`、≤4 `med`、否则 `lg`。
- 跳过：`display:none`、`visibility:hidden`、累计 `opacity` 为 0；`defs`、`marker`、`symbol`、`clipPath`、`mask`、`pattern`、`linearGradient`、`radialGradient`、`filter`、`style`、`title`、`desc`、`metadata` 整棵跳过。`g`、`a` 展开子元素。
- 转图片（只此元素，`raster(el, why, 0, groupItems)`）：`fill`/`stroke` 是 `url(…)` → `'渐变或图案'`；`filter` → `'滤镜'`；`clip-path` → `'裁切形状'`；`mask` → `'蒙版'`；`g` 自身有这几种时整个 `g` 转一张；`image`/`foreignObject`/`use`、含 `textPath` 的 `text`、其他未知标签 → `'SVG 里的<标签名>'`；单个元素测量抛错 → `'测量出错'`。
- 子项 id：`${id}:${标签名}${序号}`（序号为该 SVG 内的顺序，从 1 起）。
- `group` 的子项一个都没有（全被跳过）→ 不推 group；全部都要转图片 → 整张 `raster(svg, 'SVG 插图')`。

- [ ] **Step 1: 写失败的 e2e 检查**

在 `s-export` 页加一个块（放进现有 `exportDeck` 字符串）：
```html
<div class="block" id="b-ex-fig" style="grid-area:9/9/10/17;color:#334455"><svg viewBox="0 0 400 100" width="640" height="80">
  <defs><marker id="m-ex" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#999"/></marker>
    <linearGradient id="g-ex"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>
  <rect x="10" y="10" width="80" height="40" rx="6" style="fill:#38bdf8;fill-opacity:.5;stroke:#123456;stroke-width:2;stroke-dasharray:8 6"/>
  <circle cx="130" cy="30" r="20" fill="#ff0000"/>
  <line x1="160" y1="30" x2="230" y2="30" stroke="#4874cb" stroke-width="3" marker-end="url(#m-ex)"/>
  <path d="M240 50 Q260 0 280 50 Z" fill="#00aa00"/>
  <text x="330" y="40" text-anchor="middle" style="font-size:20px;fill:#112233">框选</text>
  <rect x="360" y="10" width="30" height="30" fill="url(#g-ex)"/>
  <circle cx="5" cy="5" r="3" style="display:none"/>
</svg></div>
<div class="obj" id="o-ex-icon" data-kind="icon" style="left:40px;top:640px;width:48px;height:48px;color:#ef4444;stroke-width:2"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 12h16"/></svg></div>
```
（viewBox 400×100 放进 640×80 的框：`meet` 以 0.8 缩放，内容宽 320，水平居中左边留白 160px——这正是 Review Focus 2。虚线 8 ÷ 线宽 2 = 4 → `dash`。）

检查（`ms` 是已有的 `s-export` 测量结果）：
```js
const fig = ms.slides[0].items.find((i) => i.k === 'group' && i.id === 'b-ex-fig');
const fk = fig ? fig.items.map((i) => i.k + ':' + i.id.split(':')[1]) : [];
check('X an svg illustration becomes one group of editable items, in document order', fk.join() === 'shape:rect1,shape:circle2,path:line3,path:path4,text:text5,raster:rect6', fk.join());
const fx0 = await ev(`(() => { const s = document.getElementById('s-export'), k = s.getBoundingClientRect().width / 1280, r = document.querySelector('#b-ex-fig svg').getBoundingClientRect(); return (r.left - s.getBoundingClientRect().left) / k; })()`);
const rect1 = fig?.items[0];
check('X svg items land where the page draws them (viewBox scale and meet offset)', rect1 && Math.abs(rect1.x - (fx0 + 160 + 8)) < 1 && Math.abs(rect1.w - 64) < 1 && Math.abs(rect1.r - 4.8) < 0.1, JSON.stringify(rect1));
check('X svg styles: colour, opacity, dash, round corner', rect1?.fill === '38bdf8' && Math.abs(rect1.fa - 0.5) < 0.01 && rect1.line === '123456' && rect1.dash === 'dash' && Math.abs(rect1.lw - 1.6) < 0.05, JSON.stringify(rect1));
const ln3 = fig?.items[2];
check('X a marker becomes an arrow end in the line colour', ln3?.end === 'med' && !ln3.start && ln3.line === '4874cb', JSON.stringify(ln3));
check('X a quadratic path is exported as cubic segments', fig?.items[3].segs.map((s) => s[0]).join('') === 'MCZ', JSON.stringify(fig?.items[3].segs));
const tx5 = fig?.items[4];
check('X svg text is an editable text box with its fill colour, scaled size and anchor', tx5?.paras[0].runs[0].t === '框选' && tx5.paras[0].runs[0].color === '112233' && Math.abs(tx5.paras[0].runs[0].size - 16) < 0.1 && tx5.paras[0].align === 'c' && tx5.wrap === false, JSON.stringify(tx5));
check('X only the gradient element is a picture, and the report says why', fig?.items[5].why === '渐变或图案' && fig.items[5].src.startsWith('data:image/png'), JSON.stringify(fig?.items[5]?.why));
const icon = ms.slides[0].items.find((i) => i.k === 'group' && i.id === 'o-ex-icon');
check('X an icon exports as an editable line in the text colour, no fill', icon?.items.length === 1 && icon.items[0].k === 'path' && icon.items[0].line === 'ef4444' && icon.items[0].fill === null, JSON.stringify(icon));
```
把原来的检查 `'X the measure has native text, box, table, shape, line and a raster for the svg'` 改为要求 `group` 且 `b-ex-svg` 是 group（它的圆变成 `shape:circle1`）。另加：
```js
const failed = JSON.parse(await ev(`(async () => { const real = htmlToImage.toCanvas; htmlToImage.toCanvas = () => Promise.reject(new Error('boom'));
  try { return JSON.stringify(await PPTExport.measure([document.getElementById('s-export')])); } finally { htmlToImage.toCanvas = real; } })()`));
const fItems = failed.slides[0].items;
check('X a failed picture cut drops only that picture, from its own group', fItems.some((i) => i.id === 'b-ex-fig') && fItems.find((i) => i.id === 'b-ex-fig').items.length === 5
  && fItems.length === ms.slides[0].items.filter((i) => i.k !== 'raster').length && failed.skipped.some((s) => s.id === 'b-ex-fig:rect6'), JSON.stringify(failed.skipped));
```

- [ ] **Step 2: 跑 e2e 确认这些检查失败**

Run: `node tests/e2e.mjs > "$TEMP/ppt-logs/e2e.log"; grep "^FAIL" "$TEMP/ppt-logs/e2e.log"`
Expected: 新加的 `X …svg…` / `X an icon…` / `X a failed picture cut…` 和改过的 measure 检查 FAIL，其余 PASS。

- [ ] **Step 3: 在 `ppt/export.js` 按上面的规则实现 `svgGroup`，并改 `walkOne`、`obj`、`raster`、`cut`**

`rasters` 的元素改成 `[el, it, list]`，`cut()` 失败时 `list.splice(list.indexOf(it), 1)`。

- [ ] **Step 4: 跑 e2e 确认全部通过**

Run: `node tests/e2e.mjs > "$TEMP/ppt-logs/e2e.log"; tail -1 "$TEMP/ppt-logs/e2e.log"; grep "^FAIL" "$TEMP/ppt-logs/e2e.log"`
Expected: `N/N passed`（N = 原 199 + 新增数），没有 FAIL。另跑 `node tests/svgpath.test.mjs` 和 ExporterTests 仍全过。

- [ ] **Step 5: 提交**

```bash
git add ppt/export.js tests/e2e.mjs
git commit -m "feat(export): inline SVG exports as a group of editable shapes; only unsupported elements become pictures"
```

---

### Task 4: 用真实稿子验收，更新文档

**Files:**
- Modify: `README.md`、`docs/guide.html`（在已有说明"转不了的部分会转成图片"的地方补一句：插图里的文字、颜色、位置导出后可改）——只在两处已有导出说明的位置各加一句。注意 README 目前在 `feat/api-runner` 分支；本分支上若没有 `README.md` 就只改 `docs/guide.html`，并在 state 里记下合并时要补 README。

- [ ] **Step 1: 复制 `decks/试用` 到临时目录导出**

Run（Git Bash）：
```bash
D="$TEMP/ppt-svg-check/试用"; rm -rf "$TEMP/ppt-svg-check"; mkdir -p "$D"; cp decks/试用/deck.html "$D/"; cp -r decks/试用/assets "$D/" 2>/dev/null
PYTHONIOENCODING=utf-8 python ppt/server.py "$D" --port 8811 --export; python ppt/server.py "$D" --stop
```
（`--export` 会在后台起一个服务，用完 `--stop` 关掉。）
Expected: 打印"导出完成"，报告里 5 张插图不再整体列为"SVG 插图"图片。

- [ ] **Step 2: 检查导出文件**

Run: `PYTHONIOENCODING=utf-8 python -c "from pptx import Presentation;import glob,sys;p=Presentation(glob.glob(sys.argv[1]+'/export/*.pptx')[0]);print([[sh.shape_type for sh in s.shapes] for s in p.slides])" "$D"`
Expected: 有插图的页里出现 `GROUP (6)`，组合内有文本框。

- [ ] **Step 3: 改文档并提交**

```bash
git add docs/guide.html README.md 2>/dev/null; git commit -m "docs: illustrations export as editable shapes"
```

- [ ] **Step 4: 交给用户人工验收**：把导出的 pptx 路径告诉用户，请其用 PowerPoint 打开：不弹修复、插图能改字和颜色。
