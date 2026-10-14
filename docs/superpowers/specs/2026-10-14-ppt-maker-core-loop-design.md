# ppt-maker 子项目 1：核心闭环 设计

日期：2026-10-14　状态：待审阅

## 1. 目标与范围

**问题**：用通用 agent（Claude / Codex）做 PPT 时，用户看不见、改不准；"把这页分成几块、每块一个主题"这类意图很难用语言说清。

**思路**：不造新 agent。用一个本地 HTML 页面当 Claude Code 的"眼睛和手"：用户在幻灯片上框选、写意图、直接改字，这些操作连同精确位置和截图回传给会话，由 Claude 改写 HTML。核心原则是把用户的隐性意图对齐成 agent 能执行的显性指令。

**成功标准**：作者本人能用它做完一份真实 PPT（如组会汇报），并且比直接在终端和 Claude 对话改得更快、更准。之后开源到 GitHub，任何人在本地一条命令即可运行（无云端、跨平台、零依赖）。

**本子项目只做核心闭环**：

> `/ppt` 打开页面 → 框选 + 写意图 → 会话收到（页、块、网格位置、截图、文字）→ Claude 改 deck.html → 页面自动刷新 → 回执气泡

**v1 支持的输入**：框选 + 文字意图（附选区截图）；直接改字。

**不在本子项目内**（各自后续独立立项）：知识库接入、HTML→pptx 导出脚本、手绘草图、Codex 接入、同时打开多份 deck、元素自由拖拽。

## 2. 架构与组件

```
ppt-maker/
├─ .claude/commands/ppt.md     Claude 的操作手册（启动、监听、事件处理、格式规则）
├─ ppt/
│  ├─ server.py                本地服务，仅 Python 标准库
│  ├─ editor.js / editor.css   编辑层：翻页、框选、意图输入、直接改字、截图、lint、气泡
│  ├─ vendor/html-to-image.js  截图库，单文件入库，不走网络
│  ├─ test_server.py           服务端测试
│  └─ selftest.html            页面计算逻辑自检
└─ decks/<名字>/
   ├─ deck.html                幻灯片本体，纯内容
   ├─ assets/                  图片、插图
   └─ .ppt/                    运行时数据（不入库）：inbox.jsonl、outbox.jsonl、shots/、heartbeat
```

| 组件 | 职责 | 不做 |
|---|---|---|
| deck.html | 只放内容，可直接双击放映 | 不含编辑层代码 |
| server.py | 发 deck 时注入编辑层；接收提交写入 inbox/shots；通过 `/api/state` 提供版本号与事件状态供页面轮询；`--tail`、`--reply` 两个命令行模式 | 不含任何 AI 逻辑 |
| editor.js | 采集意图与改字，检查渲染问题 | 不生成内容 |
| ppt.md | 规定格式与事件处理协议；所有生成能力在 Claude 侧 | — |

`server.py` 的三种运行方式：

- `python ppt/server.py <deck目录>`：启动服务（后台运行），打印带口令的 URL。
- `python ppt/server.py --tail <deck目录>`：监听模式，每来一条新事件打印一行摘要，每 10 秒写一次心跳。由 Claude Code 的 Monitor 运行，到期（≤30 分钟）后重新挂上；它与服务是两个进程，监听到期不影响服务。
- `python ppt/server.py --reply <deck目录> <事件id> "<文字>"`：写一条回执到 outbox。

`decks/*/.ppt/` 加入 `.gitignore`。

## 3. 幻灯片数据格式

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>组会汇报</title>
<style id="theme">
  :root { --bg:#fff; --fg:#1a1a1a; --accent:#2563eb; --font:"Microsoft YaHei",sans-serif; }
</style>
<style id="base">
  .slide { width:1280px; height:720px; display:grid;
           grid-template-columns:repeat(16,1fr); grid-template-rows:repeat(9,1fr); }
</style>
</head><body>
<section class="slide" id="s-intro">
  <div class="block" id="b-title" style="grid-area:1/1/3/17"><h1>研究背景</h1></div>
  <div class="block" id="b-left"  style="grid-area:3/1/9/9"><p>……</p></div>
  <div class="block grid" id="b-right" style="grid-area:3/9/9/17">
    <div class="block" id="b-r1">…</div><div class="block" id="b-r2">…</div>
  </div>
</section>
</body></html>
```

规则（写入 ppt.md，Claude 必须遵守）：

1. 每页是 `section.slide`，每块是 `div.block`，都必须有全文件唯一的 id。
2. id 是固定的名字，不表示位置；调换页序或增删内容时不重编号。
3. 定位只用 `grid-area: 起始行/起始列/结束行/结束列`，基于 16×9 网格（每格 80px）。块内细分用 `.block.grid` 子网格。网格数量是 `#base` 里的一个参数，日后可调。
4. 颜色和字体只用 `#theme` 中的 CSS 变量。整体换风格只改 `#theme`；单块主题在该块上覆盖变量。`#base` 不改。
5. 文字必须是真文字；表格用 `<table>`；插图用内联 SVG 或 `assets/` 下的图片。
6. 单文件、离线可用：样式内联，字体用系统字体，不引用外部网络资源。

## 4. 事件流程

### 4.1 启动 `/ppt <名字或主题>`

1. 若 `decks/<名字>/` 不存在，Claude 按主题写初稿 deck.html。
2. Claude 后台启动服务，端口被占用时自动顺延；服务使用该 deck 的随机口令（首次启动生成，存于 `.ppt/token`，重启不变，已打开的页面可自动恢复），打印 `http://127.0.0.1:<端口>/?t=<口令>`；Claude 打开该 URL。
3. Claude 用 Monitor 运行 `--tail`。
4. Claude 检查 inbox 中没有回执的事件，按顺序补处理。

### 4.2 事件格式（inbox.jsonl，每行一条）

```json
{"id":"e17","ts":"2026-10-14T10:02:03Z","type":"intent","slide":3,"slide_id":"s-intro",
 "rect":{"x":640,"y":160,"w":640,"h":480},"cells":"9-16/3-8",
 "blocks":["b-right","b-r1"],"text":"这块拆成三栏，每栏一个方法","shot":".ppt/shots/e17.png"}
{"id":"e18","type":"edit","slide_id":"s-intro","block":"b-left"}
{"id":"e19","type":"answer","re":"e17","text":"标题用 A/B/C"}
{"id":"e20","type":"lint","issues":[{"block":"b-r2","kind":"overflow","px":40}]}
```

- `rect` 用 1280×720 画布坐标；`cells` 表示"列范围/行范围"（从 1 开始，包含两端）；`blocks` 是与框相交的块 id，内层块在前。
- `--tail` 每条事件只打印一行摘要（id、类型、页、块、文字前 60 字），完整内容由 Claude 读 inbox 获取。

### 4.3 一次意图的处理

1. 用户拖框、写意图、回车。
2. 页面计算 rect / cells / blocks，截取选区图，带口令 POST 到服务。
3. 服务保存截图，追加 inbox 一行。
4. `--tail` 打印摘要，Claude 被唤醒：读事件，看截图，只改相关块。
5. 页面每秒轮询 `/api/state`（版本号、心跳、事件状态、回执）；版本号变化即刷新并恢复滚动位置。（ponytail: 本机轮询比 SSE 少一套长连接代码，延迟 ≤1 秒）
6. Claude 执行 `--reply e17 "已拆成三栏：A/B/C"`；页面在原区域旁显示气泡。Claude 没理解时可在回执里反问，用户在气泡中回答，生成一条 `answer` 事件。

### 4.4 其他

- **排队**：事件按顺序处理。页面上每个框显示状态：排队中 → 处理中（Claude 已读取）→ 已完成（有回执）。"处理中"由 Claude 在开始处理时执行 `--reply <id> --ack` 标记。
- **直接改字**：点击文字进入编辑，失焦时保存。页面 PUT 完整 deck 内容并附带加载时的版本号（文件修改时间 + 大小）；服务写入后追加一条 `edit` 事件。Claude 收到后不需要动作，只需在下次修改前重新读文件。
- 终端对话照常可用，与页面事件效果相同。

## 5. 出错处理

| 情况 | 处理 |
|---|---|
| Claude 不在线（会话关闭 / 监听到期未重挂） | 事件持久保存在 inbox；页面依据心跳（超过 30 秒未更新即离线）显示"Claude 在线/离线"；下次 `/ppt` 时补处理没有回执的事件 |
| 服务断开 | 页面显示红条；未发出的意图暂存于浏览器 localStorage，恢复后补发；服务进程退出时 Claude 收到后台任务通知并重启 |
| Claude 改出渲染问题 | 页面每次加载后检查文字溢出、块重叠、id 重复或缺失；有问题时发一条 `lint` 事件，同一问题（块 + 类型）只报一次；问题块显示红色虚线框；ppt.md 规定同一问题最多自动修 2 次，仍未解决就通过回执告知用户 |
| 改字冲突（版本号不符，409） | 页面拉取最新版本，按块 id 重放用户的修改后再次保存；该块已被删除时弹出提示，保留用户文字供复制 |
| 端口被占用 | 自动顺延到下一个端口 |

**安全**（开源前必须完成）：

- 只监听 `127.0.0.1`。
- 所有写操作（POST/PUT）都要求随机口令，口令只出现在 Claude 打开的 URL 中；同时校验 `Host` 请求头必须为 `127.0.0.1:<端口>` 或 `localhost:<端口>`，防止 DNS 重绑定。目的是防止任意网页冒充用户向会话注入指令。
- 文件访问限制在当前 deck 目录和 `ppt/` 目录内，越界路径拒绝；截图上限 5MB，事件文字上限 4000 字。

## 6. 测试

1. **`ppt/test_server.py`**（unittest，零依赖）：口令正确时写入 inbox 与截图；无口令、错误口令、异常 Host 被拒绝；路径越界被拒绝；版本号匹配时保存成功、不匹配时返回 409；`--reply` 写入 outbox、`--tail` 输出新事件并更新心跳。运行：`python ppt/test_server.py`。
2. **`ppt/selftest.html`**：用一份内置样例幻灯片，在浏览器中断言框选→网格换算、命中块计算、溢出/重叠检测，结果显示为绿色或红色。
3. **端到端验收清单**：`/ppt 测试` → 框选并提交意图 → Claude 修改 → 页面刷新 → 弹出气泡 → 直接改字 → 制造冲突 → 断开再恢复服务。可由 Claude 通过 Chrome 插件执行并截图。

不做：像素比对、UI 自动化测试框架。

## 7. 后续子项目（按建议顺序）

1. HTML→pptx 导出（利用 `getBoundingClientRect` 读取块的实际坐标）
2. 知识库接入（指定文件夹或文件作为生成上下文）
3. 手绘草图输入
4. Codex 接入（复用 inbox 格式，换一种取件方式）
