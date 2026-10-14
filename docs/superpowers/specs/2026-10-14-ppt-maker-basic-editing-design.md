# ppt-maker 子项目 2：基础编辑 设计

日期：2026-10-14　状态：待审阅　前置：子项目 1（核心闭环，见 `2026-10-14-ppt-maker-core-loop-design.md`）

## 1. 目标与范围

**问题**：子项目 1 只能通过 Claude 修改版面（框选写意图）或直接改字。改颜色、调大小、挪位置这类确定性操作走 Claude 既慢又耗 token，也不符合 PPT 用户的习惯。

**目标**：在页面上提供 PowerPoint 式的基础编辑能力。所有确定性操作**由页面直接执行**：立即生效、不耗 token，改完记一条 `edit` 事件通知 Claude。Claude 只负责需要理解和生成的事。

**成功标准**：用户不借助 Claude 就能完成改色、改字号、调整块的位置和大小、加删页面、插入形状、箭头、图标、图片，并能撤销任何一步修改（包括 Claude 的修改）。

**拆成两份实施计划，各自可独立交付**：

| 计划 | 内容 |
|---|---|
| 2a | 选中模型与工具栏、文字格式、块样式、拖动/拉伸块、撤销/重做（含历史快照）、增删页面、操作重放、浏览器测试脚本入库 |
| 2b | 浮动对象：形状、箭头、图标（Lucide 内置 + 让 Claude 画）、图片上传 |

**不做**（以后需要再加）：多选、对齐与分布、复制粘贴块、拖动调整页序、对齐参考线、对象吸附、组合、图片裁剪、自由曲线（属于手绘草图子项目）、导出 pptx（放在最后）。

## 2. 架构

### 2.1 文件

```
ppt/
├─ ops.js         新：所有直接修改操作（纯 DOM 函数，可作用于任意 Document）
├─ toolbar.js     新：顶栏、浮动栏、取色弹层、选中框与手柄、拖动/拉伸
├─ icons.js       新（2b）：Lucide 图标数据，由脚本生成
├─ editor.js      改：选中模型；保存改为"执行 op 并持久化"
├─ editor.css     改：工具栏、手柄、选中框样式
├─ server.py      改：历史快照、撤销/重做/历史接口、图片上传接口
├─ selftest.html  改：加入 ops 用例
└─ test_server.py 改：加入历史与上传用例
tools/build_icons.py  新（2b）：Lucide SVG → ppt/icons.js
tests/e2e.mjs         新：浏览器驱动测试脚本（仅开发用，需 Node ≥ 22 与 Edge/Chrome）
```

`server.py` 注入顺序变为：`html-to-image.js` → `geom.js` → `ops.js` → `icons.js`（存在时）→ `toolbar.js` → `editor.js`。

### 2.2 操作模型（方案 A）

每个直接修改都是 `ops.js` 中的一个操作，形如 `{op, target, args}`。`window.PPTOps.apply(doc, op)` 在给定 Document 上执行它，并返回是否成功（目标不存在时返回 `false`）。

一次操作的流程：

1. 页面在**当前 DOM** 上执行 `apply(document, op)`，用户立即看到效果。
2. 把 op 追加到待保存列表（localStorage，按 deck 口令分键）。
3. 保存：`GET /api/deck` 取文件原文 → `DOMParser` 解析 → 依次 `apply(raw, op)` → `PUT /api/deck` 整份写回。PUT 带 `label`（如"改背景色 b-left"），供历史和事件使用。
4. 成功后清空待保存列表。冲突（版本不符 / 409）或断线时保留列表；页面空闲后刷新，在最新文件上**重放**全部待保存 op 后再保存。`apply` 返回 `false` 的 op 被丢弃，并弹提示说明哪一步没生效。

**前提**：同一 op 作用于两份内容相同的文档，结果必须完全一致。所以 op 只能使用**绝对值**（"把背景设为 #ef4444""把块移到 3/2/6/9"），不能用相对值（"右移一格"）。

子项目 1 的"改字重放"（`ppt-replays`）并入此机制，成为 `setHTML` op。

### 2.3 op 清单

| op | args | 说明 |
|---|---|---|
| `setHTML` | `html` | 替换块或对象内文字区的 innerHTML（改字、文字格式） |
| `setStyle` | `{prop: value \| null}` | 设置或清除内联样式；只允许白名单属性（见 3.2） |
| `setGrid` | `"r1/c1/r2/c2"` | 块的 grid-area，夹在 1–10 / 1–17 之内 |
| `insertBlock` | `{id, slideId, grid, html}` | 新建块（`+文字`） |
| `remove` | — | 删除块或对象 |
| `insertSlide` | `{id, afterId, html}` | 插入一页 |
| `removeSlide` | — | 删除一页 |
| `insertObj` | `{id, slideId, kind, geom, html}` | 新建浮动对象（2b） |
| `setGeom` | `{x, y, w, h, rot}` | 浮动对象的位置、大小、旋转（2b） |
| `setZ` | `"top" \| "bottom"` | 对象在本页对象中的层级（2b） |
| `setArrow` | `{x1, y1, x2, y2}` | 箭头两端点，换算为 geom（2b） |
| `ensureBase` | — | `#base` 缺少 3.5 中的对象样式时补上；已有则不变（2b） |

新元素的 id 由页面生成：`b-` / `o-` / `s-` 前缀加 6 位随机字母数字，并在当前文档中查重。

## 3. 格式规则变化（同步修改 `ppt.md`）

### 3.1 颜色
允许固定色值（如 `#ef4444`）。"颜色只用主题变量"降级为 Claude 自行生成内容时的**建议**，不再是硬性规则。用户选的颜色一律写固定值，整体换主题时不会跟着变。

### 3.2 块样式
块的 `style` 中允许：`grid-area`、`background`、`border`、`border-radius`、`box-shadow`、`text-align`、`color`、`font-size`、`font-weight`、`font-style`、`text-decoration`、`opacity`（后三项用于不进改字模式时整块加粗 / 斜体 / 下划线）。`setStyle` 只接受这些属性（浮动对象另加 `left`、`top`、`width`、`height`、`transform`、`z-index`）。

### 3.3 文字格式
块内允许 `<b>`、`<i>`、`<u>`，以及 `<span style="color:…">` / `<span style="font-size:…px">`。不使用 `<font>`。字号不用 `execCommand('fontSize')`（只有 1–7 号），由页面给选区包一层 `span`。

### 3.4 浮动对象（2b）
```html
<div class="obj" id="o-k3x9qa" data-kind="arrow"
     style="left:320px;top:200px;width:240px;height:40px;transform:rotate(15deg)">
  <svg …>…</svg>
</div>
```
- 坐标是 1280×720 画布像素；`transform` 只允许 `rotate(…deg)`。
- 位于所属 `section.slide` 内、所有块之后，因此显示在块上方；DOM 顺序即层级。
- `data-kind` ∈ `shape` / `arrow` / `icon` / `image`。
- 形状可包含文字区 `<div class="obj-text">…</div>`，双击编辑。

### 3.5 `#base` 新增
```css
.obj { position:absolute; box-sizing:border-box; }
.obj > svg, .obj > img { display:block; width:100%; height:100%; }
.obj-text { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; text-align:center; padding:8px; }
```
已有 deck 的 `#base` 缺这几条时，页面在首次插入对象的同一次保存中补上（`ensureBase` 也作为 op 执行）。旧 deck 其余部分不受影响。

## 4. 交互

### 4.1 鼠标与键盘

| 操作 | 结果 |
|---|---|
| 单击块 / 对象 | **选中**：显示手柄与浮动工具栏（取代子项目 1 中"单击直接弹意图框"） |
| 从未选中处开始拖动 | 画区域框 → 意图框（不变） |
| 拖动已选中的块 | 移动，吸附 16×9 网格，松手保存 |
| 拖动块的手柄（四角、四边） | 拉伸，吸附网格；最小 1×1 格 |
| 拖动已选中的对象（2b） | 自由移动；`Shift` 锁定水平或垂直方向 |
| 对象手柄 / 旋转手柄 / 箭头端点（2b） | 缩放（`Shift` 保持比例）/ 旋转（`Shift` 每 15° 一档）/ 移动端点 |
| 双击块或形状 | 改字模式（不变）；此时文字按钮作用于选中的字 |
| 改字模式中选字 + 右键 | 只改这段（不变） |
| 单击空白处 / `Esc` | 取消选中 |
| `Enter`（有选中、非改字模式） | 打开"问 Claude"意图框，范围 = 选中元素 |
| `Ctrl+Z` / `Ctrl+Y`（也接受 `Ctrl+Shift+Z`） | 撤销 / 重做（改字模式中交给浏览器自身的撤销） |
| `Delete` / `Backspace`（非改字模式） | 删除选中元素 |
| 方向键（2b，对象） | 移动 1px；加 `Shift` 10px |

"问 Claude"发出的意图与框选意图格式相同，`blocks` 为选中元素的 id，`rect` 为它的范围，并附截图。

### 4.2 浮动工具栏

- **块**：`字色 | 字号 | B I U | 对齐 ┃ 背景 | 边框(色/粗细) | 圆角 | 阴影 ┃ 删除 ┃ 问 Claude`
- **形状 / 箭头**（2b）：`填充 | 线条色 | 线宽 | 透明度 ┃ 置顶 置底 ┃ 删除 ┃ 问 Claude`
- **图标**（2b）：`颜色 | 线宽 ┃ 置顶 置底 ┃ 删除 ┃ 问 Claude`
- **图片**（2b）：`圆角 | 边框 | 透明度 ┃ 置顶 置底 ┃ 删除 ┃ 问 Claude`

非改字模式下，文字按钮作用于整块（写在块的 style 上）；改字模式下，作用于选中的字（包 `span`）。工具栏优先显示在元素上方，空间不够时显示在下方，始终保持在窗口内。

**取色弹层**：一排主题色（读取 `#theme` 中的变量当前值，写入的是固定值）、一排 10 个常用色、最近使用的 8 个颜色（按 deck 保存在浏览器里）、"自定义"（`<input type="color">`）、"无"。

### 4.3 顶栏

`↶ ↷ ┃ +文字 +形状▾ +图片 +图标 ┃ +页 −页 ┃ ● Claude 在线`

- 固定在窗口顶部；原来右上角的状态标签并入顶栏。
- "当前页"指在视口中露出面积最大的那一页。
- `+文字`：在当前页中央放一个 6×2 格的块并选中它。
- `+页`：在当前页之后插入一张空白页。
- `−页`：删除当前页，不弹确认（可以撤销）；只剩一页时不可用。
- 2a 中 `+形状 / +图片 / +图标` 显示为不可用。

### 4.4 与自动检查（lint）的配合

用户执行 `setGrid`、`setGeom`、`insertBlock`、`insertObj` 后保存成功时，把当时页面上的全部 lint 问题记为"已见"，不再上报。之后只有新出现的问题（通常由 Claude 造成）才会以 `lint` 事件发给 Claude。浮动对象与块的重叠不算问题。实现中扩展为：用户的任何直接操作保存成功后，都把当时的 lint 问题记为已见。

## 5. 撤销与历史

### 5.1 存储
```
decks/<名字>/.ppt/history/
├─ 0001.html …       每个版本一份完整快照
└─ index.jsonl       {"n":12, "by":"user|claude|undo|redo", "label":"…", "ts":"…"}
```
- 服务启动时，如果当前文件与最新快照不同，先存一份（`by: "claude"`，label "外部修改"）。
- `PUT /api/deck` 成功后存快照（`by: "user"`，label 取请求中的 `label`）。
- 后台线程每 0.5 秒检查 `deck_version`；与服务记录的"最后已知版本"不同时存快照（`by: "claude"`，label 为"Claude 处理 #eN"，N 取 outbox 中最近一条 ack 了但尚未完成的事件；没有时为"Claude 修改"）。
- 服务自己写文件（PUT、撤销、重做）时，在 `LOCK` 内更新"最后已知版本"，后台线程不会重复记录。
- 最多保留 200 份，超出时删除最旧的。丢弃重做分支后，快照编号可能被复用（不影响任何功能）。
- 快照写入失败只记日志，不影响保存；此时 `/api/history` 返回 `"ok": false`，撤销按钮变灰并提示原因。

### 5.2 撤销 / 重做
- 服务端维护指针 `cur`（指向当前版本对应的快照）。
- `POST /api/undo`：`cur > 最旧` 时，把 `cur-1` 号快照写回 `deck.html`，`cur -= 1`。
- `POST /api/redo`：存在 `cur+1` 时写回并 `cur += 1`。
- 在 `cur` 不是最新时出现新的修改（用户或 Claude），丢弃 `cur` 之后的所有快照（重做分支），新快照接在 `cur` 之后。
- 页面按撤销时，若有待保存 op 或正在改字，先完成保存再撤销。撤销 / 重做成功后页面刷新（保持滚动位置）。
- `GET /api/history` → `{"ok", "canUndo", "canRedo", "undoLabel", "redoLabel"}`；页面用它设置 ↶/↷ 的可用状态与提示文字（"撤销：Claude 处理 #e17"）。并入 `/api/state` 的返回，不额外轮询。
- 所有新接口都要求口令，并经过 Host 校验。

### 5.3 通知 Claude
撤销 / 重做记一条事件：`{"type":"edit","op":"undo","label":"撤销了 Claude 处理 #e17"}`。普通直接操作的 `edit` 事件同样带 `op` 和 `label`。`ppt.md` 新增规则：用户撤销了你的修改时，不要自动改回去；同一意图再次出现时，参考这次撤销换一种做法，必要时先问用户。

## 6. 浮动对象细节（2b）

### 6.1 形状与箭头
- 种类：矩形、圆角矩形、椭圆、三角形、直线、单向箭头、双向箭头。
- SVG 使用 `viewBox="0 0 w h"`，并在每次 `setGeom` 时按新尺寸重新生成（不用 `preserveAspectRatio="none"`，以免线宽被拉伸）。
- 默认样式：填充 `#dbeafe`，线条 `#2563eb`，线宽 2；直线和箭头无填充。
- 插入：从 `+形状▾` 选择种类后，在幻灯片上拖动画出；只单击则放置 160×100（箭头为 160 长）。

### 6.2 图标
- `tools/build_icons.py` 读取 Lucide 官方 SVG 目录（一次性下载的 `lucide-static` 包），生成 `ppt/icons.js`：`{name: {tags, body}}`。同时生成 `ppt/vendor/LICENSE-lucide`。
- 面板：搜索框（匹配名称、标签和内置中英对照表）+ 分类 + 网格。内置对照表 `ppt/icons-zh.js` 约 150 个常用词。
- 插入：内联 SVG，`stroke="currentColor"`，颜色写在对象的 `color` 上，默认 64×64。
- "让 Claude 画一个"：输入描述后发出意图 `{type:"intent", kind:"draw-icon", text, slide_id, rect}`，`rect` 为当前页中央 64×64。Claude 按 3.4 的格式新建 `data-kind="icon"` 的对象。

### 6.3 图片
- 来源：`+图片` 选择文件、粘贴剪贴板图片、拖进幻灯片。
- `POST /api/asset?t=`：请求体为原始字节，`Content-Type` 为图片类型；上限 10MB；按文件头判断类型，只接受 PNG / JPEG / GIF / WebP（**拒绝 SVG**）；保存为 `assets/<sha1 前 12 位>.<扩展名>`，相同内容复用同一文件；返回 `{"src": "assets/…"}`。
- 插入：按原图比例，长边不超过 480px；放在拖入或粘贴位置，否则放在当前页中央。

## 7. 出错处理

| 情况 | 处理 |
|---|---|
| 保存冲突或断线 | 待保存 op 留在浏览器，页面空闲时刷新并重放（2.2） |
| 重放时目标不存在 | 跳过该 op，弹提示说明 |
| 拖动或拉伸中文件被 Claude 修改 | 与正在输入相同：松手并保存后再刷新 |
| 撤销时有待保存内容 | 先保存再撤销 |
| 快照写入失败 | 记日志，保存照常；撤销不可用并提示 |
| 图片过大或类型不支持 | 弹提示，不插入 |
| `icons.js` 不存在 | 图标面板提示运行 `python tools/build_icons.py`；"让 Claude 画"仍可用 |
| Claude 写出的对象缺少尺寸、超出画布或缺 id | lint 新增 `obj-geometry`、`obj-outside`、`missing-id`，上报给 Claude |

## 8. 测试

1. **`selftest.html`**：每个 op 至少一个用例，覆盖 `setStyle` 白名单、`setGrid` 夹取、增删块与页、`insertObj` / `setGeom` / `setZ` / `setArrow`；**确定性用例**：同一组 op 依次作用于两份相同文档，序列化结果逐字相同。
2. **`test_server.py`**：PUT 存快照；外部写文件被后台线程捕获并归为 Claude；撤销 / 重做；撤销后新修改丢弃重做分支；服务自己写文件不重复记录；200 份上限；快照失败不影响保存；`/api/asset` 收 PNG、拒绝 SVG / 超大 / 无口令，相同内容不重复存。
3. **`tests/e2e.mjs`**：把子项目 1 的浏览器驱动脚本正式入库（只操作自己的 `decks/e2e-*` 目录），新增：选中、移动、拉伸、改色、改字号（选字）、增删页、撤销 Claude 的修改、冲突时 op 重放；2b 加插入形状 / 箭头 / 图标 / 图片、旋转、置顶。运行：`node tests/e2e.mjs`。
4. **端到端验收**：用真实会话（Claude 端按 `ppt.md` 执行）走一遍：直接改色 → Claude 收到 edit 事件；让 Claude 改一块 → 撤销 → Claude 收到 undo 事件且不再改回；插入图标、图片后让 Claude 调整。
