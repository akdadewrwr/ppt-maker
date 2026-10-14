# ppt-maker 基础编辑 2a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 页面上直接完成选中、拖动 / 拉伸块、文字格式、块样式、增删页，以及覆盖所有修改（包括 Claude 的）的撤销 / 重做；每次直接操作都通知 Claude。

**Architecture:** 每个直接修改是 `ppt/ops.js` 中的一个确定性 op：先作用于当前页面，再在保存时作用于从 `GET /api/deck` 取来的文件原文，然后整份 PUT 回去。待保存 op 存在 localStorage 中，冲突或断线后刷新时重放。`server.py` 新增 `History`：每次 PUT 存快照，后台线程每 0.5 秒捕获 Claude 的直接写入，`/api/undo` / `/api/redo` 恢复快照。`ppt/toolbar.js` 只负责界面（顶栏、浮动栏、取色弹层、选中框与手柄），所有动作通过回调交给 `editor.js`。

**Tech Stack:** Python ≥3.9 标准库；原生 JS/CSS；浏览器测试用 Node ≥22（自带 WebSocket）+ Edge/Chrome 的 DevTools 协议。

**Spec:** `docs/superpowers/specs/2026-10-14-ppt-maker-basic-editing-design.md`（2a 部分：§2、§3.1–3.3、§4（不含 2b 项）、§5、§7、§8）

## Global Constraints

- 不新增任何运行时依赖；服务端只用 Python 标准库；前端无构建步骤、不联网。
- op 只用绝对值；同一组 op 作用于两份相同文档，结果必须逐字相同。
- `setStyle` 白名单：`grid-area, background, border, border-radius, box-shadow, text-align, color, font-size, font-weight, font-style, text-decoration, opacity`（比 spec §3.2 多了 `font-weight / font-style / text-decoration`，用于整块加粗、斜体、下划线，见 Task 3 的 Ruling）。
- 块网格固定 16 列 × 9 行；`grid-area` 中行范围 1–10、列范围 1–17；拖动 / 拉伸最小 1×1 格；只有直接位于 `section.slide` 下、且带 id 的块可以拖动和拉伸。
- 历史最多 200 份；撤销 / 重做 / 历史信息接口都要求口令，并经过 Host 校验。
- 编辑层新增的所有节点都在 `#ppt-ui` 里，保存只基于文件原文（沿用子项目 1 的约束）。
- localStorage 键都按 deck 口令区分：`ppt-ops`（待保存 op）、`ppt-recent-colors`，以及已有的 `ppt-queue / ppt-dismissed / ppt-lint-seen`。
- 测试 deck 只能放在 `decks/e2e-*`，**测试脚本绝不删除其他目录**。

## Review Focus

1. **Claude 写的块没有内联 `grid-area`，或用了 `span`**：拖动时不能跳位，应从实际布局推算网格 → Task 3 selftest `gridOf fallback`。
2. **块内元素自带 `color / font-size`**（Claude 常写 `<h1 style="font-size:56px">`）：整块改字号 / 字色必须真正生效 → Task 3 selftest `deep style strips inner`，Task 6 e2e `F size select deep`。
3. **改字模式中用下拉框或取色器改格式**：焦点移到工具栏时不能退出改字模式、不能丢失选区 → Task 6 e2e `F edit-mode colour wraps span`。
4. **移动后立刻按撤销**：必须先保存再撤销，不能撤到更早的版本 → Task 5 e2e `U undo right after move undoes the move`。
5. **服务端自己写文件不能被当成 Claude 的修改再记一次** → Task 2 `test_undo_not_rerecorded_by_watcher`。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `tests/e2e.mjs` | 浏览器驱动测试（开发用）；只操作 `decks/e2e-smoke` |
| `ppt/server.py` | + `History`、`claude_label`、`watch`；PUT 存快照；`/api/undo`、`/api/redo`；`/api/state` 带 `history` |
| `ppt/test_server.py` | + `HistoryTests` |
| `ppt/ops.js` | 新：`PPTOps.apply / newId / clampGrid / STYLE_OK` |
| `ppt/geom.js` | + `gridOf`、`dragGrid`、`gridStr` |
| `ppt/selftest.html` | + ops 与网格拖动用例 |
| `ppt/toolbar.js` | 新：`PPTToolbar.create(ui, cb)` |
| `ppt/editor.js` | op 队列持久化；选中模型；拖动 / 拉伸；键盘；撤销；工具栏回调 |
| `ppt/editor.css` | 顶栏、浮动栏、选中框、手柄、取色弹层 |
| `.claude/commands/ppt.md` | 新格式规则与撤销规则 |

---

### Task 1: 浏览器测试脚本入库

**Files:**
- Create: `tests/e2e.mjs`（来源：本会话 scratchpad 中的 `e2e.mjs`，当前 35 项全部通过）

**Interfaces:**
- Produces: `node tests/e2e.mjs [repo]` → 退出码 0 表示全部通过；末行 `N/N passed`。后续任务往文件末尾的 `// ---- add new checks above ----` 标记之前追加检查。可用的辅助函数：`open, drag, click, dblclick, type, enter, rectOf, ev, check, inbox, deckHtml, sleep, send, shot, startServer, url, server`。

- [ ] **Step 1: 复制并通用化**

```bash
cp "$SCRATCH/e2e.mjs" tests/e2e.mjs   # $SCRATCH = 本会话 scratchpad 目录
```
然后在 `tests/e2e.mjs` 中做以下替换：
1. 文件头注释改为：
   ```js
   // Browser-driven checks for the editor layer (dev only): node tests/e2e.mjs [repo]
   // Needs Node >= 22 and Edge or Chrome. Uses decks/e2e-smoke only — never touches other decks.
   ```
2. `const REPO = process.argv[2];` → `const REPO = process.argv[2] || process.cwd();`
3. `const SCRATCH = …` → 
   ```js
   const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-e2e-'));
   ```
   并在 import 中加 `import os from 'node:os';`
4. `const DECK = path.join(REPO, 'decks', 'smoke');` → `'e2e-smoke'`；同时把 `'decks/smoke'` 全部替换为 `'decks/e2e-smoke'`。
5. `const EDGE = '…msedge.exe';` → 
   ```js
   const EDGE = process.env.PPT_BROWSER || [
     'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe',
     '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium',
   ].find((p) => fs.existsSync(p));
   if (!EDGE) { console.error('no Edge/Chrome found; set PPT_BROWSER'); process.exit(2); }
   ```
6. 在 `check('no page JS errors'` 之前加一行标记：`  // ---- add new checks above ----`
7. `finally` 块中，在 `process.exit` 之前加：`fs.rmSync(DECK, { recursive: true, force: true });`

- [ ] **Step 2: 运行**

Run: `node tests/e2e.mjs`
Expected: `35/35 passed`，退出码 0；运行后 `decks/` 中只剩原有目录（`decks/e2e-smoke` 已删除）。

- [ ] **Step 3: Commit**

```bash
git add tests/e2e.mjs
git commit -m "test: add browser e2e driver to the repo"
```

---

### Task 2: 历史快照与撤销 / 重做（服务端）

**Files:**
- Modify: `ppt/server.py`
- Test: `ppt/test_server.py`

**Interfaces:**
- Consumes: `runtime, deck_version, read_jsonl, statuses, add_event, LOCK, now_iso`
- Produces:
  - `HISTORY_MAX = 200`、`WATCH_SECS = 0.5`
  - `claude_label(deck) -> str`：`"Claude 处理 #eN"`（outbox 中最近一条处理中的事件）或 `"Claude 修改"`
  - `class History(deck)`：`.rows: list[dict{n,by,label,ts}]`、`.cur: int`、`.ok: bool`、`.record(by, label)`、`.sync()`、`.step(d) -> row|None`、`.info() -> {ok, canUndo, canRedo, undoLabel, redoLabel}`；调用方必须持有 `LOCK`
  - `make_server` 之后：`srv.history: History`、`srv.stopped: threading.Event`；后台线程 `watch(srv)`
  - HTTP：`PUT /api/deck` body 可带 `label`（≤200 字）；`POST /api/undo|redo?t=` → 200 `{version}` / 409；`GET /api/state` 多返回 `history`
  - edit 事件多了 `label`（undo / redo 事件还带 `op`）；`summary()` 在 `text` 为空时显示 `label`

- [ ] **Step 1: 写失败测试（追加到 `ppt/test_server.py`，放在 `class CliTests` 之前）**

```python
class HistoryTests(ServerCase):
    def put(self, html, label="改背景色"):
        ver = json.loads(self.req("GET", "/api/state?t=tok")[1])["version"]
        return self.req("PUT", "/api/deck?t=tok", {"version": ver, "html": html, "label": label})

    def deck_text(self):
        return (self.deck / "deck.html").read_text(encoding="utf-8")

    def test_put_records_user_snapshot(self):
        a = self.deck_text()
        self.assertEqual(self.put(a.replace("副标题", "B"))[0], 200)
        h = self.srv.history
        self.assertEqual((h.rows[-1]["by"], h.rows[-1]["label"]), ("user", "改背景色"))
        s = json.loads(self.req("GET", "/api/state?t=tok")[1])["history"]
        self.assertEqual((s["canUndo"], s["undoLabel"], s["canRedo"]), (True, "改背景色", False))
        self.assertEqual(inbox(self.deck)[-1]["label"], "改背景色")
        self.assertIn("改背景色", server.summary(inbox(self.deck)[-1]))

    def test_external_write_recorded_as_claude(self):
        server.reply(self.deck, "e3", ack=True)
        (self.deck / "deck.html").write_text(self.deck_text().replace("副标题", "C"), encoding="utf-8")
        _time.sleep(1.2)  # watcher runs every 0.5 s
        self.assertEqual((self.srv.history.rows[-1]["by"], self.srv.history.rows[-1]["label"]), ("claude", "Claude 处理 #e3"))

    def test_undo_redo_roundtrip(self):
        a = self.deck_text()
        self.put(a.replace("副标题", "B"))
        b = self.deck_text()
        self.assertEqual(self.req("POST", "/api/undo?t=tok", {})[0], 200)
        self.assertEqual(self.deck_text(), a)
        ev = inbox(self.deck)[-1]
        self.assertEqual((ev["type"], ev["op"], ev["label"]), ("edit", "undo", "撤销了 改背景色"))
        self.assertEqual(self.req("POST", "/api/redo?t=tok", {})[0], 200)
        self.assertEqual(self.deck_text(), b)
        self.req("POST", "/api/undo?t=tok", {})
        self.put(a.replace("副标题", "C"), "改字")          # a new change drops the redo branch
        self.assertEqual(self.req("POST", "/api/redo?t=tok", {})[0], 409)

    def test_nothing_to_undo_and_token(self):
        self.assertEqual(self.req("POST", "/api/undo?t=tok", {})[0], 409)
        self.assertEqual(self.req("POST", "/api/undo", {})[0], 403)
        self.assertEqual(self.req("POST", "/api/redo?t=no", {})[0], 403)

    def test_undo_not_rerecorded_by_watcher(self):
        self.put(self.deck_text().replace("副标题", "B"))
        self.req("POST", "/api/undo?t=tok", {})
        n = len(self.srv.history.rows)
        _time.sleep(1.2)
        self.assertEqual(len(self.srv.history.rows), n)

    def test_cap(self):
        old = server.HISTORY_MAX
        server.HISTORY_MAX = 5
        try:
            for i in range(8):
                self.put(self.deck_text().replace("</body>", f"<!--{i}--></body>"), f"第{i}步")
            h = self.srv.history
            self.assertEqual(len(h.rows), 5)
            self.assertEqual(len(list(h.dir.glob("*.html"))), 5)
            self.assertEqual(h.rows[-1]["label"], "第7步")
        finally:
            server.HISTORY_MAX = old

    def test_snapshot_failure_does_not_block_save(self):
        self.srv.history.dir = self.deck / "missing" / "dir"
        self.assertEqual(self.put(self.deck_text().replace("副标题", "B"))[0], 200)
        self.assertIn(">B<", self.deck_text())
        s = json.loads(self.req("GET", "/api/state?t=tok")[1])["history"]
        self.assertEqual((s["ok"], s["canUndo"]), (False, False))

    def test_restart_keeps_position(self):
        a = self.deck_text()
        self.put(a.replace("副标题", "B"))
        self.req("POST", "/api/undo?t=tok", {})
        with server.LOCK:
            h2 = server.History(self.deck)
        self.assertEqual((h2.cur, len(h2.rows)), (self.srv.history.cur, len(self.srv.history.rows)))
        self.assertTrue(h2.info()["canRedo"])
```

- [ ] **Step 2: 运行，确认失败**

Run: `python ppt/test_server.py HistoryTests`
Expected: 全部报错，原因是 `AttributeError: 'Server' object has no attribute 'history'`（或 405 / 404 状态码不符）

- [ ] **Step 3: 实现**

在 `ppt/server.py` 的 `ONLINE_SECS = 30` 之后加：
```python
HISTORY_MAX = 200
WATCH_SECS = 0.5
```

在 `reply()` 之后加：
```python
def claude_label(deck):
    working = [i for i, s in statuses(deck).items() if s == "processing"]
    return f"Claude 处理 #{working[-1]}" if working else "Claude 修改"


class History:
    """Snapshots of deck.html: .ppt/history/NNNN.html + index.jsonl + cur. Callers hold LOCK."""

    def __init__(self, deck):
        self.deck = Path(deck)
        self.dir = runtime(deck) / "history"
        self.dir.mkdir(exist_ok=True)
        self.rows = read_jsonl(self.dir / "index.jsonl")
        try:
            self.cur = min(int((self.dir / "cur").read_text(encoding="utf-8")), len(self.rows) - 1)
        except (OSError, ValueError):
            self.cur = len(self.rows) - 1
        self.ok = True
        if self.cur < 0 or self._read(self.cur) != (self.deck / "deck.html").read_bytes():
            self.record("claude", "外部修改")  # changed while the server was not running
        self.known = deck_version(self.deck)

    def _file(self, i):
        return self.dir / f"{self.rows[i]['n']:04d}.html"

    def _read(self, i):
        try:
            return self._file(i).read_bytes()
        except OSError:
            return None

    def _save_meta(self):
        (self.dir / "index.jsonl").write_text(
            "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in self.rows), encoding="utf-8")
        (self.dir / "cur").write_text(str(self.cur), encoding="utf-8")

    def record(self, by, label):
        self.known = deck_version(self.deck)
        try:
            for i in range(self.cur + 1, len(self.rows)):  # a new change drops the redo branch
                self._file(i).unlink(missing_ok=True)
            self.rows = self.rows[:self.cur + 1]
            n = self.rows[-1]["n"] + 1 if self.rows else 1
            (self.dir / f"{n:04d}.html").write_bytes((self.deck / "deck.html").read_bytes())
            self.rows.append({"n": n, "by": by, "label": label, "ts": now_iso()})
            while len(self.rows) > HISTORY_MAX:
                self._file(0).unlink(missing_ok=True)
                self.rows.pop(0)
            self.cur = len(self.rows) - 1
            self._save_meta()
            self.ok = True
        except OSError as e:  # never block a save because history could not be written
            self.ok = False
            print(f"history: snapshot failed: {e}", file=sys.stderr)

    def sync(self):
        """Record a write made outside the server (Claude editing deck.html)."""
        if deck_version(self.deck) != self.known:
            self.record("claude", claude_label(self.deck))

    def step(self, d):
        """Undo (d=-1) or redo (d=+1); returns the row undone/redone, or None."""
        j = self.cur + d
        if not self.ok or not 0 <= j < len(self.rows):
            return None
        data = self._read(j)
        if data is None:
            return None
        row = self.rows[self.cur] if d < 0 else self.rows[j]
        (self.deck / "deck.html").write_bytes(data)
        self.known = deck_version(self.deck)  # our own write: the watcher must not record it again
        self.cur = j
        self._save_meta()
        return row

    def info(self):
        can_u = self.ok and self.cur > 0
        can_r = self.ok and self.cur < len(self.rows) - 1
        return {"ok": self.ok, "canUndo": can_u, "canRedo": can_r,
                "undoLabel": self.rows[self.cur]["label"] if can_u else "",
                "redoLabel": self.rows[self.cur + 1]["label"] if can_r else ""}


def watch(srv):
    while not srv.stopped.wait(WATCH_SECS):
        with LOCK:
            try:
                srv.history.sync()
            except OSError:
                pass  # deck.html briefly missing while an editor replaces it
```

`summary()` 中：
```python
    text = e.get("text") or (json.dumps(e["issues"], ensure_ascii=False) if e.get("issues") else "")
```
改为
```python
    text = e.get("text") or e.get("label") or (json.dumps(e["issues"], ensure_ascii=False) if e.get("issues") else "")
```

`do_GET` 中：
```python
        if path == "/api/state":
            return self.send(200, state(deck))
```
改为
```python
        if path == "/api/state":
            return self.send(200, {**state(deck), "history": self.server.history.info()})
```

`do_POST` 中，`if url.path != "/api/event":` 之前插入：
```python
        if url.path in ("/api/undo", "/api/redo"):
            kind = url.path[len("/api/"):]
            with LOCK:
                row = self.server.history.step(-1 if kind == "undo" else 1)
                if not row:
                    return self.send(409, {"error": f"nothing to {kind}"})
                verb = "撤销了" if kind == "undo" else "重做了"
                add_event(self.server.deck, {"type": "edit", "op": kind, "label": f"{verb} {row['label']}"})
                return self.send(200, {"version": deck_version(self.server.deck)})
```

`do_PUT` 中：
```python
            (deck / "deck.html").write_bytes(html.encode("utf-8"))
            new = deck_version(deck)
            add_event(deck, {"type": "edit", "slide_id": body.get("slide_id"), "block": body.get("block")})
```
改为
```python
            (deck / "deck.html").write_bytes(html.encode("utf-8"))
            new = deck_version(deck)
            label = str(body.get("label") or "编辑")[:200]
            self.server.history.record("user", label)
            add_event(deck, {"type": "edit", "slide_id": body.get("slide_id"), "block": body.get("block"), "label": label})
```

`class Server` 中加：
```python
    def server_close(self):
        self.stopped.set()
        super().server_close()
```

`make_server` 末尾 `return srv` 之前加：
```python
    srv.stopped = threading.Event()
    with LOCK:
        srv.history = History(srv.deck)
    threading.Thread(target=watch, args=(srv,), daemon=True).start()
```

- [ ] **Step 4: 运行，确认通过**

Run: `python ppt/test_server.py`
Expected: 32 tests OK（24 + 8）

- [ ] **Step 5: Commit**

```bash
git add ppt/server.py ppt/test_server.py
git commit -m "feat: deck history snapshots with undo/redo covering Claude's edits"
```

---

### Task 3: `ops.js` 与网格拖动计算

**Files:**
- Create: `ppt/ops.js`
- Modify: `ppt/geom.js`、`ppt/selftest.html`

**Interfaces:**
- Produces `window.PPTOps`：
  - `apply(doc, {op, target?, args?, label?}) -> boolean`（未知 op、目标不存在、参数被拒绝时返回 false）
  - op 列表与参数：`setHTML{html}`、`setStyle{style:{prop: value|null}, deep?}`、`setGrid{grid:"r1/c1/r2/c2"}`、`insertBlock{id, slideId, grid, html}`、`remove`、`insertSlide{id, afterId, html?}`、`removeSlide`
  - `newId(doc, prefix) -> string`（前缀 + 6 位 [0-9a-z]，在 doc 中唯一）、`clampGrid(str) -> "r1 / c1 / r2 / c2"`、`STYLE_OK: Set`
- Produces in `window.PPTGeom`：`gridOf(el) -> {r1,c1,r2,c2}`、`dragGrid(g, dx, dy, handle) -> {r1,c1,r2,c2}`（`dx/dy` 为画布像素；`handle` ∈ `move,n,s,e,w,ne,nw,se,sw`）、`gridStr(g) -> "r1/c1/r2/c2"`

- [ ] **Step 1: 写失败自检（`ppt/selftest.html`）**

在 `<section class="slide" id="s1">…</section>` 之后加：
```html
<section class="slide" id="s2">
  <div class="block" id="e" style="grid-row:2/4;grid-column:3/span 2">span-based</div>
</section>
```
在 `<script src="geom.js"></script>` 之后加 `<script src="ops.js"></script>`。

在最终统计 `const r = document.getElementById('result');` 之前加：
```js
  // ---- grid drag maths ----
  check('gridOf inline', G.gridOf(document.getElementById('c')), {r1:3,c1:9,r2:9,c2:17});
  check('gridOf fallback', G.gridOf(document.getElementById('e')), {r1:2,c1:3,r2:4,c2:5});
  const g0 = {r1:3,c1:2,r2:6,c2:9};
  check('dragGrid move snaps', G.dragGrid(g0, 85, -10, 'move'), {r1:3,c1:3,r2:6,c2:10});
  check('dragGrid move clamps', G.dragGrid(g0, 2000, 2000, 'move'), {r1:7,c1:10,r2:10,c2:17});
  check('dragGrid resize min 1 cell', G.dragGrid(g0, -1000, 0, 'se'), {r1:3,c1:2,r2:6,c2:3});
  check('dragGrid resize nw clamps', G.dragGrid(g0, -1000, -1000, 'nw'), {r1:1,c1:1,r2:6,c2:9});
  check('gridStr', G.gridStr(g0), '3/2/6/9');

  // ---- ops ----
  const O = PPTOps;
  const SRC = '<!doctype html><html><head></head><body>\n<section class="slide" id="t1"><div class="block" id="a" style="grid-area:1/1/3/17"><h1 style="color:red;font-size:40px">T</h1></div><div class="obj" id="o1"></div></section>\n<section class="slide" id="t2"></section>\n</body></html>';
  const mk = () => new DOMParser().parseFromString(SRC, 'text/html');
  const ser = (d) => d.documentElement.outerHTML;
  const d = mk(), A = () => d.getElementById('a');
  check('ops setStyle ok / rejects unknown prop', [O.apply(d, {op:'setStyle', target:'a', args:{style:{background:'#ef4444'}}}),
    O.apply(d, {op:'setStyle', target:'a', args:{style:{position:'fixed'}}})], [true, false]);
  check('ops setStyle value', A().style.background, 'rgb(239, 68, 68)');
  O.apply(d, {op:'setStyle', target:'a', args:{style:{color:'#0000ff'}, deep:true}});
  check('ops deep style strips inner', [A().style.color, d.querySelector('#a h1').getAttribute('style')], ['rgb(0, 0, 255)', 'font-size: 40px;']);
  O.apply(d, {op:'setStyle', target:'a', args:{style:{background:null}}});
  check('ops setStyle clears', A().style.background, '');
  O.apply(d, {op:'setGrid', target:'a', args:{grid:'0/15/0/40'}});
  check('ops setGrid clamps', A().style.gridArea, '1 / 15 / 2 / 17');
  O.apply(d, {op:'insertBlock', args:{id:'b', slideId:'t1', grid:'4/6/6/12', html:'<p>x</p>'}});
  check('ops insertBlock goes before objects', [...d.getElementById('t1').children].map((n) => n.id), ['a', 'b', 'o1']);
  check('ops insertBlock refuses duplicate id', O.apply(d, {op:'insertBlock', args:{id:'b', slideId:'t1', grid:'1/1/2/2'}}), false);
  O.apply(d, {op:'remove', target:'b'});
  check('ops remove', d.getElementById('b'), null);
  check('ops missing target', O.apply(d, {op:'setHTML', target:'zz', args:{html:'x'}}), false);
  check('ops unknown op', O.apply(d, {op:'explode', target:'a'}), false);
  O.apply(d, {op:'insertSlide', args:{id:'t9', afterId:'t1'}});
  check('ops insertSlide after', [...d.querySelectorAll('section.slide')].map((s) => s.id), ['t1', 't9', 't2']);
  O.apply(d, {op:'removeSlide', target:'t9'}); O.apply(d, {op:'removeSlide', target:'t2'});
  check('ops keeps the last slide', O.apply(d, {op:'removeSlide', target:'t1'}), false);
  check('ops newId unique', /^b-[0-9a-z]{6}$/.test(O.newId(d, 'b-')), true);
  const SEQ = [
    {op:'setStyle', target:'a', args:{style:{'font-size':'32px', 'text-align':'center'}, deep:true}},
    {op:'setGrid', target:'a', args:{grid:'2/2/5/10'}},
    {op:'insertBlock', args:{id:'n1', slideId:'t1', grid:'5/2/7/8', html:'<p>新</p>'}},
    {op:'setHTML', target:'n1', args:{html:'<p><b>改</b></p>'}},
    {op:'insertSlide', args:{id:'t3', afterId:'t1'}},
    {op:'removeSlide', target:'t2'},
  ];
  const d1 = mk(), d2 = mk();
  SEQ.forEach((op) => { O.apply(d1, op); O.apply(d2, op); });
  check('ops deterministic on two copies', ser(d1) === ser(d2) && ser(d1) !== ser(mk()), true);
```

- [ ] **Step 2: 运行自检，确认失败**

Run:
```bash
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --disable-gpu --window-size=1400,1700 --user-data-dir="$TEMP/ppt-edge" --dump-dom "file:///$(pwd -W)/ppt/selftest.html" 2>/dev/null | grep -oE '<h1[^<]*</h1>'
```
Expected: 标题停在 `running…`（`G.gridOf is not a function`）

- [ ] **Step 3: 在 `ppt/geom.js` 中实现网格函数**

在 `function lint(slide) {` 之前加：
```js
  function gridOf(el) { // the block's grid lines; derived from layout when Claude used spans or no inline grid-area
    const s = el.style, n = (v) => parseInt(v, 10);
    const g = { r1: n(s.gridRowStart), c1: n(s.gridColumnStart), r2: n(s.gridRowEnd), c2: n(s.gridColumnEnd) };
    if ([g.r1, g.c1, g.r2, g.c2].every(Number.isFinite) && !/span/.test(s.gridArea)) return g;
    const [cols, rows] = rectToCells(elementRect(el.closest('section.slide').getBoundingClientRect(), el)).split('/');
    const [c1, c2] = cols.split('-').map(Number), [r1, r2] = rows.split('-').map(Number);
    return { r1, c1, r2: r2 + 1, c2: c2 + 1 };
  }

  function dragGrid(g, dx, dy, handle) { // dx/dy in canvas px; snaps to whole cells, keeps >= 1x1 and inside the grid
    const dc = Math.round(dx / (W / COLS)), dr = Math.round(dy / (H / ROWS));
    let { r1, c1, r2, c2 } = g;
    if (handle === 'move') {
      const h = r2 - r1, w = c2 - c1;
      r1 = clamp(r1 + dr, 1, ROWS + 1 - h); c1 = clamp(c1 + dc, 1, COLS + 1 - w);
      return { r1, c1, r2: r1 + h, c2: c1 + w };
    }
    if (handle.includes('n')) r1 = clamp(r1 + dr, 1, r2 - 1);
    if (handle.includes('s')) r2 = clamp(r2 + dr, r1 + 1, ROWS + 1);
    if (handle.includes('w')) c1 = clamp(c1 + dc, 1, c2 - 1);
    if (handle.includes('e')) c2 = clamp(c2 + dc, c1 + 1, COLS + 1);
    return { r1, c1, r2, c2 };
  }

  const gridStr = (g) => `${g.r1}/${g.c1}/${g.r2}/${g.c2}`;
```
导出行改为：
```js
  window.PPTGeom = { W, H, COLS, ROWS, clientToSlide, elementRect, slideToClient, rectToCells, hitBlocks, lint, gridOf, dragGrid, gridStr };
```

- [ ] **Step 4: 写 `ppt/ops.js`**

```js
// ppt-maker ops: every direct edit is {op, target, args, label}. apply() runs one on any Document.
// The page applies an op to the live DOM (instant feedback) and again to the parsed file text when
// saving, so ops must be deterministic and carry absolute values only ("move to 3/2/6/9", never "one cell right").
(() => {
  const STYLE_OK = new Set(['grid-area', 'background', 'border', 'border-radius', 'box-shadow', 'text-align',
    'color', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'opacity']);
  const DEEP = new Set(['color', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'text-align']);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function clampGrid(g) {
    const [r1, c1, r2, c2] = String(g).split('/').map((s) => parseInt(s, 10));
    const R1 = clamp(r1 || 1, 1, 9), C1 = clamp(c1 || 1, 1, 16);
    return `${R1} / ${C1} / ${clamp(r2 || R1 + 1, R1 + 1, 10)} / ${clamp(c2 || C1 + 1, C1 + 1, 17)}`;
  }
  function dropEmptyStyle(n) { if (!n.getAttribute('style')) n.removeAttribute('style'); }

  const OPS = {
    setHTML(doc, t, a) { t.innerHTML = a.html; },
    setStyle(doc, t, a) {
      const style = a.style || {};
      if (Object.keys(style).some((k) => !STYLE_OK.has(k))) return false;
      for (const [k, v] of Object.entries(style)) {
        if (v == null || v === '') t.style.removeProperty(k); else t.style.setProperty(k, v);
        // a whole-block text style must win over values inner elements carry themselves
        if (a.deep && DEEP.has(k)) t.querySelectorAll('[style]').forEach((n) => { n.style.removeProperty(k); dropEmptyStyle(n); });
      }
      dropEmptyStyle(t);
    },
    setGrid(doc, t, a) { t.style.gridArea = clampGrid(a.grid); },
    insertBlock(doc, _, a) {
      const s = doc.getElementById(a.slideId);
      if (!s || !a.id || doc.getElementById(a.id)) return false;
      const b = doc.createElement('div');
      b.className = 'block'; b.id = a.id; b.style.gridArea = clampGrid(a.grid); b.innerHTML = a.html || '';
      const ref = s.querySelector(':scope > .obj'); // blocks stay below floating objects
      s.insertBefore(doc.createTextNode('\n  '), ref);
      s.insertBefore(b, ref);
    },
    remove(doc, t) { t.remove(); },
    insertSlide(doc, _, a) {
      const after = doc.getElementById(a.afterId);
      if (!after || !a.id || doc.getElementById(a.id)) return false;
      const s = doc.createElement('section');
      s.className = 'slide'; s.id = a.id; s.innerHTML = a.html || '';
      after.after(doc.createTextNode('\n'), s);
    },
    removeSlide(doc, t) {
      if (doc.querySelectorAll('section.slide').length < 2) return false;
      t.remove();
    },
  };

  function apply(doc, op) {
    const fn = OPS[op && op.op];
    if (!fn) return false;
    const t = op.target ? doc.getElementById(op.target) : null;
    if (op.target && !t) return false;
    return fn(doc, t, op.args || {}) !== false;
  }

  function newId(doc, prefix) {
    let id;
    do { id = prefix + Math.random().toString(36).slice(2, 8).padEnd(6, '0'); } while (doc.getElementById(id));
    return id;
  }

  window.PPTOps = { apply, newId, clampGrid, STYLE_OK };
})();
```

- [ ] **Step 5: 运行自检，确认通过**

Run: 同 Step 2，把 grep 换成 `grep -oE '<h1[^<]*</h1>|<li class="fail">[^<]*'`
Expected: `PASS 35/35`（14 + 7 + 14），没有 fail 行

- [ ] **Step 6: Commit**

```bash
git add ppt/ops.js ppt/geom.js ppt/selftest.html
git commit -m "feat: deterministic edit ops and grid drag maths"
```

---

### Task 4: 把保存改为 op 队列

**Files:**
- Modify: `ppt/editor.js`、`ppt/server.py`（INJECT）

**Interfaces:**
- Consumes: `PPTOps.apply`（Task 3）、`PUT /api/deck` 的 `label`（Task 2）
- Produces（editor.js 内部，Task 5/6 使用）：
  - `commit(op) -> Promise`：在当前页面执行 op（失败则弹提示并返回），追加到 `ppt-ops`，然后保存
  - `persist() -> Promise`：串行保存全部待保存 op
  - `applyPending()`：刷新后重放 `ppt-ops`
  - `runLint(silent)`：`silent=true` 时只把当前问题记为已见，不上报

- [ ] **Step 1: INJECT 加入 ops.js 与 toolbar.js**

`ppt/server.py` 中：
```python
          '<script src="/_ppt/geom.js" data-ppt></script>'
          '<script src="/_ppt/editor.js" data-ppt></script>')
```
改为
```python
          '<script src="/_ppt/geom.js" data-ppt></script>'
          '<script src="/_ppt/ops.js" data-ppt></script>'
          '<script src="/_ppt/toolbar.js" data-ppt></script>'
          '<script src="/_ppt/editor.js" data-ppt></script>')
```
并新建占位 `ppt/toolbar.js`（Task 5 中替换为完整实现）：
```js
// ppt-maker toolbars — filled in by the basic-editing 2a plan, Task 5.
```

- [ ] **Step 2: editor.js 头部**

```js
  const G = window.PPTGeom, TOKEN = window.PPT.token;
```
改为
```js
  const G = window.PPTGeom, O = window.PPTOps, TOKEN = window.PPT.token;
```

- [ ] **Step 3: endEdit 改为提交 setHTML op**

```js
    if (block.innerHTML !== before) await (lastSave = saveDeck(block));
```
改为
```js
    if (block.innerHTML !== before) await commit({ op: 'setHTML', target: block.id, args: { html: block.innerHTML }, label: `改字 ${block.id}` });
```

- [ ] **Step 4: 替换 `saveDeck` 与 `applyReplay`**

把从 `  async function saveDeck(block) {` 到它的结束 `  }`（`finally { saving = false; }` 之后那一行）整段替换为：
```js
  // ---- direct edits: ops applied live, queued, then saved onto the file text ----
  let chain = Promise.resolve();
  function commit(op) {
    if (!O.apply(document, op)) { toast('这一步没有生效（目标已不存在）'); return lastSave; }
    ls.set('ppt-ops', [...ls.get('ppt-ops', []), op]); // survives reloads, server restarts and closed tabs
    return (lastSave = persist());
  }
  function persist() { return (chain = chain.then(saveOnce)); }
  async function saveOnce() {
    const ops = ls.get('ppt-ops', []);
    if (!ops.length) return;
    saving = true;
    try {
      // rebuild from the file text, not the live DOM: extensions and deck scripts must not leak into deck.html
      const raw = await (await fetch(api('/api/deck'), { cache: 'no-store' })).json();
      if (raw.version !== version) { replayPending = true; return; } // file moved on: poll reloads when idle, ops replay on load
      const doc = new DOMParser().parseFromString(raw.html, 'text/html');
      ops.forEach((op) => O.apply(doc, op));
      const last = ops[ops.length - 1], target = last.target && document.getElementById(last.target);
      const r = await fetch(api('/api/deck'), { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version, html: '<!doctype html>\n' + doc.documentElement.outerHTML,
          label: ops.map((o) => o.label).filter(Boolean).join('，').slice(0, 200),
          block: last.target || last.args?.id, slide_id: target?.closest('section.slide')?.id || last.args?.slideId }) });
      if (r.status === 409) { replayPending = true; return; }
      if (!r.ok) throw new Error(String(r.status));
      version = (await r.json()).version;
      ls.set('ppt-ops', ls.get('ppt-ops', []).slice(ops.length)); // ops committed during the await stay queued
      runLint(true); // the user's own edits are intentional: don't send Claude to "fix" them
    } catch { replayPending = true; offline = true; render(); } // next good poll reloads and replays
    finally { saving = false; }
  }
```

把整个 `function applyReplay() { … }` 替换为：
```js
  function applyPending() { // after a conflict or outage: re-run unsaved ops on the fresh file
    const ops = ls.get('ppt-ops', []);
    if (!ops.length) return;
    const lost = ops.filter((op) => !O.apply(document, op));
    if (lost.length) toast(`有 ${lost.length} 步修改没有生效（目标已被删除），内容如下：`,
      lost.map((o) => (o.op === 'setHTML' ? o.args.html.replace(/<[^>]+>/g, '') : o.label)).join('\n'));
    ls.set('ppt-ops', ops.filter((op) => !lost.includes(op)));
    if (lost.length < ops.length) lastSave = persist();
  }
```
并把最后一行中的 `applyReplay();` 改为 `applyPending();`。

- [ ] **Step 5: runLint 支持静默**

```js
  function runLint() {
```
改为
```js
  function runLint(silent) {
```
并把
```js
    if (fresh.length) enqueue({ type: 'lint', issues: fresh });
```
改为
```js
    if (fresh.length && !silent) enqueue({ type: 'lint', issues: fresh });
```

- [ ] **Step 6: 回归**

Run: `python ppt/test_server.py && node tests/e2e.mjs`
Expected: 32 OK；`35/35 passed`（尤其 `4 …`、`6 both changes kept after 409 replay`、`I2b both offline edits saved after restart`、`I3 …` 都通过）

- [ ] **Step 7: Commit**

```bash
git add ppt/editor.js ppt/server.py ppt/toolbar.js
git commit -m "refactor: save direct edits as a replayable op queue"
```

---

### Task 5: 选中、顶栏、拖动 / 拉伸、键盘、撤销

**Files:**
- Modify: `ppt/toolbar.js`（完整实现）、`ppt/editor.js`、`ppt/editor.css`
- Test: `tests/e2e.mjs`

**Interfaces:**
- Consumes: `commit, persist, lastSave, ls, api, toast, reload, place, el, slides, openPop, submitIntent, closePop`（editor.js）；`G.gridOf / dragGrid / gridStr / elementRect`；`O.newId`；`/api/undo|redo`；`state.history`
- Produces `window.PPTToolbar.create(ui, cb) -> tb`：
  - `cb`：`{ place, undo, redo, addText, addSlide, removeSlide, startResize(handle, event), textStyle(style), blockStyle(style), toggle(cmd), border({color?, width?}), toggleShadow(), remove(), ask(), themeColors() -> string[], recentColors() -> string[] }`
  - `tb.select(el|null, {editing, resizable})`、`tb.reposition()`、`tb.setHistory(info)`、`tb.setStatus(text, off)`、`tb.setSlideCount(n)`
  - DOM 约定（e2e 依赖）：顶栏 `.ppt-top`，状态 `.ppt-status`（带 `off` 类表示断开），选中框 `.ppt-frame`，手柄 `.ppt-handle[data-handle=nw|n|ne|e|se|s|sw|w]`，浮动栏 `.ppt-bar`，取色弹层 `.ppt-colors`，色块 `button.ppt-swatch[title=<颜色>]`；按钮用 `title` 标识：`撤销 / 重做`（悬停文字以此开头）、`在当前页中央插入文字块`、`在当前页之后插入空白页`、`删除当前页`、`字色`、`字号`、`加粗`、`斜体`、`下划线`、`对齐`、`背景色`、`边框颜色`、`边框粗细`、`圆角`、`阴影`、`删除`、`问 Claude`

- [ ] **Step 1: 写失败的 e2e 检查**

在 `tests/e2e.mjs` 的辅助函数区（`const statusText = …` 之后）加：
```js
const byTitle = (t) => ev(`(() => { const b = [...document.querySelectorAll('#ppt-ui [title]')].find((n) => n.title.startsWith(${JSON.stringify(t)}) && n.offsetParent); if (!b) return null; const r = b.getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: !!b.disabled}; })()`);
const key = (k, code, vk, modifiers = 0) => send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers })
  .then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers }));
const kZoom = () => ev(`document.querySelector('section.slide').getBoundingClientRect().width / 1280`);
```
在 `// ---- add new checks above ----` 之前加：
```js
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
```

- [ ] **Step 2: 运行，确认失败**

Run: `node tests/e2e.mjs`
Expected: 35 项原有检查通过；新增的 `S / T / K / U` 检查失败（例如 `S click selects …` 为 FAIL，`byTitle` 返回 null 时脚本可能报 TypeError，同样算失败）

- [ ] **Step 3: 写 `ppt/toolbar.js`**

```js
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
```

- [ ] **Step 4: `ppt/editor.css`**

把
```css
.ppt-status { position: fixed; top: 8px; right: 8px; padding: 4px 12px; border-radius: 999px; background: #111; color: #fff; z-index: 2147483001; }
.ppt-status.off { background: #dc2626; }
```
替换为
```css
body { padding-top: 48px; }
#ppt-ui [hidden] { display: none !important; }
.ppt-top { position: fixed; top: 0; left: 0; right: 0; min-height: 40px; display: flex; flex-wrap: wrap; align-items: center; gap: 2px;
  padding: 4px 12px; box-sizing: border-box; background: #fff; border-bottom: 1px solid #e5e7eb; box-shadow: 0 1px 4px rgba(0,0,0,.06); z-index: 2147483001; }
.ppt-btn { font: inherit; color: #111; background: none; border: 1px solid transparent; border-radius: 6px; padding: 3px 8px; cursor: pointer; }
.ppt-btn:hover:not(:disabled) { background: #f3f4f6; }
.ppt-btn:disabled { color: #9ca3af; cursor: default; }
.ppt-sep { width: 1px; height: 20px; background: #e5e7eb; margin: 0 4px; }
.ppt-status { margin-left: auto; padding: 2px 10px; border-radius: 999px; background: #111; color: #fff; }
.ppt-status.off { background: #dc2626; }
.ppt-frame { outline: 2px solid #2563eb; pointer-events: none; box-sizing: border-box; }
.ppt-handle { position: absolute; width: 10px; height: 10px; margin: -6px 0 0 -6px; background: #fff; border: 2px solid #2563eb; border-radius: 2px; box-sizing: border-box; pointer-events: auto; }
.ppt-handle[data-handle="nw"] { left: 0; top: 0; cursor: nwse-resize; } .ppt-handle[data-handle="n"] { left: 50%; top: 0; cursor: ns-resize; }
.ppt-handle[data-handle="ne"] { left: 100%; top: 0; cursor: nesw-resize; } .ppt-handle[data-handle="e"] { left: 100%; top: 50%; cursor: ew-resize; }
.ppt-handle[data-handle="se"] { left: 100%; top: 100%; cursor: nwse-resize; } .ppt-handle[data-handle="s"] { left: 50%; top: 100%; cursor: ns-resize; }
.ppt-handle[data-handle="sw"] { left: 0; top: 100%; cursor: nesw-resize; } .ppt-handle[data-handle="w"] { left: 0; top: 50%; cursor: ew-resize; }
.ppt-bar { display: flex; align-items: center; gap: 2px; padding: 3px; white-space: nowrap; background: #fff; border: 1px solid #d1d5db; border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,.15); }
.ppt-bar select { font: inherit; max-width: 84px; border: 1px solid #e5e7eb; border-radius: 4px; padding: 1px 2px; }
.ppt-b { font-weight: 700; } .ppt-i { font-style: italic; } .ppt-u { text-decoration: underline; }
.ppt-ask { color: #2563eb; }
.ppt-colors { width: 248px; padding: 8px; box-sizing: border-box; background: #fff; border: 1px solid #d1d5db; border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,.15); }
.ppt-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-bottom: 6px; }
.ppt-row .who { width: 100%; color: #6b7280; }
.ppt-swatch { width: 20px; height: 20px; padding: 0; border: 1px solid #d1d5db; border-radius: 4px; }
```

- [ ] **Step 5: editor.js — 工具栏、选中、拖动、键盘、撤销**

5a. 删除
```js
  const status = el('div', 'ppt-status', ui, '连接中…');
```
在 `const marks = el('div', null, ui);` 之后加：
```js
  let selected = null, savedRange = null;
  const movable = (b) => !!b && b.id && b.classList.contains('block') && b.parentElement?.matches('section.slide');
  function select(b) { selected = b; tb.select(b, { editing: !!editing && editing.block === b, resizable: movable(b) }); }
  function currentSlide() { // the slide showing the most area in the viewport
    let best = slides()[0], most = -1;
    for (const s of slides()) {
      const r = s.getBoundingClientRect(), vis = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (vis > most) { most = vis; best = s; }
    }
    return best;
  }
  const themeColors = () => [...new Set([...(document.getElementById('theme')?.textContent || '').matchAll(/--[\w-]+\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/g)].map((m) => m[1]))];
  function rememberColor(c) { if (c) ls.set('ppt-recent-colors', [c, ...ls.get('ppt-recent-colors', []).filter((x) => x !== c)].slice(0, 8)); }
  const tb = PPTToolbar.create(ui, {
    place, themeColors, recentColors: () => ls.get('ppt-recent-colors', []),
    undo: () => undoRedo('undo'), redo: () => undoRedo('redo'),
    addText, addSlide, removeSlide,
    startResize(handle, e) { if (selected) drag = { mode: handle, el: selected, slide: selected.closest('section.slide'), x0: e.clientX, y0: e.clientY, g0: G.gridOf(selected) }; },
    textStyle, blockStyle, toggle, border, toggleShadow,
    remove() { if (!selected) return; const id = selected.id; select(null); commit({ op: 'remove', target: id, label: `删除 ${id}` }); },
    ask: askSelected,
  });
  addEventListener('scroll', () => tb.reposition(), { passive: true });
```
（`textStyle / blockStyle / toggle / border / toggleShadow` 在 Task 6 中实现；本任务先加占位，使工具栏可以加载：）
```js
  function textStyle() {} function blockStyle() {} function toggle() {} function border() {} function toggleShadow() {}
```

5b. `resize` 监听改为：
```js
  addEventListener('resize', () => { fit(); render(); tb.reposition(); });
```

5c. `render()` 开头三行
```js
    const pending = ls.get('ppt-queue', []).length;
    status.className = 'ppt-status' + (offline ? ' off' : '');
    status.textContent = offline ? `服务断开${pending ? ` · ${pending} 条待发送` : ''}`
      : `${online ? '● Claude 在线' : '○ Claude 离线'}${pending ? ` · ${pending} 条发送中` : ''}`;
```
替换为
```js
    const pending = ls.get('ppt-queue', []).length;
    tb.setStatus(offline ? `服务断开${pending ? ` · ${pending} 条待发送` : ''}`
      : `${online ? '● Claude 在线' : '○ Claude 离线'}${pending ? ` · ${pending} 条发送中` : ''}`, offline);
    tb.setHistory(offline ? null : state?.history);
    tb.setSlideCount(slides().length);
```
（`tb` 在 `render` 第一次被调用之前已创建：`poll()` 是异步的，`tb` 在同步代码中先完成初始化。）

5d. 用下面整段替换从 `  document.addEventListener('mousedown', (e) => {` 到 `mouseup` 监听结束（`openPop(slide, r, box, …);\n  });`）的三个监听：
```js
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('#ppt-ui')) return;
    if (editing) {
      if (!editing.block.contains(e.target) && document.activeElement !== editing.block) endEdit(); // focus went to a toolbar control earlier
      return;
    }
    const slide = e.target.closest('section.slide');
    if (!slide) { select(null); return; }
    e.preventDefault();
    closePop();
    if (selected && selected.contains(e.target) && movable(selected)) {
      drag = { mode: 'move', el: selected, slide, x0: e.clientX, y0: e.clientY, g0: G.gridOf(selected), target: e.target };
      return;
    }
    drag = { mode: 'area', slide, x0: e.clientX, y0: e.clientY, box: el('div', 'ppt-abs ppt-sel', ui) };
    place(drag.box, { left: e.clientX, top: e.clientY, width: 0, height: 0 });
  });
  addEventListener('mousemove', (e) => {
    if (!drag) return;
    const sr = drag.slide.getBoundingClientRect();
    if (drag.mode === 'area') return place(drag.box, G.slideToClient(sr, G.clientToSlide(sr, drag.x0, drag.y0, e.clientX, e.clientY)));
    const k = G.W / sr.width; // live preview only; the op is committed on mouseup
    drag.el.style.gridArea = G.gridStr(G.dragGrid(drag.g0, (e.clientX - drag.x0) * k, (e.clientY - drag.y0) * k, drag.mode));
    tb.reposition();
  });
  addEventListener('mouseup', (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    const sr = d.slide.getBoundingClientRect();
    if (d.mode !== 'area') {
      const k = G.W / sr.width;
      const g = G.gridStr(G.dragGrid(d.g0, (e.clientX - d.x0) * k, (e.clientY - d.y0) * k, d.mode));
      if (g !== G.gridStr(d.g0)) {
        commit({ op: 'setGrid', target: d.el.id, args: { grid: g }, label: `${d.mode === 'move' ? '移动' : '调整大小'} ${d.el.id}` });
      } else if (d.mode === 'move') { // a click inside the selected block selects the innermost block under it
        select(d.target.closest('.block') || d.el);
      }
      return tb.reposition();
    }
    let r = G.clientToSlide(sr, d.x0, d.y0, e.clientX, e.clientY);
    if (r.w < 6 && r.h < 6) { // a click selects the innermost block under the pointer
      d.box.remove();
      const b = document.elementFromPoint(e.clientX, e.clientY)?.closest('.block');
      return select(b && d.slide.contains(b) ? b : null);
    }
    select(null);
    openPop(d.slide, r, d.box, `第 ${slides().indexOf(d.slide) + 1} 页 · 网格 ${G.rectToCells(r)}`, (text) => submitIntent(d.slide, r, text));
  });
```

5e. `submitIntent` 签名与最后一行：
```js
  async function submitIntent(slide, r, text) {
```
改为
```js
  async function submitIntent(slide, r, text, blocks = G.hitBlocks(slide, r)) {
```
并把末尾的 `cells: G.rectToCells(r), blocks: G.hitBlocks(slide, r), text, shot });` 改为 `cells: G.rectToCells(r), blocks, text, shot });`

5f. 在 `async function submitIntent` 之前加：
```js
  function askSelected() {
    if (!selected) return;
    const slide = selected.closest('section.slide'), r = G.elementRect(slide.getBoundingClientRect(), selected);
    const ids = [];
    for (let n = selected; n && n !== slide; n = n.parentElement) if (n.classList.contains('block') && n.id) ids.push(n.id);
    openPop(slide, r, el('div', 'ppt-abs ppt-sel', ui), `第 ${slides().indexOf(slide) + 1} 页 · ${selected.id}`, (text) => submitIntent(slide, r, text, ids));
  }
  function addText() {
    const s = currentSlide(), id = O.newId(document, 'b-');
    commit({ op: 'insertBlock', args: { id, slideId: s.id, grid: '4/6/6/12', html: '<p style="font-size:24px;margin:0">双击输入文字</p>' }, label: `插入文字块 ${id}` });
    select(document.getElementById(id));
  }
  function addSlide() {
    const s = currentSlide(), id = O.newId(document, 's-');
    commit({ op: 'insertSlide', args: { id, afterId: s.id }, label: `插入页 ${id}` });
    document.getElementById(id)?.scrollIntoView({ block: 'center' });
  }
  function removeSlide() {
    const s = currentSlide();
    select(null);
    commit({ op: 'removeSlide', target: s.id, label: `删除页 ${s.id}` });
  }
  async function undoRedo(kind) {
    if (editing) endEdit();
    await lastSave; await persist(); // never undo past edits that are still being saved
    if (ls.get('ppt-ops', []).length) return toast('还有修改没保存成功，暂时不能撤销');
    try {
      const r = await fetch(api(`/api/${kind}`), { method: 'POST' });
      if (r.ok) reload();
    } catch { offline = true; render(); }
  }
  document.addEventListener('keydown', (e) => {
    if (editing) { if (e.key === 'Escape') editing.block.blur(); return; } // typing and its own undo belong to the browser
    if (e.target.closest?.('#ppt-ui') && /^(TEXTAREA|INPUT|SELECT)$/.test(e.target.tagName)) return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); undoRedo('undo'); }
    else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); undoRedo('redo'); }
    else if (e.key === 'Escape') { closePop(); select(null); }
    else if (selected && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); const id = selected.id; select(null); commit({ op: 'remove', target: id, label: `删除 ${id}` }); }
    else if (selected && e.key === 'Enter') { e.preventDefault(); askSelected(); }
  });
```

5g. 改字模式：失焦时如果焦点进入工具栏，则保持改字模式；同时记录选区。把 dblclick 监听与 endEdit 替换为：
```js
  document.addEventListener('dblclick', (e) => {
    const b = e.target.closest('section.slide .block');
    if (!b || editing || b.querySelector('.block') || !b.id) return;
    closePop();
    editing = { block: b, before: b.innerHTML };
    b.contentEditable = 'true';
    b.focus();
    b.addEventListener('blur', onEditBlur);
    select(b);
  });
  function onEditBlur(e) {
    if (e.relatedTarget?.closest?.('#ppt-ui')) return; // a toolbar control took focus: stay in edit mode
    endEdit();
  }
  document.addEventListener('selectionchange', () => {
    const s = getSelection();
    if (editing && s.rangeCount && editing.block.contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange();
  });
  async function endEdit() {
    if (!editing) return;
    const { block, before } = editing;
    block.removeEventListener('blur', onEditBlur);
    block.removeAttribute('contenteditable');
    editing = null; savedRange = null;
    select(selected);
    if (block.innerHTML !== before) await commit({ op: 'setHTML', target: block.id, args: { html: block.innerHTML }, label: `改字 ${block.id}` });
  }
```

- [ ] **Step 6: 运行，确认通过**

Run: `python ppt/test_server.py && node tests/e2e.mjs`
Expected: 32 OK；e2e 全部通过（35 + 14 = `49/49 passed`）

- [ ] **Step 7: Commit**

```bash
git add ppt/toolbar.js ppt/editor.js ppt/editor.css tests/e2e.mjs
git commit -m "feat: selection, top bar, grid move/resize, keyboard and undo/redo in the page"
```

---

### Task 6: 文字格式、块样式、取色、问 Claude

**Files:**
- Modify: `ppt/editor.js`（替换 Task 5 的五个占位函数）
- Test: `tests/e2e.mjs`

**Interfaces:**
- Consumes: `tb`、`selected`、`editing`、`savedRange`、`commit`、`rememberColor`（Task 5）；`setStyle{deep}`（Task 3）
- Produces: 浮动栏全部按钮可用

- [ ] **Step 1: 写失败的 e2e 检查（追加在 Task 5 检查之后、标记之前）**

```js
  // ---- 2a: formatting and block style ----
  await open(url); await sleep(2000); // let the load-time lint pass finish before taking the baseline
  const lintBefore = inbox().filter((e) => e.type === 'lint').length;
  const fx = await rectOf('#b-p2-title'); await click(fx.x, fx.y); await sleep(300);
  let b2 = await byTitle('背景色'); await click(b2.x, b2.y); await sleep(200);
  b2 = await byTitle('#ef4444'); await click(b2.x, b2.y); await sleep(2000);
  check('F background colour', /id="b-p2-title" style="[^"]*background: rgb\(239, 68, 68\)/.test(deckHtml()));
  await ev(`(() => { const s = [...document.querySelectorAll('.ppt-bar select')].find((n) => n.title === '字号'); s.value = '40'; s.dispatchEvent(new Event('change')); })()`); await sleep(2000);
  check('F size select deep', /id="b-p2-title" style="[^"]*font-size: 40px/.test(deckHtml()) && !/id="b-p2-title"[^>]*><h1 style="[^"]*font-size/.test(deckHtml()));
  b2 = await byTitle('加粗'); await click(b2.x, b2.y); await sleep(2000);
  check('F bold whole block', /id="b-p2-title" style="[^"]*font-weight: 700/.test(deckHtml()));
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
  check('F recent colours remembered', ((await ev(`localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('ppt-recent-colors')))`)) || '').includes('#2563eb'));
  // ask Claude about the selection
  const fa = await rectOf('#b-p2-title'); await click(fa.x, fa.y); await sleep(300);
  b2 = await byTitle('问 Claude'); await click(b2.x, b2.y); await sleep(300);
  await type('标题改短一点'); await enter(); await sleep(2500);
  const ask = inbox().at(-1);
  check('F ask Claude sends selection', ask?.type === 'intent' && ask.blocks?.[0] === 'b-p2-title' && !!ask.shot, JSON.stringify({ ...ask, shot: !!ask?.shot }));
  check('F user styling raises no lint for Claude', inbox().filter((e) => e.type === 'lint').length === lintBefore);
```

- [ ] **Step 2: 运行，确认失败**

Run: `node tests/e2e.mjs`
Expected: `F …` 检查失败（`F background colour` 等为 FAIL），其余通过

- [ ] **Step 3: 实现，替换 Task 5 中的占位行**

```js
  function textStyle() {} function blockStyle() {} function toggle() {} function border() {} function toggleShadow() {}
```
替换为：
```js
  function restoreRange() { // put the edit-mode selection back after a toolbar control took focus
    if (!editing) return false;
    editing.block.focus();
    const s = getSelection();
    s.removeAllRanges();
    if (savedRange) s.addRange(savedRange);
    return !!savedRange && !savedRange.collapsed;
  }
  function wrapSelection(style) { // edit mode: style just the selected characters
    const r = savedRange, span = document.createElement('span');
    for (const [k, v] of Object.entries(style)) if (v != null) span.style.setProperty(k, v);
    span.appendChild(r.extractContents());
    r.insertNode(span);
    const nr = document.createRange(); nr.selectNodeContents(span);
    const s = getSelection(); s.removeAllRanges(); s.addRange(nr); savedRange = nr;
  }
  const styleLabel = (style) => Object.entries(style).map(([k, v]) => `${k}=${v ?? '无'}`).join(' ');
  function textStyle(style) {
    rememberColor(style.color);
    if (editing && restoreRange()) return wrapSelection(style);
    if (!selected) return;
    commit({ op: 'setStyle', target: selected.id, args: { style, deep: true }, label: `文字 ${styleLabel(style)} ${selected.id}` });
    tb.reposition();
  }
  function blockStyle(style) {
    if (!selected) return;
    rememberColor(style.background);
    commit({ op: 'setStyle', target: selected.id, args: { style }, label: `样式 ${styleLabel(style)} ${selected.id}` });
    tb.reposition();
  }
  const TOGGLES = { bold: ['font-weight', '700'], italic: ['font-style', 'italic'], underline: ['text-decoration', 'underline'] };
  function toggle(cmd) {
    if (editing && restoreRange()) { document.execCommand('styleWithCSS', false, false); document.execCommand(cmd); return; }
    if (!selected) return;
    const [prop, on] = TOGGLES[cmd];
    textStyle({ [prop]: selected.style.getPropertyValue(prop) === on ? null : on });
  }
  function border({ color, width }) {
    if (!selected) return;
    const w = width ?? (parseFloat(selected.style.borderWidth) || 1);
    const c = color === undefined ? (selected.style.borderColor || '#6b7280') : color;
    rememberColor(color);
    blockStyle({ border: w && c ? `${w}px solid ${c}` : null });
  }
  function toggleShadow() {
    if (selected) blockStyle({ 'box-shadow': selected.style.boxShadow ? null : '0 4px 16px rgba(0,0,0,.15)' });
  }
```

- [ ] **Step 4: 运行，确认通过**

Run: `python ppt/test_server.py && node tests/e2e.mjs`
Expected: 32 OK；e2e 全部通过（49 + 10 = `59/59 passed`）

- [ ] **Step 5: Commit**

```bash
git add ppt/editor.js tests/e2e.mjs
git commit -m "feat: text formatting, block styles, colour picker and ask-Claude on selection"
```

---

### Task 7: `ppt.md` 规则 + spec 同步 + 端到端验收

**Files:**
- Modify: `.claude/commands/ppt.md`、`docs/superpowers/specs/2026-10-14-ppt-maker-basic-editing-design.md`

- [ ] **Step 1: `ppt.md` 更新**

"处理事件"中的 **edit** 一条：
```markdown
- **edit**：用户直接改了某块。无需动作、无需回执；下次改文件前重新读。
```
替换为：
```markdown
- **edit**：用户在页面上直接改了内容（`label` 说明改了什么，如"移动 b-left""样式 background=#ef4444 b-title"）。无需动作、无需回执；下次改文件前重新读。
- **edit 且 `op` 为 `undo` / `redo`**：用户撤销或重做了一步（`label` 如"撤销了 Claude 处理 #e17"）。**被撤销的是你的修改时，不要自动改回去**；同一意图再次出现时换一种做法，必要时先问用户。
```

"deck.html 格式规则"中第 4 条：
```markdown
4. 颜色字体只用 `#theme` 里的 CSS 变量；整体风格只改 `#theme`；单块主题在该块 style 里覆盖变量。不改 `#base`。
```
替换为：
```markdown
4. 你自己生成内容时，颜色和字体优先用 `#theme` 里的 CSS 变量；整体换风格只改 `#theme`。用户在页面上选的颜色是固定色值（如 `#ef4444`），保留它们，不要改成变量。不改 `#base`。
```
并在第 7 条之后追加：
```markdown
8. 块的 `style` 只写这些属性：`grid-area, background, border, border-radius, box-shadow, text-align, color, font-size, font-weight, font-style, text-decoration, opacity`；块内文字格式只用 `<b> <i> <u>` 和 `<span style="color:…">` / `<span style="font-size:…px">`，不用 `<font>`。
9. 不要创建或修改 `.ppt/history/`，撤销由页面完成。
```

- [ ] **Step 2: spec 同步**

在 spec §3.2 中把允许属性列表改为与 Global Constraints 中的白名单一致（加入 `font-weight, font-style, text-decoration`），并在 §4.4 末尾加一句："实现中扩展为：用户的任何直接操作保存成功后，都把当时的 lint 问题记为已见。"在 §5.1 中删去"快照编号持续递增，不复用"（丢弃重做分支后会复用编号，不影响任何功能）。

- [ ] **Step 3: 全部自动测试**

Run:
```bash
python ppt/test_server.py
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --disable-gpu --window-size=1400,1700 --user-data-dir="$TEMP/ppt-edge" --dump-dom "file:///$(pwd -W)/ppt/selftest.html" 2>/dev/null | grep -o "PASS 35/35"
node tests/e2e.mjs
```
Expected: 32 OK；`PASS 35/35`；`59/59 passed`

- [ ] **Step 4: 端到端验收（真实会话）**

在 `decks/试用` 上（或新建 `/ppt 验收2a`）由 Claude 按 `ppt.md` 执行，逐项确认：
1. 单击选中一块 → 改背景色 → 页面立刻变色；Claude 收到一条带 label 的 `edit` 事件，不回执、不动作。
2. 拖动、拉伸一块 → 吸附网格；`deck.html` 中的 `grid-area` 正确。
3. 选中块 →「💬 问 Claude」→ "加一个小标题" → Claude 修改 → 页面刷新。
4. 按 ↶ → Claude 的修改被撤销；Claude 收到 `op: undo` 事件且不改回去；按 ↷ 恢复。
5. `+页`、`+文字`、`Delete`、`−页` 都生效，并且都能撤销。
6. 改字模式下选几个字改颜色和字号 → 只有这几个字变化。

- [ ] **Step 5: Commit 并推送**

```bash
git add .claude/commands/ppt.md docs/superpowers/specs/2026-10-14-ppt-maker-basic-editing-design.md
git commit -m "docs: ppt.md rules for direct edits and undo; sync spec"
git push
```
