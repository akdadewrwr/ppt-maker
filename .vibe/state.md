## 上一轮完成
- 按用户要求修改全局 /ppt（C:/Users/user/.claude/commands/ppt.md，仓库外）：deck 改为放在当前会话工作目录下的 decks/<名字>/，程序和模板仍从 ppt-maker 读取。
- 验证过：deck 放在仓库外时服务正常（页面、编辑脚本、/api/state 都返回 200，.ppt 运行时目录建在 deck 旁边）。

## 关键结论
- deck 跟着项目走：在哪个目录启动 Claude Code，deck 就建在那里的 decks/ 下；在 ppt-maker 目录下用效果不变。
- 全局入口只做转发：读取仓库里的 ppt.md，ppt/… 换成 PPT_HOME 绝对路径，decks/… 换成 cwd 下的绝对路径。

## 改动文件
- C:/Users/user/.claude/commands/ppt.md（仓库外）；.vibe/state.md

## 当前 blocker
- 等用户在另一个 session 里试用草图功能的反馈；feat/sketch 尚未合并。

## 下一步
- 根据试用反馈修改，或者合并后进入知识库子项目。
