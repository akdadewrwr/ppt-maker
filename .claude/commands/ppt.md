---
description: 打开 ppt-maker：在浏览器幻灯片上框选/写意图/改字，操作实时回传本会话
argument-hint: <deck 名字或主题>
---
你是 ppt-maker 的执行端：用户在浏览器幻灯片上操作，操作以事件形式到达本会话，你修改 `decks/<名字>/deck.html`。参数：$ARGUMENTS

## 启动
1. 名字取参数（去掉 `/\:*?"<>|`）；参数为空就问用户。下面命令里的 `python` 不存在时用 `python3`；路径一律加引号。
2. `decks/<名字>/deck.html` 不存在：复制 `ppt/template.html` 过去，按参数主题（及对话中已有信息）写 3–6 页初稿，严格遵守"格式规则"。
3. 后台启动服务（Bash，run_in_background）：`python ppt/server.py "decks/<名字>"`。从输出拿到 URL 发给用户（服务已自动打开浏览器）。
4. 用 Monitor 挂监听：command `python ppt/server.py --tail "decks/<名字>"`，timeout_ms 1800000，description `ppt 事件 <名字>`。它启动时先输出所有未完成事件，按顺序处理。**监听到期通知一到，立即用同一命令重新挂上。**
5. 服务进程退出的通知到达时：重新执行第 3 步，把新 URL 告诉用户。

## 处理事件
摘要格式：`e17 intent slide:s-intro [b-right,b-r1] 文字…`。完整内容在 `decks/<名字>/.ppt/inbox.jsonl`，按 id 查。
- 处理 intent / answer / lint 之前先标记：`python ppt/server.py --reply "decks/<名字>" <id> --ack`
- **intent**：有 `shot` 就用 Read 看截图（路径相对 deck 目录）。先重新读 deck.html，再只改 `blocks` 列出的块（第一个是最内层）；`blocks` 为空时按 `cells`（列范围/行范围）在该区域新建块。不动无关块。
- **intent 带 `quote`**（用户在改字模式下选中文字后右键发来的）：只改这段原文。在 `blocks[0]` 里找 `quote.text`；出现多次时用 `quote.before` / `quote.after` 定位。只替换这一处，块里其他内容一律不动；没有截图，也不用看。原文已找不到时，在回执里问用户，不要猜。
- **answer**：`re` 指向原 intent；结合原意图、你之前的回执和这条回答继续改。
- **lint**：修 `issues`：overflow → 精简文字、减小字号或扩大 grid-area；overlap → 调整 grid-area；missing-id / duplicate-id → 补或改 id。同一块同一问题最多自动修 2 次，之后只回执说明，让用户决定。
- **edit**：用户直接改了某块。无需动作、无需回执；下次改文件前重新读。
- 处理完必须回执（一句话说明改了什么）：`python ppt/server.py --reply "decks/<名字>" <id> "<说明>"`。没理解就在回执里问一个具体问题，不要猜着大改。
- 用户在终端直接说的话照常执行，规则相同。

## deck.html 格式规则
1. 每页 `<section class="slide" id="s-…">`，每块 `<div class="block" id="b-…">`，id 全文件唯一。
2. id 是固定名字，不表示位置；调页序、增删内容都不重编号。新 id 用有意义的短名。
3. 定位只用 `style="grid-area:起始行/起始列/结束行/结束列"`，网格 16 列 × 9 行（画布 1280×720，每格 80px，结束线最大为行 10 / 列 17）。块内细分用 `class="block grid"` 并写 `grid-template-columns`/`grid-template-rows`。
4. 颜色字体只用 `#theme` 里的 CSS 变量；整体风格只改 `#theme`；单块主题在该块 style 里覆盖变量。不改 `#base`。
5. 文字必须是真文字；表格用 `<table>`；插图用内联 SVG 或 `assets/` 下的图片。
6. 单文件离线：不引用外部网络资源（字体、脚本、图片都不行）。
7. 不要写入任何 `data-ppt` 属性或 `ppt-` 开头的 class（编辑层专用）。
