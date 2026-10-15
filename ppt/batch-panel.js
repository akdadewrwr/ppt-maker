// ppt-maker batch panel: the 待发清单 — edit or drop items, find them, add an overall note, send them as one intent.
// UI only: the list itself lives in editor.js (cb.get / cb.set / cb.send / cb.locate).
(() => {
  function create(ui, cb) {
    const el = (tag, cls, parent, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      if (parent) parent.appendChild(e);
      return e;
    };
    const btn = (parent, label, title, fn, cls = '') => {
      const b = el('button', `ppt-btn ${cls}`, parent, label); b.type = 'button'; b.title = title; b.addEventListener('click', fn); return b;
    };
    const panel = el('div', 'ppt-kb ppt-batch', ui); panel.hidden = true;
    const head = el('div', 'ppt-kb-head', panel);
    el('b', null, head, '📝 待发清单');
    btn(head, '×', '关闭清单', () => toggle(false));
    const body = el('div', 'ppt-kb-body', panel);
    const mark = (i) => (i < 20 ? String.fromCharCode(0x2460 + i) : `(${i + 1})`);

    function refresh() {
      if (panel.hidden) return;
      const b = cb.get();
      body.textContent = '';
      const note = el('textarea', 'ppt-batch-note', body);
      note.placeholder = '总体说明（可选）：例如"第 2 页整体改成左右对比结构，配色统一"';
      note.value = b.note || '';
      note.addEventListener('input', () => cb.set({ ...cb.get(), note: note.value }, false));
      const row = el('div', 'ppt-row', body);
      btn(row, `全部发送（${b.items.length} 条）`, '把清单作为一个整体发给 Claude', () => cb.send(), 'ppt-ask');
      btn(row, '清空', '清空待发清单', () => cb.set({ note: '', items: [] }));
      b.items.forEach((it, i) => {
        const card = el('div', 'ppt-kb-item', body);
        const tags = [it.kind === 'sketch' && '草图', it.kb && '参考资料', it.quote && '选中文字'].filter(Boolean);
        el('b', null, el('div', null, card), `${mark(i)} 第 ${it.slide || '?'} 页${tags.length ? ` · ${tags.join(' · ')}` : ''}`);
        if (typeof it.shot === 'string' && it.shot.startsWith('data:image/png')) el('img', 'ppt-batch-shot', card).src = it.shot;
        const ta = el('textarea', null, card); ta.value = it.text || '';
        ta.addEventListener('input', () => { const cur = cb.get(); if (cur.items[i]) { cur.items[i].text = ta.value; cb.set(cur, false); } });
        const acts = el('div', 'ppt-kb-acts', card);
        btn(acts, '定位', '滚到这一条所在的页', () => cb.locate(it));
        btn(acts, '删除', '从清单里删掉这一条', () => { const cur = cb.get(); cur.items.splice(i, 1); cb.set(cur); });
      });
    }
    function toggle(open = panel.hidden) { panel.hidden = !open; refresh(); }
    return { toggle, refresh };
  }

  window.PPTBatch = { create };
})();
