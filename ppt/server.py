#!/usr/bin/env python3
"""ppt-maker local server (stdlib only).

  python ppt/server.py <deck_dir> [--port 8765] [--no-open]    serve deck + editor layer
  python ppt/server.py --tail <deck_dir>                        print pending/new events, one line each
  python ppt/server.py --reply <deck_dir> <event_id> [text] [--ack]
"""
import argparse, base64, hashlib, http.client, json, mimetypes, os, re, secrets, signal, subprocess, sys, threading, time, webbrowser
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

import exporter
import importer
import kb

HERE = Path(__file__).resolve().parent
MAX_BODY = 10 * 1024 * 1024
MAX_SHOT = 5 * 1024 * 1024
DRAIN_MAX = 256 * 1024 * 1024  # read off (never store) an upload we refuse, up to this size
MAX_TEXT = 4000
MAX_NOTES = 50
MAX_NOTE = 200
MAX_ITEMS = 30  # intents in one batch
STREAMED = ("/api/kb/file", "/api/import", "/api/export")
MAX_EXPORT = 50 * 1024 * 1024
ITEM_FIELDS = {"slide", "slide_id", "rect", "cells", "blocks", "text", "shot", "kind", "notes", "quote", "kb"}  # uploads written to disk as they arrive
EVENT_TYPES = {"intent", "answer", "lint"}  # need a reply; "edit" is notify-only
REPLY_TYPES = EVENT_TYPES | {"kb", "import"}  # kb events are written by the server, not posted by the page
FIELD_TYPES = {"type": str, "kind": str, "re": str, "slide": int, "slide_id": str, "rect": dict, "cells": str,
               "blocks": list, "text": str, "issues": list, "quote": dict, "notes": list, "kb": list, "items": list}
HEARTBEAT_SECS = 10
IDLE_SECS = 2 * 3600  # a server nobody has visited for this long exits on its own
SERVER_CHECK_SECS = 5
RECENT_DONE = 10
STOPPED = "服务已停止：重新运行 --detach 启动，再把网址告诉用户"
ONLINE_SECS = 30
HISTORY_MAX = 200
WATCH_SECS = 0.5
LOCK = threading.Lock()
INJECT = ('<link rel="stylesheet" href="/_ppt/editor.css" data-ppt>'
          '<script data-ppt>window.PPT={token:%s,version:%s}</script>'
          '<script src="/_ppt/vendor/html-to-image.js" data-ppt></script>'
          '<script src="/_ppt/geom.js" data-ppt></script>'
          '<script src="/_ppt/ops.js" data-ppt></script>'
          '%s'
          '<script src="/_ppt/icons-zh.js" data-ppt></script>'
          '<script src="/_ppt/sketch.js" data-ppt></script>'
          '<script src="/_ppt/kb-panel.js" data-ppt></script>'
          '<script src="/_ppt/batch-panel.js" data-ppt></script>'
          '<script src="/_ppt/toolbar.js" data-ppt></script>'
          '<script src="/_ppt/editor.js" data-ppt></script>')
ICONS_JS = '<script src="/_ppt/icons.js" data-ppt></script>'
ASSET_MAGIC = ((b"\x89PNG\r\n\x1a\n", "png"), (b"\xff\xd8\xff", "jpg"), (b"GIF87a", "gif"), (b"GIF89a", "gif"))


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
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():  # another process may be mid-append
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


def drain(f, n, chunk=65536):
    """Read and discard n bytes, holding at most one chunk at a time."""
    while n > 0:
        got = f.read(min(n, chunk))
        if not got:
            break
        n -= len(got)


def sniff_image(data):
    """Extension for PNG/JPEG/GIF/WebP bytes, else None. SVG is refused on purpose: it can carry script."""
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return next((ext for magic, ext in ASSET_MAGIC if data.startswith(magic)), None)


def save_asset(deck, data):
    """Store an uploaded image as assets/<sha1[:12]>.<ext>; identical bytes reuse the same file."""
    ext = sniff_image(data)
    if not ext:
        raise ValueError("only PNG, JPEG, GIF or WebP images")
    d = Path(deck) / "assets"
    d.mkdir(exist_ok=True)
    name = f"{hashlib.sha1(data).hexdigest()[:12]}.{ext}"
    if not (d / name).exists():
        (d / name).write_bytes(data)
    return f"assets/{name}"


def clean_event(body):
    """Whitelist fields from a page-posted event; returns (event, png_bytes|None).
    A batch keeps its items, each checked like an intent; their screenshots ride along as "_shot" for add_event."""
    if not isinstance(body, dict) or body.get("type") not in EVENT_TYPES:
        raise ValueError("bad type")
    ev, shot = _fields(body)
    items = body.get("items")
    if ev.get("kind") == "batch":
        if body["type"] != "intent" or not isinstance(items, list) or not 0 < len(items) <= MAX_ITEMS:
            raise ValueError("bad items")
        ev["items"] = []
        for it in items:
            if not isinstance(it, dict) or set(it) - ITEM_FIELDS or it.get("kind") not in (None, "sketch"):
                raise ValueError("bad item")
            fields, item_shot = _fields(it)
            ev["items"].append({**fields, **({"_shot": item_shot} if item_shot else {})})
    elif items is not None:
        raise ValueError("items only belong to a batch")
    return ev, shot


def _fields(body):
    """One event's (or batch item's) whitelisted fields; returns (fields, png_bytes|None)."""
    ev = {k: body[k] for k in FIELD_TYPES if k in body and body[k] is not None and k != "items"}
    bad = [k for k, t in FIELD_TYPES.items() if k in ev and not isinstance(ev[k], t)]
    if bad or not all(isinstance(b, str) for b in ev.get("blocks", [])):
        raise ValueError(f"bad field types: {bad or ['blocks']}")
    notes = ev.get("notes")
    if notes is not None and (len(notes) > MAX_NOTES or not all(isinstance(n, str) and len(n) <= MAX_NOTE for n in notes)):
        raise ValueError("bad notes")
    refs = ev.get("kb")
    if refs is not None and (len(refs) > 20 or not all(isinstance(k, str) and len(k) <= 20 for k in refs)):
        raise ValueError("bad kb")
    q = ev.get("quote")
    if q is not None and not (isinstance(q.get("text"), str) and q["text"] and len(q["text"]) <= MAX_TEXT
                              and all(isinstance(q.get(k, ""), str) for k in ("before", "after"))):
        raise ValueError("bad quote")
    if len(str(ev.get("text", ""))) > MAX_TEXT:
        raise ValueError("text too long")
    json.dumps(ev, ensure_ascii=False).encode("utf-8")  # a lone surrogate would fail later, in the inbox write
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
    if ev.get("items"):
        ev = {**ev, "items": [dict(it) for it in ev["items"]]}
        for i, it in enumerate(ev["items"], 1):
            png = it.pop("_shot", None)
            if png:
                (rt / "shots" / f"{eid}-{i}.png").write_bytes(png)
                it["shot"] = f".ppt/shots/{eid}-{i}.png"
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
    events, batches = [], {}
    try:
        html = (Path(deck) / "deck.html").read_text(encoding="utf-8", errors="replace")
    except OSError:
        html = ""
    for e in read_jsonl(rt / "inbox.jsonl"):
        t, status, reply = e.get("type"), st.get(e.get("id"), "queued"), replies.get(e.get("id"))
        if t == "intent" and e.get("kind") == "batch":  # one mark per item; the reply sits by the first one still on the deck
            items = e.get("items") or []
            anchor = next((i for i, it in enumerate(items, 1) if it.get("slide_id") and f'id="{it["slide_id"]}"' in html), 1)
            batches[e["id"]] = anchor
            for i, it in enumerate(items, 1):
                events.append({"id": f"{e['id']}-{i}", "type": "intent", "parent": e["id"], "re": None, "slide_id": it.get("slide_id"),
                               "rect": it.get("rect"), "text": it.get("text", ""), "status": status, "reply": reply if i == anchor else None})
        elif t in ("intent", "answer"):
            re_ = e.get("re")
            events.append({"id": e["id"], "type": t, "re": f"{re_}-{batches[re_]}" if re_ in batches else re_, "slide_id": e.get("slide_id"),
                           "rect": e.get("rect"), "text": e.get("text", ""), "status": status, "reply": reply})
        elif t == "import":
            events.append({"id": e["id"], "type": "import", "status": status, "reply": reply, "original": e.get("original")})
    return {"version": deck_version(deck),
            "online": hb.exists() and time.time() - hb.stat().st_mtime < ONLINE_SECS,
            "events": events}


def summary(e):
    blocks = e.get("blocks") or ([e["block"]] if e.get("block") else [])
    text = e.get("text") or e.get("label") or (json.dumps(e["issues"], ensure_ascii=False) if e.get("issues") else "")
    re_ = f" re:{e['re']}" if e.get("re") else ""
    quote = f" quote:「{e['quote']['text'][:20]}」" if e.get("quote") else ""
    notes = " notes:" + "".join(f"「{n[:10]}」" for n in e["notes"][:3]) if e.get("notes") else ""
    kind = f" kind:{e['kind']}" if e.get("kind") else ""
    kbs = f" kb:{','.join(e['kb'])}" if e.get("kb") else ""
    items = f" items:{len(e['items'])}" if e.get("items") else ""
    line = f"{e['id']} {e['type']}{kind}{re_} slide:{e.get('slide_id') or '-'} [{','.join(blocks)}]{quote}{notes}{kbs}{items} {text[:60]}"
    return " ".join(line.split())


def safe_summary(e):
    try:
        return summary(e)
    except Exception:  # one bad line must never stop the wake-up loop
        return f"{e.get('id')} {e.get('type')} (unreadable event, see .ppt/inbox.jsonl)"


def tail(deck, emit, stop=lambda: False, interval=0.5):
    """Emit every unfinished event, then follow the inbox. Heartbeat lets the page show 'Claude online'."""
    rt = runtime(deck)
    inbox, hb = rt / "inbox.jsonl", rt / "heartbeat"
    events, st = read_jsonl(inbox), statuses(deck)
    said = {r.get("re"): r.get("text", "") for r in outbox_rows(deck) if not r.get("ack")}
    for e in [e for e in events if e.get("type") in REPLY_TYPES and st.get(e.get("id")) == "done"][-RECENT_DONE:]:
        emit(f"最近完成 {safe_summary(e)} → {said.get(e.get('id'), '')[:120]}")  # context for a fresh session
    for e in events:
        if e.get("type") in REPLY_TYPES and st.get(e.get("id")) != "done":
            emit(safe_summary(e))
    up = server_up(deck)
    if up is False:
        emit(STOPPED)
    seen, beat, checked = len(events), 0.0, time.time()
    while not stop():
        if time.time() - beat >= HEARTBEAT_SECS:
            hb.write_text(now_iso(), encoding="utf-8")
            beat = time.time()
        if time.time() - checked >= SERVER_CHECK_SECS:
            now = server_up(deck)
            if up and not now:
                emit(STOPPED)
            up, checked = now, time.time()
        events = read_jsonl(inbox)
        for e in events[seen:]:
            emit(safe_summary(e))
        seen = len(events)
        time.sleep(interval)


def reply(deck, eid, text="", ack=False):
    append_jsonl(runtime(deck) / "outbox.jsonl", {"re": eid, "text": text, "ack": ack, "ts": now_iso()})


def outbox_rows(deck):
    return read_jsonl(runtime(deck) / "outbox.jsonl")


def claude_label(deck, since=0):
    """Name a Claude write after the event it acked or answered since the last snapshot (the reply can land
    before the watcher sees the write), else after the event still in progress."""
    recent = [r.get("re") for r in outbox_rows(deck)[since:] if r.get("re")]
    working = [i for i, s in statuses(deck).items() if s == "processing"]
    eid = recent[-1] if recent else working[-1] if working else None
    return f"Claude 处理 #{eid}" if eid else "Claude 修改"


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
        self.out_n = len(outbox_rows(self.deck))  # outbox rows already accounted for by a snapshot
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
        self.out_n = len(outbox_rows(self.deck))
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
            self.record("claude", claude_label(self.deck, self.out_n))

    def step(self, d):
        """Undo (d=-1) or redo (d=+1); returns the row undone/redone, or None."""
        self.sync()  # a Claude write the watcher has not seen yet must become its own step first
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


class Handler(BaseHTTPRequestHandler):
    timeout = 30  # a client that stalls mid-body frees its thread instead of hanging it forever

    def log_message(self, *args):
        pass

    def send(self, code, body=b"", ctype="application/json; charset=utf-8", headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")  # an uploaded image must never be sniffed into a page
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def guard(self, need_token):
        """Host check always (DNS rebinding); token for pages/APIs. Returns parsed URL or None."""
        self.stream_len = 0
        self.server.last_seen = time.time()
        if self.command in ("POST", "PUT"):
            # read the body before any reply: closing with unread bytes makes Windows reset the
            # socket, and the client never sees our 403/404
            n = int(self.headers.get("Content-Length") or 0)
            if self.command == "POST" and urlparse(self.path).path in STREAMED:  # streamed to disk by the handler, after the checks below
                self.body, self.too_large, self.stream_len = b"", False, n
            else:
                self.too_large = n > MAX_BODY
                self.body = self.rfile.read(n) if 0 < n <= MAX_BODY else b""
                if self.too_large and n <= 4 * MAX_BODY:  # ponytail: bigger than 4x just gets the socket reset
                    drain(self.rfile, n)  # discarded in chunks, never held: the 413 still reaches the client
        port = self.server.server_address[1]
        if self.headers.get("Host") not in (f"127.0.0.1:{port}", f"localhost:{port}"):
            self.discard_stream()
            self.send(403, {"error": "bad host"})
            return None
        url = urlparse(self.path)
        t = parse_qs(url.query).get("t", [""])[0]
        if need_token and not secrets.compare_digest(t.encode(), self.server.token.encode()):
            self.discard_stream()
            self.send(403, {"error": "bad token"})
            return None
        return url

    def discard_stream(self):
        """A streamed upload we will not take: read it off the socket so the reply arrives."""
        if self.stream_len and self.stream_len <= DRAIN_MAX:
            drain(self.rfile, self.stream_len)
        self.stream_len = 0

    def export_post(self):
        deck = self.server.deck
        if self.stream_len > MAX_EXPORT:
            self.discard_stream()
            return self.send(413, {"error": "导出数据超过 50MB（图片太多），请减少图片后再试"})
        try:
            raw = self.rfile.read(self.stream_len) if self.stream_len else b""
            self.stream_len = 0
            data = json.loads(raw or b"null")
            if not isinstance(data, dict) or not isinstance(data.get("slides"), list):
                raise ValueError("导出数据格式不对")
            out = deck / "export" / f"{deck.name}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.pptx"
            out.parent.mkdir(exist_ok=True)
            rep = exporter.build(data, out)  # outside LOCK: can take seconds
            res = {"file": str(out.resolve()), "url": "/export/" + quote(out.name), "summary": exporter.summary(rep), "report": rep}
            (runtime(deck) / "export.json").write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")
            return self.send(200, res)
        except exporter.Missing as e:
            return self.send(503, {"error": str(e)})
        except (ValueError, KeyError, TypeError) as e:
            return self.send(400, {"error": f"导出失败：{e}"})
        except OSError as e:
            return self.send(503, {"error": f"导出时写不进磁盘：{e}"})

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

    def kb_post(self, url):
        deck, q = self.server.deck, parse_qs(url.query)
        arg = lambda k: q.get(k, [""])[0]
        try:
            if url.path == "/api/kb/file":
                if self.stream_len > kb.MAX_FILE:
                    self.discard_stream()
                    return self.send(413, {"error": "文件超过 50MB"})
                scope = arg("scope")
                try:  # refuse before taking any bytes, then drain them so the client gets the answer
                    kb.check_file(arg("name"), arg("type"), arg("kind") or None)
                    r = kb.root(deck, scope)
                    kb.load(r)
                except (ValueError, kb.BadIndex):
                    self.discard_stream()
                    raise
                # the slow part (network, disk, Office text) runs outside LOCK: saves and polls carry on meanwhile
                up = kb.receive(r, self.rfile, self.stream_len, arg("name"), arg("type"), arg("kind") or None)
                self.stream_len = 0
                with LOCK:
                    item, created = kb.commit_file(r, up)
                    if created:
                        add_event(deck, kb.digest_event(deck, scope, item))
                return self.send(200, {"item": item, "created": created})
            with LOCK:
                body = self.read_json()
                if not isinstance(body, dict):
                    raise ValueError("bad body")
                scope = body.get("scope", "project")
                r = kb.root(deck, scope)
                if url.path == "/api/kb/add":
                    item, created = (kb.add_deck(r, kb.project_dir(deck) / "decks" / kb.safe_name(body["deck"])) if body.get("deck")
                                     else kb.add_url(r, body.get("url", ""), body.get("type"), body.get("kind")))
                elif url.path == "/api/kb/remove":
                    return self.send(200, {"item": kb.remove(r, str(body.get("id")))})
                elif url.path == "/api/kb/redigest":
                    kb.digest_event(deck, scope, kb.get(r, str(body.get("id"))))  # refuse first: nothing changes on a bad entry
                    item, created = kb.update(r, str(body.get("id")), status="pending", note=""), True
                elif url.path == "/api/kb/skill":
                    text = str(body.get("text", "")).strip()
                    if not text or len(text) > MAX_TEXT:
                        raise ValueError("请描述这个 Skill")
                    ev = add_event(deck, {"type": "kb", "kind": "skill", "scope": scope, "text": text, "dir": str(kb.skills_root(deck, scope))})
                    return self.send(200, {"id": ev["id"]})
                else:
                    return self.send(404, {"error": "not found"})
                if created:
                    add_event(deck, kb.digest_event(deck, scope, item))
                return self.send(200, {"item": item, "created": created})
        except kb.BadIndex as e:
            return self.send(409, {"error": str(e)})
        except ValueError as e:
            return self.send(400, {"error": str(e)})
        except OSError as e:  # index.json busy (Windows) or disk trouble: say so instead of dropping the connection
            return self.send(503, {"error": f"知识库暂时写不进去：{e}"})

    def do_GET(self):
        path = urlparse(self.path).path
        url = self.guard(need_token=path == "/" or path.startswith("/api/"))
        if not url:
            return
        deck = self.server.deck
        if path == "/":
            ver = deck_version(deck)  # read version first: a racing write only causes one extra reload
            html = (deck / "deck.html").read_text(encoding="utf-8")
            inj = INJECT % (json.dumps(self.server.token), json.dumps(ver), ICONS_JS if (HERE / "icons.js").is_file() else "")
            i = html.lower().rfind("</body>")
            html = html[:i] + inj + html[i:] if i >= 0 else html + inj
            # a <base> copied in from an import must not redirect the editor's own /_ppt/ scripts
            return self.send(200, html, "text/html; charset=utf-8", {"Content-Security-Policy": "base-uri 'none'"})
        if path == "/api/state":
            return self.send(200, {**state(deck), "history": self.server.history.info()})
        if path == "/api/kb":
            with LOCK:
                return self.send(200, kb.state(deck))
        if path == "/api/kb/card":
            q = parse_qs(url.query)
            try:
                return self.send(200, {"text": kb.card(deck, q.get("scope", [""])[0], q.get("id", [""])[0])})
            except (ValueError, OSError) as e:
                return self.send(404, {"error": str(e)})
        if path == "/api/deck":  # raw file text: the page saves edits into this, not into the live DOM
            with LOCK:
                return self.send(200, {"version": deck_version(deck), "html": (deck / "deck.html").read_text(encoding="utf-8")})
        if path.startswith("/_ppt/"):
            root, f = HERE, safe_path(HERE, path[len("/_ppt/"):])
        else:
            root, f = deck, safe_path(deck, path)
        if not f or (root == deck and ".ppt" in f.relative_to(deck.resolve()).parts):
            return self.send(404, {"error": "not found"})
        rel = f.relative_to(deck.resolve()).parts if root == deck else ()
        # nothing served from the deck folder (imports, assets, anything Claude copied) ever runs as the editor
        sandbox = {"Content-Security-Policy": "sandbox"} if root == deck else None
        data, ctype = f.read_bytes(), mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        if ctype == "text/html" and not re.search(rb"<meta[^>]+charset", data[:65536], re.I):
            ctype = "text/html; charset=utf-8"  # an html that never says its encoding is almost always utf-8
        if rel[:1] == ("export",):  # an exported pptx downloads under its own (often Chinese) name
            sandbox = {**(sandbox or {}), "Content-Disposition": "attachment; filename*=UTF-8''" + quote(f.name)}
        self.send(200, data, ctype, sandbox)

    def read_json(self):
        if self.too_large:
            raise ValueError("body too large")
        return json.loads(self.body or b"null")

    def do_POST(self):
        url = self.guard(need_token=True)
        if not url:
            return
        if url.path == "/api/export":
            return self.export_post()
        if url.path in ("/api/import", "/api/import/url"):
            return self.import_post(url)
        if url.path.startswith("/api/kb/"):
            return self.kb_post(url)
        if url.path == "/api/asset":
            if self.too_large:
                return self.send(413, {"error": "image larger than 10MB"})
            try:
                return self.send(200, {"src": save_asset(self.server.deck, self.body)})
            except ValueError as e:
                return self.send(415, {"error": str(e)})
        if url.path in ("/api/undo", "/api/redo"):
            kind = url.path[len("/api/"):]
            with LOCK:
                row = self.server.history.step(-1 if kind == "undo" else 1)
                if not row:
                    return self.send(409, {"error": f"nothing to {kind}"})
                verb = "撤销了" if kind == "undo" else "重做了"
                add_event(self.server.deck, {"type": "edit", "op": kind, "label": f"{verb} {row['label']}"})
                return self.send(200, {"version": deck_version(self.server.deck)})
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
        if url.path == "/api/kb/skills":
            try:
                body = self.read_json()
                kb.set_selection(self.server.deck, body.get("skills") if isinstance(body, dict) else None)
            except ValueError as e:
                return self.send(400, {"error": str(e)})
            return self.send(200, {"enabled": kb.selection(self.server.deck)})
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
            self.server.history.sync()  # record a not-yet-seen Claude write before the user's snapshot
            cur = deck_version(deck)
            if ver != cur:
                return self.send(409, {"version": cur})
            (deck / "deck.html").write_bytes(html.encode("utf-8"))
            new = deck_version(deck)
            label = str(body.get("label") or "编辑")[:200]
            self.server.history.record("user", label)
            add_event(deck, {"type": "edit", "slide_id": body.get("slide_id"), "block": body.get("block"), "label": label})
        self.send(200, {"version": new})


class Server(ThreadingHTTPServer):
    allow_reuse_address = False  # ponytail: on Windows reuse lets two servers share one port
    daemon_threads = True

    def server_close(self):
        if hasattr(self, "stopped"):  # also called by socketserver when bind fails, before make_server set it
            self.stopped.set()
        super().server_close()


def ensure_deck(deck):
    """A missing deck is made from the template next to this file, in place: never copied from anywhere else."""
    f = Path(deck) / "deck.html"
    if f.exists():
        return False
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_bytes((Path(__file__).parent / "template.html").read_bytes())
    return True


def server_file(deck):
    return runtime(deck) / "server.json"


def live_server(deck):
    """The running server of this deck ({pid, port, url, token}), or None. Asks it, so a stale file never counts."""
    try:
        info = json.loads(server_file(deck).read_text(encoding="utf-8"))
        c = http.client.HTTPConnection("127.0.0.1", int(info["port"]), timeout=2)
        c.request("GET", f"/api/state?t={info['token']}", headers={"Host": f"127.0.0.1:{info['port']}"})
        ok = c.getresponse().status == 200
        c.close()
    except (OSError, ValueError, KeyError, TypeError, http.client.HTTPException):
        return None
    return info if ok else None


def server_up(deck):
    """None: no server recorded; True / False: recorded and answering / gone."""
    return None if not server_file(deck).exists() else live_server(deck) is not None


def detach(deck, port, open_browser):
    """Start the server as its own process (not a child Claude Code can reap), or reuse the one already running."""
    info = live_server(deck)
    if info:
        return print(f"ppt-maker 已在运行 {deck.name}: {info['url']}", flush=True)
    if ensure_deck(deck):
        print(f"已从模板新建 {deck / 'deck.html'}", flush=True)
    server_file(deck).unlink(missing_ok=True)
    cmd = [sys.executable, str(Path(__file__).resolve()), "--no-open", "--port", str(port), str(deck)]
    with (runtime(deck) / "server.log").open("ab") as log:
        opts = dict(stdin=subprocess.DEVNULL, stdout=log, stderr=log, close_fds=True)
        if os.name == "nt":
            flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
            try:  # also leave the job object of the shell that started us, when it allows that
                subprocess.Popen(cmd, creationflags=flags | subprocess.CREATE_BREAKAWAY_FROM_JOB, **opts)
            except OSError:
                subprocess.Popen(cmd, creationflags=flags, **opts)
        else:
            subprocess.Popen(cmd, start_new_session=True, **opts)
    for _ in range(60):
        info = live_server(deck)
        if info:
            break
        time.sleep(0.25)
    else:
        raise SystemExit(f"服务没能启动，见 {runtime(deck) / 'server.log'}")
    print(f"ppt-maker 新启动 {deck.name}: {info['url']}", flush=True)
    if open_browser:
        webbrowser.open(info["url"])


def stop_server(deck):
    info = live_server(deck)
    if info:
        os.kill(int(info["pid"]), signal.SIGTERM)  # Windows: TerminateProcess
        for _ in range(40):
            if not live_server(deck):
                break
            time.sleep(0.25)
    server_file(deck).unlink(missing_ok=True)
    print(f"{deck.name}: 服务已停止" if info else f"{deck.name}: 没有在运行的服务", flush=True)


def idle_exit(srv, idle):
    while not srv.stopped.wait(min(idle / 2, 30)):
        if time.time() - srv.last_seen > idle:
            srv.shutdown()
            return


def make_server(deck, port=8765, token=None, tries=20, idle=IDLE_SECS):
    for p in range(port, port + tries):
        try:
            srv = Server(("127.0.0.1", p), Handler)
            break
        except OSError:
            continue
    else:
        raise SystemExit(f"no free port in {port}-{port + tries - 1}")
    srv.deck = Path(deck).resolve()
    if not token:  # persisted so a restart keeps the URL and open tabs keep working
        tf = runtime(srv.deck) / "token"
        if not tf.exists():
            tf.write_text(secrets.token_urlsafe(16), encoding="utf-8")
        token = tf.read_text(encoding="utf-8").strip()
    srv.token = token
    srv.stopped = threading.Event()
    with LOCK:
        srv.history = History(srv.deck)
    threading.Thread(target=watch, args=(srv,), daemon=True).start()
    srv.last_seen = time.time()
    threading.Thread(target=idle_exit, args=(srv, idle), daemon=True).start()
    return srv


def main(argv=None):
    ap = argparse.ArgumentParser(description="ppt-maker local server")
    ap.add_argument("deck")
    ap.add_argument("rest", nargs="*", help="--reply: <event_id> [text]")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-open", action="store_true")
    ap.add_argument("--tail", action="store_true", help="print pending/new events (run under Claude Code Monitor)")
    ap.add_argument("--reply", action="store_true", help="write a reply: <deck> <event_id> [text]")
    ap.add_argument("--ack", action="store_true", help="with --reply: mark the event as being processed")
    ap.add_argument("--kb-done", action="store_true", help="mark a kb item digested: <deck> <scope> <id> <title> <summary>")
    ap.add_argument("--import", dest="import_src", action="store_true", help="import html: <deck> <path-or-url> [append|replace]")
    ap.add_argument("--kb-add", action="store_true", help="add to a kb: <deck> <scope> <file|web|ref> <path-or-url> [kind]")
    ap.add_argument("--kb-fail", action="store_true", help="mark a kb item failed: <deck> <scope> <id> <reason>")
    ap.add_argument("--detach", action="store_true", help="start the server as its own process, or reuse the running one")
    ap.add_argument("--stop", action="store_true", help="stop this deck's server")
    a = ap.parse_args(argv)
    deck = Path(a.deck).resolve()
    serving = not (a.tail or a.reply or a.import_src or a.kb_add or a.kb_done or a.kb_fail or a.stop)
    made = serving and ensure_deck(deck)  # only starting the server makes a deck; other commands need a real one
    if not (deck / "deck.html").is_file():
        ap.error(f"{deck / 'deck.html'} not found")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if a.stop:
        return stop_server(deck)
    if a.import_src:
        if not a.rest or (len(a.rest) > 1 and a.rest[1] not in importer.MODES):
            ap.error("--import needs <path-or-url> [append|replace]")
        src, mode = a.rest[0], (a.rest[1] if len(a.rest) > 1 else "append")
        if src.startswith(("http://", "https://")):
            fields = importer.url_event(src, mode)
        else:
            p = Path(src)
            with p.open("rb") as f:
                fields = importer.event(deck, *importer.save(deck, f, p.stat().st_size, p.name), mode, origin_dir=str(p.resolve().parent))
        with LOCK:
            ev = add_event(deck, fields)
        return print(summary(ev))
    if a.kb_add:  # Claude adds things it was given in the terminal through here, never by editing index.json
        if len(a.rest) < 3:
            ap.error("--kb-add needs <scope> <file|web|ref> <path-or-url> [kind]")
        scope, typ, src = a.rest[:3]
        kind = a.rest[3] if len(a.rest) > 3 else None
        r = kb.root(deck, scope)
        if src.startswith(("http://", "https://")):
            item, created = kb.add_url(r, src, typ, kind)
        elif typ == "ref" and kind == "deck" and Path(src).is_dir():
            item, created = kb.add_deck(r, src)
        else:
            p = Path(src)
            with p.open("rb") as f:
                item, created = kb.add_file(r, f, p.stat().st_size, p.name, typ, kind)
        return print(json.dumps({"created": created, **kb.digest_event(deck, scope, item)}, ensure_ascii=False))
    if a.kb_done or a.kb_fail:
        if len(a.rest) < (4 if a.kb_done else 3):
            ap.error("--kb-done needs <scope> <id> <title> <summary>; --kb-fail needs <scope> <id> <reason>")
        scope, item_id = a.rest[0], a.rest[1]
        fields = ({"status": "ready", "title": a.rest[2], "summary": " ".join(a.rest[3:]), "note": ""} if a.kb_done
                  else {"status": "failed", "note": " ".join(a.rest[2:])})
        kb.update(kb.root(deck, scope), item_id, **fields)
        return print(f"{item_id}: {fields['status']}")
    if a.reply:
        if not a.rest:
            ap.error("--reply needs an event id")
        return reply(deck, a.rest[0], " ".join(a.rest[1:]), a.ack)
    if a.tail:
        return tail(deck, lambda s: print(s, flush=True))
    if made:
        print(f"已从模板新建 {deck / 'deck.html'}", flush=True)
    if a.detach:
        return detach(deck, a.port, not a.no_open)
    srv = make_server(deck, a.port)
    url = f"http://127.0.0.1:{srv.server_address[1]}/?t={srv.token}"
    me = {"pid": os.getpid(), "port": srv.server_address[1], "url": url, "token": srv.token}
    server_file(deck).write_text(json.dumps(me), encoding="utf-8")
    print(f"ppt-maker serving {deck.name} at {url}", flush=True)
    if not a.no_open:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    finally:
        srv.server_close()
        try:
            if json.loads(server_file(deck).read_text(encoding="utf-8")).get("pid") == me["pid"]:
                server_file(deck).unlink()
        except (OSError, ValueError):
            pass


if __name__ == "__main__":
    main()
