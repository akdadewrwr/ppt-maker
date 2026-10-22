# ppt-maker Codex 接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Codex CLI 用户用 `$ppt <名字>` 得到和 Claude `/ppt` 相同的 ppt-maker 体验。

**Architecture:** 服务端新增阻塞命令 `--wait`（游标 + 空闲停止），给 Codex 的等待循环用；心跳旁边记下当前 agent 名字，页面和历史标签用它；说明拆成一份共用规则加 Claude / Codex 两个入口；`--install-codex` 安装 skill。

**Tech Stack:** Python 3 stdlib（server.py）、原生 JS（页面）、Codex CLI 0.163.0 skills。

**Spec:** `docs/superpowers/specs/2026-10-22-ppt-maker-codex-design.md`

## Global Constraints

- 默认空闲停止 900 秒，`--idle <秒>` 可调。
- 停止那行：`f"{round(idle / 60)} 分钟没有新操作，已停止监听。用户说“继续”后重新运行 --wait。"`（默认即“15 分钟…”）。
- `--agent` 默认 `Claude`；名字存在 `.ppt/agent`，心跳过期后保留。
- 在线 = 心跳 < `ONLINE_SECS`(30)，或 有 processing 事件 且 心跳 < 600 秒。
- 只有 `edit` 事件时 `--wait` 不返回；`REPLY_TYPES` 里未 ack 的事件每次返回都输出。
- 不改 `~/.codex/config.toml`；不用 MCP；代码变量名和内部 `who:"claude"` 不改。
- 测试：`timeout 500 python ppt/test_server.py`、`bash "$TEMP/ppt-logs/selftest.sh"`、`node tests/e2e.mjs > "$TEMP/ppt-logs/e2e.log"`（只用 `decks/e2e-smoke`、端口 8800）。
- Windows：改代码用 Edit 或 scratchpad 里的 Python 补丁脚本（`assert count==1`），不用 heredoc 写含反斜杠的代码；输出中文设 `PYTHONIOENCODING=utf-8`。

## Review Focus

1. 用户在 Codex 处理事件时又发了新意图：下一次 `--wait` 必须立即返回它（游标前未 ack 的也算）——Task 1 的 `test_wait_returns_unacked_before_cursor` 覆盖。
2. 两个 `--wait` 先后运行（Codex 被打断又重进）不能重复输出已 ack 的事件——Task 1 `test_wait_never_repeats_acked`。
3. 旧 deck 没有 `.ppt/agent` 文件：页面、标签都退回 "Claude"，不报错——Task 2 `test_agent_defaults_to_claude`。
4. `.ppt/agent` 内容异常（空、超长、含换行）：按 "Claude" 处理或截断到 20 字——Task 2 `test_agent_name_is_sanitised`。
5. 服务在 `--wait` 期间被停：在 `SERVER_CHECK_SECS` 内返回 `STOPPED`，不等满 15 分钟——Task 1 `test_wait_returns_when_server_stops`。

---

### Task 0: 实测 Codex 沙箱（无代码）

**Files:** 无改动；结论写进执行 ledger 的 `Ruling:` 行，Task 4 的 skill 文字据此写。

- [ ] **Step 1:** 在 scratchpad 新建空目录，复制 `ppt/template.html` 为 `decks/spike/deck.html`，运行：
  `codex exec --skip-git-repo-check -s workspace-write -c 'windows.sandbox="unelevated"' "运行 python \"<PPT_HOME>/ppt/server.py\" --detach --no-open decks/spike ，然后运行 curl -s -o NUL -w %{http_code} <输出里的 URL> 并报告两条命令的原样输出"` < /dev/null
  Expected: 记录 ①服务能否启动 ②curl 返回 200 ③codex 结束后服务是否仍活着（`python ppt/server.py --stop decks/spike` 能否停到）。
- [ ] **Step 2:** 同样方式让 Codex 抓 `https://example.com` 的标题（不指定工具），记录能否抓到。
- [ ] **Step 3:** 让 Codex 往 `~/.ppt-maker/spike-probe.txt` 写一行再删掉，记录是否被拒。
- [ ] **Step 4:** ledger 写三条 `Ruling:`（启动服务 / 抓网页 / 工作区外写入），每条写"能"或"不能 + skill 里怎么说"。不能启动服务时：skill 让 Codex 对 `--detach` 申请提权运行（Codex 的批准机制），并在 Task 6 冒烟里验证；仍不行就停下问用户。

### Task 1: `server.py --wait`

**Files:**
- Modify: `ppt/server.py`（`tail` 附近新增函数；`main` 加参数）
- Test: `ppt/test_server.py`（新类 `WaitTests(unittest.TestCase)`，仿 `DetachTests` 用临时 deck，不起 HTTP 服务）

**Interfaces:**
- Produces: `wait_events(deck, emit, recent=False, idle=900, agent="Claude", stop=lambda: False, interval=0.5) -> str`，返回 `"events" | "idle" | "stopped"`；`idle_stop_text(idle) -> str`；CLI `--wait [--recent] [--idle N] [--agent NAME]`，退出码 0。
- Produces: `write_agent(deck, name)`：写 `.ppt/agent`（Task 2 加读取）。

- [ ] **Step 1: 写失败测试**（`emit` 收集到 list；`stop` 用计数器在若干轮后返回 True 防挂死）
  - `test_wait_ignores_edits_then_returns_with_them`：inbox 先有 `edit` e1，再在另一线程 0.3 秒后追加 `intent` e2 → 返回 `"events"`，输出两行，顺序 e1、e2。
  - `test_wait_never_repeats_acked`：e1 intent 返回后 `reply(..., ack=True)`；第二次 `wait_events`（`stop` 3 轮后 True）不输出 e1。
  - `test_wait_returns_unacked_before_cursor`：e1 返回后不 ack，第二次立即返回并再次输出 e1。
  - `test_wait_recent_lists_done_and_processing`：12 条中 11 条已回执、e12 已 ack 未回执 → `recent=True` 输出 10 行 `最近完成`，并含 `e12 `，立即返回。
  - `test_wait_idle_stop`：`idle=1` 且无事件 → 约 1 秒返回 `"idle"`，最后一行含 `已停止监听` 和 `--wait`；另断言 `idle_stop_text(900)` 以 `15 分钟没有新操作` 开头。
  - `test_wait_edit_resets_idle`：`idle=1.5`，0.8 秒时追加 edit → 1.5 秒时还没返回（用时间戳断言总时长 > 2 秒），最终 `"idle"`。
  - `test_wait_returns_when_server_stops`：写一个已死的 `server.json`（同 `test_tail_tells_recent_work_and_a_stopped_server`）→ 返回 `"stopped"`，输出含 `服务已停止`。
  - `test_wait_cli`：`server.main([str(deck), "--wait", "--idle", "1"])` 在有一条未 ack intent 时打印它并返回。
- [ ] **Step 2:** `timeout 500 python ppt/test_server.py WaitTests` → Expected: FAIL（`wait_events` 不存在）。
- [ ] **Step 3: 实现 `wait_events`**：游标存 `.ppt/wait-cursor`（inbox 行数，读不了当 0）。每轮：读 inbox 和 `statuses`；`pending` = `REPLY_TYPES` 且无状态的事件；有 pending 就输出 pending ∪ 游标后其他事件（按 inbox 顺序、`safe_summary`），游标置末尾，返回 `"events"`。inbox 行数比上一轮多就重置空闲计时。按 `HEARTBEAT_SECS` 写心跳、按 `SERVER_CHECK_SECS` 查 `server_up`（False → emit `STOPPED`，返回 `"stopped"`）。空闲到时 emit `idle_stop_text(idle)`，返回 `"idle"`。`recent=True`：先按 `tail` 的规则输出最近完成，再输出所有非 done 的 `REPLY_TYPES` 事件；有输出就置游标并返回 `"events"`，否则进入等待。开始时调用 `write_agent(deck, agent)`。CLI：`--wait` 加进 `serving` 判断。
- [ ] **Step 4:** 跑 `WaitTests` → PASS；跑全量 `timeout 500 python ppt/test_server.py` → OK。
- [ ] **Step 5: Commit** `feat(server): --wait blocks until there is something to handle (for Codex)`

### Task 2: agent 名字、在线规则、历史标签

**Files:**
- Modify: `ppt/server.py`（`state`、`tail`、`reply`、`claude_label`、`main`）
- Test: `ppt/test_server.py`（`EventTests` 和 `HistoryTests` 里加用例）

**Interfaces:**
- Consumes: Task 1 的 `write_agent`。
- Produces: `read_agent(deck) -> str`（去首尾空白、只取第一行、截 20 字，空则 `"Claude"`）；`/api/state` 多返回 `"agent": str`；`claude_label` 返回 `f"{agent} 处理 #{eid}"` / `f"{agent} 修改"`；`tail(..., agent="Claude")`，CLI `--tail --agent`。

- [ ] **Step 1: 写失败测试**
  - `test_agent_defaults_to_claude`：新 deck → `/api/state` 的 `agent == "Claude"`，`claude_label(deck) == "Claude 修改"`。
  - `test_agent_name_from_listener`：`write_agent(deck, "Codex")` → state `agent == "Codex"`；先 ack e3 → `claude_label == "Codex 处理 #e3"`。
  - `test_agent_name_is_sanitised`：`.ppt/agent` 写 `"  \n"` → `"Claude"`；写 `"A"*50 + "\nx"` → 长度 20。
  - `test_online_while_processing`：心跳 mtime 设为 120 秒前（`os.utime`）、e1 已 ack 未回执 → `online` 为 True；心跳设为 700 秒前 → False；无 processing 且 120 秒前 → False。
  - `test_reply_and_ack_touch_heartbeat`：无心跳时 `reply(deck, "e1", ack=True)` 后心跳文件存在且是新的。
  - `test_tail_writes_agent`：`tail(deck, emit, stop=lambda: True, agent="Codex")` 后 `read_agent == "Codex"`。
- [ ] **Step 2:** 跑这些测试 → FAIL。
- [ ] **Step 3:** 实现上述接口；`reply` 写完 outbox 后写心跳；`state` 的 online 按 Global Constraints。
- [ ] **Step 4:** 全量 server 测试 → OK（注意已有 `test_state_statuses_and_online`：它的 e1 是 processing 且心跳不存在 → 仍 False，不应改它）。
- [ ] **Step 5: Commit** `feat(server): remember which agent is listening; online while it works`

### Task 3: 页面显示 agent 名字

**Files:**
- Modify: `ppt/editor.js:302`（状态文字）、`ppt/toolbar.js:104,112,114,154`、`ppt/sketch.js:133`、`ppt/kb-panel.js:51,53,123,128,129`
- Test: `tests/e2e.mjs`

**Interfaces:**
- Consumes: `/api/state` 的 `agent`。
- Produces: 全局 `window.PPTAgent`：`name()` 返回当前名字（默认 `'Claude'`），`set(n)` 更新并改写已渲染的文字。已建好的按钮（"问 X"、"发给 X"）在 `set` 时更新 `textContent` 和 `title`；面板（图标、知识库）打开时用 `name()` 现取。`PPTAgent` 必须用 `var`/`function` 声明（启动即读，避免 TDZ）。

- [ ] **Step 1: 写失败 e2e 检查**（放在第 1 节离线检查之后）：写 `decks/e2e-smoke/.ppt/agent` 为 `Codex` 并写新心跳 → 等一次状态轮询 → `check('A status names the listening agent', statusText 含 'Codex 在线')`；`check('A ask button names the agent', !!(await byTitle('问 Codex')))`；然后删掉 `.ppt/agent`、写回心跳 → 等轮询 → `byTitle('问 Claude')` 存在（后续用例依赖它）。
- [ ] **Step 2:** `node tests/e2e.mjs` → Expected: 这两条 FAIL，其余 PASS。
- [ ] **Step 3:** 实现：editor.js 每次拿到 state 调 `PPTAgent.set(state.agent || 'Claude')`；状态文字 `● ${name} 在线` / `○ ${name} 离线`；其他文字把 "Claude" 换成 `PPTAgent.name()`。
- [ ] **Step 4:** e2e 全部 PASS；selftest PASS。
- [ ] **Step 5: Commit** `feat(page): name the agent that is listening`

### Task 4: 说明拆分 + Codex skill

**Files:**
- Create: `prompts/ppt-common.md`（从 `.claude/commands/ppt.md` 的"处理事件"和"格式规则"两节搬来）
- Create: `codex/skills/ppt/SKILL.md`
- Modify: `.claude/commands/ppt.md`（只留 Claude 启动步骤 + 读共用说明）、仓库外 `~/.claude/commands/ppt.md`
- Test: `ppt/test_server.py` 新类 `PromptTests`

**Interfaces:**
- Produces: `codex/skills/ppt/SKILL.md` 中用占位符 `{{PPT_HOME}}` 表示程序目录（Task 5 替换）。

- [ ] **Step 1: 写失败测试 `PromptTests`**
  - `test_common_rules_name_no_claude_tools`：`prompts/ppt-common.md` 存在，且不含 `Monitor`、`WebFetch`、`run_in_background`、`Claude Code`（kb skill 一句改为"按 skill 的格式"）。
  - `test_both_entries_read_the_common_rules`：`.claude/commands/ppt.md` 和 `codex/skills/ppt/SKILL.md` 都含 `prompts/ppt-common.md`；SKILL.md frontmatter 有 `name: ppt` 和 `description:`；SKILL.md 含 `--wait --recent --agent Codex`、`--wait --agent Codex`、`已停止监听`、`windows.sandbox` 和 `unelevated`。
  - `test_claude_entry_keeps_its_loop`：`.claude/commands/ppt.md` 含 `--detach`、`--tail`、`Monitor`。
- [ ] **Step 2:** 跑 `PromptTests` → FAIL。
- [ ] **Step 3:** 写文件。SKILL.md 按 spec 3.5 逐条写，路径用 `{{PPT_HOME}}/ppt/server.py`，deck 在当前目录 `decks/<名字>/`（先确认当前目录写成绝对路径），并按 Task 0 的 ruling 写服务启动、抓网页、工作区外写入的说明。共用说明里的 Read/WebFetch 改成动作描述（"看这张截图"、"抓取这个网页"）。全局 `~/.claude/commands/ppt.md` 第 1 步改为先读 `.claude/commands/ppt.md`（它会再让你读 `prompts/ppt-common.md`），第 2 步允许读的文件加上 `prompts/ppt-common.md`。
- [ ] **Step 4:** `PromptTests` PASS；全量 server 测试 OK。手工验证 Claude 侧：在本仓库外的临时目录新会话里运行 `/ppt spike` 能启动（由用户在 Task 6 一起验收；本步只核对全局文件内容）。
- [ ] **Step 5: Commit** `feat(prompts): shared rules for every agent; Codex skill`

### Task 5: `--install-codex`

**Files:**
- Modify: `ppt/server.py`（`main` + `install_codex(home: Path) -> Path`）
- Test: `ppt/test_server.py` `PromptTests`

**Interfaces:**
- Consumes: Task 4 的 `codex/skills/ppt/`。
- Produces: `install_codex(home)` 把 `codex/skills/ppt/` 复制到 `home/.agents/skills/ppt/`（已存在先删再复制），把 `{{PPT_HOME}}` 换成仓库绝对路径（正斜杠），返回目标目录；CLI `python ppt/server.py --install-codex`（不需要 deck 参数：`deck` 改为 `nargs="?"`，其他命令缺 deck 时照旧报错），打印安装位置、`$ppt <名字>` 用法和 `[windows]` / `sandbox = "unelevated"` 配置说明。

- [ ] **Step 1: 写失败测试** `test_install_codex`：临时 home → 返回目录下 `SKILL.md` 不含 `{{PPT_HOME}}`、含仓库路径；再装一次不报错且内容一样；`test_install_codex_cli`：`main(["--install-codex"])` 在 `mock.patch.object(Path, "home", return_value=tmp)` 下打印含 `unelevated`。
- [ ] **Step 2:** → FAIL。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 全量 server 测试 OK；运行一次真实 `python ppt/server.py --install-codex`（装到用户 home，这是本功能的目的）。
- [ ] **Step 5: Commit** `feat(server): --install-codex`

### Task 6: 真实 Codex 冒烟 + 文档

**Files:**
- Modify: `README` 或 `docs` 里已有的使用说明（若有）加一节"在 Codex 里用"；`.vibe/state.md`

- [ ] **Step 1:** 用 `codex exec -s workspace-write -c 'windows.sandbox="unelevated"'`，在 scratchpad 目录里发 `$ppt spike`，并预先往 `decks/spike/.ppt/inbox.jsonl` 由页面接口（`POST /api/event`）放一条 intent "把标题改成 Codex 冒烟"。Expected: deck.html 标题被改、outbox 有回执、`.ppt/agent` 为 `Codex`。（`codex exec` 是非交互的，空闲停止用 `--idle 30` 的手工命令验证即可。）
- [ ] **Step 2:** 停服务，删 scratchpad 里的 spike 目录。
- [ ] **Step 3:** 请用户在交互式 Codex 里试一次 `$ppt 试用`（框选 → 意图 → 回执 → 15 分钟不动 → "继续"），并在 Claude 里试一次 `/ppt`，确认拆分说明后 Claude 照常。
- [ ] **Step 4: Commit** `docs: using ppt-maker from Codex`
