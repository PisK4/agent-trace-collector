# Agent Note: 派生判定收进 derive-decision 内核

Status: implemented

## Problem

两条派生路径的四个阶段判定各存一份：前驱结算（同步 `matchPredecessor` 对切片 `finishRoleWork`）、主链角色（`assignChainRoles` 对 `assignRoleStep` 加根选取 SQL）、工具配对（`pairToolCallsTx` 对 `pairRequestTools`）、标题与折叠行摘要（`writePresentationTx` 对 `summaryStep`）。切片侧的注释自己承认是「逐条复刻同步路径」；对齐靠三张外部安全网——parity 测试、capacity 脚本里两份列清单一致的哈希函数、注释自律。改一次判定要同步四处加测试；漂移已经发生过两次（主链根选取漏掉父节点不可比的行、aux 标题覆盖依赖注释写在正确位置），都靠人工发现后手工补齐。

## Decision

新增 `src/derive-decision.ts` 作为判定内核：两条路径的「怎么判」只有一个家，同步路径（`derive.ts`）与切片路径（`derive-slice.ts`）退化为两个写 adapter——一个写 `request` 列，一个写代际表。搬进内核的判定：

- 关系：`settleRelation`（扫描状态到关系/父节点/增量的唯一出口）与 `matchPredecessor`（内存扫描形态，切片侧仍自带分页扫描，只把结算交给内核）；
- 主链 trunk：`chainTrunkRoot` 与 `chainTrunk`（遍历序第一个无可比父节点的参与请求是根，根的可达集是主链）；
- 工具配对：`initialPairState` 与 `pairOutcome`（多候选 → 结果必须更晚 → 顺序可证 → resolved 终态 → pending 保留首见位置的完整阶梯）；
- 展示：`presentationDecision` 加 `PresentationPorts` 端口（标题请求 → 正文不可读 → 增量非空 → 增量为空 → 关系未知的分支顺序）；
- 连同两条路径共用的协议抽取（`anthropicReplyCalls`、`anthropicRequestResults`、`flattenToolContent`）与文本判定（`deriveTitle`、`previewOf`、`clip`、`replyToolSummary`、`toolResultPreviewOf`）一并归位。

随判定收敛做的两处结构修正：切片角色阶段收尾时按内核结果一次写全组 `in_trunk`（取代逐页从父行继承——继承的等价性靠「父行一定更早」这个隐含前提，现在不需要前提）；同步路径在调用方的 branch→unknown 修补并入 `settleRelation` 的 `unreadableEarlier` 输入。`compareSequence` 删除：它没有生产调用方，行为是 `matchPredecessor` 的特例，其测试同步移除。

语义与判据本身不变：关系取值、根判据、配对阶梯、展示分支的每条规则与此前逐条一致；[切片等价](../feature/2026-10-22-atc-slice-equivalence.md)的逐行对照测试保留，[切片链角色](../feature/2026-10-22-atc-sliced-chain-roles.md)记录的根判据现在是内核的唯一实现。两个算法号（`GROUP_ALGORITHM` 与 `DERIVE_ALGORITHM`）保持分开：判定共用了，算法号仍区分结果是谁算的、写在哪张表。

## Alternatives considered

**维持两份实现，靠 parity 测试对齐。** 测试只能发现已经发生的漂移，不能阻止漂移；每次判定改动仍然要求人工同步四处，而正确性最敏感的恰恰是这些判定。现状的两次漂移都走到「测试或验收发现问题、人工回补」这一步，成本已经付过。

**切片路径改调同步引擎的分段函数。** 切片的分页、游标与预算是为容量目标设计的（单步一个事务、可续跑、事件循环让位）；把它压回整组内存计算等于放弃切片的存在理由。分页扫描保留，共享的只是结算与判定。

**内核放进 `derive.ts`，沿现有共享 helpers 的位置。** `derive.ts` 已经同时是同步引擎与共享读取层，再承担判定会让一个文件背三个角色；独立模块让「判定只有一个家」在目录层面可见，也避免切片为了拿判定而 import 整个同步引擎。

## Consequences

- 改判定只动 `derive-decision.ts` 一处；两条路径的一致性由结构保证，parity 测试从「对齐手段」降级为「回归网」。
- 切片角色阶段的写入形状变化：收尾事务一次写全组 `in_trunk`（每行一列），角色传播每页少一半写；长组的收尾事务与同步路径整组重算同量级，仍在单事务预算内。
- `matchPredecessor` 新增第四参 `unreadableEarlier`；`near` 字段保留，但除测试断言外没有消费方，后续若界面要「最接近的一支」再接。
- capacity 脚本的两份哈希函数仍是跨模式对照工具：它们比较的是两条路径的**产物**，判定收敛后依然成立，不因内核而删除。
