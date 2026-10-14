## 上一轮完成
- 子项目 1（核心闭环）6 个任务 + 最终审查修复全部完成，分支 feat/core-loop 已推送
## 关键结论
- 测试：21 个 unittest、selftest 14/14、浏览器脚本检查 32/32、端到端 7 项（本会话扮演 Claude 端）全部通过
- 审查修复：队列丢事件、刷新冲掉输入、坏事件卡死 --tail、离线改字跨重启丢失、保存时泄漏外部 DOM/粘贴 HTML
- 口令改为按 deck 持久化（.ppt/token），重启 URL 不变
- 延后的小问题 7 条（见最终回复）；M6 双击改字需用户确认
## 改动文件
- ppt/{server.py,test_server.py,template.html,geom.js,selftest.html,editor.js,editor.css,vendor/}
- .claude/commands/ppt.md, .gitignore, spec（口令持久化、轮询）
## 当前 blocker
- 等用户选择：合并 main / 开 PR / 保留分支
## 下一步
- 用户重启 Claude Code，在本仓库跑 `/ppt <名字>` 实际试用
