# ppt-maker 子项目 4：知识库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 项目级与全局知识库（文件、网站、参考、Claude Code Skills），在页面侧栏管理；资料由 Claude 消化成卡片，生成和修改幻灯片时按卡片取材、标出处、遵守启用的 Skills。

**Architecture:** 新的标准库模块 `ppt/kb.py` 负责所有知识库文件操作（定位、目录、流式保存、去重、Office 抽字、回收站、Skills 列表、deck 选择）。`server.py` 只做接口与事件：添加资料时写一条 `kb` 事件交给 Claude 消化，Claude 写卡片后用 `--kb-done` 更新目录。新的 `ppt/kb-panel.js` 是纯界面，只调接口；"用在这一页"借用编辑器现有的意图框，意图带 `kb` 字段。

**Tech Stack:** Python 3 标准库（`zipfile`、`xml.etree`）、浏览器原生 JS、Edge headless 测试。

**Spec:** `docs/superpowers/specs/2026-10-15-ppt-maker-kb-design.md`

## Global Constraints

- 分支 `feat/kb`；每个 task 提交，信息末尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- Python 只用标准库；页面不引入第三方库。
- 项目知识库 `<项目>/kb/`（项目 = deck 目录往上两层）；全局 `~/.ppt-maker/kb/`；Skills `<项目>/.claude/skills/`、`~/.claude/skills/`。环境变量 `PPT_PROJECT_DIR`、`PPT_HOME_DIR` 覆盖项目目录与主目录（测试用）。
- id：`k-` + 6 位小写字母数字；`type` ∈ `file|web|ref`；`ref` 的 `kind` ∈ `visual|cite|deck`；`status` ∈ `pending|ready|failed`。
- 支持 `.pdf .docx .pptx .xlsx .md .txt .csv .png .jpg .jpeg .gif .webp`，单个 ≤ 50MB，流式写盘。
- `index.json` 读不了时报错且绝不覆盖；对该范围写操作返回 409。
- 所有 `/api/kb*` 接口要求口令并经 Host 校验。
- 面板中用户/资料数据一律用 `textContent`，不进 `innerHTML`。
- 测试：`python ppt/test_server.py`；selftest（`$TEMP/ppt-logs/selftest.sh`）；`node tests/e2e.mjs`（只用 `decks/e2e-smoke`、端口 8800，知识库指向临时目录）。
- Windows：含反斜杠的代码用 Edit/Write，不用 Bash heredoc。

## Review Focus

1. **上传被拒（格式、类型、口令）时请求体没读完**：客户端要收到 400/403，而不是连接被重置。→ Task 2 `test_upload_rejections_reach_the_client`。
2. **`index.json` 里的 `source` 被手改成 `../` 路径**：删除时不能把知识库以外的文件挪走。→ Task 1 `test_remove_never_leaves_the_kb`。
3. **侧栏每 2 秒刷新**：正在输入的网址、Skill 描述不能被清掉。→ Task 3 e2e `B refresh keeps what you are typing`。
4. **资料标题、摘要含 `<script>` 等**：面板按原文显示，不执行。→ Task 3 e2e `B titles are shown as text`。
5. **Claude 写卡片、CLI 改目录时服务也在写**：只能丢失最后一次的并发写，目录不能写坏（先写临时文件再替换）。→ Task 1 `test_save_is_atomic`（目录始终是合法 JSON）。

---

### Task 1: `ppt/kb.py` 知识库模块

**Files:**
- Create: `ppt/kb.py`
- Test: `ppt/test_server.py`

**Interfaces:**
- Produces（Task 2/3 使用）：
  - `MAX_FILE`、`SCOPES = ("project", "global")`、`class BadIndex(Exception)`
  - `project_dir(deck) -> Path`、`home_dir() -> Path`、`root(deck, scope) -> Path`、`skills_root(deck, scope) -> Path`
  - `load(r) -> list`、`save(r, items)`
  - `check_file(name, typ, kind)`（ValueError）
  - `add_file(r, stream, length, name, typ, kind=None) -> (item, created)`
  - `add_url(r, url, typ, kind=None) -> (item, created)`、`add_deck(r, deck_dir) -> (item, created)`
  - `update(r, item_id, **fields) -> item`、`remove(r, item_id) -> item`
  - `extract(path) -> str`
  - `skills(deck) -> [{name, description, scope, path}]`、`selection(deck) -> [str]`、`set_selection(deck, names)`
  - `state(deck) -> {"project": {root, items, error}, "global": {…}, "decks": [str], "skills": [...], "enabled": [...]}`
  - `card(deck, scope, item_id) -> str`
  - `digest_event(deck, scope, item) -> dict`（`{type:"kb", kind:"digest", scope, kb_id, text, source, card, extracted?, snapshot?}`）

- [ ] **Step 1: 写失败的测试**

`ppt/test_server.py`：import 行加 `io, os, zipfile`（`import http.client, io, json, os, shutil, socket, sys, tempfile, threading, unittest, zipfile`），并在 `import build_icons` 之后加 `import kb`。在 `class CliTests` 之前加：

```python
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
```

- [ ] **Step 2: 运行，确认失败**

Run: `python ppt/test_server.py`
Expected: `ModuleNotFoundError: No module named 'kb'`

- [ ] **Step 3: 写 `ppt/kb.py`**

```python
"""ppt-maker knowledge base (stdlib only).

Project kb: <project>/kb, where project = deck/../.. (decks live in <project>/decks/<name>).
Global kb: ~/.ppt-maker/kb. Skills are Claude Code's own: <project>/.claude/skills and ~/.claude/skills.
PPT_PROJECT_DIR / PPT_HOME_DIR override the project directory and the home directory (tests).
Callers that run inside the server hold its LOCK; the CLI (--kb-done) may race it, which at worst
loses one of two simultaneous index writes: save() replaces the file atomically, so it never breaks.
"""
import hashlib, json, os, re, secrets, shutil, zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from xml.etree import ElementTree as ET

MAX_FILE = 50 * 1024 * 1024
OFFICE = {".docx", ".pptx", ".xlsx"}
EXTS = OFFICE | {".pdf", ".md", ".txt", ".csv", ".png", ".jpg", ".jpeg", ".gif", ".webp"}
KINDS = {"visual", "cite", "deck"}
SCOPES = ("project", "global")
ID = re.compile(r"k-[0-9a-z]{6}")
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
EXTRACT_ERRORS = (zipfile.BadZipFile, KeyError, IndexError, ValueError, ET.ParseError)


class BadIndex(Exception):
    """index.json exists but cannot be read: report it, never overwrite it."""


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def project_dir(deck):
    return Path(os.environ.get("PPT_PROJECT_DIR") or Path(deck).resolve().parent.parent)


def home_dir():
    return Path(os.environ.get("PPT_HOME_DIR") or Path.home())


def root(deck, scope):
    if scope not in SCOPES:
        raise ValueError(f"bad scope: {scope}")
    return project_dir(deck) / "kb" if scope == "project" else home_dir() / ".ppt-maker" / "kb"


def skills_root(deck, scope):
    if scope not in SCOPES:
        raise ValueError(f"bad scope: {scope}")
    return (project_dir(deck) if scope == "project" else home_dir()) / ".claude" / "skills"


def load(r):
    p = Path(r) / "index.json"
    if not p.exists():
        return []
    try:
        items = json.loads(p.read_text(encoding="utf-8"))
    except (ValueError, OSError) as e:
        raise BadIndex(f"index.json 无法读取：{e}") from e
    if not isinstance(items, list):
        raise BadIndex("index.json 不是列表")
    return items


def save(r, items):
    r = Path(r)
    r.mkdir(parents=True, exist_ok=True)
    tmp = r / f".index.{secrets.token_hex(4)}.tmp"
    tmp.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, r / "index.json")


def _new_id(items):
    taken = {i.get("id") for i in items}
    while True:
        k = "k-" + "".join(secrets.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(6))
        if k not in taken:
            return k


def safe_name(name):
    base = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", Path(str(name).replace("\\", "/")).name).strip(" .") or "file"
    stem, ext = os.path.splitext(base)
    return stem[:60] + ext.lower()


def _check_type(typ, kind, allowed):
    if typ not in allowed or (typ == "ref") != (kind in KINDS):
        raise ValueError("bad type/kind")


def check_file(name, typ, kind):
    ext = Path(safe_name(name)).suffix
    if ext not in EXTS:
        raise ValueError(f"暂不支持这种文件：{ext or name}")
    _check_type(typ, kind, {"file", "ref"})


def _paras(xml, p_tag, t_tag):
    out = []
    for p in ET.fromstring(xml).iter(p_tag):
        t = "".join(x.text or "" for x in p.iter(t_tag))
        if t.strip():
            out.append(t)
    return "\n".join(out)


def extract(path):
    """Plain text of a .docx / .pptx (by slide) / .xlsx (by sheet)."""
    path = Path(path)
    ext = path.suffix.lower()
    num = lambda n: int(re.search(r"(\d+)\.xml$", n).group(1))
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        if ext == ".docx":
            return _paras(z.read("word/document.xml"), W + "p", W + "t")
        if ext == ".pptx":
            slides = sorted((n for n in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)), key=num)
            return "\n\n".join(f"## 第 {i} 页\n{_paras(z.read(n), A + 'p', A + 't')}" for i, n in enumerate(slides, 1))
        if ext == ".xlsx":
            shared = []
            if "xl/sharedStrings.xml" in names:
                shared = ["".join(t.text or "" for t in si.iter(S + "t")) for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iter(S + "si")]
            titles = [s.get("name") for s in ET.fromstring(z.read("xl/workbook.xml")).iter(S + "sheet")]
            out = []
            for i, n in enumerate(sorted((n for n in names if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)), key=num)):
                rows = []
                for row in ET.fromstring(z.read(n)).iter(S + "row"):
                    cells = []
                    for c in row.iter(S + "c"):
                        v = c.find(S + "v")
                        if c.get("t") == "s" and v is not None:
                            cells.append(shared[int(v.text)])
                        elif c.get("t") == "inlineStr":
                            cells.append("".join(t.text or "" for t in c.iter(S + "t")))
                        else:
                            cells.append(v.text if v is not None and v.text else "")
                    rows.append("\t".join(cells))
                out.append(f"## 工作表 {titles[i] if i < len(titles) else i + 1}\n" + "\n".join(rows))
            return "\n\n".join(out)
    raise ValueError(f"not an office file: {ext}")


def add_file(r, stream, length, name, typ, kind=None):
    """Stream an upload into files/ (资料) or refs/ (参考); identical bytes in this kb return the existing item."""
    check_file(name, typ, kind)
    r = Path(r)
    items = load(r)
    item_id, fname = _new_id(items), safe_name(name)
    sub = r / ("files" if typ == "file" else "refs")
    sub.mkdir(parents=True, exist_ok=True)
    dest = sub / f"{item_id}-{fname}"
    h, left = hashlib.sha1(), length
    with dest.open("wb") as f:
        while left > 0:
            chunk = stream.read(min(65536, left))
            if not chunk:
                break
            h.update(chunk)
            f.write(chunk)
            left -= len(chunk)
    if left:
        dest.unlink()
        raise ValueError("上传不完整")
    sha = h.hexdigest()
    dup = next((i for i in items if i.get("sha1") == sha), None)
    if dup:
        dest.unlink()
        return dup, False
    item = {"id": item_id, "type": typ, **({"kind": kind} if typ == "ref" else {}), "title": Path(fname).stem,
            "summary": "", "status": "pending", "source": dest.relative_to(r).as_posix(), "sha1": sha, "added": now_iso()}
    if dest.suffix in OFFICE:
        try:
            (sub / f"{item_id}.txt").write_text(extract(dest), encoding="utf-8")
            item["text"] = f"{sub.name}/{item_id}.txt"
        except EXTRACT_ERRORS as e:
            item["note"] = f"文字抽取失败：{e}"
    items.append(item)
    save(r, items)
    return item, True


def _add_simple(r, fields):
    items = load(r)
    dup = next((i for i in items if i.get("source") == fields["source"] and i.get("type") == fields["type"]
                and i.get("kind") == fields.get("kind")), None)
    if dup:
        return dup, False
    item = {"id": _new_id(items), **fields, "summary": "", "status": "pending", "added": now_iso()}
    items.append(item)
    save(r, items)
    return item, True


def add_url(r, url, typ, kind=None):
    _check_type(typ, kind, {"web", "ref"})
    if typ == "ref" and kind != "cite":
        raise ValueError("网址只能作为出处")
    u = urlparse(str(url).strip())
    if u.scheme not in ("http", "https") or not u.netloc:
        raise ValueError("只接受 http(s) 网址")
    url = u.geturl()
    return _add_simple(r, {"type": typ, **({"kind": kind} if typ == "ref" else {}), "title": url, "source": url})


def add_deck(r, deck_dir):
    d = Path(deck_dir).resolve()
    if not (d / "deck.html").is_file():
        raise ValueError("不是 ppt-maker 的 deck 目录")
    return _add_simple(r, {"type": "ref", "kind": "deck", "title": d.name, "source": str(d)})


def _find(items, item_id):
    item = next((i for i in items if i.get("id") == item_id), None)
    if not item:
        raise ValueError(f"没有这条资料：{item_id}")
    return item


def update(r, item_id, **fields):
    items = load(r)
    item = _find(items, item_id)
    item.update(fields)
    save(r, items)
    return item


def _inside(r, rel):
    """Path of a kb-relative file, or None when it is a URL, absolute, or points outside the kb."""
    if not rel or re.match(r"https?://", rel) or Path(rel).is_absolute():
        return None
    p = (Path(r) / rel).resolve()
    return p if p.is_relative_to(Path(r).resolve()) and p.is_file() else None


def remove(r, item_id):
    items = load(r)
    item = _find(items, item_id)
    trash = Path(r) / ".trash" / item_id
    trash.mkdir(parents=True, exist_ok=True)
    for rel in (item.get("source"), item.get("text"), f"cards/{item_id}.md", f"web/{item_id}.md"):
        p = _inside(r, rel)
        if p:
            shutil.move(str(p), str(trash / p.name))
    (trash / "item.json").write_text(json.dumps(item, ensure_ascii=False), encoding="utf-8")
    save(r, [i for i in items if i is not item])
    return item


def _frontmatter(text):
    m = re.match(r"---\s*\n(.*?)\n---", text, re.S)
    meta = {}
    for line in m.group(1).splitlines() if m else []:
        k, sep, v = line.partition(":")
        if sep:
            meta[k.strip()] = v.strip().strip("'\"")
    return meta


def skills(deck):
    out = []
    for scope in SCOPES:
        base = skills_root(deck, scope)
        for f in sorted(base.glob("*/SKILL.md")) if base.is_dir() else []:
            meta = _frontmatter(f.read_text(encoding="utf-8", errors="replace"))
            out.append({"name": meta.get("name") or f.parent.name, "description": meta.get("description", ""),
                        "scope": scope, "path": str(f)})
    return out


def selection(deck):
    try:
        data = json.loads((Path(deck) / "kb.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    names = data.get("skills") if isinstance(data, dict) else None
    return [n for n in names if isinstance(n, str)] if isinstance(names, list) else []


def set_selection(deck, names):
    if not isinstance(names, list) or len(names) > 200 or not all(isinstance(n, str) and 0 < len(n) <= 100 for n in names):
        raise ValueError("bad skills")
    (Path(deck) / "kb.json").write_text(json.dumps({"skills": names}, ensure_ascii=False), encoding="utf-8")


def state(deck):
    out = {}
    for scope in SCOPES:
        r = root(deck, scope)
        try:
            out[scope] = {"root": str(r), "items": load(r), "error": None}
        except BadIndex as e:
            out[scope] = {"root": str(r), "items": [], "error": str(e)}
    decks = project_dir(deck) / "decks"
    here = Path(deck).resolve()
    out["decks"] = sorted(d.name for d in decks.iterdir() if (d / "deck.html").is_file() and d.resolve() != here) if decks.is_dir() else []
    out["skills"] = skills(deck)
    out["enabled"] = selection(deck)
    return out


def card(deck, scope, item_id):
    if not ID.fullmatch(str(item_id)):
        raise ValueError("bad id")
    return (root(deck, scope) / "cards" / f"{item_id}.md").read_text(encoding="utf-8")


def digest_event(deck, scope, item):
    """The event that asks Claude to read an item and write its card (absolute paths: any cwd works)."""
    r = root(deck, scope)
    src = item["source"]
    ev = {"type": "kb", "kind": "digest", "scope": scope, "kb_id": item["id"], "text": f"消化《{item['title']}》",
          "source": src if re.match(r"https?://", src) or Path(src).is_absolute() else str(r / src),
          "card": str(r / "cards" / f"{item['id']}.md")}
    if item.get("text"):
        ev["extracted"] = str(r / item["text"])
    if item.get("type") == "web":
        ev["snapshot"] = str(r / "web" / f"{item['id']}.md")
    return ev
```

- [ ] **Step 4: 运行，确认通过**

Run: `python ppt/test_server.py` → Expected: `Ran 63 tests … OK`（原 51 + 新 12）

- [ ] **Step 5: 提交**

```bash
git add ppt/kb.py ppt/test_server.py
git commit -m "feat(kb): knowledge base module — index, streamed uploads, office text, trash, skills, deck selection

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 服务端接口、命令行、事件

**Files:**
- Modify: `ppt/server.py`
- Test: `ppt/test_server.py`

**Interfaces:**
- Consumes: Task 1 全部。
- Produces：
  - `GET /api/kb` → `kb.state`；`GET /api/kb/card?scope=&id=` → `{text}`（404 不存在）。
  - `POST /api/kb/file?scope=&type=&kind=&name=`（原始字节流）→ `{item, created}`；400 / 403 / 409 / 413。
  - `POST /api/kb/add` `{scope, type, kind?, url?}` 或 `{scope, deck: "<decks 下的名字>"}` → `{item, created}`。
  - `POST /api/kb/remove` `{scope, id}` → `{item}`；`POST /api/kb/redigest` `{scope, id}` → `{item, created:true}`。
  - `PUT /api/kb/skills` `{skills:[…]}` → `{enabled}`；`POST /api/kb/skill` `{scope, text}` → `{id}`。
  - 新条目与重新消化都追加 `kb.digest_event` 到 inbox；`kb` 事件要回执（tail 补发）。
  - 命令行：`--kb-done <deck> <scope> <id> <title> <summary…>`、`--kb-fail <deck> <scope> <id> <reason…>`。
  - 意图事件可选字段 `kb`（≤ 20 个字符串，每个 ≤ 20 字）；摘要行附 ` kb:<ids>`。

- [ ] **Step 1: 写失败的测试**

`ppt/test_server.py`，在 `class CliTests` 之前加：

```python
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
        server.main(["--kb-done", str(self.deck), "project", kid, "年报", "营收", "12.3 亿"])
        self.assertEqual({k: kb.load(self.r)[0][k] for k in ("status", "title", "summary")}, {"status": "ready", "title": "年报", "summary": "营收 12.3 亿"})
        server.main(["--kb-fail", str(self.deck), "project", kid, "加密", "PDF"])
        self.assertEqual((kb.load(self.r)[0]["status"], kb.load(self.r)[0]["note"]), ("failed", "加密 PDF"))

    def test_intent_kb_field(self):
        self.assertEqual(self.req("POST", "/api/event?t=tok", {"type": "intent", "text": "x", "kb": ["k-abc123"]})[0], 200)
        e = inbox(self.deck)[-1]
        self.assertEqual(e["kb"], ["k-abc123"])
        self.assertIn("kb:k-abc123", server.summary(e))
        for bad in ([5], ["k" * 21], ["k-a"] * 21):
            self.assertEqual(self.req("POST", "/api/event?t=tok", {"type": "intent", "text": "x", "kb": bad})[0], 400)

    def test_tail_catches_up_kb_events(self):
        self.up(b"# x", "a.md")
        lines, done = [], threading.Event()
        th = threading.Thread(target=server.tail, args=(self.deck, lines.append, done.is_set, 0.05), daemon=True)
        th.start()
        _time.sleep(0.3)
        done.set()
        th.join(2)
        self.assertTrue(any(" kb kind:digest " in l for l in lines), lines)
```

并在文件顶部 import 区加：`from urllib.parse import quote`。

- [ ] **Step 2: 运行，确认失败**

Run: `python ppt/test_server.py` → Expected: `KbServerTests` 的 9 个测试 FAIL/ERROR（接口 404、`--kb-done` 未识别），其余 OK

- [ ] **Step 3: 实现 `ppt/server.py`**

1. import：在 `from urllib.parse import parse_qs, unquote, urlparse` 之后加 `import kb`（与 server.py 同目录，作为脚本运行和测试导入都能找到）。
2. 常量：`MAX_SHOT` 下面加 `DRAIN_MAX = 256 * 1024 * 1024  # read off (never store) an upload we refuse, up to this size`；`EVENT_TYPES` 下面加一行 `REPLY_TYPES = EVENT_TYPES | {"kb"}  # kb events are written by the server, not posted by the page`；`FIELD_TYPES` 增加 `"kb": list`。
3. `INJECT` 里 `'<script src="/_ppt/sketch.js" data-ppt></script>'` 之后加 `'<script src="/_ppt/kb-panel.js" data-ppt></script>'`。
4. `clean_event` 里 notes 校验之后加：

```python
    refs = ev.get("kb")
    if refs is not None and (len(refs) > 20 or not all(isinstance(k, str) and len(k) <= 20 for k in refs)):
        raise ValueError("bad kb")
```

5. `summary` 里 `notes = …` 之后加 `kbs = f" kb:{','.join(e['kb'])}" if e.get("kb") else ""`，并把 `{quote}{notes}` 改为 `{quote}{notes}{kbs}`。
6. `tail` 里补发未完成事件的那一行 `if e.get("type") in EVENT_TYPES and …` 改为 `REPLY_TYPES`。
7. `guard` 读请求体那段替换为（kb 上传不读进内存，由处理函数流式写盘；被拒时把它读掉，让客户端收到回复）：

```python
        self.stream_len = 0
        if self.command in ("POST", "PUT"):
            # read the body before any reply: closing with unread bytes makes Windows reset the
            # socket, and the client never sees our 403/404
            n = int(self.headers.get("Content-Length") or 0)
            if urlparse(self.path).path == "/api/kb/file":  # streamed to disk by the handler, after the checks below
                self.body, self.too_large, self.stream_len = b"", False, n
            else:
                self.too_large = n > MAX_BODY
                self.body = self.rfile.read(n) if 0 < n <= MAX_BODY else b""
                if self.too_large and n <= 4 * MAX_BODY:  # ponytail: bigger than 4x just gets the socket reset
                    drain(self.rfile, n)  # discarded in chunks, never held: the 413 still reaches the client
```

并在 `guard` 里两处 `self.send(403, …)` 之前各加一行 `self.discard_stream()`；在 `Handler` 里加：

```python
    def discard_stream(self):
        """A streamed upload we will not take: read it off the socket so the reply arrives."""
        if self.stream_len and self.stream_len <= DRAIN_MAX:
            drain(self.rfile, self.stream_len)
        self.stream_len = 0
```

8. `do_GET` 里 `if path == "/api/deck":` 之前加：

```python
        if path == "/api/kb":
            with LOCK:
                return self.send(200, kb.state(deck))
        if path == "/api/kb/card":
            q = parse_qs(url.query)
            try:
                return self.send(200, {"text": kb.card(deck, q.get("scope", [""])[0], q.get("id", [""])[0])})
            except (ValueError, OSError) as e:
                return self.send(404, {"error": str(e)})
```

9. `do_POST` 里 `if url.path == "/api/asset":` 之前加 `if url.path.startswith("/api/kb/"): return self.kb_post(url)`；`do_PUT` 里 `if url.path != "/api/deck":` 之前加：

```python
        if url.path == "/api/kb/skills":
            try:
                body = self.read_json()
                kb.set_selection(self.server.deck, body.get("skills") if isinstance(body, dict) else None)
            except ValueError as e:
                return self.send(400, {"error": str(e)})
            return self.send(200, {"enabled": kb.selection(self.server.deck)})
```

10. `Handler` 里加：

```python
    def kb_post(self, url):
        deck, q = self.server.deck, parse_qs(url.query)
        arg = lambda k: q.get(k, [""])[0]
        try:
            with LOCK:
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
                    item, created = kb.add_file(r, self.rfile, self.stream_len, arg("name"), arg("type"), arg("kind") or None)
                    self.stream_len = 0
                else:
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
```

11. `main` 里：`ap.add_argument("--ack", …)` 之后加

```python
    ap.add_argument("--kb-done", action="store_true", help="mark a kb item digested: <deck> <scope> <id> <title> <summary>")
    ap.add_argument("--kb-fail", action="store_true", help="mark a kb item failed: <deck> <scope> <id> <reason>")
```

在 `if a.reply:` 之前加：

```python
    if a.kb_done or a.kb_fail:
        if len(a.rest) < (4 if a.kb_done else 3):
            ap.error("--kb-done needs <scope> <id> <title> <summary>; --kb-fail needs <scope> <id> <reason>")
        scope, item_id = a.rest[0], a.rest[1]
        fields = ({"status": "ready", "title": a.rest[2], "summary": " ".join(a.rest[3:]), "note": ""} if a.kb_done
                  else {"status": "failed", "note": " ".join(a.rest[2:])})
        kb.update(kb.root(deck, scope), item_id, **fields)
        return print(f"{item_id}: {fields['status']}")
```

- [ ] **Step 4: 运行，确认通过**

Run: `python ppt/test_server.py` → Expected: `Ran 72 tests … OK`
Run: selftest → `PASS 99/99`；`node tests/e2e.mjs` → `126/126 passed`（页面多注入了 kb-panel.js 但它还不存在：404 不影响；e2e 的"no page JS errors"只看异常与 console.error。若 404 触发 console.error 而失败，记 Ruling 并把 Task 3 Step 3 的文件先建空壳）

- [ ] **Step 5: 提交**

```bash
git add ppt/server.py ppt/test_server.py
git commit -m "feat(kb): /api/kb endpoints, streamed uploads, digest/skill events, --kb-done/--kb-fail, intent kb field

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 知识库侧栏与接入编辑器

**Files:**
- Create: `ppt/kb-panel.js`
- Modify: `ppt/editor.js`、`ppt/toolbar.js`、`ppt/editor.css`
- Test: `tests/e2e.mjs`

**Interfaces:**
- Consumes: Task 2 全部接口；editor 的 `api / toast / openPop / submitIntent / currentSlide / slides / el / ui`。
- Produces：`window.PPTKB = { create(ui, cb) }`，`cb = {api(path), toast(msg), ask(ids, title)}`，返回 `{toggle(open?)}`。面板 class `ppt-kb`；标签按钮 class `ppt-kb-tab`、标题 `资料 / 参考 / Skills`；按钮标题：`选择文件（也可以拖进这里）`、`添加网址`、`添加这个旧 deck`、`查看 Claude 写的卡片`、`让 Claude 按这份资料改当前页`、`让 Claude 重新读这份资料`、`移到知识库的回收站`、`让 Claude 写这个 Skill`、`关闭知识库`；Skills 勾选框带 `data-skill`；顶栏按钮标题 `打开知识库`。

- [ ] **Step 1: 写失败的 e2e 测试**

`tests/e2e.mjs`：
1. `const PORT = 8800, DBG = 9333;` 之后加：

```js
const PROJ = path.join(SCRATCH, 'proj'), HOMEDIR = path.join(SCRATCH, 'home'); // the knowledge base under test, never the user's
const KB_ENV = { ...process.env, PPT_PROJECT_DIR: PROJ, PPT_HOME_DIR: HOMEDIR };
for (const [dir, file, text] of [[path.join(PROJ, '.claude', 'skills', 'brand'), 'SKILL.md', '---\nname: brand\ndescription: 公司品牌规范\n---\n主色蓝'],
  [path.join(HOMEDIR, '.claude', 'skills', 'consult'), 'SKILL.md', '---\nname: consult\ndescription: 咨询式汇报\n---\n'],
  [path.join(PROJ, 'decks', 'old'), 'deck.html', '<html><body></body></html>']]) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, file), text); }
```

2. `const py = (...a) => execFileSync('python', ['ppt/server.py', ...a], { cwd: REPO });` 改为 `…{ cwd: REPO, env: KB_ENV });`；`startServer` 里的 `spawn('python', […], { cwd: REPO })` 改为 `{ cwd: REPO, env: KB_ENV }`。

3. `// ---- add new checks above ----` 之前插入：

```js
  // ---- 4: knowledge base ----
  await open(url); await ev(`scrollTo(0, 0)`); await sleep(300);
  let b9 = await byTitle('打开知识库'); await click(b9.x, b9.y); await sleep(1000);
  check('B panel opens with three tabs', await ev(`!!document.querySelector('.ppt-kb:not([hidden])') && document.querySelectorAll('.ppt-kb-tab').length === 3`));
  const kbIndex = (scope) => { const f = path.join(scope === 'global' ? path.join(HOMEDIR, '.ppt-maker', 'kb') : path.join(PROJ, 'kb'), 'index.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : []; };
  const kbText = () => ev(`document.querySelector('.ppt-kb-body')?.textContent || ''`);
  const setKbFiles = async (files) => { const d = await send('DOM.getDocument'); const q = await send('DOM.querySelector', { nodeId: d.result.root.nodeId, selector: '.ppt-kb input[type=file]' }); await send('DOM.setFileInputFiles', { files, nodeId: q.result.nodeId }); };
  const mdPath = path.join(SCRATCH, '<b>年报</b>.md'.replace(/[<>/]/g, '_')); fs.writeFileSync(mdPath, '# 年报\n营收 12.3 亿，同比增长 18%。\n');
  await setKbFiles([mdPath]); await sleep(3000);
  const kb1 = kbIndex('project')[0];
  check('B upload: saved as pending, Claude asked to digest', kb1?.status === 'pending' && fs.existsSync(path.join(PROJ, 'kb', kb1.source))
    && inbox().some((e) => e.type === 'kb' && e.kind === 'digest' && e.kb_id === kb1.id), JSON.stringify(kb1));
  check('B panel shows 消化中', (await kbText()).includes('消化中'));
  fs.mkdirSync(path.join(PROJ, 'kb', 'cards'), { recursive: true }); fs.writeFileSync(path.join(PROJ, 'kb', 'cards', `${kb1.id}.md`), '## 摘要\n营收增长\n');
  py('--kb-done', 'decks/e2e-smoke', 'project', kb1.id, '<script>window.__x=1</script>年报', '营收 12.3 亿'); await sleep(3000);
  check('B after --kb-done: 就绪 and the summary', (await kbText()).includes('就绪') && (await kbText()).includes('营收 12.3 亿'));
  check('B titles are shown as text', (await kbText()).includes('<script>window.__x=1</script>年报') && (await ev(`window.__x`)) === undefined);
  b9 = await byTitle('查看 Claude 写的卡片'); await click(b9.x, b9.y); await sleep(1000);
  check('B card shown in the panel', ((await ev(`document.querySelector('.ppt-kb-card')?.textContent`)) || '').includes('营收增长'));
  await setKbFiles([mdPath]); await sleep(2500);
  check('B the same file again is not added twice', kbIndex('project').length === 1 && ((await ev(`[...document.querySelectorAll('.ppt-toast')].map((t) => t.textContent).join()`)) || '').includes('已在知识库里'));
  const urlBox = await rectOf('.ppt-kb input[placeholder^="粘贴网址"]'); await click(urlBox.x, urlBox.y); await type('https://example.com/report');
  await sleep(2500);
  check('B refresh keeps what you are typing', (await ev(`document.querySelector('.ppt-kb input[placeholder^="粘贴网址"]').value`)) === 'https://example.com/report');
  await enter(); await sleep(2500);
  check('B add a website', kbIndex('project').some((i) => i.type === 'web' && i.source === 'https://example.com/report'));
  b9 = await byTitle('参考'); await click(b9.x, b9.y); await sleep(800);
  await ev(`(() => { const s = document.querySelector('.ppt-kb select[title="旧 deck"]'); s.value = 'old'; })()`);
  b9 = await byTitle('添加这个旧 deck'); await click(b9.x, b9.y); await sleep(2500);
  check('B add an old deck as a reference', kbIndex('project').some((i) => i.type === 'ref' && i.kind === 'deck' && i.title === 'old') && (await kbText()).includes('old'));
  b9 = await byTitle('Skills'); await click(b9.x, b9.y); await sleep(1000);
  check('B project and global skills listed', (await kbText()).includes('公司品牌规范') && (await kbText()).includes('咨询式汇报'));
  await ev(`document.querySelector('.ppt-kb input[type=checkbox][data-skill="brand"]').click()`); await sleep(2000);
  check('B ticking a skill writes kb.json', (JSON.parse(fs.readFileSync(path.join(DECK, 'kb.json'), 'utf8')).skills || []).includes('brand'));
  const skBox = await rectOf('.ppt-kb textarea'); await click(skBox.x, skBox.y); await type('我们的汇报写法：结论先行');
  b9 = await byTitle('让 Claude 写这个 Skill'); await click(b9.x, b9.y); await sleep(2000);
  const skEv = inbox().at(-1);
  check('B new skill request goes to Claude', skEv?.type === 'kb' && skEv.kind === 'skill' && skEv.text === '我们的汇报写法：结论先行' && skEv.dir === path.join(PROJ, '.claude', 'skills'), JSON.stringify(skEv));
  b9 = await byTitle('资料'); await click(b9.x, b9.y); await sleep(1000);
  b9 = await byTitle('让 Claude 按这份资料改当前页'); await click(b9.x, b9.y); await sleep(400); await enter(); await sleep(2500);
  const kbIntent = inbox().filter((e) => e.type === 'intent').at(-1);
  check('B "用在这一页" sends an intent that names the item', JSON.stringify(kbIntent?.kb) === JSON.stringify([kb1.id]) && kbIntent.text === '按这份资料更新这一页', JSON.stringify({ ...kbIntent, shot: !!kbIntent?.shot }));
  b9 = await byTitle('移到知识库的回收站'); await click(b9.x, b9.y); await sleep(2500);
  check('B delete moves the item to the trash', !kbIndex('project').some((i) => i.id === kb1.id) && fs.existsSync(path.join(PROJ, 'kb', '.trash', kb1.id, 'item.json')));
  fs.mkdirSync(path.join(HOMEDIR, '.ppt-maker', 'kb'), { recursive: true }); fs.writeFileSync(path.join(HOMEDIR, '.ppt-maker', 'kb', 'index.json'), '{oops');
  await sleep(3000);
  check('B a broken global index is reported and left alone', (await kbText()).includes('无法读取') && fs.readFileSync(path.join(HOMEDIR, '.ppt-maker', 'kb', 'index.json'), 'utf8') === '{oops');
  b9 = await byTitle('关闭知识库'); await click(b9.x, b9.y); await sleep(300);
```

- [ ] **Step 2: 运行，确认失败**

Run: `node tests/e2e.mjs` → Expected: `script ran to the end` FAIL（找不到"打开知识库"），其余 PASS

- [ ] **Step 3: 写 `ppt/kb-panel.js`**

```js
// ppt-maker knowledge base panel: files, websites, references and Claude Code skills, per project and global.
// UI only: everything goes through /api/kb*; "用在这一页" hands an intent to editor.js through cb.ask.
(() => {
  const ICON = { file: '📄', web: '🌐', visual: '🖼', cite: '📎', deck: '🗂' };
  const STATUS = { pending: '消化中', ready: '就绪', failed: '失败' };
  const KIND_ZH = { visual: '视觉参考', cite: '出处', deck: '旧 deck' };
  const SCOPE_ZH = { project: '项目', global: '全局' };
  const MAX = 50 * 1024 * 1024;

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
    const panel = el('div', 'ppt-kb', ui); panel.hidden = true;
    const head = el('div', 'ppt-kb-head', panel);
    el('b', null, head, '📚 知识库');
    let tab = 'files', state = null, shown = '', timer = null, viewing = null, cardText = null, dropTo = null;
    const tabs = {};
    for (const [k, l] of [['files', '资料'], ['refs', '参考'], ['skills', 'Skills']]) tabs[k] = btn(head, l, l, () => { tab = k; viewing = null; build(); }, 'ppt-kb-tab');
    btn(head, '×', '关闭知识库', () => toggle(false));
    const body = el('div', 'ppt-kb-body', panel), add = el('div', 'ppt-kb-add', body), list = el('div', null, body);

    async function call(p, opts = {}) {
      const r = await fetch(cb.api(p) + (opts.query || ''), opts);
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || String(r.status));
      return data;
    }
    const send = (method, data) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    async function refresh() {
      try { state = await call('/api/kb'); } catch (e) { state = { error: e.message }; }
      const key = JSON.stringify([state, tab, viewing, cardText]);
      if (key !== shown) { shown = key; renderList(); }
    }

    function build() { // the add area is rebuilt only when the tab changes, so typing survives the 2 s refresh
      Object.entries(tabs).forEach(([k, b]) => b.classList.toggle('on', k === tab));
      add.textContent = ''; dropTo = null;
      const row = el('div', 'ppt-row', add);
      const scope = el('select', null, row); scope.title = '范围';
      Object.entries(SCOPE_ZH).forEach(([v, l]) => { el('option', null, scope, l).value = v; });
      if (tab === 'skills') {
        const ta = el('textarea', null, add); ta.placeholder = '新建 Skill：描述你要的方法或规范，例如"我们公司的品牌规范：主色……字体……"';
        btn(add, '让 Claude 写', '让 Claude 写这个 Skill', async () => {
          if (!ta.value.trim()) return;
          try { await call('/api/kb/skill', send('POST', { scope: scope.value, text: ta.value.trim() })); ta.value = ''; cb.toast('已发给 Claude，写好后会出现在列表里'); }
          catch (e) { cb.toast(`没有发出：${e.message}`); }
        }, 'ppt-ask');
        shown = ''; renderList(); return;
      }
      let kind = null;
      if (tab === 'refs') { kind = el('select', null, row); kind.title = '参考类型'; Object.entries(KIND_ZH).forEach(([v, l]) => { el('option', null, kind, l).value = v; }); }
      const file = el('input', null, row); file.type = 'file'; file.multiple = true; file.hidden = true;
      const upload = async (f) => {
        if (f.size > MAX) return cb.toast(`${f.name} 超过 50MB`);
        const typ = tab === 'files' ? 'file' : 'ref', k = tab === 'refs' ? kind.value : '';
        if (typ === 'ref' && k === 'deck' && !/\.(pptx|pdf)$/i.test(f.name)) return cb.toast('旧 deck 请上传 PPTX 或 PDF，或者从下面的列表里选');
        try {
          const r = await call('/api/kb/file', { method: 'POST', body: f, query: `&scope=${scope.value}&type=${typ}&kind=${k}&name=${encodeURIComponent(f.name)}` });
          if (!r.created) cb.toast(`《${r.item.title}》已在知识库里`);
          refresh();
        } catch (e) { cb.toast(`${f.name} 没有加入：${e.message}`); }
      };
      dropTo = upload;
      file.addEventListener('change', () => { [...file.files].forEach(upload); file.value = ''; });
      btn(row, '选择文件', '选择文件（也可以拖进这里）', () => file.click());
      const r2 = el('div', 'ppt-row', add);
      const url = el('input', null, r2); url.placeholder = tab === 'files' ? '粘贴网址，例如 https://…' : '出处网址 https://…';
      const addUrl = async () => {
        if (!url.value.trim()) return;
        try {
          const r = await call('/api/kb/add', send('POST', { scope: scope.value, type: tab === 'files' ? 'web' : 'ref', kind: tab === 'refs' ? 'cite' : undefined, url: url.value.trim() }));
          if (!r.created) cb.toast('这个网址已在知识库里');
          url.value = ''; refresh();
        } catch (e) { cb.toast(`没有加入：${e.message}`); }
      };
      url.addEventListener('keydown', (k) => { if (k.key === 'Enter') { k.preventDefault(); addUrl(); } });
      btn(r2, '添加', '添加网址', addUrl);
      if (tab === 'refs') {
        const r3 = el('div', 'ppt-row', add);
        const deck = el('select', null, r3); deck.title = '旧 deck';
        (state?.decks || []).forEach((n) => { el('option', null, deck, n).value = n; });
        btn(r3, '添加旧 deck', '添加这个旧 deck', async () => {
          if (!deck.value) return cb.toast('这个项目的 decks 里还没有别的 deck');
          try { const r = await call('/api/kb/add', send('POST', { scope: scope.value, deck: deck.value })); if (!r.created) cb.toast('这个 deck 已在知识库里'); refresh(); }
          catch (e) { cb.toast(`没有加入：${e.message}`); }
        });
      }
      shown = ''; renderList();
    }

    function renderList() {
      list.textContent = '';
      if (!state) return;
      if (state.error) { el('p', 'ppt-kb-err', list, `知识库读取失败：${state.error}`); return; }
      if (tab === 'skills') return renderSkills();
      for (const scope of Object.keys(SCOPE_ZH)) {
        const s = state[scope];
        el('div', 'who', list, SCOPE_ZH[scope]);
        if (s.error) { el('p', 'ppt-kb-err', list, s.error); continue; }
        const mine = s.items.filter((i) => (tab === 'refs') === (i.type === 'ref'));
        if (!mine.length) el('p', 'ppt-kb-empty', list, '（还没有）');
        mine.forEach((i) => renderItem(scope, i));
      }
    }
    function renderItem(scope, i) {
      const row = el('div', `ppt-kb-item ${i.status}`, list);
      const top = el('div', null, row);
      el('span', null, top, `${ICON[i.kind || i.type] || '📄'} `);
      el('b', null, top, i.title);
      el('span', `ppt-kb-status ${i.status}`, top, STATUS[i.status] || i.status);
      if (i.summary) el('p', null, row, i.summary);
      if (i.note) el('p', 'ppt-kb-err', row, i.note);
      const acts = el('div', 'ppt-kb-acts', row);
      const key = `${scope}:${i.id}`;
      if (i.status === 'ready') btn(acts, '卡片', '查看 Claude 写的卡片', async () => {
        if (viewing === key) { viewing = null; cardText = null; return refresh(); }
        try { cardText = (await call('/api/kb/card', { query: `&scope=${scope}&id=${i.id}` })).text; viewing = key; } catch (e) { cb.toast(`卡片打不开：${e.message}`); }
        refresh();
      });
      btn(acts, '用在这一页', '让 Claude 按这份资料改当前页', () => cb.ask([i.id], i.title));
      btn(acts, '重新消化', '让 Claude 重新读这份资料', () => act('/api/kb/redigest', scope, i.id));
      btn(acts, '删除', '移到知识库的回收站', () => act('/api/kb/remove', scope, i.id));
      if (viewing === key && cardText != null) el('pre', 'ppt-kb-card', row, cardText);
    }
    async function act(p, scope, id) {
      try { await call(p, send('POST', { scope, id })); } catch (e) { cb.toast(`没有完成：${e.message}`); }
      refresh();
    }
    function renderSkills() {
      const on = new Set(state.enabled || []);
      for (const scope of Object.keys(SCOPE_ZH)) {
        el('div', 'who', list, SCOPE_ZH[scope]);
        const mine = (state.skills || []).filter((s) => s.scope === scope);
        if (!mine.length) el('p', 'ppt-kb-empty', list, '（还没有）');
        for (const s of mine) {
          const row = el('label', 'ppt-kb-skill', list);
          const box = el('input', null, row); box.type = 'checkbox'; box.checked = on.has(s.name); box.dataset.skill = s.name;
          const text = el('span', null, row); el('b', null, text, s.name); if (s.description) el('div', null, text, s.description);
          box.addEventListener('change', async () => {
            const names = [...list.querySelectorAll('input[type=checkbox][data-skill]')].filter((b) => b.checked).map((b) => b.dataset.skill);
            try { await call('/api/kb/skills', send('PUT', { skills: [...new Set(names)] })); } catch (e) { cb.toast(`没有保存：${e.message}`); }
            refresh();
          });
        }
      }
    }

    panel.addEventListener('dragover', (e) => { if (dropTo) e.preventDefault(); });
    panel.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); if (dropTo) [...(e.dataTransfer?.files || [])].forEach(dropTo); });
    function toggle(open = panel.hidden) {
      panel.hidden = !open;
      clearInterval(timer); timer = null;
      if (!open) return;
      refresh().then(build);
      timer = setInterval(refresh, 2000);
    }
    return { toggle };
  }

  window.PPTKB = { create };
})();
```

- [ ] **Step 4: 接入 `ppt/editor.js`、`ppt/toolbar.js`、`ppt/editor.css`**

`editor.js`：
a. 工具栏回调对象里 `sketch: () => openSketch(currentSlide()), addSketchSlide,` 之后加 `kb: () => kbPanel.toggle(),`。
b. `addEventListener('scroll', () => tb.reposition(), { passive: true });` 之前加：

```js
  const kbPanel = PPTKB.create(ui, { api, toast, ask: askWithKb });
```

c. `async function submitIntent(slide, r, text, blocks = G.hitBlocks(slide, r)) {` 改为 `async function submitIntent(slide, r, text, blocks = G.hitBlocks(slide, r), extra = {}) {`，其中 `cells: G.rectToCells(r), blocks, text, shot });` 改为 `cells: G.rectToCells(r), blocks, text, shot, ...extra });`。
d. `function askSelected() {` 之前加：

```js
  function askWithKb(ids, title) { // from the knowledge base panel: "use this item on the current page"
    const s = currentSlide(), r = { x: 0, y: 0, w: G.W, h: G.H };
    openPop(s, r, el('div', 'ppt-abs ppt-sel', ui), `第 ${slides().indexOf(s) + 1} 页 · 参考《${title}》`,
      (text) => submitIntent(s, r, text, [], { kb: ids }), '按这份资料更新这一页');
  }
```

`toolbar.js`：`btn(top, '+草图页', '插入空白页并画草图', () => cb.addSketchSlide());` 之后加 `btn(top, '📚 知识库', '打开知识库', () => cb.kb());`

`editor.css` 末尾加：

```css
.ppt-kb { position: fixed; top: 48px; right: 0; bottom: 0; width: 360px; display: flex; flex-direction: column; background: #fff; border-left: 1px solid #d1d5db; box-shadow: -6px 0 20px rgba(0,0,0,.08); z-index: 2147483001; }
.ppt-kb-head { display: flex; align-items: center; gap: 4px; padding: 8px; border-bottom: 1px solid #e5e7eb; }
.ppt-kb-head b { margin-right: auto; }
.ppt-kb-tab.on { background: #dbeafe; }
.ppt-kb-body { flex: 1; overflow: auto; padding: 8px; }
.ppt-kb-add { border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 4px; }
.ppt-kb-body select, .ppt-kb-body input:not([type=checkbox]), .ppt-kb-body textarea { font: inherit; border: 1px solid #e5e7eb; border-radius: 6px; padding: 3px 6px; box-sizing: border-box; }
.ppt-kb-body .ppt-row { flex-wrap: nowrap; } .ppt-kb-body .ppt-row input, .ppt-kb-body .ppt-row select[title="旧 deck"] { flex: 1; min-width: 0; }
.ppt-kb-body textarea { width: 100%; min-height: 64px; resize: vertical; margin-bottom: 4px; }
.ppt-kb-item { border: 1px solid #e5e7eb; border-radius: 8px; padding: 6px 8px; margin: 6px 0; }
.ppt-kb-item p { margin: 4px 0 0; color: #374151; }
.ppt-kb-status { float: right; font-size: 12px; padding: 0 6px; border-radius: 999px; background: #fef3c7; }
.ppt-kb-status.ready { background: #dcfce7; } .ppt-kb-status.failed { background: #fee2e2; }
.ppt-kb-err { color: #dc2626; } .ppt-kb-empty { color: #9ca3af; margin: 4px 0; }
.ppt-kb-acts { margin-top: 4px; } .ppt-kb-acts .ppt-btn { font-size: 12px; padding: 1px 6px; }
.ppt-kb-card { white-space: pre-wrap; font: 12px/1.5 Consolas, "Microsoft YaHei", monospace; background: #f9fafb; border-radius: 6px; padding: 6px; max-height: 240px; overflow: auto; }
.ppt-kb-skill { display: flex; gap: 6px; align-items: flex-start; margin: 6px 0; cursor: pointer; }
```

- [ ] **Step 5: 运行，确认通过**

Run: `node tests/e2e.mjs` → Expected: `142/142 passed`（126 + 16）
Run: `python ppt/test_server.py` → `OK`（72）；selftest → `PASS 99/99`

- [ ] **Step 6: 提交**

```bash
git add ppt/kb-panel.js ppt/editor.js ppt/toolbar.js ppt/editor.css tests/e2e.mjs
git commit -m "feat(kb): knowledge base panel — files, websites, references, skills; use an item on the current page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `ppt.md` 规则与真实会话验收

**Files:**
- Modify: `.claude/commands/ppt.md`

- [ ] **Step 1: `ppt.md`**

"处理事件"一节第一条"处理 intent / answer / lint 之前先标记"改为"处理 intent / answer / lint / kb 之前先标记"。在"处理事件"一节末尾（"用户在终端直接说的话照常执行"那条之前）加：

```markdown
- **kb 事件 `kind:digest`**：消化一条资料。读 `source`（PDF 用 Read 按页读；图片直接看；有 `extracted` 时读这份抽出的文字；网址用 WebFetch 抓取，把标题、网址和正文写进 `snapshot`；旧 deck 的 `source` 是目录，读其中的 deck.html）。把卡片写到 `card`：frontmatter `id / type / title / source`，正文 `## 摘要`、`## 要点`、`## 可引用`（每条带位置，如 `- [p.12] 营收 12.3 亿`，网页写段落或小标题）；视觉参考和旧 deck 另写 `## 风格`（版式、配色、字体、结构）。然后 `python ppt/server.py --kb-done "decks/<名字>" <scope> <kb_id> "<标题>" "<一句话摘要>"` 并回执。读不了（加密、打不开、内容为空）就 `--kb-fail "decks/<名字>" <scope> <kb_id> "<原因>"` 并回执说明。
- **kb 事件 `kind:skill`**：按 Claude Code Skills 的格式在 `dir/<英文短名>/SKILL.md` 写一个 skill：frontmatter `name`（与目录名相同）、`description`（一句话说明何时使用），正文把用户描述的规则写清楚、可执行。回执里告诉用户名字，并提醒在知识库面板的 Skills 页勾选。
- **intent 带 `kb`**：用户指定了资料（id 列表），优先读这些卡片，按用户的话决定改哪里。
```

在"deck.html 格式规则"之前加一节：

```markdown
## 知识库
- 位置：项目知识库 `<项目>/kb/`（项目 = deck 目录往上两层），全局 `~/.ppt-maker/kb/`；各含 `index.json`（总目录）、`cards/`（卡片）、`files/`、`web/`、`refs/`。Skills 在 `<项目>/.claude/skills/` 和 `~/.claude/skills/`；本 deck 启用的列在 `decks/<名字>/kb.json` 的 `skills`。
- 新建 deck、处理每个 intent / answer 之前：读两个 `index.json`（不存在就是空）和本 deck 的 `kb.json`；读启用的 `SKILL.md` 并严格遵守；按意图读相关卡片；用到精确数字或原文时回到原件（`source` / `extracted` / `web/<id>.md`）核对。
- 用了知识库里的事实，就在该块底部加一行出处：`<p style="font-size:12px;margin:4px 0 0;color:var(--muted)">来源：《标题》p.12</p>`；用户要求时做一页"参考资料"。知识库里没有的事实不要编，在回执里说明缺什么。
- 新建 deck，或用户要求参考某种风格时，按视觉参考 / 旧 deck 卡片的 `## 风格` 调整 `#theme` 和版式；复用旧 deck 的页面时复制过来并换成新 id。
- 用户在终端说"把 X 加进知识库"：把原件放进 `files/`（或 `refs/`），在 `index.json` 加一条（字段同面板添加的条目，`status: "pending"`），然后照 digest 的做法写卡片、`--kb-done`。
```

- [ ] **Step 2: 全套测试并提交**

Run: `python ppt/test_server.py` → `OK`（72）；selftest → `PASS 99/99`；`node tests/e2e.mjs` → `142/142 passed`

```bash
git add .claude/commands/ppt.md
git commit -m "docs(kb): ppt.md rules for digesting, skills and using the knowledge base

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 3: 真实会话验收（副本，验完删除）**

1. 在 scratchpad 建一个临时项目目录 `kbproj/`，从模板建 `kbproj/decks/验收-4/deck.html`；后台启动 `python <repo>/ppt/server.py "<kbproj>/decks/验收-4" --no-open --port 8812`（**不设** `PPT_*` 变量，验证真实路径推算；全局知识库用 `PPT_HOME_DIR` 指到 scratchpad 的 `kbhome/`，以免写进用户主目录），Monitor 挂 `--tail`（同样的环境变量）。
2. 用临时驱动脚本：上传一份 PDF（scratchpad 里用 Edge `--print-to-pdf` 把一页含数据的 HTML 打印成 PDF）；添加一个网址 `https://example.com`；在 Skills 页新建"品牌规范：标题用深蓝 #1e3a8a，正文不超过 3 行"，项目级。
3. Claude 端按 `ppt.md`：消化 PDF（写卡片、`--kb-done`）；抓网页（写快照、卡片、`--kb-done`）；写 SKILL.md。驱动脚本勾选该 Skill。
4. 对 PDF 条目点"用在这一页"→ Claude 按卡片改封面：数字来自 PDF、带出处、标题深蓝、正文 ≤ 3 行。
5. 停服务与监听，确认目录后删除 `kbproj/`、`kbhome/`。

Expected: 页面无 JS 错误；inbox 依次有 kb digest ×2、kb skill、intent（kb 字段）；卡片与 SKILL.md 存在；封面满足 4。
