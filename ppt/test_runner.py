import sys, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import runner

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


if __name__ == "__main__":
    unittest.main()
