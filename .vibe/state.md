## 上一轮完成
- 设计修复（分支 feat/local-new）：server.py 启动时若 deck 不存在，自己从 ppt/template.html 新建（ensure_deck），只写本项目；ppt.md 启动步骤改为先启动再写初稿，Claude 不读 ppt/、不找别处旧稿；全局 ppt.md 同步。测试 server OK、selftest 99/99、e2e 169/169。
- 修复：新会话 /ppt 试用 复制了 PPT_HOME/decks/试用 的旧稿 → ppt.md 启动第 2 步和全局 ppt.md 都写明：新 deck 一律从模板开始，不读 PPT_HOME/decks（f83a2ad）。
- 子项目 5（批量提交 + 导入 HTML）已合并到 main 并推送；分支 feat/batch-import 已删除。
- 审查发现的 4 条重要、6 条提升的次要都已修复；延后的两条小问题（M7 存储写不进时导入回执反复弹出、M13 清单逐键重写）也已修复。
- main 上测试：server 99 OK、selftest 99/99、e2e 169/169。

## 关键结论
- 清单面板里打字时，内容先放在内存里，停顿 400ms 后才写入存储；离开页面（pagehide）时立即写入。
- 已经弹过的导入回执，在内存里也记一份，存储写不进时也只弹一次。
- editor.js 里，启动时就会读到的变量必须用函数声明或 var（已经踩过两次 TDZ）。
- 已知小问题（来自知识库）：index 里非对象条目返回 500、PUT 会重置连接、kb 回执只显示在终端等。

## 改动文件
- ppt/editor.js、tests/e2e.mjs（本轮）

## 当前 blocker
- 等用户同意合并 feat/local-new；project-2027/decks/试用 仍是旧稿复制（服务已停），由用户决定留或删。

## 下一步
- 等用户定下一步：UI 改进（用户说过以后再做），或者导出 pptx。
