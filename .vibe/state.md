## 上一轮完成
- Codex 接入（子项目 7）计划 7 个任务全部完成，分支 feat/codex 已推送；真实 Codex（codex exec）冒烟通过。
- skill 已装到 ~/.agents/skills/ppt；全局 ~/.claude/commands/ppt.md 已改为同时读 prompts/ppt-common.md。

## 关键结论
- Codex 沙箱：能启动常驻服务；外网要 network_access=true；工作区外写入要 writable_roots（目录须已存在，--install-codex 会建 ~/.ppt-maker）。
- 冒烟：e1 改标题+回执、.ppt/agent=Codex、历史"Codex 处理 #e1"、--idle 停止正常；一轮约 41k token。

## 改动文件
- ppt/server.py、ppt/test_server.py、ppt/editor.js、toolbar.js、sketch.js、kb-panel.js、tests/e2e.mjs
- prompts/ppt-common.md（新）、codex/skills/ppt/SKILL.md（新）、.claude/commands/ppt.md

## 当前 blocker
- 无。整分支审查已修完（--wait 发现正常停止的服务、页面 6 处名字、skill 要求每条事件都回执）；server 157 OK、selftest 99/99、e2e 197/197。

## 下一步
- 用户已实测 Codex/Claude 两边都没问题；~/.codex/config.toml 已加 windows.sandbox / network_access / writable_roots。
- 等用户确认合并 feat/codex → main（合并后在 main 跑全部测试、推送、删分支）。
