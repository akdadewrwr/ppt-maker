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

  function hitBlocks(slide, r) {
    const sr = slide.getBoundingClientRect();
    return [...slide.querySelectorAll('.block[id]')]
      .filter((b) => touches(elementRect(sr, b), r))
      .sort((a, b) => depth(b) - depth(a))
      .map((b) => b.id);
  }

  function gridOf(el) { // the block's grid lines; derived from layout when Claude used spans or no inline grid-area
    const s = el.style, n = (v) => parseInt(v, 10);
    const g = { r1: n(s.gridRowStart), c1: n(s.gridColumnStart), r2: n(s.gridRowEnd), c2: n(s.gridColumnEnd) };
    if ([g.r1, g.c1, g.r2, g.c2].every(Number.isFinite) && !/span/.test(s.gridArea)) return g;
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
    return out;
  }

  window.PPTGeom = { W, H, COLS, ROWS, clientToSlide, elementRect, slideToClient, rectToCells, hitBlocks, lint, gridOf, dragGrid, gridStr };
})();
