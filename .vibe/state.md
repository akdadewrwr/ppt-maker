## 上一轮完成
- feat/clear-done 已快进合并到 main 并推送，分支本地+远端已删
- main 上全部测试通过：server 157/157、selftest 99/99、e2e 198/198

## 关键结论
- 顶栏"✓ 清除标记"一键关掉所有绿色已完成框（含清单各条），排队/处理中保留，存 localStorage ppt-dismissed
- Codex 接入（子项目 7）已在 main，用户实测无问题
- 合并流程：在 main 上 `git merge --ff-only <branch>`，跑全测试，push，删分支

## 改动文件
- ppt/toolbar.js、ppt/editor.js、tests/e2e.mjs

## 当前 blocker
- 无

## 下一步
- 等用户新需求
- 可选：4 个延后 minor（游标损坏回退 0、Claude 入口缺 PDF 提示、每次轮询全量读 inbox/outbox、--install-codex 覆盖无提示）
- 可选：导出期间改稿那条 e2e 偶发失败，改成更稳的等待
