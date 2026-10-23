## 上一轮完成
- 新增 `server.py --install-claude`：写全局 `~/.claude/commands/ppt.md`（模板 claude/commands/ppt.md，填入本仓库路径），建 ~/.ppt-maker
- 新增使用指南 docs/guide.html（已写入 --install-claude 步骤）
- 已合并 main 并推送；server 158/158、selftest 99/99、e2e 198/198（重跑）

## 关键结论
- Claude：先 --install-claude，任意目录 `/ppt <名字>`；Codex：先 --install-codex + 改 config.toml，`$ppt <名字>`
- 同一 deck 一次只开一边
- "导出时改稿等导出完再刷新"这条 e2e 偶发失败，重跑即过，又出现一次

## 改动文件
- ppt/server.py、ppt/test_server.py、claude/commands/ppt.md（新）、docs/guide.html（新）

## 当前 blocker
- 无

## 下一步
- 等用户新需求
- 建议：把那条偶发失败的导出 e2e 改成更稳的等待
- 可选：4 个延后 minor
