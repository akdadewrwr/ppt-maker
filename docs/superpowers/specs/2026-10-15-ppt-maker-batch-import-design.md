# ppt-maker 子项目 5：批量提交 + 导入 HTML 设计

日期：2026-10-15　状态：用户已逐段确认　前置：子项目 1–4

## 1. 目标与范围

**问题 1**：现在每个意图写完就立刻发给 Claude。要规划一整页，或者好几处一起改时，只能一条一条发，Claude 看不到全貌，前后可能互相打架。

**问题 2**：以前做过的 HTML（其他工具或 AI 生成的幻灯片、普通网页、放在别处的 ppt-maker deck）没法拿进来用 ppt-maker 的方法继续改。

**目标**：
1. **批量提交**：意图可以先放进"待发清单"，跨多页，可改可删，加一段总体说明，一次发送；Claude 当成一个整体来规划。
2. **导入 HTML**：上传 `.html` / `.zip` 或给一个网址，由 Claude 尽量还原原样地转成 ppt-maker 格式（追加或替换），之后就能用所有现有方法继续改。

**不做**：清单的多套方案切换、导入时的逐页挑选、导入 PPTX（属于导出/互通子项目）、保留原稿的脚本和动画。

## 2. 批量提交

### 2.1 交互
- 意图框（框选、问 Claude、选字右键、草图"发给 Claude"、知识库"用在这一页"）有两个按钮：**发送**、**加入清单**。Enter = 发送；Ctrl+Enter = 加入清单；**清单非空时 Enter 也加入清单**（框里提示这一点）。
- 每条加入清单的意图在页面上显示带编号的虚线框（"① 待发"），位置是它的范围，跨页同样显示。
- 清单非空时顶栏出现"清单 (N)"；点开右侧侧栏（与知识库侧栏同位置，二者互斥）：
  - 每条：编号、页码、要求文字（可直接改）、截图缩略图、**定位**（滚到那一页）、**删除**。
  - **总体说明**输入框。
  - **全部发送**、**清空**。
- 清单存在浏览器里（按 deck 口令分键），刷新、关闭不丢。上限 30 条；第 31 条提示先发一批。截图存不下（浏览器存储满）时这条不带截图并提示。
- 画草图时清单侧栏和知识库侧栏一样让开。

### 2.2 事件
`{type:"intent", kind:"batch", text:<总体说明或"按清单修改">, items:[…]}`
- 每个 item 的字段与单独发送的意图相同：`slide, slide_id, rect, cells, blocks, text, kind?(sketch), notes?, quote?, kb?, shot?`。
- 服务端校验每个 item（同一白名单；`items` ≤ 30），截图分别保存为 `.ppt/shots/e12-1.png`、`e12-2.png`…，item 的 `shot` 改为路径。
- 摘要行：`e12 intent kind:batch slide:- [] items:3 按清单修改`。
- 发送前页面估算大小，超过 9MB 时提示"清单太大，请分两批发送"，不发送。
- `/api/state` 把 batch 展开成 `e12-1`、`e12-2`… 供页面画标记（状态与 e12 相同，回复显示在第 1 条旁）；对 batch 的回答 `re` 仍指向 `e12`。

### 2.3 Claude 规则（`ppt.md`）
- 先读完全部 item 和总体说明、看完全部截图，整体规划后再改；item 冲突时以总体说明为准；看不懂就问。
- 只回执一次，按编号逐条说明（"1. … 2. …"）。

## 3. 导入 HTML

### 3.1 交互
- 顶栏"导入"打开小对话框：选文件（`.html` / `.htm` / `.zip`，≤ 50MB）或粘贴网址；"追加到末尾"/"替换当前 deck"（当前 deck 还是未改过的模板时默认替换）。
- 提交后提示"已提交导入，等 Claude 转换"。Claude 回执后页面弹出回执，并带"打开原稿"链接（仅文件导入）。
- 终端里说"把 X 导入进来"：Claude 用 `server.py --import`。

### 3.2 服务端
- `POST /api/import?mode=&name=`（原始字节，流式写盘）；`POST /api/import/url` `{url, mode}`。都要口令与 Host 校验。
- 存到 `decks/<名字>/imports/<id>/`（`id` = `i-` + 6 位）。`.html` 直接存；`.zip` 安全解压：拒绝绝对路径、盘符、`..`；解压后总大小 ≤ 50MB、文件数 ≤ 2000；入口取最浅层的 `index.html`，否则最浅层的第一个 `.html`；没有 HTML 则拒绝。
- 类型提示 `hint`：含 `section.slide` 与 `id="theme"` → `ppt-maker`；含 reveal.js / Marp / Slidev 特征或 ≥ 3 个 `<section>` → `slides`；否则 `page`。
- `/imports/…` 以 `Content-Security-Policy: sandbox` 提供：原稿脚本不运行、与编辑器不同源。
- 事件：`{type:"import", kind:"file"|"url", mode, hint, import_id?, source, dir?, original?}`（`source` 为入口文件绝对路径或网址；`original` 为页面可打开的 `/imports/<id>/<入口>`）。需要 ack 与回执。
- `/api/state` 的 events 带上 import 事件（状态、回执、`original`），供页面弹出回执。

### 3.3 Claude 规则（`ppt.md`，尽量还原原样）
- `ppt-maker`：直接复制各页；id 冲突换新 id；替换时沿用其 `#theme`。
- `slides`：一页对一页；内容、布局、配色、字体尽量保持；布局对齐到 16×9 网格；颜色、字体写入 `#theme`；原有图表与 SVG 保留。
- `page`：按标题拆页（封面 + 每个章节一页），沿用原配色。
- 图片：导入目录里的复制到 deck 的 `assets/`；网上的下载到 `assets/`，失败放占位框并说明。
- 一律去掉脚本、动画、`on*` 属性、外部字体与脚本链接；deck 保持单文件离线。
- 需要看原稿样子时用 Edge 无头截图。
- 替换模式：保留 `#base`，换掉全部页面；追加模式：加在末尾。
- 回执：导入几页、哪些没能还原。识别不出内容或网址打不开：不改 deck，回执说明。

## 4. 架构

```
ppt/batch-panel.js   新：清单侧栏（只是界面；数据与发送在 editor.js）
ppt/importer.py      新：导入存储、安全解压、类型判断
ppt/editor.js        改：意图统一走 deliver(payload, toBatch)；清单数据、标记、发送；导入提交；回执弹出
ppt/toolbar.js       改：顶栏"清单 (N)""导入"；导入对话框
ppt/editor.css       改：标记、清单侧栏、对话框样式
ppt/server.py        改：batch 校验与截图、state 展开、/api/import*、/imports CSP、--import、import 事件
.claude/commands/ppt.md  改：batch 与 import 规则
```

## 5. 出错处理

| 情况 | 处理 |
|---|---|
| 清单 > 30 条 / 估算 > 9MB | 提示，不加入 / 不发送 |
| 浏览器存储满 | 这条不带截图加入，提示 |
| 服务端 batch 字段不合法 | 400（页面按现有逻辑丢弃并已在发送前校验大小，正常使用不会触发） |
| 导入格式不对 / zip 不安全 / 太大 / 没有 HTML | 400 / 413，对话框提示 |
| 原稿识别不出内容、网址打不开 | Claude 不改 deck，回执说明 |
| 导入替换后不满意 | 撤销（历史快照） |

## 6. 测试
1. **test_server**：batch 的 items 校验（类型、数量、item 内字段）、截图分存与路径、摘要行；state 展开与回答归属；importer：存 html、zip 安全解压（`..`、绝对路径、过多、过大、没有 html）、入口选择、hint 三类；`/api/import*` 口令与 413/400 送达；`/imports` 的 CSP 头；网址导入事件；`--import` 命令行。
2. **e2e**：Ctrl+Enter 加入清单出现编号标记与"清单 (1)"；清单非空时 Enter 也加入；另一页再加一条；侧栏改文字、删除、总体说明；全部发送得到 batch 事件且截图分存、清单清空、标记变为 e#-1；草图"加入清单"；导入 html 得到 import 事件、原稿带 CSP；网址导入；回执弹出带原稿链接。
3. **真实会话验收**（副本，验完删除）：用清单一次提交 3 处修改（跨 2 页 + 总体说明），Claude 一次回执；导入一份 reveal.js 风格的 HTML 和一个普通网页，检查还原程度。
