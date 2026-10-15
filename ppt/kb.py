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
