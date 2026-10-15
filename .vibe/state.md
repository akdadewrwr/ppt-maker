## 上一轮完成
- 知识库已合并到 main（1c5f1a3）。
- 子项目 5（批量提交 + 导入 HTML）：spec、plan、5 个 task 全部实现，分支 feat/batch-import（到 e0b021f，已推送）。
- 测试：server 92 OK、selftest 99/99、e2e 163/163。真实会话验收通过（临时项目，验完删除）。
- opus 最终审查：0 严重、4 重要、9 次要；4 重要 + 6 条提升的次要全部 TDD 修完（4657007）。server 99 OK、selftest 99/99、e2e 166/166。

## 关键结论
- 待发清单：Enter 立刻发送，Ctrl+Enter 或"加入清单"放进清单，清单非空时 Enter 也加入清单；页面上有编号标记；侧栏可改、可删、可定位，有总体说明；一次发送成 intent kind:batch；state 把 batch 展开成 e#-i。
- 导入：.html / .htm / .zip / 网址；importer.py 安全解压并判断类型（ppt-maker / slides / page）；/imports 加 CSP sandbox；回执在页面弹出一次，附"打开原稿"链接；新增 --import 命令。
- Ruling：
  - batch() 改为函数声明（原写法会触发 TDZ）；
  - 没有声明编码的原稿按 utf-8 提供（否则中文乱码）；
  - 弹出层放在提示框之上（回执提示框挡住了导入对话框）；
  - 另有几处 e2e 测试的修正。

## 改动文件
- ppt/importer.py（新）、ppt/batch-panel.js（新）、server.py、editor.js、toolbar.js、editor.css、test_server.py、tests/e2e.mjs、ppt.md；spec 与 plan

## 当前 blocker
- 等用户决定是否把 feat/batch-import 合并到 main。

## 下一步
- 合并（git push . feat/batch-import:main，在 main 上跑全部测试）；延后：M7 回执重复弹、M13 清单逐键重写；之后 UI 改进、导出 pptx。
