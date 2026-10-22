## 上一轮完成
- Codex 接入（子项目 7）已合并到 main 并推送，feat/codex 分支已删除（本地+远端）。
- 用户实测：交互式 Codex `$ppt` 和 Claude `/ppt` 都正常。

## 关键结论
- main 上：server 157 OK、selftest 99/99、e2e 197/197。
- Codex 需要 ~/.codex/config.toml 的 windows.sandbox / network_access / writable_roots（已为用户加好）；skill 在 ~/.agents/skills/ppt（改 codex/skills/ppt 后重跑 --install-codex）。

## 改动文件
- 无（合并）

## 当前 blocker
- 无

## 下一步
- 延后的次要问题 4 条：游标文件损坏时多打印一次、Claude 入口缺 PDF→Read 提示、轮询全量读、重装覆盖本地修改。
- 候选：更还原的 pptx 导入（用户实测暂够用）。
