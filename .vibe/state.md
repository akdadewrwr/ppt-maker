## 上一轮完成
- 新功能：改字模式下选中文字 + 右键 → 只改这段（quote 字段，不截图）；已推送 feat/core-loop
- 事故：测试脚本误删 decks/试用，已从上次通知内容恢复（URL/口令/e1 回执都在）；脚本已改为只删自己的 smoke 目录
## 关键结论
- 测试：24 个 unittest、浏览器检查 35/35；（此前）21 个 unittest、selftest 14/14、浏览器脚本检查 32/32、端到端 7 项（本会话扮演 Claude 端）全部通过
- 审查修复：队列丢事件、刷新冲掉输入、坏事件卡死 --tail、离线改字跨重启丢失、保存时泄漏外部 DOM/粘贴 HTML
- 口令改为按 deck 持久化（.ppt/token），重启 URL 不变
- 延后的小问题 7 条（见最终回复）；M6 双击改字需用户确认
## 改动文件
- ppt/{server.py,test_server.py,template.html,geom.js,selftest.html,editor.js,editor.css,vendor/}
- .claude/commands/ppt.md, .gitignore, spec（口令持久化、轮询）
## 当前 blocker
- 用户正在试用 /ppt 试用（本会话服务+监听运行中）；之后再选合并方式
- 选字交互维持现状（先双击进改字模式再选字+右键），用户确认不改
## 下一步
- 用户重启 Claude Code，在本仓库跑 `/ppt <名字>` 实际试用
