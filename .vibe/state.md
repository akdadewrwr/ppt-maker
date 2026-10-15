## 上一轮完成
- 2b 已快进合并到 main（38eaff1）并推送，2b 分支已删除；合并后测试全绿。
- 修完 6 个延后的小问题和 2a 的撤销标签时序问题：分支 fix/2b-minors（4d7850f，已推送，尚未合并）。
- 测试：server 47 OK、selftest 78/78、e2e 98/98。

## 关键结论
- 没有 id 的对象：只能选中，拖动、微调、删除都会提示"等 Claude 补上 id"。
- geomOf 缺 px 尺寸时，按计算尺寸和中心点推算（旋转后不再变大）；也认 turn/rad/grad 单位。
- 静态响应加了 nosniff；改字时插入对象会先退出改字模式；在面板里按 Esc 能关闭面板。
- 撤销标签：取上次快照之后 outbox 里最近 ack 或回复的事件，回执来得比快照早也能标对。
- 修了 e2e 里两条从未真正测到东西的检查：b-cover-sub 被回复气泡盖住，改为在 b-p3-sub 上测，并先确认已进入改字模式。

## 改动文件
- ppt/editor.js geom.js toolbar.js server.py；ppt/selftest.html test_server.py；tests/e2e.mjs

## 当前 blocker
- 等用户决定 fix/2b-minors 是否合并到 main。

## 下一步
- 合并后进入下一个子项目：手绘草图（先 brainstorming → spec）；之后是知识库 → 导出 pptx。
