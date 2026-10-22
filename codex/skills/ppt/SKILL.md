---
name: ppt
description: 打开 ppt-maker：在浏览器幻灯片上框选/写意图/改字/画草图，操作回传本会话由你修改 deck。用户输入 $ppt <deck 名字或主题> 时使用。
---
ppt-maker 的程序装在 `{{PPT_HOME}}`（下称 PPT_HOME）。deck 属于当前项目：放在**本会话当前工作目录**下的 `decks/<名字>/`（下称 DECK）。

## 路径
- 先确认当前工作目录，把 DECK 写成绝对路径。
- 共用规则里的 `ppt/…` 指 PPT_HOME 下的文件，例如 `{{PPT_HOME}}/ppt/server.py`，只用来运行命令；`decks/<名字>` 指 DECK。
- PPT_HOME 里只读 `{{PPT_HOME}}/prompts/ppt-common.md`，别的都不读、不列目录（它的 `decks/` 是开发用的测试稿，与当前项目无关）。
- 下面命令里的 `python` 不存在时用 `python3`；路径一律加引号。

## 启动
1. 名字取 `$ppt` 后面的文字（去掉 `/\:*?"<>|`）；为空就问用户。
2. 读 `{{PPT_HOME}}/prompts/ppt-common.md`（处理事件、知识库、deck 格式规则），之后全部照做。
3. 启动服务：`python "{{PPT_HOME}}/ppt/server.py" --detach "<DECK>"`。几秒内返回；服务是独立进程，你的命令结束后它继续运行。把输出里的网址告诉用户。输出"已从模板新建"时，按名字（及对话中已有信息）写 3–6 页初稿，遵守格式规则。
4. 告诉用户："我会一直监听浏览器里的操作；想直接跟我说话就按 Esc，说完让我继续监听即可。15 分钟没有操作我会自动停下，你说"继续"就恢复。"
5. 进入监听循环。

## 监听循环
- 第一次（以及每次用户让你继续时）：`python "{{PPT_HOME}}/ppt/server.py" --wait --recent --agent Codex "<DECK>"`
- 之后每次：`python "{{PPT_HOME}}/ppt/server.py" --wait --agent Codex "<DECK>"`
- 这条命令会一直等到浏览器里有需要处理的操作才返回，可能要等很久，这是正常的：耐心等它结束，不要中途杀掉或换别的命令。
- 返回后，按共用规则处理输出的每一行（先 `--ack`，改完 `--reply`；`最近完成 …` 只是前情，不要重做；`edit` 行只说明用户改过什么，下次改文件前重新读）。处理完立刻再运行 `--wait`。
- 输出含"已停止监听"：告诉用户已停止监听、说"继续"就恢复，然后结束这一轮，**不要**再运行 `--wait`。
- 输出含"服务已停止"：重新执行启动第 3 步，把新网址告诉用户，再回到循环。
- 用户按 Esc 打断后说了别的事：照做；做完问一句是否继续监听。用户说继续时用 `--wait --recent` 重新进入循环。
- 用户要关掉 ppt：`python "{{PPT_HOME}}/ppt/server.py" --stop "<DECK>"`，不再监听。

## Codex 沙箱
命令被拒（`blocked by policy`）、网页抓不到、或全局知识库 `~/.ppt-maker` 写不进去时，告诉用户在 `~/.codex/config.toml` 加上下面几行后重开 Codex（`python "{{PPT_HOME}}/ppt/server.py" --install-codex` 也会打印这段，并建好 `~/.ppt-maker`）：

```toml
[windows]
sandbox = "unelevated"

[sandbox_workspace_write]
network_access = true
writable_roots = ["<用户主目录>/.ppt-maker"]
```

`windows.sandbox` 是 Windows 上运行任何命令都需要的；`network_access` 用于知识库里的网页资料和从网址导入；`writable_roots` 用于全局知识库。没加后两项时，这些功能失败要在回执里说明原因，其余照常。
