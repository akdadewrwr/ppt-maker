---
description: 打开 ppt-maker（全局）：在浏览器幻灯片上框选/写意图/改字/画草图，操作实时回传本会话
argument-hint: <deck 名字或主题>
---
ppt-maker 的程序装在 `{{PPT_HOME}}`（下称 PPT_HOME）。deck 属于当前项目：放在**本会话当前工作目录**下的 `decks/<名字>/`（下称 DECK）。

1. 先用 Read 读取 `{{PPT_HOME}}/.claude/commands/ppt.md`，按其中的全部说明执行，参数：$ARGUMENTS。它会让你再读共用规则 `prompts/ppt-common.md`，即 `{{PPT_HOME}}/prompts/ppt-common.md`。
2. 这两份说明里的路径这样换算：
   - `ppt/…` → PPT_HOME 下的绝对路径，例如 `{{PPT_HOME}}/ppt/server.py`。只用它运行命令。
   - `decks/<名字>` → 当前工作目录下的 `decks/<名字>`。先用 `pwd` 确认当前目录，再把 DECK 写成绝对路径。
   - 除了第 1 步的这两份说明，PPT_HOME 里什么都不读、不列目录（它的 `decks/` 是开发用的测试稿，与当前项目无关）；新 deck 由服务自己从模板新建。
3. 命令示例（`<cwd>` 换成 `pwd` 的结果）：
   - 启动服务：`python "{{PPT_HOME}}/ppt/server.py" --detach "<cwd>/decks/<名字>"`
   - 关闭服务：`python "{{PPT_HOME}}/ppt/server.py" --stop "<cwd>/decks/<名字>"`
   - 监听：`python "{{PPT_HOME}}/ppt/server.py" --tail "<cwd>/decks/<名字>"`
   - 回执：`python "{{PPT_HOME}}/ppt/server.py" --reply "<cwd>/decks/<名字>" <id> "<说明>"`
