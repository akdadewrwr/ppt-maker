# ppt-maker 核心闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/ppt <名字>` 打开本地幻灯片页面；用户框选/写意图/直接改字，事件实时回传 Claude Code 会话，Claude 改 deck.html，页面自动刷新并显示回执。

**Architecture:** 一个零依赖 Python 服务（`ppt/server.py`）负责发页面、收事件、存文件；三种运行方式：serve / `--tail`（被 Claude Code Monitor 运行，打印事件唤醒会话）/ `--reply`（写回执）。浏览器端 `geom.js`（纯计算）+ `editor.js`（交互），由服务在发页面时注入，不写进 deck.html。所有生成能力由 Claude 按 `.claude/commands/ppt.md` 的规则完成。

**Tech Stack:** Python ≥3.9 标准库（http.server、unittest）；原生 JS/CSS（无构建）；html-to-image@1.11.11（单文件入库，用于选区截图）。

**Spec:** `docs/superpowers/specs/2026-10-14-ppt-maker-core-loop-design.md`

## Global Constraints

- Python ≥3.9，只用标准库；不新增任何运行时依赖。前端无构建步骤、不走网络（截图库放 `ppt/vendor/`）。
- 服务只监听 `127.0.0.1`；`/`、`/api/*` 必须带口令 `?t=`；所有请求校验 `Host` ∈ {`127.0.0.1:<端口>`, `localhost:<端口>`}。
- 文件访问限制在 deck 目录与 `ppt/` 内；deck 目录下的 `.ppt/` 不对外提供。
- 截图上限 5MB（仅 PNG）；事件文字上限 4000 字；请求体上限 10MB。
- 画布 1280×720，网格 16 列 × 9 行（每格 80px）；`cells` 格式 `"c1-c2/r1-r2"`，从 1 开始，包含两端。
- 事件类型：`intent` / `answer` / `lint`（需要回执）、`edit`（仅通知）。事件 id 为 `e<序号>`，服务分配。
- 版本号 = `"<mtime_ns>-<size>"`。心跳每 10 秒写一次，超过 30 秒视为离线。
- 编辑层注入的所有节点带 `data-ppt` 属性；保存 deck 时必须全部剔除。
- 所有文本文件 UTF-8 读写；Windows 上命令行输出也必须是 UTF-8。

## Review Focus

1. **中文内容**：意图文字、deck 内容、`--tail` 输出全是中文；Windows 默认 GBK 控制台不能乱码或报错 → Task 2、Task 3 各加中文往返测试。
2. **Claude 写出的 deck 不规范**：没有 `</body>`、或大写 `</BODY>` → 编辑层仍要注入 → Task 1 测试。
3. **窗口窄于 1280px**：幻灯片被缩放后，框选坐标仍须换算回 1280×720 → Task 4 selftest 用半尺寸 slide 矩形断言。
4. **框在空白处**（不命中任何块）：事件仍要带 `cells`、`blocks: []` 被接受 → Task 2 测试。
5. **用户正在改字时 Claude 改了文件**：不能丢用户正在输入的字 → Task 5 推迟刷新 + 409 重放，Task 6 端到端清单专门制造一次。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `.gitignore` | 忽略 `decks/*/.ppt/`、`__pycache__/` |
| `ppt/template.html` | 新 deck 的起始文件，含 `#theme` / `#base` 样式与一页示例 |
| `ppt/server.py` | 服务 + `--tail` + `--reply` |
| `ppt/test_server.py` | 服务端 unittest |
| `ppt/geom.js` | 纯计算：坐标换算、网格、命中块、lint（`window.PPTGeom`） |
| `ppt/selftest.html` | geom.js 浏览器自检 |
| `ppt/editor.js` / `ppt/editor.css` | 编辑层：缩放、轮询、框选意图、截图、离线队列、标记与气泡、改字保存、lint 上报 |
| `ppt/vendor/html-to-image.js` + `LICENSE-html-to-image` | 截图库 |
| `.claude/commands/ppt.md` | `/ppt` 操作手册 |

---

### Task 1: 模板 + 服务骨架（发页面、安全校验、端口顺延）

**Files:**
- Create: `.gitignore`, `ppt/template.html`, `ppt/server.py`, `ppt/test_server.py`

**Interfaces:**
- Produces:
  - `make_server(deck: Path|str, port: int = 8765, token: str|None = None) -> Server`（`srv.deck: Path`、`srv.token: str`、`srv.server_address[1]` 为实际端口）
  - `runtime(deck: Path) -> Path`（返回并创建 `deck/.ppt/` 与 `shots/`）
  - `deck_version(deck: Path) -> str`
  - `read_jsonl(path) -> list[dict]`、`append_jsonl(path, obj)`、`now_iso() -> str`
  - `HERE: Path`（`ppt/` 目录）、`LOCK: threading.Lock`
  - 测试辅助 `ServerCase`（`self.deck`、`self.req(method, path, body=None, host=None) -> (status, bytes)`）

- [ ] **Step 1: 写 `.gitignore` 和 `ppt/template.html`**

`.gitignore`:
```
decks/*/.ppt/
__pycache__/
```

`ppt/template.html`:
```html
<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>标题</title>
<style id="theme">
  :root { --bg:#ffffff; --fg:#1a1a1a; --muted:#6b7280; --accent:#2563eb; --font:"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif; }
</style>
<style id="base">
  body { margin:0; background:#e5e7eb; }
  .slide { width:1280px; height:720px; margin:24px auto; display:grid;
           grid-template-columns:repeat(16,minmax(0,1fr)); grid-template-rows:repeat(9,minmax(0,1fr));
           background:var(--bg); color:var(--fg); font-family:var(--font); box-shadow:0 2px 12px rgba(0,0,0,.12); position:relative; }
  .block { box-sizing:border-box; padding:8px; min-width:0; min-height:0; }
  .block.grid { display:grid; gap:8px; }
  @media print { body { background:none; } .slide { margin:0; box-shadow:none; break-after:page; } }
</style>
</head><body>
<section class="slide" id="s-cover">
  <div class="block" id="b-cover-title" style="grid-area:4/2/6/16"><h1 style="font-size:56px;margin:0;color:var(--accent)">标题</h1></div>
  <div class="block" id="b-cover-sub" style="grid-area:6/2/7/16"><p style="font-size:24px;margin:0;color:var(--muted)">副标题</p></div>
</section>
</body></html>
```

- [ ] **Step 2: 写失败测试 `ppt/test_server.py`**

```python
import http.client, json, shutil, socket, sys, tempfile, threading, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server

TEMPLATE = Path(__file__).resolve().parent / "template.html"


class ServerCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.deck = self.tmp / "deck"
        self.deck.mkdir()
        shutil.copy(TEMPLATE, self.deck / "deck.html")
        self.srv = server.make_server(self.deck, port=0, token="tok")
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def req(self, method, path, body=None, host=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        c.request(method, path, data, {"Host": host or f"127.0.0.1:{self.port}", "Content-Type": "application/json"})
        r = c.getresponse()
        out = (r.status, r.read())
        c.close()
        return out


class PageTests(ServerCase):
    def test_index_requires_token(self):
        self.assertEqual(self.req("GET", "/")[0], 403)
        self.assertEqual(self.req("GET", "/?t=bad")[0], 403)
        status, body = self.req("GET", "/?t=tok")
        self.assertEqual(status, 200)
        html = body.decode()
        self.assertIn("window.PPT=", html)
        self.assertIn("/_ppt/editor.js", html)
        self.assertLess(html.index("/_ppt/editor.js"), html.lower().rindex("</body>"))

    def test_inject_without_body_tag(self):
        (self.deck / "deck.html").write_text("<html><SECTION class=slide id=s1></SECTION>", encoding="utf-8")
        self.assertIn("/_ppt/editor.js", self.req("GET", "/?t=tok")[1].decode())
        (self.deck / "deck.html").write_text("<html><body>x</BODY></html>", encoding="utf-8")
        html = self.req("GET", "/?t=tok")[1].decode()
        self.assertLess(html.index("/_ppt/editor.js"), html.index("</BODY>"))

    def test_bad_host_rejected(self):
        self.assertEqual(self.req("GET", "/?t=tok", host=f"evil.com:{self.port}")[0], 403)
        self.assertEqual(self.req("GET", "/_ppt/server.py", host="evil.com")[0], 403)
        self.assertEqual(self.req("GET", "/?t=tok", host=f"localhost:{self.port}")[0], 200)

    def test_static_files_and_traversal(self):
        self.assertEqual(self.req("GET", "/_ppt/template.html")[0], 200)
        (self.deck / "assets").mkdir()
        (self.deck / "assets" / "a.png").write_bytes(b"\x89PNG")
        self.assertEqual(self.req("GET", "/assets/a.png")[0], 200)
        server.runtime(self.deck)
        (self.deck / ".ppt" / "inbox.jsonl").write_text("{}\n", encoding="utf-8")
        for bad in ("/.ppt/inbox.jsonl", "/_ppt/../../secret", "/%2e%2e/%2e%2e/x", "/_ppt/..%2f..%2fx", "/nope.png"):
            self.assertEqual(self.req("GET", bad)[0], 404, bad)

    def test_port_fallback(self):
        busy = socket.socket()
        busy.bind(("127.0.0.1", 0))
        busy.listen()
        try:
            srv = server.make_server(self.deck, port=busy.getsockname()[1])
            self.assertNotEqual(srv.server_address[1], busy.getsockname()[1])
            srv.server_close()
        finally:
            busy.close()


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3: 运行，确认失败**

Run: `python ppt/test_server.py`
Expected: `ModuleNotFoundError: No module named 'server'`

- [ ] **Step 4: 写 `ppt/server.py`（本任务部分）**

```python
#!/usr/bin/env python3
"""ppt-maker local server (stdlib only).

  python ppt/server.py <deck_dir> [--port 8765] [--no-open]    serve deck + editor layer
  python ppt/server.py --tail <deck_dir>                        print pending/new events, one line each
  python ppt/server.py --reply <deck_dir> <event_id> [text] [--ack]
"""
import argparse, base64, json, mimetypes, secrets, sys, threading, time, webbrowser
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

HERE = Path(__file__).resolve().parent
MAX_BODY = 10 * 1024 * 1024
MAX_SHOT = 5 * 1024 * 1024
MAX_TEXT = 4000
EVENT_TYPES = {"intent", "answer", "lint"}  # need a reply; "edit" is notify-only
HEARTBEAT_SECS = 10
ONLINE_SECS = 30
LOCK = threading.Lock()
INJECT = ('<link rel="stylesheet" href="/_ppt/editor.css" data-ppt>'
          '<script data-ppt>window.PPT={token:%s,version:%s}</script>'
          '<script src="/_ppt/vendor/html-to-image.js" data-ppt></script>'
          '<script src="/_ppt/geom.js" data-ppt></script>'
          '<script src="/_ppt/editor.js" data-ppt></script>')


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def runtime(deck):
    d = Path(deck) / ".ppt"
    (d / "shots").mkdir(parents=True, exist_ok=True)
    return d


def deck_version(deck):
    st = (Path(deck) / "deck.html").stat()
    return f"{st.st_mtime_ns}-{st.st_size}"


def read_jsonl(path):
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            out.append(json.loads(line))
        except ValueError:
            pass  # ponytail: a torn/corrupt line is skipped, not fatal
    return out


def append_jsonl(path, obj):
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")


def safe_path(root, rel):
    """File under root, or None. Blocks ../ and absolute escapes."""
    root = root.resolve()
    p = (root / unquote(rel).lstrip("/\\")).resolve()
    return p if p.is_relative_to(root) and p.is_file() else None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, code, body=b"", ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def guard(self, need_token):
        """Host check always (DNS rebinding); token for pages/APIs. Returns parsed URL or None."""
        port = self.server.server_address[1]
        if self.headers.get("Host") not in (f"127.0.0.1:{port}", f"localhost:{port}"):
            self.send(403, {"error": "bad host"})
            return None
        url = urlparse(self.path)
        t = parse_qs(url.query).get("t", [""])[0]
        if need_token and not secrets.compare_digest(t.encode(), self.server.token.encode()):
            self.send(403, {"error": "bad token"})
            return None
        return url

    def do_GET(self):
        path = urlparse(self.path).path
        url = self.guard(need_token=path == "/" or path.startswith("/api/"))
        if not url:
            return
        deck = self.server.deck
        if path == "/":
            ver = deck_version(deck)  # read version first: a racing write only causes one extra reload
            html = (deck / "deck.html").read_text(encoding="utf-8")
            inj = INJECT % (json.dumps(self.server.token), json.dumps(ver))
            i = html.lower().rfind("</body>")
            html = html[:i] + inj + html[i:] if i >= 0 else html + inj
            return self.send(200, html, "text/html; charset=utf-8")
        if path.startswith("/_ppt/"):
            root, f = HERE, safe_path(HERE, path[len("/_ppt/"):])
        else:
            root, f = deck, safe_path(deck, path)
        if not f or (root == deck and ".ppt" in f.relative_to(deck.resolve()).parts):
            return self.send(404, {"error": "not found"})
        self.send(200, f.read_bytes(), mimetypes.guess_type(f.name)[0] or "application/octet-stream")


class Server(ThreadingHTTPServer):
    allow_reuse_address = False  # ponytail: on Windows reuse lets two servers share one port
    daemon_threads = True


def make_server(deck, port=8765, token=None, tries=20):
    for p in range(port, port + tries):
        try:
            srv = Server(("127.0.0.1", p), Handler)
            break
        except OSError:
            continue
    else:
        raise SystemExit(f"no free port in {port}-{port + tries - 1}")
    srv.deck = Path(deck).resolve()
    srv.token = token or secrets.token_urlsafe(16)
    return srv


def main(argv=None):
    ap = argparse.ArgumentParser(description="ppt-maker local server")
    ap.add_argument("deck")
    ap.add_argument("rest", nargs="*", help="--reply: <event_id> [text]")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-open", action="store_true")
    a = ap.parse_args(argv)
    deck = Path(a.deck).resolve()
    if not (deck / "deck.html").is_file():
        ap.error(f"{deck / 'deck.html'} not found")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    srv = make_server(deck, a.port)
    url = f"http://127.0.0.1:{srv.server_address[1]}/?t={srv.token}"
    print(f"ppt-maker serving {deck.name} at {url}", flush=True)
    if not a.no_open:
        webbrowser.open(url)
    srv.serve_forever()


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: 运行，确认通过**

Run: `python ppt/test_server.py -v`
Expected: 5 tests OK

- [ ] **Step 6: 手动冒烟**

Run:
```bash
mkdir -p decks/smoke && cp ppt/template.html decks/smoke/deck.html
python ppt/server.py decks/smoke --no-open   # 后台运行
```
Expected: 打印 `ppt-maker serving smoke at http://127.0.0.1:8765/?t=...`；浏览器打开该 URL 能看到"标题"页（控制台会报 editor.js 等 404，属预期）。停止服务，删除 `decks/smoke`。

- [ ] **Step 7: Commit**

```bash
git add .gitignore ppt/template.html ppt/server.py ppt/test_server.py
git commit -m "feat: server skeleton serving deck with injected editor layer"
```

---

### Task 2: 事件与保存 API（POST /api/event、PUT /api/deck、GET /api/state）

**Files:**
- Modify: `ppt/server.py`（在 `safe_path` 之后加函数；`Handler` 加 `read_json`、`do_POST`、`do_PUT`，`do_GET` 加 `/api/state` 分支）
- Test: `ppt/test_server.py`

**Interfaces:**
- Consumes: Task 1 全部
- Produces:
  - `clean_event(body) -> (dict, bytes|None)`，非法时抛 `ValueError`
  - `add_event(deck, ev: dict, shot: bytes|None = None) -> dict`（分配 `id`/`ts`，调用方持 `LOCK`）
  - `statuses(deck) -> dict[str, "processing"|"done"]`
  - `state(deck) -> {"version": str, "online": bool, "events": [{"id","type","re","slide_id","rect","text","status","reply"}]}`（只含 intent 与 answer）
  - HTTP：`POST /api/event?t=` → `{"id"}`；`PUT /api/deck?t=` body `{"version","html","block","slide_id"}` → 200 `{"version"}` / 409 `{"version"}`；`GET /api/state?t=`

- [ ] **Step 1: 写失败测试（追加到 `ppt/test_server.py`，放在 `if __name__` 之前）**

```python
PNG = "data:image/png;base64," + __import__("base64").b64encode(b"\x89PNG\r\n\x1a\nfake").decode()


def inbox(deck):
    return server.read_jsonl(deck / ".ppt" / "inbox.jsonl")


class EventTests(ServerCase):
    def test_post_intent_with_shot(self):
        ev = {"type": "intent", "slide": 1, "slide_id": "s-cover", "rect": {"x": 0, "y": 0, "w": 80, "h": 80},
              "cells": "1-1/1-1", "blocks": ["b-cover-title"], "text": "标题改成蓝色渐变", "shot": PNG, "id": "hack"}
        status, body = self.req("POST", "/api/event?t=tok", ev)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["id"], "e1")
        [stored] = inbox(self.deck)
        self.assertEqual(stored["id"], "e1")                      # client id ignored
        self.assertEqual(stored["text"], "标题改成蓝色渐变")         # Chinese round-trip
        self.assertEqual(stored["shot"], ".ppt/shots/e1.png")
        self.assertTrue((self.deck / ".ppt" / "shots" / "e1.png").read_bytes().startswith(b"\x89PNG"))
        self.assertEqual(json.loads(self.req("POST", "/api/event?t=tok", {"type": "answer", "re": "e1", "text": "好"})[1])["id"], "e2")

    def test_blank_area_selection_accepted(self):
        status, _ = self.req("POST", "/api/event?t=tok", {"type": "intent", "slide_id": "s-cover", "cells": "1-2/8-9", "blocks": [], "text": "这里加脚注"})
        self.assertEqual(status, 200)

    def test_post_requires_token(self):
        self.assertEqual(self.req("POST", "/api/event", {"type": "intent", "text": "x"})[0], 403)
        self.assertEqual(self.req("POST", "/api/event?t=no", {"type": "intent", "text": "x"})[0], 403)
        self.assertEqual(inbox(self.deck), [])

    def test_post_rejects_bad_input(self):
        for bad in ({"type": "edit"}, {"type": "nope"}, [], {"type": "intent", "text": "字" * 4001},
                    {"type": "intent", "shot": "data:image/png;base64,R0lGODlh"}, {"type": "intent", "shot": "data:,!!!"}):
            self.assertEqual(self.req("POST", "/api/event?t=tok", bad)[0], 400, bad)
        self.assertEqual(inbox(self.deck), [])

    def test_put_deck_version_check(self):
        ver = json.loads(self.req("GET", "/api/state?t=tok")[1])["version"]
        html = (self.deck / "deck.html").read_text(encoding="utf-8").replace("副标题", "组会·第三周")
        status, body = self.req("PUT", "/api/deck?t=tok", {"version": ver, "html": html, "block": "b-cover-sub", "slide_id": "s-cover"})
        self.assertEqual(status, 200)
        new = json.loads(body)["version"]
        self.assertNotEqual(new, ver)
        self.assertIn("组会·第三周", (self.deck / "deck.html").read_text(encoding="utf-8"))
        self.assertEqual(inbox(self.deck)[-1]["type"], "edit")
        self.assertEqual(inbox(self.deck)[-1]["block"], "b-cover-sub")
        status, body = self.req("PUT", "/api/deck?t=tok", {"version": ver, "html": html})   # stale
        self.assertEqual(status, 409)
        self.assertEqual(json.loads(body)["version"], new)
        self.assertEqual(self.req("PUT", "/api/deck?t=tok", {"version": new, "html": "not html"})[0], 400)
        self.assertEqual(self.req("PUT", "/api/deck", {"version": new, "html": html})[0], 403)

    def test_state_statuses_and_online(self):
        self.req("POST", "/api/event?t=tok", {"type": "intent", "slide_id": "s-cover", "text": "a"})
        self.req("POST", "/api/event?t=tok", {"type": "intent", "slide_id": "s-cover", "text": "b"})
        self.req("POST", "/api/event?t=tok", {"type": "lint", "issues": []})
        out = server.runtime(self.deck) / "outbox.jsonl"
        server.append_jsonl(out, {"re": "e1", "text": "", "ack": True})
        server.append_jsonl(out, {"re": "e2", "text": "", "ack": True})
        server.append_jsonl(out, {"re": "e2", "text": "已改", "ack": False})
        s = json.loads(self.req("GET", "/api/state?t=tok")[1])
        self.assertFalse(s["online"])
        self.assertEqual([(e["id"], e["status"], e["reply"]) for e in s["events"]],
                         [("e1", "processing", None), ("e2", "done", "已改")])   # lint not listed
        (self.deck / ".ppt" / "heartbeat").write_text("x")
        self.assertTrue(json.loads(self.req("GET", "/api/state?t=tok")[1])["online"])
```

- [ ] **Step 2: 运行，确认失败**

Run: `python ppt/test_server.py -v`
Expected: EventTests 失败（404 / KeyError 'version'）；PageTests 仍通过

- [ ] **Step 3: 实现 — 在 `server.py` 的 `safe_path` 之后加入**

```python
def clean_event(body):
    """Whitelist fields from a page-posted event; returns (event, png_bytes|None)."""
    if not isinstance(body, dict) or body.get("type") not in EVENT_TYPES:
        raise ValueError("bad type")
    ev = {k: body[k] for k in ("type", "re", "slide", "slide_id", "rect", "cells", "blocks", "text", "issues") if k in body}
    if len(str(ev.get("text", ""))) > MAX_TEXT:
        raise ValueError("text too long")
    shot = None
    if body.get("shot"):
        b64 = str(body["shot"]).split(",", 1)[-1]
        if len(b64) > MAX_SHOT * 4 // 3 + 4:
            raise ValueError("shot too large")
        shot = base64.b64decode(b64, validate=True)  # binascii.Error is a ValueError
        if not shot.startswith(b"\x89PNG"):
            raise ValueError("shot must be png")
    return ev, shot


def add_event(deck, ev, shot=None):
    """Assign id/ts and append to inbox. Caller holds LOCK."""
    rt = runtime(deck)
    inbox = rt / "inbox.jsonl"
    n = len(inbox.read_text(encoding="utf-8").splitlines()) if inbox.exists() else 0  # raw lines: ids never reused
    eid = f"e{n + 1}"
    if shot:
        (rt / "shots" / f"{eid}.png").write_bytes(shot)
        ev = {**ev, "shot": f".ppt/shots/{eid}.png"}
    ev = {"id": eid, "ts": now_iso(), **ev}
    append_jsonl(inbox, ev)
    return ev


def statuses(deck):
    """event id -> 'processing' (acked) | 'done' (replied); absent = queued."""
    st = {}
    for r in read_jsonl(runtime(deck) / "outbox.jsonl"):
        if r.get("ack"):
            st.setdefault(r.get("re"), "processing")
        else:
            st[r.get("re")] = "done"
    return st


def state(deck):
    rt = runtime(deck)
    st = statuses(deck)
    replies = {r.get("re"): r.get("text", "") for r in read_jsonl(rt / "outbox.jsonl") if not r.get("ack")}
    hb = rt / "heartbeat"
    events = [{"id": e["id"], "type": e["type"], "re": e.get("re"), "slide_id": e.get("slide_id"),
               "rect": e.get("rect"), "text": e.get("text", ""),
               "status": st.get(e["id"], "queued"), "reply": replies.get(e["id"])}
              for e in read_jsonl(rt / "inbox.jsonl") if e.get("type") in ("intent", "answer")]
    return {"version": deck_version(deck),
            "online": hb.exists() and time.time() - hb.stat().st_mtime < ONLINE_SECS,
            "events": events}
```

在 `Handler` 里，`do_GET` 中 `if path == "/":` 分支之后加：
```python
        if path == "/api/state":
            return self.send(200, state(deck))
```

在 `Handler` 末尾加：
```python
    def read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ValueError("body too large")
        return json.loads(self.rfile.read(n) or b"null")

    def do_POST(self):
        url = self.guard(need_token=True)
        if not url:
            return
        if url.path != "/api/event":
            return self.send(404, {"error": "not found"})
        try:
            ev, shot = clean_event(self.read_json())
        except ValueError as e:
            return self.send(400, {"error": str(e)})
        with LOCK:
            ev = add_event(self.server.deck, ev, shot)
        self.send(200, {"id": ev["id"]})

    def do_PUT(self):
        url = self.guard(need_token=True)
        if not url:
            return
        if url.path != "/api/deck":
            return self.send(404, {"error": "not found"})
        try:
            body = self.read_json()
            html, ver = body["html"], body["version"]
            if not isinstance(html, str) or "<html" not in html.lower():
                raise ValueError("bad html")
        except (ValueError, KeyError, TypeError) as e:
            return self.send(400, {"error": str(e)})
        deck = self.server.deck
        with LOCK:
            cur = deck_version(deck)
            if ver != cur:
                return self.send(409, {"version": cur})
            (deck / "deck.html").write_bytes(html.encode("utf-8"))
            new = deck_version(deck)
            add_event(deck, {"type": "edit", "slide_id": body.get("slide_id"), "block": body.get("block")})
        self.send(200, {"version": new})
```

- [ ] **Step 4: 运行，确认通过**

Run: `python ppt/test_server.py -v`
Expected: 11 tests OK

- [ ] **Step 5: Commit**

```bash
git add ppt/server.py ppt/test_server.py
git commit -m "feat: event, deck save and state APIs"
```

---

### Task 3: 命令行 `--tail` 与 `--reply`

**Files:**
- Modify: `ppt/server.py`（加 `summary`、`tail`、`reply`；`main` 加两个开关）
- Test: `ppt/test_server.py`

**Interfaces:**
- Consumes: `read_jsonl`、`append_jsonl`、`runtime`、`statuses`、`EVENT_TYPES`、`HEARTBEAT_SECS`
- Produces:
  - `summary(ev) -> str`，格式 `e17 intent slide:s-intro [b-right,b-r1] 文字前60字`；answer 带 ` re:e17`；单行
  - `tail(deck, emit, stop=lambda: False, interval=0.5)`：先 emit 所有未 done 的 intent/answer/lint（含 processing），再跟随新行（含 edit），每 `HEARTBEAT_SECS` 写 `.ppt/heartbeat`
  - `reply(deck, eid, text="", ack=False)`
  - CLI：`server.py --tail <deck>`；`server.py --reply <deck> <id> [text...] [--ack]`

- [ ] **Step 1: 写失败测试（追加）**

```python
import time as _time


class CliTests(ServerCase):
    def test_reply_drives_status(self):
        server.reply(self.deck, "e1", ack=True)
        self.assertEqual(server.statuses(self.deck), {"e1": "processing"})
        server.reply(self.deck, "e1", "做完了")
        server.reply(self.deck, "e1", ack=True)           # late ack must not undo done
        self.assertEqual(server.statuses(self.deck), {"e1": "done"})

    def test_summary_one_line(self):
        s = server.summary({"id": "e3", "type": "answer", "re": "e1", "slide_id": "s1", "blocks": ["a", "b"], "text": "第一行\n第二行" + "长" * 100})
        self.assertTrue(s.startswith("e3 answer re:e1 slide:s1 [a,b] 第一行 第二行"))
        self.assertNotIn("\n", s)
        self.assertIn("[x]", server.summary({"id": "e4", "type": "edit", "slide_id": "s1", "block": "x"}))

    def test_tail_catch_up_then_follow(self):
        for t in ("旧的已完成", "旧的处理中", "旧的排队"):
            self.req("POST", "/api/event?t=tok", {"type": "intent", "slide_id": "s-cover", "text": t})
        server.reply(self.deck, "e1", "ok")
        server.reply(self.deck, "e2", ack=True)
        lines, done = [], threading.Event()
        th = threading.Thread(target=server.tail, args=(self.deck, lines.append, done.is_set, 0.05), daemon=True)
        th.start()
        _time.sleep(0.3)
        self.assertEqual([l.split()[0] for l in lines], ["e2", "e3"])
        self.req("POST", "/api/event?t=tok", {"type": "lint", "issues": [{"block": "b", "kind": "overflow"}]})
        _time.sleep(0.3)
        done.set()
        th.join(2)
        self.assertEqual([l.split()[0] for l in lines], ["e2", "e3", "e4"])
        self.assertTrue((self.deck / ".ppt" / "heartbeat").exists())

    def test_cli_reply(self):
        server.main(["--reply", str(self.deck), "e9", "已", "完成", "--ack"])
        server.main(["--reply", str(self.deck), "e9", "已", "完成"])
        rows = server.read_jsonl(self.deck / ".ppt" / "outbox.jsonl")
        self.assertEqual([(r["re"], r["text"], r["ack"]) for r in rows], [("e9", "已 完成", True), ("e9", "已 完成", False)])
```

- [ ] **Step 2: 运行，确认失败**

Run: `python ppt/test_server.py -v`
Expected: CliTests 报 `AttributeError: module 'server' has no attribute 'reply'`

- [ ] **Step 3: 实现 — 在 `state()` 之后加入**

```python
def summary(e):
    blocks = e.get("blocks") or ([e["block"]] if e.get("block") else [])
    text = e.get("text") or (json.dumps(e["issues"], ensure_ascii=False) if e.get("issues") else "")
    re_ = f" re:{e['re']}" if e.get("re") else ""
    line = f"{e['id']} {e['type']}{re_} slide:{e.get('slide_id') or '-'} [{','.join(blocks)}] {text[:60]}"
    return " ".join(line.split())


def tail(deck, emit, stop=lambda: False, interval=0.5):
    """Emit every unfinished event, then follow the inbox. Heartbeat lets the page show 'Claude online'."""
    rt = runtime(deck)
    inbox, hb = rt / "inbox.jsonl", rt / "heartbeat"
    events, st = read_jsonl(inbox), statuses(deck)
    for e in events:
        if e.get("type") in EVENT_TYPES and st.get(e.get("id")) != "done":
            emit(summary(e))
    seen, beat = len(events), 0.0
    while not stop():
        if time.time() - beat >= HEARTBEAT_SECS:
            hb.write_text(now_iso(), encoding="utf-8")
            beat = time.time()
        events = read_jsonl(inbox)
        for e in events[seen:]:
            emit(summary(e))
        seen = len(events)
        time.sleep(interval)


def reply(deck, eid, text="", ack=False):
    append_jsonl(runtime(deck) / "outbox.jsonl", {"re": eid, "text": text, "ack": ack, "ts": now_iso()})
```

`main` 里：在 `ap.add_argument("--no-open", ...)` 后加
```python
    ap.add_argument("--tail", action="store_true", help="print pending/new events (run under Claude Code Monitor)")
    ap.add_argument("--reply", action="store_true", help="write a reply: <deck> <event_id> [text]")
    ap.add_argument("--ack", action="store_true", help="with --reply: mark the event as being processed")
```
在 `sys.stdout.reconfigure(...)` 之后、`srv = make_server(...)` 之前加
```python
    if a.reply:
        if not a.rest:
            ap.error("--reply needs an event id")
        return reply(deck, a.rest[0], " ".join(a.rest[1:]), a.ack)
    if a.tail:
        return tail(deck, lambda s: print(s, flush=True))
```

- [ ] **Step 4: 运行，确认通过**

Run: `python ppt/test_server.py -v`
Expected: 15 tests OK

- [ ] **Step 5: 中文输出冒烟（Windows 必做）**

```bash
mkdir -p decks/smoke && cp ppt/template.html decks/smoke/deck.html
python -c "import sys;sys.path.insert(0,'ppt');import server;server.add_event(server.Path('decks/smoke'),{'type':'intent','text':'中文意图'})"
timeout 2 python ppt/server.py --tail decks/smoke; rm -rf decks/smoke
```
Expected: 输出 `e1 intent slide:- [] 中文意图`，无乱码、无 UnicodeEncodeError。

- [ ] **Step 6: Commit**

```bash
git add ppt/server.py ppt/test_server.py
git commit -m "feat: --tail and --reply command-line modes"
```

---

### Task 4: `geom.js` 纯计算 + `selftest.html`

**Files:**
- Create: `ppt/geom.js`, `ppt/selftest.html`

**Interfaces:**
- Produces `window.PPTGeom`：
  - `W=1280, H=720, COLS=16, ROWS=9`
  - `clientToSlide(sr, x0, y0, x1, y1) -> {x,y,w,h}`（`sr` 为 slide 的 `getBoundingClientRect()`；结果夹在画布内、取整）
  - `elementRect(sr, el) -> {x,y,w,h}`（画布坐标）
  - `slideToClient(sr, r) -> {left, top, width, height}`（视口坐标）
  - `rectToCells(r) -> "c1-c2/r1-r2"`
  - `hitBlocks(slide, r) -> string[]`（相交且有 id 的 `.block`，最内层在前）
  - `lint(slide) -> [{kind: "missing-id"|"duplicate-id"|"overflow"|"overlap", block, slide_id, px?, other?}]`

- [ ] **Step 1: 写失败自检 `ppt/selftest.html`**

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>geom selftest</title>
<style>
  body { margin:0; font:14px system-ui; }
  .slide { width:1280px; height:720px; display:grid;
           grid-template-columns:repeat(16,minmax(0,1fr)); grid-template-rows:repeat(9,minmax(0,1fr)); }
  .block { box-sizing:border-box; padding:8px; min-width:0; min-height:0; }
  .block.grid { display:grid; gap:8px; }
  .pass { color:#16a34a } .fail { color:#dc2626 }
</style></head><body>
<h1 id="result">running…</h1><ol id="log"></ol>
<section class="slide" id="s1">
  <div class="block" id="a" style="grid-area:1/1/3/17">title</div>
  <div class="block" id="b" style="grid-area:3/1/9/9"><p style="height:2000px">tall</p></div>
  <div class="block grid" id="c" style="grid-area:3/9/9/17;grid-template-columns:1fr 1fr">
    <div class="block" id="c1">x</div><div class="block" id="c2">y</div>
  </div>
  <div class="block" id="d" style="grid-area:8/7/10/11">overlaps b and c</div>
</section>
<script src="geom.js"></script>
<script>
  const G = PPTGeom, log = document.getElementById('log'); let pass = 0, total = 0;
  function check(name, got, want) {
    total++; const ok = JSON.stringify(got) === JSON.stringify(want); if (ok) pass++;
    const li = document.createElement('li'); li.className = ok ? 'pass' : 'fail';
    li.textContent = `${ok ? 'PASS' : 'FAIL'} ${name}: got ${JSON.stringify(got)}${ok ? '' : ' want ' + JSON.stringify(want)}`;
    log.appendChild(li);
  }
  const near = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v / 2) * 2]));
  const slide = document.getElementById('s1'), sr = slide.getBoundingClientRect();

  check('cells full', G.rectToCells({x:0,y:0,w:1280,h:720}), '1-16/1-9');
  check('cells right half', G.rectToCells({x:640,y:160,w:640,h:480}), '9-16/3-8');
  check('cells zero-size on boundary', G.rectToCells({x:80,y:80,w:0,h:0}), '2-2/2-2');
  check('cells straddle', G.rectToCells({x:79,y:0,w:2,h:1}), '1-2/1-1');

  const half = {left:100, top:50, width:640, height:360};   // slide shown at 50% (narrow window)
  check('clientToSlide scaled', G.clientToSlide(half, 100, 50, 420, 230), {x:0,y:0,w:640,h:360});
  check('clientToSlide reversed drag', G.clientToSlide(half, 420, 230, 100, 50), {x:0,y:0,w:640,h:360});
  check('clientToSlide clamps', G.clientToSlide(half, 0, 0, 2000, 2000), {x:0,y:0,w:1280,h:720});
  check('slideToClient scaled', G.slideToClient(half, {x:640,y:360,w:640,h:360}), {left:420,top:230,width:320,height:180});

  check('elementRect c', near(G.elementRect(sr, document.getElementById('c'))), {x:640,y:160,w:640,h:480});
  check('hit inner first', G.hitBlocks(slide, {x:700,y:200,w:10,h:10}), ['c1','c']);
  check('hit blank area', G.hitBlocks(slide, {x:1270,y:710,w:0,h:0}), []);
  check('hit all', G.hitBlocks(slide, {x:0,y:0,w:1280,h:720}).sort(), ['a','b','c','c1','c2','d']);

  const issues = G.lint(slide).map(i => `${i.kind}:${i.block}${i.other ? '/' + i.other : ''}`).sort();
  check('lint', issues, ['overflow:b', 'overlap:d/b', 'overlap:d/c']);
  document.getElementById('d').removeAttribute('id');
  check('lint missing id', G.lint(slide).filter(i => i.kind === 'missing-id').length, 1);

  const r = document.getElementById('result');
  r.textContent = `${pass === total ? 'PASS' : 'FAIL'} ${pass}/${total}`; r.className = pass === total ? 'pass' : 'fail';
</script>
</body></html>
```

- [ ] **Step 2: 打开自检，确认失败**

在浏览器打开 `ppt/selftest.html`（file:// 即可）。
Expected: 控制台 `PPTGeom is not defined`，标题停在 "running…"

- [ ] **Step 3: 写 `ppt/geom.js`**

```js
// ppt-maker geometry: pure helpers shared by editor.js and selftest.html.
// Canvas coords are always 1280x720 regardless of on-screen zoom.
(() => {
  const W = 1280, H = 720, COLS = 16, ROWS = 9;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function clientToSlide(sr, x0, y0, x1, y1) {
    const k = W / sr.width;
    const xa = clamp((Math.min(x0, x1) - sr.left) * k, 0, W), xb = clamp((Math.max(x0, x1) - sr.left) * k, 0, W);
    const ya = clamp((Math.min(y0, y1) - sr.top) * k, 0, H), yb = clamp((Math.max(y0, y1) - sr.top) * k, 0, H);
    return { x: Math.round(xa), y: Math.round(ya), w: Math.round(xb - xa), h: Math.round(yb - ya) };
  }

  function elementRect(sr, el) {
    const k = W / sr.width, er = el.getBoundingClientRect();
    return { x: Math.round((er.left - sr.left) * k), y: Math.round((er.top - sr.top) * k),
             w: Math.round(er.width * k), h: Math.round(er.height * k) };
  }

  function slideToClient(sr, r) {
    const k = sr.width / W;
    return { left: sr.left + r.x * k, top: sr.top + r.y * k, width: r.w * k, height: r.h * k };
  }

  function rectToCells(r) {
    const cw = W / COLS, ch = H / ROWS;
    const c1 = clamp(Math.floor(r.x / cw) + 1, 1, COLS), c2 = clamp(Math.max(c1, Math.ceil((r.x + r.w) / cw)), 1, COLS);
    const r1 = clamp(Math.floor(r.y / ch) + 1, 1, ROWS), r2 = clamp(Math.max(r1, Math.ceil((r.y + r.h) / ch)), 1, ROWS);
    return `${c1}-${c2}/${r1}-${r2}`;
  }

  const overlapArea = (a, b) =>
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const depth = (el) => { let d = 0; while ((el = el.parentElement)) if (el.classList.contains('block')) d++; return d; };
  const touches = (a, r) => r.w === 0 && r.h === 0
    ? r.x >= a.x && r.x < a.x + a.w && r.y >= a.y && r.y < a.y + a.h
    : overlapArea(a, r) > 0;

  function hitBlocks(slide, r) {
    const sr = slide.getBoundingClientRect();
    return [...slide.querySelectorAll('.block[id]')]
      .filter((b) => touches(elementRect(sr, b), r))
      .sort((a, b) => depth(b) - depth(a))
      .map((b) => b.id);
  }

  function lint(slide) {
    const out = [], sr = slide.getBoundingClientRect(), sid = slide.id || null, doc = slide.ownerDocument;
    const blocks = [...slide.querySelectorAll('.block')];
    if (!slide.id) out.push({ kind: 'missing-id', block: null, slide_id: null });
    for (const b of blocks) {
      if (!b.id) { out.push({ kind: 'missing-id', block: null, slide_id: sid }); continue; }
      if (doc.querySelectorAll('#' + CSS.escape(b.id)).length > 1) out.push({ kind: 'duplicate-id', block: b.id, slide_id: sid });
      const px = Math.max(b.scrollHeight - b.clientHeight, b.scrollWidth - b.clientWidth);
      if (px > 1) out.push({ kind: 'overflow', block: b.id, slide_id: sid, px });
    }
    // overlap only among siblings: a nested block legitimately sits inside its parent
    for (const parent of [slide, ...blocks]) {
      const kids = [...parent.children].filter((c) => c.classList.contains('block'));
      for (let i = 0; i < kids.length; i++) for (let j = 0; j < i; j++) {
        if (overlapArea(elementRect(sr, kids[i]), elementRect(sr, kids[j])) > 1)
          out.push({ kind: 'overlap', block: kids[i].id || null, other: kids[j].id || null, slide_id: sid });
      }
    }
    return out;
  }

  window.PPTGeom = { W, H, COLS, ROWS, clientToSlide, elementRect, slideToClient, rectToCells, hitBlocks, lint };
})();
```

注：`hit blank area` 用零尺寸点击 `(1270,710)`，该点在第 9 行第 16 列，`d` 只到第 10 列，`c` 只到第 8 行 → `[]`。

- [ ] **Step 4: 刷新自检，确认通过**

Expected: 标题显示绿色 `PASS 14/14`。（用 Chrome 插件 `get_page_text` 读取亦可）

- [ ] **Step 5: Commit**

```bash
git add ppt/geom.js ppt/selftest.html
git commit -m "feat: geometry helpers with browser selftest"
```

---

### Task 5: 编辑层 `editor.js` / `editor.css` + 截图库

**Files:**
- Create: `ppt/vendor/html-to-image.js`, `ppt/vendor/LICENSE-html-to-image`, `ppt/editor.css`, `ppt/editor.js`

**Interfaces:**
- Consumes: `window.PPT = {token, version}`（server 注入）、`window.PPTGeom`（Task 4）、`window.htmlToImage.toCanvas`、HTTP API（Task 2）
- Produces: 浏览器行为（无 JS 接口）。localStorage 键：`ppt-queue`、`ppt-dismissed`、`ppt-lint-seen`；sessionStorage 键：`ppt-scroll`、`ppt-replay`

- [ ] **Step 1: 下载截图库并核对全局名**

```bash
mkdir -p ppt/vendor
curl -fsSL -o ppt/vendor/html-to-image.js https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.js
curl -fsSL -o ppt/vendor/LICENSE-html-to-image https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/LICENSE
grep -o "htmlToImage" ppt/vendor/html-to-image.js | head -1
```
Expected: 输出 `htmlToImage`（UMD 全局名）。若不是，用 grep 到的实际全局名替换下面 `editor.js` 中的 `htmlToImage`。

- [ ] **Step 2: 写 `ppt/editor.css`**

```css
/* ppt-maker editor layer — injected by server.py, never saved into deck.html */
.slide { zoom: var(--ppt-zoom, 1); cursor: crosshair; }
.slide [contenteditable="true"] { outline: 2px solid #2563eb; cursor: text; }
.ppt-lint { outline: 2px dashed #dc2626 !important; outline-offset: -2px; }
#ppt-ui { position: absolute; left: 0; top: 0; z-index: 2147483000; font: 13px/1.45 system-ui, "Microsoft YaHei", sans-serif; color: #111; }
#ppt-ui .ppt-abs { position: absolute; }
.ppt-status { position: fixed; top: 8px; right: 8px; padding: 4px 12px; border-radius: 999px; background: #111; color: #fff; z-index: 2147483001; }
.ppt-status.off { background: #dc2626; }
.ppt-sel { border: 2px dashed #2563eb; background: rgba(37, 99, 235, .08); pointer-events: none; box-sizing: border-box; }
.ppt-pop, .ppt-bubble, .ppt-toast { background: #fff; border: 1px solid #d1d5db; border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,.15); padding: 8px; width: 320px; box-sizing: border-box; }
.ppt-pop textarea, .ppt-bubble textarea, .ppt-toast textarea { width: 100%; box-sizing: border-box; min-height: 56px; font: inherit; border: 1px solid #e5e7eb; border-radius: 6px; padding: 6px; resize: vertical; }
.ppt-mark { border: 2px solid #f59e0b; border-radius: 4px; pointer-events: none; box-sizing: border-box; }
.ppt-mark.processing { border-color: #2563eb; } .ppt-mark.done { border-color: #16a34a; }
.ppt-mark b { position: absolute; top: -22px; left: -2px; padding: 1px 6px; border-radius: 4px; color: #fff; font-weight: 500; background: #f59e0b; white-space: nowrap; }
.ppt-mark.processing b { background: #2563eb; } .ppt-mark.done b { background: #16a34a; }
.ppt-bubble { max-height: 280px; overflow: auto; }
.ppt-bubble p { margin: 0 0 6px; white-space: pre-wrap; } .ppt-bubble .who { color: #6b7280; }
.ppt-bubble .x { float: right; border: 0; background: none; cursor: pointer; font-size: 16px; line-height: 1; }
.ppt-toast { position: fixed; left: 50%; top: 48px; transform: translateX(-50%); z-index: 2147483001; }
```

- [ ] **Step 3: 写 `ppt/editor.js`**

```js
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
      place(bub, { left: cr.left + cr.width + 8, top: cr.top });
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
    place(node, { left: cr.left, top: cr.top + cr.height + 8 });
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
```

- [ ] **Step 4: 手动验证（服务 + curl，不需要 Claude）**

```bash
mkdir -p decks/smoke && cp ppt/template.html decks/smoke/deck.html
python ppt/server.py decks/smoke     # 后台；记下 URL
```
在浏览器中逐项确认：
1. 右上角显示 `○ Claude 离线`；窗口拉窄时幻灯片缩小、不出现横向滚动。
2. 在标题处拖框 → 弹出输入框，显示"第 1 页 · 网格 …" → 输入"测试"回车 → `decks/smoke/.ppt/inbox.jsonl` 出现 `e1 intent`，`.ppt/shots/e1.png` 是该区域截图（打开看）。
3. 页面上该区域出现橙色"#e1 排队中"框。执行 `python ppt/server.py --reply decks/smoke e1 --ack` → 1 秒内变蓝"处理中"；`--reply decks/smoke e1 "收到"` → 变绿并弹出气泡；在气泡里回复"再改改"回车 → inbox 出现 `answer re:e1`。
4. 双击副标题 → 改字 → 点空白处 → `deck.html` 已更新，inbox 有 `edit`；deck.html 中不含 `data-ppt`、`contenteditable`、`ppt-lint`、`--ppt-zoom`。
5. 用编辑器手改 deck.html（加一个字）并保存 → 页面 1 秒内自动刷新、滚动位置不变。
6. 双击副标题开始改字，此时用编辑器改 deck.html 另一处并保存，再点空白 → 页面刷新后两处修改都在（409 重放）。
7. 停掉服务 → 状态变红"服务断开"；框选提交一条 → 显示"1 条待发送"；重启服务（会得到同端口、新口令的 URL）并在同一浏览器打开新 URL → 待发送事件自动进入 inbox（队列按端口存在浏览器里）。
8. 把副标题块改成 `grid-area:6/2/7/4` 并填长文本 → 刷新后该块红色虚线框，inbox 出现一条 `lint`（overflow）；再刷新不重复上报。

全部通过后停服务、删 `decks/smoke`。

- [ ] **Step 5: Commit**

```bash
git add ppt/vendor ppt/editor.css ppt/editor.js
git commit -m "feat: editor layer — selection intents, screenshots, edit/save, lint, reply bubbles"
```

---

### Task 6: `/ppt` 命令 + 端到端验收

**Files:**
- Modify: `.claude/commands/ppt.md`（替换占位内容）

**Interfaces:**
- Consumes: CLI（Task 1、3）、`ppt/template.html`、事件格式（Task 2）

- [ ] **Step 1: 写 `.claude/commands/ppt.md`**

````markdown
---
description: 打开 ppt-maker：在浏览器幻灯片上框选/写意图/改字，操作实时回传本会话
argument-hint: <deck 名字或主题>
---
你是 ppt-maker 的执行端：用户在浏览器幻灯片上操作，操作以事件形式到达本会话，你修改 `decks/<名字>/deck.html`。参数：$ARGUMENTS

## 启动
1. 名字取参数（去掉 `/\:*?"<>|`）；参数为空就问用户。下面命令里的 `python` 不存在时用 `python3`；路径一律加引号。
2. `decks/<名字>/deck.html` 不存在：复制 `ppt/template.html` 过去，按参数主题（及对话中已有信息）写 3–6 页初稿，严格遵守"格式规则"。
3. 后台启动服务（Bash，run_in_background）：`python ppt/server.py "decks/<名字>"`。从输出拿到 URL 发给用户（服务已自动打开浏览器）。
4. 用 Monitor 挂监听：command `python ppt/server.py --tail "decks/<名字>"`，timeout_ms 1800000，description `ppt 事件 <名字>`。它启动时先输出所有未完成事件，按顺序处理。**监听到期通知一到，立即用同一命令重新挂上。**
5. 服务进程退出的通知到达时：重新执行第 3 步，把新 URL 告诉用户。

## 处理事件
摘要格式：`e17 intent slide:s-intro [b-right,b-r1] 文字…`。完整内容在 `decks/<名字>/.ppt/inbox.jsonl`，按 id 查。
- 处理 intent / answer / lint 之前先标记：`python ppt/server.py --reply "decks/<名字>" <id> --ack`
- **intent**：有 `shot` 就用 Read 看截图（路径相对 deck 目录）。先重新读 deck.html，再只改 `blocks` 列出的块（第一个是最内层）；`blocks` 为空时按 `cells`（列范围/行范围）在该区域新建块。不动无关块。
- **answer**：`re` 指向原 intent；结合原意图、你之前的回执和这条回答继续改。
- **lint**：修 `issues`：overflow → 精简文字、减小字号或扩大 grid-area；overlap → 调整 grid-area；missing-id / duplicate-id → 补或改 id。同一块同一问题最多自动修 2 次，之后只回执说明，让用户决定。
- **edit**：用户直接改了某块。无需动作、无需回执；下次改文件前重新读。
- 处理完必须回执（一句话说明改了什么）：`python ppt/server.py --reply "decks/<名字>" <id> "<说明>"`。没理解就在回执里问一个具体问题，不要猜着大改。
- 用户在终端直接说的话照常执行，规则相同。

## deck.html 格式规则
1. 每页 `<section class="slide" id="s-…">`，每块 `<div class="block" id="b-…">`，id 全文件唯一。
2. id 是固定名字，不表示位置；调页序、增删内容都不重编号。新 id 用有意义的短名。
3. 定位只用 `style="grid-area:起始行/起始列/结束行/结束列"`，网格 16 列 × 9 行（画布 1280×720，每格 80px，结束线最大为行 10 / 列 17）。块内细分用 `class="block grid"` 并写 `grid-template-columns`/`grid-template-rows`。
4. 颜色字体只用 `#theme` 里的 CSS 变量；整体风格只改 `#theme`；单块主题在该块 style 里覆盖变量。不改 `#base`。
5. 文字必须是真文字；表格用 `<table>`；插图用内联 SVG 或 `assets/` 下的图片。
6. 单文件离线：不引用外部网络资源（字体、脚本、图片都不行）。
7. 不要写入任何 `data-ppt` 属性或 `ppt-` 开头的 class（编辑层专用）。
````

- [ ] **Step 2: 跑全部自动测试**

Run: `python ppt/test_server.py -v`，并在浏览器打开 `ppt/selftest.html`
Expected: 15 tests OK；selftest `PASS 14/14`

- [ ] **Step 3: 端到端验收（重启 Claude Code 后在本仓库执行）**

1. `/ppt 测试` → 生成 `decks/测试/deck.html` 初稿，浏览器打开，右上角 `● Claude 在线`。
2. 框选一块写"拆成三栏，每栏一个方法" → Claude 被唤醒，框变蓝再变绿，页面自动刷新为三栏，气泡显示回执。
3. 在气泡里回复"第二栏换成表格" → Claude 处理 answer，页面更新。
4. 双击改一处文字 → Claude 收到 `edit`，不回执、不动作。
5. 双击改字的同时在终端让 Claude 改同一页另一块 → 失焦后两处修改都在。
6. 让 Claude 在一块里塞很长的文字 → 页面上报 lint → Claude 自动修复。
7. 结束 Claude Code 会话（不要停服务）→ 页面 30 秒内显示"离线"；提交一条意图；重新打开会话执行 `/ppt 测试` → 监听启动时补出这条事件并处理。

可由 Claude 通过 Chrome 插件执行并截图记录。发现问题记录到 `.vibe/state.md` 的"当前 blocker"并修复后重跑对应步骤。

- [ ] **Step 4: Commit 并推送**

```bash
git add .claude/commands/ppt.md
git commit -m "feat: /ppt command — startup, event protocol and deck format rules"
git push
```
