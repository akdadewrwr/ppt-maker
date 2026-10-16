## 上一轮完成
- 审查延后的次要问题全部修完（分支 feat/pptx-minors，80d98fd 及 ppt.md 补充），server OK、selftest 99/99、e2e 194/194；等用户同意合并。
- 子项目 6（导出 / 导入 PPTX）已合并到 main 并推送，分支 feat/pptx 已删除。
- main 上测试：server OK、selftest 99/99、e2e 189/189；e2e 不再往 ~/Downloads 写文件。
- 已删除 ~/Downloads 里 13 个 e2e-smoke-*.pptx。

## 关键结论
- 导出流程：页面里的 export.js 测量，POST /api/export，exporter.py（python-pptx）生成。
  - 文字、框、表格、图片、形状、箭头导出为原生对象，其余截成图片。
  - 终端用 --export；自动导出时不下载，失败原因写进 export.json。
- 导入流程：importer.py 拆出 slides.json、media/，LibreOffice 转出 slides.pdf，发 hint:pptx 的 import 事件，Claude 按 ppt.md 重建。
- 取图片最多等 5 秒；截图跳过还没加载完的图片；自动导出最多等 3 秒字体就绪。

## 改动文件
- ppt/export.js、exporter.py、importer.py、server.py、editor.js、toolbar.js、test_server.py、tests/e2e.mjs、ppt.md

## 当前 blocker
- 无

## 下一步
- 合并 feat/pptx-minors（git push . feat/pptx-minors:main，在 main 上跑全部测试）。
