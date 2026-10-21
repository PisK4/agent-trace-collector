# AGENTS.md — Archived Agent Notes

本目录是冻结的历史快照。仅允许三类动作：把完整的 implemented 文件整篇移入、在 `Status: implemented` 行正下方插入 `Archived: YYYY-MM-DD`、重录 [manifest.json](manifest.json)。封存之后永不编辑、重排版、更新、移动或删除，也不得当作现行行为的权威——现行行为的权威在代码与活动文档里。活动文档可以在有意引用历史时链接进来。

归档判据与操作步骤见[上层 README](../README.md#归档与删除)。校验命令：`node scripts/verify-archived-agent-notes.mjs`（封印新产物加 `--write`）。

manifest.json 损坏时，校验与 `--write` 都拒绝运行——封印账本不自动重写。恢复优先从 git 取回上一版（`git checkout -- .agents/notes/archived/manifest.json`）；仓库还没有提交时可以直接删除后用 `--write` 重封。
