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
const PROJ = path.join(SCRATCH, 'proj'), HOMEDIR = path.join(SCRATCH, 'home'); // the knowledge base under test, never the user's
const KB_ENV = { ...process.env, PPT_PROJECT_DIR: PROJ, PPT_HOME_DIR: HOMEDIR };
for (const [dir, file, text] of [[path.join(PROJ, '.claude', 'skills', 'brand'), 'SKILL.md', '---\nname: brand\ndescription: 公司品牌规范\n---\n主色蓝'],
  [path.join(HOMEDIR, '.claude', 'skills', 'consult'), 'SKILL.md', '---\nname: consult\ndescription: 咨询式汇报\n---\n'],
  [path.join(PROJ, 'decks', 'old'), 'deck.html', '<html><body></body></html>']]) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, file), text); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = '') => { results.push([ok, name]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`); };
const inbox = () => { const f = path.join(DECK, '.ppt', 'inbox.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; };
const deckHtml = () => fs.readFileSync(path.join(DECK, 'deck.html'), 'utf8');
const py = (...a) => execFileSync('python', ['ppt/server.py', ...a], { cwd: REPO, env: KB_ENV });
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
  server = spawn('python', ['ppt/server.py', 'decks/e2e-smoke', '--no-open', '--port', String(PORT)], { cwd: REPO, env: KB_ENV });
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
const DL = path.join(SCRATCH, 'downloads'); fs.mkdirSync(DL);
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
async function open(u) { await send('Page.navigate', { url: u }); await sleep(1800); }

try {
  // 1. offline status, fit to narrow width
  await open(url);
  check('1 status shows Claude offline', (await statusText()).includes('离线'), await statusText());
  { // the page names whichever agent is listening (Codex writes .ppt/agent through --wait --agent Codex)
    const rt = path.join(DECK, '.ppt'), hasTitle = (t) => ev(`[...document.querySelectorAll('#ppt-ui [title]')].some((n) => n.title === ${JSON.stringify(t)})`);
    fs.writeFileSync(path.join(rt, 'agent'), 'Codex'); fs.writeFileSync(path.join(rt, 'heartbeat'), 'x');
    for (let i = 0; i < 20 && !(await statusText()).includes('Codex'); i++) await sleep(250);
    check('A status names the listening agent', (await statusText()).includes('Codex 在线'), await statusText());
    check('A ask button names the agent', await hasTitle('问 Codex'));
    fs.rmSync(path.join(rt, 'agent')); fs.rmSync(path.join(rt, 'heartbeat'));
    for (let i = 0; i < 20 && !(await statusText()).includes('Claude 离线'); i++) await sleep(250);
    check('A back to Claude when no agent is recorded', (await statusText()).includes('Claude 离线') && await hasTitle('问 Claude'), await statusText());
  }
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
  check('S format bar stays one row', await ev(`(() => { const b = document.querySelector('.ppt-bar:not([hidden])'), k = [...b.children].filter((c) => c.offsetParent);
    return k.every((c) => Math.abs(c.getBoundingClientRect().top + c.offsetHeight / 2 - (k[0].getBoundingClientRect().top + k[0].offsetHeight / 2)) < 6) && k.every((c) => c.tagName !== 'BUTTON' || c.getBoundingClientRect().height < 40); })()`),
    await ev(`(() => { const r = document.querySelector('.ppt-bar').getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })()`));
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
  check('T the edit event names the new slide, not a block', /^s-/.test(inbox().at(-1)?.slide_id || '') && !inbox().at(-1)?.block, JSON.stringify(inbox().at(-1)));
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
  check('I shape menu labels read across, one line each', await ev(`[...document.querySelectorAll('.ppt-menu .ppt-btn')].every((b) => b.offsetParent && b.getBoundingClientRect().width > b.getBoundingClientRect().height * 1.5)`),
    await ev(`JSON.stringify([...document.querySelectorAll('.ppt-menu .ppt-btn')].map((b) => [b.textContent, Math.round(b.getBoundingClientRect().width), Math.round(b.getBoundingClientRect().height)]))`));
  b6 = await byTitle('画椭圆'); await click(b6.x, b6.y); await sleep(200);
  let sl = await rectOf('#s-cover');
  await drag(sl.l + 100 * ki, sl.t + 100 * ki, sl.l + 300 * ki, sl.t + 200 * ki); await sleep(2000);
  check('I draw an ellipse by dragging', /<div class="obj" id="o-[0-9a-z]{6}" data-kind="shape" data-shape="ellipse" style="left: 100px; top: 100px; width: 200px; height: 100px;[^"]*"><svg viewBox="0 0 200 100"><ellipse/.test(deckHtml()));
  check('I first object adds the #base rules in the same save', /\.obj\s*\{/.test(deckHtml()) && /补充对象样式/.test(inbox().at(-1)?.label || ''), inbox().at(-1)?.label);
  check('I new object is selected', !!(await byTitle('填充')));
  await key('z', 'KeyZ', 90, 2); await sleep(3000);
  check('I undo removes the object and the added rules together', !deckHtml().includes('data-shape="ellipse"') && !/\.obj\s*\{/.test(deckHtml()));
  // let Claude draw: the first object action in an old deck
  await ev(`scrollTo(0, 0)`); await sleep(300);
  b6 = await byTitle('插入图标'); await click(b6.x, b6.y); await sleep(300);
  const di = await rectOf('.ppt-icons input[placeholder^="没有合适的"]'); await click(di.x, di.y);
  await type('一只猫'); await enter(); await sleep(2000);
  const dIcon = inbox().filter((e) => e.type === 'intent').at(-1);
  check('I "let Claude draw" sends a draw-icon intent', dIcon?.kind === 'draw-icon' && dIcon.text === '一只猫' && dIcon.slide_id === 's-cover' && dIcon.rect?.w === 64, JSON.stringify(dIcon));
  check('I "let Claude draw" in an old deck adds the object rules Claude needs', /\.obj\s*\{/.test(deckHtml()));
  await ev(`window.__marker = 1`);
  fs.writeFileSync(path.join(DECK, 'deck.html'), deckHtml().replace('<title>', '<title>C')); await sleep(2500);   // Claude answers
  check('I page still reloads after the icon panel closed with text in it', (await ev(`window.__marker`)) === undefined);
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
  const ps = await rectOf('#b-p3-sub p'); await dblclick(ps.x, ps.y); await sleep(300); // slide 1's subtitle is squeezed under a reply bubble by now
  const typingNow = await ev(`document.querySelector('#b-p3-sub').contentEditable === 'true'`);
  await ev(`${fileJs}.then((dt) => document.activeElement.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true})))`); await sleep(2000);
  await key('Escape', 'Escape', 27); await sleep(1500);
  check('I paste image while typing inserts nothing', typingNow && nImg() === 3, `editing=${typingNow}`);
  // a move replayed after a save conflict is still the user's own: no lint for Claude
  const nl6 = inbox().filter((e) => e.type === 'lint').length;
  await ev(`localStorage.setItem('ppt-ops:' + PPT.token, JSON.stringify([{op: 'setArrow', target: 'o-ar', args: {x1: 1500, y1: 100, x2: 1700, y2: 100}, label: '移动 o-ar'}]))`);
  await send('Page.reload'); await sleep(3500);
  check('I replayed user move off the canvas raises no lint', inbox().filter((e) => e.type === 'lint').length === nl6 && /id="o-ar"[^>]*left: 1492px/.test(deckHtml()), `${nl6} -> ${inbox().filter((e) => e.type === 'lint').length}`);
  // ---- 2b review minors ----
  { const h = deckHtml(), at = h.indexOf('</section>'); fs.writeFileSync(path.join(DECK, 'deck.html'), h.slice(0, at) + '<div class="obj" data-kind="shape" style="left:900px;top:40px;width:100px;height:60px;fill:#fca5a5"><svg viewBox="0 0 100 60"><rect width="100" height="60"/></svg></div>' + h.slice(at)); }
  await sleep(2500); await ev(`scrollTo(0, 0)`); await sleep(300);
  const before7 = deckHtml();
  const nid = await ev(`(() => { const r = document.querySelector('#s-cover > .obj:not([id])').getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()`);
  await click(nid.x, nid.y); await sleep(300); await drag(nid.x, nid.y, nid.x + 50, nid.y); await sleep(300);
  await key('ArrowRight', 'ArrowRight', 39); await sleep(2000);
  const toasts = await ev(`[...document.querySelectorAll('.ppt-toast')].map((t) => t.textContent).join(' | ')`);
  check('M1 an object without id is not moved; the toast says it needs an id', deckHtml() === before7 && /id/.test(toasts) && !toasts.includes('目标已不存在')
    && !(await ev(`document.querySelector('.ppt-pop')`)) && (await ev(`document.querySelector('#s-cover > .obj:not([id])').style.left`)) === '900px', toasts);
  await key('Escape', 'Escape', 27); await sleep(200);
  const ni0 = nImg();
  await ev(`(() => { const r = document.getElementById('s-cover').getBoundingClientRect(), k = r.width / 1280; window.__drop = {x: r.left + 200 * k, y: r.top + 200 * k}; })()`);
  const sb = await rectOf('#b-p3-sub p'); await dblclick(sb.x, sb.y); await sleep(300);
  const editingNow = await ev(`document.querySelector('#b-p3-sub').contentEditable === 'true'`);
  await ev(`${fileJs}.then((dt) => document.getElementById('s-cover').dispatchEvent(new DragEvent('drop', {dataTransfer: dt, clientX: __drop.x, clientY: __drop.y, bubbles: true, cancelable: true})))`); await sleep(2500);
  const ni1 = nImg();
  await key('Delete', 'Delete', 46); await sleep(2000);
  check('M6 inserting while editing text ends edit mode, so keys act on the new object', editingNow && ni1 === ni0 + 1 && nImg() === ni0 && (await ev(`document.querySelector('#b-p3-sub').contentEditable`)) !== 'true', `${ni0} -> ${ni1} -> ${nImg()} editing=${editingNow}`);
  b6 = await byTitle('插入图标'); await click(b6.x, b6.y); await sleep(300);
  await key('Escape', 'Escape', 27); await sleep(200);
  check('M7 Escape closes the icon panel from its search box', (await ev(`document.querySelector('.ppt-icons').hidden`)) === true);
  // ---- 3: sketch ----
  await open(url); await ev(`scrollTo(0, 0)`); await sleep(300);
  let b8 = await byTitle('在当前页上画草图'); await click(b8.x, b8.y); await sleep(300);
  check('K sketch mode overlays the current slide', ((await ev(`document.querySelector('.ppt-sketch')?.getBoundingClientRect().width`)) || 0) > 100);
  const ks = await ev(`(() => { const r = document.getElementById('s-cover').getBoundingClientRect(); return {l: r.left, t: r.top, k: r.width / 1280}; })()`);
  const P = (x, y) => [ks.l + x * ks.k, ks.t + y * ks.k];
  const counts = () => ev(`[document.querySelectorAll('.ppt-sketch path').length, document.querySelectorAll('.ppt-sketch text').length].join()`);
  await drag(...P(100, 100), ...P(400, 100)); await drag(...P(100, 200), ...P(1300, 320)); // the second runs off the slide
  b8 = await byTitle('T 标注'); await click(b8.x, b8.y); await click(...P(500, 150)); await sleep(200);
  await type('不要'); await key('Escape', 'Escape', 27); await sleep(200);
  check('K Esc in the note box only cancels the note', (await counts()) === '2,0' && !!(await ev(`document.querySelector('.ppt-sketch')`)), await counts());
  await click(...P(500, 150)); await sleep(200); await type('标题<1>'); await enter(); await sleep(200);
  check('K two strokes and a note, shown as text', (await counts()) === '2,1' && (await ev(`document.querySelector('.ppt-sketch text')?.textContent`)) === '标题<1>', await counts());
  await key('Delete', 'Delete', 46); await key('z', 'KeyZ', 90, 2); await sleep(1500);
  check('K deck keys are inert while sketching', (await counts()) === '2,1' && !!(await ev(`document.querySelector('.ppt-sketch')`)));
  b8 = await byTitle('撤销上一笔'); await click(b8.x, b8.y); await sleep(200);
  check('K ↶ removes the last item', (await counts()) === '2,0');
  b8 = await byTitle('T 标注'); await click(b8.x, b8.y); await click(...P(500, 150)); await sleep(200); await type('标题<1>'); await enter(); await sleep(200);
  b8 = await byTitle('橡皮'); await click(b8.x, b8.y); await click(...P(250, 101)); await sleep(200);
  check('K eraser removes the stroke it touches', (await counts()) === '1,1', await counts());
  await ev(`window.__marker = 1`);
  fs.writeFileSync(path.join(DECK, 'deck.html'), deckHtml().replace('<title>', '<title>K')); await sleep(2500);
  check('K no reload while sketching', (await ev(`window.__marker`)) === 1);
  await key('Escape', 'Escape', 27); await sleep(2500);
  check('K Esc leaves sketch mode, then the page reloads', (await ev(`window.__marker`)) === undefined && !(await ev(`document.querySelector('.ppt-sketch')`)));
  await ev(`scrollTo(0, 0)`); await sleep(300);
  b8 = await byTitle('在当前页上画草图'); await click(b8.x, b8.y); await sleep(300);
  check('K the draft comes back', (await counts()) === '1,1');
  b8 = await byTitle('把草图发给 Claude'); await click(b8.x, b8.y); await sleep(300);
  await key('Escape', 'Escape', 27); await sleep(200);
  check('K Esc in the send box keeps the sketch', !(await ev(`document.querySelector('.ppt-pop')`)) && (await counts()) === '1,1');
  b8 = await byTitle('把草图发给 Claude'); await click(b8.x, b8.y); await sleep(300); await enter(); await sleep(3000);
  const ke = inbox().filter((e) => e.type === 'intent').at(-1);
  check('K send: sketch intent with shot, notes and the default text', ke?.kind === 'sketch' && ke.text === '按草图修改这一页' && JSON.stringify(ke.notes) === '["标题<1>"]' && ke.slide_id === 's-cover' && !!ke.shot
    && ke.rect.x + ke.rect.w <= 1280, JSON.stringify({ ...ke, shot: !!ke?.shot }));
  const shotPng = ke?.shot && fs.readFileSync(path.join(DECK, ke.shot));
  check('K the shot is the whole slide', !!shotPng && shotPng.readUInt32BE(16) === 1280 && shotPng.readUInt32BE(20) === 720);
  const leftMode = !(await ev(`document.querySelector('.ppt-sketch')`));
  b8 = await byTitle('在当前页上画草图'); await click(b8.x, b8.y); await sleep(300);
  check('K sending leaves sketch mode and clears the draft', leftMode && (await counts()) === '0,0');
  b8 = await byTitle('把草图发给 Claude'); await click(b8.x, b8.y); await sleep(300);
  check('K an empty sketch is not sent', ((await ev(`[...document.querySelectorAll('.ppt-toast')].map((t) => t.textContent).join()`)) || '').includes('还没有画内容') && !(await ev(`document.querySelector('.ppt-pop')`)));
  await drag(...P(600, 500), ...P(800, 560)); await sleep(200);
  b8 = await byTitle('把草图留在幻灯片上'); await click(b8.x, b8.y); await sleep(2500);
  const inkHtml = () => (deckHtml().match(/<div class="obj" id="o-[0-9a-z]{6}" data-kind="ink"[\s\S]*?<\/div>/) || [''])[0];
  check('K keep: an ink object is saved and selected', /data-kind="ink" style="left: \d+px;[^"]*"><svg viewBox="0 0 \d+ \d+" preserveAspectRatio="none"><path d="M[^"]+" fill="none" stroke="#ef4444" stroke-width="4"[^>]*vector-effect="non-scaling-stroke"/.test(inkHtml())
    && !!(await byTitle('颜色')) && !(await ev(`document.querySelector('.ppt-sketch')`)), inkHtml().slice(0, 200));
  b8 = await byTitle('颜色'); await click(b8.x, b8.y); await sleep(200);
  b8 = await byTitle('#2563eb'); await click(b8.x, b8.y); await sleep(2000);
  check('K ink colour changes every stroke', inkHtml().includes('#2563eb') && !inkHtml().includes('#ef4444'));
  await key('z', 'KeyZ', 90, 2); await sleep(3000);
  check('K undo restores the ink colour', inkHtml().includes('#ef4444'));
  const ns0 = nSlides();
  b8 = await byTitle('插入空白页并画草图'); await click(b8.x, b8.y); await sleep(2500);
  check('K +草图页 adds a blank slide and opens sketch mode on it', nSlides() === ns0 + 1 && !!(await ev(`document.querySelector('.ppt-sketch')`)));
  await key('Escape', 'Escape', 27); await sleep(500);
  // ---- sketch review fixes ----
  await ev(`scrollTo(0, 0)`); await sleep(300);
  b8 = await byTitle('在当前页上画草图'); await click(b8.x, b8.y); await sleep(300);
  const barR = await ev(`(() => { const b = document.querySelector('.ppt-sketchbar').getBoundingClientRect(), s = document.getElementById('s-cover').getBoundingClientRect(); return {bt: b.top, bb: b.bottom, st: s.top, sb: s.bottom}; })()`);
  check('KR the sketch bar never covers the slide', barR.bb <= barR.st || barR.bt >= barR.sb, JSON.stringify(barR));
  const deckK = deckHtml();
  b8 = await byTitle('撤销'); await click(b8.x, b8.y); await sleep(2500);
  check('KR the top bar is inert while sketching', deckHtml() === deckK && !!(await ev(`document.querySelector('.ppt-sketch')`)));
  const nImgK = (deckHtml().match(/data-kind="image"/g) || []).length;
  await ev(`${fileJs}.then((dt) => document.body.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true})))`); await sleep(2000);
  check('KR paste does not insert an image while sketching', (deckHtml().match(/data-kind="image"/g) || []).length === nImgK);
  await drag(...P(100, 100), ...P(300, 100)); await sleep(200);
  b8 = await byTitle('T 标注'); await click(b8.x, b8.y); await click(...P(100, 400)); await sleep(300); await type('最后');
  b8 = await byTitle('把草图发给 Claude'); await click(b8.x, b8.y); await sleep(300);
  b8 = await byTitle('把草图发给 Claude'); await click(b8.x, b8.y); await sleep(300);
  check('KR a second click does not stack send boxes', (await ev(`document.querySelectorAll('.ppt-pop').length`)) === 1);
  b8 = await byTitle('画笔'); await click(b8.x, b8.y); await drag(...P(900, 600), ...P(1100, 650)); await sleep(200);
  const kta = await rectOf('.ppt-pop textarea'); await click(kta.x, kta.y); await enter(); await sleep(3000);
  const kr = inbox().filter((e) => e.type === 'intent').at(-1);
  check('KR a note typed but not confirmed is still sent', JSON.stringify(kr?.notes || []).includes('最后'), JSON.stringify({ ...kr, shot: !!kr?.shot }));
  check('KR strokes drawn while the send box is open are sent too', !!kr && kr.rect.x + kr.rect.w >= 1100, JSON.stringify(kr?.rect));
  // a broken draft in the browser must not break sketch mode; wide Latin notes fit their backing
  await ev(`localStorage.setItem('ppt-sketch:s-cover:' + PPT.token, JSON.stringify({bad: 1}))`);
  await ev(`scrollTo(0, 0)`); await sleep(300);
  b8 = await byTitle('在当前页上画草图'); await click(b8.x, b8.y); await sleep(300);
  await drag(...P(100, 300), ...P(300, 300)); await sleep(200);
  b8 = await byTitle('T 标注'); await click(b8.x, b8.y); await click(...P(100, 400)); await sleep(300); await type('WWWWWWWW'); await enter(); await sleep(200);
  check('KR a malformed draft is ignored, drawing still works', (await counts()) === '1,1', await counts());
  check('KR a wide Latin note fits its backing', await ev(`(() => { const g = document.querySelector('.ppt-sketch g'); return g.querySelector('rect').width.baseVal.value >= g.querySelector('text').getBBox().width + 6; })()`));
  await key('Escape', 'Escape', 27); await sleep(500);
  { const h = deckHtml(), at = h.lastIndexOf('</body>'); fs.writeFileSync(path.join(DECK, 'deck.html'), h.slice(0, at) + '<section class="slide"><div class="block" style="grid-area:2/2/4/8">无 id 页</div></section>\n' + h.slice(at)); }
  await sleep(2500); await ev(`document.querySelector('section.slide:not([id])').scrollIntoView({block: 'center'})`); await sleep(500);
  b8 = await byTitle('在当前页上画草图'); await click(b8.x, b8.y); await sleep(500);
  check('KR a slide without id cannot be sketched on', !(await ev(`document.querySelector('.ppt-sketch')`)) && /id/.test((await ev(`[...document.querySelectorAll('.ppt-toast')].map((t) => t.textContent).join()`)) || ''));
  // ---- 4: knowledge base ----
  await open(url); await ev(`scrollTo(0, 0)`); await sleep(300);
  let b9 = await byTitle('打开知识库'); await click(b9.x, b9.y); await sleep(1000);
  check('B panel opens with three tabs', await ev(`!!document.querySelector('.ppt-kb:not([hidden])') && document.querySelectorAll('.ppt-kb-tab').length === 3`));
  const kbIndex = (scope) => { const f = path.join(scope === 'global' ? path.join(HOMEDIR, '.ppt-maker', 'kb') : path.join(PROJ, 'kb'), 'index.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : []; };
  const kbText = () => ev(`document.querySelector('.ppt-kb-body')?.textContent || ''`);
  const setKbFiles = async (files) => { const d = await send('DOM.getDocument'); const q = await send('DOM.querySelector', { nodeId: d.result.root.nodeId, selector: '.ppt-kb input[type=file]' }); await send('DOM.setFileInputFiles', { files, nodeId: q.result.nodeId }); };
  const mdPath = path.join(SCRATCH, '<b>年报</b>.md'.replace(/[<>/]/g, '_')); fs.writeFileSync(mdPath, '# 年报\n营收 12.3 亿，同比增长 18%。\n');
  await setKbFiles([mdPath]); await sleep(3000);
  const kb1 = kbIndex('project')[0];
  check('B upload: saved as pending, Claude asked to digest', kb1?.status === 'pending' && fs.existsSync(path.join(PROJ, 'kb', kb1.source))
    && inbox().some((e) => e.type === 'kb' && e.kind === 'digest' && e.kb_id === kb1.id), JSON.stringify(kb1));
  check('B panel shows 消化中', (await kbText()).includes('消化中'));
  fs.mkdirSync(path.join(PROJ, 'kb', 'cards'), { recursive: true }); fs.writeFileSync(path.join(PROJ, 'kb', 'cards', `${kb1.id}.md`), '## 摘要\n营收增长\n');
  py('--kb-done', 'decks/e2e-smoke', 'project', kb1.id, '<script>window.__x=1</script>年报', '营收 12.3 亿'); await sleep(3000);
  check('B after --kb-done: 就绪 and the summary', (await kbText()).includes('就绪') && (await kbText()).includes('营收 12.3 亿'));
  check('B titles are shown as text', (await kbText()).includes('<script>window.__x=1</script>年报') && (await ev(`window.__x`)) === undefined);
  b9 = await byTitle('查看 Claude 写的卡片'); await click(b9.x, b9.y); await sleep(1000);
  check('B card shown in the panel', ((await ev(`document.querySelector('.ppt-kb-card')?.textContent`)) || '').includes('营收增长'));
  await setKbFiles([mdPath]); await sleep(2500);
  check('B the same file again is not added twice', kbIndex('project').length === 1 && ((await ev(`[...document.querySelectorAll('.ppt-toast')].map((t) => t.textContent).join()`)) || '').includes('已在知识库里'));
  const urlBox = await rectOf('.ppt-kb input[placeholder^="粘贴网址"]'); await click(urlBox.x, urlBox.y); await type('https://example.com/report');
  await sleep(2500);
  check('B refresh keeps what you are typing', (await ev(`document.querySelector('.ppt-kb input[placeholder^="粘贴网址"]').value`)) === 'https://example.com/report');
  await enter(); await sleep(2500);
  check('B add a website', kbIndex('project').some((i) => i.type === 'web' && i.source === 'https://example.com/report'));
  b9 = await byTitle('参考'); await click(b9.x, b9.y); await sleep(800);
  await ev(`(() => { const s = document.querySelector('.ppt-kb select[title="旧 deck"]'); s.value = 'old'; })()`);
  b9 = await byTitle('添加这个旧 deck'); await click(b9.x, b9.y); await sleep(2500);
  check('B add an old deck as a reference', kbIndex('project').some((i) => i.type === 'ref' && i.kind === 'deck' && i.title === 'old') && (await kbText()).includes('old'));
  b9 = await byTitle('Skills'); await click(b9.x, b9.y); await sleep(1000);
  check('B project and global skills listed', (await kbText()).includes('公司品牌规范') && (await kbText()).includes('咨询式汇报'));
  await ev(`document.querySelector('.ppt-kb input[type=checkbox][data-skill="brand"]').click()`); await sleep(2000);
  check('B ticking a skill writes kb.json', (JSON.parse(fs.readFileSync(path.join(DECK, 'kb.json'), 'utf8')).skills || []).includes('brand'));
  const skBox = await rectOf('.ppt-kb textarea'); await click(skBox.x, skBox.y); await type('我们的汇报写法：结论先行');
  b9 = await byTitle('让 Claude 写这个 Skill'); await click(b9.x, b9.y); await sleep(2000);
  const skEv = inbox().at(-1);
  check('B new skill request goes to Claude', skEv?.type === 'kb' && skEv.kind === 'skill' && skEv.text === '我们的汇报写法：结论先行' && skEv.dir === path.join(PROJ, '.claude', 'skills'), JSON.stringify(skEv));
  b9 = await byTitle('资料'); await click(b9.x, b9.y); await sleep(1000);
  b9 = await byTitle('让 Claude 按这份资料改当前页'); await click(b9.x, b9.y); await sleep(400); await enter(); await sleep(2500);
  const kbIntent = inbox().filter((e) => e.type === 'intent').at(-1);
  check('B "用在这一页" sends an intent that names the item', JSON.stringify(kbIntent?.kb) === JSON.stringify([kb1.id]) && kbIntent.text === '按这份资料更新这一页', JSON.stringify({ ...kbIntent, shot: !!kbIntent?.shot }));
  b9 = await byTitle('移到知识库的回收站'); await click(b9.x, b9.y); await sleep(2500);
  check('B delete moves the item to the trash', !kbIndex('project').some((i) => i.id === kb1.id) && fs.existsSync(path.join(PROJ, 'kb', '.trash', kb1.id, 'item.json')));
  fs.mkdirSync(path.join(HOMEDIR, '.ppt-maker', 'kb'), { recursive: true }); fs.writeFileSync(path.join(HOMEDIR, '.ppt-maker', 'kb', 'index.json'), '{oops');
  await sleep(3000);
  check('B a broken global index is reported and left alone', (await kbText()).includes('无法读取') && fs.readFileSync(path.join(HOMEDIR, '.ppt-maker', 'kb', 'index.json'), 'utf8') === '{oops');
  b9 = await byTitle('关闭知识库'); await click(b9.x, b9.y); await sleep(300);
  // ---- kb review fixes ----
  await open(url); await ev(`scrollTo(0, 0)`); await sleep(300);
  const cov = await rectOf('#b-cover-title'); await click(cov.x, cov.t + 10); await sleep(300); // selects whatever is on top there
  b9 = await byTitle('打开知识库'); await click(b9.x, b9.y); await sleep(1000);
  const deckB = deckHtml();
  b9 = await byTitle('参考'); await click(b9.x, b9.y); await sleep(500);
  await key('Delete', 'Delete', 46); await sleep(2000);
  check('BR Delete with focus on a panel button leaves the slide alone', deckHtml() === deckB);
  b9 = await byTitle('在当前页上画草图'); await click(b9.x, b9.y); await sleep(500);
  check('BR the knowledge base panel steps aside while sketching', (await ev(`getComputedStyle(document.querySelector('.ppt-kb')).display`)) === 'none');
  await key('Escape', 'Escape', 27); await sleep(500);
  check('BR and comes back afterwards', (await ev(`getComputedStyle(document.querySelector('.ppt-kb')).display`)) !== 'none');
  b9 = await byTitle('关闭知识库'); await click(b9.x, b9.y); await sleep(300);
  // ---- 5: batch ----
  await open(url); await ev(`scrollTo(0, 0)`); await sleep(300);
  const batchLen = () => ev(`(JSON.parse(localStorage.getItem('ppt-batch:' + PPT.token) || '{"items":[]}').items || []).length`);
  const intents = () => inbox().filter((e) => e.type === 'intent').length;
  const SP = async (sid, x, y) => { const s = await ev(`(() => { const r = document.getElementById(${JSON.stringify(sid)}).getBoundingClientRect(); return {l: r.left, t: r.top, k: r.width / 1280}; })()`); return [s.l + x * s.k, s.t + y * s.k]; };
  const ctrlEnter = () => key('Enter', 'Enter', 13, 2);
  const n0q = intents();
  await drag(...(await SP('s-cover', 900, 560)), ...(await SP('s-cover', 1200, 700))); await sleep(300);
  await type('这里加一句口号'); await ctrlEnter(); await sleep(800);
  check('Q Ctrl+Enter puts it in the list, nothing is sent', (await batchLen()) === 1 && intents() === n0q
    && ((await ev(`document.querySelector('.ppt-pending b')?.textContent`)) || '').includes('待发') && !!(await byTitle('打开待发清单')));
  await drag(...(await SP('s-cover', 100, 560)), ...(await SP('s-cover', 400, 700))); await sleep(300);
  check('Q with a list, the box says Enter adds to it', ((await ev(`document.querySelector('.ppt-pop textarea').placeholder`)) || '').includes('加入清单'));
  await type('这里放联系方式'); await enter(); await sleep(800);
  check('Q Enter adds while the list is not empty', (await batchLen()) === 2 && intents() === n0q);
  await ev(`document.getElementById('s-p2').scrollIntoView({block: 'center'})`); await sleep(300);
  await drag(...(await SP('s-p2', 80, 80)), ...(await SP('s-p2', 600, 300))); await sleep(300);
  b9 = await byTitle('先放进待发清单'); await type('第二页标题改短'); await click(b9.x, b9.y); await sleep(800);
  check('Q the list spans slides', (await batchLen()) === 3 && (await ev(`document.querySelectorAll('.ppt-pending').length`)) === 3);
  b9 = await byTitle('打开待发清单'); await click(b9.x, b9.y); await sleep(500);
  check('Q panel lists the items with screenshots', (await ev(`document.querySelectorAll('.ppt-batch .ppt-kb-item').length`)) === 3 && (await ev(`!!document.querySelector('.ppt-batch img[src^="data:image/png"]')`)));
  await ev(`(() => { const t = document.querySelectorAll('.ppt-batch .ppt-kb-item textarea')[1]; t.value = '联系方式放右下角'; t.dispatchEvent(new Event('input')); })()`);
  b9 = await byTitle('从清单里删掉这一条'); await click(b9.x, b9.y); await sleep(500); // the first item's button
  check('Q delete drops that item, edits to the others are kept', (await batchLen()) === 2
    && (await ev(`JSON.parse(localStorage.getItem('ppt-batch:' + PPT.token)).items[0].text`)) === '联系方式放右下角');
  await ev(`(() => { const t = document.querySelector('.ppt-batch-note'); t.value = '整体改成更简洁的风格'; t.dispatchEvent(new Event('input')); })()`);
  b9 = await byTitle('把清单作为一个整体发给 Claude'); await click(b9.x, b9.y); await sleep(2500);
  const be = inbox().filter((e) => e.type === 'intent').at(-1);
  check('Q send all: one batch intent, note, items, shots stored per item', be?.kind === 'batch' && be.text === '整体改成更简洁的风格' && be.items?.length === 2
    && be.items.every((i, k) => !i.shot || i.shot === `.ppt/shots/${be.id}-${k + 1}.png`) && be.items.some((i) => i.shot && fs.existsSync(path.join(DECK, i.shot))), JSON.stringify(be?.items?.map((i) => i.shot)));
  await sleep(1500);
  check('Q the list is empty again and the marks show the batch ids', (await batchLen()) === 0 && !(await byTitle('打开待发清单'))
    && ((await ev(`[...document.querySelectorAll('.ppt-mark b')].map((b) => b.textContent).join()`)) || '').includes(`#${be.id}-1`));
  py('--reply', 'decks/e2e-smoke', be.id, '两处都改好了'); await sleep(2500);
  await ev(`(() => { const b = [...document.querySelectorAll('.ppt-bubble')].find((n) => n.textContent.includes('两处都改好了')); b.querySelector('textarea').id = 'batch-answer'; b.scrollIntoView({block: 'center'}); })()`); await sleep(200);
  const bta = await rectOf('#batch-answer'); await click(bta.x, bta.y); await type('口号再短一点'); await enter(); await sleep(2000);
  check('Q answering a batch refers to the batch', inbox().at(-1)?.type === 'answer' && inbox().at(-1).re === be.id, JSON.stringify(inbox().at(-1)));
  // a deleted slide and a full browser store must not break the list
  await ev(`localStorage.setItem('ppt-batch:' + PPT.token, JSON.stringify({note: '', items: [{slide: 9, slide_id: 's-gone', rect: {x: 0, y: 0, w: 10, h: 10}, cells: '1-1/1-1', blocks: [], text: '旧页'}]}))`);
  await open(url); await sleep(1000);
  check('Q a list item on a deleted slide does not break the page', !!(await byTitle('打开待发清单')) && (await ev(`document.querySelectorAll('.ppt-pending').length`)) === 0);
  await ev(`(() => { const set = Storage.prototype.setItem; window.__realSet = set; Storage.prototype.setItem = function (k, v) { if (k.startsWith('ppt-batch') && v.includes('data:image')) throw new DOMException('full', 'QuotaExceededError'); return set.call(this, k, v); }; })()`);
  await ev(`scrollTo(0, 0)`); await sleep(300);
  await drag(...(await SP('s-cover', 900, 100)), ...(await SP('s-cover', 1200, 200))); await sleep(300); await type('存储满时'); await enter(); await sleep(1500);
  check('Q storage full: item kept without its screenshot', (await batchLen()) === 2 && ((await ev(`[...document.querySelectorAll('.ppt-toast')].map((t) => t.textContent).join()`)) || '').includes('不带截图'));
  await ev(`Storage.prototype.setItem = window.__realSet; localStorage.setItem('ppt-batch:' + PPT.token, '{"note":"","items":[]}')`);
  await open(url); await sleep(500);
  // ---- batch review fixes ----
  await ev(`scrollTo(0, 0)`); await sleep(300);
  await drag(...(await SP('s-cover', 900, 100)), ...(await SP('s-cover', 1200, 200))); await sleep(300); await type('大清单'); await ctrlEnter(); await sleep(800);
  b9 = await byTitle('打开待发清单'); await click(b9.x, b9.y); await sleep(500);
  await ev(`window.__m = 1`);
  fs.writeFileSync(path.join(DECK, 'deck.html'), deckHtml().replace('<title>', '<title>R')); await sleep(3000);
  check('QR the page still reloads while the list panel is open', (await ev(`window.__m`)) === undefined && (await batchLen()) === 1);
  b9 = await byTitle('打开待发清单'); await click(b9.x, b9.y); await sleep(500);
  await ev(`(() => { window.__w = 0; const set = Storage.prototype.setItem; window.__realSet0 = set; Storage.prototype.setItem = function (k, v) { if (k.startsWith('ppt-batch')) window.__w++; return set.call(this, k, v); }; document.querySelector('.ppt-kb-item textarea').focus(); })()`);
  for (const ch of '逐字输入不卡顿') { await send('Input.insertText', { text: ch }); await sleep(30); }
  const typedWrites = await ev(`window.__w`); await sleep(1000);
  check('QR typing in the list does not rewrite it on every key', typedWrites <= 1 && (await ev(`window.__w`)) <= 2
    && (await ev(`JSON.parse(localStorage.getItem('ppt-batch:' + PPT.token)).items[0].text`)).endsWith('逐字输入不卡顿'), `writes while typing ${typedWrites}`);
  await ev(`Storage.prototype.setItem = window.__realSet0`);
  await send('Input.insertText', { text: '刷新前' }); await open(url); await sleep(800);
  check('QR an edit typed just before leaving is kept', (await ev(`JSON.parse(localStorage.getItem('ppt-batch:' + PPT.token)).items[0].text`)).endsWith('刷新前'));
  await ev(`(() => { const set = Storage.prototype.setItem; window.__realSet = set; Storage.prototype.setItem = function (k, v) { if (k.startsWith('ppt-queue') && v.includes('data:image')) throw new DOMException('full', 'QuotaExceededError'); return set.call(this, k, v); }; })()`);
  b9 = await byTitle('打开待发清单'); await click(b9.x, b9.y); await sleep(500);
  b9 = await byTitle('把清单作为一个整体发给 Claude'); await click(b9.x, b9.y); await sleep(2500);
  const bq = inbox().filter((e) => e.type === 'intent').at(-1);
  check('QR a batch too big for the send queue goes without screenshots, and says so', bq?.kind === 'batch' && bq.items[0].text.startsWith('大清单') && !bq.items[0].shot
    && ((await ev(`[...document.querySelectorAll('.ppt-toast')].map((t) => t.textContent).join()`)) || '').includes('截图没能保存'), JSON.stringify(bq?.items));
  await ev(`Storage.prototype.setItem = function (k, v) { if (k.startsWith('ppt-queue')) throw new DOMException('full', 'QuotaExceededError'); return window.__realSet.call(this, k, v); }`);
  await drag(...(await SP('s-cover', 900, 100)), ...(await SP('s-cover', 1200, 200))); await sleep(300); await type('发不出去'); await ctrlEnter(); await sleep(800);
  b9 = await byTitle('打开待发清单'); await click(b9.x, b9.y); await sleep(500);
  b9 = await byTitle('把清单作为一个整体发给 Claude'); await click(b9.x, b9.y); await sleep(1500);
  check('QR a batch that cannot be queued at all stays in the list', (await batchLen()) === 1
    && ((await ev(`[...document.querySelectorAll('.ppt-toast')].map((t) => t.textContent).join()`)) || '').includes('没能发送'));
  await ev(`Storage.prototype.setItem = window.__realSet; localStorage.setItem('ppt-batch:' + PPT.token, '{"note":"","items":[]}')`);
  await open(url); await sleep(500);
  // ---- 5: import ----
  await ev(`scrollTo(0, 0)`); await sleep(300);
  const revealPath = path.join(SCRATCH, '旧稿.html');
  fs.writeFileSync(revealPath, '<html><body><div class="reveal"><div class="slides"><section><h1>导入测试</h1></section><section>二</section></div></div><script>localStorage.setItem("stolen", "1")</script></body></html>');
  b9 = await byTitle('导入以前做过的 HTML'); await click(b9.x, b9.y); await sleep(400);
  check('I2 the dialog suggests appending to a deck that is not empty', (await ev(`document.querySelector('.ppt-import select[title="放到哪"]')?.value`)) === 'append');
  { const d = await send('DOM.getDocument'); const q = await send('DOM.querySelector', { nodeId: d.result.root.nodeId, selector: '.ppt-import input[type=file]' }); await send('DOM.setFileInputFiles', { files: [revealPath], nodeId: q.result.nodeId }); }
  await sleep(2500);
  const ie = inbox().at(-1);
  check('I2 file import: event with hint, stored original', ie?.type === 'import' && ie.kind === 'file' && ie.mode === 'append' && ie.hint === 'slides' && fs.existsSync(ie.source)
    && ((await ev(`[...document.querySelectorAll('.ppt-toast')].map((t) => t.textContent).join()`)) || '').includes('已提交导入'), JSON.stringify(ie));
  await send('Page.navigate', { url: new URL(ie.original, url).href }); await sleep(1500);
  check('I2 original opens sandboxed: its script cannot touch our storage', ((await ev(`document.body.textContent`)) || '').includes('导入测试')
    && (await ev(`(() => { try { return localStorage.getItem('stolen'); } catch { return 'blocked'; } })()`)) !== '1',
    JSON.stringify({ at: await ev(`location.href`), body: await ev(`document.body?.textContent?.slice(0, 80)`) }));
  await open(url); await sleep(500);
  b9 = await byTitle('导入以前做过的 HTML'); await click(b9.x, b9.y); await sleep(400);
  const iu = await rectOf('.ppt-import input[placeholder^="或粘贴网页网址"]'); await click(iu.x, iu.y); await type('https://example.com/report'); await enter(); await sleep(2000);
  check('I2 url import event', inbox().at(-1)?.type === 'import' && inbox().at(-1).kind === 'url' && inbox().at(-1).source === 'https://example.com/report', JSON.stringify(inbox().at(-1)));
  py('--reply', 'decks/e2e-smoke', ie.id, '导入了 2 页，动画没有保留'); await sleep(3000);
  check('I2 Claude\'s reply pops up with a link to the original', ((await ev(`[...document.querySelectorAll('.ppt-toast')].map((t) => t.textContent).join()`)) || '').includes('导入了 2 页')
    && (await ev(`[...document.querySelectorAll('.ppt-toast a')].some((a) => a.textContent === '打开原稿' && a.getAttribute('href') === ${JSON.stringify(ie.original)})`)));
  b9 = await byTitle('导入以前做过的 HTML'); await click(b9.x, b9.y); await sleep(400);
  check('I2 dialogs sit above pop-up notices', await ev(`(() => { const i = document.querySelector('.ppt-import input[placeholder^="或粘贴网页网址"]'), r = i.getBoundingClientRect();
    return [[r.left + 10, r.top + r.height / 2], [r.right - 10, r.top + r.height / 2]].every(([x, y]) => document.elementFromPoint(x, y) === i); })()`));
  await open(url); await sleep(2000);
  check('I2 the reply pops up only once', !((await ev(`[...document.querySelectorAll('.ppt-toast')].map((t) => t.textContent).join()`)) || '').includes('导入了 2 页'));
  await ev(`(() => { localStorage.removeItem('ppt-import-seen:' + PPT.token); localStorage.removeItem('ppt-import-seen'); document.querySelectorAll('.ppt-toast').forEach((t) => t.remove());
    const set = Storage.prototype.setItem; window.__realSet1 = set; Storage.prototype.setItem = function (k, v) { if (k.startsWith('ppt-import-seen')) throw new DOMException('full', 'QuotaExceededError'); return set.call(this, k, v); }; })()`);
  await sleep(3500);
  check('I2 with storage full the reply still pops up only once', (await ev(`[...document.querySelectorAll('.ppt-toast')].filter((t) => t.textContent.includes('导入了 2 页')).length`)) === 1);
  await ev(`Storage.prototype.setItem = window.__realSet1`);
  // ---- 6: export pptx ----
  const exportDeck = deckHtml().replace(/<\/body>/, `<section class="slide" id="s-export">
  <div class="block" id="b-ex-title" style="grid-area:1/2/3/16"><h2 style="margin:0;font-size:44px;color:#123456">导出测试标题</h2></div>
  <div class="block" id="b-ex-box" style="grid-area:3/2/6/8;background:#fde68a;border-radius:12px"><p style="margin:0;font-size:24px">框里的字</p><ul style="margin:0"><li>第一条</li><li>第二条</li></ul></div>
  <div class="block" id="b-ex-svg" style="grid-area:3/9/6/12"><svg viewBox="0 0 10 10" width="200" height="200"><circle cx="5" cy="5" r="4" fill="#38bdf8"/></svg></div>
  <div class="block" id="b-ex-table" style="grid-area:6/2/9/10"><table><tr><td>指标</td><td>数值</td></tr><tr><td>用户</td><td>820 万</td></tr></table></div>
  <div class="block" id="b-ex-ext" style="grid-area:6/11/9/14"><img src="https://invalid.example/x.png" alt="" style="width:100px;height:100px"></div>
  <div class="obj" id="o-ex-shape" data-kind="shape" data-shape="ellipse" style="left:1000px;top:80px;width:200px;height:100px;fill:#38bdf8;stroke:#ffffff;stroke-width:2"><svg viewBox="0 0 200 100"><ellipse cx="100" cy="50" rx="99" ry="49"/></svg><div class="obj-text">圆</div></div>
  <div class="obj" id="o-ex-arrow" data-kind="arrow" data-shape="arrow" style="left:900px;top:600px;width:300px;height:40px;stroke:#ff0000;stroke-width:3"><svg viewBox="0 0 300 40"><line x1="8" y1="20" x2="292" y2="20"/><polyline points="280,12 292,20 280,28" fill="none"/></svg></div>
  <div class="block" id="b-ex-long" style="grid-area:6/14/9/17;padding:20px;font-size:20px">这一段文字很长很长，在窄窄的块里一定会折成好几行才能放下<span style="display:none">不该出现</span><span style="visibility:hidden">也不该</span></div>
  <div class="block" id="b-ex-plain" style="grid-area:1/12/3/14"><ul style="margin:0;list-style:none;font-size:18px"><li>无符号</li></ul></div>
  <div class="block" id="b-ex-font" style="grid-area:9/2/10/8;font-family:Inter,'PingFang SC',sans-serif;font-size:18px">Inter 加中文</div>
</section>
<section class="slide" id="s-export-bg" style="background:linear-gradient(90deg,#ffffff,#eeeeee)">
  <div class="block" id="b-bg-svg" style="grid-area:3/3/6/6"><svg viewBox="0 0 10 10" width="200" height="200"><circle cx="5" cy="5" r="5" fill="#ff0000"/></svg></div>
</section></body>`);
  fs.writeFileSync(path.join(DECK, 'deck.html'), exportDeck); await open(url); await sleep(1500);
  const m1 = await ev(`PPTExport.measure([document.getElementById('s-export')]).then((d) => JSON.stringify(d))`);
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 800, deviceScaleFactor: 1, mobile: false }); await sleep(600);
  const m2 = await ev(`PPTExport.measure([document.getElementById('s-export')]).then((d) => JSON.stringify(d))`);
  await send('Emulation.clearDeviceMetricsOverride'); await sleep(600);
  const xt1 = JSON.parse(m1).slides[0].items.find((i) => i.k === 'text' && i.paras[0].runs[0].t === '导出测试标题');
  const xt2 = JSON.parse(m2).slides[0].items.find((i) => i.k === 'text' && i.paras[0].runs[0].t === '导出测试标题');
  check('X measuring gives canvas pixels at any zoom', xt1 && xt2 && Math.abs(xt1.x - xt2.x) < 1 && Math.abs(xt1.y - xt2.y) < 1 && xt1.x >= 80 && xt1.x < 100, JSON.stringify([xt1?.x, xt2?.x])); // the block's padding puts the text a little right of the grid line
  const ms = JSON.parse(m1);
  const lg = (m) => JSON.parse(m).slides[0].items.find((i) => i.k === 'text' && i.paras[0].runs[0]?.t.startsWith('这一段'));
  check('X a padded, wrapping paragraph measures the same at any zoom and keeps wrapping', lg(m1) && lg(m2) && Math.abs(lg(m1).x - lg(m2).x) < 1 && lg(m1).wrap === true && lg(m2).wrap === true
    && Math.abs(lg(m1).x - (13 * 80 + 20)) < 2, JSON.stringify([lg(m1)?.x, lg(m2)?.x, lg(m1)?.wrap, lg(m2)?.wrap]));
  const plain = ms.slides[0].items.find((i) => i.k === 'text' && i.paras[0].runs[0]?.t === '无符号');
  check('X a list without markers gets no bullet and no indent shift', plain && plain.paras[0].bullet === '' && Math.abs(plain.x - (11 * 80 + 8 + 40)) < 2, JSON.stringify([plain?.paras[0].bullet, plain?.x]));
  const fontRun = ms.slides[0].items.find((i) => i.k === 'text' && i.paras[0].runs[0]?.t === 'Inter 加中文')?.paras[0].runs[0];
  check('X Chinese text gets a CJK font of its own', fontRun?.font === 'Inter' && fontRun?.ea === 'PingFang SC'
    && ms.slides[0].items.find((i) => i.k === 'text' && i.paras[0].runs[0]?.t === '导出测试标题').paras[0].runs[0].ea === 'Microsoft YaHei', JSON.stringify(fontRun));
  const redInBg = await ev(`PPTExport.measure([document.getElementById('s-export-bg')]).then((d) => new Promise((ok) => {
    const bg = d.slides[0].items.find((i) => i.k === 'raster' && i.why === '页面背景'), im = new Image();
    if (!bg) return ok('no bg raster');
    im.onload = () => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0);
      const p = g.getImageData(Math.round(im.width * 280 / 1280), Math.round(im.height * 260 / 720), 1, 1).data; ok(p[0] > 200 && p[1] < 80 ? 'red' : 'clean'); };
    im.src = bg.src; }))`);
  check('X the page-background picture does not contain the foreground pictures', redInBg === 'clean', redInBg);
  const kinds = ms.slides[0].items.map((i) => i.k);
  check('X the measure has native text, box, table, shape, line and a raster for the svg',
    ['text', 'box', 'table', 'shape', 'line', 'raster'].every((k) => kinds.includes(k)) && ms.slides[0].items.find((i) => i.k === 'raster').id === 'b-ex-svg'
    && ms.slides[0].items.find((i) => i.k === 'text' && i.paras[0].bullet === '•'), kinds.join() + ' ' + JSON.stringify(ms.skipped));
  const xbox = ms.slides[0].items.find((i) => i.k === 'text' && i.paras[0].runs[0]?.t === '框里的字');
  check('X a one-line text does not wrap, and its box spans the block content width', xt1.wrap === false && xbox && Math.abs(xbox.w - (6 * 80 - 16)) < 2,
    JSON.stringify([xt1.wrap, xbox?.x, xbox?.w]));
  const xlist = ms.slides[0].items.find((i) => i.k === 'text' && i.paras[0].bullet === '•');
  const ulLeft = await ev(`(() => { const u = document.querySelector('#b-ex-box ul'), s = document.getElementById('s-export'), k = s.getBoundingClientRect().width / 1280;
    return (u.getBoundingClientRect().left - s.getBoundingClientRect().left) / k + parseFloat(getComputedStyle(u).paddingLeft); })()`);
  check('X list text lands where the page puts it (the bullet indent is taken out of the box)', xlist && Math.abs(xlist.x + 24 - ulLeft) < 2, JSON.stringify([xlist?.x, ulLeft]));
  check('X hidden inline text is not exported', !JSON.stringify(ms).includes('不该出现') && !JSON.stringify(ms).includes('也不该'));
  await ev(`(() => { const s = document.getElementById('s-export'), c = document.createElement('canvas'); c.width = c.height = 4;
    const g = c.getContext('2d'); g.fillStyle = '#00f'; g.fillRect(0, 0, 4, 4);
    const add = (id, area, src, css) => { const b = document.createElement('div'); b.className = 'block'; b.id = id; b.style.gridArea = area;
      const i = document.createElement('img'); i.src = src; i.style.cssText = css; b.append(i); s.append(b); };
    add('b-ex-webp', '9/9/10/10', c.toDataURL('image/webp'), 'width:40px;height:40px');
    add('b-ex-svgimg', '9/10/10/11', 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>'), 'width:40px;height:40px');
    add('b-ex-contain', '9/11/10/14', c.toDataURL('image/png'), 'width:200px;height:40px;object-fit:contain');
    Object.defineProperty(document.querySelector('#b-ex-table table'), 'rows', { configurable: true, get() { throw new Error('坏表格'); } }); })()`);
  await sleep(500);
  const mm = JSON.parse(await ev(`PPTExport.measure([document.getElementById('s-export')]).then((d) => JSON.stringify(d))`));
  const mi = (id) => mm.slides[0].items.find((i) => i.id === id);
  check('X WebP and SVG pictures are turned into PNG, and carry their id', mi('b-ex-webp')?.k === 'image' && mi('b-ex-webp').src.startsWith('data:image/png')
    && mi('b-ex-svgimg')?.src.startsWith('data:image/png'), JSON.stringify([mi('b-ex-webp')?.src.slice(0, 22), mi('b-ex-svgimg')?.src.slice(0, 22)]));
  const ct = mi('b-ex-contain'), ctBox = await ev(`(() => { const i = document.querySelector('#b-ex-contain img'), s = document.getElementById('s-export'), k = s.getBoundingClientRect().width / 1280;
    return (i.getBoundingClientRect().left - s.getBoundingClientRect().left) / k; })()`);
  check('X an object-fit:contain picture keeps its shape', ct && Math.abs(ct.w - 40) < 1 && Math.abs(ct.h - 40) < 1 && Math.abs(ct.x - (ctBox + 80)) < 1, JSON.stringify([ct?.x, ct?.w, ct?.h, ctBox]));
  check('X an element whose measuring fails becomes a picture instead of failing the export', mm.slides[0].items.some((i) => i.k === 'raster' && i.id === 'b-ex-table' && i.why === '测量出错'),
    JSON.stringify(mm.slides[0].items.filter((i) => i.id === 'b-ex-table')).slice(0, 200));
  await ev(`(() => { delete document.querySelector('#b-ex-table table').rows; ['b-ex-webp', 'b-ex-svgimg', 'b-ex-contain'].forEach((id) => document.getElementById(id).remove()); })()`);
  check('X an image that cannot be fetched is skipped, not fatal', ms.skipped.some((s) => s.id === 'b-ex-ext'), JSON.stringify(ms.skipped));
  { const lr = await rectOf('#b-ex-long'); await dblclick(lr.l + 30, lr.t + 30); await sleep(300); }
  const editingBefore = await ev(`!!document.querySelector('[contenteditable="true"]')`);
  b9 = await byTitle('导出成可在 PowerPoint'); await click(b9.x, b9.y); await sleep(500);
  check('X export leaves edit mode first', editingBefore && !(await ev(`!!document.querySelector('[contenteditable="true"]')`)), String(editingBefore));
  check('X the button shows it is busy', (await ev(`[...document.querySelectorAll('#ppt-ui [title^="导出成可在"]')].map((b) => b.textContent).join()`)) === '导出中…');
  let exported = null;
  for (let i = 0; i < 60 && !exported; i++) { await sleep(500); const d = path.join(DECK, 'export'); exported = fs.existsSync(d) && fs.readdirSync(d).find((f) => f.endsWith('.pptx')); }
  await sleep(500);
  check('X a pptx is written under export/', !!exported, String(exported));
  for (let i = 0; i < 20 && !fs.readdirSync(DL).some((f) => f.endsWith('.pptx')); i++) await sleep(250);
  check('X the button downloads the file (into the test folder)', fs.readdirSync(DL).some((f) => f.endsWith('.pptx')), fs.readdirSync(DL).join());
  check('X the report pops up with a download link', ((await ev(`[...document.querySelectorAll('.ppt-toast')].map((t) => t.textContent).join()`)) || '').includes('导出完成')
    && (await ev(`[...document.querySelectorAll('.ppt-toast a')].some((a) => a.textContent === '下载' && a.getAttribute('href').startsWith('/export/'))`)));
  if (exported) {
    const back = JSON.parse(execFileSync('python', ['-c', `import json,sys
from pptx import Presentation
p = Presentation(sys.argv[1])
print(json.dumps({"n": len(p.slides), "texts": [sh.text_frame.text for s in p.slides for sh in s.shapes if sh.has_text_frame],
  "pics": sum(sh.shape_type == 13 for s in p.slides for sh in s.shapes), "tables": sum(sh.has_table for s in p.slides for sh in s.shapes)}, ensure_ascii=False))`,
      path.join(DECK, 'export', exported)], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }));
    check('X read back: one slide per page, title text editable, svg as a picture, a table',
      back.n === (await ev(`document.querySelectorAll('section.slide').length`)) && back.texts.includes('导出测试标题') && back.pics >= 1 && back.tables === 1, JSON.stringify(back).slice(0, 300));
  }
  { const before = fs.readdirSync(DL).length; fs.rmSync(path.join(DECK, '.ppt', 'export.json'), { force: true });
    await send('Page.navigate', { url: url + '&export=1' }); // the deck holds a picture that never loads: the export must not wait for it
    const te = Date.now(); for (let i = 0; i < 240 && !fs.existsSync(path.join(DECK, '.ppt', 'export.json')); i++) await sleep(500);
    const took = Date.now() - te; await sleep(1000);
    check('X a terminal-driven export (export=1) writes the file within 20 s (a picture that never loads is skipped) and downloads nothing', took < 20000 && fs.existsSync(path.join(DECK, '.ppt', 'export.json')) && fs.readdirSync(DL).length === before, JSON.stringify([before, fs.readdirSync(DL), fs.existsSync(path.join(DECK, '.ppt', 'export.json')), took]));
    await open(url); await sleep(800); }
  { b9 = await byTitle('导出成可在 PowerPoint'); await click(b9.x, b9.y); await sleep(200);
    fs.writeFileSync(path.join(DECK, 'deck.html'), deckHtml().replace('</body>', '<!-- changed during export --></body>'));
    let seen = false;
    for (let i = 0; i < 100 && !seen; i++) { await sleep(300); seen = ((await ev(`[...document.querySelectorAll('.ppt-toast')].map((t) => t.textContent).join()`)) || '').includes('导出完成'); }
    check('X a deck change during an export waits for it to finish before reloading', seen);
    await sleep(1000); for (let i = 0; i < 40 && !(await byTitle('导入以前做过的 HTML')); i++) await sleep(250); }  // the deferred reload lands after the export
  const pptxPath = path.join(SCRATCH, '旧稿.pptx');
  execFileSync('python', ['-c', `import sys
from pptx import Presentation
p = Presentation(); s = p.slides.add_slide(p.slide_layouts[1]); s.shapes.title.text = "旧 PPT 标题"; p.save(sys.argv[1])`, pptxPath]);
  b9 = await byTitle('导入以前做过的 HTML'); await click(b9.x, b9.y); await sleep(400);
  check('I3 the dialog accepts pptx', (await ev(`document.querySelector('.ppt-import input[type=file]').accept`)).includes('.pptx'));
  { const d = await send('DOM.getDocument'); const q = await send('DOM.querySelector', { nodeId: d.result.root.nodeId, selector: '.ppt-import input[type=file]' });
    await send('DOM.setFileInputFiles', { files: [pptxPath], nodeId: q.result.nodeId }); }
  let pe = null;
  for (let i = 0; i < 120 && !pe; i++) { await sleep(500); pe = inbox().find((e) => e.type === 'import' && e.hint === 'pptx'); }
  check('I3 a pptx becomes an import event for Claude', !!pe && fs.existsSync(pe.source) && fs.existsSync(pe.media), JSON.stringify(pe)?.slice(0, 200));
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
