# ppt-maker 子项目 3：手绘草图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在幻灯片上用鼠标画草图（画笔、橡皮、文字标注、撤销、清空），画完"发给 Claude"成为 `kind:sketch` 意图，或"保留为笔迹"成为 `data-kind="ink"` 浮动对象。

**Architecture:** 新文件 `ppt/sketch.js` 分两层：确定性的纯函数（简化、平滑、外接矩形、橡皮命中、笔迹 SVG、把草图画进截图），以及画笔模式界面 `open(slide, cb)`。界面不直接改 deck：发送和保留都交给 `editor.js`，后者复用现有的意图队列、截图和 2b 的 `addObj` / op 机制。`ops.js` 只多一种对象 `ink` 和一个 op `setInkColor`。

**Tech Stack:** 浏览器原生 JS（Pointer Events、SVG、Canvas Path2D）、Python 3 标准库服务、Edge/Chrome headless 测试。

**Spec:** `docs/superpowers/specs/2026-10-14-ppt-maker-sketch-design.md`

## Global Constraints

- 在分支 `feat/sketch` 上工作；每个 task 提交，提交信息末尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- 坐标一律为画布像素 1280×720；颜色 红 `#ef4444`（默认）、黑 `#111827`、蓝 `#2563eb`、绿 `#16a34a`、橙 `#f97316`；粗细 细 2 / 中 4（默认）/ 粗 8。
- 采集：与上一点距离 < 2px 的点丢弃；RDP 容差 1.5px；坐标保留一位小数；同样输入总得到同样的 `d`。
- 标注 20px；`notes` 最多 50 项，每项 ≤ 200 字。
- 草图本身不进 deck、不进撤销历史；草稿键 `ppt-sketch:<slideId>`（经 editor 的 `ls`，自动按口令分键）。
- 发送默认文字"按草图修改这一页"；截图为整页 1280×720。
- deck 里不出现 `data-ppt` 属性或 `ppt-` 开头的 class；所有 deck 修改都经 op。
- 测试命令：`python ppt/test_server.py`；selftest（`$TEMP/ppt-logs/selftest.sh`，只认 `PASS n/n`）；`node tests/e2e.mjs`（只用 `decks/e2e-smoke` 和端口 8800）。
- Windows：含反斜杠的代码用 Edit/Write 写，不用 Bash heredoc。

## Review Focus

1. **标注文字含 `<`、`&` 等字符**：画板、截图、笔迹里都按原文显示，不被当成 HTML。→ Task 1 selftest `inkSVG escapes note text`；Task 4 e2e 标注用 `标题<1>`。
2. **在标注输入框里按 Esc**：只放弃这个标注，不退出画笔模式。→ Task 4 e2e `K Esc in the note box only cancels the note`。
3. **发送输入框里按 Esc**：只关掉输入框，草图和画笔模式都还在。→ Task 4 e2e `K Esc in the send box keeps the sketch`。
4. **画笔模式中按 Delete / Ctrl+Z**：不能删除选中块或撤销 deck。→ Task 4 e2e `K deck keys are inert while sketching`。
5. **画到幻灯片外**：点被夹在画布内，外接矩形不超出 1280×720。→ Task 1 selftest `bounds clamps to the canvas`；Task 4 e2e 有一笔拖出幻灯片。

---

### Task 1: sketch.js 纯函数

**Files:**
- Create: `ppt/sketch.js`
- Test: `ppt/selftest.html`

**Interfaces:**
- Produces（`window.PPTSketch`）：
  - `simplify(pts, tol = 1.5) -> pts`（RDP；`pts` 为 `[[x, y], …]`）
  - `smoothPath(pts) -> string`（不再简化；1 点 → `M x yL x y`，2 点 → `M…L…`，≥3 点 → 以中点为端点的二次曲线，末尾 `L` 到最后一点）
  - `noteSize(text) -> {w, h}`（每个非 ASCII 字符 20px、ASCII 11px，加 12px 内边距；h = 28）
  - `bounds(items, pad, clamp) -> {x, y, w, h} | null`（整数；clamp=true 时夹在画布内）
  - `hitItem(items, x, y) -> index | -1`（从最上层找；笔画命中距离 ≤ width/2 + 6；标注按其方框）
  - `inkSVG(items) -> {geom: {x, y, w, h}, html}`（留边 `max(width)/2 + 4`；SVG 内坐标相对外框）
  - `drawOnCanvas(ctx, items, k = 1)`
  - `COLORS`、`WIDTHS`、`esc(text)`
  - item 形状：`{type:'stroke', color, width, pts, d}` / `{type:'note', color, x, y, text}`

- [ ] **Step 1: 写失败的测试**

`ppt/selftest.html`：在 `<script src="toolbar.js"></script>` 之后加 `<script src="sketch.js"></script>`。在 `// ---- 2b: icons ----` 之前插入：

```js
  // ---- 3: sketch maths ----
  const K = window.PPTSketch || {};
  check('simplify drops collinear points', K.simplify && K.simplify(Array.from({ length: 50 }, (_, i) => [i * 2, 0])), [[0, 0], [98, 0]]);
  check('simplify keeps a corner', K.simplify && K.simplify([[0, 0], [50, 0], [100, 0], [100, 50], [100, 100]]), [[0, 0], [100, 0], [100, 100]]);
  check('smoothPath: quadratic through midpoints', K.smoothPath && K.smoothPath([[0, 0], [10, 0], [10, 10]]), 'M0 0Q10 0 10 5L10 10');
  check('smoothPath: one point is a dot', K.smoothPath && K.smoothPath([[5, 5]]), 'M5 5L5 5');
  const st = { type: 'stroke', color: '#ef4444', width: 4, pts: [[0, 0], [100, 50]] };
  check('bounds clamps to the canvas', K.bounds && [K.bounds([st], 8, true), K.bounds([st], 8, false), K.bounds([], 8, true)],
    [{ x: 0, y: 0, w: 108, h: 58 }, { x: -8, y: -8, w: 116, h: 66 }, null]);
  check('bounds counts a note box', K.bounds && K.bounds([{ type: 'note', color: '#111827', x: 200, y: 100, text: '标题' }], 0, true), { x: 200, y: 100, w: 52, h: 28 });
  check('inkSVG: box, relative coords, non-scaling stroke', K.inkSVG && K.inkSVG([{ type: 'stroke', color: '#ef4444', width: 4, pts: [[100, 100], [200, 100]] }]),
    { geom: { x: 94, y: 94, w: 112, h: 12 }, html: '<svg viewBox="0 0 112 12" preserveAspectRatio="none"><path d="M6 6L106 6" fill="none" stroke="#ef4444" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>' });
  check('inkSVG escapes note text', K.inkSVG && (() => { const h = K.inkSVG([{ type: 'note', color: '#111827', x: 10, y: 10, text: '<b>&' }]).html; return h.includes('&lt;b&gt;&amp;') && !h.includes('<b>'); })(), true);
  const hs = [{ type: 'stroke', width: 4, pts: [[0, 0], [100, 0]] }, { type: 'stroke', width: 4, pts: [[0, 0], [0, 100]] }];
  check('hitItem: near a stroke, miss, topmost first', K.hitItem && [K.hitItem(hs, 50, 7), K.hitItem(hs, 50, 9), K.hitItem(hs, 0, 0)], [0, -1, 1]);
  check('drawOnCanvas burns strokes in', K.drawOnCanvas && (() => {
    const c = document.createElement('canvas'); c.width = 100; c.height = 50; const x = c.getContext('2d');
    K.drawOnCanvas(x, [{ type: 'stroke', color: '#000000', width: 4, d: 'M0 25L100 25' }], 1);
    return x.getImageData(50, 25, 1, 1).data[3] > 0;
  })(), true);
```

- [ ] **Step 2: 运行，确认失败**

Run: selftest
Expected: `FAIL 78/88`（10 条新用例失败；`K.simplify` 等未定义）

- [ ] **Step 3: 写 `ppt/sketch.js`**

```js
// ppt-maker sketch: freehand strokes + notes over one slide. Pure maths first (deterministic, unit-tested),
// then the sketch-mode overlay. It never edits the deck: editor.js turns a finished sketch into an intent or an ink object.
(() => {
  const W = 1280, H = 720;
  const COLORS = ['#ef4444', '#111827', '#2563eb', '#16a34a', '#f97316'];
  const WIDTHS = [[2, '细'], [4, '中'], [8, '粗']];
  const NOTE_FONT = '20px "Microsoft YaHei", "PingFang SC", sans-serif';
  const n1 = (v) => Math.round(v * 10) / 10;
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function segDist([px, py], [ax, ay], [bx, by]) {
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  }
  function simplify(pts, tol = 1.5) { // Ramer–Douglas–Peucker
    if (pts.length < 3) return pts.slice();
    const a = pts[0], b = pts[pts.length - 1];
    let far = 0, at = 0;
    for (let i = 1; i < pts.length - 1; i++) { const d = segDist(pts[i], a, b); if (d > far) { far = d; at = i; } }
    if (far <= tol) return [a, b];
    return [...simplify(pts.slice(0, at + 1), tol).slice(0, -1), ...simplify(pts.slice(at), tol)];
  }
  function smoothPath(pts) { // quadratic curves: each point is a control, midpoints are the anchors
    const p = pts.map(([x, y]) => [n1(x), n1(y)]), f = ([x, y]) => `${x} ${y}`;
    if (p.length < 3) return `M${f(p[0])}L${f(p[p.length - 1])}`;
    let d = `M${f(p[0])}`;
    for (let i = 1; i < p.length - 1; i++) d += `Q${f(p[i])} ${f([n1((p[i][0] + p[i + 1][0]) / 2), n1((p[i][1] + p[i + 1][1]) / 2)])}`;
    return `${d}L${f(p[p.length - 1])}`;
  }
  const noteSize = (text) => ({ w: [...text].reduce((s, c) => s + (c.charCodeAt(0) > 255 ? 20 : 11), 0) + 12, h: 28 });
  function bounds(items, pad, clamp) {
    if (!items.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
    for (const i of items) {
      if (i.type === 'stroke') i.pts.forEach(([x, y]) => add(x, y));
      else { const s = noteSize(i.text); add(i.x, i.y); add(i.x + s.w, i.y + s.h); }
    }
    let x = Math.floor(x0 - pad), y = Math.floor(y0 - pad), r = Math.ceil(x1 + pad), b = Math.ceil(y1 + pad);
    if (clamp) { x = Math.max(0, x); y = Math.max(0, y); r = Math.min(W, r); b = Math.min(H, b); }
    return { x, y, w: r - x, h: b - y };
  }
  function hitItem(items, x, y) { // eraser: the topmost item under the pointer
    for (let n = items.length - 1; n >= 0; n--) {
      const i = items[n];
      if (i.type === 'note') { const s = noteSize(i.text); if (x >= i.x && x <= i.x + s.w && y >= i.y && y <= i.y + s.h) return n; continue; }
      const p = i.pts, reach = i.width / 2 + 6;
      if (p.length === 1 ? Math.hypot(x - p[0][0], y - p[0][1]) <= reach : p.some((q, k) => k && segDist([x, y], p[k - 1], q) <= reach)) return n;
    }
    return -1;
  }
  function inkSVG(items) { // a kept sketch: one SVG whose box is the drawing's extent
    const pad = Math.max(0, ...items.map((i) => i.width || 0)) / 2 + 4, b = bounds(items, pad, false);
    const body = items.map((i) => (i.type === 'stroke'
      ? `<path d="${smoothPath(i.pts.map(([x, y]) => [x - b.x, y - b.y]))}" fill="none" stroke="${esc(i.color)}" stroke-width="${i.width}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`
      : `<text x="${n1(i.x - b.x + 6)}" y="${n1(i.y - b.y + 20)}" font-size="20" fill="${esc(i.color)}">${esc(i.text)}</text>`)).join('');
    return { geom: { x: b.x, y: b.y, w: b.w, h: b.h }, html: `<svg viewBox="0 0 ${b.w} ${b.h}" preserveAspectRatio="none">${body}</svg>` };
  }
  function drawOnCanvas(ctx, items, k = 1) { // burn a sketch into a slide screenshot; k = canvas px per canvas unit
    ctx.save(); ctx.scale(k, k); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const i of items) {
      if (i.type === 'stroke') { ctx.strokeStyle = i.color; ctx.lineWidth = i.width; ctx.stroke(new Path2D(i.d)); continue; }
      const s = noteSize(i.text);
      ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillRect(i.x, i.y, s.w, s.h);
      ctx.fillStyle = i.color; ctx.font = NOTE_FONT; ctx.fillText(i.text, i.x + 6, i.y + 20);
    }
    ctx.restore();
  }

  window.PPTSketch = { COLORS, WIDTHS, esc, simplify, smoothPath, noteSize, bounds, hitItem, inkSVG, drawOnCanvas };
})();
```

- [ ] **Step 4: 运行，确认通过**

Run: selftest → Expected: `PASS 88/88`

- [ ] **Step 5: 提交**

```bash
git add ppt/sketch.js ppt/selftest.html
git commit -m "feat(sketch): stroke simplify/smooth, bounds, eraser hit, ink SVG, screenshot burn-in

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: ops.js `ink` 与 `setInkColor`；`hitBlocks` 也命中对象

**Files:**
- Modify: `ppt/ops.js`、`ppt/geom.js`
- Test: `ppt/selftest.html`

**Interfaces:**
- Consumes: Task 1 `PPTSketch.inkSVG`。
- Produces：`insertObj` 接受 `kind:'ink'`；op `setInkColor` args `{color}`（只对 `data-kind="ink"`）；`PPTGeom.hitBlocks(slide, r)` 返回相交的块**和对象** id（对象在前，因为它们在最上层；之后块按由内到外）。

- [ ] **Step 1: 写失败的测试**

`ppt/selftest.html` 在 `check('obj ops deterministic on two copies', …);` 之后插入：

```js
  // ---- 3: ink objects ----
  const ink = K.inkSVG ? K.inkSVG([{ type: 'stroke', color: '#ef4444', width: 4, pts: [[10, 10], [60, 40]] }, { type: 'note', color: '#111827', x: 70, y: 10, text: '注' }]) : { geom: {}, html: '' };
  const idoc = mo();
  check('ink insertObj', O.apply(idoc, { op: 'insertObj', args: { id: 'k1', slideId: 'u1', kind: 'ink', geom: ink.geom, html: ink.html } }), true);
  O.apply(idoc, { op: 'setInkColor', target: 'k1', args: { color: '#2563eb' } });
  check('setInkColor recolours every stroke and note', [...idoc.querySelectorAll('#k1 path, #k1 text')].map((n) => n.getAttribute('stroke') || n.getAttribute('fill')), ['#2563eb', '#2563eb']);
  check('setInkColor only on ink', O.apply(idoc, { op: 'setInkColor', target: 'ub', args: { color: '#2563eb' } }), false);
  const id1 = mo(), id2 = mo(), ISEQ = [{ op: 'insertObj', args: { id: 'k1', slideId: 'u1', kind: 'ink', geom: ink.geom, html: ink.html } }, { op: 'setInkColor', target: 'k1', args: { color: '#16a34a' } }];
  ISEQ.forEach((op) => { O.apply(id1, op); O.apply(id2, op); });
  check('ink ops deterministic on two copies', ser(id1) === ser(id2) && ser(id1) !== ser(mo()), true);
```

在 `check('lint objects', …);` 之后插入：

```js
  check('hitBlocks also returns objects', G.hitBlocks(document.getElementById('s3'), { x: 95, y: 195, w: 5, h: 5 }), ['g5']);
```

- [ ] **Step 2: 运行，确认失败**

Run: selftest → Expected: `FAIL 89/93`（ink insertObj、recolour、deterministic、hitBlocks 失败；"only on ink" 已经返回 false 会通过）

- [ ] **Step 3: 实现**

`ppt/ops.js`：
- `const KINDS = new Set(['shape', 'arrow', 'icon', 'image']);` 改为 `const KINDS = new Set(['shape', 'arrow', 'icon', 'image', 'ink']);`
- 在 `ensureBase(doc) {` 之前加：

```js
    setInkColor(doc, t, a) { // a kept sketch turns one colour as a whole
      if (!isObj(t) || t.dataset.kind !== 'ink' || !a.color) return false;
      t.querySelectorAll('path').forEach((p) => p.setAttribute('stroke', a.color));
      t.querySelectorAll('text').forEach((x) => x.setAttribute('fill', a.color));
    },
```

`ppt/geom.js` 的 `hitBlocks` 改为：

```js
  function hitBlocks(slide, r) { // objects first (they are on top), then blocks innermost first
    const sr = slide.getBoundingClientRect(), hit = (sel) => [...slide.querySelectorAll(sel)].filter((b) => touches(elementRect(sr, b), r));
    return [...hit('.obj[id]').reverse(), ...hit('.block[id]').sort((a, b) => depth(b) - depth(a))].map((b) => b.id);
  }
```

- [ ] **Step 4: 运行，确认通过**

Run: selftest → `PASS 93/93`；`node tests/e2e.mjs` → `98/98 passed`（hitBlocks 变化不破坏已有意图测试）

- [ ] **Step 5: 提交**

```bash
git add ppt/ops.js ppt/geom.js ppt/selftest.html
git commit -m "feat(sketch): ink objects, setInkColor op, area hits include objects

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 服务端 `notes` 字段与注入 sketch.js

**Files:**
- Modify: `ppt/server.py`
- Test: `ppt/test_server.py`

**Interfaces:**
- Produces：事件字段 `notes`（≤ 50 个字符串，每个 ≤ 200 字）；摘要行 `… [blocks]{quote} notes:「a」「b」 文字`（前 3 个，每个截 10 字）；注入顺序 `icons-zh.js → sketch.js → toolbar.js`。

- [ ] **Step 1: 写失败的测试**

`ppt/test_server.py` 在 `class DrawIconTests` 之前加：

```python
class SketchTests(ServerCase):
    def test_notes_kept_and_summarised(self):
        self.req("POST", "/api/event?t=tok", {"type": "intent", "kind": "sketch", "slide_id": "s-cover", "blocks": [],
                                              "text": "按草图修改这一页", "notes": ["标题", "这里放图表"]})
        e = inbox(self.deck)[-1]
        self.assertEqual(e["notes"], ["标题", "这里放图表"])
        self.assertIn("notes:「标题」「这里放图表」", server.summary(e))

    def test_bad_notes_rejected(self):
        for notes in (["ok", 5], ["x"] * 51, ["长" * 201], "标题"):
            self.assertEqual(self.req("POST", "/api/event?t=tok", {"type": "intent", "kind": "sketch", "text": "x", "notes": notes})[0], 400, notes)

    def test_sketch_js_injected_before_toolbar(self):
        html = self.req("GET", "/?t=tok")[1].decode()
        at = [html.index(f"/_ppt/{n}") for n in ("icons-zh.js", "sketch.js", "toolbar.js")]
        self.assertEqual(at, sorted(at))
```

- [ ] **Step 2: 运行，确认失败**

Run: `python ppt/test_server.py` → Expected: 3 个新测试 FAIL/ERROR，其余 OK

- [ ] **Step 3: 实现 `ppt/server.py`**

1. `FIELD_TYPES` 加 `"notes": list`。
2. `clean_event` 里，`q = ev.get("quote")` 之前加：

```python
    notes = ev.get("notes")
    if notes is not None and (len(notes) > MAX_NOTES or not all(isinstance(n, str) and len(n) <= MAX_NOTE for n in notes)):
        raise ValueError("bad notes")
```

并在常量区 `MAX_TEXT = 4000` 之后加 `MAX_NOTES = 50` 和 `MAX_NOTE = 200`。
3. `summary` 里，`quote = …` 之后加：

```python
    notes = " notes:" + "".join(f"「{n[:10]}」" for n in e["notes"][:3]) if e.get("notes") else ""
```

并把 `line` 里的 `{quote}` 改为 `{quote}{notes}`。
4. `INJECT` 里 `'<script src="/_ppt/icons-zh.js" data-ppt></script>'` 之后加一行 `'<script src="/_ppt/sketch.js" data-ppt></script>'`。

- [ ] **Step 4: 运行，确认通过**

Run: `python ppt/test_server.py` → Expected: `Ran 50 tests … OK`

- [ ] **Step 5: 提交**

```bash
git add ppt/server.py ppt/test_server.py
git commit -m "feat(sketch): notes field on events, inject sketch.js

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 画笔模式界面与接入编辑器

**Files:**
- Modify: `ppt/sketch.js`（加 `open`）、`ppt/editor.js`、`ppt/toolbar.js`、`ppt/editor.css`
- Test: `tests/e2e.mjs`

**Interfaces:**
- Consumes: Task 1 全部纯函数；Task 2 `setInkColor`、`hitBlocks`；Task 3 `notes`；editor 已有 `place / ls / toast / openPop / enqueue / commit / addObj / currentSlide / select / closePop / disarm / endEdit`。
- Produces：
  - `PPTSketch.open(slide, cb) -> {slide, close(discard)}`；`cb = {place, ls, toast, send(items), keep(items), onClose()}`。
  - 草图工具栏按钮标题：`画笔`、颜色 `#ef4444`…、`粗细`（select）、`橡皮（点一下删掉一笔）`、`T 标注`、`撤销上一笔`、`清空草图`、`把草图发给 Claude`、`把草图留在幻灯片上`、`退出草图（草稿会保留）`。
  - 顶栏：`✎ 草图`（title `在当前页上画草图`）、`+草图页`（title `插入空白页并画草图`）。
  - ink 浮动栏：`颜色`、`透明度`、`置顶`、`置底`、`删除`、`问 Claude`。

- [ ] **Step 1: 写失败的 e2e 测试**

`tests/e2e.mjs` 在 `// ---- add new checks above ----` 之前插入：

```js
  // ---- 3: sketch ----
  await open(url); await ev(`scrollTo(0, 0)`); await sleep(300);
  let b8 = await byTitle('在当前页上画草图'); await click(b8.x, b8.y); await sleep(300);
  check('K sketch mode overlays the current slide', ((await ev(`document.querySelector('.ppt-sketch')?.getBoundingClientRect().width`)) || 0) > 100);
  const ks = await ev(`(() => { const r = document.getElementById('s-cover').getBoundingClientRect(); return {l: r.left, t: r.top, k: r.width / 1280}; })()`);
  const P = (x, y) => [ks.l + x * ks.k, ks.t + y * ks.k];
  const counts = () => ev(`[document.querySelectorAll('.ppt-sketch path').length, document.querySelectorAll('.ppt-sketch text').length].join()`);
  await drag(...P(100, 100), ...P(400, 100)); await drag(...P(100, 200), ...P(1300, 320)); // the second runs off the slide
  b8 = await byTitle('T 标注'); await click(b8.x, b8.y); await click(...P(500, 150)); await sleep(200);
  await type('不要'); await key('Escape', 'Escape', 27); await sleep(200);
  check('K Esc in the note box only cancels the note', (await counts()) === '2,0' && !!(await ev(`document.querySelector('.ppt-sketch')`)), await counts());
  await click(...P(500, 150)); await sleep(200); await type('标题<1>'); await enter(); await sleep(200);
  check('K two strokes and a note, shown as text', (await counts()) === '2,1' && (await ev(`document.querySelector('.ppt-sketch text')?.textContent`)) === '标题<1>', await counts());
  await key('Delete', 'Delete', 46); await key('z', 'KeyZ', 90, 2); await sleep(1500);
  check('K deck keys are inert while sketching', (await counts()) === '2,1' && !!(await ev(`document.querySelector('.ppt-sketch')`)));
  b8 = await byTitle('撤销上一笔'); await click(b8.x, b8.y); await sleep(200);
  check('K ↶ removes the last item', (await counts()) === '2,0');
  b8 = await byTitle('T 标注'); await click(b8.x, b8.y); await click(...P(500, 150)); await sleep(200); await type('标题<1>'); await enter(); await sleep(200);
  b8 = await byTitle('橡皮'); await click(b8.x, b8.y); await click(...P(250, 101)); await sleep(200);
  check('K eraser removes the stroke it touches', (await counts()) === '1,1', await counts());
  await ev(`window.__marker = 1`);
  fs.writeFileSync(path.join(DECK, 'deck.html'), deckHtml().replace('<title>', '<title>K')); await sleep(2500);
  check('K no reload while sketching', (await ev(`window.__marker`)) === 1);
  await key('Escape', 'Escape', 27); await sleep(2500);
  check('K Esc leaves sketch mode, then the page reloads', (await ev(`window.__marker`)) === undefined && !(await ev(`document.querySelector('.ppt-sketch')`)));
  await ev(`scrollTo(0, 0)`); await sleep(300);
  b8 = await byTitle('在当前页上画草图'); await click(b8.x, b8.y); await sleep(300);
  check('K the draft comes back', (await counts()) === '1,1');
  b8 = await byTitle('把草图发给 Claude'); await click(b8.x, b8.y); await sleep(300);
  await key('Escape', 'Escape', 27); await sleep(200);
  check('K Esc in the send box keeps the sketch', !(await ev(`document.querySelector('.ppt-pop')`)) && (await counts()) === '1,1');
  b8 = await byTitle('把草图发给 Claude'); await click(b8.x, b8.y); await sleep(300); await enter(); await sleep(3000);
  const ke = inbox().filter((e) => e.type === 'intent').at(-1);
  check('K send: sketch intent with shot, notes and the default text', ke?.kind === 'sketch' && ke.text === '按草图修改这一页' && JSON.stringify(ke.notes) === '["标题<1>"]' && ke.slide_id === 's-cover' && !!ke.shot
    && ke.rect.x + ke.rect.w <= 1280, JSON.stringify({ ...ke, shot: !!ke?.shot }));
  const shotPng = ke?.shot && fs.readFileSync(path.join(DECK, ke.shot));
  check('K the shot is the whole slide', !!shotPng && shotPng.readUInt32BE(16) === 1280 && shotPng.readUInt32BE(20) === 720);
  const leftMode = !(await ev(`document.querySelector('.ppt-sketch')`));
  b8 = await byTitle('在当前页上画草图'); await click(b8.x, b8.y); await sleep(300);
  check('K sending leaves sketch mode and clears the draft', leftMode && (await counts()) === '0,0');
  b8 = await byTitle('把草图发给 Claude'); await click(b8.x, b8.y); await sleep(300);
  check('K an empty sketch is not sent', ((await ev(`[...document.querySelectorAll('.ppt-toast')].map((t) => t.textContent).join()`)) || '').includes('还没有画内容') && !(await ev(`document.querySelector('.ppt-pop')`)));
  await drag(...P(600, 500), ...P(800, 560)); await sleep(200);
  b8 = await byTitle('把草图留在幻灯片上'); await click(b8.x, b8.y); await sleep(2500);
  const inkHtml = () => (deckHtml().match(/<div class="obj" id="o-[0-9a-z]{6}" data-kind="ink"[\s\S]*?<\/div>/) || [''])[0];
  check('K keep: an ink object is saved and selected', /data-kind="ink" style="left: \d+px;[^"]*"><svg viewBox="0 0 \d+ \d+" preserveAspectRatio="none"><path d="M[^"]+" fill="none" stroke="#ef4444" stroke-width="4"[^>]*vector-effect="non-scaling-stroke"/.test(inkHtml())
    && !!(await byTitle('颜色')) && !(await ev(`document.querySelector('.ppt-sketch')`)), inkHtml().slice(0, 200));
  b8 = await byTitle('颜色'); await click(b8.x, b8.y); await sleep(200);
  b8 = await byTitle('#2563eb'); await click(b8.x, b8.y); await sleep(2000);
  check('K ink colour changes every stroke', inkHtml().includes('#2563eb') && !inkHtml().includes('#ef4444'));
  await key('z', 'KeyZ', 90, 2); await sleep(3000);
  check('K undo restores the ink colour', inkHtml().includes('#ef4444'));
  const ns0 = nSlides();
  b8 = await byTitle('插入空白页并画草图'); await click(b8.x, b8.y); await sleep(2500);
  check('K +草图页 adds a blank slide and opens sketch mode on it', nSlides() === ns0 + 1 && !!(await ev(`document.querySelector('.ppt-sketch')`)));
  await key('Escape', 'Escape', 27); await sleep(500);
```

- [ ] **Step 2: 运行，确认失败**

Run: `node tests/e2e.mjs`
Expected: `script ran to the end` FAIL（`byTitle('在当前页上画草图')` 为 null），其余 98 条 PASS

- [ ] **Step 3: 在 `ppt/sketch.js` 加 `open`**

在 `window.PPTSketch = …` 之前加：

```js
  // ---- sketch mode: one transparent SVG board over one slide ----
  const NS = 'http://www.w3.org/2000/svg';
  function itemSVG(i) {
    if (i.type === 'stroke') return `<path d="${i.d}" fill="none" stroke="${esc(i.color)}" stroke-width="${i.width}" stroke-linecap="round" stroke-linejoin="round"/>`;
    const s = noteSize(i.text);
    return `<g><rect x="${i.x}" y="${i.y}" width="${s.w}" height="${s.h}" rx="4" fill="#fff" fill-opacity=".85"/>`
      + `<text x="${i.x + 6}" y="${i.y + 20}" font-size="20" font-family='"Microsoft YaHei", sans-serif' fill="${esc(i.color)}">${esc(i.text)}</text></g>`;
  }
  function open(slide, cb) {
    const G = window.PPTGeom, ui = document.getElementById('ppt-ui'), key = `ppt-sketch:${slide.id}`;
    let items = cb.ls.get(key, []), mode = 'pen', color = COLORS[0], width = 4, cur = null, note = null;
    const undo = [];
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'ppt-abs ppt-sketch'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const live = document.createElementNS(NS, 'path');
    ui.appendChild(svg);
    const bar = document.createElement('div'); bar.className = 'ppt-abs ppt-bar ppt-sketchbar'; ui.appendChild(bar);
    const btn = (label, title, fn, cls = '') => {
      const b = document.createElement('button'); b.type = 'button'; b.className = `ppt-btn ${cls}`; b.textContent = label; b.title = title;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', fn); bar.appendChild(b); return b;
    };
    const sep = () => { const s = document.createElement('span'); s.className = 'ppt-sep'; bar.appendChild(s); };
    const modeBtns = { pen: btn('✎', '画笔', () => setMode('pen')) };
    const swatches = COLORS.map((c) => { const b = btn('', c, () => { color = c; if (mode === 'erase') mode = 'pen'; paint(); }, 'ppt-swatch'); b.style.background = c; return b; });
    const size = document.createElement('select'); size.title = '粗细';
    WIDTHS.forEach(([w, l]) => { const o = document.createElement('option'); o.value = w; o.textContent = l; size.appendChild(o); });
    size.value = String(width); size.addEventListener('change', () => { width = +size.value; }); bar.appendChild(size);
    modeBtns.erase = btn('⌫', '橡皮（点一下删掉一笔）', () => setMode('erase'));
    modeBtns.note = btn('T', 'T 标注', () => setMode('note'));
    btn('↶', '撤销上一笔', () => { if (undo.length) { items = undo.pop(); saved(); } });
    btn('清空', '清空草图', () => change([]));
    sep();
    btn('发给 Claude', '把草图发给 Claude', () => (items.length ? cb.send(items) : cb.toast('还没有画内容')), 'ppt-ask');
    btn('保留为笔迹', '把草图留在幻灯片上', () => (items.length ? cb.keep(items) : cb.toast('还没有画内容')));
    btn('取消', '退出草图（草稿会保留）', () => close(false));

    function setMode(m) { mode = m; paint(); }
    function paint() {
      Object.entries(modeBtns).forEach(([m, b]) => b.classList.toggle('on', m === mode));
      swatches.forEach((b, i) => b.classList.toggle('on', COLORS[i] === color));
      svg.dataset.mode = mode;
    }
    function render() { svg.innerHTML = items.map(itemSVG).join(''); if (cur) svg.appendChild(live); }
    function saved() { render(); cb.ls.set(key, items); }
    function change(next) { undo.push(items); items = next; saved(); }
    function position() {
      const r = slide.getBoundingClientRect(), bh = bar.offsetHeight || 36;
      cb.place(svg, { left: r.left, top: r.top, width: r.width, height: r.height });
      cb.place(bar, { left: Math.max(8, r.left), top: Math.max(56, Math.min(r.top - bh - 8, r.bottom - bh - 8)) });
      if (note) { const p = G.slideToClient(r, { x: note.p.x, y: note.p.y, w: 0, h: 0 }); cb.place(note.el, { left: p.left, top: p.top }); }
    }
    const pt = (e) => G.clientToSlide(slide.getBoundingClientRect(), e.clientX, e.clientY, e.clientX, e.clientY);
    const line = () => live.setAttribute('d', `M${cur.map(([x, y]) => `${x} ${y}`).join('L')}`);
    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const p = pt(e);
      if (mode === 'erase') { const n = hitItem(items, p.x, p.y); if (n >= 0) change(items.filter((_, k) => k !== n)); return; }
      if (mode === 'note') return openNote(p);
      svg.setPointerCapture(e.pointerId);
      cur = [[p.x, p.y]];
      for (const [k, v] of [['fill', 'none'], ['stroke', color], ['stroke-width', width], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]) live.setAttribute(k, v);
      line(); svg.appendChild(live);
    });
    svg.addEventListener('pointermove', (e) => {
      if (!cur) return;
      const p = pt(e), [lx, ly] = cur[cur.length - 1];
      if (Math.hypot(p.x - lx, p.y - ly) < 2) return;
      cur.push([p.x, p.y]); line();
    });
    const lift = () => {
      if (!cur) return;
      const pts = simplify(cur).map(([x, y]) => [n1(x), n1(y)]);
      cur = null;
      change([...items, { type: 'stroke', color, width, pts, d: smoothPath(pts) }]);
    };
    svg.addEventListener('pointerup', lift);
    svg.addEventListener('pointercancel', lift);
    function openNote(p) {
      endNote(false);
      const el = document.createElement('input'); el.className = 'ppt-abs ppt-note-input'; el.placeholder = '输入标注，Enter 确定 · Esc 放弃';
      ui.appendChild(el); note = { el, p }; position();
      el.addEventListener('keydown', (k) => {
        if (k.key === 'Enter') { k.preventDefault(); endNote(true); }
        else if (k.key === 'Escape') { k.preventDefault(); endNote(false); }
      });
      el.addEventListener('blur', () => endNote(true));
      setTimeout(() => el.focus());
    }
    function endNote(keep) {
      if (!note) return;
      const { el, p } = note, text = el.value.trim().slice(0, 200);
      note = null; el.remove();
      if (keep && text) change([...items, { type: 'note', color, x: p.x, y: p.y, text }]);
    }
    const onKey = (e) => { // capture phase: Esc leaves sketch mode, except inside the note box or the send box
      if (e.key !== 'Escape' || (note && e.target === note.el) || e.target.closest?.('.ppt-pop')) return;
      e.stopPropagation(); close(false);
    };
    document.addEventListener('keydown', onKey, true);
    addEventListener('scroll', position, { passive: true });
    addEventListener('resize', position);
    function close(discard) {
      endNote(false);
      document.removeEventListener('keydown', onKey, true);
      removeEventListener('scroll', position);
      removeEventListener('resize', position);
      svg.remove(); bar.remove();
      if (discard) cb.ls.set(key, []);
      cb.onClose();
    }
    paint(); render(); position();
    return { slide, close };
  }
```

把导出行改为：

```js
  window.PPTSketch = { COLORS, WIDTHS, esc, simplify, smoothPath, noteSize, bounds, hitItem, inkSVG, drawOnCanvas, open };
```

- [ ] **Step 4: 接入 `ppt/editor.js`**

a. `let armed = null; // shape kind waiting to be drawn` 之后加：`let sketch = null; // open sketch-mode controller (PPTSketch.open)`

b. 工具栏回调对象里 `addIcon, drawIcon,` 之后加：

```js
    sketch: () => openSketch(currentSlide()), addSketchSlide,
    inkColor(c) {
      if (!c || !isObj(selected)) return;
      rememberColor(c);
      commit({ op: 'setInkColor', target: selected.id, args: { color: c }, label: `笔迹颜色 ${c} ${selected.id}` });
    },
```

c. `function setZ(dir) {` 之前加：

```js
  // ---- sketch mode: freehand over one slide, then send it to Claude or keep it as ink ----
  function openSketch(slide) {
    if (sketch || !slide) return;
    if (editing) endEdit();
    closePop(); disarm(); select(null);
    sketch = PPTSketch.open(slide, { place, ls, toast, onClose: () => { sketch = null; closePop(); },
      send: (items) => sendSketch(slide, items), keep: (items) => keepSketch(slide, items) });
  }
  function addSketchSlide() {
    const s = currentSlide(), id = O.newId(document, 's-');
    commit({ op: 'insertSlide', args: { id, afterId: s.id }, label: `插入草图页 ${id}` });
    const n = document.getElementById(id);
    if (!n) return;
    n.scrollIntoView({ block: 'center' });
    openSketch(n);
  }
  function sendSketch(slide, items) {
    const r = PPTSketch.bounds(items, 8, true), notes = items.filter((i) => i.type === 'note').map((i) => i.text);
    openPop(slide, r, el('div', 'ppt-abs ppt-sel', ui), `第 ${slides().indexOf(slide) + 1} 页 · 草图`, async (text) => {
      sketch?.close(true);
      let shot = null;
      try { // the whole slide, sketch burnt on top: Claude needs the surroundings too
        const c = await htmlToImage.toCanvas(slide, { width: G.W, height: G.H, pixelRatio: 1, style: { zoom: '1', margin: '0' } });
        PPTSketch.drawOnCanvas(c.getContext('2d'), items, c.width / G.W);
        shot = c.toDataURL('image/png');
      } catch (err) { console.warn('[ppt] sketch screenshot failed', err); }
      enqueue({ type: 'intent', kind: 'sketch', slide: slides().indexOf(slide) + 1, slide_id: slide.id, rect: r,
                cells: G.rectToCells(r), blocks: G.hitBlocks(slide, r), text, notes, shot });
    }, '按草图修改这一页');
  }
  function keepSketch(slide, items) {
    const { geom, html } = PPTSketch.inkSVG(items);
    sketch?.close(true);
    addObj(slide, { kind: 'ink', geom, html });
  }
```

d. `KIND_ZH` 改为：`const KIND_ZH = { shape: '形状', arrow: '箭头', icon: '图标', image: '图片', ink: '笔迹' };`

e. `function openPop(slide, r, box, label, onSend) {` 改为 `function openPop(slide, r, box, label, onSend, fallback = '') {`，其中 `const text = ta.value.trim();` 改为 `const text = ta.value.trim() || fallback;`。

f. `poll()` 里 `const typing = drag || pop ||` 改为 `const typing = drag || pop || sketch ||`。

g. document `mousedown` 第一行 `if (e.button !== 0 || e.target.closest('#ppt-ui')) return;` 改为 `if (e.button !== 0 || sketch || e.target.closest('#ppt-ui')) return;`。

h. `keydown` 监听第一行之前加：`if (sketch) return; // the sketch board owns the keyboard`。

i. `dblclick` 监听里 `if (editing) return;` 改为 `if (editing || sketch) return;`。

- [ ] **Step 5: `ppt/toolbar.js`**

a. 顶栏 `const iconBtn = btn(top, '+图标', '插入图标', () => openIcons(iconBtn));` 之后加：

```js
    btn(top, '✎ 草图', '在当前页上画草图', () => cb.sketch());
    btn(top, '+草图页', '插入空白页并画草图', () => cb.addSketchSlide());
```

b. `b = mkBar('image');` 之前加：

```js
    b = mkBar('ink');
    colorBtn(b, 'A', '颜色', (c) => cb.inkColor(c));
    opacity(b);
    tail(b, true);
```

- [ ] **Step 6: `ppt/editor.css` 末尾加**

```css
.ppt-sketch { cursor: crosshair; touch-action: none; pointer-events: auto; }
.ppt-sketch[data-mode="erase"] { cursor: cell; } .ppt-sketch[data-mode="note"] { cursor: text; }
.ppt-sketchbar .on { outline: 2px solid #2563eb; outline-offset: 1px; }
.ppt-note-input { font: 20px "Microsoft YaHei", "PingFang SC", sans-serif; padding: 2px 6px; border: 1px solid #93c5fd; border-radius: 4px; background: #fff; min-width: 180px; }
```

- [ ] **Step 7: 运行，确认通过**

Run: `node tests/e2e.mjs` → Expected: `116/116 passed`（98 + 18）
Run: `python ppt/test_server.py` → `OK`；selftest → `PASS 93/93`

- [ ] **Step 8: 提交**

```bash
git add ppt/sketch.js ppt/editor.js ppt/toolbar.js ppt/editor.css tests/e2e.mjs
git commit -m "feat(sketch): sketch mode — pen, eraser, notes, undo, draft; send to Claude or keep as ink

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `ppt.md` 规则、spec 同步、真实会话验收

**Files:**
- Modify: `.claude/commands/ppt.md`
- Modify: `docs/superpowers/specs/2026-10-14-ppt-maker-sketch-design.md`（只同步实现中的取舍）

- [ ] **Step 1: `ppt.md`**

"处理事件"一节，在 `draw-icon` 那条之后加：

```markdown
- **intent 且 `kind` 为 `sketch`**：用户画了草图。用 Read 看 `shot`（整页截图，草图画在上面）：线条和框表示布局意图，箭头表示关系或流程；`notes` 是用户打的标注，以它的原文为准，不要从图里认字。不要把手绘线条原样搬进 deck，要做成正式的块、表格、形状、箭头或图标，并遵守格式规则。已有页只改 `blocks` 列出的块和对象，以及草图范围（`rect`）内需要新建的内容，除非用户的话另有说明；空白页（没有块）按草图生成整页。看不懂就在回执里问一个具体问题。
```

格式规则 10 的对象列表里，`- 图片：…` 之后加：

```markdown
    - 笔迹：`data-kind="ink"`，内含 `<svg viewBox="0 0 宽 高" preserveAspectRatio="none">` 与若干 `<path … vector-effect="non-scaling-stroke">`、`<text>`。这是用户亲手画的，不要主动修改或删除；用户对它"问 Claude"时按笔迹的意思生成正式内容，是否删除原笔迹按用户的话决定，没说就保留。
```

- [ ] **Step 2: spec 同步**

在 spec 第 6 节注明：`hitBlocks` 现在也返回对象（对象在前）；第 7 节"画笔模式中当前页被删除"一行改为"画笔模式中不刷新页面，当前页不会从 DOM 消失；退出后刷新，若该页已删除，草稿只是留在浏览器里不再被用到"。

- [ ] **Step 3: 全套测试**

Run: `python ppt/test_server.py` → `OK`（50）；selftest → `PASS 93/93`；`node tests/e2e.mjs` → `116/116 passed`

- [ ] **Step 4: 提交**

```bash
git add .claude/commands/ppt.md docs/superpowers/specs/2026-10-14-ppt-maker-sketch-design.md
git commit -m "docs(sketch): ppt.md rules for sketch intents and ink; sync spec

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: 真实会话验收（副本 deck，验完删除）**

1. 从 `ppt/template.html` 建 `decks/验收-3/deck.html`；后台启动 `python ppt/server.py "decks/验收-3" --no-open --port 8811`，Monitor 挂 `--tail`。
2. scratchpad 里写临时驱动脚本：点"+草图页"，画一个"左上标题框、右边大框、下面三个小框"的布局，加标注"标题""产品截图""优势1/2/3"，发给 Claude。
3. Claude 端按 `ppt.md` 处理该 sketch 事件：读截图与 notes，在空白页生成整页并回执。
4. 在封面页圈住副标题画一个下划线草图发给 Claude"改成强调色"，Claude 只改副标题。
5. 画一笔箭头保留为笔迹，对它"问 Claude：整理成正式箭头"，Claude 新建箭头对象并保留原笔迹。
6. 停服务和监听，确认目录后删除 `decks/验收-3`。

Expected: 页面无 JS 错误；inbox 依次有 sketch 意图（带 shot 和 notes）、edit 事件；验收 deck 已删除。
