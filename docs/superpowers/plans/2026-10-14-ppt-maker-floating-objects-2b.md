# ppt-maker 2b：浮动对象 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在页面上直接插入并编辑浮动对象——形状、箭头、图标（Lucide 内置 + 让 Claude 画）、图片（上传/粘贴/拖入），支持移动、缩放、旋转、端点、层级、样式，全部走 2a 的 op 队列与撤销。

**Architecture:** 对象是 `section.slide` 里所有块之后的 `<div class="obj" data-kind=…>`，用画布像素绝对定位。所有修改仍是 `ops.js` 里的确定性 op（`insertObj / setGeom / setArrow / setZ / ensureBase`，以及扩展后的 `setStyle / setHTML`），页面先作用于 live DOM，再作用于文件原文后 PUT。形状和箭头的 SVG 由 op 按尺寸重画；颜色、线宽写在对象 style 上（`fill / stroke / stroke-width` 由 SVG 继承）。几何计算（自由拖动、旋转坐标系里的缩放、旋转角）是 `geom.js` 里的纯函数。

**Tech Stack:** 浏览器原生 JS（无构建）、Python 3 标准库服务、Lucide 1.57.0（ISC，一次性生成 `ppt/icons.js` 并入库）、Edge/Chrome headless 测试。

**Spec:** `docs/superpowers/specs/2026-10-14-ppt-maker-basic-editing-design.md`（§2.3 op 清单、§3.4–3.5 对象格式、§4.1–4.3 交互、§6 浮动对象细节、§7 出错处理、§8 测试）

## Global Constraints

- 在分支 `feat/floating-objects-2b` 上工作；每个 task 提交，提交信息末尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- Python 只用标准库；页面不引入新的第三方运行时依赖（Lucide 只作为生成的数据文件 `ppt/icons.js`）。
- op 只携带绝对值；同一组 op 作用于两份相同文档，序列化结果必须逐字相同。
- deck 单文件离线：不引用外部网络资源；deck 里不出现 `data-ppt` 属性或 `ppt-` 开头的 class。
- 坐标是 1280×720 画布像素；`transform` 只允许 `rotate(…deg)`。
- `data-kind` ∈ `shape` / `arrow` / `icon` / `image`；对象位于所属 `section.slide` 内、所有块之后，DOM 顺序即层级。
- 新元素 id：`o-` 前缀加 6 位随机字母数字（`PPTOps.newId`）。
- 形状默认样式：填充 `#dbeafe`，线条 `#2563eb`，线宽 2；直线和箭头无填充。单击放置：160×100，箭头长 160。图标默认 64×64。图片长边不超过 480px。
- `/api/asset`：上限 10MB；按文件头只接受 PNG / JPEG / GIF / WebP，**拒绝 SVG**；保存为 `assets/<sha1 前 12 位>.<扩展名>`，相同内容复用；要求口令并经过 Host 校验。
- 测试命令（每个 task 结束都要全绿）：
  - `python ppt/test_server.py`
  - selftest：`"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --disable-gpu --dump-dom "file:///C:/Users/user/Desktop/InnovationIdea/ppt-maker/ppt/selftest.html" | grep -o 'PASS [0-9]*/[0-9]*\|FAIL [^<]*' | head`（只看 `<h1 id="result">` 那行的 `PASS n/n`；源码里的 `FAIL'}` 字样不是失败）
  - `node tests/e2e.mjs`（只使用 `decks/e2e-smoke` 与端口 8800；绝不删除其他 deck）
- Windows：在 Bash 里用 heredoc 写含 `\n` 的代码会被改成真换行；改代码用 Edit/Write 工具。

## Review Focus

1. **Claude 手写的对象缺少 `data-shape` 或 `<line>`**：用户仍能选中、移动、缩放它（只改外框，不重画 SVG），不会报"没有生效"。→ Task 1 selftest `obj setGeom without data-shape only moves the box`；Task 5 e2e `O Claude-written shape without data-shape still resizes`。
2. **形状里有文字时缩放/移动**：重画 SVG 不能丢掉 `.obj-text`。→ Task 1 selftest `obj setGeom redraws svg, keeps text, rotates`；Task 5 e2e `O shape text survives a redraw`。
3. **用户把对象拖到画布外**：不应作为 lint 发给 Claude；Claude 写到画布外的对象才上报 `obj-outside`。→ Task 5 e2e `L …` 两条。
4. **改字模式中粘贴图片**：只按纯文本粘贴，不上传、不插入图片。→ Task 6 e2e `I paste image while typing inserts nothing`。
5. **在图标搜索框里按方向键**：不能移动当前选中的对象。→ Task 6 e2e `I arrow keys in the icon search do not move the selection`。

---

### Task 1: ops.js 对象操作

**Files:**
- Modify: `ppt/ops.js`（整份替换，见 Step 3）
- Test: `ppt/selftest.html`

**Interfaces:**
- Consumes: 现有 `PPTOps.apply/newId/clampGrid/STYLE_OK`（保持不变）。
- Produces（后续 task 依赖）：
  - op `insertObj` args `{id, slideId, kind, shape?, geom?:{x,y,w,h,rot?}, ends?:{x1,y1,x2,y2}, style?:{}, html?}`——`kind:'arrow'` 用 `ends`，`kind:'shape'` 且给了 `shape` 时 SVG 由 op 生成；其余用 `html`。对象追加为 slide 最后一个子元素。
  - op `setGeom` args `{x,y,w,h,rot}`：任意 `.obj`；`data-kind="shape"` 且 `data-shape` 已知时按新尺寸重画 `:scope > svg`（保留 `.obj-text`）。
  - op `setArrow` args `{x1,y1,x2,y2}`（画布像素）：只用于 `data-kind="arrow"`，重算外框（四周留 8px）和 SVG。
  - op `setZ` args `{z:'top'|'bottom'}`：只用于 `.obj`，`bottom` 仍在所有块之后。
  - op `ensureBase`（无 target、无 args）：`#base` 缺对象规则时补上（没有 `#base` 就新建）。
  - op `setHTML` 新增 `args.text:true`：写入对象的 `.obj-text`（不存在则创建；`html` 为空则删除）。
  - op `setStyle`：目标是 `.obj` 时白名单为 `OBJ_OK`（见代码），`transform` 只接受 `rotate(…deg)`。
  - `PPTOps.hasObjBase(doc) -> boolean`，`PPTOps.OBJ_CSS`（字符串）。

- [ ] **Step 1: 写失败的测试**

在 `ppt/selftest.html` 中，`check('ops deterministic on two copies', …);` 那一行之后、`const r = document.getElementById('result');` 之前插入：

```js
  // ---- 2b: floating objects ----
  const OSRC = '<!doctype html><html><head><style id="base">.slide { }</style></head><body>\n<section class="slide" id="u1"><div class="block" id="ub" style="grid-area:1/1/3/5">b</div></section>\n</body></html>';
  const mo = () => new DOMParser().parseFromString(OSRC, 'text/html');
  const od = mo(), OB = (id) => od.getElementById(id);
  const hadBase = O.hasObjBase(od); O.apply(od, {op:'ensureBase'}); O.apply(od, {op:'ensureBase'});
  check('obj ensureBase adds the rules once', [hadBase, O.hasObjBase(od), od.getElementById('base').textContent.match(/\.obj \{/g).length], [false, true, 1]);
  const nob = new DOMParser().parseFromString('<html><head></head><body></body></html>', 'text/html'); O.apply(nob, {op:'ensureBase'});
  check('obj ensureBase creates #base when missing', O.hasObjBase(nob), true);
  check('obj insertObj shape', [O.apply(od, {op:'insertObj', args:{id:'o1', slideId:'u1', kind:'shape', shape:'rect', geom:{x:10.4, y:20, w:200, h:100}, style:{fill:'#dbeafe', 'stroke-width':'2'}}}),
    OB('o1').dataset.kind, OB('o1').dataset.shape, OB('o1').style.left, OB('o1').style.width, OB('o1').style.strokeWidth,
    OB('o1').querySelector('svg').getAttribute('viewBox'), OB('o1').querySelector('svg > rect').getAttribute('width')],
    [true, 'shape', 'rect', '10px', '200px', '2', '0 0 200 100', '200']);
  check('obj goes after the blocks (on top)', [...OB('u1').children].map((n) => n.id), ['ub', 'o1']);
  check('obj insertObj refuses dup id / unknown kind / bad style / unknown shape', [
    O.apply(od, {op:'insertObj', args:{id:'o1', slideId:'u1', kind:'icon', geom:{x:0, y:0, w:9, h:9}}}),
    O.apply(od, {op:'insertObj', args:{id:'o2', slideId:'u1', kind:'video', geom:{x:0, y:0, w:9, h:9}}}),
    O.apply(od, {op:'insertObj', args:{id:'o2', slideId:'u1', kind:'icon', geom:{x:0, y:0, w:9, h:9}, style:{position:'fixed'}}}),
    O.apply(od, {op:'insertObj', args:{id:'o2', slideId:'u1', kind:'shape', shape:'star', geom:{x:0, y:0, w:9, h:9}}})], [false, false, false, false]);
  O.apply(od, {op:'setHTML', target:'o1', args:{html:'<b>文字</b>', text:true}});
  O.apply(od, {op:'setGeom', target:'o1', args:{x:30, y:40, w:300, h:50, rot:30}});
  check('obj setGeom redraws svg, keeps text, rotates', [OB('o1').style.left, OB('o1').style.transform, OB('o1').querySelector('svg').getAttribute('viewBox'),
    OB('o1').querySelector('svg > rect').getAttribute('width'), OB('o1').querySelector(':scope > .obj-text').innerHTML, OB('o1').querySelectorAll('svg').length],
    ['30px', 'rotate(30deg)', '0 0 300 50', '300', '<b>文字</b>', 1]);
  O.apply(od, {op:'setGeom', target:'o1', args:{x:30, y:40, w:300, h:50, rot:0}});
  check('obj rot 0 drops transform', OB('o1').style.transform, '');
  O.apply(od, {op:'setHTML', target:'o1', args:{html:'', text:true}});
  check('obj empty text removes the text area', OB('o1').querySelector('.obj-text'), null);
  check('obj setHTML text needs an object', O.apply(od, {op:'setHTML', target:'ub', args:{html:'x', text:true}}), false);
  O.apply(od, {op:'insertObj', args:{id:'a1', slideId:'u1', kind:'arrow', shape:'arrow', ends:{x1:100, y1:100, x2:300, y2:100}, style:{stroke:'#2563eb'}}});
  const lineOf = (id) => [...OB(id).querySelector('line').attributes].map((x) => `${x.name}=${x.value}`).join(' ');
  check('obj arrow box pads the endpoints', [OB('a1').style.left, OB('a1').style.top, OB('a1').style.width, OB('a1').style.height, lineOf('a1'), OB('a1').querySelectorAll('polyline').length],
    ['92px', '92px', '216px', '16px', 'x1=8 y1=8 x2=208 y2=8', 1]);
  O.apply(od, {op:'setArrow', target:'a1', args:{x1:100, y1:300, x2:300, y2:100}});
  check('obj setArrow redraws', [OB('a1').style.height, OB('a1').querySelector('svg').getAttribute('viewBox'), lineOf('a1')], ['216px', '0 0 216 216', 'x1=8 y1=208 x2=208 y2=8']);
  check('obj setArrow needs an arrow', O.apply(od, {op:'setArrow', target:'o1', args:{x1:0, y1:0, x2:1, y2:1}}), false);
  ['line', 'arrow2'].forEach((s, i) => O.apply(od, {op:'insertObj', args:{id:`l${i}`, slideId:'u1', kind:'arrow', shape:s, ends:{x1:0, y1:0, x2:50, y2:0}}}));
  check('obj line has no head, double arrow two', [OB('l0').querySelectorAll('polyline').length, OB('l1').querySelectorAll('polyline').length], [0, 2]);
  check('obj style whitelist', [O.apply(od, {op:'setStyle', target:'o1', args:{style:{fill:'#ef4444', transform:'rotate(15deg)', opacity:'0.5'}}}),
    O.apply(od, {op:'setStyle', target:'o1', args:{style:{transform:'scale(3)'}}}),
    O.apply(od, {op:'setStyle', target:'ub', args:{style:{left:'5px'}}}),
    O.apply(od, {op:'setStyle', target:'o1', args:{style:{'grid-area':'1/1/2/2'}}})], [true, false, false, false]);
  const zorder = () => [...OB('u1').children].map((n) => n.id).join();
  O.apply(od, {op:'setZ', target:'o1', args:{z:'top'}}); const z1 = zorder();
  O.apply(od, {op:'setZ', target:'o1', args:{z:'bottom'}});
  check('obj setZ top / bottom stays above blocks', [z1, zorder(), O.apply(od, {op:'setZ', target:'ub', args:{z:'top'}})], ['ub,a1,l0,l1,o1', 'ub,o1,a1,l0,l1', false]);
  O.apply(od, {op:'insertObj', args:{id:'f1', slideId:'u1', kind:'shape', geom:{x:0, y:0, w:10, h:10}, html:'<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg>'}});
  O.apply(od, {op:'setGeom', target:'f1', args:{x:5, y:5, w:40, h:20}});
  check('obj setGeom without data-shape only moves the box', [OB('f1').style.width, OB('f1').querySelector('svg').getAttribute('viewBox')], ['40px', '0 0 10 10']);
  check('obj setGeom needs an object', O.apply(od, {op:'setGeom', target:'ub', args:{x:0, y:0, w:9, h:9}}), false);
  const OSEQ = [
    {op:'ensureBase'},
    {op:'insertObj', args:{id:'q1', slideId:'u1', kind:'shape', shape:'ellipse', geom:{x:1, y:2, w:30, h:20}, style:{fill:'#dbeafe'}}},
    {op:'setGeom', target:'q1', args:{x:5, y:6, w:50, h:40, rot:-45}},
    {op:'setHTML', target:'q1', args:{html:'字', text:true}},
    {op:'insertObj', args:{id:'q2', slideId:'u1', kind:'arrow', shape:'arrow2', ends:{x1:10, y1:10, x2:90, y2:70}}},
    {op:'setArrow', target:'q2', args:{x1:15, y1:10, x2:90, y2:75}},
    {op:'setStyle', target:'q2', args:{style:{stroke:'#ef4444', 'stroke-width':'4'}}},
    {op:'setZ', target:'q1', args:{z:'top'}},
    {op:'remove', target:'ub'},
  ];
  const od1 = mo(), od2 = mo();
  OSEQ.forEach((op) => { O.apply(od1, op); O.apply(od2, op); });
  check('obj ops deterministic on two copies', ser(od1) === ser(od2) && ser(od1) !== ser(mo()), true);
```

- [ ] **Step 2: 运行，确认失败**

Run: 上面 Global Constraints 里的 selftest 命令
Expected: `FAIL …`（`O.hasObjBase is not a function` 让脚本中断时，结果行停在 `running…`——同样算失败；先确认原因是缺函数，不是拼写错误）

- [ ] **Step 3: 实现——整份替换 `ppt/ops.js`**

```js
// ppt-maker ops: every direct edit is {op, target, args, label}. apply() runs one on any Document.
// The page applies an op to the live DOM (instant feedback) and again to the parsed file text when
// saving, so ops must be deterministic and carry absolute values only ("move to 3/2/6/9", never "one cell right").
(() => {
  const STYLE_OK = new Set(['grid-area', 'background', 'border', 'border-radius', 'box-shadow', 'text-align',
    'color', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'opacity']);
  // floating objects sit at free canvas positions; fill/stroke/stroke-width reach their SVG through inheritance
  const OBJ_OK = new Set([...STYLE_OK, 'left', 'top', 'width', 'height', 'transform', 'z-index', 'fill', 'stroke', 'stroke-width']);
  OBJ_OK.delete('grid-area');
  const ROTATE = /^rotate\(-?\d+(\.\d+)?deg\)$/;
  const KINDS = new Set(['shape', 'arrow', 'icon', 'image']);
  const DEEP = new Set(['color', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'text-align']);
  // tags whose own default (bold headings, italic <em>, underlined links) would ignore an inherited block value
  const TAGS = { 'font-weight': 'h1,h2,h3,h4,h5,h6,b,strong,th', 'font-style': 'i,em', 'text-decoration': 'u,ins,a' };
  const OBJ_CSS = [
    '.obj { position:absolute; box-sizing:border-box; }',
    '.obj > svg, .obj > img { display:block; width:100%; height:100%; overflow:visible; }',
    '.obj > img { object-fit:cover; border-radius:inherit; }',
    '.obj-text { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; text-align:center; padding:8px; }',
  ].map((l) => `  ${l}\n`).join('');
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const n1 = (v) => Math.round(v * 10) / 10;

  function clampGrid(g) {
    const [r1, c1, r2, c2] = String(g).split('/').map((s) => parseInt(s, 10));
    const R1 = clamp(r1 || 1, 1, 9), C1 = clamp(c1 || 1, 1, 16);
    return `${R1} / ${C1} / ${clamp(r2 || R1 + 1, R1 + 1, 10)} / ${clamp(c2 || C1 + 1, C1 + 1, 17)}`;
  }
  function dropEmptyStyle(n) { if (!n.getAttribute('style')) n.removeAttribute('style'); }
  const allowed = (set, style) => Object.entries(style).every(([k, v]) => set.has(k) && (k !== 'transform' || v == null || v === '' || ROTATE.test(v)));
  const isObj = (t) => !!t && t.classList.contains('obj');

  // ---- floating objects: geometry and generated SVG ----
  function normGeom(g) {
    const r = Math.round(+g.rot || 0);
    return { x: Math.round(+g.x || 0), y: Math.round(+g.y || 0), w: Math.max(1, Math.round(+g.w || 0)),
             h: Math.max(1, Math.round(+g.h || 0)), rot: ((r % 360) + 540) % 360 - 180 };
  }
  function putGeom(t, g) {
    t.style.left = `${g.x}px`; t.style.top = `${g.y}px`; t.style.width = `${g.w}px`; t.style.height = `${g.h}px`;
    if (g.rot) t.style.transform = `rotate(${g.rot}deg)`; else t.style.removeProperty('transform');
  }
  function putSvg(doc, t, html) { // replace only the drawing: a shape's text area stays
    const tmp = doc.createElement('div'); tmp.innerHTML = html;
    const old = t.querySelector(':scope > svg');
    if (old) old.replaceWith(tmp.firstChild); else t.prepend(tmp.firstChild);
  }
  // viewBox = the object's own pixel size, so a stroke is never stretched; redrawn on every resize
  function shapeSVG(shape, w, h) {
    const body = {
      rect: `<rect width="${w}" height="${h}"/>`,
      round: `<rect width="${w}" height="${h}" rx="${n1(Math.min(w, h) * 0.15)}"/>`,
      ellipse: `<ellipse cx="${n1(w / 2)}" cy="${n1(h / 2)}" rx="${n1(w / 2)}" ry="${n1(h / 2)}"/>`,
      triangle: `<polygon points="${n1(w / 2)},0 ${w},${h} 0,${h}"/>`,
    }[shape];
    return body && `<svg viewBox="0 0 ${w} ${h}">${body}</svg>`;
  }
  const PAD = 8, HEAD = 14;
  const roundEnds = (a) => ({ x1: Math.round(+a.x1 || 0), y1: Math.round(+a.y1 || 0), x2: Math.round(+a.x2 || 0), y2: Math.round(+a.y2 || 0) });
  function arrowParts(shape, e) { // canvas-px endpoints -> padded box + SVG (line, optional chevron heads)
    const x = Math.min(e.x1, e.x2) - PAD, y = Math.min(e.y1, e.y2) - PAD;
    const w = Math.abs(e.x2 - e.x1) + 2 * PAD, h = Math.abs(e.y2 - e.y1) + 2 * PAD;
    const a = [e.x1 - x, e.y1 - y], b = [e.x2 - x, e.y2 - y];
    const head = ([px, py], [qx, qy]) => { // chevron at q pointing away from p; stroke only, so it takes the line colour
      const t = Math.atan2(qy - py, qx - px), p = (s) => `${n1(qx - HEAD * Math.cos(t + s))},${n1(qy - HEAD * Math.sin(t + s))}`;
      return `<polyline points="${p(0.5)} ${qx},${qy} ${p(-0.5)}" fill="none"/>`;
    };
    const heads = (shape === 'arrow' || shape === 'arrow2' ? head(a, b) : '') + (shape === 'arrow2' ? head(b, a) : '');
    return { geom: { x, y, w, h, rot: 0 },
             html: `<svg viewBox="0 0 ${w} ${h}" stroke-linecap="round" stroke-linejoin="round"><line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/>${heads}</svg>` };
  }
  const hasObjBase = (doc) => /\.obj\s*\{/.test(doc.getElementById('base')?.textContent || '');

  const OPS = {
    setHTML(doc, t, a) {
      if (!a.text) { t.innerHTML = a.html; return; }
      if (!isObj(t)) return false;
      let x = t.querySelector(':scope > .obj-text');
      if (!a.html) { x?.remove(); return; }
      if (!x) { x = doc.createElement('div'); x.className = 'obj-text'; t.append(x); }
      x.innerHTML = a.html;
    },
    setStyle(doc, t, a) {
      const style = a.style || {};
      if (!allowed(isObj(t) ? OBJ_OK : STYLE_OK, style)) return false;
      for (const [k, v] of Object.entries(style)) {
        if (v == null || v === '') t.style.removeProperty(k); else t.style.setProperty(k, v);
        // a whole-block text style must win over values inner elements carry themselves
        if (a.deep && DEEP.has(k)) {
          t.querySelectorAll('[style]').forEach((n) => { n.style.removeProperty(k); dropEmptyStyle(n); });
          if (TAGS[k] && v != null && v !== '') t.querySelectorAll(TAGS[k]).forEach((n) => n.style.setProperty(k, 'inherit'));
        }
      }
      dropEmptyStyle(t);
    },
    setGrid(doc, t, a) { t.style.gridArea = clampGrid(a.grid); },
    insertBlock(doc, _, a) {
      const s = doc.getElementById(a.slideId);
      if (!s || !a.id || doc.getElementById(a.id)) return false;
      const b = doc.createElement('div');
      b.className = 'block'; b.id = a.id; b.style.gridArea = clampGrid(a.grid); b.innerHTML = a.html || '';
      const ref = s.querySelector(':scope > .obj'); // blocks stay below floating objects
      s.insertBefore(doc.createTextNode('\n  '), ref);
      s.insertBefore(b, ref);
    },
    remove(doc, t) { t.remove(); },
    insertSlide(doc, _, a) {
      const after = doc.getElementById(a.afterId);
      if (!after || !a.id || doc.getElementById(a.id)) return false;
      const s = doc.createElement('section');
      s.className = 'slide'; s.id = a.id; s.innerHTML = a.html || '';
      after.after(doc.createTextNode('\n'), s);
    },
    removeSlide(doc, t) {
      if (doc.querySelectorAll('section.slide').length < 2) return false;
      t.remove();
    },
    insertObj(doc, _, a) {
      const s = doc.getElementById(a.slideId);
      if (!s || !a.id || doc.getElementById(a.id) || !KINDS.has(a.kind) || !allowed(OBJ_OK, a.style || {})) return false;
      let g = normGeom(a.geom || {}), html = a.html || '';
      if (a.kind === 'arrow') ({ geom: g, html } = arrowParts(a.shape, roundEnds(a.ends || {})));
      else if (a.kind === 'shape' && a.shape && !(html = shapeSVG(a.shape, g.w, g.h))) return false;
      const o = doc.createElement('div');
      o.className = 'obj'; o.id = a.id; o.dataset.kind = a.kind;
      if (a.shape) o.dataset.shape = a.shape;
      putGeom(o, g);
      for (const [k, v] of Object.entries(a.style || {})) if (v != null && v !== '') o.style.setProperty(k, v);
      o.innerHTML = html;
      s.append(doc.createTextNode('\n  '), o); // last child = top of the stack
    },
    setGeom(doc, t, a) {
      if (!isObj(t)) return false;
      const g = normGeom(a), svg = t.dataset.kind === 'shape' && shapeSVG(t.dataset.shape, g.w, g.h);
      if (svg) putSvg(doc, t, svg); // unknown or missing data-shape (Claude's own drawing): just move the box
      putGeom(t, g);
    },
    setArrow(doc, t, a) {
      if (!isObj(t) || t.dataset.kind !== 'arrow') return false;
      const { geom, html } = arrowParts(t.dataset.shape, roundEnds(a));
      putSvg(doc, t, html);
      putGeom(t, geom);
    },
    setZ(doc, t, a) {
      if (!isObj(t) || !['top', 'bottom'].includes(a.z)) return false;
      const s = t.parentElement;
      if (a.z === 'top') s.append(t); else s.querySelector(':scope > .obj').before(t);
    },
    ensureBase(doc) {
      if (hasObjBase(doc)) return;
      let b = doc.getElementById('base');
      if (!b) { b = doc.createElement('style'); b.id = 'base'; doc.head.append(b); }
      b.textContent += `\n${OBJ_CSS}`;
    },
  };

  function apply(doc, op) {
    const fn = OPS[op && op.op];
    if (!fn) return false;
    const t = op.target ? doc.getElementById(op.target) : null;
    if (op.target && !t) return false;
    return fn(doc, t, op.args || {}) !== false;
  }

  function newId(doc, prefix) {
    let id;
    do { id = prefix + Math.random().toString(36).slice(2, 8).padEnd(6, '0'); } while (doc.getElementById(id));
    return id;
  }

  window.PPTOps = { apply, newId, clampGrid, hasObjBase, STYLE_OK, OBJ_OK, OBJ_CSS };
})();
```

- [ ] **Step 4: 运行 selftest，确认通过**

Run: selftest 命令
Expected: `PASS 55/55`（原 37 条 + 新 18 条）。若某条期望值与 Chrome 的序列化细节不符（例如 `strokeWidth` 读回 `'2px'`），先确认 op 行为本身正确，再改期望值并在 ledger 记 Ruling。

- [ ] **Step 5: 跑另外两套测试，确认没有回归**

Run: `python ppt/test_server.py` → Expected: `OK`；`node tests/e2e.mjs` → Expected: `61/61 passed`

- [ ] **Step 6: 提交**

```bash
git add ppt/ops.js ppt/selftest.html
git commit -m "feat(2b): object ops — insertObj, setGeom, setArrow, setZ, ensureBase, shape text

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: geom.js 对象几何与 lint

**Files:**
- Modify: `ppt/geom.js`
- Test: `ppt/selftest.html`

**Interfaces:**
- Consumes: 无（纯函数；`lint` 读 DOM）。
- Produces：
  - `PPTGeom.geomOf(obj) -> {x,y,w,h,rot}`（画布像素；内联尺寸缺失时按布局推算）
  - `PPTGeom.arrowEnds(obj) -> {x1,y1,x2,y2} | null`（只有 `data-kind="arrow"` 且有 `:scope > svg > line` 时非 null）
  - `PPTGeom.dragGeom(g, dx, dy, handle, shift) -> {x,y,w,h,rot}`：`handle` ∈ `move` 或 `nw n ne e se s sw w`；dx/dy 为画布像素；缩放在对象自身（旋转后）的坐标系中进行，最小 8px；`shift`：move 锁定较大方向的轴，角手柄保持比例。
  - `PPTGeom.rotateTo(g, px, py, shift) -> g'`：按指针相对中心的角度设 `rot`（指针在正上方 = 0°），`shift` 吸附 15°。
  - `lint` 新增对象问题：`missing-id`、`duplicate-id`、`obj-geometry`（left/top/width/height 有一项不是内联 px 值）、`obj-outside`（任一边超出画布 16px 以上）。issue 字段沿用 `block`。

- [ ] **Step 1: 写失败的测试**

`ppt/selftest.html` 的 `<style>` 里加两行（放在 `.block.grid` 那行后面）：

```css
  .slide { position:relative; }
  .obj { position:absolute; box-sizing:border-box; }
```

在 `</section>`（s2 那页）之后、`<script src="geom.js">` 之前加一页：

```html
<section class="slide" id="s3">
  <div class="obj" id="g1" data-kind="arrow" style="left:92px;top:92px;width:216px;height:16px;transform:rotate(30deg)"><svg viewBox="0 0 216 16"><line x1="8" y1="8" x2="208" y2="8"/></svg></div>
  <div class="obj" id="g2" data-kind="shape" style="left:10px;top:10px">no size</div>
  <div class="obj" id="g3" data-kind="icon" style="left:1300px;top:10px;width:64px;height:64px"></div>
  <div class="obj" data-kind="icon" style="left:0px;top:0px;width:8px;height:8px"></div>
  <div class="obj" id="g4" data-kind="image" style="left:-10px;top:700px;width:100px;height:30px"></div>
</section>
```

在 `check('gridOf negative lines use layout', …);` 之后插入：

```js
  // ---- 2b: floating object geometry ----
  check('geomOf reads inline px + rotation', G.geomOf(document.getElementById('g1')), {x:92,y:92,w:216,h:16,rot:30});
  check('arrowEnds of an arrow / of an icon', [G.arrowEnds(document.getElementById('g1')), G.arrowEnds(document.getElementById('g3'))], [{x1:100,y1:100,x2:300,y2:100}, null]);
  const og = {x:100, y:100, w:100, h:50, rot:0};
  check('dragGeom move free', G.dragGeom(og, 13, -7, 'move'), {x:113,y:93,w:100,h:50,rot:0});
  check('dragGeom move Shift locks to the larger axis', G.dragGeom(og, 30, 10, 'move', true), {x:130,y:100,w:100,h:50,rot:0});
  check('dragGeom e', G.dragGeom(og, 20, 99, 'e'), {x:100,y:100,w:120,h:50,rot:0});
  check('dragGeom w keeps the right edge', G.dragGeom(og, 20, 0, 'w'), {x:120,y:100,w:80,h:50,rot:0});
  check('dragGeom min size 8', G.dragGeom(og, -500, 0, 'e'), {x:100,y:100,w:8,h:50,rot:0});
  check('dragGeom Shift corner keeps ratio', G.dragGeom(og, 50, 0, 'se', true), {x:100,y:100,w:150,h:75,rot:0});
  check('dragGeom rotated 90: e follows the rotated axis', G.dragGeom({...og, rot:90}, 0, 20, 'e'), {x:90,y:110,w:120,h:50,rot:90});
  check('rotateTo pointer right = 90', G.rotateTo(og, 300, 125), {...og, rot:90});
  check('rotateTo pointer above = 0', G.rotateTo(og, 150, 0), {...og, rot:0});
  const a40 = -40 * Math.PI / 180;
  check('rotateTo Shift snaps to 15', G.rotateTo(og, 150 + 100 * Math.cos(a40), 125 + 100 * Math.sin(a40), true), {...og, rot:45});
  check('lint objects', G.lint(document.getElementById('s3')).map((i) => `${i.kind}:${i.block}`).sort(), ['missing-id:null', 'obj-geometry:g2', 'obj-outside:g3']);
```

- [ ] **Step 2: 运行，确认失败**

Run: selftest 命令
Expected: 结果行不是 `PASS`（`G.geomOf is not a function`）

- [ ] **Step 3: 实现**

在 `ppt/geom.js` 的 `const gridStr = …;` 之后加：

```js
  function geomOf(o) { // floating object box in canvas px; derived from layout when Claude left a size out
    const s = o.style, m = /rotate\((-?[\d.]+)deg\)/.exec(s.transform || ''), rot = m ? +m[1] : 0;
    if (![s.left, s.top, s.width, s.height].every((v) => /px$/.test(v))) return { ...elementRect(o.closest('section.slide').getBoundingClientRect(), o), rot };
    return { x: parseFloat(s.left), y: parseFloat(s.top), w: parseFloat(s.width), h: parseFloat(s.height), rot };
  }

  function arrowEnds(o) { // canvas-px endpoints; null when the arrow has no <line> (then it is handled like any box)
    const l = o.dataset.kind === 'arrow' && o.querySelector(':scope > svg > line');
    if (!l) return null;
    const g = geomOf(o), a = (n) => parseFloat(l.getAttribute(n)) || 0;
    return { x1: g.x + a('x1'), y1: g.y + a('y1'), x2: g.x + a('x2'), y2: g.y + a('y2') };
  }

  function dragGeom(g, dx, dy, handle, shift) { // free (no grid); a resize works in the object's own rotated axes
    if (handle === 'move') {
      if (shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      return { ...g, x: Math.round(g.x + dx), y: Math.round(g.y + dy) };
    }
    const MIN = 8, t = g.rot * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
    const lx = dx * c + dy * s, ly = -dx * s + dy * c; // pointer delta in the object's own axes
    let L = 0, T = 0, R = g.w, B = g.h;
    if (handle.includes('w')) L += lx;
    if (handle.includes('e')) R += lx;
    if (handle.includes('n')) T += ly;
    if (handle.includes('s')) B += ly;
    if (shift && handle.length === 2 && g.w && g.h) { // corner + Shift: keep the aspect ratio, anchored at the opposite corner
      const k = Math.max(MIN / Math.min(g.w, g.h), (R - L) / g.w, (B - T) / g.h);
      if (handle.includes('w')) L = R - g.w * k; else R = L + g.w * k;
      if (handle.includes('n')) T = B - g.h * k; else B = T + g.h * k;
    }
    if (R - L < MIN) { if (handle.includes('w')) L = R - MIN; else R = L + MIN; }
    if (B - T < MIN) { if (handle.includes('n')) T = B - MIN; else B = T + MIN; }
    const w = R - L, h = B - T, mx = (L + R - g.w) / 2, my = (T + B - g.h) / 2; // centre shift, own axes
    const cx = g.x + g.w / 2 + mx * c - my * s, cy = g.y + g.h / 2 + mx * s + my * c;
    return { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w: Math.round(w), h: Math.round(h), rot: g.rot };
  }

  function rotateTo(g, px, py, shift) { // the rotate handle sits above the top edge: pointer straight up = 0deg
    let d = Math.atan2(py - (g.y + g.h / 2), px - (g.x + g.w / 2)) * 180 / Math.PI + 90;
    if (shift) d = Math.round(d / 15) * 15;
    return { ...g, rot: Math.round(((d % 360) + 540) % 360 - 180) };
  }
```

在 `lint` 里，`// overlap only among siblings` 那段循环之后、`return out;` 之前加：

```js
    for (const o of slide.querySelectorAll('.obj')) { // floating objects never count as overlapping blocks
      if (!o.id) { out.push({ kind: 'missing-id', block: null, slide_id: sid }); continue; }
      if (doc.querySelectorAll('#' + CSS.escape(o.id)).length > 1) out.push({ kind: 'duplicate-id', block: o.id, slide_id: sid });
      const s = o.style;
      if (![s.left, s.top, s.width, s.height].every((v) => /px$/.test(v))) { out.push({ kind: 'obj-geometry', block: o.id, slide_id: sid }); continue; }
      const g = geomOf(o), M = 16;
      if (g.x < -M || g.y < -M || g.x + g.w > W + M || g.y + g.h > H + M) out.push({ kind: 'obj-outside', block: o.id, slide_id: sid });
    }
```

把最后的导出行改为：

```js
  window.PPTGeom = { W, H, COLS, ROWS, clientToSlide, elementRect, slideToClient, rectToCells, hitBlocks, lint, gridOf, dragGrid, gridStr,
                     geomOf, arrowEnds, dragGeom, rotateTo };
```

- [ ] **Step 4: 运行 selftest，确认通过**

Run: selftest 命令
Expected: `PASS 68/68`

- [ ] **Step 5: 回归**

Run: `python ppt/test_server.py` → `OK`；`node tests/e2e.mjs` → `61/61 passed`

- [ ] **Step 6: 提交**

```bash
git add ppt/geom.js ppt/selftest.html
git commit -m "feat(2b): free-object geometry (rotated resize, rotate, arrow ends) and object lint

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Lucide 图标库、中文对照表、搜索

**Files:**
- Create: `tools/build_icons.py`
- Create（生成并入库）: `ppt/icons.js`、`ppt/vendor/LICENSE-lucide`
- Create: `ppt/icons-zh.js`
- Modify: `ppt/toolbar.js`（加 `searchIcons` 并导出）
- Test: `ppt/test_server.py`、`ppt/selftest.html`

**Interfaces:**
- Produces：
  - `window.PPTIcons = {name: {tags: "空格分隔的英文标签", body: "<path …/>…"}}`（`body` 是 `<svg>` 内部的标记）
  - `window.PPTIconsZh = {中文词: "空格分隔的 Lucide 图标名"}`
  - `PPTToolbar.searchIcons(icons, zh, q, limit = 120) -> string[]`：`q` 为空时返回对照表里出现的图标（作为"常用"）；否则先返回中文对照命中的，再返回名称或标签包含 `q`（小写）的。
  - `build_icons.build(pkg, out_js, out_license) -> int`（图标个数）

- [ ] **Step 1: 写失败的测试**

`ppt/test_server.py` 顶部 `import server` 之后加：

```python
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import build_icons
```

在 `class CliTests` 之前加：

```python
class BuildIconsTests(unittest.TestCase):
    def test_build_from_package(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        pkg = tmp / "package"
        (pkg / "icons").mkdir(parents=True)
        (pkg / "icons" / "house.svg").write_text(
            '<!-- @license lucide-static v9.9.9 - ISC -->\n<svg\n  class="lucide lucide-house"\n  viewBox="0 0 24 24"\n>\n'
            '  <path d="M3 10a2 2 0 0 1 1 1" />\n  <circle cx="12" cy="12" r="3" />\n</svg>\n', encoding="utf-8")
        (pkg / "icons" / "no-tags.svg").write_text('<svg viewBox="0 0 24 24"><path d="M1 1h2"/></svg>', encoding="utf-8")
        (pkg / "tags.json").write_text('{"house": ["home", "living"]}', encoding="utf-8")
        (pkg / "package.json").write_text('{"version": "9.9.9"}', encoding="utf-8")
        (pkg / "LICENSE").write_text("ISC License", encoding="utf-8")
        self.assertEqual(build_icons.build(pkg, tmp / "icons.js", tmp / "LICENSE-lucide"), 2)
        js = (tmp / "icons.js").read_text(encoding="utf-8")
        self.assertIn("lucide-static 9.9.9", js.splitlines()[0])
        data = json.loads(js.split("window.PPTIcons = ", 1)[1].strip().rstrip(";"))
        self.assertEqual(data["house"], {"tags": "home living", "body": '<path d="M3 10a2 2 0 0 1 1 1"/><circle cx="12" cy="12" r="3"/>'})
        self.assertEqual(data["no-tags"]["tags"], "")
        self.assertEqual((tmp / "LICENSE-lucide").read_text(encoding="utf-8"), "ISC License")
```

`ppt/selftest.html`：在 `<script src="ops.js"></script>` 之后加：

```html
<script src="icons.js"></script>
<script src="icons-zh.js"></script>
<script src="toolbar.js"></script>
```

在 `// ---- 2b: floating objects ----` 之前插入：

```js
  // ---- 2b: icons ----
  const I = window.PPTIcons || {}, Z = window.PPTIconsZh || {}, S = window.PPTToolbar?.searchIcons;
  check('icons library loaded', Object.keys(I).length > 1500, true);
  check('every zh word maps to real icons', Object.entries(Z).flatMap(([k, v]) => v.split(' ').filter((n) => !I[n]).map((n) => `${k}:${n}`)), []);
  check('zh table has ~150 words', Object.keys(Z).length >= 150, true);
  check('search 房子 -> house first', S && S(I, Z, '房子')[0], 'house');
  check('search english name / tag', S && [S(I, Z, 'arrow-right').includes('arrow-right'), S(I, Z, 'home').includes('house')], [true, true]);
  check('search empty = common icons, all real', S && (() => { const r = S(I, Z, ''); return r.length > 50 && r.length <= 120 && r.every((n) => I[n]); })(), true);
  check('search nonsense = nothing', S && S(I, Z, 'zzqqxx'), []);
```

- [ ] **Step 2: 运行，确认失败**

Run: `python ppt/test_server.py`
Expected: `ModuleNotFoundError: No module named 'build_icons'`
Run: selftest 命令
Expected: 结果行不是 `PASS`（`icons library loaded` 等 FAIL）

- [ ] **Step 3: 写 `tools/build_icons.py`**

```python
#!/usr/bin/env python3
"""Build ppt/icons.js from a lucide-static package (stdlib only).

  npm pack lucide-static@1.57.0 && tar -xzf lucide-static-1.57.0.tgz      (gives ./package)
  python tools/build_icons.py package
"""
import json, re, shutil, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def body(svg):
    """Markup inside <svg>…</svg>, whitespace collapsed."""
    inner = re.search(r"<svg[^>]*>(.*)</svg>", svg, re.S).group(1)
    return re.sub(r">\s+<", "><", " ".join(inner.split())).replace(" />", "/>").strip()


def build(pkg, out_js=ROOT / "ppt" / "icons.js", out_license=ROOT / "ppt" / "vendor" / "LICENSE-lucide"):
    pkg = Path(pkg)
    tags = json.loads((pkg / "tags.json").read_text(encoding="utf-8"))
    version = json.loads((pkg / "package.json").read_text(encoding="utf-8")).get("version", "?")
    icons = {f.stem: {"tags": " ".join(tags.get(f.stem, [])), "body": body(f.read_text(encoding="utf-8"))}
             for f in sorted((pkg / "icons").glob("*.svg"))}
    Path(out_js).write_text(
        f"// generated by tools/build_icons.py from lucide-static {version} (ISC, see vendor/LICENSE-lucide)\n"
        f"window.PPTIcons = {json.dumps(icons, ensure_ascii=False, separators=(',', ':'))};\n", encoding="utf-8")
    shutil.copy(pkg / "LICENSE", out_license)
    return len(icons)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    print(f"{build(sys.argv[1])} icons -> ppt/icons.js")
```

- [ ] **Step 4: 生成 `ppt/icons.js`**

在仓库外的临时目录（例如 scratchpad 下新建空目录 `lucide`）里：

```bash
cd "<scratchpad>/lucide" && npm pack lucide-static@1.57.0 && tar -xzf lucide-static-1.57.0.tgz
cd "C:/Users/user/Desktop/InnovationIdea/ppt-maker" && python tools/build_icons.py "<scratchpad>/lucide/package"
```

Expected: `2154 icons -> ppt/icons.js`；`ppt/icons.js` 约 0.9MB；`ppt/vendor/LICENSE-lucide` 首行 `ISC License`。

- [ ] **Step 5: 写 `ppt/icons-zh.js`**

```js
// ppt-maker: Chinese search words -> Lucide icon names (space separated). Empty search shows these as "常用".
window.PPTIconsZh = {
  '家': 'house', '房子': 'house', '首页': 'house', '用户': 'user', '人': 'user', '个人': 'user', '团队': 'users', '客户': 'users',
  '社区': 'users-round', '新用户': 'user-plus', '公司': 'building building-2', '大楼': 'building-2', '电话': 'phone', '邮件': 'mail',
  '邮箱': 'mail', '日历': 'calendar', '日期': 'calendar', '时间': 'clock', '时钟': 'clock', '地点': 'map-pin', '位置': 'map-pin',
  '地图': 'map', '全球': 'globe', '国际': 'globe', '网络': 'globe wifi', '星': 'star', '收藏': 'star', '心': 'heart',
  '喜欢': 'heart thumbs-up', '点赞': 'thumbs-up', '对': 'check circle-check', '完成': 'circle-check check', '勾': 'check',
  '错': 'x circle-x', '关闭': 'x', '警告': 'triangle-alert', '风险': 'triangle-alert', '信息': 'info', '问题': 'circle-help',
  '帮助': 'circle-help', '想法': 'lightbulb', '创意': 'lightbulb sparkles', '灯泡': 'lightbulb', '创新': 'lightbulb rocket',
  '火箭': 'rocket', '启动': 'rocket', '增长': 'trending-up rocket', '目标': 'target', '旗帜': 'flag', '里程碑': 'flag',
  '奖杯': 'trophy', '冠军': 'trophy', '奖励': 'award gift', '礼物': 'gift', '购物': 'shopping-cart', '购物车': 'shopping-cart',
  '支付': 'credit-card wallet', '银行卡': 'credit-card', '钱包': 'wallet', '钱': 'dollar-sign banknote coins', '收入': 'banknote dollar-sign',
  '成本': 'coins', '金币': 'coins', '储蓄': 'piggy-bank', '图表': 'chart-bar chart-column chart-pie chart-line',
  '柱状图': 'chart-column chart-bar', '饼图': 'chart-pie', '折线图': 'chart-line', '上升': 'trending-up', '下降': 'trending-down',
  '数据': 'database chart-bar', '数据库': 'database', '服务器': 'server', '云': 'cloud', '芯片': 'cpu', '电脑': 'laptop monitor',
  '屏幕': 'monitor', '手机': 'smartphone', '无线': 'wifi', '安全': 'shield lock', '锁': 'lock', '盾': 'shield', '钥匙': 'key',
  '设置': 'settings', '工具': 'wrench', '维修': 'wrench', '搜索': 'search', '文件': 'file file-text', '文档': 'file-text',
  '文件夹': 'folder', '书': 'book book-open', '学习': 'book-open graduation-cap', '教育': 'graduation-cap school', '编辑': 'pencil',
  '笔': 'pencil', '图片': 'image', '照片': 'camera image', '相机': 'camera', '视频': 'video', '音乐': 'music', '麦克风': 'mic',
  '语音': 'mic', '消息': 'message-circle message-square', '聊天': 'message-circle', '发送': 'send', '分享': 'share-2 share',
  '链接': 'link', '下载': 'download', '上传': 'upload', '箭头': 'arrow-right arrow-left arrow-up arrow-down', '向右': 'arrow-right',
  '向左': 'arrow-left', '向上': 'arrow-up', '向下': 'arrow-down', '刷新': 'refresh-cw', '循环': 'repeat refresh-cw recycle',
  '播放': 'play', '暂停': 'pause', '加': 'plus', '减': 'minus', '太阳': 'sun', '月亮': 'moon', '夜晚': 'moon', '叶子': 'leaf',
  '环保': 'leaf recycle', '树': 'tree-pine', '花': 'flower', '水': 'droplet', '火': 'flame', '热门': 'flame', '闪电': 'zap',
  '能源': 'zap battery plug', '快速': 'zap', '汽车': 'car', '飞机': 'plane', '旅行': 'plane compass', '火车': 'train-front',
  '船': 'ship', '自行车': 'bike', '物流': 'truck package', '卡车': 'truck', '包裹': 'package', '盒子': 'box', '产品': 'package box',
  '工厂': 'factory', '制造': 'factory', '医院': 'hospital', '医疗': 'stethoscope hospital', '药': 'pill', '健康': 'activity heart',
  '大脑': 'brain', '智能': 'brain bot sparkles', '人工智能': 'bot sparkles brain', '机器人': 'bot', '拼图': 'puzzle',
  '整合': 'puzzle layers', '层': 'layers', '架构': 'layers layout-grid', '网格': 'layout-grid', '列表': 'list',
  '清单': 'list-checks clipboard-list', '任务': 'list-checks clipboard-list', '合作': 'handshake', '握手': 'handshake',
  '商务': 'briefcase', '工作': 'briefcase', '营销': 'megaphone', '广告': 'megaphone', '通知': 'bell', '提醒': 'bell', '查看': 'eye',
  '眼睛': 'eye', '笑脸': 'smile', '满意': 'smile', '咖啡': 'coffee', '餐饮': 'utensils', '运动': 'dumbbell', '健身': 'dumbbell',
  '游戏': 'gamepad-2', '设计': 'palette', '颜色': 'palette', '代码': 'code', '开发': 'code terminal', '终端': 'terminal', '错误': 'bug',
  '法律': 'scale gavel', '公平': 'scale', '政府': 'landmark', '银行': 'landmark', '学校': 'school', '商店': 'store', '门店': 'store',
  '登录': 'log-in', '退出': 'log-out', '筛选': 'filter', '计算': 'calculator', '百分比': 'percent', '等待': 'hourglass',
  '倒计时': 'timer', '指南': 'compass', '方向': 'compass', '山': 'mountain', '挑战': 'mountain', '保险': 'umbrella',
  '温度': 'thermometer', '回收': 'recycle', '电池': 'battery', '电源': 'plug',
};
```

- [ ] **Step 6: 在 `ppt/toolbar.js` 加 `searchIcons`**

在 `function create(ui, cb) {` 之前加：

```js
  function searchIcons(icons, zh, q, limit = 120) { // zh hits first, then names/tags containing the query
    q = q.trim().toLowerCase();
    const out = new Set(Object.entries(zh).filter(([k]) => !q || q.includes(k) || k.includes(q))
      .flatMap(([, v]) => v.split(' ')).filter((n) => icons[n]));
    if (q) for (const n in icons) if (n.includes(q) || icons[n].tags.includes(q)) out.add(n);
    return [...out].slice(0, limit);
  }
```

把最后一行改为：`window.PPTToolbar = { create, searchIcons };`

- [ ] **Step 7: 运行，确认通过**

Run: `python ppt/test_server.py` → Expected: `Ran 35 tests … OK`
Run: selftest → Expected: `PASS 75/75`
Run: `node tests/e2e.mjs` → Expected: `61/61 passed`

- [ ] **Step 8: 提交**

```bash
git add tools/build_icons.py ppt/icons.js ppt/vendor/LICENSE-lucide ppt/icons-zh.js ppt/toolbar.js ppt/test_server.py ppt/selftest.html
git commit -m "feat(2b): Lucide 1.57.0 icon library, Chinese search words, icon search

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 服务端——图片上传、draw-icon 字段、注入图标、模板对象样式

**Files:**
- Modify: `ppt/server.py`
- Modify: `ppt/template.html`
- Test: `ppt/test_server.py`

**Interfaces:**
- Consumes: Task 3 的 `ppt/icons.js`、`ppt/icons-zh.js`；Task 1 的 `OBJ_CSS` 规则文字（模板里写同样四行）。
- Produces：
  - `POST /api/asset?t=` 原始字节 → `200 {"src": "assets/<12 hex>.<png|jpg|gif|webp>"}`；类型不支持（含 SVG、空）→ 415；超过 10MB → 413；无口令/坏 Host → 403。
  - 事件字段 `kind`（str），摘要显示为 `e5 intent kind:draw-icon slide:… […] 文字`。
  - 页面注入：`ops.js` → `icons.js`（文件存在时）→ `icons-zh.js` → `toolbar.js` → `editor.js`。
  - `ppt/template.html` 的 `#base` 带对象规则。

- [ ] **Step 1: 写失败的测试**

`ppt/test_server.py` 顶部 import 行加上 `from unittest import mock`。在 `class HistoryTests` 之前加：

```python
PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 32


class AssetTests(ServerCase):
    def post_raw(self, path, data, ctype="image/png"):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("POST", path, data, {"Host": f"127.0.0.1:{self.port}", "Content-Type": ctype})
        r = c.getresponse()
        out = (r.status, r.read())
        c.close()
        return out

    def test_png_saved_by_content_hash_and_reused(self):
        status, body = self.post_raw("/api/asset?t=tok", PNG)
        self.assertEqual(status, 200)
        src = json.loads(body)["src"]
        self.assertRegex(src, r"^assets/[0-9a-f]{12}\.png$")
        self.assertEqual((self.deck / src).read_bytes(), PNG)
        self.assertEqual(json.loads(self.post_raw("/api/asset?t=tok", PNG)[1])["src"], src)
        self.assertEqual(len(list((self.deck / "assets").iterdir())), 1)
        self.assertEqual(self.req("GET", "/" + src)[0], 200)  # the page loads it like any deck file

    def test_type_from_magic_bytes_not_header(self):
        for data, ext in ((b"\xff\xd8\xff\xe0" + b"0" * 20, "jpg"), (b"GIF89a" + b"0" * 20, "gif"),
                          (b"RIFF\0\0\0\0WEBPVP8 " + b"0" * 20, "webp")):
            status, body = self.post_raw("/api/asset?t=tok", data, "application/octet-stream")
            self.assertEqual((status, json.loads(body)["src"].rsplit(".", 1)[1]), (200, ext))

    def test_svg_and_junk_rejected(self):
        for data in (b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', b"hello", b""):
            self.assertEqual(self.post_raw("/api/asset?t=tok", data, "image/svg+xml")[0], 415)
        self.assertFalse((self.deck / "assets").exists())

    def test_needs_token(self):
        self.assertEqual(self.post_raw("/api/asset", PNG)[0], 403)
        self.assertEqual(self.post_raw("/api/asset?t=bad", PNG)[0], 403)

    def test_too_large(self):
        with mock.patch.object(server, "MAX_BODY", 16):
            self.assertEqual(self.post_raw("/api/asset?t=tok", PNG)[0], 413)
        self.assertFalse((self.deck / "assets").exists())


class DrawIconTests(ServerCase):
    def test_kind_kept_and_summarised(self):
        self.req("POST", "/api/event?t=tok", {"type": "intent", "kind": "draw-icon", "slide_id": "s-cover",
                                              "rect": {"x": 608, "y": 328, "w": 64, "h": 64}, "blocks": [], "text": "一只猫"})
        e = inbox(self.deck)[-1]
        self.assertEqual(e["kind"], "draw-icon")
        self.assertIn("intent kind:draw-icon slide:s-cover", server.summary(e))
        self.assertEqual(self.req("POST", "/api/event?t=tok", {"type": "intent", "kind": 5, "text": "x"})[0], 400)

    def test_icons_injected_between_ops_and_toolbar(self):
        html = self.req("GET", "/?t=tok")[1].decode()
        at = [html.index(f"/_ppt/{n}") for n in ("ops.js", "icons.js", "icons-zh.js", "toolbar.js", "editor.js")]
        self.assertEqual(at, sorted(at))

    def test_icons_js_optional(self):
        with mock.patch.object(server, "HERE", self.tmp):  # a checkout where build_icons.py was never run
            html = self.req("GET", "/?t=tok")[1].decode()
        self.assertNotIn("/_ppt/icons.js", html)
        self.assertIn("/_ppt/icons-zh.js", html)

    def test_template_has_object_rules(self):
        self.assertIn(".obj { position:absolute; box-sizing:border-box; }", TEMPLATE.read_text(encoding="utf-8"))
```

（`inbox` 是文件里已有的辅助函数；若名字不同，用文件里读 `inbox.jsonl` 的那个。）

- [ ] **Step 2: 运行，确认失败**

Run: `python ppt/test_server.py`
Expected: AssetTests 返回 404 / DrawIconTests 断言失败（共约 9 个 FAIL/ERROR）

- [ ] **Step 3: 实现 `ppt/server.py`**

1. `import` 行加 `hashlib`：`import argparse, base64, hashlib, json, mimetypes, secrets, sys, threading, time, webbrowser`
2. `FIELD_TYPES` 加 `"kind": str`：

```python
FIELD_TYPES = {"type": str, "kind": str, "re": str, "slide": int, "slide_id": str, "rect": dict, "cells": str,
               "blocks": list, "text": str, "issues": list, "quote": dict}
```

3. `INJECT` 改为（`%s` 第三个占位放 icons.js）：

```python
INJECT = ('<link rel="stylesheet" href="/_ppt/editor.css" data-ppt>'
          '<script data-ppt>window.PPT={token:%s,version:%s}</script>'
          '<script src="/_ppt/vendor/html-to-image.js" data-ppt></script>'
          '<script src="/_ppt/geom.js" data-ppt></script>'
          '<script src="/_ppt/ops.js" data-ppt></script>'
          '%s'
          '<script src="/_ppt/icons-zh.js" data-ppt></script>'
          '<script src="/_ppt/toolbar.js" data-ppt></script>'
          '<script src="/_ppt/editor.js" data-ppt></script>')
ICONS_JS = '<script src="/_ppt/icons.js" data-ppt></script>'
ASSET_MAGIC = ((b"\x89PNG\r\n\x1a\n", "png"), (b"\xff\xd8\xff", "jpg"), (b"GIF87a", "gif"), (b"GIF89a", "gif"))
```

4. 在 `def clean_event` 之前加：

```python
def sniff_image(data):
    """Extension for PNG/JPEG/GIF/WebP bytes, else None. SVG is refused on purpose: it can carry script."""
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return next((ext for magic, ext in ASSET_MAGIC if data.startswith(magic)), None)


def save_asset(deck, data):
    """Store an uploaded image as assets/<sha1[:12]>.<ext>; identical bytes reuse the same file."""
    ext = sniff_image(data)
    if not ext:
        raise ValueError("only PNG, JPEG, GIF or WebP images")
    d = Path(deck) / "assets"
    d.mkdir(exist_ok=True)
    name = f"{hashlib.sha1(data).hexdigest()[:12]}.{ext}"
    if not (d / name).exists():
        (d / name).write_bytes(data)
    return f"assets/{name}"
```

5. `summary` 里显示 kind：

```python
    kind = f" kind:{e['kind']}" if e.get("kind") else ""
    line = f"{e['id']} {e['type']}{kind}{re_} slide:{e.get('slide_id') or '-'} [{','.join(blocks)}]{quote} {text[:60]}"
```

6. `guard` 读请求体那段改为（略超限的请求体也读掉，413 才能送到客户端）：

```python
            n = int(self.headers.get("Content-Length") or 0)
            self.too_large = n > MAX_BODY
            # ponytail: drain up to 4x the limit so the 413 arrives; anything bigger just gets the socket reset
            self.body = self.rfile.read(n) if 0 < n <= 4 * MAX_BODY else b""
            if self.too_large:
                self.body = b""
```

7. `do_GET` 里注入改为：

```python
            inj = INJECT % (json.dumps(self.server.token), json.dumps(ver), ICONS_JS if (HERE / "icons.js").is_file() else "")
```

8. `do_POST` 里，`if url.path in ("/api/undo", "/api/redo"):` 之前加：

```python
        if url.path == "/api/asset":
            if self.too_large:
                return self.send(413, {"error": "image larger than 10MB"})
            try:
                return self.send(200, {"src": save_asset(self.server.deck, self.body)})
            except ValueError as e:
                return self.send(415, {"error": str(e)})
```

- [ ] **Step 4: 模板 `#base` 加对象规则**

`ppt/template.html` 里，`  .block.grid { display:grid; gap:8px; }` 之后加四行（与 `PPTOps.OBJ_CSS` 逐字相同）：

```css
  .obj { position:absolute; box-sizing:border-box; }
  .obj > svg, .obj > img { display:block; width:100%; height:100%; overflow:visible; }
  .obj > img { object-fit:cover; border-radius:inherit; }
  .obj-text { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; text-align:center; padding:8px; }
```

- [ ] **Step 5: 运行，确认通过**

Run: `python ppt/test_server.py` → Expected: `Ran 44 tests … OK`
Run: selftest → `PASS 75/75`；`node tests/e2e.mjs` → `61/61 passed`

- [ ] **Step 6: 提交**

```bash
git add ppt/server.py ppt/template.html ppt/test_server.py
git commit -m "feat(2b): /api/asset image upload, draw-icon kind, inject icon scripts, object rules in template

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 选中与编辑对象（工具栏、手柄、拖动、旋转、端点、方向键、层级、形状文字）

**Files:**
- Modify: `ppt/toolbar.js`（整份替换，见 Step 3）
- Modify: `ppt/editor.js`
- Modify: `ppt/editor.css`
- Test: `tests/e2e.mjs`

**Interfaces:**
- Consumes: Task 1 op（`setGeom`、`setArrow`、`setZ`、`setStyle` 对象白名单、`setHTML{text}`）；Task 2 `geomOf / arrowEnds / dragGeom / rotateTo`；Task 3 `searchIcons`。
- Produces（Task 6 依赖）：
  - toolbar：每种对象一个浮动栏（标题：形状 `填充 / 线条色 / 线宽 / 透明度 / 置顶 / 置底`；箭头同形状但没有 `填充`；图标 `颜色 / 线宽`；图片 `圆角 / 边框颜色 / 边框粗细 / 透明度`）；手柄 `data-handle` ∈ 8 个方向 + `rot`（class `ppt-rot`）+ 箭头端点 `p1 / p2`（class `ppt-end`）。
  - toolbar 回调新增 `cb.z(dir)`；`cb.startResize(handle, e)` 也接收 `rot / p1 / p2`。
  - editor：`isObj(n)`、`beginDrag(mode, el, e)`、`moveOp(o, e0, g0, dx, dy)`、`objOp(drag, e)`、`editing.owner`（被编辑文字所属的块或对象）。

- [ ] **Step 1: 写失败的 e2e 测试**

`tests/e2e.mjs`：

1. 把 `mouse` 和 `drag` 两行改为（加 `modifiers`，8 = Shift）：

```js
const mouse = (type, x, y, clickCount = 1, modifiers = 0) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount, modifiers });
async function drag(x0, y0, x1, y1, modifiers = 0) { await mouse('mousePressed', x0, y0, 1, modifiers); for (let i = 1; i <= 5; i++) await mouse('mouseMoved', x0 + (x1 - x0) * i / 5, y0 + (y1 - y0) * i / 5, 1, modifiers); await mouse('mouseReleased', x1, y1, 1, modifiers); }
```

2. 在 `// ---- add new checks above ----` 之前插入：

```js
  // ---- 2b: floating objects written into the file (as Claude would) ----
  await open(url); await sleep(1500);
  const OBJS = '<div class="obj" id="o-sh" data-kind="shape" data-shape="rect" style="left:100px;top:100px;width:200px;height:100px;fill:#dbeafe;stroke:#2563eb;stroke-width:2"><svg viewBox="0 0 200 100"><rect width="200" height="100"/></svg></div>'
    + '<div class="obj" id="o-ar" data-kind="arrow" data-shape="arrow" style="left:392px;top:592px;width:216px;height:16px;stroke:#2563eb;stroke-width:2"><svg viewBox="0 0 216 16" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="8" x2="208" y2="8"/></svg></div>'
    + '<div class="obj" id="o-free" data-kind="shape" style="left:700px;top:260px;width:120px;height:120px;fill:#fde68a"><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg></div>';
  { const h = deckHtml(), at = h.lastIndexOf('</section>'); fs.writeFileSync(path.join(DECK, 'deck.html'), h.slice(0, at) + OBJS + h.slice(at)); }
  await sleep(2500);
  const ko = await kZoom();
  const handle = (sel) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()`);
  const objOrder = () => [...deckHtml().matchAll(/class="obj" id="(o-[a-z]+)"/g)].map((m) => m[1]).join();
  let o5 = await rectOf('#o-sh'); await click(o5.x, o5.y); await sleep(300);
  check('O click selects an object: shape bar', !!(await byTitle('填充')) && !(await byTitle('边框粗细')));
  await drag(o5.x, o5.y, o5.x + 50 * ko, o5.y + 20 * ko); await sleep(2000);
  check('O drag moves freely (no grid snap)', /id="o-sh"[^>]*style="left: 150px; top: 120px;/.test(deckHtml()));
  let hd = await handle('.ppt-handle[data-handle="se"]');
  await drag(hd.x, hd.y, hd.x + 40 * ko, hd.y + 20 * ko); await sleep(2000);
  check('O resize redraws the svg at the new size', /id="o-sh"[^>]*style="left: 150px; top: 120px; width: 240px; height: 120px;[^"]*"><svg viewBox="0 0 240 120"><rect width="240" height="120">/.test(deckHtml()));
  o5 = await rectOf('#o-sh'); hd = await handle('.ppt-rot');
  await drag(hd.x, hd.y, o5.x + 200, o5.y + 5, 8); await sleep(2000);   // pointer right of the centre, Shift held
  check('O rotate handle with Shift snaps to 90deg', /id="o-sh"[^>]*transform: rotate\(90deg\)/.test(deckHtml()));
  let b5 = await byTitle('填充'); await click(b5.x, b5.y); await sleep(200);
  b5 = await byTitle('#ef4444'); await click(b5.x, b5.y); await sleep(2000);
  check('O fill colour on a shape', /id="o-sh"[^>]*fill: rgb\(239, 68, 68\)/.test(deckHtml()));
  await key('ArrowRight', 'ArrowRight', 39); await sleep(300); await key('ArrowDown', 'ArrowDown', 40, 8); await sleep(2000);
  check('O arrow keys nudge 1px, Shift 10px', /id="o-sh"[^>]*style="left: 151px; top: 130px;/.test(deckHtml()));
  b5 = await byTitle('置顶'); await click(b5.x, b5.y); await sleep(2000);
  const zTop = objOrder();
  b5 = await byTitle('置底'); await click(b5.x, b5.y); await sleep(2000);
  check('O bring to front / send to back', [zTop, objOrder()].join(' | ') === 'o-ar,o-free,o-sh | o-sh,o-ar,o-free', `${zTop} | ${objOrder()}`);
  o5 = await rectOf('#o-sh'); await dblclick(o5.x, o5.y); await sleep(300);
  await type('AB'); await click(5, 60); await sleep(2000);
  check('O double-click a shape types into its text area', /id="o-sh"[\s\S]*?<div class="obj-text">AB<\/div>/.test(deckHtml()));
  o5 = await rectOf('#o-sh'); await click(o5.x, o5.y); await sleep(300);
  await key('ArrowLeft', 'ArrowLeft', 37); await sleep(2000);
  check('O shape text survives a redraw', /id="o-sh"[^>]*style="left: 150px;[\s\S]*?<div class="obj-text">AB<\/div>/.test(deckHtml()));
  // arrow: endpoint handles instead of the box handles
  const a5 = await rectOf('#o-ar'); await click(a5.x, a5.y); await sleep(300);
  check('O arrow bar has no fill, shows endpoint handles', !(await byTitle('填充')) && !!(await byTitle('线条色'))
    && (await ev(`!!document.querySelector('.ppt-end[data-handle="p2"]:not([hidden])') && !!document.querySelector('.ppt-handle[data-handle="se"][hidden]')`)));
  hd = await handle('.ppt-end[data-handle="p2"]');
  await drag(hd.x, hd.y, hd.x, hd.y - 100 * ko); await sleep(2000);
  check('O dragging an arrow end redraws it', /id="o-ar"[^>]*style="left: 392px; top: 492px; width: 216px; height: 116px;[^"]*"><svg viewBox="0 0 216 116"[^>]*><line x1="8" y1="108" x2="208" y2="8"><\/line><polyline/.test(deckHtml()));
  // an object drawn by Claude without data-shape, lying over a block
  const f5 = await rectOf('#o-free'); await click(f5.x, f5.y); await sleep(300);
  check('O object over a block wins the click', !!(await byTitle('填充')));
  hd = await handle('.ppt-handle[data-handle="se"]');
  await drag(hd.x, hd.y, hd.x + 30 * ko, hd.y + 30 * ko); await sleep(2000);
  check('O Claude-written shape without data-shape still resizes', /id="o-free"[^>]*width: 150px; height: 150px;[^"]*"><svg viewBox="0 0 10 10">/.test(deckHtml()));
  await key('Delete', 'Delete', 46); await sleep(2000);
  check('O Delete removes the object', !deckHtml().includes('id="o-free"'));
  // lint: the user's own placement is never reported; Claude's object off the canvas is
  const lintN = () => inbox().filter((e) => e.type === 'lint').length;
  const nl5 = lintN();
  o5 = await rectOf('#o-sh'); await click(o5.x, o5.y); await sleep(300);
  await drag(o5.x, o5.y, o5.x + 1000 * ko, o5.y); await sleep(2500);
  check('L user dragging an object off the canvas raises no lint', lintN() === nl5 && /id="o-sh"[^>]*style="left: 1150px;/.test(deckHtml()), `${nl5} -> ${lintN()}`);
  { const h = deckHtml(), at = h.lastIndexOf('</section>'); fs.writeFileSync(path.join(DECK, 'deck.html'), h.slice(0, at) + '<div class="obj" id="o-out" data-kind="icon" style="left:1400px;top:10px;width:64px;height:64px"><svg viewBox="0 0 24 24"></svg></div>' + h.slice(at)); }
  await sleep(3000);
  const lastLint = JSON.stringify(inbox().filter((e) => e.type === 'lint').at(-1) || {});
  check('L Claude object off the canvas is reported', lastLint.includes('obj-outside') && lastLint.includes('o-out') && !lastLint.includes('o-sh'), lastLint);
```

- [ ] **Step 2: 运行，确认失败**

Run: `node tests/e2e.mjs`
Expected: 原 61 条 PASS，新增 `O …` / `L …` 条目 FAIL（单击对象时没有"填充"按钮，因为工具栏还不认识对象）

- [ ] **Step 3: 整份替换 `ppt/toolbar.js`**

```js
// ppt-maker toolbars: top bar, floating bars, colour popover, selection frame + handles.
// UI only: every action goes back to editor.js through the callbacks given to create().
(() => {
  const COMMON = ['#000000', '#ffffff', '#6b7280', '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#2563eb', '#8b5cf6'];
  const SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 56, 72];
  const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const OPACITY = [100, 80, 60, 40, 20];

  function searchIcons(icons, zh, q, limit = 120) { // zh hits first, then names/tags containing the query
    q = q.trim().toLowerCase();
    const out = new Set(Object.entries(zh).filter(([k]) => !q || q.includes(k) || k.includes(q))
      .flatMap(([, v]) => v.split(' ')).filter((n) => icons[n]));
    if (q) for (const n in icons) if (n.includes(q) || icons[n].tags.includes(q)) out.add(n);
    return [...out].slice(0, limit);
  }

  function create(ui, cb) {
    const G = window.PPTGeom;
    const el = (tag, cls, parent, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      if (parent) parent.appendChild(e);
      return e;
    };
    const btn = (parent, label, title, onClick, cls = '') => {
      const b = el('button', `ppt-btn ${cls}`, parent, label);
      b.type = 'button'; b.title = title;
      b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the text selection while in edit mode
      b.addEventListener('click', onClick);
      return b;
    };
    const pick = (parent, title, values, fmt, onChange) => { // <select>; first option is a label, not a value
      const s = el('select', null, parent); s.title = title;
      el('option', null, s, title).value = '';
      values.forEach((v) => { el('option', null, s, fmt(v)).value = v; });
      s.addEventListener('change', () => { if (s.value !== '') onChange(s.value); s.value = ''; });
      return s;
    };
    const sep = (parent) => el('span', 'ppt-sep', parent);

    // ---- top bar ----
    const top = el('div', 'ppt-top', ui);
    const undo = btn(top, '↶', '撤销', () => cb.undo());
    const redo = btn(top, '↷', '重做', () => cb.redo());
    sep(top);
    btn(top, '+文字', '在当前页中央插入文字块', () => cb.addText());
    for (const l of ['+形状', '+图片', '+图标']) btn(top, l, '下一版提供', () => {}).disabled = true;
    sep(top);
    btn(top, '+页', '在当前页之后插入空白页', () => cb.addSlide());
    const delSlide = btn(top, '−页', '删除当前页', () => cb.removeSlide());
    const status = el('span', 'ppt-status', top, '连接中…');

    // ---- selection frame + handles ----
    const frame = el('div', 'ppt-abs ppt-frame', ui); frame.hidden = true;
    const grab = (d, h) => d.addEventListener('mousedown', (e) => { if (e.button === 0) { e.preventDefault(); cb.startResize(h, e); } });
    const handles = HANDLES.map((h) => { const d = el('div', 'ppt-handle', frame); d.dataset.handle = h; grab(d, h); return d; });
    const rot = el('div', 'ppt-handle ppt-rot', frame); rot.dataset.handle = 'rot'; rot.title = '旋转（Shift：每 15°）'; grab(rot, 'rot');
    const ends = ['p1', 'p2'].map((h) => { const d = el('div', 'ppt-abs ppt-handle ppt-end', ui); d.dataset.handle = h; d.hidden = true; grab(d, h); return d; });

    // ---- colour popover ----
    const pop = el('div', 'ppt-abs ppt-colors', ui); pop.hidden = true;
    function openColors(anchor, onPick) {
      pop.textContent = ''; pop.hidden = false;
      const done = (c) => { pop.hidden = true; onPick(c); };
      const row = (title, colors) => {
        if (!colors.length) return;
        const r = el('div', 'ppt-row', pop); el('span', 'who', r, title);
        colors.forEach((c) => { btn(r, '', c, () => done(c), 'ppt-swatch').style.background = c; });
      };
      row('主题', cb.themeColors()); row('常用', COMMON); row('最近', cb.recentColors());
      const r = el('div', 'ppt-row', pop);
      const custom = el('input', null, r); custom.type = 'color'; custom.title = '自定义颜色';
      custom.addEventListener('change', () => done(custom.value));
      btn(r, '无', '无', () => done(null));
      const ar = anchor.getBoundingClientRect();
      cb.place(pop, { left: Math.max(8, Math.min(ar.left, innerWidth - 260)), top: ar.bottom + 4 });
    }
    const popups = [pop];
    document.addEventListener('mousedown', (e) => {
      for (const p of popups) if (!p.hidden && !p.contains(e.target) && !e.target.closest('.ppt-colorbtn')) p.hidden = true;
    }, true);
    const colorBtn = (parent, label, title, onPick) => { const b = btn(parent, label, title, () => openColors(b, onPick), 'ppt-colorbtn'); return b; };

    // ---- floating bars: one per kind of selection ----
    const bars = {};
    const mkBar = (k) => { const b = el('div', 'ppt-abs ppt-bar', ui); b.hidden = true; return (bars[k] = b); };
    const tail = (b, z) => {
      sep(b);
      if (z) { btn(b, '⤒', '置顶', () => cb.z('top')); btn(b, '⤓', '置底', () => cb.z('bottom')); sep(b); }
      btn(b, '🗑', '删除', () => cb.remove());
      btn(b, '💬 问 Claude', '问 Claude', () => cb.ask(), 'ppt-ask');
    };
    const borders = (b) => {
      colorBtn(b, '□', '边框颜色', (c) => cb.border({ color: c }));
      pick(b, '边框粗细', [0, 1, 2, 4, 8], (v) => (+v ? `${v}px` : '无边框'), (v) => cb.border({ width: +v }));
    };
    const opacity = (b) => pick(b, '透明度', OPACITY, (v) => `${v}%`, (v) => cb.blockStyle({ opacity: +v === 100 ? null : String(v / 100) }));

    let b = mkBar('block');
    colorBtn(b, 'A', '字色', (c) => cb.textStyle({ color: c }));
    pick(b, '字号', SIZES, (v) => `${v}`, (v) => cb.textStyle({ 'font-size': `${v}px` }));
    btn(b, 'B', '加粗', () => cb.toggle('bold'), 'ppt-b');
    btn(b, 'I', '斜体', () => cb.toggle('italic'), 'ppt-i');
    btn(b, 'U', '下划线', () => cb.toggle('underline'), 'ppt-u');
    pick(b, '对齐', ['left', 'center', 'right'], (v) => ({ left: '左对齐', center: '居中', right: '右对齐' })[v], (v) => cb.blockStyle({ 'text-align': v }));
    sep(b);
    colorBtn(b, '■', '背景色', (c) => cb.blockStyle({ background: c }));
    borders(b);
    pick(b, '圆角', [0, 4, 8, 16, 24], (v) => `${v}px`, (v) => cb.blockStyle({ 'border-radius': +v ? `${v}px` : null }));
    btn(b, '▣', '阴影', () => cb.toggleShadow());
    tail(b, false);
    for (const k of ['shape', 'arrow']) {
      b = mkBar(k);
      if (k === 'shape') colorBtn(b, '■', '填充', (c) => cb.blockStyle({ fill: c || 'none' }));
      colorBtn(b, '／', '线条色', (c) => cb.blockStyle({ stroke: c || 'none' }));
      pick(b, '线宽', [1, 2, 3, 4, 6, 8], (v) => `${v}px`, (v) => cb.blockStyle({ 'stroke-width': v }));
      opacity(b);
      tail(b, true);
    }
    b = mkBar('icon');
    colorBtn(b, 'A', '颜色', (c) => cb.blockStyle({ color: c }));
    pick(b, '线宽', [1, 1.5, 2, 2.5, 3], (v) => `${v}`, (v) => cb.blockStyle({ 'stroke-width': v }));
    tail(b, true);
    b = mkBar('image');
    pick(b, '圆角', [0, 8, 16, 24, '50%'], (v) => (v === '50%' ? '圆形' : `${v}px`), (v) => cb.blockStyle({ 'border-radius': v === '50%' ? v : +v ? `${v}px` : null }));
    borders(b);
    opacity(b);
    tail(b, true);

    let target = null, kind = null;
    function reposition() {
      const bar = bars[kind];
      if (!target || !target.isConnected || !bar) {
        frame.hidden = true; ends.forEach((d) => { d.hidden = true; }); Object.values(bars).forEach((x) => { x.hidden = true; });
        return;
      }
      const r = target.getBoundingClientRect();
      if (kind === 'block') {
        cb.place(frame, { left: r.left, top: r.top, width: r.width, height: r.height }); frame.style.transform = '';
      } else { // objects: the frame follows the unrotated box and turns with it
        const sr = target.closest('section.slide').getBoundingClientRect(), g = G.geomOf(target), e = G.arrowEnds(target);
        cb.place(frame, G.slideToClient(sr, g)); frame.style.transform = g.rot ? `rotate(${g.rot}deg)` : '';
        if (e) ends.forEach((d, i) => { const p = G.slideToClient(sr, { x: i ? e.x2 : e.x1, y: i ? e.y2 : e.y1, w: 0, h: 0 }); cb.place(d, { left: p.left, top: p.top }); });
      }
      const bh = bar.offsetHeight || 36, bw = bar.offsetWidth || 560, topBar = top.offsetHeight + 8;
      cb.place(bar, { left: Math.max(8, Math.min(r.left, innerWidth - bw - 8)),
        top: r.top - bh - 8 >= topBar ? r.top - bh - 8 : Math.min(r.bottom + 8, innerHeight - bh - 8) });
    }
    function select(t, opts = {}) {
      target = t;
      kind = !t ? null : !t.classList.contains('obj') ? 'block' : bars[t.dataset.kind] ? t.dataset.kind : 'shape';
      Object.entries(bars).forEach(([k, x]) => { x.hidden = k !== kind; });
      frame.hidden = !t;
      const arrow = !!t && kind !== 'block' && !!G.arrowEnds(t);
      ends.forEach((d) => { d.hidden = !arrow; });
      if (!t) { pop.hidden = true; return; }
      handles.forEach((h) => { h.hidden = !opts.resizable || !!opts.editing || arrow; });
      rot.hidden = kind === 'block' || arrow || !!opts.editing;
      reposition();
    }
    return {
      select, reposition,
      setHistory(h) {
        undo.disabled = !h?.canUndo; redo.disabled = !h?.canRedo;
        const why = h && !h.ok ? '（历史记录不可用）' : '';
        undo.title = h?.canUndo ? `撤销：${h.undoLabel}` : `撤销${why || '（没有可撤销的修改）'}`;
        redo.title = h?.canRedo ? `重做：${h.redoLabel}` : `重做${why || '（没有可重做的修改）'}`;
      },
      setStatus(text, off) { status.textContent = text; status.classList.toggle('off', !!off); },
      setSlideCount(n) { delSlide.disabled = n < 2; },
    };
  }

  window.PPTToolbar = { create, searchIcons };
})();
```

- [ ] **Step 4: 修改 `ppt/editor.js`**

逐处修改（引号内为现有代码，按原样定位）：

a. `const movable = …;` 之后加一行：

```js
  const isObj = (n) => !!n && n.classList.contains('obj');
```

b. `select()` 里的 `tb.select(…)` 改为：

```js
    tb.select(b, { editing: !!editing && editing.owner === b, resizable: movable(b) || isObj(b) });
```

c. `rememberColor` 改为（忽略"无"）：

```js
  function rememberColor(c) { if (c && c !== 'none') ls.set('ppt-recent-colors', [c, ...ls.get('ppt-recent-colors', []).filter((x) => x !== c)].slice(0, 8)); }
```

d. `PPTToolbar.create` 的回调对象里，把 `startResize(handle, e) { … },` 整行替换为下面两行：

```js
    startResize(handle, e) { if (selected) beginDrag(handle, selected, e); },
    z: setZ,
```

e. `blockStyle` 里 `rememberColor(style.background);` 改为 `rememberColor(style.background || style.fill || style.stroke || style.color);`

f. `function toggleShadow() { … }` 之后加：

```js
  function setZ(dir) {
    if (!isObj(selected)) return;
    commit({ op: 'setZ', target: selected.id, args: { z: dir }, label: `${dir === 'top' ? '置顶' : '置底'} ${selected.id}` });
    tb.reposition();
  }
  // ---- floating objects: a drag is previewed as an op on the live DOM and committed on mouseup ----
  function beginDrag(mode, t, e) {
    const obj = isObj(t);
    drag = { mode, el: t, slide: t.closest('section.slide'), x0: e.clientX, y0: e.clientY, target: e.target, obj,
             g0: obj ? G.geomOf(t) : G.gridOf(t), e0: obj ? G.arrowEnds(t) : null };
  }
  function moveOp(o, e0, g0, dx, dy) { // arrows move by their ends so the drawing stays in sync
    return e0 ? { op: 'setArrow', target: o.id, args: { x1: e0.x1 + dx, y1: e0.y1 + dy, x2: e0.x2 + dx, y2: e0.y2 + dy }, label: `移动 ${o.id}` }
              : { op: 'setGeom', target: o.id, args: { ...g0, x: g0.x + dx, y: g0.y + dy }, label: `移动 ${o.id}` };
  }
  function objOp(d, e) {
    const sr = d.slide.getBoundingClientRect(), k = G.W / sr.width, id = d.el.id;
    const dx = (e.clientX - d.x0) * k, dy = (e.clientY - d.y0) * k;
    if (d.mode === 'move') { const m = G.dragGeom({ x: 0, y: 0, w: 1, h: 1, rot: 0 }, dx, dy, 'move', e.shiftKey); return moveOp(d.el, d.e0, d.g0, m.x, m.y); }
    if (d.mode === 'p1' || d.mode === 'p2') {
      const p = d.mode === 'p1' ? { x1: d.e0.x1 + dx, y1: d.e0.y1 + dy } : { x2: d.e0.x2 + dx, y2: d.e0.y2 + dy };
      return { op: 'setArrow', target: id, args: { ...d.e0, ...p }, label: `调整箭头 ${id}` };
    }
    const g = d.mode === 'rot' ? G.rotateTo(d.g0, (e.clientX - sr.left) * k, (e.clientY - sr.top) * k, e.shiftKey)
                               : G.dragGeom(d.g0, dx, dy, d.mode, e.shiftKey);
    return { op: 'setGeom', target: id, args: g, label: `${d.mode === 'rot' ? '旋转' : '调整大小'} ${id}` };
  }
```

g. `poll()` 里 `typing` 的判断，把 `ui.querySelectorAll('textarea')` 改为 `ui.querySelectorAll('textarea, input[placeholder]')`。

h. document `mousedown` 里，把

```js
    if (selected && selected.contains(e.target) && movable(selected)) {
      drag = { mode: 'move', el: selected, slide, x0: e.clientX, y0: e.clientY, g0: G.gridOf(selected), target: e.target };
      return;
    }
```

替换为：

```js
    if (selected && selected.contains(e.target) && (movable(selected) || isObj(selected))) return beginDrag('move', selected, e);
```

i. `mousemove` 里，在 `const k = G.W / sr.width; // live preview only…` 之前加：

```js
    if (drag.obj) { O.apply(document, objOp(drag, e)); return tb.reposition(); }
```

j. `mouseup` 里，在 `const sr = d.slide.getBoundingClientRect();` 之后加：

```js
    if (d.obj) {
      const op = objOp(d, e), before = d.e0 || d.g0;
      if (Object.keys(before).some((key) => Math.round(op.args[key]) !== Math.round(before[key]))) commit(op);
      return tb.reposition();
    }
```

k. `mouseup` 里单击选中那一行 `const b = document.elementFromPoint(e.clientX, e.clientY)?.closest('.block');` 改为 `…?.closest('.obj, .block');`（对象在块上方，先命中）。

l. `askSelected` 里 `if (n.classList.contains('block') && n.id) ids.push(n.id);` 改为 `if ((n.classList.contains('block') || isObj(n)) && n.id) ids.push(n.id);`

m. `keydown` 里，在 `else if (selected && (e.key === 'Delete' || …` 之前加：

```js
    else if (isObj(selected) && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const n = e.shiftKey ? 10 : 1, dx = { ArrowLeft: -n, ArrowRight: n }[e.key] || 0, dy = { ArrowUp: -n, ArrowDown: n }[e.key] || 0;
      commit(moveOp(selected, G.arrowEnds(selected), G.geomOf(selected), dx, dy));
      tb.reposition();
    }
```

n. 改字：把 `document.addEventListener('dblclick', …)` 整段和 `async function endEdit() { … }` 整段替换为：

```js
  // ---- direct text editing (double-click a leaf block, or a shape: its centred text area) ----
  document.addEventListener('dblclick', (e) => {
    if (editing) return;
    const o = e.target.closest('section.slide .obj[data-kind="shape"]');
    if (o && o.id) return startEdit(o.querySelector(':scope > .obj-text') || el('div', 'obj-text', o), o);
    const b = e.target.closest('section.slide .block');
    if (!b || b.querySelector('.block') || !b.id) return;
    startEdit(b, b);
  });
  function startEdit(t, owner) {
    closePop();
    editing = { block: t, owner, before: t.innerHTML };
    t.contentEditable = 'true';
    t.focus();
    t.addEventListener('blur', onEditBlur);
    select(owner);
  }
```

（`onEditBlur` 与 `selectionchange` 两段保持不变。）然后：

```js
  async function endEdit() {
    if (!editing) return;
    const { block, owner, before } = editing;
    block.removeEventListener('blur', onEditBlur);
    block.removeAttribute('contenteditable');
    editing = null; savedRange = null;
    select(selected);
    const html = block.innerHTML;
    if (block !== owner && !html.trim()) block.remove(); // an empty text area added just for typing
    if (html === before) return;
    await commit(block === owner ? { op: 'setHTML', target: block.id, args: { html }, label: `改字 ${block.id}` }
                                 : { op: 'setHTML', target: owner.id, args: { html, text: true }, label: `改字 ${owner.id}` });
  }
```

o. 右键改这段（`contextmenu`）里的 `blocks: [block.id]` 改为 `blocks: [editing.owner.id]`——注意 `editing` 在 await 之后可能已为 null：在该处理函数开头 `const block = editing?.block;` 之后加 `const ownerId = editing?.owner.id;`，并用 `blocks: [ownerId]`。

- [ ] **Step 5: 修改 `ppt/editor.css`**

末尾加：

```css
.ppt-rot { left: 50%; top: -28px; border-radius: 50%; cursor: grab; }
.ppt-end { border-radius: 50%; cursor: move; }
```

- [ ] **Step 6: 运行，确认通过**

Run: `node tests/e2e.mjs`
Expected: `77/77 passed`（原 61 + 新 16）；`no page JS errors` 为 PASS
Run: `python ppt/test_server.py` → `OK`；selftest → `PASS 75/75`

- [ ] **Step 7: 提交**

```bash
git add ppt/toolbar.js ppt/editor.js ppt/editor.css tests/e2e.mjs
git commit -m "feat(2b): select and edit floating objects — per-kind bars, free move/resize/rotate, arrow ends, nudge, z-order, shape text

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 插入对象（+形状、+图标与"让 Claude 画"、+图片/粘贴/拖入）

**Files:**
- Modify: `ppt/toolbar.js`
- Modify: `ppt/editor.js`
- Modify: `ppt/editor.css`
- Test: `tests/e2e.mjs`

**Interfaces:**
- Consumes: Task 1 `insertObj / ensureBase / hasObjBase`；Task 3 `PPTIcons / PPTIconsZh / searchIcons`；Task 4 `/api/asset`、事件字段 `kind`；Task 5 `isObj / select / commit`。
- Produces：顶栏按钮标题 `插入形状`、`插入图片（也可以粘贴或拖进幻灯片）`、`插入图标`；形状菜单按钮标题 `画矩形 / 画圆角矩形 / 画椭圆 / 画三角形 / 画直线 / 画箭头 / 画双向箭头`；图标面板 `.ppt-icons`（搜索框 placeholder `搜索图标（中文或英文）`，图标按钮 title = 图标名，描述框 placeholder 以 `没有合适的` 开头，按钮 `让 Claude 画`）；toolbar 回调 `cb.armShape(shape)`、`cb.addImage(file)`、`cb.addIcon(name)`、`cb.drawIcon(text)`。

- [ ] **Step 1: 写失败的 e2e 测试**

`tests/e2e.mjs` 顶部 import 加 `import zlib from 'node:zlib';`，并在 `const py = …` 之后加：

```js
function png(w, h) { // solid grey 8-bit greyscale PNG, enough to test sizing
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4); data.copy(b, 8); b.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])), 8 + data.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h, 0x80); for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
```

在 `// ---- add new checks above ----` 之前插入：

```js
  // ---- 2b: inserting objects ----
  fs.writeFileSync(path.join(DECK, 'deck.html'), deckHtml().replace(/\n\s*\.obj[^\n]*/g, '')); // an old deck: #base has no object rules
  await sleep(2500); await open(url); await ev(`scrollTo(0, 0)`); await sleep(300);
  check('I old deck has no object rules', !/\.obj\s*\{/.test(deckHtml()));
  const ki = await kZoom();
  let b6 = await byTitle('插入形状'); await click(b6.x, b6.y); await sleep(200);
  b6 = await byTitle('画椭圆'); await click(b6.x, b6.y); await sleep(200);
  let sl = await rectOf('#s-cover');
  await drag(sl.l + 100 * ki, sl.t + 100 * ki, sl.l + 300 * ki, sl.t + 200 * ki); await sleep(2000);
  check('I draw an ellipse by dragging', /<div class="obj" id="o-[0-9a-z]{6}" data-kind="shape" data-shape="ellipse" style="left: 100px; top: 100px; width: 200px; height: 100px;[^"]*"><svg viewBox="0 0 200 100"><ellipse/.test(deckHtml()));
  check('I first object adds the #base rules in the same save', /\.obj\s*\{/.test(deckHtml()) && /补充对象样式/.test(inbox().at(-1)?.label || ''), inbox().at(-1)?.label);
  check('I new object is selected', !!(await byTitle('填充')));
  await key('z', 'KeyZ', 90, 2); await sleep(3000);
  check('I undo removes the object and the added rules together', !deckHtml().includes('data-shape="ellipse"') && !/\.obj\s*\{/.test(deckHtml()));
  await ev(`scrollTo(0, 0)`); await sleep(300);
  b6 = await byTitle('插入形状'); await click(b6.x, b6.y); await sleep(200);
  b6 = await byTitle('画箭头'); await click(b6.x, b6.y); await sleep(200);
  sl = await rectOf('#s-cover'); await click(sl.l + 640 * ki, sl.t + 600 * ki); await sleep(2000);
  check('I a click places a 160px arrow', /data-kind="arrow" data-shape="arrow" style="left: 552px; top: 592px; width: 176px; height: 16px;/.test(deckHtml()));
  // icons
  b6 = await byTitle('插入图标'); await click(b6.x, b6.y); await sleep(300);
  await type('房子'); await sleep(300);
  check('I icon search finds house by its Chinese name', !!(await byTitle('house')));
  const arBefore = (deckHtml().match(/data-kind="arrow"[^>]*style="left: (\d+)px/) || [])[1];
  await key('ArrowLeft', 'ArrowLeft', 37); await sleep(1500);
  check('I arrow keys in the icon search do not move the selection', (deckHtml().match(/data-kind="arrow"[^>]*style="left: (\d+)px/) || [])[1] === arBefore && arBefore === '552');
  b6 = await byTitle('house'); await click(b6.x, b6.y); await sleep(2000);
  check('I icon inserted at the slide centre, 64px, Lucide markup', /data-kind="icon" style="left: 608px; top: 328px; width: 64px; height: 64px;[^"]*"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"[^>]*><path d="M15 21v-8/.test(deckHtml()));
  b6 = await byTitle('插入图标'); await click(b6.x, b6.y); await sleep(300);
  const di = await rectOf('.ppt-icons input[placeholder^="没有合适的"]'); await click(di.x, di.y);
  await type('一只猫'); await enter(); await sleep(2000);
  const dIcon = inbox().at(-1);
  check('I "let Claude draw" sends a draw-icon intent', dIcon?.type === 'intent' && dIcon.kind === 'draw-icon' && dIcon.text === '一只猫' && dIcon.slide_id === 's-cover' && dIcon.rect?.w === 64, JSON.stringify(dIcon));
  // images: file picker, paste, drop
  const pngPath = path.join(SCRATCH, 'wide.png'); fs.writeFileSync(pngPath, png(960, 480));
  const docN = await send('DOM.getDocument');
  const inp = await send('DOM.querySelector', { nodeId: docN.result.root.nodeId, selector: '#ppt-ui input[type=file]' });
  await send('DOM.setFileInputFiles', { files: [pngPath], nodeId: inp.result.nodeId }); await sleep(2500);
  check('I picked image: long side 480, centred, stored under assets/', /data-kind="image" style="left: 400px; top: 240px; width: 480px; height: 240px;[^"]*"><img src="assets\/[0-9a-f]{12}\.png"/.test(deckHtml())
    && fs.readdirSync(path.join(DECK, 'assets')).length === 1);
  const nImg = () => (deckHtml().match(/data-kind="image"/g) || []).length;
  const fileJs = `(async () => { const b = await (await fetch(document.querySelector('.obj[data-kind=image] img').src)).blob(); const dt = new DataTransfer(); dt.items.add(new File([b], 'p.png', {type: 'image/png'})); return dt; })()`;
  await ev(`${fileJs}.then((dt) => document.body.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true})))`); await sleep(2500);
  check('I pasted image inserted, same bytes reuse the asset', nImg() === 2 && fs.readdirSync(path.join(DECK, 'assets')).length === 1);
  await ev(`(() => { const s = document.getElementById('s-cover'), r = s.getBoundingClientRect(), k = r.width / 1280; window.__drop = {x: r.left + 200 * k, y: r.top + 200 * k}; })()`);
  await ev(`${fileJs}.then((dt) => document.getElementById('s-cover').dispatchEvent(new DragEvent('drop', {dataTransfer: dt, clientX: __drop.x, clientY: __drop.y, bubbles: true, cancelable: true})))`); await sleep(2500);
  check('I dropped image lands at the drop point (kept inside the slide)', nImg() === 3 && /data-kind="image" style="left: 0px; top: 80px; width: 480px; height: 240px;/.test(deckHtml()));
  await ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'a.txt', {type: 'text/plain'})); document.getElementById('s-cover').dispatchEvent(new DragEvent('drop', {dataTransfer: dt, clientX: __drop.x, clientY: __drop.y, bubbles: true, cancelable: true})); })()`); await sleep(800);
  check('I dropping a non-image explains and inserts nothing', nImg() === 3 && ((await ev(`document.querySelector('.ppt-toast:last-of-type')?.textContent`)) || '').includes('只支持'));
  const ps = await rectOf('#b-cover-sub p'); await dblclick(ps.l + 20, ps.y); await sleep(300); // left end: the inserted images cover the middle
  await ev(`${fileJs}.then((dt) => document.activeElement.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true})))`); await sleep(2000);
  await key('Escape', 'Escape', 27); await sleep(1500);
  check('I paste image while typing inserts nothing', nImg() === 3);
```

- [ ] **Step 2: 运行，确认失败**

Run: `node tests/e2e.mjs`
Expected: 前 77 条 PASS，新增 `I …` 条目 FAIL（`插入形状` 按钮不存在，`byTitle` 返回 null 导致后续读 `.x` 抛错时，整段在 finally 中结束——确认失败原因是按钮缺失）

- [ ] **Step 3: 修改 `ppt/toolbar.js`**

a. 把顶栏的

```js
    for (const l of ['+形状', '+图片', '+图标']) btn(top, l, '下一版提供', () => {}).disabled = true;
```

替换为：

```js
    const shapeBtn = btn(top, '+形状▾', '插入形状', () => openMenu(shapeBtn));
    const file = el('input', null, top); file.type = 'file'; file.hidden = true; file.accept = 'image/png,image/jpeg,image/gif,image/webp';
    file.addEventListener('change', () => { if (file.files[0]) cb.addImage(file.files[0]); file.value = ''; });
    btn(top, '+图片', '插入图片（也可以粘贴或拖进幻灯片）', () => file.click());
    const iconBtn = btn(top, '+图标', '插入图标', () => openIcons(iconBtn));
```

b. 在 `const popups = [pop];` 之前加（菜单与图标面板；`popups` 一行随后改为包含它们）：

```js
    // ---- shape menu: pick a kind, then drag (or click) on a slide ----
    const SHAPES = [['rect', '矩形'], ['round', '圆角矩形'], ['ellipse', '椭圆'], ['triangle', '三角形'], ['line', '直线'], ['arrow', '箭头'], ['arrow2', '双向箭头']];
    const menu = el('div', 'ppt-abs ppt-menu', ui); menu.hidden = true;
    SHAPES.forEach(([k, l]) => btn(menu, l, `画${l}`, () => { menu.hidden = true; cb.armShape(k); }));
    function openMenu(anchor) { const ar = anchor.getBoundingClientRect(); menu.hidden = false; cb.place(menu, { left: ar.left, top: ar.bottom + 4 }); }

    // ---- icon panel: search the Lucide library, or describe one for Claude to draw ----
    const icons = el('div', 'ppt-abs ppt-icons', ui); icons.hidden = true;
    function openIcons(anchor) {
      icons.textContent = ''; icons.hidden = false;
      const q = el('input', null, icons); q.placeholder = '搜索图标（中文或英文）';
      const grid = el('div', 'ppt-icon-grid', icons);
      const show = () => {
        grid.textContent = '';
        if (!window.PPTIcons) { el('p', 'who', grid, '图标库未生成：运行 python tools/build_icons.py（"让 Claude 画"仍可用）'); return; }
        for (const n of searchIcons(window.PPTIcons, window.PPTIconsZh || {}, q.value)) {
          const ib = btn(grid, '', n, () => { icons.hidden = true; cb.addIcon(n); }, 'ppt-icon');
          ib.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${window.PPTIcons[n].body}</svg>`;
        }
      };
      q.addEventListener('input', show); show();
      const r = el('div', 'ppt-row', icons);
      const d = el('input', null, r); d.placeholder = '没有合适的？描述一下，让 Claude 画';
      const go = () => { if (d.value.trim()) { icons.hidden = true; cb.drawIcon(d.value.trim()); } };
      btn(r, '让 Claude 画', '让 Claude 画一个图标', go);
      d.addEventListener('keydown', (k) => { if (k.key === 'Enter') { k.preventDefault(); go(); } });
      const ar = anchor.getBoundingClientRect();
      cb.place(icons, { left: Math.max(8, Math.min(ar.left, innerWidth - 348)), top: ar.bottom + 4 });
      setTimeout(() => q.focus());
    }
```

c. `const popups = [pop];` 改为 `const popups = [pop, menu, icons];`

- [ ] **Step 4: 修改 `ppt/editor.js`**

a. 顶部 `let replayPending = false;` 之后加：`let armed = null; // shape kind waiting to be drawn`

b. 工具栏回调对象里，`z: setZ,` 之后加：

```js
    armShape(shape) { select(null); armed = shape; document.documentElement.classList.add('ppt-armed'); },
    addImage: (f) => addImage(f, null),
    addIcon, drawIcon,
```

c. `setZ` 函数之前加插入相关函数：

```js
  // ---- inserting objects ----
  const KIND_ZH = { shape: '形状', arrow: '箭头', icon: '图标', image: '图片' };
  const LINES = new Set(['line', 'arrow', 'arrow2']);
  function disarm() { armed = null; document.documentElement.classList.remove('ppt-armed'); }
  function addObj(slide, args) {
    const id = O.newId(document, 'o-');
    if (!O.hasObjBase(document)) commit({ op: 'ensureBase', label: '补充对象样式' }); // an older deck: same save as the object
    commit({ op: 'insertObj', args: { id, slideId: slide.id, ...args }, label: `插入${KIND_ZH[args.kind]} ${id}` });
    select(document.getElementById(id));
  }
  function drawShape(slide, shape, a, b) { // a/b: canvas-px points where the drag started and ended
    const click = Math.abs(b.x - a.x) < 6 && Math.abs(b.y - a.y) < 6;
    if (LINES.has(shape)) {
      const ends = click ? { x1: a.x - 80, y1: a.y, x2: a.x + 80, y2: a.y } : { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
      return addObj(slide, { kind: 'arrow', shape, ends, style: { stroke: '#2563eb', 'stroke-width': '2' } });
    }
    const geom = click ? { x: a.x - 80, y: a.y - 50, w: 160, h: 100 }
                       : { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
    addObj(slide, { kind: 'shape', shape, geom, style: { fill: '#dbeafe', stroke: '#2563eb', 'stroke-width': '2' } });
  }
  function addIcon(name) {
    const body = window.PPTIcons?.[name]?.body;
    if (!body) return;
    addObj(currentSlide(), { kind: 'icon', geom: { x: G.W / 2 - 32, y: G.H / 2 - 32, w: 64, h: 64 }, style: { color: '#111827', 'stroke-width': '2' },
      html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">${body}</svg>` });
  }
  function drawIcon(text) {
    const s = currentSlide(), r = { x: G.W / 2 - 32, y: G.H / 2 - 32, w: 64, h: 64 };
    enqueue({ type: 'intent', kind: 'draw-icon', slide: slides().indexOf(s) + 1, slide_id: s.id, rect: r, cells: G.rectToCells(r), blocks: [], text });
  }
  async function addImage(file, at) { // at: {slide, x, y} in canvas px (drop point), or null = centre of the current slide
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return toast('只支持 PNG、JPEG、GIF、WebP 图片');
    if (file.size > 10 * 1024 * 1024) return toast('图片超过 10MB，请先压缩');
    let src, img;
    try {
      const r = await fetch(api('/api/asset'), { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
      if (!r.ok) throw new Error(String(r.status));
      src = (await r.json()).src;
      img = new Image(); img.src = src; await img.decode();
    } catch (err) { return toast(`图片没有插入（${err.message}）`); }
    const k = Math.min(1, 480 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
    const cx = at ? at.x : G.W / 2, cy = at ? at.y : G.H / 2, inside = (v, size, max) => Math.round(Math.min(Math.max(v - size / 2, 0), Math.max(0, max - size)));
    addObj(at?.slide || currentSlide(), { kind: 'image', geom: { x: inside(cx, w, G.W), y: inside(cy, h, G.H), w, h }, html: `<img src="${src}" alt="">` });
  }
```

d. document `mousedown` 里，`closePop();` 之后（move 判断之前）加：

```js
    if (armed) {
      drag = { mode: 'draw', shape: armed, slide, x0: e.clientX, y0: e.clientY, box: el('div', 'ppt-abs ppt-sel', ui) };
      return place(drag.box, { left: e.clientX, top: e.clientY, width: 0, height: 0 });
    }
```

e. `mousemove` 里 `if (drag.mode === 'area') return place(…);` 改为 `if (drag.mode === 'area' || drag.mode === 'draw') return place(…);`

f. `mouseup` 里，`const sr = d.slide.getBoundingClientRect();` 之后、`if (d.obj)` 之前加：

```js
    if (d.mode === 'draw') {
      d.box.remove(); disarm();
      const pt = (x, y) => G.clientToSlide(sr, x, y, x, y);
      return drawShape(d.slide, d.shape, pt(d.x0, d.y0), pt(e.clientX, e.clientY));
    }
```

g. `keydown` 里 `else if (e.key === 'Escape') { closePop(); select(null); }` 改为 `else if (e.key === 'Escape') { closePop(); select(null); disarm(); }`

h. `paste` 监听整段替换为：

```js
  document.addEventListener('paste', (e) => {
    if (editing) { // plain text only: no foreign markup, remote images or pasted pictures inside text
      if (!editing.block.contains(e.target)) return;
      e.preventDefault();
      document.execCommand('insertText', false, e.clipboardData?.getData('text/plain') || '');
      return;
    }
    if (e.target.closest?.('#ppt-ui')) return;
    const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
    if (f) { e.preventDefault(); addImage(f, null); }
  });
  document.addEventListener('dragover', (e) => { if (e.target.closest?.('section.slide') && e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    const slide = e.target.closest?.('section.slide'), f = e.dataTransfer?.files?.[0];
    if (!slide || !f) return;
    e.preventDefault(); // never let the browser navigate away to the dropped file
    const p = G.clientToSlide(slide.getBoundingClientRect(), e.clientX, e.clientY, e.clientX, e.clientY);
    addImage(f, { slide, x: p.x, y: p.y });
  });
```

- [ ] **Step 5: 修改 `ppt/editor.css`**

末尾加：

```css
.ppt-armed .slide { cursor: copy; }
.ppt-menu, .ppt-icons { background: #fff; border: 1px solid #d1d5db; border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,.15); padding: 6px; box-sizing: border-box; }
.ppt-menu { display: flex; flex-direction: column; align-items: stretch; }
.ppt-menu .ppt-btn { text-align: left; }
.ppt-icons { width: 340px; }
.ppt-icons input { font: inherit; border: 1px solid #e5e7eb; border-radius: 6px; padding: 4px 6px; box-sizing: border-box; }
.ppt-icons > input { width: 100%; margin-bottom: 6px; }
.ppt-icons .ppt-row { flex-wrap: nowrap; margin: 0; } .ppt-icons .ppt-row input { flex: 1; min-width: 0; }
.ppt-icon-grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 2px; max-height: 240px; overflow: auto; margin-bottom: 6px; }
.ppt-icon { padding: 4px; } .ppt-icon svg { display: block; width: 24px; height: 24px; }
```

- [ ] **Step 6: 运行，确认通过**

Run: `node tests/e2e.mjs`
Expected: `92/92 passed`（77 + 15）
Run: `python ppt/test_server.py` → `OK`；selftest → `PASS 75/75`

- [ ] **Step 7: 提交**

```bash
git add ppt/toolbar.js ppt/editor.js ppt/editor.css tests/e2e.mjs
git commit -m "feat(2b): insert shapes, arrows, Lucide icons, 'let Claude draw', images by picker/paste/drop

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `ppt.md` 规则、spec 同步、真实会话验收

**Files:**
- Modify: `.claude/commands/ppt.md`
- Modify: `docs/superpowers/specs/2026-10-14-ppt-maker-basic-editing-design.md`

**Interfaces:**
- Consumes: 前面所有 task 定下的格式（Task 1 的对象标记、Task 4 的 `kind`）。

- [ ] **Step 1: 更新 `.claude/commands/ppt.md`**

"处理事件"一节，`- **intent**：…` 那条的"再只改 `blocks` 列出的块"改为"再只改 `blocks` 列出的块或对象（`o-` 开头的是浮动对象）"，并在其后加一条：

```markdown
- **intent 且 `kind` 为 `draw-icon`**：用户想要一个图标库里没有的图标，`text` 是描述。在 `slide_id` 页按 `rect` 的位置和大小新建一个图标对象（格式见规则 10），自己画 24×24 的线条图：只用 `path / circle / rect / line / polyline`，不写颜色和线宽（它们由对象的 `color`、`stroke-width` 控制），风格与 Lucide 一致（圆角端点、2px 线、简洁）。新 id 以 `o-` 开头。
```

`- **lint**：…` 那条末尾补充："obj-geometry → 给对象补齐 `left/top/width/height`；obj-outside → 把对象移回画布内（必要时缩小）。"

"deck.html 格式规则"末尾加：

```markdown
10. 浮动对象（形状、箭头、图标、图片）：`<div class="obj" id="o-…" data-kind="shape|arrow|icon|image" style="left:…px;top:…px;width:…px;height:…px">`，放在所属页内所有块之后，DOM 顺序即上下层级。坐标是画布像素；旋转只写 `transform:rotate(…deg)`。对象 style 只写：`left, top, width, height, transform, fill, stroke, stroke-width, color, opacity, border, border-radius, box-shadow`。
    - 形状：`data-shape` 为 `rect|round|ellipse|triangle`；内含 `<svg viewBox="0 0 宽 高">`，与对象尺寸一致（改尺寸时按新尺寸重画）；填充/线条写在对象的 `fill / stroke / stroke-width` 上，不写在 svg 里。形状里的文字放 `<div class="obj-text">…</div>`（在 svg 之后）。
    - 箭头：`data-shape` 为 `line|arrow|arrow2`；svg 里一条 `<line>`（端点是对象内坐标，四周留 8px）加箭头 `<polyline … fill="none">`。
    - 图标：`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">…</svg>`，颜色写对象的 `color`，线宽写 `stroke-width:2`。
    - 图片：`<img src="assets/…" alt="">`，只用 `assets/` 下已有的文件。
    - `#base` 里的 `.obj` 规则由页面维护，不要改。
```

- [ ] **Step 2: 同步 spec（按实现的取舍）**

在 `docs/superpowers/specs/2026-10-14-ppt-maker-basic-editing-design.md` 中：
- §2.1：`icons.js` 一行改为"新（2b）：Lucide 1.57.0 图标数据，由 `tools/build_icons.py` 生成并入库"；加一行 `icons-zh.js  新（2b）：中文搜索词对照表`；注入顺序改为 `… ops.js → icons.js（存在时）→ icons-zh.js → toolbar.js → editor.js`。
- §2.3：`setZ` 的 args 写成 `{z: "top" | "bottom"}`；`setGeom` 说明加"形状有已知 `data-shape` 时按新尺寸重画 SVG，否则只改外框"；`setArrow` 说明加"箭头的移动也用它"；`setHTML` 加"`text:true` 时写入对象的 `.obj-text`"。
- §3.2：浮动对象另加的属性改为 `left、top、width、height、transform、z-index、fill、stroke、stroke-width`（后三项供形状/箭头/图标的 SVG 继承）。
- §3.5：`#base` 规则替换为 `PPTOps.OBJ_CSS` 的四行（多了 `overflow:visible` 与 `.obj > img { object-fit:cover; border-radius:inherit; }`）。
- §6.2：面板改为"搜索框 + 网格；搜索为空时显示对照表里的常用图标"（Lucide 包里没有分类数据，所以不做分类）。

- [ ] **Step 3: 全套测试**

Run: `python ppt/test_server.py` → `OK`；selftest → `PASS 75/75`；`node tests/e2e.mjs` → `92/92 passed`

- [ ] **Step 4: 提交**

```bash
git add .claude/commands/ppt.md docs/superpowers/specs/2026-10-14-ppt-maker-basic-editing-design.md
git commit -m "docs(2b): ppt.md rules for floating objects and draw-icon; sync spec with implementation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: 真实会话验收（用副本，验完删除）**

1. 复制模板建一个验收 deck：`decks/验收-2b/deck.html`（从 `ppt/template.html` 复制，不碰用户的 `decks/试用`）。
2. 后台启动 `python ppt/server.py "decks/验收-2b" --no-open --port 8810`，用 Monitor 挂 `--tail`。
3. 用浏览器驱动脚本（scratchpad 里临时写，参照 `tests/e2e.mjs` 的辅助函数）依次：插入一个圆角矩形并改填充色；插入图标 `rocket`；粘贴一张 PNG；对图标"让 Claude 画一个咖啡杯"。
4. Claude 端按 `ppt.md` 处理 draw-icon 事件：在 rect 位置写入图标对象并回执；确认页面刷新后显示、能被选中并拖动。
5. 选中图片发"问 Claude：加一个细边框"，Claude 只改该对象的 style；然后在页面上撤销，确认收到 `undo` 事件且不改回。
6. 停服务、删除 `decks/验收-2b`（删除前先 `ls` 确认目标就是验收目录）。

Expected: 每一步页面无 JS 错误；inbox 里依次出现 edit / intent(kind draw-icon) / edit(op undo) 事件；验收 deck 已删除。
