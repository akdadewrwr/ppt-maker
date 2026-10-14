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
