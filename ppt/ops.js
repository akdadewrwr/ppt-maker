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
