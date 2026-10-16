## 上一轮完成
- 子项目 6（导出 / 导入 PPTX）：spec、plan、6 个 task 全部完成，分支 feat/pptx（到 ec19515，已推送）。
- 测试：server OK、selftest 99/99、e2e 182/182。真实验收通过（临时项目，验完已删除）。
- opus 最终审查：1 严重、7 重要、约 13 次要。严重和重要的全部用 TDD 修完，另将中文字体一条提升为重要（c9cb83d）。修后 server OK、selftest 99/99、e2e 189/189。

## 关键结论
- 导出流程：export.js 在页面里测量，再 POST /api/export，由 exporter.py（python-pptx）生成文件。
  - 文字、框、表格、图片、形状、箭头导出为原生可编辑对象；SVG、渐变、阴影、图标等截成 2 倍图。
  - 生成后自动下载并弹出报告；终端导出用 --export（无头 Edge 打开 export=1 的页面）。
- 导入流程：importer.py 拆出 slides.json、media/，再用 LibreOffice 转出 slides.pdf，发 hint:pptx 的 import 事件，由 Claude 按 ppt.md 重建。
- 执行中的决定（Ruling）：
  - 文本框跟随块的内容宽度，单行文字不自动换行；
  - 列表文本框扣掉项目符号的缩进；
  - 取不到的图片在截图时用透明占位；
  - 主题的系统色取实际颜色值；
  - 另有几处只涉及测试的修正。

## 改动文件
- ppt/export.js（新）、ppt/exporter.py（新）、importer.py、server.py、editor.js、toolbar.js、test_server.py、tests/e2e.mjs、ppt.md；spec 与 plan

## 当前 blocker
- 等用户决定是否合并 feat/pptx；~/Downloads 里有之前 e2e 留下的 e2e-smoke-*.pptx，等用户决定是否删除。

## 下一步
- 合并（git push . feat/pptx:main，在 main 上跑全部测试）。延后的次要问题：WebP 图片、测量出错不回退为图片、隐藏文字也被导出、同一秒导出撞名、SmartArt 类型名等。
