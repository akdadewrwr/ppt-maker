## 上一轮完成
- feat/api-runner 完成并推送：runner.py（agent / llm 两种后端）、test_runner.py、prompts/ppt-llm.md、guide 2b 节
- opus 整分支 review：1 Critical + 4 Important + M1（升级）全部 TDD 修复；runner 42/42、server 158/158；agent 后端真实命令行冒烟通过

## 关键结论
- 校验与找页改用 html.parser（注释、引号内的值、实体编码、`/` 分隔属性、`//` 开头网址都绕不过）；页面里有没闭合的标签 / 注释，或有 <style>/<textarea> 等，一律拒绝
- 报错正文先去掉 key 再截断；Windows 上 os.replace 被占用时重试
- 延后 minor：M2 写入窗口竞态、M3 kill_tree 重复、M4 POSIX Ctrl+C、M5 等待间隙到达的事件、M6 撤销标签、M7 请求总超时、M8 stderr 编码、M10 测试文件位置

## 改动文件
- ppt/runner.py、ppt/test_runner.py、prompts/ppt-llm.md（新）；docs/guide.html；spec + plan

## 当前 blocker
- llm 后端只对假接口测过，还没用真实 API key 跑过

## 下一步
- 问用户是否合并 main（合并后在 main 上跑全部测试、推送、删分支）
- 建议用户用自己的 key 实测一次 llm 后端
