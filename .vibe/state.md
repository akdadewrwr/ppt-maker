## 上一轮完成
- 已合并推送 main：服务发现自己的 Python 代码更新后自动换新代码重启，网址不变（96f3b3c）
- 已合并推送 main：README 和截图、动图、录制工具从 feat/api-runner 带过来（c9c1aaa）

## 关键结论
- 全套测试通过：服务端 169、svgpath 12/12、e2e 210/210（第一遍有一项超时，重跑通过）
- main 上的 README 去掉了 runner 部分，加了"插图可编辑"；docs/api-runner.md、prompts/ppt-llm.md 和 runner 的设计/计划留在分支
- 合并前已启动的服务没有监视功能，要重启一次才会生效
- 以后开发放在单独的工作目录，否则每次保存都会让用户的服务重启
- 已打开的页面仍用旧脚本，需刷新

## 改动文件
- ppt/server.py、ppt/test_server.py、README.md、docs/media/*、tools/readme-media.mjs、tools/frames_to_gif.py

## 当前 blocker
- 无

## 下一步
- feat/api-runner 用真实 key 测试后合并；合并时 README 会冲突，要把 runner 部分加回去
- 修行内小标签导出（边框和底色丢失）
- 可选：代码更新后页面提示刷新
