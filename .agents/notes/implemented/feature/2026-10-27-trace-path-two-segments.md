# Agent Note: 中栏文件路径显示末两段

Status: implemented

本篇是显示层决策，不涉及后端、schema 与派生。它改写[pretty-trace 工具行摘要](2026-10-24-pretty-trace-tool-summary-and-tint.md)里「文件类参数一律 basename」这一条，其余摘要规则与配色由那篇继续拥有，两记录互相链接。

## Problem

中栏工具行只显示文件名，同名文件并列时无从分辨。用户实测反馈：连续几条 `Read` 行分别显示 `semantics.ts`、`claude.ts`、`omp.ts`、`request-purpose.ts`、`harness-purpose.test.ts`，跨目录的同名文件（`src/harness/*.ts` 与 `tests/*.ts`）在扫读时被压成同一形状，要逐条悬停才能确认读的是哪个。

本机库实测（`tool_call.arg_path`，2026-10-27 快照，4,569 条）：同一会话内按文件名去重，61 个会话共撞车 174 次；折成末两段后降到 54 次，末三段 13 次。

## Decision

`web/trace-view.js` 的 `baseName` 从「取最后一段」改为「取末两段」，即 `父目录/文件名`。所有文件类参数共用这一个折算点：Read/Edit/Write 的 `file_path` 与 `path`、以及未知工具回退链里的 `file_path`/`path`。完整路径仍进悬停 title 与右栏，行内不做字符数截断，超长由列宽省略号处理。

单一分段路径（`AGENTS.md`）原样显示，不补斜杠。仓库根文件显示成 `agent-trace-collector/AGENTS.md`——倒数第二段是仓库名而不是文件名，这是纯后缀折算的直接结果，不是特例。

会话汇总折叠区的路径 chip 保持现状：那里已有「同名 basename 并列时补一段」的按需逻辑（`web/session-view.js` 的 `pathLabel`），chip 空间比中栏行更窄，固定两段会更早触发省略。

## Alternatives considered

**固定末三段。** 区分度最高（同会话撞车 13 次），但会带上仓库名：`agent-trace-collector/src/harness/semantics.ts`。中栏行宽有限，多出的一段几乎总是同一个仓库名，付出列宽却换不到区分度。落选。

**改后端带出 cwd，显示项目相对路径（`src/harness/semantics.ts`）。** 这是最符合直觉的形态，但前提不成立：`raw_hook.cwd` 覆盖率实测 claude 66%、omp 与 zcode 全 0%，且 71% 的 `file_path` 不落在 cwd 之下（worktree 场景）。读模型 `RequestRow`/`RequestDetail` 本就不带 cwd，要接入就得改读模型契约、投影与查询，换来的仍是同一列两种口径。会话内路径公共前缀的可用率只有 19.9%，也不能替代 cwd。落选。

**只在同名冲突时补一段（沿用 `pathLabel` 的做法）。** 改动最小，但要窗口上下文，且每行宽度不一致，扫读时行首参差。落选。

## Consequences

同一会话内的路径歧义减少约七成，代价是行首多两段路径文本，长路径更早触发列宽省略号；完整路径的可得性不变，仍在悬停与右栏。`src/` 这一层被折掉，`src/harness/x.ts` 与 `tests/harness/x.ts` 仍可区分，但 `src/a/x.ts` 与 `tests/a/x.ts` 之外的更深同构路径要靠悬停。这是纯显示折算，不改变任何派生事实。

## Testing

`bun test tests/trace-view.test.ts tests/web.test.ts tests/trace-pair.test.ts tests/session-summary.test.ts`（79 项）与 `bun run typecheck` 通过（2026-10-27）。覆盖：Read 四种区间组合、Edit 含与不含 replace_all、Write、OMP 小写 read/write/edit、未知工具回退链、单段路径不补斜杠、仓库根文件取到仓库名、调用行预览与结果行前缀及悬停摘要的路径形态。
