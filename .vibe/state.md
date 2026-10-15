## 上一轮完成
- 2a 完成 + 最终审查修复（C1 撤销丢 Claude 写入、负网格线拖动塌缩、Escape 卡改字模式、标题无法取消加粗），已推送 feat/basic-editing-2a
## 关键结论
- 测试：34 个 unittest、selftest 37/37、浏览器检查 61/61；真实会话验收：直接改色→edit 事件；问 Claude→修改；撤销 Claude 修改→undo 事件且不改回；重做
- 新功能：顶栏（撤销/重做/+文字/+页/−页/状态）、单击选中+浮动栏、拖动/拉伸吸网格、字色字号BIU对齐、背景/边框/圆角/阴影、改字模式内选字格式、Delete/Enter/Ctrl+Z
- 修了 2 个实现中发现的 bug：端口占用时 server_close 崩溃；工具栏文本框抢焦点导致 Delete 无效
- 试用服务因系统内存不足被 Claude Code 停掉，未自动重启（需要时再启动，URL 不变）
## 改动文件
- ppt/{server.py,test_server.py,ops.js,geom.js,selftest.html,toolbar.js,editor.js,editor.css}、tests/e2e.mjs、.claude/commands/ppt.md、spec
## 当前 blocker
- 等用户选：合并 main / 开 PR / 保留分支
## 下一步
- 合并后 → 2b（形状/箭头/图标/图片）计划
