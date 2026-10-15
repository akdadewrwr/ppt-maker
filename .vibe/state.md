## 上一轮完成
- 新建全局命令入口 C:/Users/user/.claude/commands/ppt.md（不在仓库里），在任何目录下都能用 /ppt。
- 另一个 session 找不到 /ppt 的原因：它不是在 ppt-maker 目录下启动的（项目命令只从启动目录的 .claude/commands 加载）。

## 关键结论
- 全局入口只做转发：读取仓库里的 .claude/commands/ppt.md 并照做，路径一律用 PPT_HOME 绝对路径；deck 统一放在 PPT_HOME/decks/。规则只维护仓库里这一份。
- 入口里写死了本机路径。开源时应改成插件或安装脚本，这是以后的事。
- 在 ppt-maker 目录下，项目级和用户级的 /ppt 同名，两者都能用。

## 改动文件
- C:/Users/user/.claude/commands/ppt.md（新，仓库外）；.vibe/state.md

## 当前 blocker
- 等用户在另一个 session 里试用草图功能的反馈；feat/sketch 尚未合并。

## 下一步
- 根据试用反馈修改，或者合并后进入知识库子项目。
