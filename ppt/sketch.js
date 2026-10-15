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
