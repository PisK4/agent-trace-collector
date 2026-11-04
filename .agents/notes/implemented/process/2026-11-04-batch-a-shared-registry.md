# Agent Note: 批次 A 共享登记面先铺，供两家适配器并行

Status: implemented

## Problem

批次 A 要并行接 WorkBuddy 与 Grok 两家本地会话适配器。两家的实现各自独立，但登记面有五个共享文件：`src/sources/files.ts` 的 `SourceKind`、`src/sources/session/types.ts` 的 `SessionKind`、`registry.ts` 的 `SESSION_ADAPTERS`、`catalog.ts` 的两行、以及 `tests/catalog.test.ts`。两个 Agent 各建 worktree 各自改这五个文件，第二次 `--no-ff` 合并必然冲突；`SourceKind` 这种类型联合更容易合并成只剩一家的形状。

## Decision

先建 `feat/session-batch-a-base` 作为两家分支的共同基线，把共享登记面一次铺好：

- `SourceKind` 与 `SessionKind` 各加 `grok_session`、`workbuddy_session`。
- `registry.ts` 登记两个最小占位 adapter：`adapters/grok.ts` 与 `adapters/workbuddy.ts` 的 `discover` 恒返回空，`read` 返回 `unchanged`，不解析任何会话。占位只为让基线能编译、注册表数组有合法成员，生产不会跑到这个分支。
- `catalog.ts` 两行填 `sourceKind` 并标 `implemented`。
- `tests/catalog.test.ts` 不改：它断言注册表里每个适配器都有 `implemented` 条目，基线已满足。

两个实现分支以本分支为基线，各自只替换自己那家的占位文件、写专属读取辅助、窄测试与自己的 Agent Note，不碰共享文件。生产部署、合并、对账与验收由主线程串行做。

## Alternatives considered

**两个 Agent 各自改共享文件，合并时解冲突。** 五处冲突集中在两行登记上，且 `SourceKind` 联合容易被解成只剩一家；解冲突的人要重新核类型，返工比先铺基线大。

**准备分支只改类型联合，registry 与 catalog 留给两家分支。** 占位 adapter 不存在时 `registry.ts` 的 import 会让基线编译不过，两家分支都从红基线起步，分不清失败是不是自己引入。

**不并行，一家一家串行。** 零冲突但放弃并行度；Pis 已选定三段式并行。

## Consequences

- 收益：两家实现可以同时在各自 worktree 里写解析与测试，共享文件零冲突；基线 `bun test` 1258 pass / 0 fail、`bun run typecheck` 退出 0。
- 代价：基线短暂把两家标成 `implemented`，而占位实现不解析会话。这个分支不合并进 master、不部署生产，两家分支会立刻替换占位；主检出看到 `implemented` 时，两个适配器都已是真实实现。
- 多一个准备分支与一次提交；两个实现分支都要从它切出，合并顺序由主线程定。

## Related

- [覆盖矩阵与分批路线](../../proposed/feature/2026-11-04-agent-coverage-matrix.md) 定批次 A 的范围与完成条件。
- [落地方案在 worktree 分支里做](2026-10-28-implementation-worktree.md) 定 worktree 与 `--no-ff` 合并规则。
