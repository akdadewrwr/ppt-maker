# 子项目 8：直接接用户自己的 API（runner）

## 意图
现在必须开着 Claude Code 或 Codex 会话才能用。别人可能只有自己的 API：
- **agent 类**：自己会用工具的 agent（Claude Agent SDK、OpenAI Agents SDK、`claude -p`、`codex exec`、公司内部 agent 等）；
- **LLM 类**：只有对话接口的模型（OpenAI、DeepSeek、通义、Ollama、vLLM……）。

两类都要能直接用：一条命令启动，不用开 Claude / Codex 会话。

## 目标
- 新增 `ppt/runner.py`：一个常驻程序，替代 agent 会话跑"等事件 → 处理 → 回执"的循环。
- 两种后端：`--backend agent`（调用用户给的命令）和 `--backend llm`（调用 OpenAI 兼容的 `/chat/completions`）。
- 页面无需改动：runner 用现有的 `wait_events` / `reply` / `--agent` 名字，页面照常显示"<名字> 在线"、标记和回执。

## 非目标
- 不做 MCP、不做插件系统、不为每家 API 写专用适配：LLM 只支持 OpenAI 兼容接口（Anthropic、Gemini、DeepSeek、通义、Ollama 都提供这种接口）。
- LLM 后端第一版不做：知识库消化（kb）、导入（import）、知识库引用（intent 带 `kb`）。这些事件 ack 后回执"API 模式暂不支持…，请用 Claude / Codex 或 agent 后端"。
- 不加任何第三方依赖（只用标准库 urllib / json）。

## 反目标（做成这样就算失败）
- API key 出现在 deck 目录、日志、回执或命令行历史里。
- 模型返回坏内容时把 deck.html 写坏（写一半、丢页、混进脚本）。
- 某个事件出错让 runner 整个退出，或让同一事件被无限重试。

## 怎么用
```
python ppt/runner.py "decks/<名字>" --backend llm --base-url https://api.deepseek.com/v1 --model deepseek-chat [--name DeepSeek]
python ppt/runner.py "decks/<名字>" --backend agent --cmd "claude -p --permission-mode acceptEdits" [--name MyAgent]
```
- key 只从环境变量 `PPT_API_KEY` 读（LLM 后端）；没设置就报错退出，提示怎么设。
- runner 先做 `--detach` 同样的事（启动或沿用服务、需要时从模板新建、打开浏览器），打印网址，然后进入循环。新建的 deck 不自动写初稿（模板页即可），我的取舍：少一次模型调用、少一个失败点。
- 循环：`wait_events(..., agent=<名字>, idle=无限)`；返回 `events` 时取出所有未完成的 REPLY_TYPES 事件逐个处理；`stopped` 时打印"服务已停止"并退出；Ctrl+C 退出。
- `--name` 默认：llm 后端用模型名，agent 后端用 "Agent"；截到 20 字（沿用 `read_agent` 的上限）。

## agent 后端
- 每次 `wait_events` 返回，runner 把一份提示写进 `.ppt/runner-prompt.md`，然后运行 `--cmd`：提示同时从 stdin 传入；命令里的 `{prompt}` 换成提示文件的绝对路径，`{deck}` 换成 deck 绝对路径。工作目录 = deck 所在项目目录（deck 往上两层），与 Claude / Codex 一致。
- 提示内容：`prompts/ppt-common.md` 全文 + 路径换算说明（`ppt/…` → 本仓库绝对路径，`decks/<名字>` → deck 绝对路径）+ 本次的事件摘要行（与 `--wait` 输出相同，含"最近完成"前情）+ 一句"处理完每个事件都要 --ack 再 --reply，处理完就退出，不要运行 --wait / --tail"。
- 命令超时 `--timeout`（默认 600 秒）。命令结束（或超时被杀）后，本次给出的事件里仍未回执的，runner 代为回执："<名字> 没有回执这条（退出码 N）：<stderr 最后 300 字>"，避免同一事件被无限重发。
- 用户的 agent 是远程服务时，由用户写一个小脚本包一层，作为 `--cmd`；不另做 HTTP 协议。

## llm 后端
- 每个事件一次请求（batch 是一个事件，一次请求）。先 `--ack`。
- 请求：`POST {base-url}/chat/completions`，`Authorization: Bearer $PPT_API_KEY`，`model`，`response_format: {"type":"json_object"}`（服务不支持时去掉重试一次），超时 `--timeout`（默认 180 秒）。
- system：一份专给 LLM 的规则 `prompts/ppt-llm.md`（从 ppt-common.md 的"处理事件"里 intent / answer / lint / draw-icon / sketch / quote / batch 的部分和"格式规则"整理而来，去掉命令、知识库、导入），加上下面的返回格式。
- user：事件 JSON（去掉内部字段）+ `#theme` 的 `<style>` + 相关页面的完整 `<section>` HTML（事件涉及的页；`answer` 带上原 intent、之前的回执；整页新建或说不清哪页时给全部页面的 HTML）+ 截图（`shot` 和 batch 条目的 `shot`，以 `image_url` data URL 发送）。只看文字、无截图的模型照样能用。
- 返回格式（JSON）：
  `{"reply": "给用户的说明", "slides": [{"id": "s-…", "html": "<section …>…</section>"}], "insert": [{"after": "s-…|null", "html": "<section …>"}], "delete": ["s-…"], "theme": "<style id=\"theme\">…</style> 或省略"}`
  只返回改动的页；`reply` 必填。
- 写回前校验，全部通过才写，否则不改 deck，回执"没改成：<原因>"：
  - JSON 可解析、字段类型对；
  - 每个 html 恰好是一个 `section.slide`，id 与 `slides[].id` 一致、在 deck 中存在（insert 的新 id 不能已存在）；
  - 写入后整份 deck 的 id 唯一；
  - 不含 `<script>`、`on*=` 属性、`javascript:`、外部 `http(s)://` 资源引用、`data-ppt` / `ppt-` class；
  - `delete` 后至少剩一页。
- 写入：在内存里替换对应 `<section>` 后整份写临时文件再 `os.replace`（原子）。服务的 watcher 会自动记入撤销历史，标签沿用"<名字> 处理 #eN"。
- 写之前重读 deck.html（用户可能刚改过）；用户在请求期间又改了 deck（版本变了）且改动涉及同一页，就不写，回执"你刚改了这页，我没覆盖，请再说一次"。我的取舍：宁可多问一次，也不覆盖用户的手改。
- 请求失败（网络、4xx/5xx、超时、返回不是 JSON）：回执"没改成：<原因>"，不重试（用户再发一次即可）。key 不进任何错误信息。
- 不支持的事件（kb、import、intent 带 `kb`）：ack 后回执上面那句。

## 补充决定（builder check 后，均为我的取舍）
1. **取事件**：`wait_events` 只负责等；返回后 runner 自己读 `inbox.jsonl`，按 `statuses()` 取所有未 done 的 REPLY_TYPES 事件（含已 ack 未回执的）。启动后第一次用 `recent=True`，所以上次崩溃留下的半截事件会被重新处理。
2. **edit 事件**：llm 后端忽略（它总是拿最新的 deck.html）；agent 后端照 `--wait` 一样连同摘要行交给 agent。lint / draw-icon / sketch / quote / batch 都用同一个返回格式；图标、草图做成内联 SVG 写在页面 HTML 里，不新建 assets 文件。
3. **不覆盖手改**：请求前记下发给模型的每个 `<section>` 和 `#theme` 的内容；写之前重读，返回里要替换 / 删除的页、`insert.after` 指向的页、以及（要改时）`#theme`，只要有一个和请求前不同，就整份不写，回执请用户再说一次。runner 是独立进程，不用服务的 LOCK：原子 `os.replace`，由 watcher 记入历史。
4. **在线状态**：两种后端都在处理前先 `--ack` 本次全部事件；处理期间 runner 另开线程每 10 秒写一次 heartbeat，页面不会显示离线。
5. **agent 命令**：用 `shell=True` 运行用户给的整串命令（Windows / bash 都按用户自己的写法）；`{prompt}`、`{deck}` 替换为加了双引号的绝对路径。提示里的命令用 runner 自己的 Python（`sys.executable`）和绝对路径。
6. **代为回执前**再查一次 `statuses()`，已经 done 的不再回执。
7. **给模型哪些页**：事件的 `slide_id`（batch 取各条目的 `slide_id`；answer 取 `re` 指向的原 intent 的；lint 取问题块所在的页）；取不到就给全部页面。发给模型的页面 HTML 超过 200,000 字符时不请求，回执"这份稿子太大，API 模式处理不了，请指定一页再说"。
8. **校验范围**：页面 HTML 和 `#theme` 都不许有 `http(s)://`（含 CSS `url()`、`src`、`href`）、`@import`、`<script>`、`on*=`、`javascript:`；`data:` 只允许 `data:image/`；`theme` 必须恰好是一个 `<style id="theme">…</style>`。
9. **batch 原子**：一次请求、一次校验、一次写入。应用顺序：替换 → 删除 → 插入；`insert.after` 必须是删除后仍在的页，`null` 表示加在最后。

## 留给实现者的
- prompt 的具体措辞（`prompts/ppt-llm.md`）、`<section>` 的定位方式（正则或 html.parser，能正确处理嵌套即可）。
- runner 的输出格式（每处理一个事件打印一行即可）。

## 测试
- 单元（test_server.py 新增类）：用一个本地假 OpenAI 服务（http.server）和一个假 agent 命令（python 小脚本），覆盖：正常改页、插页删页、改 theme、各条校验拒绝、请求失败、用户期间改页不覆盖、不支持事件、agent 命令不回执时代为回执、超时、key 不出现在回执和 deck 目录。
- 不加 e2e（页面没改）。
