## 上一轮完成
- 知识库（子项目 4）：spec、plan、4 个 task 全部实现，分支 feat/kb（到 3ad6784，已推送）。
- 测试：server 72 OK、selftest 99/99、e2e 142/142。真实会话验收通过（临时项目，验完删除；没有写进用户主目录）。
- 草图分支已合并到 main（a0d493b）。
- 整个分支的最终审查已派出：opus 审查员在后台运行。

## 关键结论
- 知识库分项目级（<项目>/kb）和全局（~/.ppt-maker/kb），资料由 Claude 消化成卡片，用 --kb-done / --kb-fail 更新目录。
- Skills 复用 Claude Code 的 .claude/skills；每个 deck 在 decks/<名字>/kb.json 里勾选启用。
- 页面有"📚 知识库"侧栏（资料 / 参考 / Skills）。"用在这一页"发出的意图带 kb 字段。
- ppt.md 新规则：消化、写 Skill、使用资料（出处小字、不编造、按风格卡片调整）。
- 测试和验收用 PPT_PROJECT_DIR / PPT_HOME_DIR 隔离，不碰真实知识库。

## 改动文件
- ppt/kb.py（新）、ppt/kb-panel.js（新）、server.py、editor.js、toolbar.js、editor.css、test_server.py、tests/e2e.mjs、ppt.md；kb 的 spec 和 plan

## 当前 blocker
- 等审查结果：Critical / Important 问题先用 TDD 修完，再问用户是否合并。

## 下一步
- 修完审查发现的问题，列出全部 Ruling 和延后的小问题，问用户是否合并；之后是 UI 改进、导出 pptx。
