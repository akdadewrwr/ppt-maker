## 上一轮完成
- 已合并并推送 main（9a2d442）：Enter 重开修复、导入表格 0×0 修复、SVG 插图导出为可编辑形状、数字圆圈首行缩进修复、"服务已停止"误报修复
- 已删除合并完的分支和 ppt-maker-svg 工作目录；只剩 main 和 feat/api-runner

## 关键结论
- main 全套测试通过：服务端 165、路径解析 12/12、e2e 210/210
- 真实稿子实测：试用 4 页 0 张图片、5 张插图都是可编辑组合；技术立项的数字圆圈不再盖住文字（首行缩进 28px）
- 导出原来不会主动退出文字编辑，已改为导出时先退出
- 整体审阅被用户停掉，没有完成

## 改动文件
- ppt/export.js、ppt/exporter.py、ppt/editor.js、ppt/importer.py、ppt/server.py、ppt/test_server.py、tests/e2e.mjs、tests/svgpath.test.mjs、docs/guide.html、prompts/ppt-common.md

## 当前 blocker
- 无；PowerPoint 打开是否弹"修复"提示需用户确认

## 下一步
- 用户在 PowerPoint 里验收导出（插图可改字和颜色、圆圈位置）
- feat/api-runner：用真实 key 测 llm 后端后合并，合并时 README 补一句插图可编辑
