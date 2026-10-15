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
- **intent**：有 `shot` 就用 Read 看截图（路径相对 deck 目录）。先重新读 deck.html，再只改 `blocks` 列出的块或对象（`o-` 开头的是浮动对象；第一个是最内层）；`blocks` 为空时按 `cells`（列范围/行范围）在该区域新建块。不动无关块。
- **intent 且 `kind` 为 `draw-icon`**：用户想要一个图标库里没有的图标，`text` 是描述。在 `slide_id` 页按 `rect` 的位置和大小新建一个图标对象（格式见规则 10），自己画 24×24 的线条图：只用 `path / circle / rect / line / polyline`，不写颜色和线宽（它们由对象的 `color`、`stroke-width` 控制），风格与 Lucide 一致（圆角端点、2px 线、简洁）。新 id 以 `o-` 开头。
- **intent 带 `quote`**（用户在改字模式下选中文字后右键发来的）：只改这段原文。在 `blocks[0]` 里找 `quote.text`；出现多次时用 `quote.before` / `quote.after` 定位。只替换这一处，块里其他内容一律不动；没有截图，也不用看。原文已找不到时，在回执里问用户，不要猜。
- **answer**：`re` 指向原 intent；结合原意图、你之前的回执和这条回答继续改。
- **lint**：修 `issues`：overflow → 精简文字、减小字号或扩大 grid-area；overlap → 调整 grid-area；missing-id / duplicate-id → 补或改 id；obj-geometry → 给对象补齐 `left/top/width/height`；obj-outside → 把对象移回画布内（必要时缩小）。同一块同一问题最多自动修 2 次，之后只回执说明，让用户决定。
- **edit**：用户在页面上直接改了内容（`label` 说明改了什么，如"移动 b-left""样式 background=#ef4444 b-title"）。无需动作、无需回执；下次改文件前重新读。
- **edit 且 `op` 为 `undo` / `redo`**：用户撤销或重做了一步（`label` 如"撤销了 Claude 处理 #e17"）。**被撤销的是你的修改时，不要自动改回去**；同一意图再次出现时换一种做法，必要时先问用户。
- 处理完必须回执（一句话说明改了什么）：`python ppt/server.py --reply "decks/<名字>" <id> "<说明>"`。没理解就在回执里问一个具体问题，不要猜着大改。
- 用户在终端直接说的话照常执行，规则相同。

## deck.html 格式规则
1. 每页 `<section class="slide" id="s-…">`，每块 `<div class="block" id="b-…">`，id 全文件唯一。
2. id 是固定名字，不表示位置；调页序、增删内容都不重编号。新 id 用有意义的短名。
3. 定位只用 `style="grid-area:起始行/起始列/结束行/结束列"`，网格 16 列 × 9 行（画布 1280×720，每格 80px，结束线最大为行 10 / 列 17）。块内细分用 `class="block grid"` 并写 `grid-template-columns`/`grid-template-rows`。
4. 你自己生成内容时，颜色和字体优先用 `#theme` 里的 CSS 变量；整体换风格只改 `#theme`。用户在页面上选的颜色是固定色值（如 `#ef4444`），保留它们，不要改成变量。不改 `#base`。
5. 文字必须是真文字；表格用 `<table>`；插图用内联 SVG 或 `assets/` 下的图片。
6. 单文件离线：不引用外部网络资源（字体、脚本、图片都不行）。
7. 不要写入任何 `data-ppt` 属性或 `ppt-` 开头的 class（编辑层专用）。
8. 块的 `style` 只写这些属性：`grid-area, background, border, border-radius, box-shadow, text-align, color, font-size, font-weight, font-style, text-decoration, opacity`；块内文字格式只用 `<b> <i> <u>` 和 `<span style="color:…">` / `<span style="font-size:…px">`，不用 `<font>`。
9. 不要创建或修改 `.ppt/history/`，撤销由页面完成。
10. 浮动对象（形状、箭头、图标、图片）：`<div class="obj" id="o-…" data-kind="shape|arrow|icon|image" style="left:…px;top:…px;width:…px;height:…px">`，放在所属页内所有块之后，DOM 顺序即上下层级。坐标是画布像素；旋转只写 `transform:rotate(…deg)`。对象 style 只写：`left, top, width, height, transform, fill, stroke, stroke-width, color, opacity, border, border-radius, box-shadow`。
    - 形状：`data-shape` 为 `rect|round|ellipse|triangle`；内含 `<svg viewBox="0 0 宽 高">`，与对象尺寸一致（改尺寸时按新尺寸重画）；填充/线条写在对象的 `fill / stroke / stroke-width` 上，不写在 svg 里。形状里的文字放 `<div class="obj-text">…</div>`（在 svg 之后）。
    - 箭头：`data-shape` 为 `line|arrow|arrow2`；svg 里一条 `<line>`（端点是对象内坐标，四周留 8px）加箭头 `<polyline … fill="none">`。
    - 图标：`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">…</svg>`，颜色写对象的 `color`，线宽写 `stroke-width:2`。
    - 图片：`<img src="assets/…" alt="">`，只用 `assets/` 下已有的文件。
    - `#base` 里的 `.obj` 规则由页面维护，不要改。
