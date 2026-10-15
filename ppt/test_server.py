import contextlib, http.client, io, json, os, shutil, socket, sys, tempfile, threading, unittest, zipfile
import time as _time
from pathlib import Path
from unittest import mock
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server
import kb
import importer

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import build_icons

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

    def test_nosniff(self):  # review M5: an uploaded "image" that is also HTML must never render as a page
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("GET", "/_ppt/template.html", headers={"Host": f"127.0.0.1:{self.port}"})
        r = c.getresponse()
        r.read()
        c.close()
        self.assertEqual(r.getheader("X-Content-Type-Options"), "nosniff")

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

    def test_rejected_write_still_answers_403(self):
        # unread request bodies make Windows reset the socket instead of delivering the 403
        # repro: body arrives after the server already answered and closed -> RST, client never sees the status
        def slow(method, path):
            body = b'{"type": "intent", "text": "x"}'
            s = socket.create_connection(("127.0.0.1", self.port), timeout=5)
            s.sendall(f"{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n"
                      f"Content-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n".encode())
            _time.sleep(0.3)
            try:
                s.sendall(body)
                _time.sleep(0.3)
                return int(s.recv(64).split()[1])
            except OSError as e:
                return repr(e)
            finally:
                s.close()
        self.assertEqual(slow("POST", "/api/event"), 403)
        self.assertEqual(slow("PUT", "/api/deck?t=no"), 403)
        self.assertEqual(slow("POST", "/api/nope?t=tok"), 404)

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



class ReviewFixTests(ServerCase):
    def test_wrong_field_types_rejected(self):  # I2
        for bad in ({"type": "intent", "blocks": [1]}, {"type": "intent", "text": 5},
                    {"type": "intent", "slide_id": ["x"]}, {"type": "lint", "issues": "x"}):
            self.assertEqual(self.req("POST", "/api/event?t=tok", bad)[0], 400, bad)

    def test_tail_survives_malformed_event(self):  # I2
        server.append_jsonl(server.runtime(self.deck) / "inbox.jsonl", {"id": "e1", "type": "intent", "blocks": [1], "text": 7})
        server.append_jsonl(server.runtime(self.deck) / "inbox.jsonl", {"id": "e2", "type": "intent", "text": "好"})
        lines = []
        server.tail(self.deck, lines.append, stop=lambda: True)
        self.assertEqual([l.split()[0] for l in lines], ["e1", "e2"])

    def test_read_jsonl_tolerates_torn_utf8(self):  # M1
        p = server.runtime(self.deck) / "inbox.jsonl"
        p.write_bytes('{"id": "e1", "type": "intent", "text": "好"}\n{"id": "e2", "text": "'.encode() + "中".encode()[:2])
        self.assertEqual([e["id"] for e in server.read_jsonl(p)], ["e1"])

    def test_token_persists_across_restarts(self):  # I2b
        a = server.make_server(self.deck, port=0)
        b = server.make_server(self.deck, port=0)
        try:
            self.assertEqual(a.token, b.token)
            self.assertEqual((self.deck / ".ppt" / "token").read_text(encoding="utf-8"), a.token)
        finally:
            a.server_close(); b.server_close()

    def test_get_raw_deck(self):  # I3: page rebuilds from the file text, not the live DOM
        status, body = self.req("GET", "/api/deck?t=tok")
        self.assertEqual(status, 200)
        d = json.loads(body)
        self.assertEqual(d["html"], (self.deck / "deck.html").read_text(encoding="utf-8"))
        self.assertEqual(d["version"], server.deck_version(self.deck))
        self.assertEqual(self.req("GET", "/api/deck")[0], 403)


class QuoteTests(ServerCase):
    def test_quote_intent_stored_without_shot(self):
        q = {"text": "副标题", "before": "", "after": ""}
        ev = {"type": "intent", "slide_id": "s-cover", "blocks": ["b-cover-sub"], "text": "更正式", "quote": q}
        self.assertEqual(self.req("POST", "/api/event?t=tok", ev)[0], 200)
        stored = inbox(self.deck)[-1]
        self.assertEqual(stored["quote"], q)
        self.assertNotIn("shot", stored)

    def test_bad_quote_rejected(self):
        for q in ("副标题", {"text": 5}, {"before": "x"}, {"text": "x" * 4001}):
            self.assertEqual(self.req("POST", "/api/event?t=tok", {"type": "intent", "quote": q})[0], 400, q)

    def test_summary_shows_quote(self):
        s = server.summary({"id": "e1", "type": "intent", "slide_id": "s1", "blocks": ["b"], "text": "改正式",
                            "quote": {"text": "在幻灯片上指给 agent 看，而不是说给它听"}})
        self.assertIn("quote:「在幻灯片上指给 agent 看，而不是", s)


PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\0" * 32


class AssetTests(ServerCase):
    def post_raw(self, path, data, ctype="image/png"):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("POST", path, data, {"Host": f"127.0.0.1:{self.port}", "Content-Type": ctype})
        r = c.getresponse()
        out = (r.status, r.read())
        c.close()
        return out

    def test_png_saved_by_content_hash_and_reused(self):
        status, body = self.post_raw("/api/asset?t=tok", PNG_BYTES)
        self.assertEqual(status, 200)
        src = json.loads(body)["src"]
        self.assertRegex(src, r"^assets/[0-9a-f]{12}\.png$")
        self.assertEqual((self.deck / src).read_bytes(), PNG_BYTES)
        self.assertEqual(json.loads(self.post_raw("/api/asset?t=tok", PNG_BYTES)[1])["src"], src)
        self.assertEqual(len(list((self.deck / "assets").iterdir())), 1)
        self.assertEqual(self.req("GET", "/" + src)[0], 200)  # the page loads it like any deck file

    def test_type_from_magic_bytes_not_header(self):
        for data, ext in ((b"\xff\xd8\xff\xe0" + b"0" * 20, "jpg"), (b"GIF89a" + b"0" * 20, "gif"),
                          (b"RIFF\0\0\0\0WEBPVP8 " + b"0" * 20, "webp")):
            status, body = self.post_raw("/api/asset?t=tok", data, "application/octet-stream")
            self.assertEqual((status, json.loads(body)["src"].rsplit(".", 1)[1]), (200, ext))

    def test_svg_and_junk_rejected(self):
        for data in (b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', b"hello", b""):
            self.assertEqual(self.post_raw("/api/asset?t=tok", data, "image/svg+xml")[0], 415)
        self.assertFalse((self.deck / "assets").exists())

    def test_needs_token(self):
        self.assertEqual(self.post_raw("/api/asset", PNG_BYTES)[0], 403)
        self.assertEqual(self.post_raw("/api/asset?t=bad", PNG_BYTES)[0], 403)

    def test_too_large(self):
        with mock.patch.object(server, "MAX_BODY", 16):
            self.assertEqual(self.post_raw("/api/asset?t=tok", PNG_BYTES)[0], 413)
        self.assertFalse((self.deck / "assets").exists())


class DrainTests(unittest.TestCase):
    def test_drain_discards_in_chunks(self):  # review M4: an oversized body must not be buffered whole
        reads = []

        class F(io.BytesIO):
            def read(self, n=-1):
                reads.append(n)
                return super().read(n)

        f = F(b"x" * 200_000)
        server.drain(f, 200_000)
        self.assertEqual((f.tell(), max(reads)), (200_000, 65536))


class SketchTests(ServerCase):
    def test_notes_kept_and_summarised(self):
        self.req("POST", "/api/event?t=tok", {"type": "intent", "kind": "sketch", "slide_id": "s-cover", "blocks": [],
                                              "text": "按草图修改这一页", "notes": ["标题", "这里放图表"]})
        e = inbox(self.deck)[-1]
        self.assertEqual(e["notes"], ["标题", "这里放图表"])
        self.assertIn("notes:「标题」「这里放图表」", server.summary(e))

    def test_bad_notes_rejected(self):
        for notes in (["ok", 5], ["x"] * 51, ["长" * 201], "标题"):
            self.assertEqual(self.req("POST", "/api/event?t=tok", {"type": "intent", "kind": "sketch", "text": "x", "notes": notes})[0], 400, notes)

    def test_unencodable_text_rejected_not_dropped(self):  # review I5: a lone surrogate jammed the page's event queue
        for body in (b'{"type": "intent", "text": "x", "notes": ["\\ud83d"]}', b'{"type": "intent", "text": "x\\ud83d"}'):
            c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
            c.request("POST", "/api/event?t=tok", body, {"Host": f"127.0.0.1:{self.port}", "Content-Type": "application/json"})
            r = c.getresponse()
            r.read()
            c.close()
            self.assertEqual(r.status, 400, body)

    def test_sketch_js_injected_before_toolbar(self):
        html = self.req("GET", "/?t=tok")[1].decode()
        at = [html.index(f"/_ppt/{n}") for n in ("icons-zh.js", "sketch.js", "toolbar.js")]
        self.assertEqual(at, sorted(at))


class DrawIconTests(ServerCase):
    def test_kind_kept_and_summarised(self):
        self.req("POST", "/api/event?t=tok", {"type": "intent", "kind": "draw-icon", "slide_id": "s-cover",
                                              "rect": {"x": 608, "y": 328, "w": 64, "h": 64}, "blocks": [], "text": "一只猫"})
        e = inbox(self.deck)[-1]
        self.assertEqual(e["kind"], "draw-icon")
        self.assertIn("intent kind:draw-icon slide:s-cover", server.summary(e))
        self.assertEqual(self.req("POST", "/api/event?t=tok", {"type": "intent", "kind": 5, "text": "x"})[0], 400)

    def test_icons_injected_between_ops_and_toolbar(self):
        html = self.req("GET", "/?t=tok")[1].decode()
        at = [html.index(f"/_ppt/{n}") for n in ("ops.js", "icons.js", "icons-zh.js", "toolbar.js", "editor.js")]
        self.assertEqual(at, sorted(at))

    def test_icons_js_optional(self):
        with mock.patch.object(server, "HERE", self.tmp):  # a checkout where build_icons.py was never run
            html = self.req("GET", "/?t=tok")[1].decode()
        self.assertNotIn("/_ppt/icons.js", html)
        self.assertIn("/_ppt/icons-zh.js", html)

    def test_template_has_object_rules(self):
        self.assertIn(".obj { position:absolute; box-sizing:border-box; }", TEMPLATE.read_text(encoding="utf-8"))


class HistoryTests(ServerCase):
    def put(self, html, label="改背景色"):
        ver = json.loads(self.req("GET", "/api/state?t=tok")[1])["version"]
        return self.req("PUT", "/api/deck?t=tok", {"version": ver, "html": html, "label": label})

    def deck_text(self):
        return (self.deck / "deck.html").read_text(encoding="utf-8")

    def test_claude_label_survives_a_fast_reply(self):  # Claude may reply before the 0.5 s watcher tick
        self.req("POST", "/api/event?t=tok", {"type": "intent", "slide_id": "s-cover", "text": "x"})
        server.reply(self.deck, "e1", ack=True)
        with server.LOCK:  # hold the watcher off so write + reply both land before the snapshot
            (self.deck / "deck.html").write_text(self.deck_text().replace("副标题", "CLAUDE"), encoding="utf-8")
            server.reply(self.deck, "e1", "改好了")
            self.srv.history.sync()
        self.assertEqual(self.srv.history.rows[-1]["label"], "Claude 处理 #e1")

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

    def test_undo_right_after_claude_write_keeps_it_recoverable(self):  # review C1
        a = self.deck_text()
        self.put(a.replace("副标题", "B"))
        b = self.deck_text()
        (self.deck / "deck.html").write_text(b.replace(">B<", ">CLAUDE<"), encoding="utf-8")
        self.assertEqual(self.req("POST", "/api/undo?t=tok", {})[0], 200)  # before the 0.5 s watcher tick
        self.assertEqual(self.deck_text(), b)
        self.assertEqual(inbox(self.deck)[-1]["label"], "撤销了 Claude 修改")
        self.req("POST", "/api/redo?t=tok", {})
        self.assertIn(">CLAUDE<", self.deck_text())

    def test_put_right_after_claude_write_gets_its_own_row(self):  # review C1
        (self.deck / "deck.html").write_text(self.deck_text().replace("副标题", "CLAUDE"), encoding="utf-8")
        self.put(self.deck_text().replace("CLAUDE", "USER"), "改字")
        rows = self.srv.history.rows
        self.assertEqual([(r["by"], r["label"]) for r in rows[-2:]], [("claude", "Claude 修改"), ("user", "改字")])

    def test_restart_keeps_position(self):
        a = self.deck_text()
        self.put(a.replace("副标题", "B"))
        self.req("POST", "/api/undo?t=tok", {})
        with server.LOCK:
            h2 = server.History(self.deck)
        self.assertEqual((h2.cur, len(h2.rows)), (self.srv.history.cur, len(self.srv.history.rows)))
        self.assertTrue(h2.info()["canRedo"])


class BuildIconsTests(unittest.TestCase):
    def test_build_from_package(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        pkg = tmp / "package"
        (pkg / "icons").mkdir(parents=True)
        (pkg / "icons" / "house.svg").write_text(
            '<!-- @license lucide-static v9.9.9 - ISC -->\n<svg\n  class="lucide lucide-house"\n  viewBox="0 0 24 24"\n>\n'
            '  <path d="M3 10a2 2 0 0 1 1 1" />\n  <circle cx="12" cy="12" r="3" />\n</svg>\n', encoding="utf-8")
        (pkg / "icons" / "no-tags.svg").write_text('<svg viewBox="0 0 24 24"><path d="M1 1h2"/></svg>', encoding="utf-8")
        (pkg / "tags.json").write_text('{"house": ["home", "living"]}', encoding="utf-8")
        (pkg / "package.json").write_text('{"version": "9.9.9"}', encoding="utf-8")
        (pkg / "LICENSE").write_text("ISC License", encoding="utf-8")
        self.assertEqual(build_icons.build(pkg, tmp / "icons.js", tmp / "LICENSE-lucide"), 2)
        js = (tmp / "icons.js").read_text(encoding="utf-8")
        self.assertIn("lucide-static 9.9.9", js.splitlines()[0])
        data = json.loads(js.split("window.PPTIcons = ", 1)[1].strip().rstrip(";"))
        self.assertEqual(data["house"], {"tags": "home living", "body": '<path d="M3 10a2 2 0 0 1 1 1"/><circle cx="12" cy="12" r="3"/>'})
        self.assertEqual(data["no-tags"]["tags"], "")
        self.assertEqual((tmp / "LICENSE-lucide").read_text(encoding="utf-8"), "ISC License")


def zip_bytes(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in files.items():
            z.writestr(name, data)
    return buf.getvalue()


W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
S_NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
DOCX = zip_bytes({"word/document.xml": f'<w:document {W_NS}><w:body><w:p><w:r><w:t>营收</w:t></w:r><w:r><w:t>12.3 亿</w:t></w:r></w:p>'
                                       f'<w:p><w:r><w:t>增长 18%</w:t></w:r></w:p></w:body></w:document>'})
_slide = lambda t: f'<p:sld xmlns:p="urn:p" {A_NS}><a:p><a:r><a:t>{t}</a:t></a:r></a:p></p:sld>'
PPTX = zip_bytes({"ppt/slides/slide2.xml": _slide("第二页"), "ppt/slides/slide10.xml": _slide("第十页"), "ppt/slides/slide1.xml": _slide("封面")})
XLSX = zip_bytes({"xl/workbook.xml": f'<workbook {S_NS}><sheets><sheet name="数据"/></sheets></workbook>',
                  "xl/sharedStrings.xml": f'<sst {S_NS}><si><t>地区</t></si><si><t>华东</t></si></sst>',
                  "xl/worksheets/sheet1.xml": f'<worksheet {S_NS}><sheetData><row><c t="s"><v>0</v></c><c><v>2024</v></c></row>'
                                              f'<row><c t="s"><v>1</v></c><c><v>12.3</v></c></row></sheetData></worksheet>'})


class KbCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.proj, self.home = self.tmp / "proj", self.tmp / "home"
        self.deck = self.proj / "decks" / "d1"
        self.deck.mkdir(parents=True)
        shutil.copy(TEMPLATE, self.deck / "deck.html")
        env = mock.patch.dict(os.environ, {"PPT_PROJECT_DIR": str(self.proj), "PPT_HOME_DIR": str(self.home)})
        env.start()
        self.addCleanup(env.stop)
        self.r = kb.root(self.deck, "project")


class KbModuleTests(KbCase):
    def test_roots_follow_the_overrides(self):
        self.assertEqual(kb.root(self.deck, "project"), self.proj / "kb")
        self.assertEqual(kb.root(self.deck, "global"), self.home / ".ppt-maker" / "kb")
        self.assertEqual(kb.skills_root(self.deck, "global"), self.home / ".claude" / "skills")
        with self.assertRaises(ValueError):
            kb.root(self.deck, "elsewhere")

    def test_extract_office(self):
        for name, data, want in (("a.docx", DOCX, "营收12.3 亿\n增长 18%"),
                                 ("b.pptx", PPTX, "## 第 1 页\n封面\n\n## 第 2 页\n第二页\n\n## 第 3 页\n第十页"),
                                 ("c.xlsx", XLSX, "## 工作表 数据\n地区\t2024\n华东\t12.3")):
            (self.tmp / name).write_bytes(data)
            self.assertEqual(kb.extract(self.tmp / name), want)

    def test_add_file_extracts_and_dedupes(self):
        item, created = kb.add_file(self.r, io.BytesIO(DOCX), len(DOCX), "报告 2025.docx", "file")
        self.assertTrue(created)
        self.assertRegex(item["id"], r"^k-[0-9a-z]{6}$")
        self.assertEqual((item["type"], item["title"], item["status"]), ("file", "报告 2025", "pending"))
        self.assertEqual((self.r / item["source"]).read_bytes(), DOCX)
        self.assertEqual((self.r / item["text"]).read_text(encoding="utf-8"), "营收12.3 亿\n增长 18%")
        again, created2 = kb.add_file(self.r, io.BytesIO(DOCX), len(DOCX), "另一个名字.docx", "file")
        self.assertEqual((again["id"], created2), (item["id"], False))
        self.assertEqual(len(kb.load(self.r)), 1)
        self.assertEqual(len(list((self.r / "files").glob("*.docx"))), 1)

    def test_add_file_validation(self):
        for name, typ, kind in (("x.exe", "file", None), ("a.png", "ref", None), ("a.png", "file", "visual"), ("a.png", "web", None)):
            with self.assertRaises(ValueError):
                kb.add_file(self.r, io.BytesIO(b"x"), 1, name, typ, kind)
        item, _ = kb.add_file(self.r, io.BytesIO(b"\x89PNG"), 4, "../../evil/截图.PNG", "ref", "visual")
        self.assertEqual((item["kind"], item["source"]), ("visual", f"refs/{item['id']}-截图.png"))
        with self.assertRaises(ValueError):  # the client sent fewer bytes than announced
            kb.add_file(self.r, io.BytesIO(b"abc"), 10, "a.md", "file")
        self.assertEqual(len(kb.load(self.r)), 1)

    def test_broken_office_file_is_kept_with_a_note(self):
        item, _ = kb.add_file(self.r, io.BytesIO(b"not a zip"), 9, "坏.docx", "file")
        self.assertIn("文字抽取失败", item["note"])
        self.assertNotIn("text", item)

    def test_add_url_and_deck(self):
        for url, typ, kind in (("ftp://x.com/a", "web", None), ("javascript:alert(1)", "web", None), ("https://x.com", "ref", "visual")):
            with self.assertRaises(ValueError):
                kb.add_url(self.r, url, typ, kind)
        a, c1 = kb.add_url(self.r, " https://example.com/r ", "web")
        b, c2 = kb.add_url(self.r, "https://example.com/r", "web")
        self.assertEqual((a["source"], c1, b["id"], c2), ("https://example.com/r", True, a["id"], False))
        cite, _ = kb.add_url(self.r, "https://example.com/r", "ref", "cite")  # same URL as a citation is a different entry
        self.assertNotEqual(cite["id"], a["id"])
        old = self.proj / "decks" / "old"
        old.mkdir()
        (old / "deck.html").write_text("<html></html>", encoding="utf-8")
        d, _ = kb.add_deck(self.r, old)
        self.assertEqual((d["type"], d["kind"], d["title"], d["source"]), ("ref", "deck", "old", str(old.resolve())))
        with self.assertRaises(ValueError):
            kb.add_deck(self.r, self.proj / "decks" / "nope")

    def test_update_and_remove_to_trash(self):
        item, _ = kb.add_file(self.r, io.BytesIO(b"# hi"), 4, "a.md", "file")
        (self.r / "cards").mkdir()
        (self.r / "cards" / f"{item['id']}.md").write_text("card", encoding="utf-8")
        self.assertEqual(kb.update(self.r, item["id"], status="ready", summary="s")["status"], "ready")
        kb.remove(self.r, item["id"])
        self.assertEqual(kb.load(self.r), [])
        trash = self.r / ".trash" / item["id"]
        self.assertEqual(sorted(p.name for p in trash.iterdir()), sorted([f"{item['id']}-a.md", f"{item['id']}.md", "item.json"]))
        with self.assertRaises(ValueError):
            kb.update(self.r, item["id"], status="ready")

    def test_remove_never_leaves_the_kb(self):
        outside = self.tmp / "keep.txt"
        outside.write_text("mine", encoding="utf-8")
        kb.save(self.r, [{"id": "k-aaaaaa", "type": "file", "title": "x", "source": "../../keep.txt", "status": "ready"}])
        kb.remove(self.r, "k-aaaaaa")
        self.assertEqual(outside.read_text(encoding="utf-8"), "mine")

    def test_save_is_atomic(self):
        kb.save(self.r, [{"id": "k-aaaaaa"}])
        kb.save(self.r, [{"id": "k-bbbbbb"}])
        self.assertEqual(kb.load(self.r), [{"id": "k-bbbbbb"}])
        self.assertEqual([p.name for p in self.r.iterdir()], ["index.json"])  # no temp files left behind

    def test_bad_index_raises_and_state_reports_it(self):
        g = kb.root(self.deck, "global")
        g.mkdir(parents=True)
        (g / "index.json").write_text("{oops", encoding="utf-8")
        with self.assertRaises(kb.BadIndex):
            kb.load(g)
        st = kb.state(self.deck)
        self.assertEqual(st["global"]["items"], [])
        self.assertTrue(st["global"]["error"])
        self.assertIsNone(st["project"]["error"])
        self.assertEqual((g / "index.json").read_text(encoding="utf-8"), "{oops")

    def test_skills_selection_and_state(self):
        sk = self.proj / ".claude" / "skills"
        (sk / "brand").mkdir(parents=True)
        (sk / "brand" / "SKILL.md").write_text('---\nname: brand-guide\ndescription: "公司品牌规范"\n---\n规则', encoding="utf-8")
        (sk / "plain").mkdir()
        (sk / "plain" / "SKILL.md").write_text("没有 frontmatter", encoding="utf-8")
        g = self.home / ".claude" / "skills" / "consult"
        g.mkdir(parents=True)
        (g / "SKILL.md").write_text("---\nname: consult\ndescription: 咨询式汇报\n---\n", encoding="utf-8")
        self.assertEqual([(s["name"], s["description"], s["scope"]) for s in kb.skills(self.deck)],
                         [("brand-guide", "公司品牌规范", "project"), ("plain", "", "project"), ("consult", "咨询式汇报", "global")])
        self.assertEqual(kb.selection(self.deck), [])
        kb.set_selection(self.deck, ["brand-guide"])
        self.assertEqual(kb.selection(self.deck), ["brand-guide"])
        for bad in ("brand-guide", [1], ["x" * 101]):
            with self.assertRaises(ValueError):
                kb.set_selection(self.deck, bad)
        (self.proj / "decks" / "old").mkdir()
        (self.proj / "decks" / "old" / "deck.html").write_text("x", encoding="utf-8")
        st = kb.state(self.deck)
        self.assertEqual((st["decks"], st["enabled"], len(st["skills"])), (["old"], ["brand-guide"], 3))

    def test_upload_does_not_lose_a_concurrent_update(self):  # review I1: --kb-done landing while a file streams in
        first, _ = kb.add_file(self.r, io.BytesIO(b"# a"), 3, "a.md", "file")
        r = self.r

        class Racing(io.BytesIO):
            def read(s, n=-1):
                if s.tell() == 0:
                    kb.update(r, first["id"], status="ready")
                return super().read(n)
        kb.add_file(self.r, Racing(b"# b"), 3, "b.md", "file")
        self.assertEqual([i["status"] for i in kb.load(self.r)], ["ready", "pending"])

    def test_save_retries_a_busy_index_and_cleans_up(self):  # review I1: Windows refuses to replace an open file
        real, calls = os.replace, []

        def flaky(a, b):
            calls.append(1)
            if len(calls) < 3:
                raise PermissionError("busy")
            return real(a, b)
        with mock.patch("kb.os.replace", flaky):
            kb.save(self.r, [{"id": "k-aaaaaa"}])
        self.assertEqual(kb.load(self.r), [{"id": "k-aaaaaa"}])
        with mock.patch("kb.os.replace", side_effect=PermissionError("busy")):
            with self.assertRaises(PermissionError):
                kb.save(self.r, [])
        self.assertEqual([p.name for p in self.r.iterdir()], ["index.json"])

    def test_extraction_never_breaks_an_upload(self):  # review I3
        bad_xlsx = zip_bytes({"xl/workbook.xml": f'<workbook {S_NS}><sheets><sheet name="s"/></sheets></workbook>',
                              "xl/worksheets/sheet1.xml": f'<worksheet {S_NS}><sheetData><row><c t="s"><v/></c></row></sheetData></worksheet>'})
        item, _ = kb.add_file(self.r, io.BytesIO(bad_xlsx), len(bad_xlsx), "坏表.xlsx", "file")
        self.assertIn("文字抽取失败", item["note"])
        with mock.patch("kb.extract", side_effect=RuntimeError("encrypted")):
            item2, _ = kb.add_file(self.r, io.BytesIO(DOCX), len(DOCX), "加密.docx", "file")
        self.assertIn("encrypted", item2["note"])
        with mock.patch("kb.save", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                kb.add_file(self.r, io.BytesIO(b"# c"), 3, "c.md", "file")
        self.assertEqual(sorted(p.name.split("-", 2)[-1] for p in (self.r / "files").glob("k-*")), sorted(["坏表.xlsx", "加密.docx"]))

    def test_extracted_text_is_capped(self):  # review I4: a huge sheet must not be held whole in memory or on disk
        with mock.patch.object(kb, "MAX_TEXT_OUT", 10):
            item, _ = kb.add_file(self.r, io.BytesIO(DOCX), len(DOCX), "长.docx", "file")
        text = (self.r / item["text"]).read_text(encoding="utf-8")
        self.assertTrue(text.endswith("（已截断）"), text)
        self.assertLess(len(text), 40)

    def test_ids_from_the_index_are_checked(self):  # review M1: a hand-edited id must not reach the filesystem
        kb.save(self.r, [{"id": "../../evil", "type": "file", "title": "x", "source": "files/x.md", "status": "ready"}])
        with self.assertRaises(ValueError):
            kb.remove(self.r, "../../evil")
        self.assertFalse((self.tmp / "evil").exists())

    def test_digest_event_only_points_inside(self):  # review I2: a hand-edited index must not send Claude elsewhere
        outside = self.tmp / "secret.txt"
        outside.write_text("secret", encoding="utf-8")
        elsewhere = self.tmp / "other" / "decks" / "x"
        elsewhere.mkdir(parents=True)
        (elsewhere / "deck.html").write_text("x", encoding="utf-8")
        for item in ({"id": "k-aaaaaa", "type": "file", "title": "t", "source": str(outside)},
                     {"id": "k-aaaaaa", "type": "file", "title": "t", "source": "../../secret.txt"},
                     {"id": "k-aaaaaa", "type": "file", "title": "t", "source": "files/a.md", "text": str(outside)},
                     {"id": "k-aaaaaa", "type": "ref", "kind": "deck", "title": "t", "source": str(elsewhere)},
                     {"id": "k-aaaaaa", "type": "web", "title": "t", "source": "file:///C:/secret.txt"},
                     {"id": "k-aaaaaa", "type": "file", "title": "t"}):
            with self.assertRaises(ValueError, msg=item):
                kb.digest_event(self.deck, "project", item)

    def test_digest_event_and_card(self):
        item, _ = kb.add_file(self.r, io.BytesIO(PPTX), len(PPTX), "旧稿.pptx", "ref", "deck")
        ev = kb.digest_event(self.deck, "project", item)
        self.assertEqual((ev["type"], ev["kind"], ev["scope"], ev["kb_id"], ev["text"]), ("kb", "digest", "project", item["id"], "消化《旧稿》"))
        self.assertEqual(ev["source"], str(self.r / item["source"]))
        self.assertEqual(ev["extracted"], str(self.r / item["text"]))
        self.assertEqual(ev["card"], str(self.r / "cards" / f"{item['id']}.md"))
        web, _ = kb.add_url(self.r, "https://example.com", "web")
        wev = kb.digest_event(self.deck, "project", web)
        self.assertEqual((wev["source"], wev["snapshot"]), ("https://example.com", str(self.r / "web" / f"{web['id']}.md")))
        (self.r / "cards").mkdir(exist_ok=True)
        (self.r / "cards" / f"{item['id']}.md").write_text("## 摘要", encoding="utf-8")
        self.assertEqual(kb.card(self.deck, "project", item["id"]), "## 摘要")
        with self.assertRaises(ValueError):
            kb.card(self.deck, "project", "../index")


def post_raw(port, path, data, ctype="application/octet-stream", method="POST"):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    c.request(method, path, data, {"Host": f"127.0.0.1:{port}", "Content-Type": ctype})
    r = c.getresponse()
    out = (r.status, r.read())
    c.close()
    return out


class KbServerTests(ServerCase):
    def setUp(self):
        super().setUp()
        self.proj, self.home = self.tmp / "proj", self.tmp / "home"
        env = mock.patch.dict(os.environ, {"PPT_PROJECT_DIR": str(self.proj), "PPT_HOME_DIR": str(self.home)})
        env.start()
        self.addCleanup(env.stop)
        self.r = self.proj / "kb"

    def up(self, data, name, typ="file", kind="", scope="project", token="tok"):
        q = f"/api/kb/file?t={token}&scope={scope}&type={typ}&kind={kind}&name={quote(name)}"
        status, body = post_raw(self.port, q, data)
        return status, json.loads(body) if body.startswith(b"{") else body

    def test_upload_streams_and_asks_claude_to_digest(self):
        status, body = self.up(DOCX, "报告.docx")
        self.assertEqual((status, body["created"]), (200, True))
        item = body["item"]
        self.assertEqual(kb.load(self.r)[0]["id"], item["id"])
        ev = inbox(self.deck)[-1]
        self.assertEqual((ev["type"], ev["kind"], ev["kb_id"], ev["extracted"]), ("kb", "digest", item["id"], str(self.r / item["text"])))
        self.assertTrue(server.summary(ev).startswith(f"{ev['id']} kb kind:digest"))
        status, body = self.up(DOCX, "again.docx")
        self.assertEqual((status, body["created"]), (200, False))
        self.assertEqual(len([e for e in inbox(self.deck) if e["type"] == "kb"]), 1)  # no second digest for a duplicate

    def test_upload_rejections_reach_the_client(self):
        self.assertEqual(self.up(b"x" * 1000, "a.exe")[0], 400)
        self.assertEqual(self.up(b"x" * 1000, "a.png", typ="ref")[0], 400)
        self.assertEqual(self.up(b"x" * 1000, "a.md", token="bad")[0], 403)
        with mock.patch.object(kb, "MAX_FILE", 16):
            self.assertEqual(self.up(b"x" * 1000, "a.md")[0], 413)
        self.assertFalse(self.r.exists())

    def test_add_remove_redigest(self):
        def post(path, body):
            s, b = post_raw(self.port, f"{path}?t=tok", json.dumps(body).encode(), "application/json")
            return s, json.loads(b)
        self.assertEqual(post("/api/kb/add", {"scope": "project", "type": "web", "url": "ftp://x"})[0], 400)
        s, b = post("/api/kb/add", {"scope": "global", "type": "web", "url": "https://example.com"})
        self.assertEqual((s, b["created"]), (200, True))
        g = self.home / ".ppt-maker" / "kb"
        self.assertEqual(kb.load(g)[0]["source"], "https://example.com")
        (self.proj / "decks" / "old").mkdir(parents=True)
        (self.proj / "decks" / "old" / "deck.html").write_text("x", encoding="utf-8")
        s, b = post("/api/kb/add", {"scope": "project", "deck": "old"})
        self.assertEqual((s, b["item"]["kind"]), (200, "deck"))
        did = b["item"]["id"]
        kb.update(self.r, did, status="failed", note="打不开")
        s, b = post("/api/kb/redigest", {"scope": "project", "id": did})
        self.assertEqual((s, b["item"]["status"], b["item"]["note"]), (200, "pending", ""))
        self.assertEqual(inbox(self.deck)[-1]["kb_id"], did)
        s, b = post("/api/kb/remove", {"scope": "project", "id": did})
        self.assertEqual((s, kb.load(self.r)), (200, []))
        self.assertEqual(post("/api/kb/remove", {"scope": "project", "id": did})[0], 400)
        self.assertEqual(post("/api/kb/add", {"scope": "nowhere", "type": "web", "url": "https://x.com"})[0], 400)

    def test_bad_index_is_409_and_untouched(self):
        g = self.home / ".ppt-maker" / "kb"
        g.mkdir(parents=True)
        (g / "index.json").write_text("{oops", encoding="utf-8")
        st = json.loads(self.req("GET", "/api/kb?t=tok")[1])
        self.assertTrue(st["global"]["error"])
        s, _ = post_raw(self.port, "/api/kb/add?t=tok", json.dumps({"scope": "global", "type": "web", "url": "https://x.com"}).encode(), "application/json")
        self.assertEqual(s, 409)
        self.assertEqual(self.up(b"# x", "a.md", scope="global")[0], 409)
        self.assertEqual((g / "index.json").read_text(encoding="utf-8"), "{oops")

    def test_skills_put_and_skill_request(self):
        s, b = post_raw(self.port, "/api/kb/skills?t=tok", json.dumps({"skills": ["brand"]}).encode(), "application/json", "PUT")
        self.assertEqual((s, json.loads(b)["enabled"]), (200, ["brand"]))
        self.assertEqual(kb.selection(self.deck), ["brand"])
        self.assertEqual(post_raw(self.port, "/api/kb/skills?t=tok", b'{"skills": "brand"}', "application/json", "PUT")[0], 400)
        s, _ = post_raw(self.port, "/api/kb/skill?t=tok", json.dumps({"scope": "global", "text": "品牌规范：主色蓝"}).encode(), "application/json")
        ev = inbox(self.deck)[-1]
        self.assertEqual((s, ev["kind"], ev["dir"], ev["text"]), (200, "skill", str(self.home / ".claude" / "skills"), "品牌规范：主色蓝"))
        self.assertEqual(post_raw(self.port, "/api/kb/skill?t=tok", b'{"scope": "project", "text": " "}', "application/json")[0], 400)

    def test_state_and_card(self):
        st = json.loads(self.req("GET", "/api/kb?t=tok")[1])
        self.assertEqual((st["project"]["items"], st["skills"], st["enabled"]), ([], [], []))
        self.assertEqual(self.req("GET", "/api/kb")[0], 403)
        _, body = self.up(b"# x", "a.md")
        (self.r / "cards").mkdir()
        (self.r / "cards" / f"{body['item']['id']}.md").write_text("## 摘要\n要点", encoding="utf-8")
        s, b = self.req("GET", f"/api/kb/card?t=tok&scope=project&id={body['item']['id']}")
        self.assertEqual((s, json.loads(b)["text"]), (200, "## 摘要\n要点"))
        self.assertEqual(self.req("GET", "/api/kb/card?t=tok&scope=project&id=k-zzzzzz")[0], 404)

    def test_kb_done_and_fail_cli(self):
        _, body = self.up(b"# x", "a.md")
        kid = body["item"]["id"]
        with contextlib.redirect_stdout(io.StringIO()):  # keep the CLI's one-line confirmation out of the test report
            server.main(["--kb-done", str(self.deck), "project", kid, "年报", "营收", "12.3 亿"])
        self.assertEqual({k: kb.load(self.r)[0][k] for k in ("status", "title", "summary")}, {"status": "ready", "title": "年报", "summary": "营收 12.3 亿"})
        with contextlib.redirect_stdout(io.StringIO()):
            server.main(["--kb-fail", str(self.deck), "project", kid, "加密", "PDF"])
        self.assertEqual((kb.load(self.r)[0]["status"], kb.load(self.r)[0]["note"]), ("failed", "加密 PDF"))

    def test_intent_kb_field(self):
        self.assertEqual(self.req("POST", "/api/event?t=tok", {"type": "intent", "text": "x", "kb": ["k-abc123"]})[0], 200)
        e = inbox(self.deck)[-1]
        self.assertEqual(e["kb"], ["k-abc123"])
        self.assertIn("kb:k-abc123", server.summary(e))
        for bad in ([5], ["k" * 21], ["k-a"] * 21):
            self.assertEqual(self.req("POST", "/api/event?t=tok", {"type": "intent", "text": "x", "kb": bad})[0], 400)

    def test_a_slow_upload_does_not_block_other_requests(self):  # review I4: the stream is read outside LOCK
        s = socket.create_connection(("127.0.0.1", self.port))
        s.sendall(f"POST /api/kb/file?t=tok&scope=project&type=file&name=a.md HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n"
                  f"Content-Length: 100\r\n\r\n# partial".encode())
        _time.sleep(0.3)
        try:
            c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
            c.request("GET", "/api/kb?t=tok", headers={"Host": f"127.0.0.1:{self.port}"})
            self.assertEqual(c.getresponse().status, 200)
            c.close()
        finally:
            s.close()

    def test_busy_index_is_503_not_a_dropped_connection(self):  # review I1
        with mock.patch("kb.save", side_effect=PermissionError("busy")):
            s, b = post_raw(self.port, "/api/kb/add?t=tok", json.dumps({"scope": "project", "type": "web", "url": "https://x.com"}).encode(), "application/json")
        self.assertEqual(s, 503)

    def test_redigest_refuses_paths_outside_the_kb(self):  # review I2
        kb.save(self.r, [{"id": "k-aaaaaa", "type": "file", "title": "t", "source": str(self.tmp / "deck" / "deck.html"), "status": "failed"}])
        s, _ = post_raw(self.port, "/api/kb/redigest?t=tok", json.dumps({"scope": "project", "id": "k-aaaaaa"}).encode(), "application/json")
        self.assertEqual(s, 400)
        self.assertFalse(any(e["type"] == "kb" for e in inbox(self.deck)))

    def test_kb_add_cli(self):  # so Claude never edits index.json by hand
        src = self.tmp / "笔记.md"
        src.write_text("# 笔记", encoding="utf-8")
        with contextlib.redirect_stdout(io.StringIO()) as out:
            server.main(["--kb-add", str(self.deck), "project", "file", str(src)])
            server.main(["--kb-add", str(self.deck), "global", "web", "https://example.com"])
        items = kb.load(self.r)
        self.assertEqual((items[0]["title"], items[0]["status"]), ("笔记", "pending"))
        self.assertEqual(kb.load(self.home / ".ppt-maker" / "kb")[0]["source"], "https://example.com")
        self.assertIn(items[0]["id"], out.getvalue())  # Claude needs the id (and the card path) to digest it
        self.assertIn("card", out.getvalue())

    def test_tail_catches_up_kb_events(self):
        self.up(b"# x", "a.md")
        lines, done = [], threading.Event()
        th = threading.Thread(target=server.tail, args=(self.deck, lines.append, done.is_set, 0.05), daemon=True)
        th.start()
        _time.sleep(0.3)
        done.set()
        th.join(2)
        self.assertTrue(any(" kb kind:digest " in l for l in lines), lines)


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
        self.assertIn("charset=utf-8", r.getheader("Content-Type"))  # no <meta charset>: Chinese must not turn into mojibake
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


if __name__ == "__main__":
    unittest.main()
