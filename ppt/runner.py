"""ppt-maker runner: the agent session's job (wait -> handle -> reply) done by the user's own agent command or LLM API."""
import re
from collections import Counter

CONFLICT = "你刚改了这页，我没覆盖，请再说一次"
TAG = re.compile(r"<(/?)section\b[^>]*>", re.I)
ID = re.compile(r"""(?<![\w-])id\s*=\s*["']([^"']+)["']""", re.I)
THEME = re.compile(r"""<style\b[^>]*(?<![\w-])id\s*=\s*["']theme["'][^>]*>.*?</style\s*>""", re.I | re.S)
FORBIDDEN = ((r"<script", "含脚本"), (r"<[^>]*\son[a-z]+\s*=", "含 on… 事件属性"), (r"javascript:", "含 javascript: 链接"),
             (r"https?://", "引用了外部网址"), (r"@import", "含 @import"), (r"data:(?!image/)", "含非图片的 data: 链接"),
             (r"data-ppt", "含 data-ppt 属性"), (r"""class\s*=\s*["'][^"']*(?<![\w-])ppt-""", "用了 ppt- 开头的 class"))


def sections(html):
    """(id, start, end) of each top-level <section class="slide">, nested <section>s inside counted out."""
    out, depth, top = [], 0, None
    for m in TAG.finditer(html):
        if not m.group(1):
            if depth == 0:
                tag = m.group(0)
                cls = re.search(r"""class\s*=\s*["']([^"']*)["']""", tag, re.I)
                i = ID.search(tag)
                top = (i.group(1), m.start()) if cls and "slide" in cls.group(1).split() and i else None
            depth += 1
        elif depth:
            depth -= 1
            if depth == 0 and top:
                out.append((top[0], top[1], m.end()))
                top = None
    return out


def theme_span(html):
    m = THEME.search(html)
    return m.span() if m else None


def bad_content(fragment):
    for pat, why in FORBIDDEN:
        if re.search(pat, fragment, re.I):
            return why
    return None


def snapshot(html, ids):
    cur = {i: html[s:e] for i, s, e in sections(html)}
    snap = {i: cur[i] for i in ids if i in cur}
    t = theme_span(html)
    if t:
        snap["#theme"] = html[t[0]:t[1]]
    return snap


def _one_section(h, want):
    h = h.strip()
    sp = sections(h)
    if len(sp) != 1 or sp[0][1] != 0 or sp[0][2] != len(h):
        return None, "返回的页面不是恰好一个 <section class=\"slide\">"
    if want is not None and sp[0][0] != want:
        return None, f"返回的页面 id 是 {sp[0][0]}，不是 {want}"
    return h, bad_content(h)


def _span(html, sid):
    return next(((s, e) for i, s, e in sections(html) if i == sid), None)


def apply_changes(html, resp, sent):
    """(new_html, None) or (None, reason). Pages the user changed since `sent` was taken are never overwritten."""
    slides, ins, dele, theme = resp.get("slides") or [], resp.get("insert") or [], resp.get("delete") or [], resp.get("theme")
    if not (isinstance(slides, list) and all(isinstance(x, dict) and isinstance(x.get("id"), str) and isinstance(x.get("html"), str) for x in slides)
            and isinstance(ins, list) and all(isinstance(x, dict) and isinstance(x.get("html"), str) and (x.get("after") is None or isinstance(x.get("after"), str)) for x in ins)
            and isinstance(dele, list) and all(isinstance(x, str) for x in dele) and (theme is None or isinstance(theme, str))):
        return None, "返回的 JSON 格式不对"
    cur = {i: html[s:e] for i, s, e in sections(html)}
    for sid in [x["id"] for x in slides] + dele + [x["after"] for x in ins if x.get("after")]:
        if sid not in sent:
            return None, f"没有 {sid} 这一页" if sid not in cur else f"{sid} 这一页没发给模型，不能改"
        if cur.get(sid) != sent[sid]:
            return None, CONFLICT
    if theme is not None:
        t = theme_span(html)
        if not t:
            return None, "这份稿子没有 <style id=\"theme\">，不能改主题"
        if html[t[0]:t[1]] != sent.get("#theme"):
            return None, CONFLICT
        t = theme.strip()
        if not THEME.fullmatch(t) or len(re.findall(r"<style\b", t, re.I)) != 1:
            return None, "主题必须恰好是一个 <style id=\"theme\">…</style>"
        if bad_content(t):
            return None, f"主题{bad_content(t)}"
    for x in slides:
        h, why = _one_section(x["html"], x["id"])
        if why or h is None:
            return None, why or "返回的页面不对"
        s, e = _span(html, x["id"])
        html = html[:s] + h + html[e:]
    for sid in dele:
        s, e = _span(html, sid)
        html = html[:s] + html[e:].removeprefix("\n")
    if not sections(html):
        return None, "不能删掉所有页面"
    for x in ins:
        h, why = _one_section(x["html"], None)
        if why or h is None:
            return None, why or "返回的页面不对"
        if x.get("after") is None:
            at = sections(html)[-1][2]
        else:
            sp = _span(html, x["after"])
            if not sp:
                return None, f"要插在 {x['after']} 之后，但这一页已删除"
            at = sp[1]
        html = html[:at] + "\n" + h + html[at:]
    if theme is not None:
        s, e = theme_span(html)
        html = html[:s] + theme.strip() + html[e:]
    dup = [i for i, n in Counter(ID.findall(html)).items() if n > 1]
    if dup:
        return None, f"id 重复：{', '.join(dup[:5])}"
    return html, None
