import contextlib, io, os, shutil, sys, tempfile, unittest
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


def _time():
    import time
    return time.time()


if __name__ == "__main__":
    unittest.main()
