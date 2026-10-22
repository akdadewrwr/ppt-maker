// ppt-maker knowledge base panel: files, websites, references and Claude Code skills, per project and global.
// UI only: everything goes through /api/kb*; "用在这一页" hands an intent to editor.js through cb.ask.
(() => {
  const ICON = { file: '📄', web: '🌐', visual: '🖼', cite: '📎', deck: '🗂' };
  const STATUS = { pending: '消化中', ready: '就绪', failed: '失败' };
  const KIND_ZH = { visual: '视觉参考', cite: '出处', deck: '旧 deck' };
  const SCOPE_ZH = { project: '项目', global: '全局' };
  const MAX = 50 * 1024 * 1024;

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
    const panel = el('div', 'ppt-kb', ui); panel.hidden = true;
    const head = el('div', 'ppt-kb-head', panel);
    el('b', null, head, '📚 知识库');
    let tab = 'files', state = null, shown = '', timer = null, viewing = null, cardText = null, dropTo = null;
    const tabs = {};
    for (const [k, l] of [['files', '资料'], ['refs', '参考'], ['skills', 'Skills']]) tabs[k] = btn(head, l, l, () => { tab = k; viewing = null; build(); }, 'ppt-kb-tab');
    btn(head, '×', '关闭知识库', () => toggle(false));
    const body = el('div', 'ppt-kb-body', panel), add = el('div', 'ppt-kb-add', body), list = el('div', null, body);

    async function call(p, opts = {}) {
      const r = await fetch(cb.api(p) + (opts.query || ''), opts);
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || String(r.status));
      return data;
    }
    const send = (method, data) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    async function refresh() {
      try { state = await call('/api/kb'); } catch (e) { state = { error: e.message }; }
      const key = JSON.stringify([state, tab, viewing, cardText]);
      if (key !== shown) { shown = key; renderList(); }
    }

    function build() { // the add area is rebuilt only when the tab changes, so typing survives the 2 s refresh
      Object.entries(tabs).forEach(([k, b]) => b.classList.toggle('on', k === tab));
      add.textContent = ''; dropTo = null;
      const row = el('div', 'ppt-row', add);
      const scope = el('select', null, row); scope.title = '范围';
      Object.entries(SCOPE_ZH).forEach(([v, l]) => { el('option', null, scope, l).value = v; });
      if (tab === 'skills') {
        const ta = el('textarea', null, add); ta.placeholder = '新建 Skill：描述你要的方法或规范，例如"我们公司的品牌规范：主色……字体……"';
        btn(add, `让 ${PPTAgent.name()} 写`, `让 ${PPTAgent.name()} 写这个 Skill`, async () => {
          if (!ta.value.trim()) return;
          try { await call('/api/kb/skill', send('POST', { scope: scope.value, text: ta.value.trim() })); ta.value = ''; cb.toast(`已发给 ${PPTAgent.name()}，写好后会出现在列表里`); }
          catch (e) { cb.toast(`没有发出：${e.message}`); }
        }, 'ppt-ask');
        shown = ''; renderList(); return;
      }
      let kind = null;
      if (tab === 'refs') { kind = el('select', null, row); kind.title = '参考类型'; Object.entries(KIND_ZH).forEach(([v, l]) => { el('option', null, kind, l).value = v; }); }
      const file = el('input', null, row); file.type = 'file'; file.multiple = true; file.hidden = true;
      const upload = async (f) => {
        if (f.size > MAX) return cb.toast(`${f.name} 超过 50MB`);
        const typ = tab === 'files' ? 'file' : 'ref', k = tab === 'refs' ? kind.value : '';
        if (typ === 'ref' && k === 'deck' && !/\.(pptx|pdf)$/i.test(f.name)) return cb.toast('旧 deck 请上传 PPTX 或 PDF，或者从下面的列表里选');
        try {
          const r = await call('/api/kb/file', { method: 'POST', body: f, query: `&scope=${scope.value}&type=${typ}&kind=${k}&name=${encodeURIComponent(f.name)}` });
          if (!r.created) cb.toast(`《${r.item.title}》已在知识库里`);
          refresh();
        } catch (e) { cb.toast(`${f.name} 没有加入：${e.message}`); }
      };
      dropTo = upload;
      file.addEventListener('change', () => { [...file.files].forEach(upload); file.value = ''; });
      btn(row, '选择文件', '选择文件（也可以拖进这里）', () => file.click());
      const r2 = el('div', 'ppt-row', add);
      const url = el('input', null, r2); url.placeholder = tab === 'files' ? '粘贴网址，例如 https://…' : '出处网址 https://…';
      const addUrl = async () => {
        if (!url.value.trim()) return;
        try {
          const r = await call('/api/kb/add', send('POST', { scope: scope.value, type: tab === 'files' ? 'web' : 'ref', kind: tab === 'refs' ? 'cite' : undefined, url: url.value.trim() }));
          if (!r.created) cb.toast('这个网址已在知识库里');
          url.value = ''; refresh();
        } catch (e) { cb.toast(`没有加入：${e.message}`); }
      };
      url.addEventListener('keydown', (k) => { if (k.key === 'Enter') { k.preventDefault(); addUrl(); } });
      btn(r2, '添加', '添加网址', addUrl);
      if (tab === 'refs') {
        const r3 = el('div', 'ppt-row', add);
        const deck = el('select', null, r3); deck.title = '旧 deck';
        (state?.decks || []).forEach((n) => { el('option', null, deck, n).value = n; });
        btn(r3, '添加旧 deck', '添加这个旧 deck', async () => {
          if (!deck.value) return cb.toast('这个项目的 decks 里还没有别的 deck');
          try { const r = await call('/api/kb/add', send('POST', { scope: scope.value, deck: deck.value })); if (!r.created) cb.toast('这个 deck 已在知识库里'); refresh(); }
          catch (e) { cb.toast(`没有加入：${e.message}`); }
        });
      }
      shown = ''; renderList();
    }

    function renderList() {
      list.textContent = '';
      if (!state) return;
      if (state.error) { el('p', 'ppt-kb-err', list, `知识库读取失败：${state.error}`); return; }
      if (tab === 'skills') return renderSkills();
      for (const scope of Object.keys(SCOPE_ZH)) {
        const s = state[scope];
        el('div', 'who', list, SCOPE_ZH[scope]);
        if (s.error) { el('p', 'ppt-kb-err', list, s.error); continue; }
        const mine = s.items.filter((i) => (tab === 'refs') === (i.type === 'ref'));
        if (!mine.length) el('p', 'ppt-kb-empty', list, '（还没有）');
        mine.forEach((i) => renderItem(scope, i));
      }
    }
    function renderItem(scope, i) {
      const row = el('div', `ppt-kb-item ${i.status}`, list);
      const top = el('div', null, row);
      el('span', null, top, `${ICON[i.kind || i.type] || '📄'} `);
      el('b', null, top, i.title);
      el('span', `ppt-kb-status ${i.status}`, top, STATUS[i.status] || i.status);
      if (i.summary) el('p', null, row, i.summary);
      if (i.note) el('p', 'ppt-kb-err', row, i.note);
      const acts = el('div', 'ppt-kb-acts', row);
      const key = `${scope}:${i.id}`;
      if (i.status === 'ready') btn(acts, '卡片', `查看 ${PPTAgent.name()} 写的卡片`, async () => {
        if (viewing === key) { viewing = null; cardText = null; return refresh(); }
        try { cardText = (await call('/api/kb/card', { query: `&scope=${scope}&id=${i.id}` })).text; viewing = key; } catch (e) { cb.toast(`卡片打不开：${e.message}`); }
        refresh();
      });
      btn(acts, '用在这一页', `让 ${PPTAgent.name()} 按这份资料改当前页`, () => cb.ask([i.id], i.title));
      btn(acts, '重新消化', `让 ${PPTAgent.name()} 重新读这份资料`, () => act('/api/kb/redigest', scope, i.id));
      btn(acts, '删除', '移到知识库的回收站', () => act('/api/kb/remove', scope, i.id));
      if (viewing === key && cardText != null) el('pre', 'ppt-kb-card', row, cardText);
    }
    async function act(p, scope, id) {
      try { await call(p, send('POST', { scope, id })); } catch (e) { cb.toast(`没有完成：${e.message}`); }
      refresh();
    }
    function renderSkills() {
      const on = new Set(state.enabled || []);
      for (const scope of Object.keys(SCOPE_ZH)) {
        el('div', 'who', list, SCOPE_ZH[scope]);
        const mine = (state.skills || []).filter((s) => s.scope === scope);
        if (!mine.length) el('p', 'ppt-kb-empty', list, '（还没有）');
        for (const s of mine) {
          const row = el('label', 'ppt-kb-skill', list);
          const box = el('input', null, row); box.type = 'checkbox'; box.checked = on.has(s.name); box.dataset.skill = s.name;
          const text = el('span', null, row); el('b', null, text, s.name); if (s.description) el('div', null, text, s.description);
          box.addEventListener('change', async () => {
            const names = [...list.querySelectorAll('input[type=checkbox][data-skill]')].filter((b) => b.checked).map((b) => b.dataset.skill);
            try { await call('/api/kb/skills', send('PUT', { skills: [...new Set(names)] })); } catch (e) { cb.toast(`没有保存：${e.message}`); }
            refresh();
          });
        }
      }
    }

    panel.addEventListener('dragover', (e) => { if (dropTo) e.preventDefault(); });
    panel.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); if (dropTo) [...(e.dataTransfer?.files || [])].forEach(dropTo); });
    function toggle(open = panel.hidden) {
      panel.hidden = !open;
      clearInterval(timer); timer = null;
      if (!open) return;
      refresh().then(build);
      timer = setInterval(refresh, 2000);
    }
    return { toggle };
  }

  window.PPTKB = { create };
})();
