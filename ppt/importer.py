"""ppt-maker HTML import (stdlib only): store an uploaded .html / .zip safely under decks/<name>/imports/<id>/,
pick its entry page and guess what it is. Claude does the conversion; this only lands the files."""
import json, os, re, secrets, shutil, subprocess, tempfile, zipfile, zlib
from pathlib import Path, PurePosixPath
from urllib.parse import quote, urlparse

import kb
from exporter import Missing, need_pptx  # noqa: F401  (Missing: callers catch it from here too)

MAX_IMPORT = 50 * 1024 * 1024  # bytes uploaded, and bytes written when a zip is unpacked
MAX_FILES = 2000
MODES = ("append", "replace")
EXTS = (".html", ".htm", ".zip", ".pptx")


def check_name(name):
    ext = Path(kb.safe_name(name)).suffix.lower()
    if ext == ".ppt":
        raise ValueError("请先在 PowerPoint 里另存为 .pptx")
    if ext not in EXTS:
        raise ValueError("只能导入 .html、.htm、.zip 或 .pptx")
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
    try:
        return _unzip_checked(zpath, d)
    except (zipfile.BadZipFile, zlib.error, RuntimeError, NotImplementedError, EOFError) as e:  # damaged or encrypted
        raise ValueError(f"压缩包损坏或已加密：{e}") from e
    except OSError as e:  # e.g. a file and a folder with the same name
        raise ValueError(f"压缩包里有无法解开的条目：{e}") from e


def _unzip_checked(zpath, d):
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
    tmp = base / f".{iid}.upload{ext}"  # outside the folder a zip unpacks into: no member can collide with it
    try:
        with tmp.open("wb") as out:
            missing = _copy_exact(stream, out, length)
        if missing:
            raise ValueError("上传不完整")
        if ext == ".zip":
            entry = _unzip(tmp, d)
        else:
            entry = d / kb.safe_name(name)
            os.replace(tmp, entry)
        return iid, d, entry
    except BaseException:
        shutil.rmtree(d, ignore_errors=True)
        raise
    finally:
        tmp.unlink(missing_ok=True)


EMU_PER_IN = 914400


def soffice():
    for p in ("C:/Program Files/LibreOffice/program/soffice.exe", "C:/Program Files (x86)/LibreOffice/program/soffice.exe"):
        if Path(p).is_file():
            return p
    return shutil.which("soffice") or shutil.which("libreoffice")


def render_pdf(path, out_dir):
    """slides.pdf next to the import so Claude can see each page; None when LibreOffice is missing or slow."""
    exe = soffice()
    if not exe:
        return None
    prof = Path(tempfile.mkdtemp(prefix="ppt-lo-"))  # own profile: a LibreOffice the user has open locks the default one
    try:
        subprocess.run([exe, f"-env:UserInstallation={prof.as_uri()}", "--headless", "--convert-to", "pdf", "--outdir", str(out_dir), str(path)],
                       capture_output=True, timeout=60)
        made = Path(out_dir) / (Path(path).stem + ".pdf")
        if not made.is_file():
            return None
        dst = Path(out_dir) / "slides.pdf"
        os.replace(made, dst)
        return dst
    except (OSError, subprocess.SubprocessError):
        return None
    finally:
        shutil.rmtree(prof, ignore_errors=True)


def pptx_extract(path, out_dir):
    """Every slide's elements in canvas pixels (width 1280) -> slides.json; pictures -> media/."""
    need_pptx()
    from pptx import Presentation
    from pptx.enum.shapes import MSO_SHAPE_TYPE
    from pptx.oxml.ns import qn
    try:
        prs = Presentation(str(path))
        slides = list(prs.slides)
    except Exception as e:  # zip, xml or package errors: python-pptx raises many kinds
        raise ValueError("无法读取这个 pptx") from e
    if not slides:
        raise ValueError("无法读取这个 pptx")
    k = 1280 / prs.slide_width
    w_in, h_in = prs.slide_width / EMU_PER_IN, prs.slide_height / EMU_PER_IN
    ratio = "16:9" if abs(w_in / h_in - 16 / 9) < 0.02 else "4:3" if abs(w_in / h_in - 4 / 3) < 0.02 else f"{w_in:.2f}x{h_in:.2f}in"
    media = Path(out_dir) / "media"
    media.mkdir(parents=True, exist_ok=True)
    n_pic = [0]

    def color(fmt):
        try:
            return str(fmt.rgb)
        except (AttributeError, TypeError, ValueError):
            try:
                return {"theme": str(fmt.theme_color)}
            except (AttributeError, TypeError, ValueError):
                return None

    def paras(tf):
        out = []
        for p in tf.paragraphs:
            pPr = p._p.pPr
            bullet = pPr is not None and (pPr.find(qn("a:buChar")) is not None or pPr.find(qn("a:buAutoNum")) is not None)
            out.append({"align": str(p.alignment) if p.alignment is not None else None, "level": p.level, "bullet": bullet,
                        "runs": [{"t": r.text, "size": round(r.font.size * k, 1) if r.font.size else None, "b": r.font.bold, "i": r.font.italic,
                                  "color": color(r.font.color) if r.font.color and r.font.color.type is not None else None, "font": r.font.name}
                                 for r in p.runs]})
        return out

    def walk(shapes, ax, ay, bx, by, items):  # (ax, ay, bx, by): child EMU -> page EMU for nested groups
        for sh in shapes:
            x0, y0 = sh.left or 0, sh.top or 0
            g = {"name": sh.name, "x": round((ax + bx * x0) * k, 1), "y": round((ay + by * y0) * k, 1),
                 "w": round(bx * (sh.width or 0) * k, 1), "h": round(by * (sh.height or 0) * k, 1), "rotation": round(getattr(sh, "rotation", 0) or 0, 1)}
            st = sh.shape_type
            if st == MSO_SHAPE_TYPE.GROUP:
                xf = sh._element.grpSpPr.find(qn("a:xfrm"))
                off, ext, choff, chext = (xf.find(qn(t)) for t in ("a:off", "a:ext", "a:chOff", "a:chExt"))
                sx = int(ext.get("cx")) / max(1, int(chext.get("cx")))
                sy = int(ext.get("cy")) / max(1, int(chext.get("cy")))
                walk(sh.shapes, ax + bx * (int(off.get("x")) - int(choff.get("x")) * sx), ay + by * (int(off.get("y")) - int(choff.get("y")) * sy), bx * sx, by * sy, items)
                continue
            if hasattr(sh, "image"):
                try:
                    img = sh.image
                except (AttributeError, ValueError, KeyError):
                    img = None
                if img is not None:
                    n_pic[0] += 1
                    name = f"img-{n_pic[0]}.{img.ext}"
                    (media / name).write_bytes(img.blob)
                    items.append({**g, "kind": "picture", "file": f"media/{name}"})
                    continue
            if getattr(sh, "has_table", False) and sh.has_table:
                items.append({**g, "kind": "table", "cells": [[c.text for c in r.cells] for r in sh.table.rows]})
            elif getattr(sh, "has_chart", False) and sh.has_chart:
                items.append({**g, "kind": "unsupported", "type": "chart"})
            elif st in (MSO_SHAPE_TYPE.LINE,) or sh.__class__.__name__ == "Connector":
                items.append({**g, "kind": "line", "color": color(sh.line.color) if sh.line.color.type is not None else None})
            elif st in (MSO_SHAPE_TYPE.AUTO_SHAPE, MSO_SHAPE_TYPE.TEXT_BOX, MSO_SHAPE_TYPE.PLACEHOLDER, MSO_SHAPE_TYPE.FREEFORM):
                try:
                    shape = str(sh.auto_shape_type).split(" (")[0] if st == MSO_SHAPE_TYPE.AUTO_SHAPE else None  # 0.6.23 enums: "OVAL (9)"
                except (ValueError, AttributeError):
                    shape = None
                try:
                    fill = color(sh.fill.fore_color) if sh.fill.type == 1 else None  # MSO_FILL.SOLID
                except (AttributeError, TypeError):
                    fill = None
                text = paras(sh.text_frame) if sh.has_text_frame and sh.text_frame.text.strip() else []
                kind = "shape" if shape or fill else "text"
                items.append({**g, "kind": kind, "shape": shape, "fill": fill, "paras": text})
            else:
                items.append({**g, "kind": "unsupported", "type": str(st)})

    out = {"size": {"w": 1280, "h": round(prs.slide_height * k, 1), "ratio": ratio}, "theme": theme(prs), "slides": []}
    for i, s in enumerate(slides, 1):
        items = []
        walk(s.shapes, 0, 0, 1, 1, items)
        out["slides"].append({"index": i, "items": items})
    (Path(out_dir) / "slides.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    return out


def theme(prs):
    """Theme colours and fonts of the first master (a:clrScheme, a:fontScheme)."""
    from pptx.opc.constants import RELATIONSHIP_TYPE as RT
    from xml.etree import ElementTree as ET
    A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
    try:
        root = ET.fromstring(prs.slide_master.part.part_related_by(RT.THEME).blob)
    except (KeyError, ET.ParseError, AttributeError):
        return {"colors": {}, "fonts": {}}
    colors = {}
    for el in root.iter(f"{A}clrScheme"):
        for c in el:
            v = (c[0].get("lastClr") or c[0].get("val")) if len(c) else None  # sysClr: lastClr is the real colour
            colors[c.tag.replace(A, "")] = v
        break
    fonts = {}
    for kind in ("majorFont", "minorFont"):
        el = next(root.iter(f"{A}{kind}"), None)
        if el is not None:
            fonts[kind] = {t: (el.find(f"{A}{t}").get("typeface") if el.find(f"{A}{t}") is not None else None) for t in ("latin", "ea")}
    return {"colors": colors, "fonts": fonts}


def hint(text):
    """What the html looks like, so Claude knows how to read it."""
    if re.search(r'<section[^>]*class="[^"]*\bslide\b', text) and re.search(r'id=["\']theme["\']', text):
        return "ppt-maker"
    if re.search(r'class="[^"]*\breveal\b|data-marpit|slidev', text, re.I) or len(re.findall(r"<section\b", text, re.I)) >= 3:
        return "slides"
    return "page"


def event(deck, iid, d, entry, mode, origin_dir=None):
    if entry.suffix.lower() == ".pptx":
        try:
            pptx_extract(entry, d)
            pdf = render_pdf(entry, d)
        except BaseException:
            shutil.rmtree(d, ignore_errors=True)
            raise
        base = Path(deck) / "imports"
        link = lambda p: "/imports/" + "/".join(quote(x, safe="") for x in p.relative_to(base).parts)
        ev = {"type": "import", "kind": "file", "mode": mode, "hint": "pptx", "import_id": iid, "text": f"导入《{entry.name}》{mode} pptx",
              "source": str(d / "slides.json"), "pdf": str(pdf) if pdf else None, "media": str(d / "media"), "dir": str(d),
              "original": link(pdf) if pdf else link(entry)}
        if origin_dir:
            ev["origin_dir"] = origin_dir
        return ev
    h = hint(entry.read_text(encoding="utf-8", errors="replace")[:2_000_000])
    rel = entry.relative_to(Path(deck) / "imports").parts
    ev = {"type": "import", "kind": "file", "mode": mode, "hint": h, "import_id": iid, "text": f"导入《{entry.name}》{mode} {h}",
          "source": str(entry), "dir": str(d), "original": "/imports/" + "/".join(quote(p, safe="") for p in rel)}  # a ready-to-use link
    if origin_dir:  # imported from the terminal: its pictures and styles still sit next to the original file
        ev["origin_dir"] = origin_dir
    return ev


def url_event(url, mode):
    u = urlparse(str(url).strip())
    if u.scheme not in ("http", "https") or not u.netloc:
        raise ValueError("只接受 http(s) 网址")
    return {"type": "import", "kind": "url", "mode": mode, "text": f"导入 {u.geturl()} {mode}", "source": u.geturl()}
