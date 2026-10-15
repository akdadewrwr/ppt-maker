// ppt-maker editor layer: injected by server.py, never saved into deck.html.
// Every node it adds carries data-ppt (stripped on save) or lives in #ppt-ui.
(() => {
  const G = window.PPTGeom, O = window.PPTOps, TOKEN = window.PPT.token;
  let version = window.PPT.version, saving = false, editing = null, drag = null, pop = null, lastKey = '';
  let replayPending = false; // a save failed offline: reload+replay once the server is back
  let armed = null; // shape kind waiting to be drawn
  let sketch = null; // open sketch-mode controller (PPTSketch.open)
  let lastSave = Promise.resolve();
  const api = (p) => `${p}?t=${encodeURIComponent(TOKEN)}`;
  const slides = () => [...document.querySelectorAll('section.slide')];
  const ls = { // keys are scoped by token: one port can serve different decks over time
    get: (k, d) => { try { return JSON.parse(localStorage.getItem(`${k}:${TOKEN}`)) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(`${k}:${TOKEN}`, JSON.stringify(v)); return true; } catch { return false; } },
  };
  function el(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function place(node, r) { // r: viewport rect -> document-absolute position inside #ppt-ui
    Object.assign(node.style, { left: `${r.left + scrollX}px`, top: `${r.top + scrollY}px`,
      width: r.width == null ? '' : `${r.width}px`, height: r.height == null ? '' : `${r.height}px` });
  }
  function panelBeside(cr, right) { // 320px panel: right of cr if it fits, else below; always inside the viewport
    const W = 320, pad = 8;
    if (right && cr.left + cr.width + pad + W <= innerWidth - pad) return { left: cr.left + cr.width + pad, top: cr.top };
    return { left: Math.max(pad, Math.min(cr.left, innerWidth - W - pad)), top: cr.top + cr.height + pad };
  }

  const ui = el('div', null, document.body); ui.id = 'ppt-ui'; ui.setAttribute('data-ppt', '');
  const marks = el('div', null, ui);
  let selected = null, savedRange = null;
  const movable = (b) => !!b && b.id && b.classList.contains('block') && b.parentElement?.matches('section.slide');
  const isObj = (n) => !!n && n.classList.contains('obj');
  function select(b) {
    // slide clicks preventDefault, so a reply box or popup keeps focus and would swallow Delete/Enter: release it
    if (b && document.activeElement?.closest?.('#ppt-ui')) document.activeElement.blur();
    selected = b;
    tb.select(b, { editing: !!editing && editing.owner === b, resizable: movable(b) || (isObj(b) && !!b.id) });
  }
  function currentSlide() { // the slide showing the most area in the viewport
    let best = slides()[0], most = -1;
    for (const s of slides()) {
      const r = s.getBoundingClientRect(), vis = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (vis > most) { most = vis; best = s; }
    }
    return best;
  }
  const themeColors = () => [...new Set([...(document.getElementById('theme')?.textContent || '').matchAll(/--[\w-]+\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/g)].map((m) => m[1]))];
  function rememberColor(c) { if (c && c !== 'none') ls.set('ppt-recent-colors', [c, ...ls.get('ppt-recent-colors', []).filter((x) => x !== c)].slice(0, 8)); }
  const tb = PPTToolbar.create(ui, {
    place, themeColors, recentColors: () => ls.get('ppt-recent-colors', []),
    undo: () => undoRedo('undo'), redo: () => undoRedo('redo'),
    addText, addSlide, removeSlide,
    startResize(handle, e) { if (selected) beginDrag(handle, selected, e); },
    z: setZ,
    armShape(shape) { select(null); armed = shape; document.documentElement.classList.add('ppt-armed'); },
    addImage: (f) => addImage(f, null),
    addIcon, drawIcon,
    sketch: () => openSketch(currentSlide()), addSketchSlide,
    inkColor(c) {
      if (!c || !isObj(selected)) return;
      rememberColor(c);
      commit({ op: 'setInkColor', target: selected.id, args: { color: c }, label: `笔迹颜色 ${c} ${selected.id}` });
    },
    textStyle, blockStyle, toggle, border, toggleShadow,
    remove() { if (!selected) return; const id = selected.id; select(null); commit({ op: 'remove', target: id, label: `删除 ${id}` }); },
    ask: askSelected,
  });
  addEventListener('scroll', () => tb.reposition(), { passive: true });
  function restoreRange() { // put the edit-mode selection back after a toolbar control took focus
    if (!editing) return false;
    editing.block.focus();
    const s = getSelection();
    s.removeAllRanges();
    if (savedRange) s.addRange(savedRange);
    return !!savedRange && !savedRange.collapsed;
  }
  function wrapSelection(style) { // edit mode: style just the selected characters
    const r = savedRange, span = document.createElement('span');
    for (const [k, v] of Object.entries(style)) if (v != null) span.style.setProperty(k, v);
    span.appendChild(r.extractContents());
    r.insertNode(span);
    const nr = document.createRange(); nr.selectNodeContents(span);
    const s = getSelection(); s.removeAllRanges(); s.addRange(nr); savedRange = nr;
  }
  const styleLabel = (style) => Object.entries(style).map(([k, v]) => `${k}=${v ?? '无'}`).join(' ');
  function textStyle(style) {
    rememberColor(style.color);
    if (editing && restoreRange()) return wrapSelection(style);
    if (!selected) return;
    commit({ op: 'setStyle', target: selected.id, args: { style, deep: true }, label: `文字 ${styleLabel(style)} ${selected.id}` });
    tb.reposition();
  }
  function blockStyle(style) {
    if (!selected) return;
    rememberColor(style.background || style.fill || style.stroke || style.color);
    commit({ op: 'setStyle', target: selected.id, args: { style }, label: `样式 ${styleLabel(style)} ${selected.id}` });
    tb.reposition();
  }
  const TOGGLES = { bold: ['font-weight', '700', '400'], italic: ['font-style', 'italic', 'normal'], underline: ['text-decoration', 'underline', 'none'] };
  function isOn(cmd, block) { // judge from what the user sees (headings are bold by default), not from inline styles
    let n = [...block.querySelectorAll('*')].find((x) => !x.children.length && x.textContent.trim()) || block;
    if (cmd === 'bold') return parseInt(getComputedStyle(n).fontWeight, 10) >= 600;
    if (cmd === 'italic') return getComputedStyle(n).fontStyle === 'italic';
    for (; n && n !== block.parentElement; n = n.parentElement) if (getComputedStyle(n).textDecorationLine.includes('underline')) return true;
    return false; // underline doesn't inherit as a value: it is on if any ancestor up to the block draws it
  }
  function toggle(cmd) {
    if (editing && restoreRange()) { document.execCommand('styleWithCSS', false, false); document.execCommand(cmd); return; }
    if (!selected) return;
    const [prop, on, off] = TOGGLES[cmd];
    textStyle({ [prop]: isOn(cmd, selected) ? off : on });
  }
  function border({ color, width }) {
    if (!selected) return;
    const w = width ?? (parseFloat(selected.style.borderWidth) || 1);
    const c = color === undefined ? (selected.style.borderColor || '#6b7280') : color;
    rememberColor(color);
    blockStyle({ border: w && c ? `${w}px solid ${c}` : null });
  }
  function toggleShadow() {
    if (selected) blockStyle({ 'box-shadow': selected.style.boxShadow ? null : '0 4px 16px rgba(0,0,0,.15)' });
  }
  // ---- inserting objects ----
  const KIND_ZH = { shape: '形状', arrow: '箭头', icon: '图标', image: '图片', ink: '笔迹' };
  const LINES = new Set(['line', 'arrow', 'arrow2']);
  function disarm() { armed = null; document.documentElement.classList.remove('ppt-armed'); }
  function addObj(slide, args) {
    if (editing) endEdit(); // a drop or paste while typing: keys must act on the new object
    const id = O.newId(document, 'o-');
    if (!O.hasObjBase(document)) commit({ op: 'ensureBase', label: '补充对象样式' }); // an older deck: same save as the object
    commit({ op: 'insertObj', args: { id, slideId: slide.id, ...args }, label: `插入${KIND_ZH[args.kind]} ${id}` });
    select(document.getElementById(id));
    return id;
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
    if (!O.hasObjBase(document)) commit({ op: 'ensureBase', label: '补充对象样式' }); // Claude's icon needs the .obj rules too
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
  // ---- sketch mode: freehand over one slide, then send it to Claude or keep it as ink ----
  function openSketch(slide) {
    if (sketch || !slide) return;
    if (!slide.id) return toast(NO_ID); // drafts and the ink object are keyed by the slide id
    if (editing) endEdit();
    closePop(); disarm(); select(null);
    document.documentElement.classList.add('ppt-sketching'); // top bar off: undo, page and insert buttons would act under the board
    sketch = PPTSketch.open(slide, { place, ls, toast, onClose: () => { sketch = null; closePop(); document.documentElement.classList.remove('ppt-sketching'); },
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
  function sendSketch(slide, getItems) { // the board stays live under the box: read the sketch when it is sent
    openPop(slide, PPTSketch.bounds(getItems(), 8, true), el('div', 'ppt-abs ppt-sel', ui), `第 ${slides().indexOf(slide) + 1} 页 · 草图`, async (text) => {
      const items = getItems(), r = PPTSketch.bounds(items, 8, true), notes = items.filter((i) => i.type === 'note').map((i) => i.text);
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
    const { geom, html } = PPTSketch.inkSVG(items), id = addObj(slide, { kind: 'ink', geom, html });
    sketch?.close(!!document.getElementById(id)); // the draft goes only once the ink is really there
  }
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

  // ---- fit, reload, scroll restore ----
  function fit() { document.documentElement.style.setProperty('--ppt-zoom', String(Math.min(1, (innerWidth - 48) / G.W))); lastKey = ''; }
  function reload() { sessionStorage.setItem('ppt-scroll', String(scrollY)); location.reload(); }
  addEventListener('resize', () => { fit(); render(); tb.reposition(); });
  fit();
  const sy = sessionStorage.getItem('ppt-scroll');
  if (sy) { sessionStorage.removeItem('ppt-scroll'); requestAnimationFrame(() => scrollTo(0, +sy)); }

  // ---- event queue (survives server restarts) ----
  let flushing = false, online = false, offline = false, state = null;
  function enqueue(ev) {
    const q = [...ls.get('ppt-queue', []), ev];
    if (!ls.set('ppt-queue', q)) ls.set('ppt-queue', q.map((e) => ({ ...e, shot: undefined }))); // quota: drop screenshots
    flush();
  }
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      let q;
      while ((q = ls.get('ppt-queue', [])).length) {
        const r = await fetch(api('/api/event'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q[0]) });
        if (!r.ok && r.status !== 400) break; // 400 = malformed, drop it; anything else retry later
        ls.set('ppt-queue', ls.get('ppt-queue', []).slice(1)); // re-read: events may have been queued during the await
      }
    } catch { /* offline: poll() will retry */ } finally { flushing = false; render(); }
  }

  // ---- polling ----
  async function poll() {
    try {
      const r = await fetch(api('/api/state'), { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      state = await r.json(); offline = false; online = state.online;
      const typing = drag || pop || sketch || [...ui.querySelectorAll('textarea, input[placeholder]')].some((t) => !t.closest('[hidden]') && (t.value.trim() || t === document.activeElement));
      if (!editing && !saving && !typing && (state.version !== version || replayPending)) return reload(); // never wipe what the user is typing
      flush();
    } catch { offline = true; }
    render();
  }
  setInterval(poll, 1000);
  poll();

  // ---- rendering: status pill + per-intent marks and reply bubbles ----
  function render() {
    const pending = ls.get('ppt-queue', []).length;
    tb.setStatus(offline ? `服务断开${pending ? ` · ${pending} 条待发送` : ''}`
      : `${online ? '● Claude 在线' : '○ Claude 离线'}${pending ? ` · ${pending} 条发送中` : ''}`, offline);
    tb.setHistory(offline ? null : state?.history);
    tb.setSlideCount(slides().length);
    if (!state || (document.activeElement && document.activeElement.closest('.ppt-bubble'))) return; // don't wipe a half-typed answer
    const key = JSON.stringify([state.events, ls.get('ppt-dismissed', []), scrollX, document.documentElement.style.cssText]);
    if (key === lastKey) return;
    lastKey = key;
    marks.textContent = '';
    const dismissed = new Set(ls.get('ppt-dismissed', []));
    const threads = new Map();
    for (const e of state.events) {
      const root = e.type === 'intent' ? e.id : e.re;
      if (!threads.has(root)) threads.set(root, []);
      threads.get(root).push(e);
    }
    for (const [rootId, items] of threads) {
      const root = items[0], slide = document.getElementById(root.slide_id || '');
      if (root.type !== 'intent' || !root.rect || !slide || dismissed.has(rootId)) continue;
      const last = items[items.length - 1], sr = slide.getBoundingClientRect(), cr = G.slideToClient(sr, root.rect);
      const m = el('div', `ppt-abs ppt-mark ${last.status}`, marks);
      place(m, cr);
      el('b', null, m, `#${rootId} ${{ queued: '排队中', processing: '处理中', done: '已完成' }[last.status]}`);
      if (!items.some((e) => e.reply)) continue;
      const bub = el('div', 'ppt-abs ppt-bubble', marks);
      place(bub, panelBeside(cr, true));
      const x = el('button', 'x', bub, '×'); x.title = '关闭';
      x.onclick = () => { ls.set('ppt-dismissed', [...dismissed, rootId]); render(); };
      for (const e of items) {
        el('p', null, bub).append(el('span', 'who', null, '你：'), e.text);
        if (e.reply) el('p', null, bub).append(el('span', 'who', null, 'Claude：'), e.reply);
      }
      const ta = el('textarea', null, bub); ta.placeholder = '回复 Claude…（Enter 发送）';
      ta.onkeydown = (k) => {
        if (k.key !== 'Enter' || k.shiftKey || !ta.value.trim()) return;
        k.preventDefault();
        enqueue({ type: 'answer', re: rootId, slide_id: root.slide_id, text: ta.value.trim() });
        ta.blur(); lastKey = '';
      };
    }
  }

  // ---- select an area (drag) or a block (click) -> intent popup ----
  function closePop() { if (pop) { pop.box.remove(); pop.node.remove(); pop = null; } }
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || sketch || e.target.closest('#ppt-ui')) return;
    if (editing) {
      if (!editing.block.contains(e.target) && document.activeElement !== editing.block) endEdit(); // focus went to a toolbar control earlier
      return;
    }
    const slide = e.target.closest('section.slide');
    if (!slide) { select(null); return; }
    e.preventDefault();
    closePop();
    if (armed) {
      drag = { mode: 'draw', shape: armed, slide, x0: e.clientX, y0: e.clientY, box: el('div', 'ppt-abs ppt-sel', ui) };
      return place(drag.box, { left: e.clientX, top: e.clientY, width: 0, height: 0 });
    }
    if (selected && selected.contains(e.target) && isObj(selected) && !selected.id) return toast(NO_ID);
    if (selected && selected.contains(e.target) && (movable(selected) || isObj(selected))) return beginDrag('move', selected, e);
    drag = { mode: 'area', slide, x0: e.clientX, y0: e.clientY, box: el('div', 'ppt-abs ppt-sel', ui) };
    place(drag.box, { left: e.clientX, top: e.clientY, width: 0, height: 0 });
  });
  addEventListener('mousemove', (e) => {
    if (!drag) return;
    const sr = drag.slide.getBoundingClientRect();
    if (drag.mode === 'area' || drag.mode === 'draw') return place(drag.box, G.slideToClient(sr, G.clientToSlide(sr, drag.x0, drag.y0, e.clientX, e.clientY)));
    if (drag.obj) { O.apply(document, objOp(drag, e)); return tb.reposition(); }
    const k = G.W / sr.width; // live preview only; the op is committed on mouseup
    drag.el.style.gridArea = G.gridStr(G.dragGrid(drag.g0, (e.clientX - drag.x0) * k, (e.clientY - drag.y0) * k, drag.mode));
    tb.reposition();
  });
  addEventListener('mouseup', (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    const sr = d.slide.getBoundingClientRect();
    if (d.mode === 'draw') {
      d.box.remove(); disarm();
      const pt = (x, y) => G.clientToSlide(sr, x, y, x, y);
      return drawShape(d.slide, d.shape, pt(d.x0, d.y0), pt(e.clientX, e.clientY));
    }
    if (d.obj) {
      const op = objOp(d, e), before = d.e0 || d.g0;
      if (Object.keys(before).some((key) => Math.round(op.args[key]) !== Math.round(before[key]))) commit(op);
      return tb.reposition();
    }
    if (d.mode !== 'area') {
      const k = G.W / sr.width;
      const g = G.gridStr(G.dragGrid(d.g0, (e.clientX - d.x0) * k, (e.clientY - d.y0) * k, d.mode));
      if (g !== G.gridStr(d.g0)) {
        commit({ op: 'setGrid', target: d.el.id, args: { grid: g }, label: `${d.mode === 'move' ? '移动' : '调整大小'} ${d.el.id}` });
      } else if (d.mode === 'move') { // a click inside the selected block selects the innermost block under it
        select(d.target.closest('.block') || d.el);
      }
      return tb.reposition();
    }
    let r = G.clientToSlide(sr, d.x0, d.y0, e.clientX, e.clientY);
    if (r.w < 6 && r.h < 6) { // a click selects the innermost block under the pointer
      d.box.remove();
      const b = document.elementFromPoint(e.clientX, e.clientY)?.closest('.obj, .block');
      return select(b && d.slide.contains(b) ? b : null);
    }
    select(null);
    openPop(d.slide, r, d.box, `第 ${slides().indexOf(d.slide) + 1} 页 · 网格 ${G.rectToCells(r)}`, (text) => submitIntent(d.slide, r, text));
  });

  function openPop(slide, r, box, label, onSend, fallback = '') {
    closePop(); // one box at a time: an orphaned one could not be closed and would hold off reloads
    const cr = G.slideToClient(slide.getBoundingClientRect(), r);
    place(box, cr);
    const node = el('div', 'ppt-abs ppt-pop', ui);
    place(node, panelBeside(cr, false));
    el('div', 'who', node, label);
    const ta = el('textarea', null, node); ta.placeholder = '想怎么改这里？Enter 发送 · Shift+Enter 换行 · Esc 取消';
    pop = { box, node };
    setTimeout(() => ta.focus());
    ta.onkeydown = (k) => {
      if (k.key === 'Escape') return closePop();
      if (k.key !== 'Enter' || k.shiftKey) return;
      k.preventDefault();
      const text = ta.value.trim() || fallback;
      if (!text) return;
      closePop();
      onSend(text);
    };
  }

  // ---- text selection in edit mode + right-click: change just that text, no screenshot ----
  document.addEventListener('contextmenu', (e) => {
    const sel = getSelection();
    const block = editing?.block;
    const ownerId = editing?.owner.id;
    if (!block || !sel.rangeCount || sel.isCollapsed || !block.contains(sel.anchorNode) || !block.contains(sel.focusNode)) return;
    const range = sel.getRangeAt(0), quoted = range.toString();
    if (!quoted.trim()) return;
    e.preventDefault();
    const pre = document.createRange(); pre.selectNodeContents(block); pre.setEnd(range.startContainer, range.startOffset);
    const full = block.textContent, at = pre.toString().length;
    // before/after pin down which occurrence when the same text appears twice in the block
    const quote = { text: quoted, before: full.slice(Math.max(0, at - 20), at), after: full.slice(at + quoted.length, at + quoted.length + 20) };
    const slide = block.closest('section.slide'), sr = slide.getBoundingClientRect(), qr = range.getBoundingClientRect();
    const r = G.clientToSlide(sr, qr.left, qr.top, qr.right, qr.bottom);
    const short = quoted.length > 24 ? quoted.slice(0, 24) + '…' : quoted;
    openPop(slide, r, el('div', 'ppt-abs ppt-sel', ui), `改这段：「${short}」`, async (text) => {
      await lastSave; // the user's own typing must be in deck.html before Claude reads it
      enqueue({ type: 'intent', slide: slides().indexOf(slide) + 1, slide_id: slide.id, rect: r,
                cells: G.rectToCells(r), blocks: [ownerId], text, quote });
    });
  });

  function askSelected() {
    if (!selected) return;
    const slide = selected.closest('section.slide'), r = G.elementRect(slide.getBoundingClientRect(), selected);
    const ids = [];
    for (let n = selected; n && n !== slide; n = n.parentElement) if ((n.classList.contains('block') || isObj(n)) && n.id) ids.push(n.id);
    openPop(slide, r, el('div', 'ppt-abs ppt-sel', ui), `第 ${slides().indexOf(slide) + 1} 页 · ${selected.id}`, (text) => submitIntent(slide, r, text, ids));
  }
  function addText() {
    const s = currentSlide(), id = O.newId(document, 'b-');
    commit({ op: 'insertBlock', args: { id, slideId: s.id, grid: '4/6/6/12', html: '<p style="font-size:24px;margin:0">双击输入文字</p>' }, label: `插入文字块 ${id}` });
    select(document.getElementById(id));
  }
  function addSlide() {
    const s = currentSlide(), id = O.newId(document, 's-');
    commit({ op: 'insertSlide', args: { id, afterId: s.id }, label: `插入页 ${id}` });
    document.getElementById(id)?.scrollIntoView({ block: 'center' });
  }
  function removeSlide() {
    const s = currentSlide();
    select(null);
    commit({ op: 'removeSlide', target: s.id, label: `删除页 ${s.id}` });
  }
  async function undoRedo(kind) {
    if (editing) endEdit();
    await lastSave; await persist(); // never undo past edits that are still being saved
    if (ls.get('ppt-ops', []).length) return toast('还有修改没保存成功，暂时不能撤销');
    try {
      const r = await fetch(api(`/api/${kind}`), { method: 'POST' });
      if (r.ok) reload();
    } catch { offline = true; render(); }
  }
  document.addEventListener('keydown', (e) => {
    if (sketch) return; // the sketch board owns the keyboard
    if (editing) { if (e.key === 'Escape') endEdit(); return; } // typing and its own undo belong to the browser; Escape works even from a toolbar control
    if (e.target.closest?.('#ppt-ui') && /^(TEXTAREA|INPUT|SELECT)$/.test(e.target.tagName)) return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); undoRedo('undo'); }
    else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); undoRedo('redo'); }
    else if (e.key === 'Escape') { closePop(); select(null); disarm(); }
    else if (isObj(selected) && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const n = e.shiftKey ? 10 : 1, dx = { ArrowLeft: -n, ArrowRight: n }[e.key] || 0, dy = { ArrowUp: -n, ArrowDown: n }[e.key] || 0;
      commit(moveOp(selected, G.arrowEnds(selected), G.geomOf(selected), dx, dy));
      tb.reposition();
    }
    else if (selected && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); const id = selected.id; select(null); commit({ op: 'remove', target: id, label: `删除 ${id}` }); }
    else if (selected && e.key === 'Enter') { e.preventDefault(); askSelected(); }
  });

  async function submitIntent(slide, r, text, blocks = G.hitBlocks(slide, r)) {
    let shot = null;
    try {
      const full = await htmlToImage.toCanvas(slide, { width: G.W, height: G.H, pixelRatio: 1, style: { zoom: '1', margin: '0' } });
      const c = document.createElement('canvas');
      c.width = Math.max(1, r.w); c.height = Math.max(1, r.h);
      c.getContext('2d').drawImage(full, r.x, r.y, c.width, c.height, 0, 0, c.width, c.height);
      shot = c.toDataURL('image/png');
    } catch (err) { console.warn('[ppt] screenshot failed', err); }
    enqueue({ type: 'intent', slide: slides().indexOf(slide) + 1, slide_id: slide.id, rect: r,
              cells: G.rectToCells(r), blocks, text, shot });
  }

  // ---- direct text editing (double-click a leaf block, or a shape: its centred text area) ----
  document.addEventListener('dblclick', (e) => {
    if (editing || sketch) return;
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
  function onEditBlur(e) {
    if (e.relatedTarget?.closest?.('#ppt-ui')) return; // a toolbar control took focus: stay in edit mode
    endEdit();
  }
  document.addEventListener('selectionchange', () => {
    const s = getSelection();
    if (editing && s.rangeCount && editing.block.contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange();
  });
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
  document.addEventListener('paste', (e) => {
    if (sketch) return; // the sketch board owns the page
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
    if (sketch) return e.preventDefault();
    e.preventDefault(); // never let the browser navigate away to the dropped file
    const p = G.clientToSlide(slide.getBoundingClientRect(), e.clientX, e.clientY, e.clientX, e.clientY);
    addImage(f, { slide, x: p.x, y: p.y });
  });
  // ---- direct edits: ops applied live, queued, then saved onto the file text ----
  let chain = Promise.resolve();
  const NO_ID = '这个元素还没有 id，等 Claude 补上后才能修改';
  function commit(op) {
    if ('target' in op && !op.target) { toast(NO_ID); return lastSave; } // Claude left out the id: lint asks it to add one
    if (!O.apply(document, op)) { toast('这一步没有生效（目标已不存在）'); return lastSave; }
    ls.set('ppt-ops', [...ls.get('ppt-ops', []), op]); // survives reloads, server restarts and closed tabs
    return (lastSave = persist());
  }
  function persist() { return (chain = chain.then(saveOnce)); }
  async function saveOnce() {
    const ops = ls.get('ppt-ops', []);
    if (!ops.length) return;
    saving = true;
    try {
      // rebuild from the file text, not the live DOM: extensions and deck scripts must not leak into deck.html
      const raw = await (await fetch(api('/api/deck'), { cache: 'no-store' })).json();
      if (raw.version !== version) { replayPending = true; return; } // file moved on: poll reloads when idle, ops replay on load
      const doc = new DOMParser().parseFromString(raw.html, 'text/html');
      ops.forEach((op) => O.apply(doc, op));
      const last = ops[ops.length - 1], target = last.target && document.getElementById(last.target);
      const pageId = { insertSlide: last.args?.id, removeSlide: last.target }[last.op]; // page ops name the page, not a block
      const r = await fetch(api('/api/deck'), { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version, html: '<!doctype html>\n' + doc.documentElement.outerHTML,
          label: ops.map((o) => o.label).filter(Boolean).join('，').slice(0, 200),
          block: pageId ? null : last.target || last.args?.id, slide_id: pageId || target?.closest('section.slide')?.id || last.args?.slideId }) });
      if (r.status === 409) { replayPending = true; return; }
      if (!r.ok) throw new Error(String(r.status));
      version = (await r.json()).version;
      ls.set('ppt-ops', ls.get('ppt-ops', []).slice(ops.length)); // ops committed during the await stay queued
      runLint(true); // the user's own edits are intentional: don't send Claude to "fix" them
    } catch { replayPending = true; offline = true; render(); } // next good poll reloads and replays
    finally { saving = false; }
  }
  function toast(msg, text) {
    const t = el('div', 'ppt-toast', ui);
    const x = el('button', 'x', t, '×'); x.onclick = () => t.remove();
    el('p', null, t, msg);
    if (text != null) { const ta = el('textarea', null, t); ta.value = text; ta.readOnly = true; }
  }
  function applyPending() { // after a conflict or outage: re-run unsaved ops on the fresh file
    const ops = ls.get('ppt-ops', []);
    if (!ops.length) return;
    const lost = ops.filter((op) => !O.apply(document, op));
    if (lost.length) toast(`有 ${lost.length} 步修改没有生效（目标已被删除），内容如下：`,
      lost.map((o) => (o.op === 'setHTML' ? o.args.html.replace(/<[^>]+>/g, '') : o.label)).join('\n'));
    ls.set('ppt-ops', ops.filter((op) => !lost.includes(op)));
    if (lost.length < ops.length) lastSave = persist();
    return lost.length < ops.length;
  }

  // ---- lint: the page looks at the render so Claude doesn't have to ----
  function runLint(silent) {
    const issues = slides().flatMap((s) => G.lint(s));
    document.querySelectorAll('.ppt-lint').forEach((n) => n.classList.remove('ppt-lint'));
    issues.forEach((i) => i.block && document.getElementById(i.block)?.classList.add('ppt-lint'));
    const keys = issues.map((i) => `${i.slide_id}:${i.block}:${i.kind}:${i.other || ''}`);
    const seen = new Set(ls.get('ppt-lint-seen', []));
    const fresh = issues.filter((_, n) => !seen.has(keys[n]));
    ls.set('ppt-lint-seen', keys); // fixed issues drop out, so a recurrence is reported again
    if (fresh.length && !silent) enqueue({ type: 'lint', issues: fresh });
  }
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => runLint(applyPending())); // replayed ops are the user's own: their issues count as seen
})();
