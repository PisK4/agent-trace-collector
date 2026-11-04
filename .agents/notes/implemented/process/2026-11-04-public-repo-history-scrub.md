# Agent Note: 开源前清理本机痕迹并重写公开历史

Status: implemented

## Problem

仓库在 GitHub 上是 public，`master` 已推送。跟踪文件与历史里有四类不该对外的东西：

- **绝对家目录路径。** `docs/acceptance.md`、`docs/operations.md`、`docs/superpowers/plans/`、五篇 note 与三个测试夹具写进了本机家目录前缀，pickaxe 命中 12 个以上 commit。
- **真实会话标识。** README 图注与六篇 note 引用了七个真实会话 UUID，另有截短形式散落在验收记录与测试注释里。
- **单笔请求用量指纹。** 验收记录里带了具体 req 号与精确 token 数，体检 note 带了本机日志路径与真实模型标题。
- **本地隐藏引用。** `refs/codex/turn-diffs/*` 三条引用持有 `.intent/` 快照，其中 `events.jsonl` 是 intent hook 抓到的真实用户请求原文。这些从未进过分支，但 `git push --mirror`、bundle 或误推 `refs/codex` 会把它带出去。

`.gitignore` 只覆盖数据库、日志与 `.intent`，`.zcode/`（含个人 plan 文件）、`.claude/`、`.archify/`、`*.token`、`redaction.salt` 都没有兜底，`git add -A` 会误提交。

会话 UUID 与请求号本身不能反查正文。但它们是本机使用痕迹，与可公开的架构决策无关，留着的唯一作用是把个人使用画像挂在公开仓库上。

## Decision

分两步：先把 tip 清干净并提交，再定向重写 `master` 全历史。

**tip 清理**按敏感类型分别处理，不做一刀切遮蔽：

- 测试夹具的家目录前缀改成 `/Users/example`，路径形状不变，断言不需要改。
- 文档正文里的本机路径改成占位符（`$HOME`、`/path/to/agent-trace-collector`、`<worktrees>`、`<tmp>`）。
- 体检 note 的 `file://` 绝对链接改成仓库内相对路径（`../../../..`），链接重新可用。
- 七个真实会话 UUID 各映射到一个互不相同的合成 UUID。逐一映射而不是统一替换，是为了保住「不同会话是不同键」这一语义。
- 验收记录里的 req 号掩成 `req #`，精确 token 数改成约数，七类求和的等式仍然成立。
- README 图注去掉会话 ID 与「真实会话」表述，只描述画面内容。
- `.gitignore` 补本机工具目录、`data/`、`*.token`、`redaction.salt`。

**历史重写**用 `git filter-repo --refs master --replace-text`，只处理 `master`。替换规则按前缀长短排序，先命中本仓绝对路径这类长前缀，最后用 `/Users/<user>` 兜底成 `/Users/example`。UUID 与用量指纹用字面量逐条替换。

**不动面**：83 个本地分支和三个 worktree 一律不重写。`atc-demo-scenario` 上有并行会话的在途暂存改动，全量重写的风险大于收益。

`refs/codex/turn-diffs/*` 直接删除引用，再 `reflog expire --expire=now` 加 `gc --prune=now`，让对象真正离开本地库。

## Alternatives considered

- **全新单 commit 历史。** 最彻底，代价是丢掉 575 个 commit 的开发过程。这类过程史正是仓库对外价值的一部分，否决。
- **只清新提交、历史留着。** 公开侧旧 commit 永久可访问，`/Users/<user>` 一直能被 pickaxe 挖出来。这等于没处理，否决。
- **连 83 个分支一起重写。** 名义上更干净，实际会碰在途 worktree 的暂存区与分支基线。这些分支不推送，风险大于收益，否决。
- **统一替换所有 UUID。** 会破坏「不同会话不同键」的唯一性语义，换成互不相同的合成值才对。

## Consequences

- **旧分支合并前必须 rebase。** 本地分支的祖先仍是旧历史（含家目录路径）。直接合进 `master` 会把敏感历史带回公开侧。这是本次最需要守的纪律。
- **所有 SHA 变化。** 任何基于旧 SHA 的引用（issue、外部笔记、本地 checkout）失效。
- **强推的残留窗口。** GitHub 侧旧对象短期内仍可能按 SHA 访问，缓存与镜像的清理不由仓库控制。没有 fork、没有 star，影响面限于作者自己。
- **worktree 不受影响。** 三个 worktree 分支仍指向旧基线，功能代码完整；它们后续合并时按上一条 rebase。
- **备份已删除。** 重写前的 mirror 与在途补丁先放 `~/atc-oss-backup-20261104`，验证通过后按指示删除。删除前逐项核对过替代副本：两篇未跟踪 note 与 `.zcode/` 在原位，`LESSONS` 在途改动与备份补丁一致。旧历史仍可从 83 个本地分支的祖先取回，那是现在唯一的旧历史副本，也是上一条约定的由来。

## Testing

- `git grep '/Users/<user>'`、真实 UUID 正则、`<model> · <time>` 在跟踪文件里零命中。
- `bun test tests/body-view.test.ts tests/trace-view.test.ts tests/derive-presentation.test.ts tests/trace-anchor.test.ts` 105 通过、0 失败：夹具改动只碰路径字符串，断言不变。
- 重写后在 mirror 上复查：`master` 全历史 `git grep` 同样零命中，`refs/codex` 已消失。
