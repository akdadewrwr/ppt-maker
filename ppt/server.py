#!/usr/bin/env python3
"""ppt-maker local server (stdlib only).

  python ppt/server.py <deck_dir> [--port 8765] [--no-open]    serve deck + editor layer
  python ppt/server.py --tail <deck_dir>                        print pending/new events, one line each
  python ppt/server.py --reply <deck_dir> <event_id> [text] [--ack]
"""
import argparse, base64, hashlib, json, mimetypes, secrets, sys, threading, time, webbrowser
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

HERE = Path(__file__).resolve().parent
MAX_BODY = 10 * 1024 * 1024
MAX_SHOT = 5 * 1024 * 1024
MAX_TEXT = 4000
EVENT_TYPES = {"intent", "answer", "lint"}  # need a reply; "edit" is notify-only
FIELD_TYPES = {"type": str, "kind": str, "re": str, "slide": int, "slide_id": str, "rect": dict, "cells": str,
               "blocks": list, "text": str, "issues": list, "quote": dict}
HEARTBEAT_SECS = 10
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
    """Whitelist fields from a page-posted event; returns (event, png_bytes|None)."""
    if not isinstance(body, dict) or body.get("type") not in EVENT_TYPES:
        raise ValueError("bad type")
    ev = {k: body[k] for k in FIELD_TYPES if k in body and body[k] is not None}
    bad = [k for k, t in FIELD_TYPES.items() if k in ev and not isinstance(ev[k], t)]
    if bad or not all(isinstance(b, str) for b in ev.get("blocks", [])):
        raise ValueError(f"bad field types: {bad or ['blocks']}")
    q = ev.get("quote")
    if q is not None and not (isinstance(q.get("text"), str) and q["text"] and len(q["text"]) <= MAX_TEXT
                              and all(isinstance(q.get(k, ""), str) for k in ("before", "after"))):
        raise ValueError("bad quote")
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


def summary(e):
    blocks = e.get("blocks") or ([e["block"]] if e.get("block") else [])
    text = e.get("text") or e.get("label") or (json.dumps(e["issues"], ensure_ascii=False) if e.get("issues") else "")
    re_ = f" re:{e['re']}" if e.get("re") else ""
    quote = f" quote:「{e['quote']['text'][:20]}」" if e.get("quote") else ""
    kind = f" kind:{e['kind']}" if e.get("kind") else ""
    line = f"{e['id']} {e['type']}{kind}{re_} slide:{e.get('slide_id') or '-'} [{','.join(blocks)}]{quote} {text[:60]}"
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
    for e in events:
        if e.get("type") in EVENT_TYPES and st.get(e.get("id")) != "done":
            emit(safe_summary(e))
    seen, beat = len(events), 0.0
    while not stop():
        if time.time() - beat >= HEARTBEAT_SECS:
            hb.write_text(now_iso(), encoding="utf-8")
            beat = time.time()
        events = read_jsonl(inbox)
        for e in events[seen:]:
            emit(safe_summary(e))
        seen = len(events)
        time.sleep(interval)


def reply(deck, eid, text="", ack=False):
    append_jsonl(runtime(deck) / "outbox.jsonl", {"re": eid, "text": text, "ack": ack, "ts": now_iso()})


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
        if self.command in ("POST", "PUT"):
            # read the body before any reply: closing with unread bytes makes Windows reset the
            # socket, and the client never sees our 403/404
            n = int(self.headers.get("Content-Length") or 0)
            self.too_large = n > MAX_BODY
            self.body = self.rfile.read(n) if 0 < n <= MAX_BODY else b""
            if self.too_large and n <= 4 * MAX_BODY:  # ponytail: bigger than 4x just gets the socket reset
                drain(self.rfile, n)  # discarded in chunks, never held: the 413 still reaches the client
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
            inj = INJECT % (json.dumps(self.server.token), json.dumps(ver), ICONS_JS if (HERE / "icons.js").is_file() else "")
            i = html.lower().rfind("</body>")
            html = html[:i] + inj + html[i:] if i >= 0 else html + inj
            return self.send(200, html, "text/html; charset=utf-8")
        if path == "/api/state":
            return self.send(200, {**state(deck), "history": self.server.history.info()})
        if path == "/api/deck":  # raw file text: the page saves edits into this, not into the live DOM
            with LOCK:
                return self.send(200, {"version": deck_version(deck), "html": (deck / "deck.html").read_text(encoding="utf-8")})
        if path.startswith("/_ppt/"):
            root, f = HERE, safe_path(HERE, path[len("/_ppt/"):])
        else:
            root, f = deck, safe_path(deck, path)
        if not f or (root == deck and ".ppt" in f.relative_to(deck.resolve()).parts):
            return self.send(404, {"error": "not found"})
        self.send(200, f.read_bytes(), mimetypes.guess_type(f.name)[0] or "application/octet-stream")

    def read_json(self):
        if self.too_large:
            raise ValueError("body too large")
        return json.loads(self.body or b"null")

    def do_POST(self):
        url = self.guard(need_token=True)
        if not url:
            return
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
    a = ap.parse_args(argv)
    deck = Path(a.deck).resolve()
    if not (deck / "deck.html").is_file():
        ap.error(f"{deck / 'deck.html'} not found")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if a.reply:
        if not a.rest:
            ap.error("--reply needs an event id")
        return reply(deck, a.rest[0], " ".join(a.rest[1:]), a.ack)
    if a.tail:
        return tail(deck, lambda s: print(s, flush=True))
    srv = make_server(deck, a.port)
    url = f"http://127.0.0.1:{srv.server_address[1]}/?t={srv.token}"
    print(f"ppt-maker serving {deck.name} at {url}", flush=True)
    if not a.no_open:
        webbrowser.open(url)
    srv.serve_forever()


if __name__ == "__main__":
    main()
