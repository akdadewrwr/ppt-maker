"""ppt-maker HTML import (stdlib only): store an uploaded .html / .zip safely under decks/<name>/imports/<id>/,
pick its entry page and guess what it is. Claude does the conversion; this only lands the files."""
import os, re, secrets, shutil, zipfile
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse

import kb

MAX_IMPORT = 50 * 1024 * 1024  # bytes uploaded, and bytes written when a zip is unpacked
MAX_FILES = 2000
MODES = ("append", "replace")
EXTS = (".html", ".htm", ".zip")


def check_name(name):
    ext = Path(kb.safe_name(name)).suffix
    if ext not in EXTS:
        raise ValueError("只能导入 .html、.htm 或 .zip")
    return ext


def _new_id(base):
    while True:
        iid = "i-" + "".join(secrets.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(6))
        if not (base / iid).exists():
            return iid


def _copy_exact(stream, out, length):
    """Copy an upload of a known length; returns the bytes still missing (0 when complete)."""
    left = length
    while left > 0:
        chunk = stream.read(min(65536, left))
        if not chunk:
            break
        out.write(chunk)
        left -= len(chunk)
    return left


def _copy_capped(src, out, budget):
    """Copy a zip member counting the bytes really written: a zip header can lie about its sizes."""
    while True:
        chunk = src.read(65536)
        if not chunk:
            return budget
        budget -= len(chunk)
        if budget < 0:
            raise ValueError("压缩包解压后超过 50MB")
        out.write(chunk)


def _unzip(zpath, d):
    with zipfile.ZipFile(zpath) as z:
        infos = [i for i in z.infolist() if not i.is_dir()]
        if len(infos) > MAX_FILES:
            raise ValueError("压缩包里文件太多")
        budget = MAX_IMPORT
        for i in infos:
            name = i.filename.replace("\\", "/")
            parts = PurePosixPath(name).parts
            if name.startswith("/") or re.match(r"^[A-Za-z]:", name) or ".." in parts:
                raise ValueError(f"压缩包里有不安全的路径：{i.filename}")
            dest = d.joinpath(*parts).resolve()
            if not dest.is_relative_to(d.resolve()):
                raise ValueError(f"压缩包里有不安全的路径：{i.filename}")
            dest.parent.mkdir(parents=True, exist_ok=True)
            with z.open(i) as src, dest.open("wb") as out:
                budget = _copy_capped(src, out, budget)
    pages = [p for p in d.rglob("*") if p.is_file() and p.suffix.lower() in (".html", ".htm")]
    if not pages:
        raise ValueError("压缩包里没有 HTML")
    return min(pages, key=lambda p: (len(p.relative_to(d).parts), p.name.lower() != "index.html", p.as_posix()))


def save(deck, stream, length, name):
    """Land an upload: (import id, its folder, the entry html). Nothing is left behind on failure."""
    ext = check_name(name)
    base = Path(deck) / "imports"
    base.mkdir(parents=True, exist_ok=True)
    iid = _new_id(base)
    d = base / iid
    d.mkdir()
    try:
        tmp = d / f".upload{ext}"
        with tmp.open("wb") as out:
            missing = _copy_exact(stream, out, length)
        if missing:
            raise ValueError("上传不完整")
        if ext == ".zip":
            entry = _unzip(tmp, d)
            tmp.unlink()
        else:
            entry = d / kb.safe_name(name)
            os.replace(tmp, entry)
        return iid, d, entry
    except BaseException:
        shutil.rmtree(d, ignore_errors=True)
        raise


def hint(text):
    """What the html looks like, so Claude knows how to read it."""
    if re.search(r'<section[^>]*class="[^"]*\bslide\b', text) and re.search(r'id=["\']theme["\']', text):
        return "ppt-maker"
    if re.search(r'class="[^"]*\breveal\b|data-marpit|slidev', text, re.I) or len(re.findall(r"<section\b", text, re.I)) >= 3:
        return "slides"
    return "page"


def event(deck, iid, d, entry, mode):
    h = hint(entry.read_text(encoding="utf-8", errors="replace")[:2_000_000])
    return {"type": "import", "kind": "file", "mode": mode, "hint": h, "import_id": iid, "text": f"导入《{entry.name}》{mode} {h}",
            "source": str(entry), "dir": str(d), "original": "/imports/" + entry.relative_to(Path(deck) / "imports").as_posix()}


def url_event(url, mode):
    u = urlparse(str(url).strip())
    if u.scheme not in ("http", "https") or not u.netloc:
        raise ValueError("只接受 http(s) 网址")
    return {"type": "import", "kind": "url", "mode": mode, "text": f"导入 {u.geturl()} {mode}", "source": u.geturl()}
