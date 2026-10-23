import base64, contextlib, io, json, os, shutil, sys, tempfile, threading, unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import runner
import server

HERE = Path(__file__).resolve().parent

THEME = '<style id="theme">:root{--fg:#111}</style>'


def deck(*slides):
    return f'<html><head>{THEME}</head><body>\n' + "\n".join(f'<section class="slide" id="{i}">{t}</section>' for i, t in slides) + "\n</body></html>"


def page(i, t="x"):
    return f'<section class="slide" id="{i}">{t}</section>'


class SurgeryTests(unittest.TestCase):
    def setUp(self):
        self.html = deck(("s-a", "A"), ("s-b", "B"))
        self.sent = runner.snapshot(self.html, ["s-a", "s-b"])

    def ids(self, html):
        return [i for i, _, _ in runner.sections(html)]

    def apply(self, resp, html=None, sent=None):
        return runner.apply_changes(html or self.html, {"reply": "ok", **resp}, sent or self.sent)

    def test_sections_nested(self):
        html = deck(("s-a", "<section>x</section>tail"), ("s-b", "B"))
        (i, s, e), _ = runner.sections(html)
        self.assertEqual(self.ids(html), ["s-a", "s-b"])
        self.assertTrue(html[s:e].endswith("tail</section>"))

    def test_apply_replace_insert_delete(self):
        out, why = self.apply({"slides": [{"id": "s-a", "html": page("s-a", "新A")}],
                               "insert": [{"after": "s-a", "html": page("s-c")}], "delete": ["s-b"]})
        self.assertIsNone(why)
        self.assertEqual(self.ids(out), ["s-a", "s-c"])
        self.assertIn("新A", out)

    def test_apply_insert_null_appends(self):
        out, why = self.apply({"insert": [{"after": None, "html": page("s-z")}]})
        self.assertEqual((why, self.ids(out)), (None, ["s-a", "s-b", "s-z"]))

    def test_apply_theme(self):
        t = '<style id="theme">:root{--fg:#f00}</style>'
        out, why = self.apply({"theme": t})
        self.assertIsNone(why)
        self.assertIn("#f00", out)
        self.assertNotIn("#111", out)

    def assertRejected(self, resp):
        out, why = self.apply(resp)
        self.assertIsNone(out)
        self.assertTrue(why)

    def test_apply_rejects_unknown_id(self):
        self.assertRejected({"slides": [{"id": "s-x", "html": page("s-x")}]})

    def test_apply_rejects_id_mismatch(self):
        self.assertRejected({"slides": [{"id": "s-a", "html": page("s-b")}]})

    def test_apply_rejects_duplicate_id(self):
        self.assertRejected({"insert": [{"after": "s-a", "html": page("s-b")}]})
        self.assertRejected({"slides": [{"id": "s-a", "html": page("s-a", '<div id="dup"></div><div id="dup"></div>')}]})

    def test_apply_rejects_delete_all(self):
        self.assertRejected({"delete": ["s-a", "s-b"]})

    def test_apply_rejects_after_deleted(self):
        self.assertRejected({"delete": ["s-b"], "insert": [{"after": "s-b", "html": page("s-c")}]})

    def test_apply_rejects_not_one_section(self):
        self.assertRejected({"slides": [{"id": "s-a", "html": page("s-a") + page("s-q")}]})
        self.assertRejected({"slides": [{"id": "s-a", "html": "<div>no section</div>"}]})

    def test_apply_rejects_forbidden(self):
        for bad in ("<script>alert(1)</script>", '<b onclick="x()">', '<a href="javascript:x">', '<img src="https://x/a.png">',
                    "<style>@import 'x.css';</style>", '<a href="data:text/html,x">', '<div data-ppt="1">', '<div class="a ppt-x">'):
            with self.subTest(bad):
                self.assertRejected({"slides": [{"id": "s-a", "html": page("s-a", bad)}]})
        out, why = self.apply({"slides": [{"id": "s-a", "html": page("s-a", '<img src="data:image/png;base64,AA">')}]})
        self.assertIsNone(why)

    def test_apply_rejects_bad_theme(self):
        self.assertRejected({"theme": "<style>:root{}</style>"})
        self.assertRejected({"theme": THEME + THEME})
        self.assertRejected({"theme": '<style id="theme">body{background:url(https://x/y.png)}</style>'})

    def test_apply_rejects_bad_shape(self):
        self.assertRejected({"slides": "s-a"})
        self.assertRejected({"slides": [{"id": "s-a"}]})
        self.assertRejected({"delete": "s-a"})

    def test_apply_conflict(self):
        changed = self.html.replace(">A<", ">用户改的<")
        out, why = self.apply({"slides": [{"id": "s-a", "html": page("s-a", "新")}]}, html=changed)
        self.assertEqual((out, why), (None, runner.CONFLICT))
        self.assertEqual(self.apply({"delete": ["s-a"]}, html=changed)[1], runner.CONFLICT)
        self.assertEqual(self.apply({"insert": [{"after": "s-a", "html": page("s-c")}]}, html=changed)[1], runner.CONFLICT)
        out, why = self.apply({"insert": [{"after": "s-b", "html": page("s-c")}]}, html=changed)  # another page changed: fine
        self.assertIsNone(why)
        self.assertIn("用户改的", out)
        theme_changed = self.html.replace("#111", "#222")
        self.assertEqual(self.apply({"theme": THEME}, html=theme_changed)[1], runner.CONFLICT)

    def test_review_c1_filter_bypasses(self):  # each of these ran script or reached the network in the editor page
        for bad in ("<svg/onload=alert(1)>", '<img alt=">" onerror=alert(1) src=x>', '<iframe srcdoc="&lt;script&gt;parent.PPT&lt;/script&gt;"></iframe>',
                    '<a href="&#106;avascript:alert(1)">x</a>', '<a href="java\tscript:alert(1)">x</a>', '<img src="//evil.example/p.png">',
                    '<embed src="x.swf">', '<object data="x"></object>', '<base href="x">', '<div style="background:url(//evil/x.png)"></div>',
                    '<svg><use href="https://evil/x.svg#a"></use></svg>', '<div STYLE="background:URL(&quot;http://e/x&quot;)"></div>'):
            with self.subTest(bad):
                self.assertRejected({"slides": [{"id": "s-a", "html": page("s-a", bad)}]})

    def test_review_i1_page_that_swallows_the_rest(self):
        for bad in ("<!--", "<style>", "<textarea>", "<title>", "<xmp>", "<plaintext>", "<b>bold", "</div>", "<![CDATA["):
            with self.subTest(bad):
                self.assertRejected({"slides": [{"id": "s-a", "html": page("s-a", bad)}]})
        for ok in ("<p>one<p>two", "<ul><li>a<li>b</ul>", "<!-- note --><br><img src=\"assets/a.png\">", "<svg viewBox=\"0 0 1 1\"><path d=\"M0 0\"/></svg>"):
            with self.subTest(ok):
                self.assertIsNone(self.apply({"slides": [{"id": "s-a", "html": page("s-a", ok)}]})[1])
        self.assertRejected({"theme": '<style id="theme">x</style><!--'})
        self.assertRejected({"theme": '<style id="theme">x</style><p>'})

    def test_review_i2_comments_and_attribute_values(self):
        html = deck(("s-a", '<!-- old </section> --><div class="block" id="b-9">tail</div>'), ("s-b", "B"))
        self.assertEqual([i for i, _, _ in runner.sections(html)], ["s-a", "s-b"])
        out, why = self.apply({"slides": [{"id": "s-a", "html": page("s-a", "NEW")}]}, html=html, sent=runner.snapshot(html, ["s-a", "s-b"]))
        self.assertIsNone(why)
        self.assertNotIn("tail", out)
        self.assertNotIn("-->", out)
        tricky = '<section class="slide" title=\'id="s-a"\' id="s-zzz">x</section>'
        self.assertRejected({"slides": [{"id": "s-a", "html": tricky}]})
        css = deck(("s-a", "A"), ("s-b", "B")).replace(":root{--fg:#111}", ':root{--fg:#111} [id="s-a"]{color:red}')
        self.assertIsNone(self.apply({"slides": [{"id": "s-a", "html": page("s-a", "N")}]}, html=css, sent=runner.snapshot(css, ["s-a"]))[1])

    def test_review_i4_inserts_keep_their_order(self):
        out, why = self.apply({"insert": [{"after": "s-a", "html": page("s-1")}, {"after": "s-a", "html": page("s-2")}, {"after": "s-2", "html": page("s-3")}]})
        self.assertIsNone(why)
        self.assertEqual(self.ids(out), ["s-a", "s-1", "s-2", "s-3", "s-b"])

    def test_apply_unsent_page_is_not_a_conflict_but_an_error(self):
        out, why = self.apply({"slides": [{"id": "s-b", "html": page("s-b", "新")}]}, sent=runner.snapshot(self.html, ["s-a"]))
        self.assertIsNone(out)
        self.assertNotEqual(why, runner.CONFLICT)


class DeckCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.deck = self.tmp / "proj" / "decks" / "d"
        server.ensure_deck(self.deck)
        self.inbox = server.runtime(self.deck) / "inbox.jsonl"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def add(self, eid, typ="intent", **k):
        ev = {"id": eid, "type": typ, "text": f"做{eid}", **k}
        server.append_jsonl(self.inbox, ev)
        return ev

    def run_loop(self, handle, rounds=30):  # stop after `rounds` polls so a broken loop can never hang the suite
        n = [0]
        def stop():
            n[0] += 1
            return n[0] > rounds
        with contextlib.redirect_stdout(io.StringIO()):
            return runner.run(self.deck, handle, "T", stop=stop, interval=0.01)

    def replies(self, eid):
        return [r["text"] for r in server.outbox_rows(self.deck) if r.get("re") == eid and not r.get("ack")]

    def script(self, body):
        p = self.tmp / f"agent{len(list(self.tmp.glob('agent*.py')))}.py"
        p.write_text(f"import sys, time\nsys.path.insert(0, {str(HERE)!r})\nimport server\nfrom pathlib import Path\n{body}\n", encoding="utf-8")
        return f'"{sys.executable}" "{p}"'


class RunnerTests(DeckCase):
    def test_run_hands_pending_and_acks(self):
        self.add("e1")
        self.add("e2", "edit", label="移动 b-x")
        got = []
        self.run_loop(lambda evs, lines: got.append([e["id"] for e in evs]))
        self.assertEqual(got, [["e1"]])
        self.assertEqual(server.statuses(self.deck).get("e1"), "processing")

    def test_run_handles_acked_unreplied_after_restart(self):
        self.add("e1")
        server.reply(self.deck, "e1", ack=True)
        got = []
        self.run_loop(lambda evs, lines: got.append([e["id"] for e in evs]))
        self.assertEqual(got, [["e1"]])

    def test_run_handle_exception_replies(self):
        self.add("e1")
        def boom(evs, lines):
            raise ValueError("x")
        self.run_loop(boom)
        self.assertEqual(server.statuses(self.deck).get("e1"), "done")
        self.assertIn("ValueError", self.replies("e1")[0])

    def test_agent_handle_fallback(self):
        ev = self.add("e1")
        runner.agent_handle(self.deck, self.script("sys.stdin.read(); sys.exit(3)"), 30, "A")([ev], ["e1 intent"])
        self.assertIn("退出码 3", self.replies("e1")[0])

    def test_agent_handle_agent_replies(self):
        ev = self.add("e1")
        cmd = self.script("server.reply(Path(sys.argv[1]), 'e1', '好了')") + " {deck}"
        runner.agent_handle(self.deck, cmd, 30, "A")([ev], ["e1 intent"])
        self.assertEqual(self.replies("e1"), ["好了"])

    def test_agent_prompt_file_and_stdin(self):
        ev = self.add("e1")
        cmd = self.script("p = Path(sys.argv[1]).read_text(encoding='utf-8'); s = sys.stdin.buffer.read().decode('utf-8')\n"
                          "server.reply(Path(sys.argv[2]), 'e1', 'same' if p == s and 'e1 intent' in s else 'diff')") + " {prompt} {deck}"
        runner.agent_handle(self.deck, cmd, 30, "A")([ev], ["e1 intent"])
        self.assertEqual(self.replies("e1"), ["same"])

    def test_agent_timeout_fallback(self):
        ev = self.add("e1")
        t = _time()
        runner.agent_handle(self.deck, self.script("time.sleep(20)"), 1, "A")([ev], ["e1 intent"])
        self.assertLess(_time() - t, 15)
        self.assertIn("超时", self.replies("e1")[0])

    def test_minor_m3_one_kill_tree(self):
        import importer
        self.assertIs(runner.kill_tree, importer.kill_tree)

    def test_minor_m4_ctrl_c_ends_the_agent(self):
        ev = self.add("e1")
        killed = []
        with mock.patch.object(runner.subprocess.Popen, "communicate", side_effect=KeyboardInterrupt), \
             mock.patch.object(runner, "kill_tree", side_effect=lambda p: (killed.append(p.pid), p.kill(), p.wait())):
            with self.assertRaises(KeyboardInterrupt):
                runner.agent_handle(self.deck, self.script("time.sleep(20)"), 30, "A")([ev], ["e1 intent"])
        self.assertEqual(len(killed), 1)

    def test_minor_m5_every_event_reaches_the_prompt(self):
        e1, e2 = self.add("e1"), self.add("e2", text="后到的")
        cmd = self.script("p = sys.stdin.buffer.read().decode('utf-8')\nfor e in ('e1', 'e2'):\n    server.reply(Path(sys.argv[1]), e, 'seen' if e + ' intent' in p else 'missing')") + " {deck}"
        runner.agent_handle(self.deck, cmd, 30, "A")([e1, e2], ["e1 intent slide:- [] 做e1"])
        self.assertEqual((self.replies("e1"), self.replies("e2")), (["seen"], ["seen"]))

    def test_minor_m8_stderr_in_the_console_code_page(self):
        import locale
        enc = locale.getpreferredencoding(False)
        ev = self.add("e1")
        runner.agent_handle(self.deck, self.script(f"sys.stderr.buffer.write('中文出错'.encode({enc!r})); sys.exit(1)"), 30, "A")([ev], ["e1 intent"])
        self.assertIn("中文出错", self.replies("e1")[0])

    def test_agent_prompt_has_rules_and_paths(self):
        p = runner.agent_prompt(self.deck.resolve(), ["e1 intent slide:s-a"])
        for s in ("## deck.html 格式规则", self.deck.resolve().as_posix(), Path(sys.executable).as_posix(), "e1 intent slide:s-a", "不要运行 --wait"):
            self.assertIn(s, p)

    def test_main_requires_key(self):
        env = {k: v for k, v in os.environ.items() if k != "PPT_API_KEY"}
        with mock.patch.dict(os.environ, env, clear=True), self.assertRaises(SystemExit) as cm:
            runner.main([str(self.deck), "--backend", "llm", "--base-url", "http://127.0.0.1:1", "--model", "m"])
        self.assertIn("PPT_API_KEY", str(cm.exception.code))

    def test_main_agent_requires_cmd(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            runner.main([str(self.deck), "--backend", "agent"])


class FakeLLM(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.reqs.append({"auth": self.headers.get("Authorization"), "path": self.path, "body": body})
        status, out = self.server.queue.pop(0)
        if callable(out):
            status, out = 200, out()
        drip = isinstance(out, tuple)
        data = (out[1] if drip else out).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if not drip:
            return self.wfile.write(data)
        import time
        for b in data:  # one byte every 0.3 s: no single read ever times out
            try:
                self.wfile.write(bytes([b]))
                self.wfile.flush()
            except OSError:
                return
            time.sleep(0.3)

    def log_message(self, *a):
        pass


def said(resp):
    return json.dumps({"choices": [{"message": {"content": json.dumps(resp, ensure_ascii=False)}}]}, ensure_ascii=False)


PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgAAIAAAUAAen63NgAAAAASUVORK5CYII=")


class LlmTests(DeckCase):
    def setUp(self):
        super().setUp()
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeLLM)
        self.srv.reqs, self.srv.queue = [], []
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}/v1"

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        super().tearDown()

    def handle(self, *evs, key="k"):
        runner.llm_handle(self.deck, self.url, key, "m", 10, "M")(list(evs), [])

    def html(self):
        return (self.deck / "deck.html").read_text(encoding="utf-8")

    def cover(self, text):
        return {"id": "s-cover", "html": f'<section class="slide" id="s-cover"><div class="block" id="b-new" style="grid-area:1/1/3/17">{text}</div></section>'}

    def test_llm_edits_page(self):
        (server.runtime(self.deck) / "shots").mkdir(exist_ok=True)
        (server.runtime(self.deck) / "shots" / "e1.png").write_bytes(PNG)
        ev = self.add("e1", slide_id="s-cover", blocks=["b-title"], shot=".ppt/shots/e1.png")
        self.srv.queue.append((200, said({"reply": "改好了", "slides": [self.cover("新标题")]})))
        self.handle(ev)
        self.assertIn("新标题", self.html())
        self.assertEqual(self.replies("e1"), ["改好了"])
        r = self.srv.reqs[0]
        self.assertEqual((r["auth"], r["path"], r["body"]["model"]), ("Bearer k", "/v1/chat/completions", "m"))
        self.assertEqual(r["body"]["response_format"], {"type": "json_object"})
        parts = r["body"]["messages"][1]["content"]
        self.assertTrue(any(p["type"] == "image_url" and p["image_url"]["url"].startswith("data:image/png;base64,") for p in parts))
        text = "".join(p.get("text", "") for p in parts)
        self.assertIn('id="s-cover"', text)
        self.assertIn('<style id="theme">', text)
        self.assertNotIn(".ppt/shots", text)

    def test_llm_retries_without_response_format_on_400(self):
        ev = self.add("e1", slide_id="s-cover")
        self.srv.queue += [(400, '{"error":"response_format unsupported"}'), (200, said({"reply": "好"}))]
        self.handle(ev)
        self.assertEqual(self.replies("e1"), ["好"])
        self.assertNotIn("response_format", self.srv.reqs[1]["body"])

    def test_llm_bad_json_replies_and_keeps_deck(self):
        before = self.html()
        ev = self.add("e1", slide_id="s-cover")
        self.srv.queue.append((200, json.dumps({"choices": [{"message": {"content": "不是 JSON"}}]})))
        self.handle(ev)
        self.assertEqual(self.html(), before)
        self.assertTrue(self.replies("e1")[0].startswith("没改成"))

    def test_llm_rejected_change_keeps_deck(self):
        before = self.html()
        ev = self.add("e1", slide_id="s-cover")
        self.srv.queue.append((200, said({"reply": "好", "slides": [self.cover("<script>x</script>")]})))
        self.handle(ev)
        self.assertEqual(self.html(), before)
        self.assertIn("脚本", self.replies("e1")[0])

    def test_llm_conflict(self):
        ev = self.add("e1", slide_id="s-cover")
        f = self.deck / "deck.html"
        def user_edits_meanwhile():
            f.write_text(self.html().replace("</section>", "<p>用户手改</p></section>", 1), encoding="utf-8")
            return said({"reply": "好", "slides": [self.cover("模型的")]})
        self.srv.queue.append((200, user_edits_meanwhile))
        self.handle(ev)
        self.assertIn("用户手改", self.html())
        self.assertNotIn("模型的", self.html())
        self.assertEqual(self.replies("e1"), [runner.CONFLICT])

    def test_llm_unsupported_kb_and_import(self):
        evs = [self.add("e1", "kb", kind="digest"), self.add("e2", "import", kind="file"), self.add("e3", slide_id="s-cover", kb=["k1"])]
        self.handle(*evs)
        self.assertEqual(self.srv.reqs, [])
        for e in ("e1", "e2", "e3"):
            self.assertEqual(self.replies(e), [runner.UNSUPPORTED])

    def test_llm_error_never_leaks_key(self):
        key = "sk-secret-123456"
        ev = self.add("e1", slide_id="s-cover")
        self.srv.queue.append((401, json.dumps({"error": f"bad key {key}"})))
        self.handle(ev, key=key)
        self.assertTrue(self.replies("e1")[0].startswith("没改成"))
        self.assertIn("401", self.replies("e1")[0])
        for p in self.deck.rglob("*"):
            if p.is_file():
                self.assertNotIn(key.encode(), p.read_bytes(), p)

    def test_review_i3_key_straddling_the_cut(self):
        key = "sk-" + "a" * 48
        ev = self.add("e1", slide_id="s-cover")
        self.srv.queue.append((401, json.dumps({"error": "x" * 270 + " Bearer " + key})))
        self.handle(ev, key=key)
        self.assertNotIn("a" * 8, self.replies("e1")[0])

    def test_review_m1_replace_retries_when_windows_holds_the_file(self):
        real, n = os.replace, [0]
        def flaky(a, b):
            n[0] += 1
            if n[0] <= 2:
                raise PermissionError("in use")
            real(a, b)
        with mock.patch.object(runner.os, "replace", flaky):
            runner.write_deck(self.deck, "<html>new</html>")
        self.assertEqual((self.deck / "deck.html").read_text(encoding="utf-8"), "<html>new</html>")
        self.assertFalse((self.deck / ".deck.runner.tmp").exists())

    def test_minor_m2_write_refuses_when_the_file_moved_on(self):
        f = self.deck / "deck.html"
        f.write_text("<html>user</html>", encoding="utf-8")
        self.assertFalse(runner.write_deck(self.deck, "<html>model</html>", expect="<html>before</html>"))
        self.assertEqual(f.read_text(encoding="utf-8"), "<html>user</html>")
        self.assertTrue(runner.write_deck(self.deck, "<html>model</html>", expect="<html>user</html>"))
        self.assertEqual(f.read_text(encoding="utf-8"), "<html>model</html>")

    def test_minor_m6_each_write_is_labelled_with_its_own_event(self):
        evs = [self.add("e1", slide_id="s-cover"), self.add("e2", slide_id="s-cover")]
        server.write_agent(self.deck, "M")  # run() does this through wait_events
        for e in evs:
            server.reply(self.deck, e["id"], ack=True)  # run() acks the whole batch first
        self.srv.queue += [(200, said({"reply": "1", "slides": [self.cover("一")]})), (200, said({"reply": "2", "slides": [self.cover("二")]}))]
        labels, real = [], runner.write_deck
        def spy(deck, html, expect=None):
            labels.append(server.claude_label(deck))
            return real(deck, html, expect)
        with mock.patch.object(runner, "write_deck", spy), mock.patch.object(runner.time, "sleep"):
            self.handle(*evs)
        self.assertEqual(labels, ["M 处理 #e1", "M 处理 #e2"])

    def test_minor_m7_whole_request_has_a_deadline(self):
        ev = self.add("e1", slide_id="s-cover")
        self.srv.queue.append((200, ("drip", said({"reply": "慢"}))))
        t = _time()
        runner.llm_handle(self.deck, self.url, "k", "m", 1, "M")([ev], [])
        self.assertLess(_time() - t, 6)
        self.assertIn("超时", self.replies("e1")[0])

    def test_llm_unreachable(self):
        ev = self.add("e1", slide_id="s-cover")
        runner.llm_handle(self.deck, "http://127.0.0.1:1/v1", "k", "m", 5, "M")([ev], [])
        self.assertTrue(self.replies("e1")[0].startswith("没改成"))

    def test_llm_too_big(self):
        f = self.deck / "deck.html"
        f.write_text(self.html().replace("</section>", "<p>" + "字" * 200001 + "</p></section>", 1), encoding="utf-8")
        ev = self.add("e1", slide_id="s-cover")
        self.handle(ev)
        self.assertEqual(self.srv.reqs, [])
        self.assertEqual(self.replies("e1"), [runner.TOO_BIG])

    def test_llm_insert_and_answer_context(self):
        first = self.add("e1", slide_id="s-cover", text="加一页")
        server.reply(self.deck, "e1", "要讲什么？")
        ans = self.add("e2", "answer", re="e1", text="讲预算")
        self.srv.queue.append((200, said({"reply": "加了", "insert": [{"after": "s-cover", "html": '<section class="slide" id="s-budget"></section>'}]})))
        self.handle(ans)
        self.assertEqual([i for i, _, _ in runner.sections(self.html())], ["s-cover", "s-budget"])
        text = "".join(p.get("text", "") for p in self.srv.reqs[0]["body"]["messages"][1]["content"])
        self.assertIn("加一页", text)
        self.assertIn("要讲什么？", text)

    def test_pages_for(self):
        html = deck(("s-a", '<div class="block" id="b-1"></div>'), ("s-b", '<div class="block" id="b-2"></div>'))
        by = {"e1": {"id": "e1", "type": "intent", "slide_id": "s-b"}}
        self.assertEqual(runner.pages_for({"type": "intent", "slide_id": "s-a"}, by, html), ["s-a"])
        self.assertEqual(runner.pages_for({"type": "intent", "kind": "batch", "items": [{"slide_id": "s-b"}, {"slide_id": "s-a"}, {"slide_id": "s-b"}]}, by, html), ["s-b", "s-a"])
        self.assertEqual(runner.pages_for({"type": "answer", "re": "e1"}, by, html), ["s-b"])
        self.assertEqual(runner.pages_for({"type": "lint", "issues": [{"block": "b-2", "kind": "overflow"}]}, by, html), ["s-b"])
        self.assertIsNone(runner.pages_for({"type": "intent"}, by, html))
        self.assertIsNone(runner.pages_for({"type": "intent", "slide_id": "s-gone"}, by, html))


def _time():
    import time
    return time.time()


if __name__ == "__main__":
    unittest.main()
