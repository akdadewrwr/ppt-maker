# API Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ppt/runner.py`, a long-running program that does the agent session's job (wait → handle → reply) by calling the user's own agent command or an OpenAI-compatible LLM API.

**Architecture:** runner imports `server` and reuses `wait_events` / `statuses` / `reply` / `detach`. It has two handlers: `agent_handle` runs a shell command per wakeup, and `llm_handle` makes one chat request per event, validates the returned page HTML, and writes deck.html atomically. Page code and server behavior do not change.

**Tech Stack:** Python 3 stdlib only (urllib, json, subprocess, html.parser not required).

**Spec:** docs/superpowers/specs/2026-10-22-ppt-maker-api-runner-design.md

## Global Constraints
- No third-party dependency.
- The key comes only from env `PPT_API_KEY`. It must never be written into the deck dir, a reply, or an error message.
- Agent name is at most 20 chars. Default: the model name (llm) or "Agent" (agent).
- Unsupported in llm: `kb`, `import`, and `intent` with `kb`. These are acked, then replied `API 模式暂不支持这类操作（知识库 / 导入），请用 Claude / Codex 或 agent 后端`.
- Conflict reply: `你刚改了这页，我没覆盖，请再说一次`.
- Too-big reply when page HTML sent exceeds 200,000 chars: `这份稿子太大，API 模式处理不了，请指定一页再说`.
- Heartbeat every 10 s while handling (`server.HEARTBEAT_SECS`).
- Default timeouts: agent 600 s, llm 180 s.
- Agent fallback reply: `<名字> 没有回执这条（退出码 N）：<stderr 最后 300 字>`. Re-check `statuses()` before writing it. A timeout counts as exit code `超时`.
- Validation forbids, in slide HTML and theme: `<script`, ` on…=`, `javascript:`, `http://` / `https://`, `@import`, `data:` other than `data:image/`, `data-ppt`, and class `ppt-…`. Theme must be exactly one `<style id="theme">…</style>`.
- Apply order: replace → delete → insert. `insert.after` must be a page still present after deletes; `null` means append at the end. At least one page must remain, and ids must be unique afterwards.

## Review Focus
1. A model returns `html` for an id that does not exist, or a `<section>` whose id differs from `id`. The deck must be untouched and the reply must say why. Covered by `test_apply_rejects_*`.
2. Runner restarted while an event was acked but not replied. It must be handled again, not left "processing" forever. Covered by `test_run_handles_acked_unreplied_after_restart`.
3. An agent command that hangs. It is killed at the timeout, the fallback reply is written, and the loop continues. Covered by `test_agent_timeout_fallback`.
4. An HTTP error body that echoes the Authorization header. The reply must not contain the key. Covered by `test_llm_error_never_leaks_key`.
5. A `<section>` that contains nested `<section>` tags (user content). Span finding must use the outer one. Covered by `test_sections_nested`.

---

### Task 1: deck surgery (pure functions)

**Files:**
- Create: `ppt/runner.py`
- Create: `ppt/test_runner.py` (same style as test_server.py: unittest; `sys.path` insert; `if __name__ == "__main__": unittest.main()`)

**Interfaces:**
- Produces:
  - `sections(html: str) -> list[tuple[str, int, int]]`: `(id, start, end)` for each top-level `<section … class="…slide…" … id="…">…</section>` in document order. Count nested `<section`/`</section>` to find the matching close.
  - `theme_span(html) -> tuple[int, int] | None`: span of `<style id="theme">…</style>`.
  - `bad_content(fragment: str) -> str | None`: the first forbidden thing found (a short Chinese reason), or None.
  - `snapshot(html, ids: list[str]) -> dict[str, str]`: `{id: section_html, "#theme": theme_html}` for the given ids (missing ids skipped).
  - `apply_changes(html: str, resp: dict, sent: dict) -> tuple[str | None, str | None]`: `(new_html, None)` or `(None, reason)`. `resp` is the model JSON (`reply`, `slides`, `insert`, `delete`, `theme`). `sent` is the `snapshot` taken before the request. If a replaced or deleted page, an `after` target, or (when `theme` is given) the theme differs from `sent`, or is missing from `sent`, return `CONFLICT`. Exception: a page the model replaces that was not sent at all is a validation error, not a conflict.
  - Constant `CONFLICT`.

- [ ] **Step 1: Write failing tests** in `class SurgeryTests`, built on `server/template.html`'s structure (two slides `s-a`, `s-b` and a theme):
  - `test_sections_nested`: a slide containing `<section>x</section>` → span ends at the outer `</section>`; ids `["s-a","s-b"]`.
  - `test_apply_replace_insert_delete`: replace s-a, insert s-c after s-a, delete s-b → `sections` ids `["s-a","s-c"]`, and the new s-a text is present.
  - `test_apply_insert_null_appends` → new page last.
  - `test_apply_theme`: theme replaced.
  - `test_apply_rejects_unknown_id`, `test_apply_rejects_id_mismatch`, `test_apply_rejects_duplicate_id`, `test_apply_rejects_delete_all`, `test_apply_rejects_after_deleted`: each returns `(None, reason)` with a non-empty reason.
  - `test_apply_rejects_forbidden`: one subTest for each of `<script>`, `onclick=`, `javascript:`, `https://x/a.png`, `@import`, `data:text/html`, `data-ppt`, `class="ppt-x"`. `data:image/png;base64,AA` is allowed.
  - `test_apply_rejects_bad_theme`: theme without `id="theme"`, or two style tags.
  - `test_apply_conflict`: `sent` holds the old s-a; html has a changed s-a → `(None, CONFLICT)`. Inserting after an unchanged page while another page changed is still accepted.
- [ ] **Step 2: Run** `PYTHONIOENCODING=utf-8 python ppt/test_runner.py`. Expected: ImportError / failures.
- [ ] **Step 3: Implement** the Produces above. Use regex plus depth counting for sections. Implement `bad_content` with case-insensitive regexes.
- [ ] **Step 4: Run again.** Expected: OK.
- [ ] **Step 5: Commit** `feat(runner): validate and apply page-level changes to deck.html`.

### Task 2: runner loop + agent backend + CLI

**Files:** Modify `ppt/runner.py`, `ppt/test_runner.py`.

**Interfaces:**
- Consumes: `server.wait_events(deck, emit, recent, idle, agent, stop, interval)`, `server.statuses`, `server.reply`, `server.read_jsonl`, `server.runtime`, `server.REPLY_TYPES`, `server.detach(deck, port, open_browser)`.
- Produces:
  - `pending(deck) -> list[dict]`: full inbox events of `REPLY_TYPES` whose status is not `done`, in inbox order.
  - `beating(deck)`: context manager. A daemon thread writes `.ppt/heartbeat` every `HEARTBEAT_SECS` until exit.
  - `run(deck, handle, name, stop=lambda: False, interval=0.5) -> str`: loop. The first `wait_events` call uses `recent=True`, later ones `recent=False`, always `idle=float("inf")`, and `stop`/`interval` are passed through. On `"events"`: `evs = pending(deck)`, ack each, then call `handle(evs, lines)` inside `beating`. Any exception from `handle` → reply to every still-unfinished event of `evs` with `没改成：<异常类名>`. On `"stopped"`: print `server.STOPPED` and return `"stopped"`. On `None` (stop): return `None`.
  - `agent_prompt(deck, lines) -> str`: the text of `prompts/ppt-common.md`, then the path mapping (`ppt/…` → `<repo>/ppt/…`, `decks/<名字>` → `<deck abs>`, `python` → `sys.executable`), then the lines, then `处理完每个事件都要先 --ack 再 --reply（不需要改动的也回执一句说明）；处理完就退出，不要运行 --wait 或 --tail。`
  - `agent_handle(deck, cmd, timeout, name) -> handle`: a closure that:
    1. writes `.ppt/runner-prompt.md`;
    2. runs `cmd` with `{prompt}` / `{deck}` replaced by quoted absolute paths, using `shell=True`, `cwd=deck.parent.parent`, prompt on stdin, `capture_output=True`, `text=True`, `encoding="utf-8"`, `errors="replace"`, `timeout`;
    3. writes the fallback reply for each still-unfinished event.
  - `main(argv=None)`: positional `deck`, plus `--backend {agent,llm}` (required), `--cmd`, `--base-url`, `--model`, `--name`, `--timeout`, `--port` (default 8765), `--no-open`.
    - agent backend without `--cmd` → `ap.error`.
    - llm backend without `--base-url` / `--model` → `ap.error`. Missing `PPT_API_KEY` → `SystemExit` with a message naming the variable (and how to set it in PowerShell and bash).
    - Then `detach(deck, port, not no_open)`, print `已开始监听（<名字>），Ctrl+C 退出`, then `run`.

- [ ] **Step 1: Failing tests** in `class RunnerTests` (temp deck via `server.ensure_deck`, events appended to the inbox the way WaitTests does, `stop` limited by a poll count):
  - `test_run_hands_pending_and_acks`: fake handle records ids; e1 intent, e2 edit → handle gets `[e1]`, and outbox has an ack for e1.
  - `test_run_handles_acked_unreplied_after_restart`: e1 already acked, not replied → handle gets e1.
  - `test_run_handle_exception_replies`: handle raises ValueError → e1 done with text containing `ValueError`.
  - `test_agent_handle_fallback`: cmd = `"<sys.executable>" -c "import sys; sys.stdin.read(); sys.exit(3)"` → e1 done, text contains `退出码 3`.
  - `test_agent_handle_agent_replies`: cmd runs a tiny python script that calls `server.reply(deck, "e1", "好了")` using `{deck}` → the only reply is "好了" (no fallback row).
  - `test_agent_timeout_fallback`: cmd sleeps 5 s, timeout 1 → reply contains `超时`.
  - `test_agent_prompt_has_rules_and_paths`: the prompt contains `## deck.html 格式规则`, the absolute deck path, and `sys.executable`.
  - `test_main_requires_key`: llm backend with `PPT_API_KEY` unset → SystemExit mentioning `PPT_API_KEY`.
- [ ] **Step 2: Run.** Expected: failures.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `python ppt/test_runner.py`. Expected: OK.
- [ ] **Step 5: Commit** `feat(runner): wait loop and agent backend`.

### Task 3: llm backend

**Files:** Modify `ppt/runner.py`, `ppt/test_runner.py`. Create `prompts/ppt-llm.md`.

**Interfaces:**
- Consumes: Task 1 `sections / snapshot / apply_changes / CONFLICT`, Task 2 `run`.
- Produces:
  - `chat(base_url, key, model, messages, timeout) -> str`: POST `{base_url.rstrip('/')}/chat/completions` with `response_format: {"type":"json_object"}`. On HTTP 400, retry once without `response_format`. Returns `choices[0].message.content`. Errors raise `RuntimeError(<短原因>)`, and the message never includes `key`: strip it from any text before raising.
  - `pages_for(ev, events_by_id, html) -> list[str] | None`: slide ids per spec decision 7 (`None` = all pages).
  - `build_messages(deck, ev, events_by_id, html) -> tuple[list, dict]`: returns `(messages, sent)`.
    - system = `prompts/ppt-llm.md`.
    - user content parts: text JSON of the event (drop `shot`, `ts`); the theme; the pages' HTML; for `answer`, the original intent and its reply. Then `image_url` data-URL parts for `shot` and the items' `shot` (files under deck; skip missing).
    - `sent = snapshot(...)`.
    - Raises `ValueError(TOO_BIG)` over 200,000 chars.
  - `llm_handle(deck, base_url, key, model, timeout, name) -> handle`. Per event:
    1. Unsupported → reply with that message.
    2. Otherwise build messages → `chat` → `json.loads` → re-read deck.html → `apply_changes` → atomic write (temp file in the deck dir + `os.replace`) → reply `resp["reply"]`.
    3. Any failure → reply `没改成：<原因>`.
- `prompts/ppt-llm.md` (Chinese): the role; the event kinds (intent, answer, lint, draw-icon, sketch, quote, batch rules copied in substance from ppt-common.md without commands / kb / import); format rules 1–8 and 10 copied verbatim; the return JSON shape with field meanings; "只返回改动的页；reply 必填；看不懂就不改页面，在 reply 里问一个具体问题".

- [ ] **Step 1: Failing tests** in `class LlmTests`. A fake OpenAI server (`http.server` on port 0 in a thread) returns a queued response body, records requests, and can return a chosen status.
  - `test_llm_edits_page`: model replaces s-cover → deck has the new text, reply text = model reply. The request has `Authorization: Bearer k`, model `m`, an `image_url` part when the event has a shot.
  - `test_llm_retries_without_response_format_on_400`.
  - `test_llm_bad_json_replies_and_keeps_deck`.
  - `test_llm_conflict`: fake server changes deck.html's s-cover while answering → deck keeps the user's change, reply = CONFLICT.
  - `test_llm_unsupported_kb_and_import`: events `kb` and `import` → no request made, the unsupported reply is sent.
  - `test_llm_error_never_leaks_key`: server returns 401 with body containing the key → reply lacks the key; also no file under the deck dir contains the key.
  - `test_llm_too_big`: a deck whose page HTML exceeds 200,000 chars → reply TOO_BIG, no request.
  - `test_pages_for`: intent slide_id → [it]; batch → item slide ids; answer → original's; lint → the issue blocks' slides; none → None.
- [ ] **Step 2: Run.** Expected: failures.
- [ ] **Step 3: Implement**, and wire `--backend llm` in `main`.
- [ ] **Step 4: Run** `python ppt/test_runner.py && python ppt/test_server.py`. Expected: both OK.
- [ ] **Step 5: Commit** `feat(runner): OpenAI-compatible llm backend`.

### Task 4: guide

**Files:** Modify `docs/guide.html`.

- [ ] **Step 1:** Add section "用自己的 API" with:
  - both commands from the spec;
  - setting `PPT_API_KEY` in PowerShell (`$env:PPT_API_KEY="…"`) and bash;
  - the llm limits (no kb / import);
  - "同一份稿子一次只开一边" applies to the runner too.
- [ ] **Step 2: Commit** `docs: guide covers the API runner`.
