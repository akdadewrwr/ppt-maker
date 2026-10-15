## 上一轮完成
- 知识库审查修复完成：分支 feat/kb（3b28ba6，已推送，尚未合并）。测试：server 82 OK、selftest 99/99、e2e 145/145。
- 新需求的头脑风暴进行中：①多处修改先放进待发清单再一起发送 ②导入以前做过的 HTML。用户已回答需求问题；"批量提交"那段设计已给出，等用户确认。

## 关键结论
- 知识库修复：
  - 上传在锁外流式写入；index.json 写入遇到 Windows 占用时会重试；
  - Office 抽取出错不会弄坏上传，抽出的文字有上限；
  - digest 只指向知识库内、http(s) 网址或本项目的 deck；条目 id 会校验；
  - 新增 --kb-add 命令；画草图时侧栏让开；焦点在侧栏里时按键不作用到幻灯片。
- 延后的小问题：M2、M3、M6–M9（见 ledger 摘要：坏条目返回 500、Office 页序和工作表名、PUT 的连接重置、kb 回执只在终端里、勾选与刷新的竞争、若干边界情况）。
- 新需求的已定方向：
  - 批量：待发清单，Enter 立刻发送、Ctrl+Enter 加入清单，清单非空时 Enter 也加入清单；跨页；有总体说明；作为 kind:batch 一次发送。
  - 导入：其他工具/AI 生成的幻灯片、普通网页、旧 ppt-maker deck 都要支持；尽量还原原样。

## 改动文件
- ppt/kb.py server.py editor.js editor.css test_server.py tests/e2e.mjs ppt.md

## 当前 blocker
- 等用户：feat/kb 是否合并；批量提交那段设计是否通过。

## 下一步
- 讲导入 HTML 那段设计 → 写 spec → 写 plan → 执行。
