# 用自己的 API 驱动 ppt-maker

平时 ppt-maker 要开着 Claude Code（`/ppt`）或 Codex（`$ppt`）会话。如果你手上只有自己的 API，可以用 `ppt/runner.py` 代替这个会话。它会启动服务、打开浏览器，然后一直接收浏览器里的操作，交给你的 API 处理，改好稿子并在页面上回执。页面的用法和平时完全一样。

runner 支持两种 API：

| | `--backend llm` | `--backend agent` |
|---|---|---|
| 适合 | 只有对话接口的模型（OpenAI、DeepSeek、通义、Ollama、vLLM…） | 会自己用工具的 agent（Claude Agent SDK、OpenAI Agents SDK、`claude -p`、`codex exec`、公司内部 agent…） |
| 谁改 deck.html | runner 按模型返回的 JSON 改 | agent 自己改 |
| 谁回执 | runner | agent 自己运行回执命令（没回执的由 runner 代回） |
| 知识库、导入 | 暂不支持 | 支持（看 agent 的能力） |

只需要 Python 3，不用装别的包。

---

## 1. LLM 后端（只有对话接口）

### 快速开始
```powershell
# PowerShell
$env:PPT_API_KEY = "你的 key"
python ppt/runner.py "decks/我的演讲" --backend llm --base-url https://api.deepseek.com/v1 --model deepseek-chat
```
```bash
# bash
export PPT_API_KEY=你的key
python ppt/runner.py "decks/我的演讲" --backend llm --base-url https://api.deepseek.com/v1 --model deepseek-chat
```
稿子不存在时会从模板新建。浏览器打开后，像平时一样点块、拖框、写意图就行；页面右上角会显示"deepseek-chat 在线"。按 `Ctrl+C` 退出。

### 接口要求
- OpenAI 兼容的 `POST {base-url}/chat/completions`，用 `Authorization: Bearer <key>` 认证。
- 最好支持 `response_format: {"type": "json_object"}`。不支持时服务会返回 400，runner 会去掉这个参数再试一次。
- 要看懂截图和草图，模型得支持图片输入（OpenAI 的 `image_url` 格式）。不支持图片的模型也能用，只是看不到截图。

常见服务的 `--base-url`（以各家文档为准）：

| 服务 | `--base-url` |
|---|---|
| OpenAI | `https://api.openai.com/v1` |
| DeepSeek | `https://api.deepseek.com/v1` |
| 通义千问（DashScope 兼容模式） | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Anthropic（OpenAI 兼容接口） | `https://api.anthropic.com/v1` |
| Google Gemini（OpenAI 兼容接口） | `https://generativelanguage.googleapis.com/v1beta/openai` |
| Ollama（本机） | `http://localhost:11434/v1`（key 随便填一个非空值） |
| vLLM / 其他自建服务 | 你的服务地址，通常以 `/v1` 结尾 |

### 它怎么工作
每来一个操作发一次请求，一张清单也只发一次：
1. 把这条操作标记为"处理中"（页面上显示蓝框）。
2. 发给模型：
   - system：规则 `prompts/ppt-llm.md`；
   - user：操作的 JSON、`#theme`、全部页面 id，以及相关页面的完整 HTML；如果是回答，再附上原来的意图和之前的回执；有截图就附上截图。
3. 模型只返回一个 JSON：
   ```json
   {"reply": "给用户的说明（必填）",
    "slides": [{"id": "s-cover", "html": "<section class=\"slide\" id=\"s-cover\">…</section>"}],
    "insert": [{"after": "s-cover", "html": "<section class=\"slide\" id=\"s-new\">…</section>"}],
    "delete": ["s-old"],
    "theme": "<style id=\"theme\">…</style>"}
   ```
   只写改动的部分，用不到的字段省略。`after: null` 表示加在最后；几页插在同一页之后时，按数组顺序排列。
4. runner 先检查，全部通过才写回 `deck.html`（整份原子替换，并进入撤销历史）；不通过就不改稿子，并回执原因：
   - 每个 `html` 必须恰好是一个 `<section class="slide">`，id 和要改的页一致；
   - 写完以后整份稿子的 id 不重复，至少剩一页；
   - 不能有脚本、`<iframe>`/`<object>`/`<embed>`、`on…` 事件属性、`javascript:`、外部网址（包括 `//` 开头的和 CSS `url()` 里的）、`@import`，`data:` 只允许图片；
   - 不能有没闭合的标签或注释，也不能有 `<style>`、`<textarea>` 这类会吞掉后面页面的标签；
   - 不能有 `data-ppt` 属性和 `ppt-` 开头的 class。
5. 在模型思考期间，如果你手改了它要改的页（或主题），它的结果整份不写，回执"你刚改了这页，我没覆盖，请再说一次"。
6. 回执 `reply`，页面上变成绿框。

### 限制
- 知识库消化、导入、引用知识库这三类操作会回执"API 模式暂不支持…"，需要时改用 Claude / Codex 或 agent 后端。
- 发给模型的页面 HTML 超过 20 万字符时不发请求，回执请你指定一页再说。
- 请求失败、超时或返回看不懂时，回执原因，不自动重试，再发一次就行。
- 新建的稿子不写初稿，从模板页开始。

---

## 2. Agent 后端（会自己用工具的 agent）

### 快速开始
```powershell
python ppt/runner.py "decks/我的演讲" --backend agent --cmd "你的 agent 命令" --name MyAgent
```

### runner 怎么调用你的命令
每当有一批要处理的操作，runner 就运行一次 `--cmd`：
- **通过 shell 运行**（Windows 是 cmd，其他系统是 sh），按你写的原样执行。
- **说明从 stdin 传入**（UTF-8）。命令里的 `{prompt}` 会换成说明文件的路径（`.ppt/runner-prompt.md`），`{deck}` 会换成稿子目录，两者都是加了引号的绝对路径。
- **工作目录**是稿子往上两层（项目目录），和 Claude / Codex 一样。
- **说明的内容**：
  - 共用规则 `prompts/ppt-common.md`（怎么处理各类操作、deck.html 格式规则、知识库）；
  - 路径换算，里面直接写了要用的 Python 和 `server.py` 的绝对路径；
  - 这次要处理的操作摘要，和 Claude / Codex 看到的一样；
  - 一句要求："每个操作先 `--ack` 再 `--reply`，处理完就退出"。

### 你的 agent 需要做到
1. 能读写文件、能运行命令。
2. 按说明修改 `deck.html`，并对每个操作回执：
   ```
   python "<ppt-maker>/ppt/server.py" --reply "<deck>" e17 --ack
   python "<ppt-maker>/ppt/server.py" --reply "<deck>" e17 "把标题改成了两行"
   ```
3. 处理完就退出，不要运行 `--wait` 或 `--tail`。runner 负责等待下一批。

### runner 帮你兜底
- 命令超过 `--timeout`（默认 600 秒）会被结束，连同它启动的子进程。
- 命令结束后还有没回执的操作，runner 替它回执"<名字> 没有回执这条（退出码 N）：<错误输出的最后 300 字>"，这样同一个操作不会被反复发。
- 处理期间 runner 每 10 秒报一次在线，页面不会显示离线。
- 按 `Ctrl+C` 退出时，正在运行的 agent 也会被结束。
- runner 重启后，会接着处理上次没做完的操作。

### 接入示例
下面只是写法示例，参数以各工具自己的文档为准，主要是要给它读写文件和运行命令的权限。

**Claude Code（无界面模式）**：说明从 stdin 读入。
```powershell
--cmd "claude -p --permission-mode acceptEdits --allowedTools Bash"
```

**Codex**：让它读说明文件。
```powershell
--cmd 'codex exec "按 {prompt} 里的说明处理，处理完就退出"'
```

**自己用 SDK 写的 agent**：写一个脚本，从 stdin 读说明，交给你的 agent 去执行。
```python
# my_agent.py —— 用法：--cmd "python my_agent.py {deck}"
import sys
prompt = sys.stdin.buffer.read().decode("utf-8")
deck = sys.argv[1]
# 把 prompt 交给你的 agent（Claude Agent SDK / OpenAI Agents SDK / LangGraph…），
# 给它读写文件和运行命令的工具。它会按说明修改 deck.html，并运行 --ack / --reply。
run_my_agent(prompt, workdir=deck)
```

**远程 agent 服务**：同样写一个小脚本，把说明 POST 给你的服务。远程服务碰不到本机文件，所以要么让服务返回修改内容，由脚本写回 `deck.html` 并运行 `--reply`；要么让服务把每条结论返回来，由脚本代为回执。

---

## 3. 命令行参数

| 参数 | 说明 |
|---|---|
| `deck` | 稿子目录，例如 `decks/我的演讲`；不存在会从模板新建 |
| `--backend llm\|agent` | 必填 |
| `--base-url` / `--model` | llm 后端必填 |
| `--cmd` | agent 后端必填 |
| `--name` | 页面上显示的名字（最多 20 字）；默认 llm 用模型名，agent 用 `Agent` |
| `--timeout` | 秒数：agent 每次运行默认 600 秒，llm 每次请求默认 180 秒 |
| `--port` | 服务端口，默认 8765；已有服务在跑就沿用 |
| `--no-open` | 不自动打开浏览器 |

key 只从环境变量 `PPT_API_KEY` 读，不能写在命令行里，也不会写进稿子目录、日志或回执；接口报错里出现 key 时会换成 `***`。

## 4. 注意
- 同一份稿子一次只开一个处理端（runner、Claude、Codex 三选一），否则同一个操作可能被处理两次。
- runner 的修改和 Claude 的一样会进撤销历史，页面上的 ↶ 可以撤销。
- 遇到问题先看 runner 窗口的输出，再看 `decks/<名字>/.ppt/server.log`。
