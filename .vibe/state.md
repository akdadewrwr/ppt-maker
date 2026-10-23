## 上一轮完成
- feat/api-runner 上：README 加了截图和动图（hero、intent.gif、sketch.gif、batch、export，放 docs/media/），由 tools/readme-media.mjs 从真实编辑器录制，可重跑
- 录制时发现并修了页面 bug：选中块后在输入框按 Enter 发送，输入框会立刻重新弹出（e2e 新增检查，先红后绿，199/199）
- 之前：runner 8 个 minor、docs/api-runner.md、README 已推送；未合并 main

## 关键结论
- 录制脚本用自己的临时稿子和端口 8810，agent 一侧由脚本代替（README 里写明了），不需要 API key
- GIF 由 tools/frames_to_gif.py（Pillow，仅开发用）合成，宽 960，每个约 270–300KB
- Enter 重开的根因：发送时输入框已被移除，页面键盘处理判断不出它来自面板；改为忽略已脱离页面的输入框的按键

## 改动文件
- ppt/editor.js、tests/e2e.mjs、README.md、tools/readme-media.mjs（新）、tools/frames_to_gif.py（新）、docs/media/*（新）

## 当前 blocker
- llm 后端只对假接口测过，还没用真实 API key 跑过

## 下一步
- 用户看 README 效果；用自己的 key 实测 llm 后端；同意后合并 main
