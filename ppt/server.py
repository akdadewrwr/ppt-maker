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
