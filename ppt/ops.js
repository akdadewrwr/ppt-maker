// ppt-maker ops: every direct edit is {op, target, args, label}. apply() runs one on any Document.
// The page applies an op to the live DOM (instant feedback) and again to the parsed file text when
// saving, so ops must be deterministic and carry absolute values only ("move to 3/2/6/9", never "one cell right").
(() => {
  const STYLE_OK = new Set(['grid-area', 'background', 'border', 'border-radius', 'box-shadow', 'text-align',
    'color', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'opacity']);
  const DEEP = new Set(['color', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'text-align']);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function clampGrid(g) {
    const [r1, c1, r2, c2] = String(g).split('/').map((s) => parseInt(s, 10));
    const R1 = clamp(r1 || 1, 1, 9), C1 = clamp(c1 || 1, 1, 16);
    return `${R1} / ${C1} / ${clamp(r2 || R1 + 1, R1 + 1, 10)} / ${clamp(c2 || C1 + 1, C1 + 1, 17)}`;
  }
  function dropEmptyStyle(n) { if (!n.getAttribute('style')) n.removeAttribute('style'); }

  const OPS = {
    setHTML(doc, t, a) { t.innerHTML = a.html; },
    setStyle(doc, t, a) {
      const style = a.style || {};
      if (Object.keys(style).some((k) => !STYLE_OK.has(k))) return false;
      for (const [k, v] of Object.entries(style)) {
        if (v == null || v === '') t.style.removeProperty(k); else t.style.setProperty(k, v);
        // a whole-block text style must win over values inner elements carry themselves
        if (a.deep && DEEP.has(k)) t.querySelectorAll('[style]').forEach((n) => { n.style.removeProperty(k); dropEmptyStyle(n); });
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

  window.PPTOps = { apply, newId, clampGrid, STYLE_OK };
})();
