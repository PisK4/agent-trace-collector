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

## 验证

**`list.param` 是分组键，展示文案放 `label`。**
- 证据：2026-11-02 方向 A 第 5 步第一版把 `param` 传成 `${name} 的调用`，对组永不命中、失败数恒 0；测试直接传 meta 测不到这条装配路径，真实后端同样中招，靠合成数据 curl 对比抓到。
- 防护：改 `summaryList` 的取数后，用合成页面 curl 对比 chip 与页头计数；参数摘要从 `arg_path`/`arg_skill` 读，不从 `param` 反解。
- Seen 1× (2026-11-02).

## 已晋升到常备规则

暂无。晋升后的条目在这里保留一行规则名、日期与证据锚点；规则正文只在它的新家。