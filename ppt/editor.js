// ppt-maker editor layer: injected by server.py, never saved into deck.html.
// Every node it adds carries data-ppt (stripped on save) or lives in #ppt-ui.
(() => {
  const G = window.PPTGeom, TOKEN = window.PPT.token;
  let version = window.PPT.version, saving = false, editing = null, drag = null, pop = null, lastKey = '';
  let replayPending = false; // a save failed offline: reload+replay once the server is back
  const api = (p) => `${p}?t=${encodeURIComponent(TOKEN)}`;
  const slides = () => [...document.querySelectorAll('section.slide')];
  const ls = {
    get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  };
  function el(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function place(node, r) { // r: viewport rect -> document-absolute position inside #ppt-ui
    Object.assign(node.style, { left: `${r.left + scrollX}px`, top: `${r.top + scrollY}px`,
      width: r.width == null ? '' : `${r.width}px`, height: r.height == null ? '' : `${r.height}px` });
  }
  function panelBeside(cr, right) { // 320px panel: right of cr if it fits, else below; always inside the viewport
    const W = 320, pad = 8;
    if (right && cr.left + cr.width + pad + W <= innerWidth - pad) return { left: cr.left + cr.width + pad, top: cr.top };
    return { left: Math.max(pad, Math.min(cr.left, innerWidth - W - pad)), top: cr.top + cr.height + pad };
  }

  const ui = el('div', null, document.body); ui.id = 'ppt-ui'; ui.setAttribute('data-ppt', '');
  const status = el('div', 'ppt-status', ui, '连接中…');
  const marks = el('div', null, ui);

  // ---- fit, reload, scroll restore ----
  function fit() { document.documentElement.style.setProperty('--ppt-zoom', String(Math.min(1, (innerWidth - 48) / G.W))); lastKey = ''; }
  function reload() { sessionStorage.setItem('ppt-scroll', String(scrollY)); location.reload(); }
  addEventListener('resize', () => { fit(); render(); });
  fit();
  const sy = sessionStorage.getItem('ppt-scroll');
  if (sy) { sessionStorage.removeItem('ppt-scroll'); requestAnimationFrame(() => scrollTo(0, +sy)); }

  // ---- event queue (survives server restarts) ----
  let flushing = false, online = false, offline = false, state = null;
  function enqueue(ev) {
    const q = [...ls.get('ppt-queue', []), ev];
    if (!ls.set('ppt-queue', q)) ls.set('ppt-queue', q.map((e) => ({ ...e, shot: undefined }))); // quota: drop screenshots
    flush();
  }
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      let q = ls.get('ppt-queue', []);
      while (q.length) {
        const r = await fetch(api('/api/event'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q[0]) });
        if (!r.ok && r.status !== 400) break; // 400 = malformed, drop it; anything else retry later
        q = q.slice(1); ls.set('ppt-queue', q);
      }
    } catch { /* offline: poll() will retry */ } finally { flushing = false; render(); }
  }

  // ---- polling ----
  async function poll() {
    try {
      const r = await fetch(api('/api/state'), { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      state = await r.json(); offline = false; online = state.online;
      if (!editing && !saving && (state.version !== version || replayPending)) return reload();
      flush();
    } catch { offline = true; }
    render();
  }
  setInterval(poll, 1000);
  poll();

  // ---- rendering: status pill + per-intent marks and reply bubbles ----
  function render() {
    const pending = ls.get('ppt-queue', []).length;
    status.className = 'ppt-status' + (offline ? ' off' : '');
    status.textContent = offline ? `服务断开${pending ? ` · ${pending} 条待发送` : ''}`
      : `${online ? '● Claude 在线' : '○ Claude 离线'}${pending ? ` · ${pending} 条发送中` : ''}`;
    if (!state || (document.activeElement && document.activeElement.closest('.ppt-bubble'))) return; // don't wipe a half-typed answer
    const key = JSON.stringify([state.events, ls.get('ppt-dismissed', []), scrollX, document.documentElement.style.cssText]);
    if (key === lastKey) return;
    lastKey = key;
    marks.textContent = '';
    const dismissed = new Set(ls.get('ppt-dismissed', []));
    const threads = new Map();
    for (const e of state.events) {
      const root = e.type === 'intent' ? e.id : e.re;
      if (!threads.has(root)) threads.set(root, []);
      threads.get(root).push(e);
    }
    for (const [rootId, items] of threads) {
      const root = items[0], slide = document.getElementById(root.slide_id || '');
      if (root.type !== 'intent' || !root.rect || !slide || dismissed.has(rootId)) continue;
      const last = items[items.length - 1], sr = slide.getBoundingClientRect(), cr = G.slideToClient(sr, root.rect);
      const m = el('div', `ppt-abs ppt-mark ${last.status}`, marks);
      place(m, cr);
      el('b', null, m, `#${rootId} ${{ queued: '排队中', processing: '处理中', done: '已完成' }[last.status]}`);
      if (!items.some((e) => e.reply)) continue;
      const bub = el('div', 'ppt-abs ppt-bubble', marks);
      place(bub, panelBeside(cr, true));
      const x = el('button', 'x', bub, '×'); x.title = '关闭';
      x.onclick = () => { ls.set('ppt-dismissed', [...dismissed, rootId]); render(); };
      for (const e of items) {
        el('p', null, bub).append(el('span', 'who', null, '你：'), e.text);
        if (e.reply) el('p', null, bub).append(el('span', 'who', null, 'Claude：'), e.reply);
      }
      const ta = el('textarea', null, bub); ta.placeholder = '回复 Claude…（Enter 发送）';
      ta.onkeydown = (k) => {
        if (k.key !== 'Enter' || k.shiftKey || !ta.value.trim()) return;
        k.preventDefault();
        enqueue({ type: 'answer', re: rootId, slide_id: root.slide_id, text: ta.value.trim() });
        ta.blur(); lastKey = '';
      };
    }
  }

  // ---- select an area (drag) or a block (click) -> intent popup ----
  function closePop() { if (pop) { pop.box.remove(); pop.node.remove(); pop = null; } }
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || editing || e.target.closest('#ppt-ui')) return;
    const slide = e.target.closest('section.slide');
    if (!slide) return;
    e.preventDefault();
    closePop();
    drag = { slide, x0: e.clientX, y0: e.clientY, box: el('div', 'ppt-abs ppt-sel', ui) };
    place(drag.box, { left: e.clientX, top: e.clientY, width: 0, height: 0 });
  });
  addEventListener('mousemove', (e) => {
    if (!drag) return;
    const sr = drag.slide.getBoundingClientRect();
    place(drag.box, G.slideToClient(sr, G.clientToSlide(sr, drag.x0, drag.y0, e.clientX, e.clientY)));
  });
  addEventListener('mouseup', (e) => {
    if (!drag) return;
    const { slide, x0, y0, box } = drag; drag = null;
    const sr = slide.getBoundingClientRect();
    let r = G.clientToSlide(sr, x0, y0, e.clientX, e.clientY);
    if (r.w < 6 && r.h < 6) { // a click selects the innermost block under the pointer
      const b = document.elementFromPoint(e.clientX, e.clientY)?.closest('.block');
      if (!b || !slide.contains(b)) { box.remove(); return; }
      r = G.elementRect(sr, b);
    }
    const cr = G.slideToClient(sr, r);
    place(box, cr);
    const node = el('div', 'ppt-abs ppt-pop', ui);
    place(node, panelBeside(cr, false));
    el('div', 'who', node, `第 ${slides().indexOf(slide) + 1} 页 · 网格 ${G.rectToCells(r)}`);
    const ta = el('textarea', null, node); ta.placeholder = '想怎么改这里？Enter 发送 · Shift+Enter 换行 · Esc 取消';
    pop = { box, node };
    setTimeout(() => ta.focus());
    ta.onkeydown = (k) => {
      if (k.key === 'Escape') return closePop();
      if (k.key !== 'Enter' || k.shiftKey) return;
      k.preventDefault();
      const text = ta.value.trim();
      if (!text) return;
      closePop();
      submitIntent(slide, r, text);
    };
  });

  async function submitIntent(slide, r, text) {
    let shot = null;
    try {
      const full = await htmlToImage.toCanvas(slide, { width: G.W, height: G.H, pixelRatio: 1, style: { zoom: '1', margin: '0' } });
      const c = document.createElement('canvas');
      c.width = Math.max(1, r.w); c.height = Math.max(1, r.h);
      c.getContext('2d').drawImage(full, r.x, r.y, c.width, c.height, 0, 0, c.width, c.height);
      shot = c.toDataURL('image/png');
    } catch (err) { console.warn('[ppt] screenshot failed', err); }
    enqueue({ type: 'intent', slide: slides().indexOf(slide) + 1, slide_id: slide.id, rect: r,
              cells: G.rectToCells(r), blocks: G.hitBlocks(slide, r), text, shot });
  }

  // ---- direct text editing (double-click a leaf block) ----
  document.addEventListener('dblclick', (e) => {
    const b = e.target.closest('section.slide .block');
    if (!b || editing || b.querySelector('.block') || !b.id) return;
    closePop();
    editing = { block: b, before: b.innerHTML };
    b.contentEditable = 'true';
    b.focus();
    b.addEventListener('blur', endEdit, { once: true });
  });
  async function endEdit() {
    const { block, before } = editing;
    block.removeAttribute('contenteditable');
    editing = null;
    if (block.innerHTML !== before) await saveDeck(block);
  }
  function serialize() {
    const doc = document.documentElement.cloneNode(true);
    doc.querySelectorAll('[data-ppt]').forEach((n) => n.remove());
    doc.querySelectorAll('[contenteditable]').forEach((n) => n.removeAttribute('contenteditable'));
    doc.querySelectorAll('.ppt-lint').forEach((n) => n.classList.remove('ppt-lint'));
    doc.style.removeProperty('--ppt-zoom');
    if (!doc.getAttribute('style')) doc.removeAttribute('style');
    return '<!doctype html>\n' + doc.outerHTML;
  }
  async function saveDeck(block) {
    const replay = JSON.stringify({ id: block.id, html: block.innerHTML });
    saving = true;
    try {
      const r = await fetch(api('/api/deck'), { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version, html: serialize(), block: block.id, slide_id: block.closest('section.slide')?.id }) });
      if (r.status === 409) { sessionStorage.setItem('ppt-replay', replay); saving = false; return reload(); }
      if (!r.ok) throw new Error(String(r.status));
      version = (await r.json()).version;
      sessionStorage.removeItem('ppt-replay');
      runLint();
    } catch { sessionStorage.setItem('ppt-replay', replay); replayPending = true; offline = true; render(); } // next good poll reloads and replays
    finally { saving = false; }
  }
  function toast(msg, text) {
    const t = el('div', 'ppt-toast', ui);
    const x = el('button', 'x', t, '×'); x.onclick = () => t.remove();
    el('p', null, t, msg);
    if (text != null) { const ta = el('textarea', null, t); ta.value = text; ta.readOnly = true; }
  }
  function applyReplay() { // after a 409/offline save: re-apply the user's edit onto the fresh file by block id
    const raw = sessionStorage.getItem('ppt-replay');
    if (!raw) return;
    const { id, html } = JSON.parse(raw);
    const b = document.getElementById(id);
    if (!b) { sessionStorage.removeItem('ppt-replay'); return toast('你改的那一块已被 Claude 删除，改动未保存，内容如下：', html); }
    b.innerHTML = html;
    saveDeck(b);
  }

  // ---- lint: the page looks at the render so Claude doesn't have to ----
  function runLint() {
    const issues = slides().flatMap((s) => G.lint(s));
    document.querySelectorAll('.ppt-lint').forEach((n) => n.classList.remove('ppt-lint'));
    issues.forEach((i) => i.block && document.getElementById(i.block)?.classList.add('ppt-lint'));
    const keys = issues.map((i) => `${i.slide_id}:${i.block}:${i.kind}:${i.other || ''}`);
    const seen = new Set(ls.get('ppt-lint-seen', []));
    const fresh = issues.filter((_, n) => !seen.has(keys[n]));
    ls.set('ppt-lint-seen', keys); // fixed issues drop out, so a recurrence is reported again
    if (fresh.length) enqueue({ type: 'lint', issues: fresh });
  }
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => { applyReplay(); runLint(); });
})();
