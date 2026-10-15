// ppt-maker geometry: pure helpers shared by editor.js and selftest.html.
// Canvas coords are always 1280x720 regardless of on-screen zoom.
(() => {
  const W = 1280, H = 720, COLS = 16, ROWS = 9;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function clientToSlide(sr, x0, y0, x1, y1) {
    const k = W / sr.width;
    const xa = clamp((Math.min(x0, x1) - sr.left) * k, 0, W), xb = clamp((Math.max(x0, x1) - sr.left) * k, 0, W);
    const ya = clamp((Math.min(y0, y1) - sr.top) * k, 0, H), yb = clamp((Math.max(y0, y1) - sr.top) * k, 0, H);
    return { x: Math.round(xa), y: Math.round(ya), w: Math.round(xb - xa), h: Math.round(yb - ya) };
  }

  function elementRect(sr, el) {
    const k = W / sr.width, er = el.getBoundingClientRect();
    return { x: Math.round((er.left - sr.left) * k), y: Math.round((er.top - sr.top) * k),
             w: Math.round(er.width * k), h: Math.round(er.height * k) };
  }

  function slideToClient(sr, r) {
    const k = sr.width / W;
    return { left: sr.left + r.x * k, top: sr.top + r.y * k, width: r.w * k, height: r.h * k };
  }

  function rectToCells(r) {
    const cw = W / COLS, ch = H / ROWS;
    const c1 = clamp(Math.floor(r.x / cw) + 1, 1, COLS), c2 = clamp(Math.max(c1, Math.ceil((r.x + r.w) / cw)), 1, COLS);
    const r1 = clamp(Math.floor(r.y / ch) + 1, 1, ROWS), r2 = clamp(Math.max(r1, Math.ceil((r.y + r.h) / ch)), 1, ROWS);
    return `${c1}-${c2}/${r1}-${r2}`;
  }

  const overlapArea = (a, b) =>
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const depth = (el) => { let d = 0; while ((el = el.parentElement)) if (el.classList.contains('block')) d++; return d; };
  const touches = (a, r) => r.w === 0 && r.h === 0
    ? r.x >= a.x && r.x < a.x + a.w && r.y >= a.y && r.y < a.y + a.h
    : overlapArea(a, r) > 0;

  function hitBlocks(slide, r) { // objects first (they are on top), then blocks innermost first
    const sr = slide.getBoundingClientRect(), hit = (sel) => [...slide.querySelectorAll(sel)].filter((b) => touches(elementRect(sr, b), r));
    return [...hit('.obj[id]').reverse(), ...hit('.block[id]').sort((a, b) => depth(b) - depth(a))].map((b) => b.id);
  }

  function gridOf(el) { // the block's grid lines; derived from layout when Claude used spans or no inline grid-area
    const s = el.style, n = (v) => parseInt(v, 10);
    const g = { r1: n(s.gridRowStart), c1: n(s.gridColumnStart), r2: n(s.gridRowEnd), c2: n(s.gridColumnEnd) };
    if ([g.r1, g.c1, g.r2, g.c2].every((v) => v >= 1) && !/span/.test(s.gridArea)) return g; // -1 etc. count from the end: use layout
    const [cols, rows] = rectToCells(elementRect(el.closest('section.slide').getBoundingClientRect(), el)).split('/');
    const [c1, c2] = cols.split('-').map(Number), [r1, r2] = rows.split('-').map(Number);
    return { r1, c1, r2: r2 + 1, c2: c2 + 1 };
  }

  function dragGrid(g, dx, dy, handle) { // dx/dy in canvas px; snaps to whole cells, keeps >= 1x1 and inside the grid
    const dc = Math.round(dx / (W / COLS)), dr = Math.round(dy / (H / ROWS));
    let { r1, c1, r2, c2 } = g;
    if (handle === 'move') {
      const h = r2 - r1, w = c2 - c1;
      r1 = clamp(r1 + dr, 1, ROWS + 1 - h); c1 = clamp(c1 + dc, 1, COLS + 1 - w);
      return { r1, c1, r2: r1 + h, c2: c1 + w };
    }
    if (handle.includes('n')) r1 = clamp(r1 + dr, 1, r2 - 1);
    if (handle.includes('s')) r2 = clamp(r2 + dr, r1 + 1, ROWS + 1);
    if (handle.includes('w')) c1 = clamp(c1 + dc, 1, c2 - 1);
    if (handle.includes('e')) c2 = clamp(c2 + dc, c1 + 1, COLS + 1);
    return { r1, c1, r2, c2 };
  }

  const gridStr = (g) => `${g.r1}/${g.c1}/${g.r2}/${g.c2}`;

  function geomOf(o) { // floating object box in canvas px; derived from layout when Claude left a size out
    const s = o.style, m = /rotate\((-?[\d.]+)(deg|turn|rad|grad)?\)/.exec(s.transform || '');
    const rot = m ? Math.round(+m[1] * { deg: 1, turn: 360, rad: 180 / Math.PI, grad: 0.9 }[m[2] || 'deg'] * 100) / 100 : 0;
    if (![s.left, s.top, s.width, s.height].every((v) => /px$/.test(v))) {
      // layout fallback: the bounding box of a rotated element is not its size, but its centre is the centre
      const r = elementRect(o.closest('section.slide').getBoundingClientRect(), o), cs = getComputedStyle(o);
      const w = parseFloat(cs.width) || r.w, h = parseFloat(cs.height) || r.h;
      return { x: Math.round(r.x + r.w / 2 - w / 2), y: Math.round(r.y + r.h / 2 - h / 2), w, h, rot };
    }
    return { x: parseFloat(s.left), y: parseFloat(s.top), w: parseFloat(s.width), h: parseFloat(s.height), rot };
  }

  function arrowEnds(o) { // canvas-px endpoints, or null: then the arrow is moved and resized like any box
    const l = o.dataset.kind === 'arrow' && ['line', 'arrow', 'arrow2'].includes(o.dataset.shape) && o.querySelector(':scope > svg > line');
    if (!l) return null;
    const g = geomOf(o), a = (n) => parseFloat(l.getAttribute(n)) || 0;
    // only arrows drawn the way setArrow redraws them (unrotated, viewBox = box size); others would be mangled
    if (g.rot || l.parentElement.getAttribute('viewBox') !== `0 0 ${g.w} ${g.h}`) return null;
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

  function lint(slide) {
    const out = [], sr = slide.getBoundingClientRect(), sid = slide.id || null, doc = slide.ownerDocument;
    const blocks = [...slide.querySelectorAll('.block')];
    if (!slide.id) out.push({ kind: 'missing-id', block: null, slide_id: null });
    for (const b of blocks) {
      if (!b.id) { out.push({ kind: 'missing-id', block: null, slide_id: sid }); continue; }
      if (doc.querySelectorAll('#' + CSS.escape(b.id)).length > 1) out.push({ kind: 'duplicate-id', block: b.id, slide_id: sid });
      const px = Math.max(b.scrollHeight - b.clientHeight, b.scrollWidth - b.clientWidth);
      if (px > 1) out.push({ kind: 'overflow', block: b.id, slide_id: sid, px });
    }
    // overlap only among siblings: a nested block legitimately sits inside its parent
    for (const parent of [slide, ...blocks]) {
      const kids = [...parent.children].filter((c) => c.classList.contains('block'));
      for (let i = 0; i < kids.length; i++) for (let j = 0; j < i; j++) {
        if (overlapArea(elementRect(sr, kids[i]), elementRect(sr, kids[j])) > 1)
          out.push({ kind: 'overlap', block: kids[i].id || null, other: kids[j].id || null, slide_id: sid });
      }
    }
    for (const o of slide.querySelectorAll('.obj')) { // floating objects never count as overlapping blocks
      if (!o.id) { out.push({ kind: 'missing-id', block: null, slide_id: sid }); continue; }
      if (doc.querySelectorAll('#' + CSS.escape(o.id)).length > 1) out.push({ kind: 'duplicate-id', block: o.id, slide_id: sid });
      const s = o.style;
      if (![s.left, s.top, s.width, s.height].every((v) => /px$/.test(v))) { out.push({ kind: 'obj-geometry', block: o.id, slide_id: sid }); continue; }
      const g = geomOf(o), M = 16;
      if (g.x < -M || g.y < -M || g.x + g.w > W + M || g.y + g.h > H + M) out.push({ kind: 'obj-outside', block: o.id, slide_id: sid });
    }
    return out;
  }

  window.PPTGeom = { W, H, COLS, ROWS, clientToSlide, elementRect, slideToClient, rectToCells, hitBlocks, lint, gridOf, dragGrid, gridStr,
                     geomOf, arrowEnds, dragGeom, rotateTo };
})();
