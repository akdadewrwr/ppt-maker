# ppt-maker 子项目 7：Codex 接入 设计

日期：2026-10-22　状态：已过 builder check，待用户审阅　前置：子项目 1–6

## 1. 目标与范围

**问题**：ppt-maker 只能由 Claude Code 驱动（`/ppt`）。用 Codex CLI 的人用不了。

**目标**：Codex 用户在 Codex CLI 里输入 `$ppt <名字>`，得到和 Claude 用户 `/ppt <名字>` 一样的体验：同一个浏览器页面，框选、写意图、改字、草图、知识库、导入导出都一样；浏览器操作以事件形式到达 Codex 会话，Codex 修改 `deck.html` 并回执。

**用户的决定**：
- 不替用户挑选 agent：在 Codex 里用就是 Codex，在 Claude 里用就是 Claude。
- 不用 MCP：Codex 和 Claude 都能运行 shell 命令，Codex 复用现有的 `server.py` 命令，只新增一个阻塞等待的命令。
- Codex 无法被后台事件唤醒（截至 codex-cli 0.163.0，官方没有这个能力），所以用**等待循环**：Codex 运行一条命令，阻塞到下一个浏览器事件，处理完再等。等待期间 Codex 显示为忙碌；用户想直接和它说话时按 Esc 打断。
- **浏览器 15 分钟没有动静，Codex 停止监听**，告诉用户说"继续"就恢复（等待期间 Codex 每隔一段时间要轮询一次，实测 150 秒约多花 15k token，不能无限挂着）。

**不做**：MCP、同一份 deck 同时接两个 agent、`codex queue`（alpha，且消息会伪装成用户输入）、演示模式、动画。

**成功标准**：在真实 Codex 会话里 `$ppt 试用` → 浏览器打开 → 框选一块写意图 → Codex 改好并回执 → 页面显示"Codex 在线"、历史记录写"Codex 处理 #eN"；浏览器 15 分钟不动 → Codex 停止监听并提示；说"继续" → 恢复。

## 2. 实测事实（2026-10-22，codex-cli 0.163.0，Windows 11）

- Codex 的命令入口是 skill：`~/.agents/skills/<名字>/SKILL.md`（frontmatter `name`、`description`），用 `$名字` 调用，后面的文字随提示一起传入。`~/.codex/prompts` 的 `/prompts:名字` 已弃用，不用。
- Windows 上默认沙箱让**所有命令**都报 `rejected: blocked by policy`（连 `echo` 也不行）。设 `windows.sandbox = "unelevated"`（`~/.codex/config.toml` 的 `[windows]` 段，或 `-c windows.sandbox="unelevated"`）后正常。
- 设好后，一条阻塞 150 秒的命令完整跑完，没有超时或被杀；Codex 中途会轮询"进程还在运行"。

## 3. 设计

### 3.1 新命令 `server.py --wait <deck>`

给 Codex 的等待循环用；Claude 继续用 `--tail` + Monitor，不变。

- 维护一个游标 `.ppt/wait-cursor`（inbox 已读到第几行）。
- **返回条件**：存在需要处理且还没 ack 的事件（`REPLY_TYPES`，不论在游标前后）。返回时输出：所有未 ack 的这类事件（游标前的也再输出一次，例如上次 `--wait` 返回后用户按了 Esc、Codex 没来得及 ack），加上游标之后的其他事件（`edit`、撤销/重做），各一行摘要（格式同 `--tail`），按 inbox 顺序；游标推到末尾，退出码 0。已 ack 未回执的事件只由 `--recent` 输出，平时不重复。
- 只有 `edit` 事件时**不返回**（用户拖动、改字会频繁产生 edit，每条都唤醒 Codex 太费 token），但它们算"有动静"，会重置空闲计时，并在下次返回时一起输出。
- **空闲停止**：从开始等待起，inbox 15 分钟没有任何新行（服务写入的 kb 事件也算：它们是用户在知识库面板里的操作引起的），就输出 `15 分钟没有新操作，已停止监听。用户说"继续"后重新运行 --wait。` 并退出 0。时长用 `--idle <秒>` 可调，默认 900。
- **会话开始**用 `--wait --recent`：先输出"最近完成 …"（同 `--tail`，最近 10 条），再输出所有未完成的事件，**包括已 ack 未回执的**（上次会话中断留下的），游标推到末尾，立即返回；没有任何未完成事件时才进入等待。
- 服务停了：输出 `STOPPED` 那行并立即返回（同 `--tail` 的检查方式）。
- 等待期间按 `HEARTBEAT_SECS` 写心跳，同 `--tail`。

### 3.2 页面显示当前 agent 的名字

- `--tail` 和 `--wait` 加 `--agent <名字>`，默认 `Claude`。名字写进 `.ppt/agent`（心跳过期后仍保留，最后一个监听的 agent 为准，所以 Codex 停止监听后页面显示"Codex 离线"）；`/api/state` 返回 `agent`。
- 页面上所有写着"Claude"的用户可见文字（约 20 处：顶栏状态"Claude 在线/离线"、"问 Claude"、"让 Claude 画"、"发给 Claude"、知识库面板里的提示等）改成用 `state.agent`；还没有心跳时显示"Claude"。
- 历史记录标签（`claude_label`：`Claude 处理 #eN` / `Claude 修改`）用 `.ppt/agent` 里的名字（记快照时读，心跳过期也照用）。已经写进历史的旧标签不改。
- 代码里的变量名、注释、内部 `who:"claude"` 之类不改。

### 3.3 在线状态

Codex 处理一个事件时不在 `--wait` 里，心跳会断。页面在这两种情况下都算在线：心跳在 `ONLINE_SECS` 内，**或**有事件处于 processing（已 ack 未回执）且心跳在 10 分钟内（防止崩溃会话留下的 processing 事件让页面永远显示在线）。`--ack` 和 `--reply` 也刷新心跳。空闲停止后心跳不再更新，页面显示"Codex 离线"，这是对的：这时的操作要等用户说"继续"才会被处理（事件不会丢，下次 `--wait` 会输出）。

### 3.4 说明文件：一份共用，两个入口

现在全部说明在 `.claude/commands/ppt.md`（全局 `~/.claude/commands/ppt.md` 让 Claude 去读它）。拆成：
- **`prompts/ppt-common.md`**：处理事件、deck 格式规则、导入/知识库规则——和 agent 无关的部分，从现有 `ppt.md` 原样搬过来，措辞改成不点名 Claude（"你"）。
- **`.claude/commands/ppt.md`**：Claude 的启动步骤（`--detach`、Monitor 挂 `--tail`、到期重挂、服务停止重启），最后"读 `prompts/ppt-common.md` 并照做"。
- **`codex/skills/ppt/SKILL.md`**：Codex 的启动步骤和等待循环（见 3.5），最后同样读共用说明。
- 全局 `~/.claude/commands/ppt.md`（仓库外、写死了 PPT_HOME）的"PPT_HOME 里只读这份说明"放宽为"只读 `.claude/commands/ppt.md` 和 `prompts/ppt-common.md`"。和以前一样直接改这个文件（实现者的决定：现在没有 Claude 的安装命令，不为这一处新增），计划里单列一步并验证 `/ppt` 仍能读到共用说明。

kb 的 `kind:skill` 事件让 agent 写 `SKILL.md`（frontmatter `name`、`description`），Claude 和 Codex 的 skill 格式相同，规则不用分开。

### 3.5 Codex skill 的内容

- 名字取参数，规则同 Claude 版（去掉非法字符，空就问）。
- 路径换算同全局 Claude 命令：程序在 PPT_HOME（安装时写入绝对路径），deck 在当前工作目录的 `decks/<名字>/`。
- 启动：`server.py --detach "<deck>"`，把 URL 告诉用户；输出"已从模板新建"时写 3–6 页初稿（同 Claude 版）。
- 告诉用户一句："我会一直监听浏览器里的操作；想直接跟我说话按 Esc，说完让我继续监听即可。15 分钟没有操作我会自动停下。"
- 循环：`server.py --wait --recent --agent Codex "<deck>"`（第一次）→ 按共用说明处理输出的每个事件 → `server.py --wait --agent Codex "<deck>"` → … 
- 输出空闲停止那行时：告诉用户已停止监听、说"继续"恢复，然后结束这一轮，**不要**再运行 `--wait`。用户说"继续"（或类似的话）时用 `--wait --recent` 重新进入循环。
- 输出 `STOPPED` 时：重新 `--detach`，告诉用户新 URL，继续循环。
- 用户打断后说了别的事：照做；做完问一句是否继续监听，或用户明确说继续时再进循环。
- 命令被 `blocked by policy` 拒绝时：告诉用户在 `~/.codex/config.toml` 加 `[windows]` / `sandbox = "unelevated"` 后重开 Codex。

### 3.6 安装

`python ppt/server.py --install-codex`：把 `codex/skills/ppt/` 复制到 `~/.agents/skills/ppt/`，把 PPT_HOME 换成本仓库的绝对路径；已存在就覆盖并说明。结束时打印一段说明：Windows 上需要的 `[windows] sandbox = "unelevated"` 配置，以及用法 `$ppt <名字>`。**不自动改** `~/.codex/config.toml`（那是用户的持久配置）。

## 4. 测试

- `test_server.py`：
  - `--wait` 只有 edit 事件时不返回、有 intent 时返回并带上之前的 edit；
  - 游标：同一事件不会被两次 `--wait` 输出；
  - 未 ack 的旧事件在游标前也会让 `--wait` 立即返回；
  - `--recent` 输出最近完成和已 ack 未回执的事件；
  - 空闲超时（用很小的 `--idle`）输出停止那行、退出 0；edit 事件重置空闲计时；
  - 服务停了立即返回 `STOPPED`；
  - `--agent` 写进心跳、`/api/state` 返回、`claude_label` 用它；
  - processing 中且心跳过期时 `online` 仍为真；
  - `--install-codex` 写出的 SKILL.md 含绝对 PPT_HOME（用临时 HOME）。
- `e2e.mjs`：心跳 agent 为 Codex 时顶栏显示"Codex 在线"、按钮提示文字用 Codex。
- **真实 Codex 冒烟**（手工或 `codex exec -s workspace-write -c windows.sandbox="unelevated"`，只用 `decks/e2e-smoke` 一类测试 deck）：`$ppt` 启动、一条 intent 改好并回执、空闲停止。

## 5. 风险（计划里要先验证）

1. **沙箱里能否启动独立服务**：`--detach` 要起一个监听端口、在命令结束后继续活着的进程。unelevated 沙箱可能禁止联网/监听端口，或在命令结束时结束子进程。先用 `codex exec` 实测；不行就在 skill 里写明需要的权限（例如对这条命令申请批准），这是 Codex 侧的配置问题，不改服务设计。
2. **沙箱写权限**：workspace-write 只允许写工作目录。全局知识库 `~/.ppt-maker`、`ppt/` 下的 export 临时文件等在工作目录外的写入可能被拒，要实测并在 skill 里说明。
3. **Codex 抓网页**：kb 的 url 资料和 `import kind:url` 需要抓网页。先实测 Codex 在 workspace-write + unelevated 下能否抓；能就照常；不能就在 skill 里写明：这类资料请用户把网页另存为文件再加入（实现者的决定：不为此让服务端代抓，以后需要再加）。
4. **Codex 的工具差异**：看截图（Codex 有看图工具）、抓网页（kb 的 url 资料、import 的 url）在 Codex 里用什么方式，共用说明里不要写死 Claude 的工具名（Read、WebFetch、Monitor），改成描述动作（"看这张截图""抓取这个网页"）。
5. **轮询开销**：15 分钟空闲上限是按实测估的，真实使用后可能要调；`--idle` 留着就是为了这个。

## 6. 留给实现者

- `--wait` 的轮询间隔、游标文件格式、空闲停止那句话的具体措辞。
- 共用说明的具体拆分边界（以"和 agent 无关"为准）。
- 页面上把名字拼进文字的具体写法。
