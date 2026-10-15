# ppt-maker 子项目 5：批量提交 + 导入 HTML Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 意图可以先进"待发清单"、一次发出（`kind:batch`）；以前做过的 HTML（文件、zip、网址）可以导入，由 Claude 尽量还原原样地转成 ppt-maker 格式。

**Architecture:** 所有意图都经同一个出口 `deliver(payload, toBatch)`：立刻发送走现有队列，否则进浏览器里的清单；清单发送时打包成一个 `kind:batch` 意图，服务端逐条校验、分存截图，并在 `/api/state` 里展开成 `e12-1…` 供页面画标记。导入由新模块 `ppt/importer.py` 安全落盘与判断类型，`server.py` 发 `import` 事件交给 Claude 转换；原稿以 CSP sandbox 提供。

**Tech Stack:** Python 3 标准库（`zipfile`）、浏览器原生 JS、Edge headless 测试。

**Spec:** `docs/superpowers/specs/2026-10-15-ppt-maker-batch-import-design.md`

## Global Constraints

- 分支 `feat/batch-import`；每个 task 提交，信息末尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- Python 只用标准库；页面不引入第三方库。
- 清单 ≤ 30 条；发送前估算 JSON > 9MB 时拒发；batch 的 item 只允许 `kind` 为空或 `sketch`。
- 导入：`.html .htm .zip`，≤ 50MB（上传与 zip 解压后都算），zip ≤ 2000 个文件，拒绝绝对路径、盘符、`..`；`mode` ∈ `append|replace`；导入 id `i-` + 6 位小写字母数字。
- `/imports/…` 一律带 `Content-Security-Policy: sandbox`。
- 新接口都要口令与 Host 校验；流式上传被拒时把请求体读掉再回复。
- 页面里用户/原稿数据用 `textContent`；截图缩略图只接受 `data:image/png`。
- 测试：`python ppt/test_server.py`；selftest（`$TEMP/ppt-logs/selftest.sh`）；`node tests/e2e.mjs`。
- Windows：含反斜杠或 `\r\n` 的代码用 Edit/Write，不用 Bash heredoc。

## Review Focus

1. **清单里的条目所在页被删了**：标记不画、定位无效，但发送照常（Claude 会按 `slide_id` 发现并说明）。→ Task 3 e2e `Q a list item on a deleted slide does not break the page`。
2. **浏览器存储满**：加入清单不能静默丢；要么不带截图加入并提示，要么提示没加入。→ Task 3 e2e `Q storage full: item kept without its screenshot`。
3. **zip 里文件头谎报大小（压缩炸弹）**：解压时按实际写出的字节计数并中止。→ Task 2 `test_zip_bomb_stops_at_the_real_size`。
4. **原稿里的脚本**：通过 `/imports/` 打开时不运行、不能读编辑器的 localStorage。→ Task 2 `test_original_is_sandboxed`（头）与 Task 4 e2e `I2 original opens sandboxed`。
5. **对 batch 的回复与追问**：回复显示在第 1 条旁；在气泡里追问，`re` 指向 batch 本身而不是 `e12-1`。→ Task 1 `test_state_expands_batches` 与 Task 3 e2e `Q answering a batch refers to the batch`。

---

### Task 1: 服务端 batch 事件

**Files:** Modify `ppt/server.py`；Test `ppt/test_server.py`

**Interfaces:**
- Produces：`clean_event` 接受 `{type:"intent", kind:"batch", text?, items:[…]}`；`MAX_ITEMS = 30`；`add_event` 把 item 截图存为 `e<N>-<i>.png`；`state()` 的 events 里 batch 展开为 `{id:"e12-1", type:"intent", parent:"e12", slide_id, rect, text, status, reply(仅第 1 条)}`，回答 batch 的 answer 的 `re` 显示为 `e12-1`；`summary` 附 ` items:N`。

- [ ] **Step 1: 写失败的测试**（`class CliTests` 之前）

```python
class BatchTests(ServerCase):
    def item(self, text, slide_id="s-cover", **kw):
        return {"slide": 1, "slide_id": slide_id, "rect": {"x": 0, "y": 0, "w": 100, "h": 50}, "cells": "1-2/1-1", "blocks": ["b-cover-title"], "text": text, **kw}

    def post(self, ev):
        return self.req("POST", "/api/event?t=tok", ev)[0]

    def test_batch_items_saved_with_their_shots(self):
        self.assertEqual(self.post({"type": "intent", "kind": "batch", "text": "整页改成对比结构",
                                    "items": [self.item("标题改短", shot=PNG), self.item("画一个流程", kind="sketch", notes=["开始"])]}), 200)
        e = inbox(self.deck)[-1]
        self.assertEqual([i["text"] for i in e["items"]], ["标题改短", "画一个流程"])
        self.assertEqual(e["items"][0]["shot"], f".ppt/shots/{e['id']}-1.png")
        self.assertTrue((self.deck / e["items"][0]["shot"]).read_bytes().startswith(b"\x89PNG"))
        self.assertNotIn("shot", e["items"][1])
        self.assertIn(" kind:batch ", server.summary(e))
        self.assertIn(" items:2 ", server.summary(e))

    def test_batch_validation(self):
        ok = self.item("x")
        for bad in ({"type": "intent", "kind": "batch", "text": "x"},
                    {"type": "intent", "kind": "batch", "items": "x"},
                    {"type": "intent", "kind": "batch", "items": []},
                    {"type": "intent", "kind": "batch", "items": [ok] * 31},
                    {"type": "intent", "kind": "batch", "items": [{**ok, "type": "intent"}]},
                    {"type": "intent", "kind": "batch", "items": [{**ok, "kind": "draw-icon"}]},
                    {"type": "intent", "kind": "batch", "items": [{**ok, "blocks": "x"}]},
                    {"type": "intent", "kind": "batch", "items": [{**ok, "items": [ok]}]},
                    {"type": "intent", "text": "x", "items": [ok]}):
            self.assertEqual(self.post(bad), 400, bad)

    def test_state_expands_batches(self):
        self.post({"type": "intent", "kind": "batch", "items": [self.item("一"), self.item("二", slide_id="s-2")]})
        self.post({"type": "answer", "re": "e1", "text": "第二条再大一点"})
        server.reply(self.deck, "e1", "两处都改好了")
        ev = {e["id"]: e for e in json.loads(self.req("GET", "/api/state?t=tok")[1])["events"]}
        self.assertEqual((ev["e1-1"]["parent"], ev["e1-1"]["reply"], ev["e1-1"]["status"]), ("e1", "两处都改好了", "done"))
        self.assertEqual((ev["e1-2"]["slide_id"], ev["e1-2"]["reply"]), ("s-2", None))
        self.assertNotIn("e1", ev)
        self.assertEqual(ev["e2"]["re"], "e1-1")
```

- [ ] **Step 2: 运行，确认失败** — `python ppt/test_server.py` → 3 个 BatchTests FAIL

- [ ] **Step 3: 实现 `ppt/server.py`**
1. 常量：`MAX_NOTE = 200` 之后加 `MAX_ITEMS = 30`。
2. `clean_event` 拆成两段：把"`ev = {k: body[k] …`"到"`return ev, shot`"整段移入新函数 `def _fields(body):`（不含 type 校验，`"""One event's (or batch item's) whitelisted fields; returns (fields, png_bytes|None)."""`），并在 `_fields` 开头的字典推导式里排除 `items`：`ev = {k: body[k] for k in FIELD_TYPES if k in body and body[k] is not None and k != "items"}`。`clean_event` 改为：

```python
def clean_event(body):
    """Whitelist fields from a page-posted event; returns (event, png_bytes|None).
    A batch keeps its items, each checked like an intent; their screenshots ride along as "_shot" for add_event."""
    if not isinstance(body, dict) or body.get("type") not in EVENT_TYPES:
        raise ValueError("bad type")
    ev, shot = _fields(body)
    items = body.get("items")
    if ev.get("kind") == "batch":
        if not isinstance(items, list) or not 0 < len(items) <= MAX_ITEMS:
            raise ValueError("bad items")
        ev["items"] = []
        for it in items:
            if not isinstance(it, dict) or "type" in it or "items" in it or it.get("kind") not in (None, "sketch"):
                raise ValueError("bad item")
            fields, item_shot = _fields(it)
            ev["items"].append({**fields, **({"_shot": item_shot} if item_shot else {})})
    elif items is not None:
        raise ValueError("items only belong to a batch")
    return ev, shot
```

3. `FIELD_TYPES` 加 `"items": list`。
4. `add_event` 里 `if shot:` 之前加：

```python
    if ev.get("items"):
        ev = {**ev, "items": [dict(it) for it in ev["items"]]}
        for i, it in enumerate(ev["items"], 1):
            png = it.pop("_shot", None)
            if png:
                (rt / "shots" / f"{eid}-{i}.png").write_bytes(png)
                it["shot"] = f".ppt/shots/{eid}-{i}.png"
```

5. `state()` 的 events 构建换成：

```python
    events, batches = [], set()
    for e in read_jsonl(rt / "inbox.jsonl"):
        t, status, reply = e.get("type"), st.get(e.get("id"), "queued"), replies.get(e.get("id"))
        if t == "intent" and e.get("kind") == "batch":  # one mark per item; the reply sits by the first
            batches.add(e["id"])
            for i, it in enumerate(e.get("items") or [], 1):
                events.append({"id": f"{e['id']}-{i}", "type": "intent", "parent": e["id"], "re": None, "slide_id": it.get("slide_id"),
                               "rect": it.get("rect"), "text": it.get("text", ""), "status": status, "reply": reply if i == 1 else None})
        elif t in ("intent", "answer"):
            re_ = e.get("re")
            events.append({"id": e["id"], "type": t, "re": f"{re_}-1" if re_ in batches else re_, "slide_id": e.get("slide_id"),
                           "rect": e.get("rect"), "text": e.get("text", ""), "status": status, "reply": reply})
```

6. `summary`：`kbs = …` 之后加 `items = f" items:{len(e['items'])}" if e.get("items") else ""`，`{quote}{notes}{kbs}` 改为 `{quote}{notes}{kbs}{items}`。

- [ ] **Step 4: 运行，确认通过** — `python ppt/test_server.py` → OK（85）；selftest 99/99；e2e 145/145
- [ ] **Step 5: 提交** `feat(batch): batch intents — items checked one by one, screenshots per item, expanded in /api/state`

---

### Task 2: `ppt/importer.py` 与导入接口

**Files:** Create `ppt/importer.py`；Modify `ppt/server.py`；Test `ppt/test_server.py`

**Interfaces:**
- Produces：`importer.MAX_IMPORT`、`MAX_FILES`、`MODES = ("append", "replace")`、`check_name(name)`、`save(deck, stream, length, name) -> (iid, dir, entry)`、`hint(text) -> "ppt-maker"|"slides"|"page"`、`event(deck, iid, d, entry, mode) -> dict`、`url_event(url, mode) -> dict`；
  `POST /api/import?mode=&name=`（流式）→ `{id}`；`POST /api/import/url` `{url, mode}` → `{id}`；`/imports/…` 带 CSP sandbox；`import` 事件需要回执；`state()` 的 events 带 `{id, type:"import", status, reply, original}`；命令行 `--import <deck> <路径或网址> [append|replace]`。

- [ ] **Step 1: 写失败的测试**（`class CliTests` 之前；文件顶部 `import importer`）

```python
REVEAL = '<html><body><div class="reveal"><div class="slides"><section><h1>导入测试</h1></section><section>二</section></div></div><script>window.x=1</script></body></html>'


class ImporterTests(ServerCase):
    def save(self, data, name):
        return importer.save(self.deck, io.BytesIO(data), len(data), name)

    def test_hint(self):
        self.assertEqual(importer.hint(TEMPLATE.read_text(encoding="utf-8")), "ppt-maker")
        self.assertEqual(importer.hint(REVEAL), "slides")
        self.assertEqual(importer.hint("<section>a</section>" * 3), "slides")
        self.assertEqual(importer.hint("<article><h1>报告</h1><p>正文</p></article>"), "page")

    def test_save_html_and_zip(self):
        iid, d, entry = self.save(REVEAL.encode(), "../旧稿.html")
        self.assertRegex(iid, r"^i-[0-9a-z]{6}$")
        self.assertEqual((d, entry.name, entry.read_text(encoding="utf-8")), (self.deck / "imports" / iid, "旧稿.html", REVEAL))
        z = zip_bytes({"deep/a/page.html": "<p>x</p>", "site/index.html": "<h1>首页</h1>", "site/img/a.png": b"\x89PNG", "site/about.html": "<p>y</p>"})
        _, d2, entry2 = self.save(z, "site.zip")
        self.assertEqual(entry2.relative_to(d2).as_posix(), "site/index.html")
        self.assertTrue((d2 / "site" / "img" / "a.png").is_file())
        self.assertFalse(any(p.suffix == ".zip" for p in d2.iterdir()))

    def test_unsafe_or_empty_zips_are_refused(self):
        for files in ({"../evil.html": "x"}, {"/abs.html": "x"}, {"C:/win.html": "x"}, {"a.txt": "no html here"}):
            with self.assertRaises(ValueError, msg=files):
                self.save(zip_bytes(files), "x.zip")
        with mock.patch.object(importer, "MAX_FILES", 2):
            with self.assertRaises(ValueError):
                self.save(zip_bytes({"a.html": "1", "b.html": "2", "c.html": "3"}), "x.zip")
        with self.assertRaises(ValueError):
            self.save(b"<p>x</p>", "x.exe")
        self.assertEqual(list((self.deck / "imports").iterdir()), [])  # nothing half-imported is left behind
        self.assertFalse((self.tmp / "evil.html").exists())

    def test_zip_bomb_stops_at_the_real_size(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("index.html", "<p>" + "x" * 5000 + "</p>")
        with mock.patch.object(importer, "MAX_IMPORT", 1000):
            with self.assertRaises(ValueError):
                self.save(buf.getvalue(), "bomb.zip")

    def up(self, data, name, mode="append", token="tok"):
        return post_raw(self.port, f"/api/import?t={token}&mode={mode}&name={quote(name)}", data, "text/html")

    def test_import_endpoint_and_event(self):
        s, b = self.up(REVEAL.encode(), "旧稿.html")
        self.assertEqual(s, 200)
        e = inbox(self.deck)[-1]
        self.assertEqual((e["id"], e["type"], e["kind"], e["mode"], e["hint"]), (json.loads(b)["id"], "import", "file", "append", "slides"))
        self.assertTrue(Path(e["source"]).is_file())
        self.assertEqual(e["original"], f"/imports/{e['import_id']}/旧稿.html")
        self.assertIn(" import kind:file ", server.summary(e))
        for args, code in (((b"x" * 1000, "a.html", "sideways"), 400), ((b"x" * 1000, "a.exe"), 400), ((b"x" * 1000, "a.html", "append", "bad"), 403)):
            self.assertEqual(self.up(*args)[0], code, args)
        with mock.patch.object(importer, "MAX_IMPORT", 16):
            self.assertEqual(self.up(b"x" * 1000, "a.html")[0], 413)

    def test_original_is_sandboxed(self):
        self.up(REVEAL.encode(), "旧稿.html")
        e = inbox(self.deck)[-1]
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("GET", quote(e["original"]), headers={"Host": f"127.0.0.1:{self.port}"})
        r = c.getresponse()
        body = r.read().decode()
        c.close()
        self.assertEqual((r.status, r.getheader("Content-Security-Policy")), (200, "sandbox"))
        self.assertIn("导入测试", body)
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("GET", "/?t=tok", headers={"Host": f"127.0.0.1:{self.port}"})
        self.assertIsNone(c.getresponse().getheader("Content-Security-Policy"))
        c.close()

    def test_url_import_state_and_cli(self):
        def post(body):
            return post_raw(self.port, "/api/import/url?t=tok", json.dumps(body).encode(), "application/json")[0]
        self.assertEqual(post({"url": "ftp://x.com", "mode": "append"}), 400)
        self.assertEqual(post({"url": "https://example.com/a", "mode": "replace"}), 200)
        e = inbox(self.deck)[-1]
        self.assertEqual((e["type"], e["kind"], e["mode"], e["source"]), ("import", "url", "replace", "https://example.com/a"))
        server.reply(self.deck, e["id"], "导入了 3 页")
        st = {x["id"]: x for x in json.loads(self.req("GET", "/api/state?t=tok")[1])["events"]}
        self.assertEqual((st[e["id"]]["type"], st[e["id"]]["status"], st[e["id"]]["reply"]), ("import", "done", "导入了 3 页"))
        src = self.tmp / "旧.html"
        src.write_text(REVEAL, encoding="utf-8")
        with contextlib.redirect_stdout(io.StringIO()) as out:
            server.main(["--import", str(self.deck), str(src), "replace"])
        e2 = inbox(self.deck)[-1]
        self.assertEqual((e2["type"], e2["mode"], e2["hint"]), ("import", "replace", "slides"))
        self.assertIn(e2["id"], out.getvalue())
```

- [ ] **Step 2: 运行，确认失败** — `ModuleNotFoundError: importer`

- [ ] **Step 3: 写 `ppt/importer.py`**

```python
"""ppt-maker HTML import (stdlib only): store an uploaded .html / .zip safely under decks/<name>/imports/<id>/,
pick its entry page and guess what it is. Claude does the conversion; this only lands the files."""
import os, re, secrets, shutil, zipfile
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse

import kb

MAX_IMPORT = 50 * 1024 * 1024  # bytes uploaded, and bytes written when a zip is unpacked
MAX_FILES = 2000
MODES = ("append", "replace")
EXTS = (".html", ".htm", ".zip")


def check_name(name):
    ext = Path(kb.safe_name(name)).suffix
    if ext not in EXTS:
        raise ValueError("只能导入 .html、.htm 或 .zip")
    return ext


def _new_id(base):
    while True:
        iid = "i-" + "".join(secrets.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(6))
        if not (base / iid).exists():
            return iid


def _copy(src, out, budget):
    """Copy a stream, counting real bytes: a zip header can lie about its sizes."""
    while True:
        chunk = src.read(65536)
        if not chunk:
            return budget
        budget -= len(chunk)
        if budget < 0:
            raise ValueError("压缩包解压后超过 50MB")
        out.write(chunk)


def _unzip(zpath, d):
    with zipfile.ZipFile(zpath) as z:
        infos = [i for i in z.infolist() if not i.is_dir()]
        if len(infos) > MAX_FILES:
            raise ValueError("压缩包里文件太多")
        budget = MAX_IMPORT
        for i in infos:
            name = i.filename.replace("\\", "/")
            parts = PurePosixPath(name).parts
            if name.startswith("/") or re.match(r"^[A-Za-z]:", name) or ".." in parts:
                raise ValueError(f"压缩包里有不安全的路径：{i.filename}")
            dest = d.joinpath(*parts).resolve()
            if not dest.is_relative_to(d.resolve()):
                raise ValueError(f"压缩包里有不安全的路径：{i.filename}")
            dest.parent.mkdir(parents=True, exist_ok=True)
            with z.open(i) as src, dest.open("wb") as out:
                budget = _copy(src, out, budget)
    pages = [p for p in d.rglob("*") if p.is_file() and p.suffix.lower() in (".html", ".htm")]
    if not pages:
        raise ValueError("压缩包里没有 HTML")
    return min(pages, key=lambda p: (len(p.relative_to(d).parts), p.name.lower() != "index.html", p.as_posix()))


def save(deck, stream, length, name):
    """Land an upload: (import id, its folder, the entry html). Nothing is left behind on failure."""
    ext = check_name(name)
    base = Path(deck) / "imports"
    base.mkdir(parents=True, exist_ok=True)
    iid = _new_id(base)
    d = base / iid
    d.mkdir()
    try:
        tmp = d / f".upload{ext}"
        with tmp.open("wb") as out:
            left = _copy_exact(stream, out, length)
        if left:
            raise ValueError("上传不完整")
        if ext == ".zip":
            entry = _unzip(tmp, d)
            tmp.unlink()
        else:
            entry = d / kb.safe_name(name)
            os.replace(tmp, entry)
        return iid, d, entry
    except BaseException:
        shutil.rmtree(d, ignore_errors=True)
        raise


def _copy_exact(stream, out, length):
    left = length
    while left > 0:
        chunk = stream.read(min(65536, left))
        if not chunk:
            break
        out.write(chunk)
        left -= len(chunk)
    return left


def hint(text):
    """What the html looks like, so Claude knows how to read it."""
    if re.search(r'<section[^>]*class="[^"]*\bslide\b', text) and re.search(r'id=["\']theme["\']', text):
        return "ppt-maker"
    if re.search(r'class="[^"]*\breveal\b|data-marpit|slidev', text, re.I) or len(re.findall(r"<section\b", text, re.I)) >= 3:
        return "slides"
    return "page"


def event(deck, iid, d, entry, mode):
    text = entry.read_text(encoding="utf-8", errors="replace")[:2_000_000]
    h = hint(text)
    return {"type": "import", "kind": "file", "mode": mode, "hint": h, "import_id": iid, "text": f"导入《{entry.name}》{mode} {h}",
            "source": str(entry), "dir": str(d), "original": "/imports/" + entry.relative_to(Path(deck) / "imports").as_posix()}


def url_event(url, mode):
    u = urlparse(str(url).strip())
    if u.scheme not in ("http", "https") or not u.netloc:
        raise ValueError("只接受 http(s) 网址")
    return {"type": "import", "kind": "url", "mode": mode, "text": f"导入 {u.geturl()} {mode}", "source": u.geturl()}
```

- [ ] **Step 4: 接入 `ppt/server.py`**
1. `import kb` 之后加 `import importer`。
2. `REPLY_TYPES = EVENT_TYPES | {"kb"}` 改为 `REPLY_TYPES = EVENT_TYPES | {"kb", "import"}`。
3. 加常量 `STREAMED = ("/api/kb/file", "/api/import")`；`guard` 里 `if urlparse(self.path).path == "/api/kb/file":` 改为 `if self.command == "POST" and urlparse(self.path).path in STREAMED:`。
4. `send(self, code, body=b"", ctype=…)` 加参数 `headers=None`，在 `end_headers()` 之前 `for k, v in (headers or {}).items(): self.send_header(k, v)`。
5. 静态文件那段：`self.send(200, f.read_bytes(), mimetypes…)` 改为

```python
        rel = f.relative_to(deck.resolve()).parts if root == deck else ()
        sandbox = {"Content-Security-Policy": "sandbox"} if rel[:1] == ("imports",) else None  # imported pages never run as us
        self.send(200, f.read_bytes(), mimetypes.guess_type(f.name)[0] or "application/octet-stream", sandbox)
```

6. `do_POST` 里 `if url.path.startswith("/api/kb/"):` 之前加 `if url.path in ("/api/import", "/api/import/url"): return self.import_post(url)`；`Handler` 加：

```python
    def import_post(self, url):
        deck, q = self.server.deck, parse_qs(url.query)
        try:
            if url.path == "/api/import":
                mode, name = q.get("mode", [""])[0], q.get("name", [""])[0]
                if self.stream_len > importer.MAX_IMPORT:
                    self.discard_stream()
                    return self.send(413, {"error": "文件超过 50MB"})
                try:
                    if mode not in importer.MODES:
                        raise ValueError("bad mode")
                    importer.check_name(name)
                except ValueError:
                    self.discard_stream()
                    raise
                iid, d, entry = importer.save(deck, self.rfile, self.stream_len, name)  # outside LOCK: may be big
                self.stream_len = 0
                fields = importer.event(deck, iid, d, entry, mode)
            else:
                body = self.read_json()
                if not isinstance(body, dict) or body.get("mode") not in importer.MODES:
                    raise ValueError("bad body")
                fields = importer.url_event(body.get("url", ""), body["mode"])
            with LOCK:
                ev = add_event(deck, fields)
            return self.send(200, {"id": ev["id"]})
        except ValueError as e:
            return self.send(400, {"error": str(e)})
        except OSError as e:
            return self.send(503, {"error": f"导入时写不进磁盘：{e}"})
```

7. `state()`：在 `elif t in ("intent", "answer"):` 分支之后加

```python
        elif t == "import":
            events.append({"id": e["id"], "type": "import", "status": status, "reply": reply, "original": e.get("original")})
```

8. 命令行：`ap.add_argument("--import", dest="import_src", action="store_true", help="import html: <deck> <path-or-url> [append|replace]")`；在 `if a.kb_add:` 之前加：

```python
    if a.import_src:
        if not a.rest or (len(a.rest) > 1 and a.rest[1] not in importer.MODES):
            ap.error("--import needs <path-or-url> [append|replace]")
        src, mode = a.rest[0], (a.rest[1] if len(a.rest) > 1 else "append")
        if src.startswith(("http://", "https://")):
            fields = importer.url_event(src, mode)
        else:
            p = Path(src)
            with p.open("rb") as f:
                fields = importer.event(deck, *importer.save(deck, f, p.stat().st_size, p.name), mode)
        with LOCK:
            ev = add_event(deck, fields)
        return print(summary(ev))
```

- [ ] **Step 5: 运行，确认通过** — `python ppt/test_server.py` → OK（92）；selftest；e2e 145/145
- [ ] **Step 6: 提交** `feat(import): land .html/.zip imports safely, sandboxed originals, import events, --import`

---

### Task 3: 待发清单（页面）

**Files:** Create `ppt/batch-panel.js`；Modify `ppt/editor.js`、`ppt/toolbar.js`、`ppt/editor.css`、`ppt/server.py`（INJECT）；Test `tests/e2e.mjs`

**Interfaces:**
- Consumes：Task 1 的 batch 事件与 state 展开。
- Produces：`window.PPTBatch = { create(ui, cb) }`，`cb = {get(), set(b, refreshPanel=true), send(), locate(item)}`，返回 `{toggle(open?), refresh()}`；面板 class `ppt-kb ppt-batch`；按钮标题 `把清单作为一个整体发给 Claude`、`清空待发清单`、`滚到这一条所在的页`、`从清单里删掉这一条`、`关闭清单`；总体说明 `textarea.ppt-batch-note`；顶栏按钮标题 `打开待发清单`（文字 `📝 清单 (N)`，N=0 时隐藏）；意图框按钮标题 `立刻发给 Claude`、`先放进待发清单（Ctrl+Enter）`；标记 class `ppt-mark ppt-pending`，文字 `① 待发`。

- [ ] **Step 1: 写失败的 e2e 测试**（`// ---- add new checks above ----` 之前）

```js
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
  await ev(`(() => { const t = document.querySelectorAll('.ppt-batch .ppt-kb-item textarea')[0]; t.value = '口号：记下来就有用'; t.dispatchEvent(new Event('input')); })()`);
  b9 = await byTitle('从清单里删掉这一条'); await click(b9.x, b9.y); await sleep(500);   // deletes item 1? no: buttons are per item in order
  check('Q delete drops one item', (await batchLen()) === 2);
  await ev(`(() => { const t = document.querySelector('.ppt-batch-note'); t.value = '整体改成更简洁的风格'; t.dispatchEvent(new Event('input')); })()`);
  b9 = await byTitle('把清单作为一个整体发给 Claude'); await click(b9.x, b9.y); await sleep(2500);
  const be = inbox().filter((e) => e.type === 'intent').at(-1);
  check('Q send all: one batch intent, note, items, shots stored per item', be?.kind === 'batch' && be.text === '整体改成更简洁的风格' && be.items?.length === 2
    && be.items.every((i, k) => !i.shot || i.shot === `.ppt/shots/${be.id}-${k + 1}.png`) && be.items.some((i) => i.shot && fs.existsSync(path.join(DECK, i.shot))), JSON.stringify(be?.items?.map((i) => ({ ...i, shot: i.shot }))));
  await sleep(1500);
  check('Q the list is empty again and the marks show the batch ids', (await batchLen()) === 0 && !(await byTitle('打开待发清单'))
    && ((await ev(`[...document.querySelectorAll('.ppt-mark b')].map((b) => b.textContent).join()`)) || '').includes(`#${be.id}-1`));
  py('--reply', 'decks/e2e-smoke', be.id, '两处都改好了'); await sleep(2500);
  const bta = await rectOf('.ppt-bubble textarea'); await click(bta.x, bta.y); await type('口号再短一点'); await enter(); await sleep(2000);
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
```

（"删除"按的是第 1 条的按钮，所以剩下第 2、3 条；第 1 条改过的文字随之删除，这正好也检查了"删除按顺序"。）

- [ ] **Step 2: 运行，确认失败** — `script ran to the end` FAIL

- [ ] **Step 3: 写 `ppt/batch-panel.js`**

```js
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
```

- [ ] **Step 4: `ppt/editor.js`**
a. `openPop(slide, r, box, label, onSend, fallback = '')` 整个函数换成：

```js
  function openPop(slide, r, box, label, onSend, fallback = '') { // onSend(text, toBatch)
    closePop(); // one box at a time: an orphaned one could not be closed and would hold off reloads
    const cr = G.slideToClient(slide.getBoundingClientRect(), r);
    place(box, cr);
    const node = el('div', 'ppt-abs ppt-pop', ui);
    place(node, panelBeside(cr, false));
    el('div', 'who', node, label);
    const listed = batch().items.length;
    const ta = el('textarea', null, node);
    ta.placeholder = listed ? `想怎么改这里？Enter 加入清单（已有 ${listed} 条）· Shift+Enter 换行 · Esc 取消`
      : '想怎么改这里？Enter 发送 · Ctrl+Enter 加入清单 · Shift+Enter 换行 · Esc 取消';
    pop = { box, node };
    const go = (toBatch) => {
      const text = ta.value.trim() || fallback;
      if (!text) return;
      closePop();
      onSend(text, toBatch);
    };
    const row = el('div', 'ppt-row', node);
    for (const [label2, title, toBatch] of [['发送', '立刻发给 Claude', false], ['加入清单', '先放进待发清单（Ctrl+Enter）', true]]) {
      const b = el('button', 'ppt-btn', row, label2); b.type = 'button'; b.title = title;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => go(toBatch));
    }
    setTimeout(() => ta.focus());
    ta.onkeydown = (k) => {
      if (k.key === 'Escape') return closePop();
      if (k.key !== 'Enter' || k.shiftKey) return;
      k.preventDefault();
      go(k.ctrlKey || k.metaKey || batch().items.length > 0);
    };
  }
```

b. 清单数据与出口（放在 `openPop` 之前）：

```js
  // ---- the 待发清单: intents wait here until "全部发送" sends them as one ----
  const batch = () => { const b = ls.get('ppt-batch', null); return b && Array.isArray(b.items) ? b : { note: '', items: [] }; };
  function setBatch(b, refreshPanel = true) {
    if (!ls.set('ppt-batch', b)) toast('浏览器存储已满，清单没能保存');
    lastKey = ''; render(); tb.setBatchCount(b.items.length);
    if (refreshPanel) batchPanel.refresh();
    if (!b.items.length) batchPanel.toggle(false);
  }
  function addToBatch(p) {
    const b = batch();
    if (b.items.length >= 30) return toast('清单最多 30 条，请先发送一批');
    const { type, ...item } = p;
    b.items.push(item);
    if (!ls.set('ppt-batch', b)) {
      delete item.shot;
      if (!ls.set('ppt-batch', b)) return toast('浏览器存储已满，没能加入清单');
      toast('浏览器存储已满，这一条不带截图');
    }
    setBatch(b);
  }
  function sendBatch() {
    const b = batch();
    if (!b.items.length) return;
    const ev = { type: 'intent', kind: 'batch', text: (b.note || '').trim() || '按清单修改', items: b.items };
    if (JSON.stringify(ev).length > 9e6) return toast('清单太大（截图太多），请分两批发送');
    enqueue(ev);
    setBatch({ note: '', items: [] });
  }
  const deliver = (p, toBatch) => (toBatch ? addToBatch(p) : enqueue(p));
```

c. 各个发送点改走 `deliver`：
- 框选：`(text) => submitIntent(d.slide, r, text)` → `(text, toBatch) => submitIntent(d.slide, r, text, undefined, {}, toBatch)`。
- `askSelected`：`(text) => submitIntent(slide, r, text, ids)` → `(text, toBatch) => submitIntent(slide, r, text, ids, {}, toBatch)`。
- `askWithKb`：`(text) => submitIntent(s, r, text, [], { kb: ids })` → `(text, toBatch) => submitIntent(s, r, text, [], { kb: ids }, toBatch)`。
- `submitIntent(slide, r, text, blocks = G.hitBlocks(slide, r), extra = {})` 加参数 `toBatch = false`，最后的 `enqueue({ type: 'intent', … })` 改为 `deliver({ type: 'intent', … }, toBatch)`。
- 选字右键：`async (text) => {` → `async (text, toBatch) => {`，其中 `enqueue({ type: 'intent', …, quote });` 改为 `deliver({ type: 'intent', …, quote }, toBatch);`。
- 草图：`async (text) => {` → `async (text, toBatch) => {`，其中 `enqueue({ type: 'intent', kind: 'sketch', … });` 改为 `deliver({ type: 'intent', kind: 'sketch', … }, toBatch);`。

d. `enqueue` 的配额回退改为同时去掉 item 截图：`q.map((e) => ({ ...e, shot: undefined, items: e.items?.map((i) => ({ ...i, shot: undefined })) }))`。

e. 面板与顶栏：`const kbPanel = PPTKB.create(…)` 之后加 `const batchPanel = PPTBatch.create(ui, { get: batch, set: setBatch, send: sendBatch, locate: (it) => document.getElementById(it.slide_id)?.scrollIntoView({ block: 'center' }) });` 与 `tb.setBatchCount(batch().items.length);`。工具栏回调里 `kb: () => kbPanel.toggle(),` 改为 `kb: () => { batchPanel.toggle(false); kbPanel.toggle(); },` 并加 `batch: () => { kbPanel.toggle(false); batchPanel.toggle(); },`。

f. `render()` 里 `const key = JSON.stringify([state.events, …` 改为 `const key = JSON.stringify([state.events, batch().items.map((i) => [i.slide_id, i.rect]), …`；在 `marks.textContent = '';` 之后加：

```js
    batch().items.forEach((it, i) => { // what waits in the list, numbered where it applies
      const s = document.getElementById(it.slide_id || '');
      if (!s || !it.rect) return;
      const m = el('div', 'ppt-abs ppt-mark ppt-pending', marks);
      place(m, G.slideToClient(s.getBoundingClientRect(), it.rect));
      el('b', null, m, `${i < 20 ? String.fromCharCode(0x2460 + i) : `(${i + 1})`} 待发`);
    });
```

并把气泡里的 `enqueue({ type: 'answer', re: rootId, …` 改为 `enqueue({ type: 'answer', re: root.parent || rootId, …`。
g. keydown 里 `e.target.closest('.ppt-kb')` 已覆盖 `.ppt-batch`（同时带两个 class），无需改。

- [ ] **Step 5: `toolbar.js`、`editor.css`、`server.py`**
- toolbar：`btn(top, '📚 知识库', …)` 之后加 `const batchBtn = btn(top, '📝 清单', '打开待发清单', () => cb.batch()); batchBtn.hidden = true;`；返回对象加 `setBatchCount(n) { batchBtn.hidden = !n; batchBtn.textContent = \`📝 清单 (${n})\`; },`。
- css 末尾：

```css
.ppt-mark.ppt-pending { border: 2px dashed #7c3aed; } .ppt-mark.ppt-pending b { background: #7c3aed; }
.ppt-pop .ppt-row { justify-content: flex-end; margin: 6px 0 0; }
.ppt-batch-note { width: 100%; min-height: 56px; box-sizing: border-box; margin-bottom: 6px; }
.ppt-batch-shot { display: block; max-width: 100%; max-height: 120px; margin: 4px 0; border: 1px solid #e5e7eb; border-radius: 4px; }
.ppt-batch .ppt-kb-item textarea { width: 100%; min-height: 48px; box-sizing: border-box; }
```

- server INJECT：`'<script src="/_ppt/kb-panel.js" data-ppt></script>'` 之后加 `'<script src="/_ppt/batch-panel.js" data-ppt></script>'`。

- [ ] **Step 6: 运行，确认通过** — e2e 全过（156：145 + 11）；server、selftest 照旧
- [ ] **Step 7: 提交** `feat(batch): 待发清单 — Ctrl+Enter/加入清单, numbered marks, list panel, send all as one batch`

---

### Task 4: 导入（页面）

**Files:** Modify `ppt/toolbar.js`、`ppt/editor.js`、`ppt/editor.css`；Test `tests/e2e.mjs`

**Interfaces:** 顶栏按钮标题 `导入以前做过的 HTML`；对话框 class `ppt-icons ppt-import`，里面 `select[title="放到哪"]`、`input[type=file]`、网址框 placeholder 以 `或粘贴网页网址` 开头、按钮标题 `导入这个网页`；toolbar 回调 `cb.importFile(file, mode)`、`cb.importUrl(url, mode)`、`cb.importMode()`；toast 支持链接 `toast(msg, text, href)`，链接文字"打开原稿"。

- [ ] **Step 1: 写失败的 e2e 测试**

```js
  // ---- 5: import ----
  await open(url); await ev(`scrollTo(0, 0)`); await sleep(300);
  const revealPath = path.join(SCRATCH, '旧稿.html');
  fs.writeFileSync(revealPath, '<html><body><div class="reveal"><div class="slides"><section><h1>导入测试</h1></section><section>二</section></div></div><script>localStorage.setItem("stolen", "1")</script></body></html>');
  b9 = await byTitle('导入以前做过的 HTML'); await click(b9.x, b9.y); await sleep(400);
  check('I2 the dialog suggests appending to a deck that is not empty', (await ev(`document.querySelector('.ppt-import select[title="放到哪"]').value`)) === 'append');
  { const d = await send('DOM.getDocument'); const q = await send('DOM.querySelector', { nodeId: d.result.root.nodeId, selector: '.ppt-import input[type=file]' }); await send('DOM.setFileInputFiles', { files: [revealPath], nodeId: q.result.nodeId }); }
  await sleep(2500);
  const ie = inbox().at(-1);
  check('I2 file import: event with hint, stored original', ie?.type === 'import' && ie.kind === 'file' && ie.mode === 'append' && ie.hint === 'slides' && fs.existsSync(ie.source)
    && ((await ev(`[...document.querySelectorAll('.ppt-toast')].map((t) => t.textContent).join()`)) || '').includes('已提交导入'), JSON.stringify(ie));
  await send('Page.navigate', { url: new URL(encodeURI(ie.original), url).href }); await sleep(1500);
  check('I2 original opens sandboxed: its script cannot touch our storage', (await ev(`document.body.textContent`)).includes('导入测试') && (await ev(`(() => { try { return localStorage.getItem('stolen'); } catch { return 'blocked'; } })()`)) !== '1');
  await open(url); await sleep(500);
  b9 = await byTitle('导入以前做过的 HTML'); await click(b9.x, b9.y); await sleep(400);
  const iu = await rectOf('.ppt-import input[placeholder^="或粘贴网页网址"]'); await click(iu.x, iu.y); await type('https://example.com/report'); await enter(); await sleep(2000);
  check('I2 url import event', inbox().at(-1)?.type === 'import' && inbox().at(-1).kind === 'url' && inbox().at(-1).source === 'https://example.com/report');
  py('--reply', 'decks/e2e-smoke', ie.id, '导入了 2 页，动画没有保留'); await sleep(3000);
  check('I2 Claude\'s reply pops up with a link to the original', ((await ev(`[...document.querySelectorAll('.ppt-toast')].map((t) => t.textContent).join()`)) || '').includes('导入了 2 页')
    && (await ev(`[...document.querySelectorAll('.ppt-toast a')].some((a) => a.textContent === '打开原稿' && decodeURI(a.getAttribute('href')) === ${JSON.stringify(ie.original)})`)));
  await open(url); await sleep(2000);
  check('I2 the reply pops up only once', !((await ev(`[...document.querySelectorAll('.ppt-toast')].map((t) => t.textContent).join()`)) || '').includes('导入了 2 页'));
```

- [ ] **Step 2: 运行，确认失败**

- [ ] **Step 3: toolbar**：`batchBtn` 那行之前加 `const importBtn = btn(top, '导入', '导入以前做过的 HTML', () => openImport(importBtn));`；在图标面板 `const popups = [pop, menu, icons];` 之前加：

```js
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
```

并把 `const popups = [pop, menu, icons];` 改为 `const popups = [pop, menu, icons, imp];`。

- [ ] **Step 4: editor**
a. 工具栏回调加 `importFile, importUrl, importMode,`。
b. `toast(msg, text)` 改为 `toast(msg, text, href)`，在 `el('p', null, t, msg);` 之后加 `if (href) { const a = el('a', null, t, '打开原稿'); a.href = encodeURI(href); a.target = '_blank'; a.rel = 'noopener'; }`。
c. `askWithKb` 之前加：

```js
  // ---- import an old html / zip / web page: Claude converts it; its reply pops up once ----
  function importMode() { // an untouched template deck gets replaced, anything else gets the import appended
    const ss = slides();
    return ss.length === 1 && ss[0].querySelectorAll('.block').length <= 2 && (document.getElementById('b-cover-title')?.textContent || '').trim() === '标题' ? 'replace' : 'append';
  }
  async function importFile(f, mode) {
    if (!/\.(html?|zip)$/i.test(f.name)) return toast('只能导入 .html、.htm 或 .zip');
    if (f.size > 50 * 1024 * 1024) return toast('文件超过 50MB');
    try {
      const r = await fetch(api('/api/import') + `&mode=${mode}&name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || String(r.status));
      toast('已提交导入，等 Claude 转换');
    } catch (e) { toast(`没有导入：${e.message}`); }
  }
  async function importUrl(u, mode) {
    try {
      const r = await fetch(api('/api/import/url'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: u, mode }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || String(r.status));
      toast('已提交导入，等 Claude 转换');
    } catch (e) { toast(`没有导入：${e.message}`); }
  }
  function announceImports() {
    const seen = new Set(ls.get('ppt-import-seen', []));
    let changed = false;
    for (const e of state?.events || []) {
      if (e.type !== 'import' || e.status !== 'done' || !e.reply || seen.has(e.id)) continue;
      seen.add(e.id); changed = true;
      toast(`导入完成：${e.reply}`, null, e.original);
    }
    if (changed) ls.set('ppt-import-seen', [...seen]);
  }
```

d. `poll()` 里 `state = await r.json(); offline = false; online = state.online;` 之后加 `announceImports();`。

- [ ] **Step 5: css** 末尾加 `.ppt-toast a { display: inline-block; margin-top: 4px; color: #2563eb; }`

- [ ] **Step 6: 运行，确认通过** — e2e 全过（162：156 + 6）；server、selftest 照旧
- [ ] **Step 7: 提交** `feat(import): 导入 dialog — html/zip/url, default mode, Claude's reply pops up once with the original`

---

### Task 5: `ppt.md` 规则与真实会话验收

- [ ] **Step 1: `ppt.md`**：处理事件一节"先标记"那条改为"处理 intent / answer / lint / kb / import 之前先标记"；`intent 带 kb` 之后加：

```markdown
- **intent 且 `kind` 为 `batch`**：用户攒了一张清单一起发。`items` 每条是一个普通意图（字段同上，`shot` 是这条的截图，草图条目带 `notes`）；`text` 是总体说明。先把全部条目和总体说明读完、截图都看完，整体规划后再改；条目之间冲突时以总体说明为准；看不懂就问。只回执一次，按编号逐条说明（"1. … 2. …"）。
- **import 事件**：把以前的 HTML 转成本 deck 的格式，尽量还原原样。`kind:file` 读 `source`（入口 HTML，同目录 `dir` 里有它的图片和样式）；`kind:url` 用 WebFetch 读网页。需要看原稿样子时用 Edge 无头截图：`"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --screenshot=<png> --window-size=1280,720 "<file:///… 或网址>"`，再用 Read 看。按 `hint` 转换：
  - `ppt-maker`：直接复制各页，id 冲突换新 id；`mode:replace` 时连 `#theme` 一起沿用。
  - `slides`：原来一页对一页，内容、布局、配色、字体尽量保持；布局对齐到 16×9 网格；颜色、字体写进 `#theme`；原有图表与 SVG 保留。
  - `page`（网址也按这类）：按标题拆页（封面 + 每个章节一页），沿用原配色。
  - 图片：`dir` 里的复制到本 deck 的 `assets/`；网上的下载到 `assets/`（失败就放占位框）。去掉脚本、动画、`on*` 属性、外部字体和脚本链接。
  - `mode:replace`：保留 `#base`，换掉全部页面；`mode:append`：加在最后一页之后。每页、每块都按格式规则写 id 和 grid-area。
  - 回执：导入了几页、哪些没能还原。识别不出内容或网址打不开：不改 deck，回执说明。
- 用户在终端说"把 X 导入进来"：`python ppt/server.py --import "decks/<名字>" "<路径或网址>" [append|replace]`，它会记一条 import 事件，照上面处理。
```

- [ ] **Step 2: 全套测试并提交** `docs: ppt.md rules for batch intents and HTML import`

- [ ] **Step 3: 真实会话验收**（scratchpad 临时项目，验完删除）
1. 建 `accproj/decks/验收-5/deck.html`（模板），后台起服务（`PPT_HOME_DIR` 指向 scratchpad），Monitor 挂 `--tail`。
2. 导入一份 reveal.js 风格的 3 页 HTML（带配色、一张图），选"替换"；Claude 按规则转换并回执；检查页数、配色进了 `#theme`、图片在 `assets/`、没有 `<script>`。
3. 用清单一次提交 3 处修改（两页 + 总体说明）；Claude 一次回执，逐条说明。
4. 网址导入 `https://example.com`（追加）；Claude 回执。
5. 停服务与监听，删除临时目录。
