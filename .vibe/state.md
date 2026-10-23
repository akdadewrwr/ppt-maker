## 上一轮完成
- 在 feat/api-runner 上修完 review 的 8 个 minor（各自先红后绿），已推送到 GitHub 的 feat/api-runner；未合并 main（用户要求先不合并）
- 新增 docs/api-runner.md：两种后端的用法、接口要求、返回 JSON 格式、校验规则、agent 接入约定与示例、参数表；guide 2b 节加了链接
- 新增 README.md（项目简介、需要、三种快速开始、文档、目录、测试）
- runner 49/49、server 158/158；agent 后端命令行冒烟再次通过

## 关键结论
- M2 写前再比对文件，变了就不写、回执请用户再说（读和替换之间仍有极小窗口，要彻底需服务端锁）
- M3 复用 importer.kill_tree；M4 Ctrl+C 时一并结束 agent；M5 提示里补上等待后才到的事件
- M6 写之前再 ack 一次本事件，撤销标签不再标错；同批多次写之间等 watcher 记成各自一步
- M7 整个请求一个截止时间 + 32MB 上限；M8 stderr 不是 UTF-8 时按系统编码解；M10 spec 改为测试在 ppt/test_runner.py
- llm 后端读写 deck.html 改为按原始字节，CRLF 稿子不被改换行

## 改动文件
- ppt/runner.py、ppt/test_runner.py、docs/superpowers/specs/2026-10-22-ppt-maker-api-runner-design.md、docs/api-runner.md（新）、README.md（新）、docs/guide.html

## 当前 blocker
- llm 后端只对假接口测过，还没用真实 API key 跑过

## 下一步
- 用户用自己的 key 实测 llm 后端；用户同意后再合并 main
