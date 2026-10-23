## 上一轮完成
- fix/flaky-export-e2e 已快进合并 main 并推送，分支本地+远端已删
- main 上：server 158/158、selftest 99/99、e2e 198/198

## 关键结论
- 导出 e2e 偶发失败已改稳：用 sessionStorage 记录"导出完成"提示，不再赌 1 秒窗口
- Claude 用 --install-claude + `/ppt`，Codex 用 --install-codex + `$ppt`；使用指南在 docs/guide.html

## 改动文件
- tests/e2e.mjs

## 当前 blocker
- 无

## 下一步
- 等用户新需求
- 可选：4 个延后 minor（游标损坏回退 0、Claude 入口缺 PDF 提示、每次轮询全量读 inbox/outbox、--install-codex 覆盖无提示）
