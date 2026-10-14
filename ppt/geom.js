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

  window.PPTGeom = { W, H, COLS, ROWS, clientToSlide, elementRect, slideToClient, rectToCells, hitBlocks, lint };
})();
