## 上一轮完成
- 分支 fix/restart-on-code-change：服务发现自己的 Python 代码更新后，换新代码自动重启，网址不变
- 新增 4 个测试；全套通过：服务端 169、svgpath 12/12、e2e 210/210（第一遍 X 导出中改稿一项超时，重跑通过，判为机器慢）

## 关键结论
- 只看 server.py、exporter.py、importer.py、kb.py；页面脚本和模板本来每次请求都从磁盘读
- 文件要连续两次检查不变且能编译才重启，防止保存到一半或语法错误把服务弄停
- 重启间隙 server.json 带 restarting 标记，30 秒内 --tail 不报停止，--detach / --stop 会等新进程起来
- 页面断线时会排队、恢复后补发，重启那几秒不丢修改
- 未解决：已打开的页面仍是旧脚本，需刷新才换新

## 改动文件
- ppt/server.py、ppt/test_server.py、.vibe/state.md

## 当前 blocker
- 无；已提交到分支，等用户同意合并

## 下一步
- 测试通过后问用户是否合并到 main
- 之后：修行内小标签导出；feat/api-runner 真实 key 测试后合并
