// Records the README's screenshots and gifs from the real editor (dev only): node tools/readme-media.mjs
// Needs Node >= 22, Edge or Chrome, Python with Pillow. Works on its own scratch deck and port; never touches decks/.
// The agent's side is scripted here (a reply and an edit written straight to the deck), so it runs without any API.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = process.cwd();
const OUT = path.join(REPO, 'docs', 'media');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-media-'));
const PROJ = path.join(SCRATCH, 'proj'), DECK = path.join(PROJ, 'decks', 'demo');
const EDGE = process.env.PPT_BROWSER || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const PORT = 8810, DBG = 9343, W = 1280, H = 800;
const ENV = { ...process.env, PPT_PROJECT_DIR: PROJ, PPT_HOME_DIR: path.join(SCRATCH, 'home'), PYTHONIOENCODING: 'utf-8' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

// ---- the demo deck ----
const ICON = {
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
};
const svgIcon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">${ICON[n]}</svg>`;
const THEME = `<style id="theme">
  :root { --bg:#ffffff; --fg:#111827; --muted:#6b7280; --accent:#4f46e5; --soft:#eef2ff; --font:"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif; }
</style>`;
const COVER = `<section class="slide" id="s-cover">
  <div class="block" id="b-cover-band" style="grid-area:1/1/10/7;background:var(--accent)"></div>
  <div class="block" id="b-cover-kicker" style="grid-area:3/8/4/17"><p style="font-size:22px;margin:0;color:var(--accent);font-weight:700">2026 Q4 · 产品汇报</p></div>
  <div class="block" id="b-cover-title" style="grid-area:4/8/6/17"><h1 style="font-size:60px;margin:0;line-height:1.2">让 agent 帮你改 PPT</h1></div>
  <div class="block" id="b-cover-sub" style="grid-area:6/8/7/17"><p style="font-size:24px;margin:0;color:var(--muted)">在浏览器里说想怎么改，剩下的交给它</p></div>
</section>`;
const POINTS = `<section class="slide" id="s-points">
  <div class="block" id="b-points-title" style="grid-area:1/2/2/16"><h2 style="font-size:40px;margin:16px 0 0">本季度三个重点</h2></div>
  <div class="block" id="b-points-list" style="grid-area:3/2/9/16"><ul style="font-size:28px;line-height:2;margin:0">
    <li>性能：页面打开速度提升 40%</li><li>安全：所有导出文件本地处理，不上传</li><li>协作：支持 Claude、Codex 和自己的 API</li></ul></div>
</section>`;
const CARD = (n, id, icon, title, text) => `<div class="block" id="b-card-${id}" style="grid-area:3/${2 + n * 5}/9/${6 + n * 5};background:var(--soft);border-radius:16px">
    <div style="width:56px;height:56px;color:var(--accent);margin:16px 0 0 8px">${svgIcon(icon)}</div>
    <h3 style="font-size:30px;margin:16px 8px 8px">${title}</h3><p style="font-size:22px;margin:0 8px;color:var(--muted);line-height:1.6">${text}</p></div>`;
const POINTS_CARDS = `<section class="slide" id="s-points">
  <div class="block" id="b-points-title" style="grid-area:1/2/2/16"><h2 style="font-size:40px;margin:16px 0 0">本季度三个重点</h2></div>
  ${CARD(0, 'perf', 'zap', '性能', '页面打开速度提升 40%')}
  ${CARD(1, 'safe', 'shield', '安全', '所有导出文件本地处理，不上传')}
  ${CARD(2, 'team', 'users', '协作', '支持 Claude、Codex 和自己的 API')}
</section>`;
const DATA = `<section class="slide" id="s-data">
  <div class="block" id="b-data-title" style="grid-area:1/2/2/16"><h2 style="font-size:40px;margin:16px 0 0">关键数据</h2></div>
  <div class="block" id="b-data-table" style="grid-area:3/2/9/16"><table style="width:100%;border-collapse:collapse;font-size:26px">
    <tr style="color:var(--muted)"><td>指标</td><td>Q3</td><td>Q4</td></tr>
    <tr><td>周活跃用户</td><td>1.2 万</td><td><b style="color:var(--accent)">2.0 万</b></td></tr>
    <tr><td>平均改稿时间</td><td>35 分钟</td><td><b style="color:var(--accent)">12 分钟</b></td></tr>
    <tr><td>导出成功率</td><td>96%</td><td><b style="color:var(--accent)">99.5%</b></td></tr></table></div>
</section>`;
const FLOW = (id) => `<section class="slide" id="${id}">
  <div class="block" id="b-flow-title" style="grid-area:1/2/2/16"><h2 style="font-size:40px;margin:16px 0 0">上线流程</h2></div>
  ${[['research', '调研', '访谈 20 位用户'], ['design', '设计', '两轮原型评审'], ['launch', '上线', '灰度一周后全量']].map(([k, t, s], n) =>
    `<div class="block" id="b-flow-${k}" style="grid-area:4/${2 + n * 5}/7/${6 + n * 5};background:${n === 2 ? 'var(--accent)' : 'var(--soft)'};color:${n === 2 ? '#ffffff' : 'var(--fg)'};border-radius:16px;text-align:center">
    <h3 style="font-size:34px;margin:40px 0 8px">${t}</h3><p style="font-size:22px;margin:0">${s}</p></div>`).join('\n  ')}
  ${[0, 1].map((n) => `<div class="obj" id="o-flow-arrow${n}" data-kind="arrow" data-shape="arrow" style="left:${400 + n * 400}px;top:340px;width:80px;height:40px;stroke:#4f46e5;stroke-width:4">
    <svg viewBox="0 0 80 40"><line x1="8" y1="20" x2="72" y2="20"/><polyline points="60,10 72,20 60,30" fill="none"/></svg></div>`).join('\n  ')}
</section>`;
const tpl = fs.readFileSync(path.join(REPO, 'ppt', 'template.html'), 'utf8');
const deckOf = (...slides) => tpl.replace(/<style id="theme">[\s\S]*?<\/style>/, THEME).replace(/<title>.*?<\/title>/, '<title>产品汇报</title>')
  .replace(/<section[\s\S]*<\/section>/, slides.join('\n'));
fs.mkdirSync(DECK, { recursive: true });
const deckFile = path.join(DECK, 'deck.html');
fs.writeFileSync(deckFile, deckOf(COVER, POINTS, DATA));
const py = (...a) => execFileSync('python', ['ppt/server.py', ...a], { cwd: REPO, env: ENV });
const rt = path.join(DECK, '.ppt');
const online = () => { fs.writeFileSync(path.join(rt, 'agent'), 'Claude'); fs.writeFileSync(path.join(rt, 'heartbeat'), new Date().toISOString()); };
const inbox = () => { const f = path.join(rt, 'inbox.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; };

// ---- server + browser ----
const server = spawn('python', ['ppt/server.py', DECK, '--no-open', '--port', String(PORT)], { cwd: REPO, env: ENV });
const url = await new Promise((res) => server.stdout.on('data', (d) => { const m = String(d).match(/http\S+/); if (m) res(m[0]); }));
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${DBG}`, `--user-data-dir=${path.join(SCRATCH, 'prof')}`, `--window-size=${W},${H}`, 'about:blank']);
let ws;
for (let i = 0; i < 50 && !ws; i++) {
  try { const t = (await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json()).find((x) => x.type === 'page'); ws = new WebSocket(t.webSocketDebuggerUrl); } catch { await sleep(200); }
}
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0; const waiting = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } });
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const mouse = (type, x, y, clickCount = 1) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount });
const click = async (x, y) => { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); };
const key = (k, code, vk, modifiers = 0) => send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers })
  .then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers }));
const enter = (mod = 0) => key('Enter', 'Enter', 13, mod);
const byTitle = (t) => ev(`(() => { const b = [...document.querySelectorAll('#ppt-ui [title]')].find((n) => n.title.startsWith(${JSON.stringify(t)}) && n.offsetParent); if (!b) return null; const r = b.getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()`);
const rectOf = (sel) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2, l: r.left, t: r.top, w: r.width, h: r.height}; })()`);
const slideAt = (id) => ev(`(() => { const s = document.getElementById(${JSON.stringify(id)}); scrollBy(0, s.getBoundingClientRect().top - 64); const r = s.getBoundingClientRect(); return {l: r.left, t: r.top, k: r.width / 1280}; })()`);
const until = async (expr, ms = 15000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr)) return true; await sleep(200); } throw new Error(`timed out: ${expr}`); };
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: path.join(SCRATCH, 'dl') });
const open = async () => { await send('Page.navigate', { url }); await until(`!!document.querySelector('#ppt-ui [title^="导入以前做过的"]')`); await sleep(600); };
const png = async () => Buffer.from((await send('Page.captureScreenshot')).result.data, 'base64');
const still = async (name) => { fs.writeFileSync(path.join(OUT, name), await png()); console.log(`docs/media/${name}`); };

// a gif is a list of screenshots, each held for some ms
class Gif {
  constructor(name) { this.name = name; this.dir = fs.mkdtempSync(path.join(SCRATCH, name + '-')); this.frames = []; }
  async frame(ms = 120) { const f = `f${String(this.frames.length).padStart(3, '0')}.png`; fs.writeFileSync(path.join(this.dir, f), await png()); this.frames.push({ file: f, ms }); }
  async type(text, step = 2) { for (let i = 0; i < text.length; i += step) { await send('Input.insertText', { text: text.slice(i, i + step) }); await this.frame(90); } }
  async drag(x0, y0, x1, y1, steps = 6) {
    await mouse('mousePressed', x0, y0);
    for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps); if (i % 2 === 0) await this.frame(60); }
    await mouse('mouseReleased', x1, y1);
  }
  save() {
    fs.writeFileSync(path.join(this.dir, 'manifest.json'), JSON.stringify(this.frames));
    console.log(execFileSync('python', [path.join(REPO, 'tools', 'frames_to_gif.py'), path.join(this.dir, 'manifest.json'), path.join(OUT, this.name + '.gif'), '960'], { encoding: 'utf8' }).trim());
  }
}
// the agent's side, scripted: mark processing, then edit and reply
const agentWorks = async (gif, eid, html, text, made) => {
  online(); py('--reply', DECK, eid, '--ack');
  await until(`[...document.querySelectorAll('.ppt-mark.processing')].length > 0`); await gif.frame(1100);
  fs.writeFileSync(deckFile, html); online(); py('--reply', DECK, eid, text);
  await until(`!!document.querySelector(${JSON.stringify(made)}) && !!document.querySelector('.ppt-mark.done') && !!document.querySelector('.ppt-bubble')`);
  await sleep(600); await gif.frame(3500);
};
const clean = async () => { await ev(`Object.keys(localStorage).filter((k) => k.startsWith('ppt-batch')).forEach((k) => localStorage.removeItem(k))`); const b = await byTitle('清除已完成标记'); if (b) await click(b.x, b.y); await sleep(300); };

try {
  // ---- hero ----
  online(); await open(); await sleep(800);
  await still('hero.png');

  // ---- intent: click a block, say what you want, the agent changes it ----
  {
    const g = new Gif('intent');
    online(); await open(); await slideAt('s-points'); await sleep(400); await g.frame(900);
    const r = await rectOf('#b-points-list'); await click(r.x, r.y); await sleep(300); await g.frame(700);
    const ask = await byTitle('问 Claude'); await click(ask.x, ask.y); await sleep(300); await g.frame(500);
    await g.type('改成三张卡片，每张配一个图标'); await g.frame(700);
    await enter(); await until(`[...document.querySelectorAll('.ppt-mark')].length > 0`); await key('Escape', 'Escape', 27); await sleep(300); await g.frame(1100);
    const eid = inbox().filter((e) => e.type === 'intent').at(-1).id;
    await agentWorks(g, eid, deckOf(COVER, POINTS_CARDS, DATA), '改成了三张卡片：性能、安全、协作，各配了一个图标，文字没动。', '#b-card-perf');
    g.save();
  }

  // ---- sketch: draw the layout, the agent turns it into a real page ----
  {
    const g = new Gif('sketch');
    await open(); await clean(); await slideAt('s-data'); await sleep(300);
    const add = await byTitle('插入空白页并画草图'); await click(add.x, add.y);
    await until(`!!document.querySelector('.ppt-sketch')`); await sleep(400);
    const sid = await ev(`document.querySelectorAll('section.slide')[3].id`);
    const s = await slideAt(sid); await sleep(300); await g.frame(800);
    const P = (x, y) => [s.l + x * s.k, s.t + y * s.k];
    await g.drag(...P(120, 90), ...P(560, 90));
    for (const x of [120, 520, 920]) { // three boxes
      await g.drag(...P(x, 280), ...P(x + 260, 280), 3); await g.drag(...P(x + 260, 280), ...P(x + 260, 480), 3);
      await g.drag(...P(x + 260, 480), ...P(x, 480), 3); await g.drag(...P(x, 480), ...P(x, 280), 3);
    }
    for (const x of [400, 800]) { await g.drag(...P(x, 380), ...P(x + 100, 380), 3); await g.drag(...P(x + 80, 360), ...P(x + 100, 380), 2); await g.drag(...P(x + 80, 400), ...P(x + 100, 380), 2); }
    await g.frame(500);
    const note = await byTitle('T 标注'); await click(note.x, note.y); await click(...P(140, 560)); await sleep(200);
    await g.type('三步：调研 → 设计 → 上线，最后一步高亮', 3); await enter(); await sleep(200); await g.frame(900);
    const go = await byTitle('把草图发给 Claude'); await click(go.x, go.y); await sleep(300); await g.frame(800);
    await enter(); await until(`!document.querySelector('.ppt-sketch') && [...document.querySelectorAll('.ppt-mark')].length > 0`); await sleep(300); await slideAt(sid); await g.frame(1000);
    const eid = inbox().filter((e) => e.kind === 'sketch').at(-1).id;
    await agentWorks(g, eid, fs.readFileSync(deckFile, 'utf8').replace(new RegExp(`<section class="slide" id="${sid}"[\\s\\S]*?</section>`), FLOW(sid)),
      '按草图做成了三步流程：调研、设计、上线，最后一步用主色高亮，中间用箭头连接。', '#b-flow-research');
    g.save();
  }

  // ---- batch: collect several changes, send them together ----
  {
    await open(); await clean(); await slideAt('s-cover'); await sleep(300);
    let r = await rectOf('#b-cover-sub'); await click(r.x, r.y); await sleep(200); await enter(); await sleep(300);
    await send('Input.insertText', { text: '副标题再短一点' }); await enter(2); await sleep(400);
    await slideAt('s-data'); await sleep(300);
    r = await rectOf('#b-data-table'); await click(r.x, r.y); await sleep(200); await enter(); await sleep(300);
    await send('Input.insertText', { text: '加一列“同比”' }); await enter(); await sleep(400); await key('Escape', 'Escape', 27); await sleep(300);
    const list = await byTitle('打开待发清单'); await click(list.x, list.y); await sleep(600);
    await still('batch.png');
  }

  // ---- export ----
  {
    await open(); await clean(); await open(); await slideAt('s-points'); await sleep(300);
    const b = await byTitle('导出成可在 PowerPoint'); await click(b.x, b.y);
    await until(`[...document.querySelectorAll('.ppt-toast')].some((t) => t.textContent.includes('导出完成'))`, 60000); await sleep(300);
    await still('export.png');
  }
} finally {
  ws.close(); edge.kill(); server.kill();
  await sleep(500); fs.rmSync(SCRATCH, { recursive: true, force: true });
}
