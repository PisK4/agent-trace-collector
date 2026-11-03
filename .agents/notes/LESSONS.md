# 工作教训

本仓库的代码由 Agent 写、审、提交。这里记录在本仓库反复踩的工作方式错误：规则、证据与可执行防护。改代码前先读与本次改动相关的章节。

这里不是决策记录。为什么这样设计、否决了什么，写进[Agent Note](README.md)；单次缺陷的完整复盘写进 bug-fix note；每个会话都要遵守的稳定规则写进根 [AGENTS.md](../../AGENTS.md)。一条教训稳定成测试、脚本或常备约定后，从正文删除并迁入对应家；本文件末尾只保留一行迁移指针与证据锚点。

当前维护方式是任务收尾自检，没有夜间 review。非平凡任务结束前，把本次踩到、下次还会踩的坑追加一条；同一坑再次出现，在 Seen 行补日期。同一规则在三个不同日期出现，或防护已经变成测试、脚本、常备约定，就晋升。

## 条目格式

**一句话祈使句规则。**
- 证据：commit、文件与行、日期，说明当时错在哪。
- 防护：可执行动作，命令、测试或检查项。
- Seen N× (日期列表).

## 派生与版本

**升算法号时，容忍窗口与测试钉子一起动。**
- 证据：2026-11-01 Hermes 修复把 `PURPOSE_VERSION` 7 升到 8、`GROUP_ALGORITHM` 6 升到 7、`DERIVE_ALGORITHM` 10 升到 11；容忍窗口漏移会把前一代工具事实误判为未知，全量套件靠两处测试钉子抓出漏改。
- 防护：升号后 grep `algo ===`，再 grep 测试里的 `GROUP_ALGORITHM).toBe`；位置包括 `src/semantics.ts`、`src/derive/state.ts`、`src/queries/session-summary.ts` 的两处窗口、`tests/session-summary.test.ts` 与 `tests/derive-slice.test.ts`；合并前跑全量 `bun test`。
- Seen 1× (2026-11-01).

## Worktree 与提交

**新 worktree 先软链主检出的 `node_modules`，再把软链写进该 worktree 的 `info/exclude`。**
- 证据：2026-10-25 新建 worktree 后 `tsc --noEmit` 找不到 `@types/bun`，因为 worktree 没有 `node_modules`；仓库 `.gitignore` 只写 `node_modules/`（目录模式），软链不匹配，会以未跟踪文件出现。
- 防护：`ln -s <主检出>/node_modules node_modules`；在 `git rev-parse --git-dir` 下的 `info/exclude` 追加一行 `node_modules`，目录不存在时先 mkdir。
- Seen 1× (2026-10-25).

**合并被并行会话的在途文件挡住时，定向 stash 该文件、合并、再 pop，不整库 stash、不代提交。**
- 证据：2026-11-03 合并 fix/websearch-subevent-cards 时，主检出里另一个会话对同一 note 文件有未提交的 F26 修复记录，`git merge` 以 "local changes would be overwritten" 拒绝；分支改动（F31/F32 状态行）与在途改动（F26 段落）分处同一文件不同段落。
- 防护：`git stash push -m <说明> -- <path>` → `git merge --no-ff` → `git stash pop`；pop 前确认两批编辑不在同一行段。整库 stash 会把对方所有在途文件一起卷走。
- Seen 1× (2026-11-03).

## 验证

**`list.param` 是分组键，展示文案放 `label`。**
- 证据：2026-11-02 方向 A 第 5 步第一版把 `param` 传成 `${name} 的调用`，对组永不命中、失败数恒 0；测试直接传 meta 测不到这条装配路径，真实后端同样中招，靠合成数据 curl 对比抓到。
- 防护：改 `summaryList` 的取数后，用合成页面 curl 对比 chip 与页头计数；参数摘要从 `arg_path`/`arg_skill` 读，不从 `param` 反解。
- Seen 1× (2026-11-02).

**门禁报红先确认文件是否属于本批改动，再判断是否自己引入。**
- 证据：2026-11-03 全量 `verify:notes` 在 `.agents/notes/implemented/feature/2026-11-03-live-session-activity-and-navigation.md` 报 implemented 格式错，该文件是并发会话尚未跟踪的迁移中途产物；本批改动在 `--staged` 与 `--range` 两处均通过。同一轮还有 7 个历史批次真的缺 note，不能因为存在并发文件就全部当成误报。
- 防护：报红文件先跑 `git ls-files <path>`，输出为空说明未跟踪、归并发会话；本批范围单独跑 `node scripts/verify-change-notes.mjs --range origin/master..HEAD`；历史缺口逐批看提交信息里有没有 `Agent-Note: none`。
- Seen 1× (2026-11-03).

## 方案与回填

**预测重派生/判据变更的效果前，先查存量行的 `body_state` 与 `purpose_version` 分布。**
- 证据：2026-11-03 WebSearch 子事件方案立项时推断「version bump 后 64 张 conv 卡会被新判据收走（bypass）」；落地时只读核查发现 69 个 conv 行全部 `body_state='pending'` 且已存 `purpose_version=10`，正文不可读走 `unavailableDecision` 的 retained 保留，新判据根本执行不到，69 键 rebuild 是无效果写库。新判据只对 `purpose_version` 为空的新行生效。
- 防护：任何「bump/重派生会翻转存量行」的结论，先用只读 SQL 按 `(body_state, purpose_version, purpose_status)` 分组数一遍；retained 优先于新判据是设计行为，不是 bug。
- Seen 1× (2026-11-03).

## 已晋升到常备规则

暂无。晋升后的条目在这里保留一行规则名、日期与证据锚点；规则正文只在它的新家。