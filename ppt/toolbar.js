// ppt-maker toolbars: top bar, floating bar, colour popover, selection frame + handles.
// UI only: every action goes back to editor.js through the callbacks given to create().
(() => {
  const COMMON = ['#000000', '#ffffff', '#6b7280', '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#2563eb', '#8b5cf6'];
  const SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 56, 72];
  const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

  function create(ui, cb) {
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
    for (const l of ['+形状', '+图片', '+图标']) btn(top, l, '下一版提供', () => {}).disabled = true;
    sep(top);
    btn(top, '+页', '在当前页之后插入空白页', () => cb.addSlide());
    const delSlide = btn(top, '−页', '删除当前页', () => cb.removeSlide());
    const status = el('span', 'ppt-status', top, '连接中…');

    // ---- selection frame + handles ----
    const frame = el('div', 'ppt-abs ppt-frame', ui); frame.hidden = true;
    const handles = HANDLES.map((h) => {
      const d = el('div', 'ppt-handle', frame); d.dataset.handle = h;
      d.addEventListener('mousedown', (e) => { if (e.button === 0) { e.preventDefault(); cb.startResize(h, e); } });
      return d;
    });

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
    document.addEventListener('mousedown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('.ppt-colorbtn')) pop.hidden = true; }, true);
    const colorBtn = (parent, label, title, onPick) => { const b = btn(parent, label, title, () => openColors(b, onPick), 'ppt-colorbtn'); return b; };

    // ---- floating bar (blocks) ----
    const bar = el('div', 'ppt-abs ppt-bar', ui); bar.hidden = true;
    colorBtn(bar, 'A', '字色', (c) => cb.textStyle({ color: c }));
    pick(bar, '字号', SIZES, (v) => `${v}`, (v) => cb.textStyle({ 'font-size': `${v}px` }));
    btn(bar, 'B', '加粗', () => cb.toggle('bold'), 'ppt-b');
    btn(bar, 'I', '斜体', () => cb.toggle('italic'), 'ppt-i');
    btn(bar, 'U', '下划线', () => cb.toggle('underline'), 'ppt-u');
    pick(bar, '对齐', ['left', 'center', 'right'], (v) => ({ left: '左对齐', center: '居中', right: '右对齐' })[v], (v) => cb.blockStyle({ 'text-align': v }));
    sep(bar);
    colorBtn(bar, '■', '背景色', (c) => cb.blockStyle({ background: c }));
    colorBtn(bar, '□', '边框颜色', (c) => cb.border({ color: c }));
    pick(bar, '边框粗细', [0, 1, 2, 4, 8], (v) => (+v ? `${v}px` : '无边框'), (v) => cb.border({ width: +v }));
    pick(bar, '圆角', [0, 4, 8, 16, 24], (v) => `${v}px`, (v) => cb.blockStyle({ 'border-radius': +v ? `${v}px` : null }));
    btn(bar, '▣', '阴影', () => cb.toggleShadow());
    sep(bar);
    btn(bar, '🗑', '删除', () => cb.remove());
    btn(bar, '💬 问 Claude', '问 Claude', () => cb.ask(), 'ppt-ask');

    let target = null;
    function reposition() {
      if (!target || !target.isConnected) { frame.hidden = bar.hidden = true; return; }
      const r = target.getBoundingClientRect();
      cb.place(frame, { left: r.left, top: r.top, width: r.width, height: r.height });
      const bh = bar.offsetHeight || 36, bw = bar.offsetWidth || 560, topBar = top.offsetHeight + 8;
      cb.place(bar, { left: Math.max(8, Math.min(r.left, innerWidth - bw - 8)),
        top: r.top - bh - 8 >= topBar ? r.top - bh - 8 : Math.min(r.bottom + 8, innerHeight - bh - 8) });
    }
    function select(t, opts = {}) {
      target = t;
      frame.hidden = bar.hidden = !t;
      if (!t) { pop.hidden = true; return; }
      handles.forEach((h) => { h.hidden = !opts.resizable || !!opts.editing; });
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
    };
  }

  window.PPTToolbar = { create };
})();
