// Browser-driven checks for the editor layer (dev only): node tests/e2e.mjs [repo]
// Needs Node >= 22 and Edge or Chrome. Uses decks/e2e-smoke only — never touches other decks.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const REPO = process.argv[2] || process.cwd();
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-e2e-'));
const DECK = path.join(REPO, 'decks', 'e2e-smoke');
const EDGE = process.env.PPT_BROWSER || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium',
].find((p) => fs.existsSync(p));
if (!EDGE) { console.error('no Edge/Chrome found; set PPT_BROWSER'); process.exit(2); }
const PORT = 8800, DBG = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = '') => { results.push([ok, name]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`); };
const inbox = () => { const f = path.join(DECK, '.ppt', 'inbox.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; };
const deckHtml = () => fs.readFileSync(path.join(DECK, 'deck.html'), 'utf8');
const py = (...a) => execFileSync('python', ['ppt/server.py', ...a], { cwd: REPO });
function png(w, h) { // solid grey 8-bit greyscale PNG, enough to test sizing
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4); data.copy(b, 8); b.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])), 8 + data.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h, 0x80); for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// --- deck with 3 slides so scroll restore is observable ---
fs.rmSync(DECK, { recursive: true, force: true }); // only our own smoke deck, never the user's decks
fs.mkdirSync(DECK, { recursive: true });
let tpl = fs.readFileSync(path.join(REPO, 'ppt', 'template.html'), 'utf8');
const sec = tpl.match(/<section[\s\S]*?<\/section>/)[0];
const more = [2, 3].map((n) => sec.replaceAll('s-cover', `s-p${n}`).replaceAll('b-cover-', `b-p${n}-`)).join('\n');
fs.writeFileSync(path.join(DECK, 'deck.html'), tpl.replace(sec, sec + '\n' + more));

// --- server ---
let server, url;
async function startServer() {
  server = spawn('python', ['ppt/server.py', 'decks/e2e-smoke', '--no-open', '--port', String(PORT)], { cwd: REPO });
  url = await new Promise((res) => server.stdout.on('data', (d) => { const m = String(d).match(/http\S+/); if (m) res(m[0]); }));
}
await startServer();

// --- browser ---
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${DBG}`, `--user-data-dir=${path.join(SCRATCH, 'edge-prof')}`, '--window-size=1400,900', 'about:blank']);
let ws;
for (let i = 0; i < 50 && !ws; i++) {
  try { const t = (await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json()).find((x) => x.type === 'page'); ws = new WebSocket(t.webSocketDebuggerUrl); } catch { await sleep(200); }
}
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0; const pending = new Map(); const errors = [];
ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map((a) => a.value).join(' '));
});
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; };
const mouse = (type, x, y, clickCount = 1, modifiers = 0) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount, modifiers });
async function drag(x0, y0, x1, y1, modifiers = 0) { await mouse('mousePressed', x0, y0, 1, modifiers); for (let i = 1; i <= 5; i++) await mouse('mouseMoved', x0 + (x1 - x0) * i / 5, y0 + (y1 - y0) * i / 5, 1, modifiers); await mouse('mouseReleased', x1, y1, 1, modifiers); }
async function click(x, y) { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); }
async function dblclick(x, y) { await click(x, y); await mouse('mousePressed', x, y, 2); await mouse('mouseReleased', x, y, 2); }
const type = (t) => send('Input.insertText', { text: t });
const enter = async () => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); };
const shot = async (name) => { const r = await send('Page.captureScreenshot'); fs.writeFileSync(path.join(SCRATCH, name), Buffer.from(r.result.data, 'base64')); };
const rectOf = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); const b = e.getBoundingClientRect(); if (b.top < 0 || b.bottom > innerHeight) e.scrollIntoView({block: 'center'}); const r = e.getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2, l: r.left, t: r.top, w: r.width, h: r.height}; })()`);
const statusText = () => ev(`document.querySelector('.ppt-status').textContent`);

const byTitle = (t) => ev(`(() => { const b = [...document.querySelectorAll('#ppt-ui [title]')].find((n) => n.title.startsWith(${JSON.stringify(t)}) && n.offsetParent); if (!b) return null; const r = b.getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: !!b.disabled}; })()`);
const key = (k, code, vk, modifiers = 0) => send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers })
  .then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers }));
const kZoom = () => ev(`document.querySelector('section.slide').getBoundingClientRect().width / 1280`);
await send('Runtime.enable'); await send('Page.enable');
async function open(u) { await send('Page.navigate', { url: u }); await sleep(1800); }

try {
  // 1. offline status, fit to narrow width
  await open(url);
  check('1 status shows Claude offline', (await statusText()).includes('离线'), await statusText());
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const fitInfo = await ev(`({zoom: getComputedStyle(document.documentElement).getPropertyValue('--ppt-zoom'), sw: document.documentElement.scrollWidth, iw: innerWidth})`);
  check('1 narrow window: slides zoomed, no horizontal scroll', fitInfo.sw <= fitInfo.iw && +fitInfo.zoom < 1, JSON.stringify(fitInfo));
  await shot('1-narrow.png');

  // 2. drag-select title -> intent with screenshot
  const t = await rectOf('#b-cover-title');
  await drag(t.l + 5, t.t + 5, t.l + t.w - 5, t.t + t.h - 5);
  await sleep(200);
  const popText = await ev(`document.querySelector('.ppt-pop')?.textContent`);
  check('2 popup shows page + cells', /第 1 页 · 网格 \d+-\d+\/\d+-\d+/.test(popText || ''), popText);
  await type('测试'); await enter(); await sleep(1500);
  const e1 = inbox()[0];
  check('2 intent e1 stored', e1?.type === 'intent' && e1.text === '测试' && e1.blocks?.[0] === 'b-cover-title', JSON.stringify({ ...e1, ts: undefined }));
  const shotFile = e1?.shot && path.join(DECK, e1.shot);
  check('2 screenshot saved', !!shotFile && fs.existsSync(shotFile) && fs.statSync(shotFile).size > 200, shotFile);
  if (shotFile && fs.existsSync(shotFile)) fs.copyFileSync(shotFile, path.join(SCRATCH, '2-e1-crop.png'));

  // 3. statuses + bubble + answer
  await sleep(1200);
  check('3 mark queued', (await ev(`document.querySelector('.ppt-mark b')?.textContent`)) === '#e1 排队中');
  py('--reply', 'decks/e2e-smoke', 'e1', '--ack'); await sleep(1500);
  check('3 mark processing', (await ev(`document.querySelector('.ppt-mark b')?.textContent`)) === '#e1 处理中');
  py('--reply', 'decks/e2e-smoke', 'e1', '收到'); await sleep(1500);
  check('3 mark done + bubble', (await ev(`document.querySelector('.ppt-mark b')?.textContent`)) === '#e1 已完成' && (await ev(`document.querySelector('.ppt-bubble')?.textContent`) || '').includes('收到'));
  await shot('3-bubble.png');
  const bw = await ev(`({sw: document.documentElement.scrollWidth, iw: innerWidth, r: document.querySelector('.ppt-bubble').getBoundingClientRect().right})`);
  check('3 bubble inside viewport, no horizontal scroll', bw.sw <= bw.iw && bw.r <= bw.iw, JSON.stringify(bw));
  const ta = await rectOf('.ppt-bubble textarea');
  await click(ta.x, ta.y); await type('再改改'); await enter(); await sleep(1500);
  const ans = inbox().find((e) => e.type === 'answer');
  check('3 answer re:e1', ans?.re === 'e1' && ans.text === '再改改', JSON.stringify(ans));

  // 4. direct text edit
  const sub = await rectOf('#b-cover-sub p');
  await dblclick(sub.x, sub.y); await sleep(200);
  check('4 block editable', (await ev(`document.activeElement?.id`)) === 'b-cover-sub');
  await type('X'); await click(5, 5); await sleep(1500);
  const h = deckHtml();
  check('4 deck saved with edit', /副标题X|X副标题|副X标题|副标X题/.test(h) || h.includes('X'), '');
  check('4 saved html is clean', !/data-ppt|contenteditable|ppt-lint|--ppt-zoom|ppt-ui/.test(h));
  check('4 edit event', inbox().at(-1)?.type === 'edit' && inbox().at(-1)?.block === 'b-cover-sub');
  await sleep(1500);

  // 5. external change -> reload, scroll kept
  await ev(`scrollTo(0, 600)`); await sleep(100);
  await ev(`window.__marker = 1`);
  fs.writeFileSync(path.join(DECK, 'deck.html'), deckHtml().replace('>标题<', '>标题A<'));
  await sleep(2500);
  const after = await ev(`({m: window.__marker, y: scrollY})`);
  check('5 page reloaded on file change', after.m === undefined, JSON.stringify(after));
  check('5 scroll position restored', Math.abs(after.y - 600) < 5, JSON.stringify(after));
  await ev(`scrollTo(0, 0)`); await sleep(200);

  // 6. conflict: edit while file changes -> replay
  const sub2 = await rectOf('#b-cover-sub p');
  await dblclick(sub2.x, sub2.y); await sleep(200); await type('Y');
  fs.writeFileSync(path.join(DECK, 'deck.html'), deckHtml().replace('>标题A<', '>标题B<'));
  await sleep(1500);
  check('6 no reload while editing', (await ev(`document.activeElement?.id`)) === 'b-cover-sub');
  await click(5, 5); await sleep(3500);
  const h6 = deckHtml();
  check('6 both changes kept after 409 replay', h6.includes('标题B') && h6.includes('Y'), '');

  // 7. offline queue
  server.kill(); await sleep(1800);
  check('7 status shows disconnected', (await statusText()).includes('服务断开'), await statusText());
  const t7 = await rectOf('#b-p2-title');
  await drag(t7.l + 5, t7.t + 5, t7.l + 200, t7.t + 60); await sleep(200);
  await type('离线时提交'); await enter(); await sleep(1500);
  check('7 shows 1 pending', (await statusText()).includes('1 条待发送'), await statusText());
  const n7 = inbox().length;
  await startServer(); await open(url); await sleep(1500);
  check('7 queued event delivered after restart', inbox().length > n7 && inbox().some((e) => e.text === '离线时提交'));

  // 8. lint
  fs.writeFileSync(path.join(DECK, 'deck.html'), deckHtml().replace('grid-area:6/2/7/16"><p style="font-size:24px;margin:0;color:var(--muted)">', 'grid-area:6/2/7/4"><p style="font-size:24px;margin:0;color:var(--muted)">很长很长很长很长很长很长很长很长很长很长很长很长的文字'));
  await sleep(3000);
  check('8 overflow block outlined', (await ev(`!!document.querySelector('#b-cover-sub.ppt-lint')`)) === true);
  const lints = () => inbox().filter((e) => e.type === 'lint').length;
  const n8 = lints();
  check('8 lint event sent', n8 >= 1 && JSON.stringify(inbox().filter((e) => e.type === 'lint').at(-1)).includes('overflow'));
  await send('Page.reload'); await sleep(2500);
  check('8 lint not re-sent on reload', lints() === n8, `${n8} -> ${lints()}`);
  await shot('8-lint.png');

  // ---- review fixes ----
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await open(url); await ev(`scrollTo(0,0)`); await sleep(300);
  // C1: event enqueued while a slow POST is in flight must not be lost
  await ev(`(() => { const f = window.fetch; window.fetch = async (u, o) => { if (o && o.method === 'POST') await new Promise(r => setTimeout(r, 800)); return f(u, o); }; })()`);
  const c1 = await rectOf('#b-p3-title');
  await drag(c1.l + 5, c1.t + 5, c1.l + 150, c1.t + 50); await sleep(150); await type('C1-first'); await enter(); await sleep(300);
  await drag(c1.l + 5, c1.t + 5, c1.l + 150, c1.t + 50); await sleep(150); await type('C1-second'); await enter(); await sleep(3000);
  check('C1 both queued intents reach inbox', inbox().some((e) => e.text === 'C1-first') && inbox().some((e) => e.text === 'C1-second'));
  // I1: half-typed intent survives a file change
  await open(url);
  const i1 = await rectOf('#b-p2-sub');
  await drag(i1.l + 3, i1.t + 3, i1.l + 120, i1.t + 30); await sleep(150); await type('半句话');
  fs.writeFileSync(path.join(DECK, 'deck.html'), deckHtml().replace('<title>', '<title>I1'));
  await sleep(2500);
  check('I1 popup text survives file change', (await ev(`document.querySelector('.ppt-pop textarea')?.value`)) === '半句话');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(2500); // deferred reload happens now
  // I3: foreign DOM and pasted HTML must not reach deck.html
  await open(url);
  await ev(`document.body.insertAdjacentHTML('beforeend', '<div id="ext-injected">EXT</div>'); document.querySelector('#s-p2').setAttribute('data-ext', '1')`);
  const i3 = await rectOf('#b-p2-sub p');
  await dblclick(i3.x, i3.y); await sleep(200);
  await ev(`(() => { const dt = new DataTransfer(); dt.setData('text/html', '<img src="https://evil.example/x.png">粘贴'); dt.setData('text/plain', '粘贴'); document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
  await type('Z'); await click(5, 5); await sleep(2000);
  const h3 = deckHtml();
  check('I3 edit saved', h3.includes('Z'));
  check('I3 pasted as plain text', h3.includes('粘贴') && !h3.includes('evil.example'));
  check('I3 foreign DOM not saved', !h3.includes('ext-injected') && !h3.includes('data-ext'));
  // I2b: two edits made while the server is down survive a restart (same tab, same URL)
  await open(url);
  server.kill(); await sleep(1500);
  for (const [sel, txt] of [['#b-p3-title h1', 'AAA'], ['#b-p3-sub p', 'BBB']]) {
    const r = await rectOf(sel); await dblclick(r.x, r.y); await sleep(200); await type(txt); await click(5, 5); await sleep(800);
  }
  const url0 = url; await startServer();
  check('I2b restart keeps URL', url === url0, `${url0} vs ${url}`);
  await sleep(5000);
  const hb = deckHtml();
  check('I2b both offline edits saved after restart', hb.includes('AAA') && hb.includes('BBB'));
  // Q: select text in edit mode, right-click -> quote intent without screenshot
  await open(url);
  const q0 = await rectOf('#b-p3-sub p');
  await dblclick(q0.x, q0.y); await sleep(200);
  const qs = await ev(`(() => { const t = document.querySelector('#b-p3-sub p').firstChild; const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, 2); const s = getSelection(); s.removeAllRanges(); s.addRange(r); const b = r.getBoundingClientRect(); return {x: b.left + b.width / 2, y: b.top + b.height / 2, text: r.toString()}; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: qs.x, y: qs.y, button: 'right', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: qs.x, y: qs.y, button: 'right', clickCount: 1 });
  await sleep(300);
  check('Q popup shows quote', ((await ev(`document.querySelector('.ppt-pop')?.textContent`)) || '').includes('改这段'));
  await type('改得更正式'); await enter(); await sleep(2500);
  const qe = inbox().at(-1);
  check('Q quote intent sent without screenshot', qe?.type === 'intent' && qe.text === '改得更正式' && qe.quote?.text === qs.text && !qe.shot && qe.blocks?.[0] === 'b-p3-sub', JSON.stringify(qe));
  check('Q status mark shown', ((await ev(`[...document.querySelectorAll('.ppt-mark b')].map(b => b.textContent).join()`)) || '').includes(qe?.id));
  // ---- 2a: selection, move, resize, top bar, keyboard, undo ----
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await open(url); await sleep(300);
  const t2 = await rectOf('#b-p2-title');
  await click(t2.x, t2.y); await sleep(300);
  check('S click selects (frame + bar, no popup)', await ev(`!!document.querySelector('.ppt-frame:not([hidden])') && !!document.querySelector('.ppt-bar:not([hidden])') && !document.querySelector('.ppt-pop')`));
  check('S top bar shows status', !!(await ev(`document.querySelector('.ppt-top .ppt-status')?.textContent`)));
  const k = await kZoom();
  await drag(t2.x, t2.y, t2.x + 80 * k, t2.y + 80 * k); await sleep(2000);
  check('S move snaps to grid and saves', deckHtml().includes('id="b-p2-title" style="grid-area: 5 / 3 / 7 / 17;"'));
  check('S move sends a labelled edit event', /移动/.test(inbox().at(-1)?.label || ''), JSON.stringify(inbox().at(-1)));
  const se = await ev(`(() => { const r = document.querySelector('.ppt-handle[data-handle="se"]').getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()`);
  await drag(se.x, se.y, se.x - 160 * k, se.y); await sleep(2000);
  check('S resize via handle', deckHtml().includes('id="b-p2-title" style="grid-area: 5 / 3 / 7 / 15;"'));
  check('U undo right after move undoes the move', await (async () => {
    const before = deckHtml(); const b = await rectOf('#b-p2-title');
    await drag(b.x, b.y, b.x, b.y + 80 * k); await sleep(100);        // move, then undo immediately
    await key('z', 'KeyZ', 90, 2); await sleep(3000);
    return deckHtml() === before;
  })());
  const nSlides = () => (deckHtml().match(/<section class="slide"/g) || []).length;
  const n0 = nSlides();
  let tb = await byTitle('在当前页之后插入空白页'); await click(tb.x, tb.y); await sleep(2000);
  check('T +页 inserts a slide', nSlides() === n0 + 1);
  tb = await byTitle('删除当前页'); await click(tb.x, tb.y); await sleep(2000);
  check('T −页 removes a slide', nSlides() === n0);
  tb = await byTitle('在当前页中央插入文字块'); await click(tb.x, tb.y); await sleep(2000);
  const newId = await ev(`document.querySelector('.ppt-frame:not([hidden])') && [...document.querySelectorAll('.block')].find((b) => b.textContent.includes('双击输入文字'))?.id`);
  check('T +文字 inserts and selects a block', !!newId && deckHtml().includes(`id="${newId}"`), newId);
  await key('Delete', 'Delete', 46); await sleep(2000);
  check('K Delete removes the selected block', !deckHtml().includes(`id="${newId}"`));
  // undo a change Claude made directly to the file
  fs.writeFileSync(path.join(DECK, 'deck.html'), deckHtml().replace('id="b-p2-sub"', 'id="b-p2-sub" data-claude="1"'));
  await sleep(2500);                                                 // watcher snapshot + page reload
  tb = await byTitle('撤销');
  check('U undo button names Claude', !tb.disabled && /Claude/.test(await ev(`[...document.querySelectorAll('#ppt-ui [title]')].find((n) => n.title.startsWith('撤销')).title`)));
  await click(tb.x, tb.y); await sleep(2500);
  check('U undo reverts Claude change', !deckHtml().includes('data-claude'));
  check('U undo event for Claude', inbox().at(-1)?.op === 'undo' && /Claude/.test(inbox().at(-1)?.label || ''), JSON.stringify(inbox().at(-1)));
  tb = await byTitle('重做'); await click(tb.x, tb.y); await sleep(2500);
  check('U redo restores it', deckHtml().includes('data-claude'));
  // ---- 2a: formatting and block style ----
  await open(url); await sleep(2000); // let the load-time lint pass finish before taking the baseline
  const lintBefore = inbox().filter((e) => e.type === 'lint').length;
  const fx = await rectOf('#b-p2-title'); await click(fx.x, fx.t + 10); await sleep(300); // title overlaps the subtitle by now
  let b2 = await byTitle('背景色'); await click(b2.x, b2.y); await sleep(200);
  b2 = await byTitle('#ef4444'); await click(b2.x, b2.y); await sleep(2000);
  check('F background colour', /id="b-p2-title" style="[^"]*background: rgb\(239, 68, 68\)/.test(deckHtml()));
  await ev(`(() => { const s = [...document.querySelectorAll('.ppt-bar select')].find((n) => n.title === '字号'); s.value = '40'; s.dispatchEvent(new Event('change')); })()`); await sleep(2000);
  check('F size select deep', /id="b-p2-title" style="[^"]*font-size: 40px/.test(deckHtml()) && !/id="b-p2-title"[^>]*><h1 style="[^"]*font-size/.test(deckHtml()));
  b2 = await byTitle('加粗'); await click(b2.x, b2.y); await sleep(2000);   // the title is an <h1>: bold by default
  check('F bold toggles off a bold heading', /id="b-p2-title" style="[^"]*font-weight: 400/.test(deckHtml())
    && (await ev(`parseInt(getComputedStyle(document.querySelector('#b-p2-title h1')).fontWeight, 10)`)) < 600);
  b2 = await byTitle('加粗'); await click(b2.x, b2.y); await sleep(2000);
  check('F bold toggles back on', /id="b-p2-title" style="[^"]*font-weight: 700/.test(deckHtml()));
  await ev(`(() => { const s = [...document.querySelectorAll('.ppt-bar select')].find((n) => n.title === '边框粗细'); s.value = '2'; s.dispatchEvent(new Event('change')); })()`); await sleep(2000);
  check('F border width', /id="b-p2-title" style="[^"]*border: 2px solid/.test(deckHtml()));
  b2 = await byTitle('阴影'); await click(b2.x, b2.y); await sleep(2000);
  check('F shadow toggle', /id="b-p2-title" style="[^"]*box-shadow/.test(deckHtml()));
  // edit mode: colour only the selected characters
  const fs2 = await rectOf('#b-p2-sub p');
  await dblclick(fs2.x, fs2.y); await sleep(300);
  await ev(`(() => { const t = document.querySelector('#b-p2-sub p').firstChild; const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, 1); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()`);
  await sleep(100);
  b2 = await byTitle('字色'); await click(b2.x, b2.y); await sleep(200);
  b2 = await byTitle('#2563eb'); await click(b2.x, b2.y); await sleep(200);
  check('F edit mode survives toolbar use', (await ev(`document.querySelector('#b-p2-sub')?.contentEditable`)) === 'true');
  await click(5, 60); await sleep(2500);
  check('F edit-mode colour wraps span', /id="b-p2-sub"[\s\S]*?<span style="color: rgb\(37, 99, 235\);">/.test(deckHtml()));
  // Escape must leave edit mode even when focus sits on a toolbar dropdown (review I2)
  const fe = await rectOf('#b-p2-sub p');
  await dblclick(fe.x, fe.y); await sleep(300);
  await ev(`[...document.querySelectorAll('.ppt-bar select')].find((n) => n.title === '字号').focus()`); await sleep(100);
  await key('Escape', 'Escape', 27); await sleep(500);
  check('F Escape from toolbar control ends edit mode', (await ev(`document.querySelector('#b-p2-sub')?.contentEditable`)) !== 'true');
  check('F recent colours remembered', ((await ev(`localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('ppt-recent-colors')))`)) || '').includes('#2563eb'));
  // ask Claude about the selection
  const fa = await rectOf('#b-p2-title'); await click(fa.x, fa.t + 10); await sleep(300); // earlier moves made the title overlap the subtitle
  b2 = await byTitle('问 Claude'); await click(b2.x, b2.y); await sleep(300);
  await type('标题改短一点'); await enter(); await sleep(2500);
  const ask = inbox().at(-1);
  check('F ask Claude sends selection', ask?.type === 'intent' && ask.blocks?.[0] === 'b-p2-title' && !!ask.shot, JSON.stringify({ ...ask, shot: !!ask?.shot }));
  check('F user styling raises no lint for Claude', inbox().filter((e) => e.type === 'lint').length === lintBefore);
  // ---- 2b: floating objects written into the file (as Claude would) ----
  await open(url); await sleep(1500);
  const OBJS = '<div class="obj" id="o-sh" data-kind="shape" data-shape="rect" style="left:100px;top:100px;width:200px;height:100px;fill:#dbeafe;stroke:#2563eb;stroke-width:2"><svg viewBox="0 0 200 100"><rect width="200" height="100"/></svg></div>'
    + '<div class="obj" id="o-ar" data-kind="arrow" data-shape="arrow" style="left:392px;top:592px;width:216px;height:16px;stroke:#2563eb;stroke-width:2"><svg viewBox="0 0 216 16" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="8" x2="208" y2="8"/></svg></div>'
    + '<div class="obj" id="o-free" data-kind="shape" style="left:700px;top:260px;width:120px;height:120px;fill:#fde68a"><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg></div>';
  { const h = deckHtml(), at = h.lastIndexOf('</section>'); fs.writeFileSync(path.join(DECK, 'deck.html'), h.slice(0, at) + OBJS + h.slice(at)); }
  await sleep(2500);
  const ko = await kZoom();
  const handle = (sel) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()`);
  const objOrder = () => [...deckHtml().matchAll(/class="obj" id="(o-[a-z]+)"/g)].map((m) => m[1]).join();
  let o5 = await rectOf('#o-sh'); await click(o5.x, o5.y); await sleep(300);
  check('O click selects an object: shape bar', !!(await byTitle('填充')) && !(await byTitle('边框粗细')));
  await drag(o5.x, o5.y, o5.x + 50 * ko, o5.y + 20 * ko); await sleep(2000);
  check('O drag moves freely (no grid snap)', /id="o-sh"[^>]*style="left: 150px; top: 120px;/.test(deckHtml()));
  let hd = await handle('.ppt-handle[data-handle="se"]');
  await drag(hd.x, hd.y, hd.x + 40 * ko, hd.y + 20 * ko); await sleep(2000);
  check('O resize redraws the svg at the new size', /id="o-sh"[^>]*style="left: 150px; top: 120px; width: 240px; height: 120px;[^"]*"><svg viewBox="0 0 240 120"><rect width="240" height="120">/.test(deckHtml()));
  o5 = await rectOf('#o-sh'); hd = await handle('.ppt-rot');
  await drag(hd.x, hd.y, o5.x + 200, o5.y + 5, 8); await sleep(2000);   // pointer right of the centre, Shift held
  check('O rotate handle with Shift snaps to 90deg', /id="o-sh"[^>]*transform: rotate\(90deg\)/.test(deckHtml()), JSON.stringify({ hd, o5, at: await ev(`document.elementFromPoint(${hd.x}, ${hd.y})?.className`), html: (deckHtml().match(/<div class="obj" id="o-sh"[^>]*>/) || [])[0] }));
  let b5 = await byTitle('填充'); await click(b5.x, b5.y); await sleep(200);
  b5 = await byTitle('#ef4444'); await click(b5.x, b5.y); await sleep(2000);
  check('O fill colour on a shape', /id="o-sh"[^>]*fill: rgb\(239, 68, 68\)/.test(deckHtml()));
  await key('ArrowRight', 'ArrowRight', 39); await sleep(300); await key('ArrowDown', 'ArrowDown', 40, 8); await sleep(2000);
  check('O arrow keys nudge 1px, Shift 10px', /id="o-sh"[^>]*style="left: 151px; top: 130px;/.test(deckHtml()));
  b5 = await byTitle('置顶'); await click(b5.x, b5.y); await sleep(2000);
  const zTop = objOrder();
  b5 = await byTitle('置底'); await click(b5.x, b5.y); await sleep(2000);
  check('O bring to front / send to back', [zTop, objOrder()].join(' | ') === 'o-ar,o-free,o-sh | o-sh,o-ar,o-free', `${zTop} | ${objOrder()}`);
  o5 = await rectOf('#o-sh'); await dblclick(o5.x, o5.y); await sleep(300);
  await type('AB'); await click(5, 60); await sleep(2000);
  check('O double-click a shape types into its text area', /id="o-sh"[\s\S]*?<div class="obj-text">AB<\/div>/.test(deckHtml()));
  o5 = await rectOf('#o-sh'); await click(o5.x, o5.y); await sleep(300);
  await key('ArrowLeft', 'ArrowLeft', 37); await sleep(2000);
  check('O shape text survives a redraw', /id="o-sh"[^>]*style="left: 150px;[\s\S]*?<div class="obj-text">AB<\/div>/.test(deckHtml()));
  // arrow: endpoint handles instead of the box handles
  const a5 = await rectOf('#o-ar'); await click(a5.x, a5.y); await sleep(300);
  check('O arrow bar has no fill, shows endpoint handles', !(await byTitle('填充')) && !!(await byTitle('线条色'))
    && (await ev(`!!document.querySelector('.ppt-end[data-handle="p2"]:not([hidden])') && !!document.querySelector('.ppt-handle[data-handle="se"][hidden]')`)));
  hd = await handle('.ppt-end[data-handle="p2"]');
  await drag(hd.x, hd.y, hd.x, hd.y - 100 * ko); await sleep(2000);
  check('O dragging an arrow end redraws it', /id="o-ar"[^>]*style="left: 392px; top: 492px; width: 216px; height: 116px;[^"]*"><svg viewBox="0 0 216 116"[^>]*><line x1="8" y1="108" x2="208" y2="8"><\/line><polyline/.test(deckHtml()));
  // an object drawn by Claude without data-shape, lying over a block
  const f5 = await rectOf('#o-free'); await click(f5.x, f5.y); await sleep(300);
  check('O object over a block wins the click', !!(await byTitle('填充')));
  hd = await handle('.ppt-handle[data-handle="se"]');
  await drag(hd.x, hd.y, hd.x + 30 * ko, hd.y + 30 * ko); await sleep(2000);
  check('O Claude-written shape without data-shape still resizes', /id="o-free"[^>]*width: 150px; height: 150px;[^"]*"><svg viewBox="0 0 10 10">/.test(deckHtml()));
  await key('Delete', 'Delete', 46); await sleep(2000);
  check('O Delete removes the object', !deckHtml().includes('id="o-free"'));
  // lint: the user's own placement is never reported; Claude's object off the canvas is
  const lintN = () => inbox().filter((e) => e.type === 'lint').length;
  const nl5 = lintN();
  o5 = await rectOf('#o-sh'); await click(o5.x, o5.y); await sleep(300);
  await drag(o5.x, o5.y, o5.x + 1000 * ko, o5.y); await sleep(2500);
  check('L user dragging an object off the canvas raises no lint', lintN() === nl5 && /id="o-sh"[^>]*style="left: 1150px;/.test(deckHtml()), `${nl5} -> ${lintN()}`);
  { const h = deckHtml(), at = h.lastIndexOf('</section>'); fs.writeFileSync(path.join(DECK, 'deck.html'), h.slice(0, at) + '<div class="obj" id="o-out" data-kind="icon" style="left:1400px;top:10px;width:64px;height:64px"><svg viewBox="0 0 24 24"></svg></div>' + h.slice(at)); }
  await sleep(3000);
  const lastLint = JSON.stringify(inbox().filter((e) => e.type === 'lint').at(-1) || {});
  check('L Claude object off the canvas is reported', lastLint.includes('obj-outside') && lastLint.includes('o-out') && !lastLint.includes('o-sh'), lastLint);
  // ---- 2b: inserting objects ----
  fs.writeFileSync(path.join(DECK, 'deck.html'), deckHtml().replace(/\n\s*\.obj[^\n]*/g, '')); // an old deck: #base has no object rules
  await sleep(2500); await open(url); await ev(`scrollTo(0, 0)`); await sleep(300);
  check('I old deck has no object rules', !/\.obj\s*\{/.test(deckHtml()));
  const ki = await kZoom();
  let b6 = await byTitle('插入形状'); await click(b6.x, b6.y); await sleep(200);
  b6 = await byTitle('画椭圆'); await click(b6.x, b6.y); await sleep(200);
  let sl = await rectOf('#s-cover');
  await drag(sl.l + 100 * ki, sl.t + 100 * ki, sl.l + 300 * ki, sl.t + 200 * ki); await sleep(2000);
  check('I draw an ellipse by dragging', /<div class="obj" id="o-[0-9a-z]{6}" data-kind="shape" data-shape="ellipse" style="left: 100px; top: 100px; width: 200px; height: 100px;[^"]*"><svg viewBox="0 0 200 100"><ellipse/.test(deckHtml()));
  check('I first object adds the #base rules in the same save', /\.obj\s*\{/.test(deckHtml()) && /补充对象样式/.test(inbox().at(-1)?.label || ''), inbox().at(-1)?.label);
  check('I new object is selected', !!(await byTitle('填充')));
  await key('z', 'KeyZ', 90, 2); await sleep(3000);
  check('I undo removes the object and the added rules together', !deckHtml().includes('data-shape="ellipse"') && !/\.obj\s*\{/.test(deckHtml()));
  await ev(`scrollTo(0, 0)`); await sleep(300);
  b6 = await byTitle('插入形状'); await click(b6.x, b6.y); await sleep(200);
  b6 = await byTitle('画箭头'); await click(b6.x, b6.y); await sleep(200);
  sl = await rectOf('#s-cover'); await click(sl.l + 640 * ki, sl.t + 600 * ki); await sleep(2000);
  check('I a click places a 160px arrow', /data-kind="arrow" data-shape="arrow" style="left: 552px; top: 592px; width: 176px; height: 16px;/.test(deckHtml()));
  // icons
  b6 = await byTitle('插入图标'); await click(b6.x, b6.y); await sleep(300);
  await type('房子'); await sleep(300);
  check('I icon search finds house by its Chinese name', !!(await byTitle('house')));
  const arBefore = (deckHtml().match(/data-kind="arrow"[^>]*style="left: (\d+)px/) || [])[1];
  await key('ArrowLeft', 'ArrowLeft', 37); await sleep(1500);
  check('I arrow keys in the icon search do not move the selection', (deckHtml().match(/data-kind="arrow"[^>]*style="left: (\d+)px/) || [])[1] === arBefore && arBefore === '552');
  b6 = await byTitle('house'); await click(b6.x, b6.y); await sleep(2000);
  check('I icon inserted at the slide centre, 64px, Lucide markup', /data-kind="icon" style="left: 608px; top: 328px; width: 64px; height: 64px;[^"]*"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"[^>]*><path d="M15 21v-8/.test(deckHtml()));
  b6 = await byTitle('插入图标'); await click(b6.x, b6.y); await sleep(300);
  const di = await rectOf('.ppt-icons input[placeholder^="没有合适的"]'); await click(di.x, di.y);
  await type('一只猫'); await enter(); await sleep(2000);
  const dIcon = inbox().at(-1);
  check('I "let Claude draw" sends a draw-icon intent', dIcon?.type === 'intent' && dIcon.kind === 'draw-icon' && dIcon.text === '一只猫' && dIcon.slide_id === 's-cover' && dIcon.rect?.w === 64, JSON.stringify(dIcon));
  // images: file picker, paste, drop
  const pngPath = path.join(SCRATCH, 'wide.png'); fs.writeFileSync(pngPath, png(960, 480));
  const docN = await send('DOM.getDocument');
  const inp = await send('DOM.querySelector', { nodeId: docN.result.root.nodeId, selector: '#ppt-ui input[type=file]' });
  await send('DOM.setFileInputFiles', { files: [pngPath], nodeId: inp.result.nodeId }); await sleep(2500);
  check('I picked image: long side 480, centred, stored under assets/', /data-kind="image" style="left: 400px; top: 240px; width: 480px; height: 240px;[^"]*"><img src="assets\/[0-9a-f]{12}\.png"/.test(deckHtml())
    && fs.readdirSync(path.join(DECK, 'assets')).length === 1);
  const nImg = () => (deckHtml().match(/data-kind="image"/g) || []).length;
  const fileJs = `(async () => { const b = await (await fetch(document.querySelector('.obj[data-kind=image] img').src)).blob(); const dt = new DataTransfer(); dt.items.add(new File([b], 'p.png', {type: 'image/png'})); return dt; })()`;
  await ev(`${fileJs}.then((dt) => document.body.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true})))`); await sleep(2500);
  check('I pasted image inserted, same bytes reuse the asset', nImg() === 2 && fs.readdirSync(path.join(DECK, 'assets')).length === 1);
  await ev(`(() => { const s = document.getElementById('s-cover'), r = s.getBoundingClientRect(), k = r.width / 1280; window.__drop = {x: r.left + 200 * k, y: r.top + 200 * k}; })()`);
  await ev(`${fileJs}.then((dt) => document.getElementById('s-cover').dispatchEvent(new DragEvent('drop', {dataTransfer: dt, clientX: __drop.x, clientY: __drop.y, bubbles: true, cancelable: true})))`); await sleep(2500);
  check('I dropped image lands at the drop point (kept inside the slide)', nImg() === 3 && /data-kind="image" style="left: 0px; top: 80px; width: 480px; height: 240px;/.test(deckHtml()));
  await ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'a.txt', {type: 'text/plain'})); document.getElementById('s-cover').dispatchEvent(new DragEvent('drop', {dataTransfer: dt, clientX: __drop.x, clientY: __drop.y, bubbles: true, cancelable: true})); })()`); await sleep(800);
  check('I dropping a non-image explains and inserts nothing', nImg() === 3 && ((await ev(`document.querySelector('.ppt-toast:last-of-type')?.textContent`)) || '').includes('只支持'));
  const ps = await rectOf('#b-cover-sub p'); await dblclick(ps.l + 20, ps.y); await sleep(300); // left end: the inserted images cover the middle
  await ev(`${fileJs}.then((dt) => document.activeElement.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true})))`); await sleep(2000);
  await key('Escape', 'Escape', 27); await sleep(1500);
  check('I paste image while typing inserts nothing', nImg() === 3);
  // ---- add new checks above ----
  check('no page JS errors', errors.length === 0, errors.join(' | '));
} catch (err) {
  check('script ran to the end', false, `${err.stack} | page errors: ${errors.join(' | ')}`);
} finally {
  const failed = results.filter(([ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  server.kill(); edge.kill(); ws.close();
  fs.rmSync(DECK, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
