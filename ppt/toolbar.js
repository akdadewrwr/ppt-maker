// ppt-maker toolbars: top bar, floating bars, colour popover, selection frame + handles.
// UI only: every action goes back to editor.js through the callbacks given to create().
(() => {
  const COMMON = ['#000000', '#ffffff', '#6b7280', '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#2563eb', '#8b5cf6'];
  const SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 56, 72];
  const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const OPACITY = [100, 80, 60, 40, 20];

  function searchIcons(icons, zh, q, limit = 120) { // zh hits first, then names/tags containing the query
    q = q.trim().toLowerCase();
    const out = new Set(Object.entries(zh).filter(([k]) => !q || q.includes(k) || k.includes(q))
      .flatMap(([, v]) => v.split(' ')).filter((n) => icons[n]));
    if (q) for (const n in icons) if (n.includes(q) || icons[n].tags.includes(q)) out.add(n);
    return [...out].slice(0, limit);
  }

  function create(ui, cb) {
    const G = window.PPTGeom;
    const el = (tag, cls, parent, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      if (parent) parent.appendChild(e);
      return e;
    };
    const btn = (parent, label, title, onClick, cls = '') => {
      const b = el('button', `ppt-btn ${cls}`, parent, label);
      b.type = 'button'; b.title = title;
      b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the text selection while in edit mode
      b.addEventListener('click', onClick);
      return b;
    };
    const pick = (parent, title, values, fmt, onChange) => { // <select>; first option is a label, not a value
      const s = el('select', null, parent); s.title = title;
      el('option', null, s, title).value = '';
      values.forEach((v) => { el('option', null, s, fmt(v)).value = v; });
      s.addEventListener('change', () => { if (s.value !== '') onChange(s.value); s.value = ''; });
      return s;
    };
    const sep = (parent) => el('span', 'ppt-sep', parent);

    // ---- top bar ----
    const top = el('div', 'ppt-top', ui);
    const undo = btn(top, '↶', '撤销', () => cb.undo());
    const redo = btn(top, '↷', '重做', () => cb.redo());
    sep(top);
    btn(top, '+文字', '在当前页中央插入文字块', () => cb.addText());
    const shapeBtn = btn(top, '+形状▾', '插入形状', () => openMenu(shapeBtn));
    const file = el('input', null, top); file.type = 'file'; file.hidden = true; file.accept = 'image/png,image/jpeg,image/gif,image/webp';
    file.addEventListener('change', () => { if (file.files[0]) cb.addImage(file.files[0]); file.value = ''; });
    btn(top, '+图片', '插入图片（也可以粘贴或拖进幻灯片）', () => file.click());
    const iconBtn = btn(top, '+图标', '插入图标', () => openIcons(iconBtn));
    btn(top, '✎ 草图', '在当前页上画草图', () => cb.sketch());
    btn(top, '+草图页', '插入空白页并画草图', () => cb.addSketchSlide());
    btn(top, '📚 知识库', '打开知识库', () => cb.kb());
    const importBtn = btn(top, '导入', '导入以前做过的 HTML', () => openImport(importBtn));
    const batchBtn = btn(top, '📝 清单', '打开待发清单', () => cb.batch()); batchBtn.hidden = true;
    sep(top);
    btn(top, '+页', '在当前页之后插入空白页', () => cb.addSlide());
    const delSlide = btn(top, '−页', '删除当前页', () => cb.removeSlide());
    const status = el('span', 'ppt-status', top, '连接中…');

    // ---- selection frame + handles ----
    const frame = el('div', 'ppt-abs ppt-frame', ui); frame.hidden = true;
    const grab = (d, h) => d.addEventListener('mousedown', (e) => { if (e.button === 0) { e.preventDefault(); cb.startResize(h, e); } });
    const handles = HANDLES.map((h) => { const d = el('div', 'ppt-handle', frame); d.dataset.handle = h; grab(d, h); return d; });
    const rot = el('div', 'ppt-handle ppt-rot', frame); rot.dataset.handle = 'rot'; rot.title = '旋转（Shift：每 15°）'; grab(rot, 'rot');
    const ends = ['p1', 'p2'].map((h) => { const d = el('div', 'ppt-abs ppt-handle ppt-end', ui); d.dataset.handle = h; d.hidden = true; grab(d, h); return d; });

    // ---- colour popover ----
    const pop = el('div', 'ppt-abs ppt-colors', ui); pop.hidden = true;
    function openColors(anchor, onPick) {
      pop.textContent = ''; pop.hidden = false;
      const done = (c) => { pop.hidden = true; onPick(c); };
      const row = (title, colors) => {
        if (!colors.length) return;
        const r = el('div', 'ppt-row', pop); el('span', 'who', r, title);
        colors.forEach((c) => { btn(r, '', c, () => done(c), 'ppt-swatch').style.background = c; });
      };
      row('主题', cb.themeColors()); row('常用', COMMON); row('最近', cb.recentColors());
      const r = el('div', 'ppt-row', pop);
      const custom = el('input', null, r); custom.type = 'color'; custom.title = '自定义颜色';
      custom.addEventListener('change', () => done(custom.value));
      btn(r, '无', '无', () => done(null));
      const ar = anchor.getBoundingClientRect();
      cb.place(pop, { left: Math.max(8, Math.min(ar.left, innerWidth - 260)), top: ar.bottom + 4 });
    }
    // ---- shape menu: pick a kind, then drag (or click) on a slide ----
    const SHAPES = [['rect', '矩形'], ['round', '圆角矩形'], ['ellipse', '椭圆'], ['triangle', '三角形'], ['line', '直线'], ['arrow', '箭头'], ['arrow2', '双向箭头']];
    const menu = el('div', 'ppt-abs ppt-menu', ui); menu.hidden = true;
    SHAPES.forEach(([k, l]) => btn(menu, l, `画${l}`, () => { menu.hidden = true; cb.armShape(k); }));
    function openMenu(anchor) { const ar = anchor.getBoundingClientRect(); menu.hidden = false; cb.place(menu, { left: ar.left, top: ar.bottom + 4 }); }

    // ---- icon panel: search the Lucide library, or describe one for Claude to draw ----
    const icons = el('div', 'ppt-abs ppt-icons', ui); icons.hidden = true;
    for (const p of [menu, icons]) p.addEventListener('keydown', (k) => { if (k.key === 'Escape') p.hidden = true; });
    function openIcons(anchor) {
      icons.textContent = ''; icons.hidden = false;
      const q = el('input', null, icons); q.placeholder = '搜索图标（中文或英文）';
      const grid = el('div', 'ppt-icon-grid', icons);
      const show = () => {
        grid.textContent = '';
        if (!window.PPTIcons) { el('p', 'who', grid, '图标库未生成：运行 python tools/build_icons.py（"让 Claude 画"仍可用）'); return; }
        for (const n of searchIcons(window.PPTIcons, window.PPTIconsZh || {}, q.value)) {
          const ib = btn(grid, '', n, () => { icons.hidden = true; cb.addIcon(n); }, 'ppt-icon');
          ib.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${window.PPTIcons[n].body}</svg>`;
        }
      };
      q.addEventListener('input', show); show();
      const r = el('div', 'ppt-row', icons);
      const d = el('input', null, r); d.placeholder = '没有合适的？描述一下，让 Claude 画';
      const go = () => { if (d.value.trim()) { icons.hidden = true; cb.drawIcon(d.value.trim()); } };
      btn(r, '让 Claude 画', '让 Claude 画一个图标', go);
      d.addEventListener('keydown', (k) => { if (k.key === 'Enter') { k.preventDefault(); go(); } });
      const ar = anchor.getBoundingClientRect();
      cb.place(icons, { left: Math.max(8, Math.min(ar.left, innerWidth - 348)), top: ar.bottom + 4 });
      setTimeout(() => q.focus());
    }
    // ---- import dialog: an old html (or a zip with its pictures), or a web page ----
    const imp = el('div', 'ppt-abs ppt-icons ppt-import', ui); imp.hidden = true;
    imp.addEventListener('keydown', (k) => { if (k.key === 'Escape') imp.hidden = true; });
    function openImport(anchor) {
      imp.textContent = ''; imp.hidden = false;
      el('b', null, imp, '导入以前做过的 HTML');
      const row = el('div', 'ppt-row', imp);
      const mode = el('select', null, row); mode.title = '放到哪';
      [['append', '追加到末尾'], ['replace', '替换当前 deck']].forEach(([v, l]) => { el('option', null, mode, l).value = v; });
      mode.value = cb.importMode();
      const file = el('input', null, row); file.type = 'file'; file.accept = '.html,.htm,.zip'; file.hidden = true;
      file.addEventListener('change', () => { if (file.files[0]) { imp.hidden = true; cb.importFile(file.files[0], mode.value); } file.value = ''; });
      btn(row, '选择文件', '选择 .html / .htm，或把 HTML 和图片打包成 .zip', () => file.click());
      const r2 = el('div', 'ppt-row', imp);
      const url = el('input', null, r2); url.placeholder = '或粘贴网页网址 https://…';
      const go = () => { if (url.value.trim()) { imp.hidden = true; cb.importUrl(url.value.trim(), mode.value); } };
      url.addEventListener('keydown', (k) => { if (k.key === 'Enter') { k.preventDefault(); go(); } });
      btn(r2, '导入', '导入这个网页', go);
      const ar = anchor.getBoundingClientRect();
      cb.place(imp, { left: Math.max(8, Math.min(ar.left, innerWidth - 348)), top: ar.bottom + 4 });
    }
    const popups = [pop, menu, icons, imp];
    document.addEventListener('mousedown', (e) => {
      for (const p of popups) if (!p.hidden && !p.contains(e.target) && !e.target.closest('.ppt-colorbtn')) p.hidden = true;
    }, true);
    const colorBtn = (parent, label, title, onPick) => { const b = btn(parent, label, title, () => openColors(b, onPick), 'ppt-colorbtn'); return b; };

    // ---- floating bars: one per kind of selection ----
    const bars = {};
    const mkBar = (k) => { const b = el('div', 'ppt-abs ppt-bar', ui); b.hidden = true; return (bars[k] = b); };
    const tail = (b, z) => {
      sep(b);
      if (z) { btn(b, '⤒', '置顶', () => cb.z('top')); btn(b, '⤓', '置底', () => cb.z('bottom')); sep(b); }
      btn(b, '🗑', '删除', () => cb.remove());
      btn(b, '💬 问 Claude', '问 Claude', () => cb.ask(), 'ppt-ask');
    };
    const borders = (b) => {
      colorBtn(b, '□', '边框颜色', (c) => cb.border({ color: c }));
      pick(b, '边框粗细', [0, 1, 2, 4, 8], (v) => (+v ? `${v}px` : '无边框'), (v) => cb.border({ width: +v }));
    };
    const opacity = (b) => pick(b, '透明度', OPACITY, (v) => `${v}%`, (v) => cb.blockStyle({ opacity: +v === 100 ? null : String(v / 100) }));

    let b = mkBar('block');
    colorBtn(b, 'A', '字色', (c) => cb.textStyle({ color: c }));
    pick(b, '字号', SIZES, (v) => `${v}`, (v) => cb.textStyle({ 'font-size': `${v}px` }));
    btn(b, 'B', '加粗', () => cb.toggle('bold'), 'ppt-b');
    btn(b, 'I', '斜体', () => cb.toggle('italic'), 'ppt-i');
    btn(b, 'U', '下划线', () => cb.toggle('underline'), 'ppt-u');
    pick(b, '对齐', ['left', 'center', 'right'], (v) => ({ left: '左对齐', center: '居中', right: '右对齐' })[v], (v) => cb.blockStyle({ 'text-align': v }));
    sep(b);
    colorBtn(b, '■', '背景色', (c) => cb.blockStyle({ background: c }));
    borders(b);
    pick(b, '圆角', [0, 4, 8, 16, 24], (v) => `${v}px`, (v) => cb.blockStyle({ 'border-radius': +v ? `${v}px` : null }));
    btn(b, '▣', '阴影', () => cb.toggleShadow());
    tail(b, false);
    for (const k of ['shape', 'arrow']) {
      b = mkBar(k);
      if (k === 'shape') colorBtn(b, '■', '填充', (c) => cb.blockStyle({ fill: c || 'none' }));
      colorBtn(b, '／', '线条色', (c) => cb.blockStyle({ stroke: c || 'none' }));
      pick(b, '线宽', [1, 2, 3, 4, 6, 8], (v) => `${v}px`, (v) => cb.blockStyle({ 'stroke-width': v }));
      opacity(b);
      tail(b, true);
    }
    b = mkBar('icon');
    colorBtn(b, 'A', '颜色', (c) => cb.blockStyle({ color: c }));
    pick(b, '线宽', [1, 1.5, 2, 2.5, 3], (v) => `${v}`, (v) => cb.blockStyle({ 'stroke-width': v }));
    tail(b, true);
    b = mkBar('ink');
    colorBtn(b, 'A', '颜色', (c) => cb.inkColor(c));
    opacity(b);
    tail(b, true);
    b = mkBar('image');
    pick(b, '圆角', [0, 8, 16, 24, '50%'], (v) => (v === '50%' ? '圆形' : `${v}px`), (v) => cb.blockStyle({ 'border-radius': v === '50%' ? v : +v ? `${v}px` : null }));
    borders(b);
    opacity(b);
    tail(b, true);

    let target = null, kind = null;
    function reposition() {
      const bar = bars[kind];
      if (!target || !target.isConnected || !bar) {
        frame.hidden = true; ends.forEach((d) => { d.hidden = true; }); Object.values(bars).forEach((x) => { x.hidden = true; });
        return;
      }
      const r = target.getBoundingClientRect();
      if (kind === 'block') {
        cb.place(frame, { left: r.left, top: r.top, width: r.width, height: r.height }); frame.style.transform = '';
      } else { // objects: the frame follows the unrotated box and turns with it
        const sr = target.closest('section.slide').getBoundingClientRect(), g = G.geomOf(target), e = G.arrowEnds(target);
        cb.place(frame, G.slideToClient(sr, g)); frame.style.transform = g.rot ? `rotate(${g.rot}deg)` : '';
        if (e) ends.forEach((d, i) => { const p = G.slideToClient(sr, { x: i ? e.x2 : e.x1, y: i ? e.y2 : e.y1, w: 0, h: 0 }); cb.place(d, { left: p.left, top: p.top }); });
      }
      const bh = bar.offsetHeight || 36, bw = bar.offsetWidth || 560, topBar = top.offsetHeight + 8;
      const gap = rot.hidden ? 8 : 40; // keep the rotate handle above the frame clear of the bar
      cb.place(bar, { left: Math.max(8, Math.min(r.left, innerWidth - bw - 8)),
        top: r.top - bh - gap >= topBar ? r.top - bh - gap : Math.min(r.bottom + gap, innerHeight - bh - 8) });
    }
    function select(t, opts = {}) {
      target = t;
      kind = !t ? null : !t.classList.contains('obj') ? 'block' : bars[t.dataset.kind] ? t.dataset.kind : 'shape';
      Object.entries(bars).forEach(([k, x]) => { x.hidden = k !== kind; });
      frame.hidden = !t;
      const arrow = !!t && kind !== 'block' && !!G.arrowEnds(t);
      ends.forEach((d) => { d.hidden = !arrow; });
      if (!t) { pop.hidden = true; return; }
      handles.forEach((h) => { h.hidden = !opts.resizable || !!opts.editing || arrow; });
      rot.hidden = kind === 'block' || arrow || !!opts.editing;
      reposition();
    }
    return {
      select, reposition,
      setHistory(h) {
        undo.disabled = !h?.canUndo; redo.disabled = !h?.canRedo;
        const why = h && !h.ok ? '（历史记录不可用）' : '';
        undo.title = h?.canUndo ? `撤销：${h.undoLabel}` : `撤销${why || '（没有可撤销的修改）'}`;
        redo.title = h?.canRedo ? `重做：${h.redoLabel}` : `重做${why || '（没有可重做的修改）'}`;
      },
      setStatus(text, off) { status.textContent = text; status.classList.toggle('off', !!off); },
      setSlideCount(n) { delSlide.disabled = n < 2; },
      setBatchCount(n) { batchBtn.hidden = !n; batchBtn.textContent = `📝 清单 (${n})`; },
    };
  }

  window.PPTToolbar = { create, searchIcons };
})();
