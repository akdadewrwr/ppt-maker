"""ppt-maker runner: the agent session's job (wait -> handle -> reply) done by the user's own agent command or LLM API."""
import argparse, base64, contextlib, json, os, re, signal, subprocess, sys, threading, urllib.error, urllib.request
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server

REPO = Path(__file__).resolve().parent.parent

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


# ---- the loop ----
def pending(deck):
    st = server.statuses(deck)
    return [e for e in server.read_jsonl(server.runtime(deck) / "inbox.jsonl")
            if e.get("type") in server.REPLY_TYPES and st.get(e.get("id")) != "done"]


@contextlib.contextmanager
def beating(deck):
    """Keep the page showing us online while one handle runs (an LLM call or an agent can take minutes)."""
    done = threading.Event()
    hb = server.runtime(deck) / "heartbeat"
    def beat():
        while True:
            hb.write_text(server.now_iso(), encoding="utf-8")
            if done.wait(server.HEARTBEAT_SECS):
                return
    t = threading.Thread(target=beat, daemon=True)
    t.start()
    try:
        yield
    finally:
        done.set()
        t.join()


def finish(deck, evs, text):
    """Reply to every event of `evs` that is still not done (never twice)."""
    st = server.statuses(deck)
    for e in evs:
        if st.get(e["id"]) != "done":
            server.reply(deck, e["id"], text)


def run(deck, handle, name, stop=lambda: False, interval=0.5):
    first = True
    while True:
        lines = []
        got = server.wait_events(deck, lines.append, recent=first, idle=float("inf"), agent=name, stop=stop, interval=interval)
        first = False  # the first wait also picks up what a crashed run left half done
        for line in lines:
            print(line, flush=True)
        if got == "stopped":
            return "stopped"
        if got != "events":
            return None
        evs = pending(deck)
        for e in evs:
            server.reply(deck, e["id"], ack=True)
        with beating(deck):
            try:
                handle(evs, lines)
            except Exception as x:  # one bad event must never stop the loop
                print(f"出错：{type(x).__name__}: {x}", file=sys.stderr, flush=True)
                finish(deck, evs, f"没改成：{type(x).__name__}")


# ---- agent backend ----
def agent_prompt(deck, lines):
    py = Path(sys.executable).as_posix()
    return ((REPO / "prompts" / "ppt-common.md").read_text(encoding="utf-8")
            + f"\n\n## 路径\n- 上面的 `ppt/…` 指 `{REPO.as_posix()}/ppt/…`；`decks/<名字>` 指 `{Path(deck).as_posix()}`。"
            + f"\n- 命令里的 `python` 用 `{py}`，路径一律加引号。例：`\"{py}\" \"{REPO.as_posix()}/ppt/server.py\" --reply \"{Path(deck).as_posix()}\" <id> --ack`"
            + "\n\n## 这次要处理的操作\n" + "\n".join(lines)
            + "\n\n处理完每个事件都要先 --ack 再 --reply（不需要改动的也回执一句说明）；处理完就退出，不要运行 --wait 或 --tail。\n")


def kill_tree(p):
    if os.name == "nt":
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(p.pid)], capture_output=True)
    else:
        with contextlib.suppress(OSError):
            os.killpg(p.pid, signal.SIGKILL)


def agent_handle(deck, cmd, timeout, name):
    deck = Path(deck).resolve()
    def handle(evs, lines):
        prompt = agent_prompt(deck, lines)
        pf = server.runtime(deck) / "runner-prompt.md"
        pf.write_bytes(prompt.encode("utf-8"))
        c = cmd.replace("{prompt}", f'"{pf}"').replace("{deck}", f'"{deck}"')
        with pf.open("rb") as stdin:  # a file, not a pipe: a child that never reads stdin can't block us before the timeout starts
            p = subprocess.Popen(c, shell=True, cwd=deck.parent.parent, stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 start_new_session=os.name != "nt")
        try:
            out, err = p.communicate(timeout=timeout)
            code = p.returncode
        except subprocess.TimeoutExpired:
            kill_tree(p)  # the shell's children too, or their open pipes would block us
            code, out, err = "超时", b"", b""
            with contextlib.suppress(subprocess.TimeoutExpired):
                out, err = p.communicate(timeout=5)
        out, err = (out or b"").decode("utf-8", "replace"), (err or b"").decode("utf-8", "replace")
        if out.strip():
            print(out.strip()[-2000:], flush=True)
        finish(deck, evs, f"{name} 没有回执这条（退出码 {code}）：{err.strip()[-300:]}")
    return handle


# ---- llm backend ----
UNSUPPORTED = "API 模式暂不支持这类操作（知识库 / 导入），请用 Claude / Codex 或 agent 后端"
TOO_BIG = "这份稿子太大，API 模式处理不了，请指定一页再说"
MAX_PAGES = 200_000


def scrub(s, key):
    return s.replace(key, "***") if key else s


def chat(base_url, key, model, messages, timeout):
    """One OpenAI-compatible chat completion -> the reply text. Errors are RuntimeError with a short reason, never the key."""
    url = base_url.rstrip("/") + "/chat/completions"
    body = {"model": model, "messages": messages, "response_format": {"type": "json_object"}}
    while True:
        req = urllib.request.Request(url, json.dumps(body, ensure_ascii=False).encode("utf-8"),
                                     {"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = json.loads(r.read().decode("utf-8"))
            return data["choices"][0]["message"]["content"]
        except urllib.error.HTTPError as e:
            if e.code == 400 and "response_format" in body:  # some servers don't take json mode: once more without it
                body.pop("response_format")
                continue
            detail = e.read()[:300].decode("utf-8", "replace")
            raise RuntimeError(scrub(f"接口返回 {e.code}：{detail}", key)) from None
        except (urllib.error.URLError, OSError) as e:
            raise RuntimeError(scrub(f"连不上接口：{e}", key)) from None
        except (KeyError, IndexError, TypeError, ValueError):
            raise RuntimeError("接口返回的内容看不懂") from None


def pages_for(ev, by_id, html):
    """The slide ids an event is about, or None (= send every page)."""
    have = {i for i, _, _ in sections(html)}
    if ev.get("type") == "answer":
        orig = by_id.get(ev.get("re"))
        return pages_for(orig, by_id, html) if orig and orig is not ev else None
    if ev.get("items"):
        ids = [it.get("slide_id") for it in ev["items"]]
    elif ev.get("type") == "lint":
        spans = sections(html)
        ids = []
        for iss in ev.get("issues") or []:
            m = re.search(rf"""(?<![\w-])id\s*=\s*["']{re.escape(str(iss.get("block", "")))}["']""", html)
            ids += [i for i, s, e in spans if m and s <= m.start() < e]
    else:
        ids = [ev.get("slide_id")]
    ids = list(dict.fromkeys(i for i in ids if i in have))
    return ids or None


def _image(deck, rel):
    try:
        p = (Path(deck) / rel).resolve()
        if Path(deck).resolve() not in p.parents:
            return None
        return {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode()}}
    except (OSError, TypeError, ValueError):
        return None


def build_messages(deck, ev, by_id, html):
    ids = pages_for(ev, by_id, html)
    spans = sections(html)
    pick = [html[s:e] for i, s, e in spans if ids is None or i in ids]
    if sum(map(len, pick)) > MAX_PAGES:
        raise ValueError(TOO_BIG)
    sent = snapshot(html, [i for i, _, _ in spans if ids is None or i in ids])
    clean = lambda e: {k: ([{kk: vv for kk, vv in it.items() if kk != "shot"} for it in v] if k == "items" else v)
                       for k, v in e.items() if k not in ("shot", "ts")}
    text = ["操作：" + json.dumps(clean(ev), ensure_ascii=False)]
    if ev.get("type") == "answer" and by_id.get(ev.get("re")):
        said = [r.get("text", "") for r in server.outbox_rows(deck) if r.get("re") == ev["re"] and not r.get("ack")]
        text.append("原来的意图：" + json.dumps(clean(by_id[ev["re"]]), ensure_ascii=False))
        text.append("你之前的回执：" + (said[-1] if said else "（无）"))
    text.append("主题：\n" + sent.get("#theme", "（没有 #theme）"))
    text.append("全部页面 id（按顺序）：" + ", ".join(i for i, _, _ in spans))
    text.append("相关页面：\n" + "\n".join(pick))
    parts = [{"type": "text", "text": "\n\n".join(text)}]
    shots = [ev.get("shot")] + [it.get("shot") for it in ev.get("items") or []]
    parts += [img for img in (_image(deck, s) for s in shots if s) if img]
    system = (REPO / "prompts" / "ppt-llm.md").read_text(encoding="utf-8")
    return [{"role": "system", "content": system}, {"role": "user", "content": parts}], sent


def _unsupported(ev):
    return ev.get("type") in ("kb", "import") or bool(ev.get("kb"))


def _parse(content):
    s = content.strip()
    s = re.sub(r"^```(?:json)?\s*|\s*```$", "", s)  # some models wrap it anyway
    try:
        resp = json.loads(s)
    except ValueError:
        raise ValueError("模型返回的不是 JSON") from None
    if not isinstance(resp, dict) or not isinstance(resp.get("reply"), str):
        raise ValueError("模型返回的 JSON 缺少 reply")
    return resp


def write_deck(deck, html):
    f = Path(deck) / "deck.html"
    tmp = f.with_name(".deck.runner.tmp")
    tmp.write_bytes(html.encode("utf-8"))
    os.replace(tmp, f)  # atomic: the page and the watcher never see half a file


def llm_handle(deck, base_url, key, model, timeout, name):
    deck = Path(deck).resolve()
    f = deck / "deck.html"
    def one(ev, by_id):
        if _unsupported(ev):
            return UNSUPPORTED
        html = f.read_text(encoding="utf-8")
        try:
            messages, sent = build_messages(deck, ev, by_id, html)
        except ValueError as x:
            return str(x)
        resp = _parse(chat(base_url, key, model, messages, timeout))
        now = f.read_text(encoding="utf-8")  # the user may have changed it while the model was thinking
        new, why = apply_changes(now, resp, sent)
        if why:
            return why if why == CONFLICT else f"没改成：{why}"
        if new != now:
            write_deck(deck, new)
        return resp["reply"]
    def handle(evs, lines):
        by_id = {e.get("id"): e for e in server.read_jsonl(server.runtime(deck) / "inbox.jsonl")}
        for ev in evs:
            print(f"处理 {server.safe_summary(ev)}", flush=True)
            try:
                text = one(ev, by_id)
            except (RuntimeError, ValueError) as x:
                text = f"没改成：{x}"
            except Exception as x:  # one bad event must not take the others down
                text = f"没改成：{type(x).__name__}"
            server.reply(deck, ev["id"], scrub(text, key))
    return handle


# ---- cli ----
KEY_HELP = "请先设置环境变量 PPT_API_KEY（PowerShell：$env:PPT_API_KEY=\"…\"；bash：export PPT_API_KEY=…）"


def main(argv=None):
    ap = argparse.ArgumentParser(description="ppt-maker runner: handle the page's events with your own agent command or LLM API")
    ap.add_argument("deck")
    ap.add_argument("--backend", choices=("agent", "llm"), required=True)
    ap.add_argument("--cmd", help="agent: shell command run for each batch of events; {prompt} / {deck} are replaced, the prompt is also on stdin")
    ap.add_argument("--base-url", help="llm: OpenAI-compatible base url, e.g. https://api.deepseek.com/v1")
    ap.add_argument("--model", help="llm: model name")
    ap.add_argument("--name", help="name shown on the page")
    ap.add_argument("--timeout", type=float, help="seconds per agent run (600) or llm request (180)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-open", action="store_true")
    a = ap.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    deck = Path(a.deck).resolve()
    if a.backend == "agent":
        if not a.cmd:
            ap.error("--backend agent needs --cmd")
        name = (a.name or "Agent")[:20]
        handle = agent_handle(deck, a.cmd, a.timeout or 600, name)
    else:
        if not (a.base_url and a.model):
            ap.error("--backend llm needs --base-url and --model")
        key = os.environ.get("PPT_API_KEY", "").strip()
        if not key:
            raise SystemExit(KEY_HELP)
        name = (a.name or a.model)[:20]
        handle = llm_handle(deck, a.base_url, key, a.model, a.timeout or 180, name)
    server.detach(deck, a.port, not a.no_open)
    print(f"已开始监听（{name}），Ctrl+C 退出", flush=True)
    try:
        if run(deck, handle, name) == "stopped":
            print("服务已停止，runner 退出。重新运行这条命令即可。", flush=True)
    except KeyboardInterrupt:
        print("已退出", flush=True)


if __name__ == "__main__":
    main()
