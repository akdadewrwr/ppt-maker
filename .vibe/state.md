## 上一轮完成
- brainstorming：已确认目标=自用→开源；先做 Claude Code
## 关键结论
- 愿景：/ppt 打开本地 HTML 幻灯片；用户在页面上选区/画框/打字表达意图 → 回传 Claude/Codex 会话 → agent 改 HTML；可挂知识库；最终 HTML→pptx 脚本
- 核心原则：把用户隐性知识对齐为显性指令；不造新 agent，复用 Claude/Codex
- 拆成 5 块：①幻灯片编辑页 ②页面↔会话桥 ③生成能力 ④知识库 ⑤导出 pptx
- 建议先做最小闭环：①+②（选区+意图 → 会话 → 改 HTML → 页面刷新）
- 成功标准：先自用做完真实 PPT；之后开源到 GitHub，各人本地安装使用（需易装、跨平台、无云端）
- 第一版只接 Claude Code（后台监听唤醒会话）；回传层预留以后接 Codex
- 幻灯片结构=A：固定 16:9 画布 + 细网格（16×9 方格，80px），块按格跨行列，可嵌套子网格；导出时读 getBoundingClientRect 转坐标
- v1 输入：框选+文字意图（附选区截图）+ 直接改字；手绘草图放 v2
- 回传=方案1：Python 标准库本地服务 → .ppt/inbox.jsonl → Claude Code Monitor 唤醒；页面 SSE 自动刷新
- 第 1 节架构已确认：deck.html 纯内容（服务端注入编辑层）；server.py 零依赖；改字带版本号防冲突；v1 不做知识库/导出/草图
- 第 2 节格式已确认：section.slide/div.block 固定 id；grid-area 定位；颜色字体只用 #theme 变量；真文字；单文件离线
- 第 3 节流程已确认：server.py 三模式（serve/--tail/--reply）；inbox.jsonl 事件含 slide/cells/blocks/text/shot；回执气泡可反问；改字带版本号存回
- 第 4 节已确认：心跳显示在线/离线；断线暂存补发；页面 lint 事件（溢出/重叠/id）最多自动修 2 次；冲突按块 id 重放；127.0.0.1+随机口令+Host 校验+路径限制
- 仓库：git@main → https://github.com/akdadewrwr/ppt-maker.git
## 改动文件
- .vibe/state.md；git init + 首次推送
## 当前 blocker
- 等用户确认设计第 5 节（测试），之后写 spec
## 下一步
- 分段设计（1架构 2数据格式 3事件流 4错误处理 5测试） → 写 spec → writing-plans
