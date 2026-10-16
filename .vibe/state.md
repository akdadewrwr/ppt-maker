## 上一轮完成
- 合入 main：新 deck 由 server.py 从自带模板新建（ensure_deck，只写本项目；只有启动服务才新建）；ppt.md 改为先启动再写初稿，Claude 不读 ppt/、不找别处旧稿；全局 ppt.md 同步。
- 修复 UI："+形状"菜单文字竖排 → .ppt-menu 加 width: max-content。
- main 测试：server OK、selftest 99/99、e2e 171/171；分支 feat/local-new 已删。

## 关键结论
- #ppt-ui 宽度为 0：没写宽度的 .ppt-abs 弹出层会缩成一字一行；新弹出层要给宽度或 max-content（格式工具条已检查，正常）。
- 只有启动服务会新建 deck；--tail/--reply 等遇到不存在的 deck 仍报错。

## 改动文件
- ppt/server.py、ppt/test_server.py、ppt/editor.css、tests/e2e.mjs、.claude/commands/ppt.md；~/.claude/commands/ppt.md（仓库外）

## 当前 blocker
- 无（project-2027/decks/试用 仍是旧稿复制，由用户决定留或删）

## 下一步
- 等用户定：更多 UI 改进，或导出 pptx。
