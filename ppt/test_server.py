import http.client, json, shutil, socket, sys, tempfile, threading, unittest
import time as _time
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
