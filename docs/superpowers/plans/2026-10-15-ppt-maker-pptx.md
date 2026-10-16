# 导出 / 导入 PPTX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一键把 deck 导出成可在 PowerPoint 里编辑的 .pptx，并能把 .pptx 导入为 import 事件交给 Claude 重建。

**Architecture:** 导出时，页面里的 `export.js` 把每页测量成 JSON（文字片段、框、表格、图片、形状、线条；转不了的用 html-to-image 截成 PNG），POST 给 `/api/export`，由 `exporter.py`（python-pptx）生成 pptx。终端 `--export` 用无头 Edge 打开 `export=1` 的页面，走同一条路。导入时，`importer.py` 用 python-pptx 拆出 `slides.json`，把图片解到 `media/`，用 LibreOffice 转出 `slides.pdf`，发一条 `hint:"pptx"` 的 import 事件。

**Tech Stack:** Python 3 标准库 + python-pptx 0.6.23（延迟导入）；浏览器端原生 JS + 已内置的 html-to-image；LibreOffice（可选）；测试用 unittest、selftest、node e2e。

**Spec:** `docs/superpowers/specs/2026-10-15-ppt-maker-pptx-design.md`

## Global Constraints
- python-pptx 只在导出和导入 pptx 时用到，其他功能仍然只用标准库。没装时返回 503，提示语为 `导出需要 python-pptx：pip install python-pptx`。
- 画布 1280×720 px；pptx 尺寸 13.333×7.5 英寸；1px = 9525 EMU；pt = px × 0.75。
- `/api/export` 上限 50MB（流式）；单张图片不超过 10MB；导入 pptx 上限 50MB（沿用 `MAX_IMPORT`）。
- 导出文件写到 `decks/<名字>/export/<名字>-<YYYYMMDD-HHMMSS>.pptx`，先写临时文件再改名。
- 编辑层（`#ppt-ui`、`[data-ppt]`、`ppt-` 开头的 class）永远不导出。
- LibreOffice 转换超时 60 秒；终端导出最长等 120 秒。
- 旧版 `.ppt` 返回 400，提示 `请先在 PowerPoint 里另存为 .pptx`；损坏、加密或零页的 pptx 返回 400，提示 `无法读取这个 pptx`。

## Review Focus
1. 窄窗口：页面带 CSS zoom 时，测量出的坐标仍然是画布像素，和不缩放时一致（Task 3 的 e2e 覆盖）。
2. deck 名或文件名含中文、空格：下载头用 RFC 5987 的 `filename*`，浏览器下载的文件名正确（Task 2 覆盖）。
3. 图片地址取不到（外链或 404）：这一项跳过并写进报告，不能让整份导出失败（Task 3 覆盖）。
4. 有嵌套组合、占位符继承、非 16:9 的 pptx：坐标换算正确（Task 5 覆盖）。
5. LibreOffice 没装、超时，或用户正开着 LibreOffice（配置目录被锁）：照常导入，`pdf: null`；用独立的 `-env:UserInstallation` 避开锁（Task 5 覆盖）。

---

### Task 1: `exporter.py`：测量 JSON → pptx

**Files:**
- Create: `ppt/exporter.py`
- Test: `ppt/test_server.py`（新增 `ExporterTests`）

**Interfaces:**
- Produces:
  - `exporter.Missing(RuntimeError)`、`exporter.need_pptx()`：没装 python-pptx 时抛 `Missing`。
  - `exporter.build(data: dict, out: Path) -> dict`：返回 report `{slides, text, shape, table, image, raster:[{id,why}], skipped:[{id,why}]}`。
  - `exporter.summary(report) -> str`。
  - 测量 JSON 格式（Task 3 产出）：

```
{ "slides": [ {"id": "s-x", "bg": "ffffff"|null, "items": [ITEM...]} ],
  "skipped": [{"id": "...", "why": "..."}] }
ITEM 按绘制顺序（下层在前），坐标都是画布像素：
 {"k":"text","x","y","w","h","paras":[PARA]}
 {"k":"box","x","y","w","h","fill":hex|null,"fa":0..1,"line":hex|null,"lw":px,"r":px}
 {"k":"table","x","y","w","h","cols":[px],"rows":[px],"border":hex|null,"bw":px,"cells":[[{"paras":[PARA],"fill":hex|null}]]}
 {"k":"image","x","y","w","h","src":dataurl,"crop":{"l","t","r","b"}}       // crop 是比例
 {"k":"raster","x","y","w","h","src":dataurl,"id","why"}
 {"k":"shape","shape":"rect|round|ellipse|triangle","x","y","w","h","rot":deg,"fill":hex|null,"fa","line":hex|null,"lw":px,"paras":[PARA]}
 {"k":"line","x1","y1","x2","y2","color":hex,"lw":px,"start":bool,"end":bool}
PARA = {"align":"l|c|r|j","lh":px|null,"bullet":""|"•"|"1.","level":0,"runs":[RUN]}
RUN  = {"t":str,"font":str,"size":px,"color":hex,"a":0..1,"b":bool,"i":bool,"u":bool,"s":bool} | {"br":true}
```

- [ ] **Step 1: Write the failing tests** (add to `ppt/test_server.py`; `import exporter` next to `import importer`; add `base64` to the first import line)

```python
PNG_1PX = base64.b64encode(bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")).decode()


def sample_export():
    run = lambda t, **k: {"t": t, "font": "Microsoft YaHei", "size": 40, "color": "112233", "a": 1, "b": False, "i": False, "u": False, "s": False, **k}
    para = lambda *runs, **k: {"align": "l", "lh": None, "bullet": "", "level": 0, "runs": list(runs), **k}
    return {"slides": [
        {"id": "s-cover", "bg": "0f172a", "items": [
            {"k": "box", "x": 80, "y": 80, "w": 400, "h": 200, "fill": "1e293b", "fa": 1, "line": None, "lw": 0, "r": 12},
            {"k": "text", "x": 100, "y": 100, "w": 600, "h": 60, "paras": [para(run("季度复盘", b=True), {"br": True}, run("第二行"), align="c")]},
            {"k": "text", "x": 100, "y": 300, "w": 600, "h": 90, "paras": [para(run("要点一"), bullet="•"), para(run("要点二"), bullet="•", level=1)]},
            {"k": "shape", "shape": "ellipse", "x": 700, "y": 100, "w": 200, "h": 100, "rot": 30, "fill": "38bdf8", "fa": 1, "line": "ffffff", "lw": 2,
             "paras": [para(run("圆", size=20), align="c")]},
            {"k": "line", "x1": 100, "y1": 600, "x2": 500, "y2": 600, "color": "fbbf24", "lw": 3, "start": False, "end": True},
        ]},
        {"id": "s-data", "bg": None, "items": [
            {"k": "table", "x": 80, "y": 80, "w": 400, "h": 80, "cols": [200, 200], "rows": [40, 40], "border": "cccccc", "bw": 1,
             "cells": [[{"paras": [para(run("指标", size=16))], "fill": "eeeeee"}, {"paras": [para(run("数值", size=16))], "fill": None}],
                       [{"paras": [para(run("用户", size=16))], "fill": None}, {"paras": [para(run("820 万", size=16))], "fill": None}]]},
            {"k": "image", "x": 600, "y": 80, "w": 100, "h": 100, "src": "data:image/png;base64," + PNG_1PX, "crop": {"l": 0.1, "t": 0, "r": 0.1, "b": 0}},
            {"k": "raster", "x": 600, "y": 300, "w": 100, "h": 100, "src": "data:image/png;base64," + PNG_1PX, "id": "b-chart", "why": "SVG 插图"},
        ]}], "skipped": [{"id": "b-ext", "why": "图片取不到"}]}


class ExporterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_build_makes_editable_native_objects(self):
        from pptx import Presentation
        from pptx.util import Emu
        out = self.tmp / "out" / "d.pptx"
        out.parent.mkdir()
        rep = exporter.build(sample_export(), out)
        self.assertEqual({k: rep[k] for k in ("slides", "text", "shape", "table", "image")}, {"slides": 2, "text": 2, "shape": 3, "table": 1, "image": 1})  # box + ellipse + line
        self.assertEqual(rep["raster"], [{"id": "b-chart", "why": "SVG 插图"}])
        self.assertEqual(rep["skipped"], [{"id": "b-ext", "why": "图片取不到"}])
        self.assertEqual([p.name for p in out.parent.iterdir()], ["d.pptx"])  # no temp file left
        prs = Presentation(str(out))
        self.assertEqual((prs.slide_width, prs.slide_height), (Emu(1280 * 9525), Emu(720 * 9525)))
        s1, s2 = prs.slides
        self.assertEqual(str(s1.background.fill.fore_color.rgb), "0F172A")
        tb = [sh for sh in s1.shapes if sh.has_text_frame and sh.text_frame.text.startswith("季度复盘")][0]
        self.assertEqual((tb.left, tb.top, tb.width), (Emu(100 * 9525), Emu(100 * 9525), Emu(600 * 9525)))
        r0 = tb.text_frame.paragraphs[0].runs[0]
        self.assertEqual((r0.font.size.pt, r0.font.bold, str(r0.font.color.rgb), r0.font.name), (30.0, True, "112233", "Microsoft YaHei"))
        self.assertIn("\v", tb.text_frame.paragraphs[0].text)  # the <br> is a line break inside the paragraph
        self.assertIn('typeface="Microsoft YaHei"', r0._r.xml.split("<a:ea")[1][:60])  # east asian font set too
        bul = [sh for sh in s1.shapes if sh.has_text_frame and sh.text_frame.text.startswith("要点一")][0].text_frame.paragraphs
        self.assertIn("buChar", bul[0]._p.xml)
        self.assertEqual(bul[1].level, 1)
        ell = [sh for sh in s1.shapes if sh.has_text_frame and sh.text_frame.text == "圆"][0]
        self.assertEqual((ell.auto_shape_type.name if hasattr(ell.auto_shape_type, "name") else str(ell.auto_shape_type), ell.rotation), ("OVAL", 30.0))
        self.assertNotIn("<p:style>", ell._element.xml)  # no theme style: no surprise blue fill or shadow
        line = [sh for sh in s1.shapes if sh.shape_type == 9 or sh.__class__.__name__ == "Connector"][0]
        self.assertIn("tailEnd", line._element.xml)
        self.assertNotIn("headEnd", line._element.xml)
        tbl = [sh for sh in s2.shapes if sh.has_table][0].table
        self.assertEqual([[c.text for c in r.cells] for r in tbl.rows], [["指标", "数值"], ["用户", "820 万"]])
        pics = [sh for sh in s2.shapes if sh.shape_type == 13]
        self.assertEqual(len(pics), 2)
        self.assertAlmostEqual(pics[0].crop_left, 0.1, places=3)

    def test_summary_names_what_became_pictures(self):
        rep = {"slides": 4, "text": 18, "shape": 6, "table": 1, "image": 2, "raster": [{"id": "b-chart", "why": "SVG 插图"}], "skipped": []}
        self.assertEqual(exporter.summary(rep), "导出完成：4 页，18 个文本框、6 个形状、1 个表格、2 张图片；1 处转成了图片（b-chart：SVG 插图）")
        self.assertEqual(exporter.summary({**rep, "raster": [], "skipped": [{"id": "x", "why": "坏"}]}),
                         "导出完成：4 页，18 个文本框、6 个形状、1 个表格、2 张图片；1 处没能导出（x：坏）")

    def test_a_bad_item_is_skipped_not_fatal(self):
        data = {"slides": [{"id": "s", "bg": None, "items": [{"k": "image", "x": 0, "y": 0, "w": 9, "h": 9, "src": "data:text/html;base64,PGI+", "crop": None},
                                                            {"k": "nonsense"}]}]}
        rep = exporter.build(data, self.tmp / "x.pptx")
        self.assertEqual([s["why"][:5] for s in rep["skipped"]], ["无法生成：", "无法生成："])

    def test_missing_python_pptx_is_reported(self):
        with mock.patch.dict(sys.modules, {"pptx": None}):
            with self.assertRaises(exporter.Missing) as c:
                exporter.build(sample_export(), self.tmp / "y.pptx")
        self.assertEqual(str(c.exception), "导出需要 python-pptx：pip install python-pptx")
```

- [ ] **Step 2: Run to verify failure**

Run: `timeout 300 python ppt/test_server.py ExporterTests`
Expected: ERROR `ModuleNotFoundError: No module named 'exporter'`

- [ ] **Step 3: Implement `ppt/exporter.py`**

```python
"""ppt-maker pptx export: slides measured in the page (export.js) -> an editable .pptx. python-pptx is imported lazily."""
import base64, binascii, io, os, re
from pathlib import Path

PX = 9525  # EMU per CSS px
MAX_IMG = 10 * 1024 * 1024
ALIGN = {"l": 1, "c": 2, "r": 3, "j": 4}  # PP_ALIGN values
SHAPES = {"rect": 1, "round": 5, "ellipse": 9, "triangle": 7}  # MSO_SHAPE values
DATA_URL = re.compile(r"data:image/(png|jpeg|gif|webp);base64,(.+)", re.S)


class Missing(RuntimeError):
    pass


def need_pptx():
    try:
        import pptx  # noqa: F401
    except ImportError as e:
        raise Missing("导出需要 python-pptx：pip install python-pptx") from e


def E(v):
    return int(round(float(v) * PX))


def image_bytes(src):
    m = DATA_URL.fullmatch(src or "")
    if not m:
        raise ValueError("不是图片")
    try:
        data = base64.b64decode(m.group(2), validate=False)
    except binascii.Error as e:
        raise ValueError("图片数据坏了") from e
    if len(data) > MAX_IMG:
        raise ValueError("图片超过 10MB")
    return data


def build(data, out):
    need_pptx()
    from pptx import Presentation
    from pptx.dml.color import RGBColor
    from pptx.enum.shapes import MSO_CONNECTOR
    from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE
    from pptx.oxml.ns import qn
    from pptx.util import Emu, Pt

    def rgb(h):
        return RGBColor.from_string(str(h)[:6].upper())

    def alpha(fill, a):  # transparency on a solid fill
        if a is not None and a < 1:
            clr = fill._xPr.find(qn("a:solidFill"))[0]
            el = clr.makeelement(qn("a:alpha"), {"val": str(int(a * 100000))})
            clr.append(el)

    def plain(sh):  # drop the theme style: no blue fill, no shadow, black text
        st = sh._element.find(qn("p:style"))
        if st is not None:
            sh._element.remove(st)
        return sh

    def set_fill(fill, hexv, a=1):
        if hexv:
            fill.solid()
            fill.fore_color.rgb = rgb(hexv)
            alpha(fill, a)
        else:
            fill.background()

    def set_line(line, hexv, w):
        if hexv and w:
            line.color.rgb = rgb(hexv)
            line.width = Emu(E(w))
        else:
            line.fill.background()

    def runs_into(para, p):
        para.alignment = ALIGN.get(p.get("align"))
        if p.get("lh"):
            para.line_spacing = Pt(float(p["lh"]) * 0.75)
        lvl = int(p.get("level") or 0)
        para.level = min(lvl, 8)
        if p.get("bullet"):
            pPr = para._p.get_or_add_pPr()
            pPr.set("marL", str(E(24 * (lvl + 1))))
            pPr.set("indent", str(-E(18)))
            if p["bullet"] == "•":
                pPr.append(pPr.makeelement(qn("a:buChar"), {"char": "•"}))
            else:
                pPr.append(pPr.makeelement(qn("a:buAutoNum"), {"type": "arabicPeriod"}))
        for r in p.get("runs") or []:
            if r.get("br"):
                para.add_line_break()
                continue
            run = para.add_run()
            run.text = r.get("t", "")
            f = run.font
            f.size = Pt(float(r.get("size") or 16) * 0.75)
            f.bold, f.italic, f.underline = bool(r.get("b")), bool(r.get("i")), bool(r.get("u"))
            if r.get("color"):
                f.color.rgb = rgb(r["color"])
            if r.get("font"):
                f.name = r["font"]
                rPr = run._r.get_or_add_rPr()
                rPr.find(qn("a:latin")).addnext(rPr.makeelement(qn("a:ea"), {"typeface": r["font"]}))
            if r.get("s"):
                run._r.get_or_add_rPr().set("strike", "sngStrike")

    def text_into(tf, paras, middle=False):
        tf.word_wrap = True
        tf.auto_size = MSO_AUTO_SIZE.NONE
        tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
        if middle:
            tf.vertical_anchor = MSO_ANCHOR.MIDDLE
        for i, p in enumerate(paras or []):
            runs_into(tf.paragraphs[0] if i == 0 else tf.add_paragraph(), p)

    def add_text(s, it):
        tb = s.shapes.add_textbox(E(it["x"]), E(it["y"]), E(it["w"]), E(it["h"]))
        text_into(tb.text_frame, it["paras"])
        return "text"

    def add_box(s, it):
        kind = SHAPES["round"] if it.get("r") else SHAPES["rect"]
        sh = plain(s.shapes.add_shape(kind, E(it["x"]), E(it["y"]), E(it["w"]), E(it["h"])))
        if it.get("r"):
            sh.adjustments[0] = min(0.5, float(it["r"]) / max(1.0, min(float(it["w"]), float(it["h"]))))
        set_fill(sh.fill, it.get("fill"), it.get("fa", 1))
        set_line(sh.line, it.get("line"), it.get("lw"))
        return "shape"

    def add_shape(s, it):
        sh = plain(s.shapes.add_shape(SHAPES[it["shape"]], E(it["x"]), E(it["y"]), E(it["w"]), E(it["h"])))
        sh.rotation = float(it.get("rot") or 0)
        set_fill(sh.fill, it.get("fill"), it.get("fa", 1))
        set_line(sh.line, it.get("line"), it.get("lw"))
        if it.get("paras"):
            text_into(sh.text_frame, it["paras"], middle=True)
        return "shape"

    def add_line(s, it):
        c = plain(s.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, E(it["x1"]), E(it["y1"]), E(it["x2"]), E(it["y2"])))
        c.line.color.rgb = rgb(it.get("color") or "000000")
        c.line.width = Emu(E(it.get("lw") or 1))
        ln = c.line._get_or_add_ln()
        for key, tag in (("start", "a:headEnd"), ("end", "a:tailEnd")):
            if it.get(key):
                ln.append(ln.makeelement(qn(tag), {"type": "triangle"}))
        return "shape"

    def add_pic(s, it):
        pic = s.shapes.add_picture(io.BytesIO(image_bytes(it["src"])), E(it["x"]), E(it["y"]), E(it["w"]), E(it["h"]))
        crop = it.get("crop") or {}
        pic.crop_left, pic.crop_top = float(crop.get("l", 0)), float(crop.get("t", 0))
        pic.crop_right, pic.crop_bottom = float(crop.get("r", 0)), float(crop.get("b", 0))
        return "image" if it["k"] == "image" else "raster"

    def add_table(s, it):
        rows, cols = len(it["cells"]), len(it["cells"][0])
        gf = s.shapes.add_table(rows, cols, E(it["x"]), E(it["y"]), E(it["w"]), E(it["h"]))
        t = gf.table
        t.first_row = t.horz_banding = False
        for j, w in enumerate(it.get("cols") or []):
            t.columns[j].width = Emu(E(w))
        for i, h in enumerate(it.get("rows") or []):
            t.rows[i].height = Emu(E(h))
        for i, row in enumerate(it["cells"]):
            for j, cd in enumerate(row):
                cell = t.cell(i, j)
                set_fill(cell.fill, cd.get("fill"))
                cell.margin_left = cell.margin_right = Emu(E(4))
                cell.margin_top = cell.margin_bottom = Emu(E(2))
                text_into(cell.text_frame, cd.get("paras"))
                if it.get("border") and it.get("bw"):
                    tcPr = cell._tc.get_or_add_tcPr()
                    for side in ("a:lnL", "a:lnR", "a:lnT", "a:lnB"):
                        ln = tcPr.makeelement(qn(side), {"w": str(E(it["bw"]))})
                        sf = ln.makeelement(qn("a:solidFill"), {})
                        sf.append(sf.makeelement(qn("a:srgbClr"), {"val": str(it["border"])[:6].upper()}))
                        ln.append(sf)
                        tcPr.insert(0, ln) if side == "a:lnL" else tcPr.append(ln)
        return "table"

    add = {"text": add_text, "box": add_box, "shape": add_shape, "line": add_line, "image": add_pic, "raster": add_pic, "table": add_table}
    prs = Presentation()
    prs.slide_width, prs.slide_height = Emu(1280 * PX), Emu(720 * PX)
    blank = prs.slide_layouts[6]
    rep = {"slides": 0, "text": 0, "shape": 0, "table": 0, "image": 0, "raster": [], "skipped": list(data.get("skipped") or [])}
    for sd in data["slides"]:
        s = prs.slides.add_slide(blank)
        rep["slides"] += 1
        if sd.get("bg"):
            s.background.fill.solid()
            s.background.fill.fore_color.rgb = rgb(sd["bg"])
        for it in sd.get("items") or []:
            try:
                kind = add[it["k"]](s, it)
            except (KeyError, ValueError, TypeError, IndexError, AttributeError) as e:
                rep["skipped"].append({"id": it.get("id", ""), "why": f"无法生成：{e}"})
                continue
            if kind == "raster":
                rep["raster"].append({"id": it.get("id", ""), "why": it.get("why", "")})
            else:
                rep[kind] += 1
    out = Path(out)
    tmp = out.with_name(out.name + ".part")
    try:
        prs.save(str(tmp))
        os.replace(tmp, out)
    finally:
        tmp.unlink(missing_ok=True)
    return rep


def summary(rep):
    s = f"导出完成：{rep['slides']} 页，{rep['text']} 个文本框、{rep['shape']} 个形状、{rep['table']} 个表格、{rep['image']} 张图片"
    if rep.get("raster"):
        s += f"；{len(rep['raster'])} 处转成了图片（" + "；".join(f"{r['id']}：{r['why']}" for r in rep["raster"]) + "）"
    if rep.get("skipped"):
        s += f"；{len(rep['skipped'])} 处没能导出（" + "；".join(f"{r['id']}：{r['why']}" for r in rep["skipped"]) + "）"
    return s
```

- [ ] **Step 4: Run to verify pass**

Run: `timeout 300 python ppt/test_server.py ExporterTests`
Expected: `OK`（4 tests）

- [ ] **Step 5: Commit**

```bash
git add ppt/exporter.py ppt/test_server.py
git commit -m "feat(export): build an editable pptx from measured slides"
```

---

### Task 2: `/api/export` 接口和 `/export/` 下载

**Files:**
- Modify: `ppt/server.py`（`STREAMED`、`do_POST`，新增 `export_post`，`do_GET` 静态文件的下载头）
- Test: `ppt/test_server.py`（新增 `ExportApiTests(ServerCase)`）

**Interfaces:**
- Consumes: `exporter.build`、`exporter.summary`、`exporter.Missing`（Task 1）。
- Produces:
  - `POST /api/export?t=` 返回 `{file, url, summary, report}`；`url` 形如 `/export/<quote(name)>`。
  - 同时写 `.ppt/export.json`，内容同返回值，供 Task 4 读取。
  - `MAX_EXPORT = 50 * 1024 * 1024`。

- [ ] **Step 1: Write the failing tests**

```python
class ExportApiTests(ServerCase):
    def post_raw(self, path, data):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        c.request("POST", path, data, {"Host": f"127.0.0.1:{self.port}", "Content-Type": "application/json"})
        r = c.getresponse()
        out = (r.status, json.loads(r.read() or b"null"))
        c.close()
        return out

    def test_export_writes_a_file_and_offers_it_as_a_download(self):
        st, d = self.post_raw("/api/export?t=tok", json.dumps(sample_export()).encode())
        self.assertEqual(st, 200, d)
        f = Path(d["file"])
        self.assertEqual(f.parent, (self.deck / "export").resolve())
        self.assertRegex(f.name, r"^deck-\d{8}-\d{6}\.pptx$")
        self.assertTrue(d["summary"].startswith("导出完成：2 页"))
        self.assertEqual(json.loads((self.deck / ".ppt" / "export.json").read_text(encoding="utf-8"))["file"], d["file"])
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("GET", d["url"], headers={"Host": f"127.0.0.1:{self.port}"})
        r = c.getresponse()
        self.assertEqual(r.status, 200)
        self.assertEqual(r.getheader("Content-Disposition"), "attachment; filename*=UTF-8''" + quote(f.name))
        self.assertEqual(r.read()[:2], b"PK")
        c.close()

    def test_export_needs_the_token_and_a_sane_body(self):
        self.assertEqual(self.post_raw("/api/export?t=bad", b"{}")[0], 403)
        self.assertEqual(self.post_raw("/api/export?t=tok", b"not json")[0], 400)
        self.assertEqual(self.post_raw("/api/export?t=tok", json.dumps({"slides": "x"}).encode())[0], 400)

    def test_export_over_50mb_is_refused(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        c.putrequest("POST", "/api/export?t=tok", skip_host=True)
        c.putheader("Host", f"127.0.0.1:{self.port}")
        c.putheader("Content-Length", str(server.MAX_EXPORT + 1))
        c.endheaders()
        try:
            c.send(b"x" * 65536)
        except OSError:
            pass
        self.assertEqual(c.getresponse().status, 413)
        c.close()

    def test_export_without_python_pptx_says_how_to_install(self):
        with mock.patch.object(exporter, "build", side_effect=exporter.Missing("导出需要 python-pptx：pip install python-pptx")):
            st, d = self.post_raw("/api/export?t=tok", json.dumps(sample_export()).encode())
        self.assertEqual((st, d["error"]), (503, "导出需要 python-pptx：pip install python-pptx"))

    def test_a_chinese_deck_name_downloads_with_its_name(self):
        (self.deck / "export").mkdir()
        (self.deck / "export" / "季度 复盘-1.pptx").write_bytes(b"PK")
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("GET", "/export/" + quote("季度 复盘-1.pptx"), headers={"Host": f"127.0.0.1:{self.port}"})
        self.assertEqual(c.getresponse().getheader("Content-Disposition"), "attachment; filename*=UTF-8''" + quote("季度 复盘-1.pptx"))
        c.close()
```

- [ ] **Step 2: Run to verify failure**

Run: `timeout 300 python ppt/test_server.py ExportApiTests`
Expected: FAIL（404 / 无 `MAX_EXPORT` / 没有下载头）

- [ ] **Step 3: Implement**

在 `server.py` 中：
- 增加 `import exporter`（放在 `import importer` 旁边）。
- 增加常量 `MAX_EXPORT = 50 * 1024 * 1024`；`STREAMED = ("/api/kb/file", "/api/import", "/api/export")`。
- `do_POST` 里 import 分支的前面加：`if url.path == "/api/export": return self.export_post()`。
- 新增方法：

```python
    def export_post(self):
        deck = self.server.deck
        if self.stream_len > MAX_EXPORT:
            self.discard_stream()
            return self.send(413, {"error": "导出数据超过 50MB（图片太多），请减少图片后再试"})
        try:
            raw = self.rfile.read(self.stream_len) if self.stream_len else b""
            self.stream_len = 0
            data = json.loads(raw or b"null")
            if not isinstance(data, dict) or not isinstance(data.get("slides"), list):
                raise ValueError("导出数据格式不对")
            out = deck / "export" / f"{deck.name}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.pptx"
            out.parent.mkdir(exist_ok=True)
            rep = exporter.build(data, out)  # outside LOCK: can take seconds
            res = {"file": str(out.resolve()), "url": "/export/" + quote(out.name), "summary": exporter.summary(rep), "report": rep}
            (runtime(deck) / "export.json").write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")
            return self.send(200, res)
        except exporter.Missing as e:
            return self.send(503, {"error": str(e)})
        except (ValueError, KeyError, TypeError) as e:
            return self.send(400, {"error": f"导出失败：{e}"})
        except OSError as e:
            return self.send(503, {"error": f"导出时写不进磁盘：{e}"})
```

- `server.py` 需要 `from urllib.parse import parse_qs, quote, unquote, urlparse`。
- `do_GET` 静态文件分支：在 `self.send(200, data, ctype, sandbox)` 之前：

```python
        if rel[:1] == ("export",):  # an exported pptx downloads under its own (often Chinese) name
            sandbox = {**(sandbox or {}), "Content-Disposition": "attachment; filename*=UTF-8''" + quote(f.name)}
```

- [ ] **Step 4: Run to verify pass**

Run: `timeout 300 python ppt/test_server.py`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add ppt/server.py ppt/test_server.py
git commit -m "feat(export): POST /api/export and /export downloads"
```

---

### Task 3: `export.js` 测量 + "导出 PPT"按钮

**Files:**
- Create: `ppt/export.js`
- Modify:
  - `ppt/server.py`（`INJECT` 在 toolbar.js 之前加 `<script src="/_ppt/export.js" data-ppt></script>`）
  - `ppt/toolbar.js`（按钮、`setExporting`）
  - `ppt/editor.js`（`exportPptx`；`toast` 增加第四个参数 `label`）
- Test: `tests/e2e.mjs`

**Interfaces:**
- Consumes: `POST /api/export`（Task 2）、测量 JSON 格式（Task 1）。
- Produces:
  - `window.PPTExport.measure(slides: Element[]) -> Promise<{slides, skipped}>`；
  - toolbar 的 `cb.exportPptx()` 和 `tb.setExporting(on)`；
  - editor 的 `exportPptx()`（Task 4 的 `export=1` 会调用它）；
  - `toast(msg, text, href, label='打开原稿')`。

- [ ] **Step 1: Write the failing e2e checks**（插在 `// ---- add new checks above ----` 之前）

```js
  // ---- 6: export pptx ----
  const exportDeck = deckHtml().replace(/<\/body>/, `<section class="slide" id="s-export">
  <div class="block" id="b-ex-title" style="grid-area:1/2/3/16"><h2 style="margin:0;font-size:44px;color:#123456">导出测试标题</h2></div>
  <div class="block" id="b-ex-box" style="grid-area:3/2/6/8;background:#fde68a;border-radius:12px"><p style="margin:0;font-size:24px">框里的字</p><ul style="margin:0"><li>第一条</li><li>第二条</li></ul></div>
  <div class="block" id="b-ex-svg" style="grid-area:3/9/6/12"><svg viewBox="0 0 10 10" width="200" height="200"><circle cx="5" cy="5" r="4" fill="#38bdf8"/></svg></div>
  <div class="block" id="b-ex-table" style="grid-area:6/2/9/10"><table><tr><td>指标</td><td>数值</td></tr><tr><td>用户</td><td>820 万</td></tr></table></div>
  <div class="block" id="b-ex-ext" style="grid-area:6/11/9/14"><img src="https://invalid.example/x.png" alt="" style="width:100px;height:100px"></div>
  <div class="obj" id="o-ex-shape" data-kind="shape" data-shape="ellipse" style="left:1000px;top:80px;width:200px;height:100px;fill:#38bdf8;stroke:#ffffff;stroke-width:2"><svg viewBox="0 0 200 100"><ellipse cx="100" cy="50" rx="99" ry="49"/></svg><div class="obj-text">圆</div></div>
  <div class="obj" id="o-ex-arrow" data-kind="arrow" data-shape="arrow" style="left:900px;top:600px;width:300px;height:40px;stroke:#ff0000;stroke-width:3"><svg viewBox="0 0 300 40"><line x1="8" y1="20" x2="292" y2="20"/><polyline points="280,12 292,20 280,28" fill="none"/></svg></div>
</section></body>`);
  fs.writeFileSync(path.join(DECK, 'deck.html'), exportDeck); await open(url); await sleep(1500);
  const m1 = await ev(`PPTExport.measure([document.getElementById('s-export')]).then((d) => JSON.stringify(d))`);
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 800, deviceScaleFactor: 1, mobile: false }); await sleep(600);
  const m2 = await ev(`PPTExport.measure([document.getElementById('s-export')]).then((d) => JSON.stringify(d))`);
  await send('Emulation.clearDeviceMetricsOverride'); await sleep(600);
  const t1 = JSON.parse(m1).slides[0].items.find((i) => i.k === 'text' && i.paras[0].runs[0].t === '导出测试标题');
  const t2 = JSON.parse(m2).slides[0].items.find((i) => i.k === 'text' && i.paras[0].runs[0].t === '导出测试标题');
  check('X measuring gives canvas pixels at any zoom', t1 && t2 && Math.abs(t1.x - t2.x) < 1 && Math.abs(t1.y - t2.y) < 1 && Math.abs(t1.x - 80) < 2, JSON.stringify([t1?.x, t2?.x]));
  const ms = JSON.parse(m1);
  const kinds = ms.slides[0].items.map((i) => i.k);
  check('X the measure has native text, box, table, shape, line and a raster for the svg',
    ['text', 'box', 'table', 'shape', 'line', 'raster'].every((k) => kinds.includes(k)) && ms.slides[0].items.find((i) => i.k === 'raster').id === 'b-ex-svg'
    && ms.slides[0].items.find((i) => i.k === 'text' && i.paras[0].bullet === '•'), kinds.join());
  check('X an image that cannot be fetched is skipped, not fatal', ms.skipped.some((s) => s.id === 'b-ex-ext'), JSON.stringify(ms.skipped));
  b9 = await byTitle('导出成可在 PowerPoint'); await click(b9.x, b9.y); await sleep(500);
  check('X the button shows it is busy', (await ev(`[...document.querySelectorAll('#ppt-ui [title^="导出成可在"]')].map((b) => b.textContent).join()`)) === '导出中…');
  let exported = null;
  for (let i = 0; i < 60 && !exported; i++) { await sleep(500); const d = path.join(DECK, 'export'); exported = fs.existsSync(d) && fs.readdirSync(d).find((f) => f.endsWith('.pptx')); }
  await sleep(500);
  check('X a pptx is written under export/', !!exported, String(exported));
  check('X the report pops up with a download link', ((await ev(`[...document.querySelectorAll('.ppt-toast')].map((t) => t.textContent).join()`)) || '').includes('导出完成')
    && (await ev(`[...document.querySelectorAll('.ppt-toast a')].some((a) => a.textContent === '下载' && a.getAttribute('href').startsWith('/export/'))`)));
  if (exported) {
    const back = JSON.parse(execFileSync('python', ['-c', `import json,sys
from pptx import Presentation
p = Presentation(sys.argv[1])
print(json.dumps({"n": len(p.slides), "texts": [sh.text_frame.text for s in p.slides for sh in s.shapes if sh.has_text_frame],
  "pics": sum(sh.shape_type == 13 for s in p.slides for sh in s.shapes), "tables": sum(sh.has_table for s in p.slides for sh in s.shapes)}, ensure_ascii=False))`,
      path.join(DECK, 'export', exported)], { encoding: 'utf8' }));
    check('X read back: one slide per page, title text editable, svg as a picture, a table',
      back.n === (await ev(`document.querySelectorAll('section.slide').length`)) && back.texts.includes('导出测试标题') && back.pics >= 1 && back.tables === 1, JSON.stringify(back).slice(0, 300));
  }
```

- [ ] **Step 2: Run to verify failure**

Run: `node tests/e2e.mjs > "$TEMP/ppt-logs/e2e.log" 2>&1; grep -E "^FAIL|passed" "$TEMP/ppt-logs/e2e.log"`
Expected: FAIL（`PPTExport is not defined`，脚本中断）

- [ ] **Step 3: Implement `ppt/export.js`**

```js
// Measures slides for the pptx export: canvas-pixel geometry, text runs with computed styles, boxes, tables,
// images, shapes and lines. What PowerPoint can't express natively becomes a PNG cut from an html-to-image render.
window.PPTExport = (() => {
  const W = 1280, H = 720;
  const SKIP = '[data-ppt], #ppt-ui, [class^="ppt-"], [class*=" ppt-"]';
  const RASTER_TAGS = { SVG: 'SVG 插图', CANVAS: '画布', VIDEO: '视频', IFRAME: '内嵌页面' };
  function col(c) { // rgb()/rgba() -> {hex, a}; transparent -> null
    const m = c && c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    const a = p.length > 3 ? p[3] : 1;
    return a === 0 ? null : { hex: p.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''), a };
  }
  const blockish = (el) => { const d = getComputedStyle(el).display; return d !== 'inline' && d !== 'contents' && d !== 'none'; };
  const idOf = (el) => el.closest('[id]')?.id || el.tagName.toLowerCase();
  function rasterWhy(el, cs) {
    if (RASTER_TAGS[el.tagName.toUpperCase()]) return RASTER_TAGS[el.tagName.toUpperCase()];
    if (cs.backgroundImage !== 'none') return '渐变或背景图';
    if (cs.boxShadow !== 'none') return '阴影';
    if (cs.transform !== 'none') return '旋转或变形';
    if (cs.filter !== 'none') return '滤镜';
    if (cs.clipPath !== 'none') return '裁切形状';
    return '';
  }
  const ALIGN = { left: 'l', start: 'l', center: 'c', right: 'r', end: 'r', justify: 'j' };
  function run(text, cs) {
    const c = col(cs.color) || { hex: '000000', a: 1 };
    const deco = cs.textDecorationLine || '';
    return { t: text, font: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(), size: parseFloat(cs.fontSize), color: c.hex, a: c.a,
      b: parseInt(cs.fontWeight, 10) >= 600, i: cs.fontStyle === 'italic', u: deco.includes('underline'), s: deco.includes('line-through') };
  }
  function para(root, extra = {}) { // the inline text of root (child blocks are walked separately)
    const cs = getComputedStyle(root), runs = [];
    (function collect(node) {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) {
          const pre = /pre/.test(getComputedStyle(n.parentElement).whiteSpace);
          const t = pre ? n.data : n.data.replace(/\s+/g, ' ');
          if (t) runs.push(run(t, getComputedStyle(n.parentElement)));
        } else if (n.nodeType === 1 && !n.matches(SKIP)) {
          if (n.tagName === 'BR') runs.push({ br: true });
          else if (!blockish(n) && !RASTER_TAGS[n.tagName.toUpperCase()] && n.tagName !== 'IMG') collect(n);
        }
      }
    })(root);
    while (runs.length && runs[0].t !== undefined && !runs[0].t.trim()) runs.shift();
    if (runs[0]?.t) runs[0].t = runs[0].t.trimStart();
    const last = runs.at(-1);
    if (last?.t) last.t = last.t.trimEnd();
    const lh = parseFloat(cs.lineHeight);
    return { align: ALIGN[cs.textAlign] || 'l', lh: Number.isFinite(lh) ? lh : null, bullet: '', level: 0, runs: runs.filter((r) => r.br || r.t), ...extra };
  }
  function textRect(root) { // union of the line boxes of root's own text
    const rg = document.createRange(), rs = [];
    const walk = (node) => { for (const n of node.childNodes) {
      if (n.nodeType === 3 && n.data.trim()) { rg.selectNodeContents(n); rs.push(...rg.getClientRects()); }
      else if (n.nodeType === 1 && !n.matches(SKIP) && !blockish(n) && n.tagName !== 'IMG' && !RASTER_TAGS[n.tagName.toUpperCase()]) walk(n);
    } };
    walk(root);
    if (!rs.length) return null;
    const l = Math.min(...rs.map((r) => r.left)), t = Math.min(...rs.map((r) => r.top));
    return { left: l, top: t, width: Math.max(...rs.map((r) => r.right)) - l, height: Math.max(...rs.map((r) => r.bottom)) - t };
  }
  async function dataUrl(src) {
    if (src.startsWith('data:image/')) return src;
    const b = await (await fetch(src)).blob();
    if (!b.type.startsWith('image/')) throw new Error('不是图片');
    return new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(b); });
  }

  async function measureSlide(slide, skipped) {
    const sr = slide.getBoundingClientRect(), k = sr.width / W;
    const rel = (r) => ({ x: (r.left - sr.left) / k, y: (r.top - sr.top) / k, w: r.width / k, h: r.height / k });
    const items = [], rasters = [], pending = [];
    const scs = getComputedStyle(slide), sbg = col(scs.backgroundColor);
    const textItem = (el, paras) => { const r = textRect(el); if (r && paras.some((p) => p.runs.length)) { const g = rel(r); items.push({ k: 'text', ...g, w: g.w + 4, paras }); } };
    const raster = (el, why, pad = 0) => { const g = rel(el.getBoundingClientRect()); const it = { k: 'raster', x: g.x - pad, y: g.y - pad, w: g.w + 2 * pad, h: g.h + 2 * pad, id: idOf(el), why }; items.push(it); rasters.push([el, it]); };
    function obj(el) {
      const cs = getComputedStyle(el), kind = el.dataset.kind, shape = el.dataset.shape;
      const g = { x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0, w: parseFloat(el.style.width) || 0, h: parseFloat(el.style.height) || 0 };
      if (kind === 'shape' && ['rect', 'round', 'ellipse', 'triangle'].includes(shape)) {
        const f = col(cs.fill), s = col(cs.stroke), m = /rotate\((-?[\d.]+)deg\)/.exec(el.style.transform || '');
        const t = el.querySelector('.obj-text');
        items.push({ k: 'shape', shape, ...g, rot: m ? parseFloat(m[1]) : 0, fill: f?.hex || null, fa: f?.a ?? 1, line: s?.hex || null, lw: parseFloat(cs.strokeWidth) || 0,
          paras: t ? [para(t)] : [] });
      } else if (kind === 'arrow') {
        const ln = el.querySelector('line'), s = col(cs.stroke) || { hex: '000000' };
        if (!ln) return raster(el, '箭头');
        const p = (a) => parseFloat(ln.getAttribute(a)) || 0;
        items.push({ k: 'line', x1: g.x + p('x1'), y1: g.y + p('y1'), x2: g.x + p('x2'), y2: g.y + p('y2'), color: s.hex, lw: parseFloat(cs.strokeWidth) || 2,
          start: shape === 'arrow2', end: shape === 'arrow' || shape === 'arrow2' });
      } else if (kind === 'image' && el.querySelector('img')) {
        image(el.querySelector('img'), g);
      } else raster(el, kind === 'icon' ? '图标' : kind === 'ink' ? '笔迹' : '对象');
    }
    function image(img, g = rel(img.getBoundingClientRect())) {
      const it = { k: 'image', ...g, src: '', crop: null };
      const nr = img.naturalWidth / (img.naturalHeight || 1), br = g.w / (g.h || 1);
      if (getComputedStyle(img).objectFit === 'cover' && img.naturalWidth) {
        const c = nr > br ? (1 - br / nr) / 2 : 0, v = nr < br ? (1 - nr / br) / 2 : 0;
        it.crop = { l: c, r: c, t: v, b: v };
      }
      items.push(it);
      pending.push(dataUrl(img.currentSrc || img.src).then((u) => { it.src = u; }).catch(() => { items.splice(items.indexOf(it), 1); skipped.push({ id: idOf(img), why: '图片取不到' }); }));
    }
    function table(el) {
      const rows = [...el.rows];
      if (rows.some((r) => [...r.cells].some((c) => c.colSpan > 1 || c.rowSpan > 1))) return raster(el, '合并单元格的表格');
      const first = rows[0]?.cells[0], fcs = first && getComputedStyle(first), b = fcs && col(fcs.borderTopColor);
      items.push({ k: 'table', ...rel(el.getBoundingClientRect()), cols: [...(rows[0]?.cells || [])].map((c) => c.getBoundingClientRect().width / k),
        rows: rows.map((r) => r.getBoundingClientRect().height / k), border: fcs && parseFloat(fcs.borderTopWidth) ? b?.hex || null : null, bw: fcs ? parseFloat(fcs.borderTopWidth) || 0 : 0,
        cells: rows.map((r) => [...r.cells].map((c) => ({ paras: [para(c)], fill: col(getComputedStyle(c).backgroundColor)?.hex || null }))) });
    }
    function walk(el) {
      if (el.matches(SKIP)) return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      if (el.classList.contains('obj')) return obj(el);
      const why = rasterWhy(el, cs);
      if (why) return raster(el, why, cs.boxShadow !== 'none' ? 16 : 0);
      if (el.tagName === 'TABLE') return table(el);
      if (el.tagName === 'IMG') return image(el);
      const bg = col(cs.backgroundColor), bw = parseFloat(cs.borderTopWidth) || 0, bc = cs.borderTopStyle !== 'none' && bw ? col(cs.borderTopColor) : null;
      if (bg || bc) items.push({ k: 'box', ...rel(el.getBoundingClientRect()), fill: bg?.hex || null, fa: bg?.a ?? 1, line: bc?.hex || null, lw: bc ? bw : 0, r: parseFloat(cs.borderTopLeftRadius) || 0 });
      if ((el.tagName === 'UL' || el.tagName === 'OL') && [...el.children].every((li) => li.tagName === 'LI' && ![...li.children].some(blockish))) {
        return textItem(el, [...el.children].map((li, i) => para(li, { bullet: el.tagName === 'UL' ? '•' : `${i + 1}.` })));
      }
      textItem(el, [para(el)]);
      for (const c of el.children) if (blockish(c) || RASTER_TAGS[c.tagName.toUpperCase()] || c.tagName === 'IMG' || c.classList.contains('obj')) walk(c);
    }
    for (const c of slide.children) walk(c);
    let bg = sbg ? sbg.hex : 'ffffff';
    if (scs.backgroundImage !== 'none') { // gradient or picture behind the page: one picture at the very bottom
      const it = { k: 'raster', x: 0, y: 0, w: W, h: H, id: slide.id, why: '页面背景' };
      items.unshift(it); rasters.push([null, it]);
    }
    if (rasters.length) await cut(slide, rasters, skipped, items);
    await Promise.all(pending);
    return { id: slide.id, bg, items };
  }
  async function render(slide, mode) { // mode t: only the marked rasters, page background clear; b: the page background alone
    const st = document.createElement('style'); st.dataset.ppt = '';
    st.textContent = '[data-ppt-x="t"] *, [data-ppt-x="b"] * { visibility: hidden !important; } [data-ppt-x="t"] { background: transparent !important; }'
      + '[data-ppt-x="r"], [data-ppt-x="r"] * { visibility: visible !important; }';
    document.head.append(st); slide.dataset.pptX = mode;
    try { return await htmlToImage.toCanvas(slide, { width: W, height: H, pixelRatio: 2, style: { zoom: '1', margin: '0' } }); }
    finally { delete slide.dataset.pptX; st.remove(); }
  }
  async function cut(slide, rasters, skipped, items) {
    const marked = rasters.filter(([el]) => el);
    marked.forEach(([el]) => { el.dataset.pptX = 'r'; });
    try {
      const fg = marked.length ? await render(slide, 't') : null, bgc = rasters.some(([el]) => !el) ? await render(slide, 'b') : null;
      for (const [el, it] of rasters) {
        const src = el ? fg : bgc, c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(it.w * 2)); c.height = Math.max(1, Math.round(it.h * 2));
        c.getContext('2d').drawImage(src, it.x * 2, it.y * 2, c.width, c.height, 0, 0, c.width, c.height);
        it.src = c.toDataURL('image/png');
      }
    } catch (e) {
      for (const [, it] of rasters) { items.splice(items.indexOf(it), 1); skipped.push({ id: it.id, why: `转图片失败：${e.message || e}` }); }
    } finally { marked.forEach(([el]) => { delete el.dataset.pptX; }); }
  }
  async function measure(slides) {
    const skipped = [], out = [];
    for (const s of slides) out.push(await measureSlide(s, skipped));
    return { slides: out, skipped };
  }
  return { measure };
})();
```

- [ ] **Step 4: Wire the button**

`ppt/toolbar.js`：在 `importBtn` 那行之后加：

```js
    const exportBtn = btn(top, '导出 PPT', '导出成可在 PowerPoint 里编辑的 .pptx', () => cb.exportPptx());
```

并在 `return {` 返回的对象里加：

```js
      setExporting(on) { exportBtn.disabled = on; exportBtn.textContent = on ? '导出中…' : '导出 PPT'; },
```

`ppt/editor.js`：
- 在 `PPTToolbar.create(ui, {` 的回调里加 `exportPptx: () => exportPptx(),`。
- `toast` 改成：

```js
  function toast(msg, text, href, label = '打开原稿') {
    const t = el('div', 'ppt-toast', ui);
    const x = el('button', 'x', t, '×'); x.onclick = () => t.remove();
    el('p', null, t, msg);
    if (href) { const a = el('a', null, t, label); a.href = href; a.target = '_blank'; a.rel = 'noopener'; } // the server sends it url-safe
    if (text != null) { const ta = el('textarea', null, t); ta.value = text; ta.readOnly = true; }
  }
```

- 在 `importFile` 前面加：

```js
  let exporting = false;
  async function exportPptx() { // measured here, built by the server; the file downloads and a report pops up
    if (exporting) return;
    exporting = true; tb.setExporting(true); select(null); closePop();
    try {
      const data = await PPTExport.measure(slides());
      const r = await fetch(api('/api/export'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || String(r.status));
      const a = el('a', null, ui); a.href = d.url; a.download = ''; a.click(); a.remove();
      toast(d.summary, null, d.url, '下载');
    } catch (e) { toast(`没有导出：${e.message}`); }
    finally { exporting = false; tb.setExporting(false); }
  }
```

`ppt/server.py`：`INJECT` 里在 `toolbar.js` 那行之前加 `'<script src="/_ppt/export.js" data-ppt></script>'`。

- [ ] **Step 5: Run e2e, selftest, server tests**

Run:
- `node tests/e2e.mjs > "$TEMP/ppt-logs/e2e.log" 2>&1; grep -E "^FAIL|passed" "$TEMP/ppt-logs/e2e.log"`
- `bash "$TEMP/ppt-logs/selftest.sh" | tail -1`
- `timeout 300 python ppt/test_server.py | tail -1`

Expected: e2e 全部 PASS；selftest 99/99；server `OK`。

- [ ] **Step 6: Commit**

```bash
git add ppt/export.js ppt/toolbar.js ppt/editor.js ppt/server.py tests/e2e.mjs
git commit -m "feat(export): measure slides in the page, 导出 PPT button and report"
```

---

### Task 4: 终端 `--export`（无头 Edge + `export=1`）

**Files:**
- Modify:
  - `ppt/server.py`（新增 `browser()`、`export_cli()`，增加 `--export` 参数）
  - `ppt/editor.js`（启动时检测 `export=1`）
- Test: `ppt/test_server.py`（新增 `ExportCliTests`，没有浏览器时跳过）

**Interfaces:**
- Consumes:
  - `live_server`、`detach`（已有）；
  - `.ppt/export.json`（Task 2）；
  - `exportPptx()`（Task 3）。
- Produces: `server.browser() -> str | None`；`server.export_cli(deck, port) -> None`（打印两行：文件路径和报告）。

- [ ] **Step 1: Write the failing test**

```python
@unittest.skipUnless(server.browser(), "needs Edge or Chrome")
class ExportCliTests(unittest.TestCase):
    def test_export_from_the_terminal(self):
        proj = Path(tempfile.mkdtemp())
        deck = proj / "decks" / "导出"
        self.addCleanup(shutil.rmtree, proj, True)
        self.addCleanup(subprocess.run, [sys.executable, SERVER_PY, "--stop", str(deck)], capture_output=True, timeout=30)
        r = subprocess.run([sys.executable, SERVER_PY, "--export", "--port", "8860", str(deck)], capture_output=True, text=True, encoding="utf-8", timeout=200)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        files = list((deck / "export").glob("*.pptx"))
        self.assertEqual(len(files), 1)
        self.assertIn(str(files[0].resolve()), r.stdout)
        self.assertIn("导出完成：1 页", r.stdout)
```

- [ ] **Step 2: Run to verify failure**

Run: `timeout 300 python ppt/test_server.py ExportCliTests`
Expected: ERROR `module 'server' has no attribute 'browser'`

- [ ] **Step 3: Implement**

`server.py`（放在 `stop_server` 之后）：

```python
BROWSERS = ("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
            "C:/Program Files/Google/Chrome/Application/chrome.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/microsoft-edge")


def browser():
    return next((p for p in (os.environ.get("PPT_BROWSER"), *BROWSERS) if p and Path(p).is_file()), None)


def export_cli(deck, port):
    """Export from the terminal: the same page-side export, driven by a headless browser."""
    exe = browser()
    if not exe:
        raise SystemExit("找不到 Edge 或 Chrome：设置环境变量 PPT_BROWSER 指向浏览器")
    info = live_server(deck)
    if not info:
        detach(deck, port, False)
        info = live_server(deck)
    res_file = runtime(deck) / "export.json"
    res_file.unlink(missing_ok=True)
    prof = Path(tempfile.mkdtemp(prefix="ppt-export-"))
    p = subprocess.Popen([exe, "--headless=new", "--disable-gpu", f"--user-data-dir={prof}", "--window-size=1400,900", info["url"] + "&export=1"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(480):
            if res_file.exists():
                res = json.loads(res_file.read_text(encoding="utf-8"))
                print(res["file"], flush=True)
                return print(res["summary"], flush=True)
            if p.poll() is not None:
                break
            time.sleep(0.25)
        raise SystemExit("导出没有完成（120 秒内没有结果）；在浏览器里点\"导出 PPT\"看看提示")
    finally:
        p.kill()
        p.wait(10)
        shutil.rmtree(prof, ignore_errors=True)
```

- 增加 `import shutil, tempfile`。
- argparse 加 `ap.add_argument("--export", action="store_true", help="export this deck to .pptx from the terminal")`。
- `serving` 的排除条件加上 `a.export`：`--export` 遇到不存在的 deck 时报错，不新建。
- 在 `if a.stop:` 之后加 `if a.export: return export_cli(deck, a.port)`。

`editor.js`：在 `poll();` 那行之后加：

```js
  if (new URLSearchParams(location.search).get('export') === '1') document.fonts.ready.then(() => setTimeout(exportPptx, 800)); // server.py --export
```

- [ ] **Step 4: Run to verify pass**

Run: `timeout 300 python ppt/test_server.py ExportCliTests`，然后跑完整套：`timeout 400 python ppt/test_server.py | tail -1`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add ppt/server.py ppt/editor.js ppt/test_server.py
git commit -m "feat(export): server.py --export drives the page export headlessly"
```

---

### Task 5: 导入 pptx

**Files:**
- Modify:
  - `ppt/importer.py`（`EXTS`、`check_name`、`pptx_extract`、`render_pdf`、`event`）
  - `ppt/server.py`（`import_post` 捕获 `exporter.Missing` 返回 503；PDF 不加 sandbox）
  - `ppt/toolbar.js`（对话框的标题和 accept）
  - `ppt/editor.js`（`importFile` 的扩展名检查）
- Test: `ppt/test_server.py`（新增 `PptxImportTests(ServerCase)`）、`tests/e2e.mjs`

**Interfaces:**
- Consumes: `exporter.need_pptx`、`exporter.Missing`（Task 1）。
- Produces:
  - `importer.pptx_extract(path: Path, out_dir: Path) -> dict`（同时写 `slides.json`）；
  - `importer.render_pdf(path, out_dir) -> Path | None`；
  - import 事件：`{type:"import", kind:"file", hint:"pptx", mode, import_id, text, source:<slides.json>, pdf:<path>|None, media:<dir>, dir, original}`。

- [ ] **Step 1: Write the failing tests**

```python
def make_pptx(path, width_in=13.333, height_in=7.5):
    from pptx import Presentation
    from pptx.dml.color import RGBColor
    from pptx.enum.shapes import MSO_SHAPE
    from pptx.util import Inches, Pt
    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(width_in), Inches(height_in)
    s = prs.slides.add_slide(prs.slide_layouts[1])  # title + content placeholders: positions come from the layout
    s.shapes.title.text = "季度复盘"
    tb = s.shapes.add_textbox(Inches(1), Inches(5), Inches(4), Inches(1))
    r = tb.text_frame.paragraphs[0].add_run()
    r.text, r.font.size, r.font.bold = "大字", Pt(30), True
    r.font.color.rgb = RGBColor(0x11, 0x22, 0x33)
    sh = s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(6), Inches(1), Inches(2), Inches(1))
    sh.fill.solid(); sh.fill.fore_color.rgb = RGBColor(0x38, 0xBD, 0xF8)
    grp = s.shapes.add_group_shape()
    grp.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(9), Inches(4), Inches(1), Inches(1))
    s.shapes.add_picture(io.BytesIO(base64.b64decode(PNG_1PX)), Inches(10), Inches(1), Inches(1), Inches(1))
    t = s.shapes.add_table(2, 2, Inches(1), Inches(6), Inches(4), Inches(1)).table
    t.cell(0, 0).text = "指标"
    prs.slides.add_slide(prs.slide_layouts[6])
    prs.save(str(path))


class PptxImportTests(ServerCase):
    def up(self, data, name, mode="append"):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=120)
        c.request("POST", f"/api/import?t=tok&mode={mode}&name={quote(name)}", data, {"Host": f"127.0.0.1:{self.port}"})
        r = c.getresponse()
        out = (r.status, json.loads(r.read() or b"null"))
        c.close()
        return out

    def test_pptx_is_taken_apart_for_claude(self):
        src = self.tmp / "old.pptx"
        make_pptx(src)
        with mock.patch.object(importer, "render_pdf", return_value=None):
            st, d = self.up(src.read_bytes(), "旧稿.pptx")
        self.assertEqual(st, 200, d)
        e = inbox(self.deck)[-1]
        self.assertEqual((e["type"], e["hint"], e["pdf"]), ("import", "pptx", None))
        sj = json.loads(Path(e["source"]).read_text(encoding="utf-8"))
        self.assertEqual((sj["size"]["w"], round(sj["size"]["h"]), sj["size"]["ratio"]), (1280, 720, "16:9"))
        self.assertEqual(len(sj["slides"]), 2)
        items = sj["slides"][0]["items"]
        title = [i for i in items if i["kind"] == "text" and i["paras"] and i["paras"][0]["runs"] and i["paras"][0]["runs"][0]["t"] == "季度复盘"][0]
        self.assertGreater(title["w"], 0)  # inherited from the layout placeholder
        big = [i for i in items if i["kind"] == "text" and "大字" in json.dumps(i, ensure_ascii=False)][0]
        self.assertEqual((round(big["x"]), round(big["y"])), (96, 480))
        run = big["paras"][0]["runs"][0]
        self.assertEqual((round(run["size"]), run["b"], run["color"]), (40, True, "112233"))
        oval = [i for i in items if i["kind"] == "shape" and i.get("shape") == "OVAL"][0]
        self.assertEqual(oval["fill"], "38BDF8")
        grp_rect = [i for i in items if i["kind"] == "shape" and i.get("shape") == "RECTANGLE"][0]
        self.assertEqual((round(grp_rect["x"]), round(grp_rect["y"])), (864, 384))  # group child in page coordinates
        pic = [i for i in items if i["kind"] == "picture"][0]
        self.assertTrue((Path(e["dir"]) / pic["file"]).is_file())
        tbl = [i for i in items if i["kind"] == "table"][0]
        self.assertEqual(tbl["cells"][0][0], "指标")
        self.assertIn("colors", sj["theme"])

    def test_a_4_3_deck_keeps_its_ratio(self):
        src = self.tmp / "old43.pptx"
        make_pptx(src, 10, 7.5)
        with mock.patch.object(importer, "render_pdf", return_value=None):
            self.assertEqual(self.up(src.read_bytes(), "a.pptx")[0], 200)
        sj = json.loads(Path(inbox(self.deck)[-1]["source"]).read_text(encoding="utf-8"))
        self.assertEqual((sj["size"]["w"], sj["size"]["h"], sj["size"]["ratio"]), (1280, 960, "4:3"))

    def test_broken_pptx_and_old_ppt_are_refused_cleanly(self):
        self.assertEqual(self.up(b"PK\x03\x04 not really", "bad.pptx"), (400, {"error": "无法读取这个 pptx"}))
        self.assertEqual(self.up(b"\xd0\xcf\x11\xe0", "old.ppt")[1]["error"], "请先在 PowerPoint 里另存为 .pptx")
        self.assertEqual([p for p in (self.deck / "imports").iterdir()] if (self.deck / "imports").exists() else [], [])

    def test_no_python_pptx_gives_503(self):
        src = self.tmp / "old.pptx"
        make_pptx(src)
        with mock.patch.object(importer, "pptx_extract", side_effect=exporter.Missing("导出需要 python-pptx：pip install python-pptx")):
            self.assertEqual(self.up(src.read_bytes(), "x.pptx")[0], 503)
        self.assertEqual(list((self.deck / "imports").iterdir()), [])

    def test_render_pdf_without_libreoffice_is_none(self):
        with mock.patch.object(importer, "soffice", return_value=None):
            self.assertIsNone(importer.render_pdf(self.tmp / "x.pptx", self.tmp))

    def test_pdf_original_is_not_sandboxed(self):  # Chrome's PDF viewer won't open under CSP sandbox
        (self.deck / "imports" / "i-x").mkdir(parents=True)
        (self.deck / "imports" / "i-x" / "slides.pdf").write_bytes(b"%PDF-1.4")
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("GET", "/imports/i-x/slides.pdf", headers={"Host": f"127.0.0.1:{self.port}"})
        self.assertIsNone(c.getresponse().getheader("Content-Security-Policy"))
        c.close()
```

- [ ] **Step 2: Run to verify failure**

Run: `timeout 300 python ppt/test_server.py PptxImportTests`
Expected: FAIL（400 "只能导入…" 或没有 `render_pdf`）

- [ ] **Step 3: Implement `importer.py`**

- `EXTS = (".html", ".htm", ".zip", ".pptx")`；`check_name` 改成：

```python
def check_name(name):
    ext = Path(kb.safe_name(name)).suffix.lower()
    if ext == ".ppt":
        raise ValueError("请先在 PowerPoint 里另存为 .pptx")
    if ext not in EXTS:
        raise ValueError("只能导入 .html、.htm、.zip 或 .pptx")
    return ext
```

- `save` 里非 zip 的分支保持不变（`.pptx` 原样落成 entry）。
- 新增：

```python
from exporter import Missing, need_pptx

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
                    shape = sh.auto_shape_type.name if st == MSO_SHAPE_TYPE.AUTO_SHAPE else None
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
            v = c[0].get("val") or c[0].get("lastClr") if len(c) else None
            colors[c.tag.replace(A, "")] = v
        break
    fonts = {}
    for kind in ("majorFont", "minorFont"):
        el = next(root.iter(f"{A}{kind}"), None)
        if el is not None:
            fonts[kind] = {t: (el.find(f"{A}{t}").get("typeface") if el.find(f"{A}{t}") is not None else None) for t in ("latin", "ea")}
    return {"colors": colors, "fonts": fonts}
```

- 增加 `import json, subprocess, tempfile`。
- `event()` 的开头加 pptx 分支：

```python
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
```

`server.py`：
- `import_post` 增加 `except exporter.Missing as e: return self.send(503, {"error": str(e)})`，放在 `except ValueError` 之前。
- 静态文件的 sandbox 改成 `sandbox = {"Content-Security-Policy": "sandbox"} if root == deck and f.suffix.lower() != ".pdf" else None`，并加注释：Chrome 的 PDF 查看器在 sandbox 下打不开，而且它本身在独立进程里运行。

`toolbar.js`：
- 标题 `'导入以前做过的 HTML'` 改成 `'导入以前做过的 HTML 或 PPTX'`（两处：按钮 title 和对话框的 `<b>`）。
- `file.accept = '.html,.htm,.zip,.pptx'`。
- "选择文件"的说明改为 `'选择 .html / .htm / .pptx，或把 HTML 和图片打包成 .zip'`。

`editor.js`：`importFile` 的检查改为 `if (!/\.(html?|zip|pptx)$/i.test(f.name)) return toast(/\.ppt$/i.test(f.name) ? '请先在 PowerPoint 里另存为 .pptx' : '只能导入 .html、.htm、.zip 或 .pptx');`

- [ ] **Step 4: e2e import check**（加在 Task 3 的 checks 之后）

```js
  const pptxPath = path.join(SCRATCH, '旧稿.pptx');
  execFileSync('python', ['-c', `import sys
from pptx import Presentation
p = Presentation(); s = p.slides.add_slide(p.slide_layouts[1]); s.shapes.title.text = "旧 PPT 标题"; p.save(sys.argv[1])`, pptxPath]);
  b9 = await byTitle('导入以前做过的 HTML'); await click(b9.x, b9.y); await sleep(400);
  check('I3 the dialog accepts pptx', (await ev(`document.querySelector('.ppt-import input[type=file]').accept`)).includes('.pptx'));
  { const d = await send('DOM.getDocument'); const q = await send('DOM.querySelector', { nodeId: d.result.root.nodeId, selector: '.ppt-import input[type=file]' });
    await send('DOM.setFileInputFiles', { files: [pptxPath], nodeId: q.result.nodeId }); }
  let pe = null;
  for (let i = 0; i < 120 && !pe; i++) { await sleep(500); pe = inbox().find((e) => e.type === 'import' && e.hint === 'pptx'); }
  check('I3 a pptx becomes an import event for Claude', !!pe && fs.existsSync(pe.source) && fs.existsSync(pe.media), JSON.stringify(pe)?.slice(0, 200));
```

- [ ] **Step 5: Run everything**

Run:
- `timeout 400 python ppt/test_server.py | tail -1`
- `bash "$TEMP/ppt-logs/selftest.sh" | tail -1`
- `node tests/e2e.mjs > "$TEMP/ppt-logs/e2e.log" 2>&1; grep -E "^FAIL|passed" "$TEMP/ppt-logs/e2e.log"`

Expected: 全部通过。

- [ ] **Step 6: Commit**

```bash
git add ppt/importer.py ppt/server.py ppt/toolbar.js ppt/editor.js ppt/test_server.py tests/e2e.mjs
git commit -m "feat(import): pptx -> slides.json + media + slides.pdf for Claude to rebuild"
```

---

### Task 6: `ppt.md` 规则 + 真实验收

**Files:**
- Modify: `.claude/commands/ppt.md`

- [ ] **Step 1: 规则**

在 import 事件的 hint 列表里（`page` 那条之后）加：

```
  - `pptx`：`source` 是 `slides.json`（坐标已换算成画布像素，宽 1280；`size.ratio` 不是 16:9 时按比例放进 16:9，空出的地方留白），`media` 是原图，有 `pdf` 时用 Read 按页对照原样。一页对一页：标题、正文这类文本框对齐 16×9 网格做成块；装饰形状、线条、箭头、图片按精确像素做成浮动对象（规则 10）；`theme` 的配色和字体写进 `#theme`；用到的 `media/` 图片复制到 `assets/`。`unsupported`（图表、SmartArt 等）能用表格或 SVG 表达就重建，否则从 PDF 截出那块当图片放进去。备注、动画、切换效果不保留。
```

在终端相关规则那里（`--import` 那条之后）加：

```
- 用户在终端说"导出 PPT / 导出成 pptx"：`python ppt/server.py --export "decks/<名字>"`，把输出的文件路径和报告（哪些转成了图片）告诉用户。页面上的"导出 PPT"按钮不经过你。
```

- [ ] **Step 2: 真实验收**（临时项目放在 scratchpad，验收完删除）
1. 复制一份带表格、SVG、形状、箭头的 deck，用 `--detach` 启动服务。在页面点"导出 PPT"，确认下载和报告。
2. 用 LibreOffice 把导出的 pptx 转成 PDF，看每页（Read），和页面截图对比：文字位置、换行、颜色、表格、箭头。有明显偏差就回到 Task 3 修，并记 Ruling。
3. 运行 `server.py --export`，确认输出的路径和报告正确。
4. 用 python-pptx 做一份多页 pptx（含组合、图片、表格），在页面里导入。我作为 Claude 按 `ppt.md` 重建，回执后看页面上的提示和"打开原稿"（PDF）能否打开。
5. 停掉服务，删掉临时目录。

- [ ] **Step 3: Commit**

```bash
git add .claude/commands/ppt.md
git commit -m "docs(ppt.md): rebuild imported pptx; export from the terminal"
```
