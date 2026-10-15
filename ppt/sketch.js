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

  window.PPTSketch = { COLORS, WIDTHS, esc, simplify, smoothPath, noteSize, bounds, hitItem, inkSVG, drawOnCanvas, open };
})();
