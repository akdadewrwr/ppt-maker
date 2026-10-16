## 上一轮完成
- 合入 main：服务独立运行。server.py --detach 以脱离的进程启动（不受 Claude Code 内存回收影响），已在运行就沿用；.ppt/server.json 记 pid/port/url/token；--stop 关闭；2 小时无访问自动退出。
- --tail 启动时先输出"最近完成"（最近 10 条已完成及回执，给新会话当前情），服务停了输出"服务已停止"。
- ppt.md 和全局 ppt.md 改为 --detach 前台启动、监听停了就重挂、"服务已停止"时重启、--stop 关闭。
- main 测试：server 105 OK、selftest 99/99、e2e 171/171；实测通过 Bash 工具启动后命令结束服务仍存活。

## 关键结论
- 被关原因：整机内存几乎耗尽（16GB 剩 0.1GB），Claude Code 回收后台任务；服务本身只占 12–28MB，没有漏内存。
- 服务和 Claude 只通过 deck 目录的文件交流（inbox/outbox），服务挂在谁下面无关；监听仍是会话的后台任务。
- 监听每 5 秒探测一次服务，这也算访问，所以监听挂着时服务不会因空闲退出。

## 改动文件
- ppt/server.py、ppt/test_server.py、.claude/commands/ppt.md；~/.claude/commands/ppt.md（仓库外）

## 当前 blocker
- 无（project-2027/decks/试用 仍是旧稿复制，由用户决定）

## 下一步
- 等用户定：更多 UI 改进，或导出 pptx。
