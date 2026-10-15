"""ppt-maker knowledge base (stdlib only).

Project kb: <project>/kb, where project = deck/../.. (decks live in <project>/decks/<name>).
Global kb: ~/.ppt-maker/kb. Skills are Claude Code's own: <project>/.claude/skills and ~/.claude/skills.
PPT_PROJECT_DIR / PPT_HOME_DIR override the project directory and the home directory (tests).
Index writes are read-modify-write inside the server's LOCK; the CLI (--kb-done / --kb-add) runs in its own
process and can still race it, losing at worst one of two simultaneous writes. save() replaces the file
atomically (retrying while Windows has it open), so index.json is never left broken.
"""
import hashlib, json, os, re, secrets, shutil, time, zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from xml.etree import ElementTree as ET

MAX_FILE = 50 * 1024 * 1024
MAX_TEXT_OUT = 2_000_000  # characters of text extracted from one Office file; the rest is cut
OFFICE = {".docx", ".pptx", ".xlsx"}
EXTS = OFFICE | {".pdf", ".md", ".txt", ".csv", ".png", ".jpg", ".jpeg", ".gif", ".webp"}
KINDS = {"visual", "cite", "deck"}
SCOPES = ("project", "global")
ID = re.compile(r"k-[0-9a-z]{6}")
URL = re.compile(r"https?://\S+")
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


class BadIndex(Exception):
    """index.json exists but cannot be read: report it, never overwrite it."""


class _Full(Exception):
    """Extracted text reached MAX_TEXT_OUT."""


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
    for attempt in range(10):
        try:
            os.replace(tmp, r / "index.json")
            return
        except PermissionError:  # Windows: another process has index.json open for a moment
            if attempt == 9:
                tmp.unlink(missing_ok=True)
                raise
            time.sleep(0.05)


def _new_id(items):
    taken = {i.get("id") for i in items if isinstance(i, dict)}
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


def _paras(z, member, p_tag, t_tag, put):
    """Stream one XML part: each paragraph's text on its own line (bounded memory, stops at the cap)."""
    first = True
    with z.open(member) as f:  # closed even when the cap stops us early: an open member keeps the zip file locked
        for _, el in ET.iterparse(f, events=("end",)):
            if el.tag == p_tag:
                t = "".join(x.text or "" for x in el.iter(t_tag))
                if t.strip():
                    put(t if first else "\n" + t)
                    first = False
                el.clear()


def _xlsx(z, names, put):
    shared = []
    if "xl/sharedStrings.xml" in names:
        with z.open("xl/sharedStrings.xml") as f:
            for _, el in ET.iterparse(f, events=("end",)):
                if el.tag == S + "si":
                    shared.append("".join(t.text or "" for t in el.iter(S + "t")))
                    el.clear()
    titles = [s.get("name") for s in ET.fromstring(z.read("xl/workbook.xml")).iter(S + "sheet")]
    num = lambda n: int(re.search(r"(\d+)\.xml$", n).group(1))
    for i, n in enumerate(sorted((n for n in names if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)), key=num)):
        put(("\n\n" if i else "") + f"## 工作表 {titles[i] if i < len(titles) else i + 1}")
        with z.open(n) as f:
            for _, row in ET.iterparse(f, events=("end",)):
                if row.tag != S + "row":
                    continue
                cells = []
                for c in row.iter(S + "c"):
                    v = c.find(S + "v")
                    if c.get("t") == "s" and v is not None:
                        cells.append(shared[int(v.text)])
                    elif c.get("t") == "inlineStr":
                        cells.append("".join(t.text or "" for t in c.iter(S + "t")))
                    else:
                        cells.append(v.text if v is not None and v.text else "")
                put("\n" + "\t".join(cells))
                row.clear()


def extract(path):
    """Plain text of a .docx / .pptx (by slide) / .xlsx (by sheet), at most MAX_TEXT_OUT characters."""
    path = Path(path)
    ext, out, size = path.suffix.lower(), [], [0]

    def put(s):
        out.append(s)
        size[0] += len(s)
        if size[0] > MAX_TEXT_OUT:
            raise _Full

    num = lambda n: int(re.search(r"(\d+)\.xml$", n).group(1))
    try:
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
            if ext == ".docx":
                _paras(z, "word/document.xml", W + "p", W + "t", put)
            elif ext == ".pptx":
                for i, n in enumerate(sorted((n for n in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)), key=num), 1):
                    put(("\n\n" if i > 1 else "") + f"## 第 {i} 页\n")
                    _paras(z, n, A + "p", A + "t", put)
            elif ext == ".xlsx":
                _xlsx(z, names, put)
            else:
                raise ValueError(f"not an office file: {ext}")
    except _Full:
        return "".join(out)[:MAX_TEXT_OUT] + "\n（已截断）"
    return "".join(out)


def receive(r, stream, length, name, typ, kind=None):
    """Stream an upload into a temp file inside the kb and extract its text. Touches no index, so the
    server runs it outside its LOCK; commit_file() then files it under the lock."""
    check_file(name, typ, kind)
    r = Path(r)
    r.mkdir(parents=True, exist_ok=True)
    fname = safe_name(name)
    tmp = r / f".upload.{secrets.token_hex(4)}{Path(fname).suffix}"
    h, left = hashlib.sha1(), length
    try:
        with tmp.open("wb") as f:
            while left > 0:
                chunk = stream.read(min(65536, left))
                if not chunk:
                    break
                h.update(chunk)
                f.write(chunk)
                left -= len(chunk)
        if left:
            raise ValueError("上传不完整")
        up = {"tmp": tmp, "sha1": h.hexdigest(), "name": fname, "type": typ, "kind": kind, "text": None, "note": None}
        if tmp.suffix in OFFICE:
            try:
                up["text"] = extract(tmp)
            except Exception as e:  # best effort: a file we cannot read is still kept, with the reason
                up["note"] = f"文字抽取失败：{e}"
        return up
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def commit_file(r, up):
    """Dedupe against the current index, move the upload into files/ (资料) or refs/ (参考), save."""
    r, made = Path(r), []
    try:
        items = load(r)
        dup = next((i for i in items if isinstance(i, dict) and i.get("sha1") == up["sha1"]), None)
        if dup:
            return dup, False
        item_id = _new_id(items)
        sub = r / ("files" if up["type"] == "file" else "refs")
        sub.mkdir(parents=True, exist_ok=True)
        dest = sub / f"{item_id}-{up['name']}"
        os.replace(up["tmp"], dest)
        made.append(dest)
        item = {"id": item_id, "type": up["type"], **({"kind": up["kind"]} if up["type"] == "ref" else {}),
                "title": Path(up["name"]).stem, "summary": "", "status": "pending",
                "source": dest.relative_to(r).as_posix(), "sha1": up["sha1"], "added": now_iso()}
        if up["text"] is not None:
            txt = sub / f"{item_id}.txt"
            txt.write_text(up["text"], encoding="utf-8")
            made.append(txt)
            item["text"] = f"{sub.name}/{item_id}.txt"
        if up["note"]:
            item["note"] = up["note"]
        items.append(item)
        save(r, items)
        return item, True
    except BaseException:
        for p in made:  # never leave a file the index does not know about
            p.unlink(missing_ok=True)
        raise
    finally:
        up["tmp"].unlink(missing_ok=True)


def add_file(r, stream, length, name, typ, kind=None):
    """receive + commit_file in one go (tests, the CLI)."""
    return commit_file(r, receive(r, stream, length, name, typ, kind))


def _add_simple(r, fields):
    items = load(r)
    dup = next((i for i in items if isinstance(i, dict) and i.get("source") == fields["source"] and i.get("type") == fields["type"]
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
    if not isinstance(item_id, str) or not ID.fullmatch(item_id):  # ids reach the filesystem (.trash/<id>)
        raise ValueError(f"bad id: {item_id}")
    item = next((i for i in items if isinstance(i, dict) and i.get("id") == item_id), None)
    if not item:
        raise ValueError(f"没有这条资料：{item_id}")
    return item


def get(r, item_id):
    return _find(load(r), item_id)


def update(r, item_id, **fields):
    items = load(r)
    item = _find(items, item_id)
    item.update(fields)
    save(r, items)
    return item


def _inside(r, rel):
    """Path of a kb-relative file, or None when it is a URL, absolute, or points outside the kb."""
    if not isinstance(rel, str) or not rel or URL.match(rel) or Path(rel).is_absolute():
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


def _source(deck, r, item):
    """Where Claude may read an item: a file inside this kb, an http(s) URL (web / citation),
    or a deck folder of this project. A hand-edited index pointing anywhere else is refused."""
    src, kind = item.get("source"), item.get("kind")
    if not isinstance(src, str) or not src:
        raise ValueError("条目缺少原件")
    if URL.fullmatch(src) and (item.get("type") == "web" or kind == "cite"):
        return src
    if kind == "deck" and Path(src).is_absolute():
        d = Path(src).resolve()
        if d.is_relative_to((project_dir(deck) / "decks").resolve()) and (d / "deck.html").is_file():
            return str(d)
        raise ValueError("旧 deck 不在本项目的 decks 里")
    if _inside(r, src) is None:
        raise ValueError("原件不在知识库里")
    return str(r / src)


def digest_event(deck, scope, item):
    """The event that asks Claude to read an item and write its card (absolute paths: any cwd works)."""
    r = root(deck, scope)
    ev = {"type": "kb", "kind": "digest", "scope": scope, "kb_id": item.get("id"), "text": f"消化《{item.get('title', '')}》",
          "source": _source(deck, r, item), "card": str(r / "cards" / f"{item.get('id')}.md")}
    if item.get("text"):
        if _inside(r, item["text"]) is None:
            raise ValueError("抽取的文字不在知识库里")
        ev["extracted"] = str(r / item["text"])
    if item.get("type") == "web":
        ev["snapshot"] = str(r / "web" / f"{item.get('id')}.md")
    return ev
