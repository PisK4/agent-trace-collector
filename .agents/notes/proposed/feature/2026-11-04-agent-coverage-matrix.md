# Agent Note: 本地 Agent 覆盖矩阵与分批适配器路线

Status: proposed

## Problem

`src/sources/catalog.ts` 列了 Magpie 的 19 个本地会话 Agent，只有 `agent`、`sourceKind`、`format`、`status` 四列。目录骨架能防注册表漂移，但回答不了接下一家时要先查什么：本机到底有没有数据、格式能不能还原逐笔调用、有没有上游解析器可核对、与网关侧证据会不会重复建行。交接文档建议按 Qoder、Grok、WorkBuddy 的顺序接，这个顺序没有写出判据，也没说明为什么 Hermes 有 4,778 笔请求却不在第一批。

覆盖广度是这个开源项目的入口，但解析器数量不等于覆盖质量。没有真实样本支撑的适配器会把「已支持」写进报告，却无法验收。第一版适配器提案已在[本地 Agent 会话适配器](2026-11-04-agent-session-adapters.md)里定了范围，[覆盖护栏](../../implemented/feature/2026-11-04-coverage-foundation.md)补了目录与调度底座，两者都没有给出 19 家的逐家现状与接入顺序。

## Proposal

新增 `docs/agent-coverage.md`，作为「覆盖状态」这一事实的家。它承载三件事：

1. 三个口径分开：有适配器、本机有数据、已入库。用生产库的 `source_cursor`、`request`、`request_evidence` 聚合与本机只读扫描说明三者可以两两不同。
2. 19 家逐家矩阵：目录 status、本机数据规模、生产库覆盖、Magpie `internal/sessions/` 下的解析器参照、接入批次。目录 status 与实测有出入处以矩阵为准，但不改 `catalog.ts` 的 status，避免把一次快照写进代码。
3. 分批路线与每批完成条件：判据按「有真实数据、能还原逐笔调用、与已实现适配器同构、不需要先解决跨来源去重、有上游解析器可核对」排序。

本轮不写适配器代码，不改 `registry.ts` 与 `SourceKind`，不动生产服务。DSH 全量回填收敛的读数按轮次追加到 `docs/acceptance.md`，不改旧结论。

分批结论（依据见矩阵正文）：

| 批次 | Agent | 前置条件 |
| --- | --- | --- |
| A | WorkBuddy、Grok | 无；两家有真实会话文件且格式可还原调用 |
| B | Qoder、CodeBuddy | 先侦查 Qoder 调用数据的真实根目录；CodeBuddy 复用批次 A 的 buddy 解析 |
| C | Hermes、OpenCode | 先落地多来源同一调用的身份归一；OpenCode 等本机有会话库 |
| 不排期 | qoder-cn、cline、cursor、alma、kimi、agy | 等本机出现真实数据 |

一次一家、一次一个 worktree 分支，不把三家合并成一个分支。理由是格式差异大：WorkBuddy 是 message 行加 subagents 子目录，Grok 是一个会话多个文件且用量只在会话级累计，Qoder 的 segment 日志里几乎没有模型调用。合并成一个分支会让三种失败模式互相遮挡。

Qoder 被排到批次 B 而不与 A 同批，来自只读扫描：`~/.qoder/logs/sessions` 的 118 个 segment 共 1,154 条事件，只有 1 个文件含 `model.request.started`，没有 assistant 回复与逐笔用量；`~/.qoder/projects` 的 8 个会话目录里只有 1 个 22 KB jsonl，10 行是会话骨架与一条 `hi` 用户消息，同样没有 assistant 回复。Magpie 的 `qoder.go` 只做目录定位，调用解析走 `ccFiles("qoder", QoderDir("qoder"))` 复用 Claude Code 的 `projects` 形状。两处根都只有骨架，先写解析器只能读出空窗口，得先确认调用记录落在哪个文件。

Hermes 排在批次 C 且前置去重，来自生产库对账：4,778 笔请求全部由 hook、账本、路由三种网关侧证据构成，本地 `.hermes` 有 205,607 个文件却没有本地游标。补一个本地解析器会把同一批调用第二次送进库。

## 与 Wake 的关系

Wake 的 Agent 清单与扫描分层用作路线参照，不照搬它的覆盖判定。ATC 已有 SQLite 库与读取架构，[覆盖护栏](../../implemented/feature/2026-11-04-coverage-foundation.md)已否决再建一套索引。Wake 值得借的是「廉价发现、按需解析、单家失败不拖垮全局」的分层，以及 `detect()` 由根目录派生、`list_session_files()` 只做廉价枚举这类可执行契约。Wake 的 24 项进 `ALL` 就配 adapter 与契约测试，是单层结构；ATC 把目录状态与解析能力分成两层，让「本机有这家、但还没接」可见。具体源码证据与差异点写进 `docs/agent-coverage.md` 的对标节。

## Alternatives considered

**直接按交接文档接 Qoder、Grok、WorkBuddy 三家。** 顺序没有判据，Qoder 的 segment 日志里几乎没有调用数据，先接会得到一个永远读不出 request 的适配器。本轮先把 19 家的现状与格式差异摊开，再按证据排顺序。

**把矩阵塞进 `catalog.ts` 的注释或 `docs/architecture-design.md`。** 前者会把一次本机快照写进代码，且 19 行表格撑爆文件头；后者承载的是已实现适配器的现行行为，不适合放待接来源的批次与快照读数。一个事实一个家，覆盖状态单独成文。

**把 19 家全部实现一遍，用数量换覆盖。** 六家在本机没有根目录也没有真实样本，写出来的解析器只有合成 fixture，无法做真实流量验收，还会把「已支持」写进报告。第一版提案已否决这条路。

**先做 `source-health` 自动计算覆盖，再排批次。** 自动检测要有稳定的契约与版本签名，属于[数据源契约漂移检测](2026-11-04-source-contract-drift.md)的后续工作。本轮用一次人工只读测量把路线定下来，自动检测随后补上，不互相阻塞。

**按 Magpie 的解析器有无来排优先级。** Magpie 19 家都有 `.go` 解析器，但本机有没有数据、格式能不能还原调用才是 ATC 能否验收的前提。上游参照只是核对材料，不是判据。

## Acceptance criteria

- `docs/agent-coverage.md` 存在，19 家逐行可查，三个口径与生产库、本机扫描的读数一致。
- 分批路线写出判据、每批前置条件与不排期的原因；Wake 对标节有可核对的源码位置，且写清 ATC 两层结构与 Wake 单层结构的差别。
- `docs/acceptance.md` 按轮次追加 DSH 回填收敛读数，旧结论不改写。
- `docs/architecture-design.md` 与 `docs/README.md` 有指向覆盖矩阵的入口链接，不复制矩阵内容。
- 本轮不改 `src/` 下任何代码，`bun test`、`bun run typecheck` 与 `bun run verify:notes` 在有代码改动时才跑；纯文档改动按门禁说明记录豁免理由。

## Risks

- 读数是一次快照，文件数、字节数与 request 数会随使用增长。矩阵写明采集日期与「重新测量」，但读者仍可能直接引用过期数字；`source-health` 落地前靠人工更新。
- Qoder 的两处根（`~/.qoder/logs/sessions` 与 `~/.qoder/projects`）都只有会话骨架，调用记录的真实落点尚未确认。批次 B 的侦查可能得出「本机没有可读的调用数据」，那时 Qoder 要降为不排期。
- Grok 的逐笔用量不可得，只能按会话累计摊或留 null。若按累计摊，会与 droid 的 `session_usage` 口径一致，但单笔 request 的用量列为 NULL，页面读数与其它来源不同。
- Wake 对标依赖外部检出的当前版本；`repos-external/` 不动内容，版本变化时对标节的源码位置要重新核对。
- 本轮没有新适配器落地，覆盖广度没有增加；交付的是路线与现状，不是可用的解析器。
