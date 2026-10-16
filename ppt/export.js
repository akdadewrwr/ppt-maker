// Measures slides for the pptx export: canvas-pixel geometry, text runs with computed styles, boxes, tables,
// images, shapes and lines. What PowerPoint can't express natively becomes a PNG cut from an html-to-image render.
window.PPTExport = (() => {
  const W = 1280, H = 720;
  const BLANK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const SKIP = '[data-ppt], #ppt-ui, [class^="ppt-"], [class*=" ppt-"]';
  const RASTER_TAGS = { SVG: 'SVG 插图', CANVAS: '画布', VIDEO: '视频', IFRAME: '内嵌页面' };
  function col(c) { // rgb()/rgba() -> {hex, a}; transparent -> null
    const m = c && c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    const a = p.length > 3 ? p[3] : 1;
    return a === 0 ? null : { hex: p.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''), a };
  }
  const blockish = (el) => { const d = getComputedStyle(el).display; return d !== 'inline' && d !== 'contents' && d !== 'none'; };
  const idOf = (el) => el.closest('[id]')?.id || el.tagName.toLowerCase();
  function rasterWhy(el, cs) {
    if (RASTER_TAGS[el.tagName.toUpperCase()]) return RASTER_TAGS[el.tagName.toUpperCase()];
    if (cs.backgroundImage !== 'none') return '渐变或背景图';
    if (cs.boxShadow !== 'none') return '阴影';
    if (cs.transform !== 'none') return '旋转或变形';
    if (cs.filter !== 'none') return '滤镜';
    if (cs.clipPath !== 'none') return '裁切形状';
    return '';
  }
  const ALIGN = { left: 'l', start: 'l', center: 'c', right: 'r', end: 'r', justify: 'j' };
  function run(text, cs) {
    const c = col(cs.color) || { hex: '000000', a: 1 };
    const deco = cs.textDecorationLine || '';
    return { t: text, font: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(), size: parseFloat(cs.fontSize), color: c.hex, a: c.a,
      b: parseInt(cs.fontWeight, 10) >= 600, i: cs.fontStyle === 'italic', u: deco.includes('underline'), s: deco.includes('line-through') };
  }
  function para(root, extra = {}) { // the inline text of root (child blocks are walked separately)
    const cs = getComputedStyle(root), runs = [];
    (function collect(node) {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) {
          const pre = /pre/.test(getComputedStyle(n.parentElement).whiteSpace);
          const t = pre ? n.data : n.data.replace(/\s+/g, ' ');
          if (t) runs.push(run(t, getComputedStyle(n.parentElement)));
        } else if (n.nodeType === 1 && !n.matches(SKIP)) {
          if (n.tagName === 'BR') runs.push({ br: true });
          else if (!blockish(n) && !RASTER_TAGS[n.tagName.toUpperCase()] && n.tagName !== 'IMG') collect(n);
        }
      }
    })(root);
    while (runs.length && runs[0].t !== undefined && !runs[0].t.trim()) runs.shift();
    if (runs[0]?.t) runs[0].t = runs[0].t.trimStart();
    const last = runs.at(-1);
    if (last?.t) last.t = last.t.trimEnd();
    const lh = parseFloat(cs.lineHeight);
    return { align: ALIGN[cs.textAlign] || 'l', lh: Number.isFinite(lh) ? lh : null, bullet: '', level: 0, runs: runs.filter((r) => r.br || r.t), ...extra };
  }
  function textRect(root) { // union of the line boxes of root's own text
    const rg = document.createRange(), rs = [];
    const walk = (node) => { for (const n of node.childNodes) {
      if (n.nodeType === 3 && n.data.trim()) { rg.selectNodeContents(n); rs.push(...rg.getClientRects()); }
      else if (n.nodeType === 1 && !n.matches(SKIP) && !blockish(n) && n.tagName !== 'IMG' && !RASTER_TAGS[n.tagName.toUpperCase()]) walk(n);
    } };
    walk(root);
    if (!rs.length) return null;
    const l = Math.min(...rs.map((r) => r.left)), t = Math.min(...rs.map((r) => r.top));
    return { left: l, top: t, width: Math.max(...rs.map((r) => r.right)) - l, height: Math.max(...rs.map((r) => r.bottom)) - t };
  }
  async function dataUrl(src) {
    if (src.startsWith('data:image/')) return src;
    const b = await (await fetch(src)).blob();
    if (!b.type.startsWith('image/')) throw new Error('不是图片');
    return new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(b); });
  }

  async function measureSlide(slide, skipped) {
    const sr = slide.getBoundingClientRect(), k = sr.width / W;
    const rel = (r) => ({ x: (r.left - sr.left) / k, y: (r.top - sr.top) / k, w: r.width / k, h: r.height / k });
    const items = [], rasters = [], pending = [];
    const scs = getComputedStyle(slide), sbg = col(scs.backgroundColor);
    // whole: a list's text sits in its <li>s, so the list's own box is the text box
    const textItem = (el, paras, whole = false) => { const r = whole ? el.getBoundingClientRect() : textRect(el); if (r && paras.some((p) => p.runs.length)) { const g = rel(r); items.push({ k: 'text', ...g, w: g.w + 4, paras }); } };
    const raster = (el, why, pad = 0) => { const g = rel(el.getBoundingClientRect()); const it = { k: 'raster', x: g.x - pad, y: g.y - pad, w: g.w + 2 * pad, h: g.h + 2 * pad, id: idOf(el), why }; items.push(it); rasters.push([el, it]); };
    function obj(el) {
      const cs = getComputedStyle(el), kind = el.dataset.kind, shape = el.dataset.shape;
      const g = { x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0, w: parseFloat(el.style.width) || 0, h: parseFloat(el.style.height) || 0 };
      if (kind === 'shape' && ['rect', 'round', 'ellipse', 'triangle'].includes(shape)) {
        const f = col(cs.fill), s = col(cs.stroke), m = /rotate\((-?[\d.]+)deg\)/.exec(el.style.transform || '');
        const t = el.querySelector('.obj-text');
        items.push({ k: 'shape', shape, ...g, rot: m ? parseFloat(m[1]) : 0, fill: f?.hex || null, fa: f?.a ?? 1, line: s?.hex || null, lw: parseFloat(cs.strokeWidth) || 0,
          paras: t ? [para(t)] : [] });
      } else if (kind === 'arrow') {
        const ln = el.querySelector('line'), s = col(cs.stroke) || { hex: '000000' };
        if (!ln) return raster(el, '箭头');
        const p = (a) => parseFloat(ln.getAttribute(a)) || 0;
        items.push({ k: 'line', x1: g.x + p('x1'), y1: g.y + p('y1'), x2: g.x + p('x2'), y2: g.y + p('y2'), color: s.hex, lw: parseFloat(cs.strokeWidth) || 2,
          start: shape === 'arrow2', end: shape === 'arrow' || shape === 'arrow2' });
      } else if (kind === 'image' && el.querySelector('img')) {
        image(el.querySelector('img'), g);
      } else raster(el, kind === 'icon' ? '图标' : kind === 'ink' ? '笔迹' : '对象');
    }
    function image(img, g = rel(img.getBoundingClientRect())) {
      const it = { k: 'image', ...g, src: '', crop: null };
      const nr = img.naturalWidth / (img.naturalHeight || 1), br = g.w / (g.h || 1);
      if (getComputedStyle(img).objectFit === 'cover' && img.naturalWidth) {
        const c = nr > br ? (1 - br / nr) / 2 : 0, v = nr < br ? (1 - nr / br) / 2 : 0;
        it.crop = { l: c, r: c, t: v, b: v };
      }
      items.push(it);
      pending.push(dataUrl(img.currentSrc || img.src).then((u) => { it.src = u; }).catch(() => { items.splice(items.indexOf(it), 1); skipped.push({ id: idOf(img), why: '图片取不到' }); }));
    }
    function table(el) {
      const rows = [...el.rows];
      if (rows.some((r) => [...r.cells].some((c) => c.colSpan > 1 || c.rowSpan > 1))) return raster(el, '合并单元格的表格');
      const first = rows[0]?.cells[0], fcs = first && getComputedStyle(first), b = fcs && col(fcs.borderTopColor);
      items.push({ k: 'table', ...rel(el.getBoundingClientRect()), cols: [...(rows[0]?.cells || [])].map((c) => c.getBoundingClientRect().width / k),
        rows: rows.map((r) => r.getBoundingClientRect().height / k), border: fcs && parseFloat(fcs.borderTopWidth) ? b?.hex || null : null, bw: fcs ? parseFloat(fcs.borderTopWidth) || 0 : 0,
        cells: rows.map((r) => [...r.cells].map((c) => ({ paras: [para(c)], fill: col(getComputedStyle(c).backgroundColor)?.hex || null }))) });
    }
    function walk(el) {
      if (el.matches(SKIP)) return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      if (el.classList.contains('obj')) return obj(el);
      const why = rasterWhy(el, cs);
      if (why) return raster(el, why, cs.boxShadow !== 'none' ? 16 : 0);
      if (el.tagName === 'TABLE') return table(el);
      if (el.tagName === 'IMG') return image(el);
      const bg = col(cs.backgroundColor), bw = parseFloat(cs.borderTopWidth) || 0, bc = cs.borderTopStyle !== 'none' && bw ? col(cs.borderTopColor) : null;
      if (bg || bc) items.push({ k: 'box', ...rel(el.getBoundingClientRect()), fill: bg?.hex || null, fa: bg?.a ?? 1, line: bc?.hex || null, lw: bc ? bw : 0, r: parseFloat(cs.borderTopLeftRadius) || 0 });
      if ((el.tagName === 'UL' || el.tagName === 'OL') && [...el.children].every((li) => li.tagName === 'LI' && ![...li.children].some(blockish))) {
        return textItem(el, [...el.children].map((li, i) => para(li, { bullet: el.tagName === 'UL' ? '•' : `${i + 1}.` })), true);
      }
      textItem(el, [para(el)]);
      for (const c of el.children) if (blockish(c) || RASTER_TAGS[c.tagName.toUpperCase()] || c.tagName === 'IMG' || c.classList.contains('obj')) walk(c);
    }
    for (const c of slide.children) walk(c);
    let bg = sbg ? sbg.hex : 'ffffff';
    if (scs.backgroundImage !== 'none') { // gradient or picture behind the page: one picture at the very bottom
      const it = { k: 'raster', x: 0, y: 0, w: W, h: H, id: slide.id, why: '页面背景' };
      items.unshift(it); rasters.push([null, it]);
    }
    if (rasters.length) await cut(slide, rasters, skipped, items);
    await Promise.all(pending);
    return { id: slide.id, bg, items };
  }
  async function render(slide, mode) { // mode t: only the marked rasters, page background clear; b: the page background alone
    const st = document.createElement('style'); st.dataset.ppt = '';
    st.textContent = '[data-ppt-x="t"] *, [data-ppt-x="b"] * { visibility: hidden !important; } [data-ppt-x="t"] { background: transparent !important; }'
      + '[data-ppt-x="r"], [data-ppt-x="r"] * { visibility: visible !important; }';
    document.head.append(st); slide.dataset.pptX = mode;
    try { // a picture that can't be fetched (it is reported as skipped) must not sink the whole render
      return await htmlToImage.toCanvas(slide, { width: W, height: H, pixelRatio: 2, style: { zoom: '1', margin: '0' }, imagePlaceholder: BLANK });
    }
    finally { delete slide.dataset.pptX; st.remove(); }
  }
  async function cut(slide, rasters, skipped, items) {
    const marked = rasters.filter(([el]) => el);
    marked.forEach(([el]) => { el.dataset.pptX = 'r'; });
    try {
      const fg = marked.length ? await render(slide, 't') : null, bgc = rasters.some(([el]) => !el) ? await render(slide, 'b') : null;
      for (const [el, it] of rasters) {
        const src = el ? fg : bgc, c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(it.w * 2)); c.height = Math.max(1, Math.round(it.h * 2));
        c.getContext('2d').drawImage(src, it.x * 2, it.y * 2, c.width, c.height, 0, 0, c.width, c.height);
        it.src = c.toDataURL('image/png');
      }
    } catch (e) {
      for (const [, it] of rasters) { items.splice(items.indexOf(it), 1); skipped.push({ id: it.id, why: `转图片失败：${e.message || e}` }); }
    } finally { marked.forEach(([el]) => { delete el.dataset.pptX; }); }
  }
  async function measure(slides) {
    const skipped = [], out = [];
    for (const s of slides) out.push(await measureSlide(s, skipped));
    return { slides: out, skipped };
  }
  return { measure };
})();
