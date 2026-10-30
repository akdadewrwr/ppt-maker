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
  const CJK = /YaHei|JhengHei|PingFang|Hiragino|Noto (Sans|Serif) (CJK|SC|TC|JP|KR)|Source Han|SimSun|SimHei|NSimSun|KaiTi|FangSong|DengXian|STHeiti|STSong|Heiti|Songti|Meiryo|MS Gothic|MS Mincho|Yu Gothic|Malgun|[\u4e00-\u9fff]/i;
  function run(text, cs) {
    const c = col(cs.color) || { hex: '000000', a: 1 };
    const deco = cs.textDecorationLine || '';
    const fonts = cs.fontFamily.split(',').map((f) => f.replace(/["']/g, '').trim()).filter(Boolean);
    return { t: text, font: fonts[0], ea: fonts.find((f) => CJK.test(f)) || 'Microsoft YaHei', size: parseFloat(cs.fontSize), color: c.hex, a: c.a,
      b: parseInt(cs.fontWeight, 10) >= 600, i: cs.fontStyle === 'italic', u: deco.includes('underline'), s: deco.includes('line-through') };
  }
  function para(root, extra = {}) { // the inline text of root (child blocks are walked separately)
    const cs = getComputedStyle(root), runs = [];
    (function collect(node) {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) {
          if (getComputedStyle(n.parentElement).visibility === 'hidden') continue; // hidden text stays hidden
          const pre = /pre/.test(getComputedStyle(n.parentElement).whiteSpace);
          const t = pre ? n.data : n.data.replace(/\s+/g, ' ');
          if (t) runs.push(run(t, getComputedStyle(n.parentElement)));
        } else if (n.nodeType === 1 && !n.matches(SKIP) && getComputedStyle(n).display !== 'none') {
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
    if (/^data:image\/(png|jpeg|gif)[;,]/.test(src)) return src; // other inline pictures (webp, svg) are converted below
    const b = await (await fetch(src, { signal: AbortSignal.timeout(5000) })).blob(); // a slow external picture is skipped, not waited on
    if (!b.type.startsWith('image/')) throw new Error('不是图片');
    if (/^image\/(png|jpeg|gif)$/.test(b.type)) return new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(b); });
    const url = URL.createObjectURL(b); // WebP, SVG, …: PowerPoint wants PNG
    try {
      const im = new Image(); im.src = url; await im.decode();
      const c = document.createElement('canvas'); c.width = im.naturalWidth || 300; c.height = im.naturalHeight || 150;
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    } finally { URL.revokeObjectURL(url); }
  }

  function arcSegs(x1, y1, rx, ry, deg, large, sweep, x2, y2) { // SVG 1.1 F.6.5: endpoint arc -> centre form -> cubics of ≤ 90° each
    const phi = deg * Math.PI / 180, cos = Math.cos(phi), sin = Math.sin(phi);
    const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2, xp = cos * dx + sin * dy, yp = -sin * dx + cos * dy;
    const lam = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
    if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
    const den = rx * rx * yp * yp + ry * ry * xp * xp;
    let co = Math.sqrt(Math.max(0, (rx * rx * ry * ry - den) / den));
    if (large === sweep) co = -co;
    const cxp = co * rx * yp / ry, cyp = -co * ry * xp / rx;
    const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
    const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t1 = ang(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
    let dt = ang((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI; else if (sweep && dt < 0) dt += 2 * Math.PI;
    const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9)), step = dt / n, k = 4 / 3 * Math.tan(step / 4);
    const at = (u, v) => [cx + rx * u * cos - ry * v * sin, cy + rx * u * sin + ry * v * cos];
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = t1 + i * step, b = a + step;
      const end = i === n - 1 ? [x2, y2] : at(Math.cos(b), Math.sin(b));
      out.push(['C', ...at(Math.cos(a) - k * Math.sin(a), Math.sin(a) + k * Math.cos(a)), ...at(Math.cos(b) + k * Math.sin(b), Math.sin(b) - k * Math.cos(b)), ...end]);
    }
    return out;
  }
  function pathSegs(d) { // SVG path data -> absolute ['M',x,y] ['L',x,y] ['C',x1,y1,x2,y2,x,y] ['Z']; stops at the first bad token, like browsers
    const out = [], NUM = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/y, SEP = /[\s,]*/y;
    let p = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0, cx = null, cy = null, qx = null, qy = null;
    d = String(d || '');
    const skip = () => { SEP.lastIndex = p; SEP.exec(d); p = SEP.lastIndex; };
    const num = () => { skip(); NUM.lastIndex = p; const m = NUM.exec(d); if (!m) throw new Error('bad path'); p = NUM.lastIndex; return +m[0]; };
    const flag = () => { skip(); const c = d[p]; if (c !== '0' && c !== '1') throw new Error('bad flag'); p++; return c === '1'; }; // flags may touch: a1 1 0 01 2 2
    try {
      for (;;) {
        skip();
        if (p >= d.length) break;
        if (/[a-z]/i.test(d[p])) { cmd = d[p++]; if (!'MmLlHhVvCcSsQqTtAaZz'.includes(cmd)) break; }
        else if (!cmd || cmd === 'Z' || cmd === 'z') break; // a number with no command to repeat
        const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase(), ox = rel ? x : 0, oy = rel ? y : 0;
        let ncx = null, ncy = null, nqx = null, nqy = null;
        if (C === 'Z') { out.push(['Z']); x = sx; y = sy; }
        else if (C === 'M') { x = ox + num(); y = oy + num(); sx = x; sy = y; out.push(['M', x, y]); cmd = rel ? 'l' : 'L'; }
        else if (C === 'L') { x = ox + num(); y = oy + num(); out.push(['L', x, y]); }
        else if (C === 'H') { x = ox + num(); out.push(['L', x, y]); }
        else if (C === 'V') { y = oy + num(); out.push(['L', x, y]); }
        else if (C === 'C' || C === 'S') {
          const [x1, y1] = C === 'C' ? [ox + num(), oy + num()] : cx === null ? [x, y] : [2 * x - cx, 2 * y - cy];
          const x2 = ox + num(), y2 = oy + num(), ex = ox + num(), ey = oy + num();
          out.push(['C', x1, y1, x2, y2, ex, ey]); x = ex; y = ey; ncx = x2; ncy = y2;
        } else if (C === 'Q' || C === 'T') {
          const [q1, q2] = C === 'Q' ? [ox + num(), oy + num()] : qx === null ? [x, y] : [2 * x - qx, 2 * y - qy];
          const ex = ox + num(), ey = oy + num();
          out.push(['C', x + 2 / 3 * (q1 - x), y + 2 / 3 * (q2 - y), ex + 2 / 3 * (q1 - ex), ey + 2 / 3 * (q2 - ey), ex, ey]); x = ex; y = ey; nqx = q1; nqy = q2;
        } else { // A
          const rx = Math.abs(num()), ry = Math.abs(num()), deg = num(), large = flag(), sweep = flag(), ex = ox + num(), ey = oy + num();
          if (ex !== x || ey !== y) out.push(...(rx && ry ? arcSegs(x, y, rx, ry, deg, large, sweep, ex, ey) : [['L', ex, ey]]));
          x = ex; y = ey;
        }
        cx = ncx; cy = ncy; qx = nqx; qy = nqy;
      }
    } catch { /* keep what parsed */ }
    return out;
  }

  async function measureSlide(slide, skipped) {
    const sr = slide.getBoundingClientRect(), k = sr.width / W;
    const rel = (r) => ({ x: (r.left - sr.left) / k, y: (r.top - sr.top) / k, w: r.width / k, h: r.height / k });
    const items = [], rasters = [], pending = [];
    const scs = getComputedStyle(slide), sbg = col(scs.backgroundColor);
    // The text box spans el's content width (PowerPoint's wider font metrics then wrap where the page does, and centring
    // stays centred); one line of text never wraps. whole: a list's text sits in its <li>s, so the list's box is the height.
    // list: 'bullets' | 'plain' | false. Computed padding and line-height are canvas px, rects are zoomed: scale by k.
    const textItem = (el, paras, list = false) => {
      const r = list ? el.getBoundingClientRect() : textRect(el);
      if (!r || !paras.some((p) => p.runs.length)) return;
      const cs = getComputedStyle(el), b = el.getBoundingClientRect(), n = (v) => parseFloat(v) || 0;
      let left = b.left + (n(cs.borderLeftWidth) + n(cs.paddingLeft)) * k;
      const right = b.right - (n(cs.borderRightWidth) + n(cs.paddingRight)) * k;
      if (list === 'bullets') left -= 24 * k; // the pptx bullet indent (marL 24px): list text then starts where the page's does
      const lh = parseFloat(cs.lineHeight) || n(cs.fontSize) * 1.3;
      items.push({ k: 'text', ...rel({ left, top: r.top, width: Math.max(right - left, r.width), height: r.height }), wrap: paras.length > 1 || r.height / k > lh * 1.5, paras });
    };
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
      const it = { k: 'image', ...g, id: idOf(img), src: '', crop: null };
      const nr = img.naturalWidth / (img.naturalHeight || 1), br = g.w / (g.h || 1);
      if (getComputedStyle(img).objectFit === 'cover' && img.naturalWidth) {
        const c = nr > br ? (1 - br / nr) / 2 : 0, v = nr < br ? (1 - nr / br) / 2 : 0;
        it.crop = { l: c, r: c, t: v, b: v };
      } else if (getComputedStyle(img).objectFit === 'contain' && img.naturalWidth) { // letterboxed: the picture is smaller than its box
        if (nr > br) { const h = it.w / nr; it.y += (it.h - h) / 2; it.h = h; } else { const w = it.h * nr; it.x += (it.w - w) / 2; it.w = w; }
      }
      items.push(it);
      pending.push(dataUrl(img.currentSrc || img.src).then((u) => { it.src = u; }).catch(() => { drop(it); skipped.push({ id: idOf(img), why: '图片取不到' }); }));
    }
    function table(el) {
      const rows = [...el.rows];
      if (rows.some((r) => [...r.cells].some((c) => c.colSpan > 1 || c.rowSpan > 1))) return raster(el, '合并单元格的表格');
      const first = rows[0]?.cells[0], fcs = first && getComputedStyle(first), b = fcs && col(fcs.borderTopColor);
      items.push({ k: 'table', ...rel(el.getBoundingClientRect()), cols: [...(rows[0]?.cells || [])].map((c) => c.getBoundingClientRect().width / k),
        rows: rows.map((r) => r.getBoundingClientRect().height / k), border: fcs && parseFloat(fcs.borderTopWidth) ? b?.hex || null : null, bw: fcs ? parseFloat(fcs.borderTopWidth) || 0 : 0,
        cells: rows.map((r) => [...r.cells].map((c) => ({ paras: [para(c)], fill: col(getComputedStyle(c).backgroundColor)?.hex || null }))) });
    }
    const drop = (it) => { const i = items.indexOf(it); if (i >= 0) items.splice(i, 1); };
    function walk(el) { // a measuring error turns the element into a picture instead of failing the export
      const n = items.length, nr = rasters.length;
      try { walkOne(el); } catch {
        items.length = n; rasters.length = nr; raster(el, '测量出错');
      }
    }
    function walkOne(el) {
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
        const marked = getComputedStyle(el.children[0] || el).listStyleType !== 'none';
        return textItem(el, [...el.children].map((li, i) => para(li, { bullet: !marked ? '' : el.tagName === 'UL' ? '•' : `${i + 1}.` })), marked ? 'bullets' : 'plain');
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
      + '[data-ppt-x="t"] [data-ppt-x="r"], [data-ppt-x="t"] [data-ppt-x="r"] * { visibility: visible !important; }'; // not in the background render
    document.head.append(st); slide.dataset.pptX = mode;
    try { // a picture that can't be fetched (it is reported as skipped) must not sink the whole render
      return await htmlToImage.toCanvas(slide, { width: W, height: H, pixelRatio: 2, style: { zoom: '1', margin: '0' }, imagePlaceholder: BLANK,
        filter: (n) => !(n.tagName === 'IMG' && !(n.complete && n.naturalWidth)) }); // pictures still loading would stall the render
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
  return { measure, pathSegs };
})();
