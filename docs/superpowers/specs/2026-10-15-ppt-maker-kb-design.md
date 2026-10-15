# ppt-maker 子项目 4：知识库 设计

日期：2026-10-15　状态：用户已逐段确认　前置：子项目 1–3（核心闭环、基础编辑、手绘草图）

## 1. 目标与范围

**问题**：Claude 做幻灯片时只知道用户在对话里说的话。用户手里的资料（报告、网页、数据）、做事方法（品牌规范、汇报写法）、喜欢的样子（参考页面、以前的 deck）都进不来，于是内容靠编、风格靠猜。

**目标**：给 ppt-maker 一个知识库，同时管"写什么"和"怎么做"：
- **资料**：文件、网站——事实、数据、原文。
- **Agent Skills**：做事方法与规范，直接复用 Claude Code 的 Skills 机制。
- **参考**：视觉参考（截图、设计稿、别人的 deck）、可引用的出处、以前做过的 deck。

**范围**：两层——项目级（当前目录下 `kb/`，与 `decks/` 并列，本项目所有 deck 共用）和全局（`~/.ppt-maker/kb/`，所有项目共用）。

**管理方式**：页面上的"📚 知识库"侧栏；在终端里直接对 Claude 说也可以。

**成功标准**：用户把一份 PDF、一个网页加进知识库，勾选一个品牌规范 Skill，让 Claude 做一页；这页的数字来自资料并标了出处，样式遵守 Skill。

**不做**：向量检索 / 嵌入模型、OCR、知识库的版本历史（删除只进回收站）、多人共享、自动抓取整站。

## 2. 存储与数据

```
<项目>/kb/                    项目知识库（项目目录 = deck 目录往上两层：<项目>/decks/<名字>）
~/.ppt-maker/kb/              全局知识库
  ├─ index.json               总目录
  ├─ files/<id>-<原文件名>     资料原件；Office 文件另有 files/<id>.txt（抽出的文字）
  ├─ web/<id>.md               网页正文快照（Claude 抓取后写入）
  ├─ refs/<id>-<文件名>        参考原件（同上，Office 文件另有 .txt）
  ├─ cards/<id>.md             Claude 写的卡片
  └─ .trash/<id>/              删除的条目（原件、文字、卡片）
```

**index.json**：数组，每项：
`{id, type, kind?, title, summary, status, source, sha1?, text?, note?, added}`
- `id`：`k-` 加 6 位小写字母数字。
- `type`：`file` | `web` | `ref`；`ref` 必须有 `kind`：`visual` | `cite` | `deck`。
- `status`：`pending`（等 Claude 消化）| `ready` | `failed`（`note` 写原因）。
- `source`：相对 kb 根的原件路径；网页和网址出处为 URL；旧 deck（ppt-maker 做的）为其目录的绝对路径，不复制。
- `sha1`：上传文件内容的哈希，同一范围内用于去重。
- `text`：Office 文件抽出的文字（相对 kb 根）。
- 写入：先写临时文件再替换。读不了（不是 JSON 或不是数组）时报错，**绝不覆盖**。

**卡片** `cards/<id>.md`：
```markdown
---
id: k-ab12cd
type: file
title: 2025 年度报告
source: files/k-ab12cd-年报.pdf
---
## 摘要
## 要点
## 可引用        每条带位置：- [p.12] 营收 12.3 亿，同比 +18%
## 风格          仅视觉参考与旧 deck：版式、配色、字体、结构
```

**每个 deck 的选择** `decks/<名字>/kb.json`：`{"skills": ["brand-guide"]}`——本 deck 启用哪些 Skills。知识条目默认全部可用。

**Skills**：不入库，就用 Claude Code 的位置：项目 `<项目>/.claude/skills/<名字>/SKILL.md`，全局 `~/.claude/skills/<名字>/SKILL.md`。服务端读 frontmatter 的 `name`、`description`（缺省用目录名）。

**支持的文件**：`.pdf .docx .pptx .xlsx .md .txt .csv .png .jpg .jpeg .gif .webp`，单个 ≤ 50MB，流式写盘。

## 3. 知识库面板

- 顶栏"📚 知识库"打开右侧侧栏（宽 360px，不影响编辑；画草图时与其他顶栏按钮一样不可用）。
- 标签：**资料 | 参考 | Skills**；列表分"项目"和"全局"两组；侧栏打开时每 2 秒刷新一次。
- 每条：类型图标、标题、状态（消化中 / 就绪 / 失败及原因）、一句话摘要；按钮：**卡片**（就绪后，侧栏内只读显示）、**用在这一页**、**重新消化**、**删除**（移入 `.trash/`）。
- 添加区有范围选择："项目"（默认）/"全局"。
  - 资料：选择或拖入文件；粘贴网址后"添加"。
  - 参考：先选类型（视觉参考 / 出处 / 旧 deck）；文件；网址（仅出处）；旧 deck 从本项目 `decks/` 列表中选。
- 不支持的格式、超过 50MB：提示，不添加。同一范围已有相同内容：提示"已在知识库里"。
- Skills 页：列出项目与全局 Skills，勾选框表示当前 deck 是否启用（写入 `kb.json`）。底部"新建 Skill"：一句话描述 + 范围 → 由 Claude 写出 `SKILL.md`。
- **用在这一页**：打开意图输入框（范围为整页，标签"参考《标题》"），可直接 Enter（默认文字"按这份资料更新这一页"）；意图带 `kb: [id]`。

## 4. Claude 侧

### 4.1 事件
- 添加文件 / 网址 / 旧 deck，或"重新消化"：服务端记一条 `{type:"kb", kind:"digest", scope, kb_id, text:"消化《标题》", source, extracted?, card}`（`source`/`extracted`/`card` 为绝对路径或 URL）。
- 新建 Skill：`{type:"kb", kind:"skill", scope, text, dir}`（`dir` 为对应 skills 根目录的绝对路径）。
- `kb` 事件与 intent 一样需要 ack 与回执。意图事件新增可选字段 `kb`（字符串列表）。

### 4.2 消化（`ppt.md` 规则）
- PDF、图片：直接读原件（PDF 按页读）。Office：读 `extracted` 文本；需要看版式（视觉参考、旧 deck）时再看原件。网页：抓取 URL，把正文写到 `web/<id>.md`。旧 deck：读其 `deck.html`。
- 写卡片到 `card`，然后 `python ppt/server.py --kb-done "<deck>" <scope> <kb_id> "<标题>" "<一句话摘要>"`；失败用 `--kb-fail "<deck>" <scope> <kb_id> "<原因>"`。

### 4.3 使用（`ppt.md` 规则）
- 新建 deck、处理每个意图前：读项目与全局 `index.json` 和本 deck 的 `kb.json`；读启用的 `SKILL.md` 并遵守；按意图读相关卡片，引用精确数字或原文时回到原件核对。意图带 `kb` 时优先使用这些条目。
- 用到知识库中的事实时，在该块底部加一行小字出处："来源：《标题》p.12"；用户要求时生成"参考资料"页。知识库里没有的事实不要编，在回执里说明缺什么。
- 新建 deck 或用户要求"参考某某风格"时，按视觉参考 / 旧 deck 卡片的"风格"调整 `#theme` 与版式；复用旧 deck 的页面时复制并换新 id。
- 用户在终端说"把 X 加进知识库"时，按同样的目录结构放原件、写卡片、更新 `index.json`（可用 `--kb-done`）。

## 5. 架构

```
ppt/kb.py          新：知识库读写（定位、目录、流式保存、去重、Office 抽字、回收站、Skills 列表、deck 选择）
ppt/server.py      改：/api/kb* 接口、--kb-done / --kb-fail、kb 事件、intent 的 kb 字段
ppt/kb-panel.js    新：侧栏界面（只调用接口；"用在这一页"调用编辑器的意图框）
ppt/toolbar.js     改：顶栏"📚 知识库"
ppt/editor.js      改：接入侧栏；意图可带 kb
ppt/editor.css     改：侧栏样式
.claude/commands/ppt.md  改：消化与使用规则
```
接口（都要求口令并经 Host 校验）：`GET /api/kb`、`GET /api/kb/card?scope=&id=`、`POST /api/kb/file?scope=&type=&kind=&name=`（原始字节，流式）、`POST /api/kb/add`（`{scope,type,kind?,url?,deck?}`）、`POST /api/kb/remove`、`POST /api/kb/redigest`、`PUT /api/kb/skills`、`POST /api/kb/skill`。

测试与隔离：环境变量 `PPT_PROJECT_DIR`（项目目录）、`PPT_HOME_DIR`（代替用户主目录，影响 `~/.ppt-maker/kb` 与 `~/.claude/skills`）。

## 6. 出错处理

| 情况 | 处理 |
|---|---|
| 格式不支持 / 超过 50MB | 400 / 413，面板提示，不添加 |
| 同范围内容相同的文件 / 相同网址 / 同一旧 deck | 返回已有条目，面板提示"已在知识库里" |
| Office 文字抽不出（损坏） | 条目照常加入，`note` 记原因；Claude 看原件或标记失败 |
| 加密 PDF、网页打不开 | Claude `--kb-fail` 写明原因；可"重新消化" |
| Claude 不在线 | 条目保持"消化中"；事件在 inbox 中，Claude 上线后补处理 |
| `index.json` 读不了 | 面板该组显示错误；对该范围的写操作返回 409，不覆盖原文件 |
| 没有 skills 目录 | 列表为空；"新建 Skill"照常可用 |
| 删除已被引用的资料 | 幻灯片上的出处文字保留；原件在 `.trash/` |

## 7. 测试

1. **test_server**：docx / pptx / xlsx 抽字（测试内用 zipfile 生成）；去重；格式与类型校验；流式上传与 50MB 上限（413）；各接口要求口令；网址只接受 http(s)；删除进回收站；`--kb-done` / `--kb-fail`；Skills frontmatter 解析；`kb.json` 读写；坏的 `index.json` 不被覆盖；intent 的 `kb` 字段；digest 事件字段与摘要行。
2. **e2e**：打开面板；上传 md → 消化中 + digest 事件；`--kb-done` 后显示就绪与摘要、能看卡片；重复上传提示；添加网址；参考里添加旧 deck；Skills 列表与勾选写入 `kb.json`；新建 Skill 发事件；"用在这一页"的意图带 `kb`；删除进回收站；全局 `index.json` 损坏时显示错误且文件不变。
3. **真实会话验收**（副本，验完删除）：消化一份 PDF 和一个网页；新建品牌规范 Skill 并勾选；让 Claude 基于资料做一页，检查出处与 Skill 是否遵守。
