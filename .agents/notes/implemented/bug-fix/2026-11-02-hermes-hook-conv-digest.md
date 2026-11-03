# Agent Note: Hermes 会话身份归类——hook 失败调用的 conv-digest 归组

Status: implemented

## Problem

### 背景：Hermes hook 失败调用落成孤儿会话

Hermes 通过 magpie hook 上报请求时，请求头里没有 session 字段。成功调用会有 response id，ATC 可以按 response id 关联到账本与路由；失败调用（客户端断开、超时、HTTP ≥400）没有完整回复因此没有 response id，hook 行无法与账本侧配对。

这类 hook-only 行在落库时走既有路径：session 缺失 → 路由 conv 缺失 → 退回 `["hook", hookId]` 作为 conv_key，actor 为空。会话列表按 conv_key 聚合，结果就是每个失败 hook 各自成为一个独立的孤儿会话，actor 显示为未知。

影响体现在列表、详情和计数三个层面：

- 列表显示「（无标题）· 归属未知 · 1 笔」，四个标题候选全部依赖 `derive_queue` 的 `conv_key + actor` join，join 不上就只能回退到 model_time。
- 点进去看到的"多条"其实是 1 笔失败请求携带的全部历史消息（样例 req 65497 有 95 条）整段铺开，不是多次独立调用。
- 账本侧同时还有一行「缺正文」记录（同一请求，≤241 ms 内存在），会话计数因此多算一笔。

### 规模

生产库只读检查（2026-11-02）：Hermes 共 506 个会话，其中 63 个是这类 hook-only 孤儿；63/63 全部是失败调用；63/63 在 ≤241 ms 窗口内有账本侧对应行（即存在"缺正文"的账本双胞胎）。其余 443 个会话正常。

### 与既有记录的关系

已在活动 note 树做 supersession check，不取代任何既有决定：

- [hermes-auxiliary-session-noise.md](../../proposed/bug-fix/2026-11-01-hermes-auxiliary-session-noise.md) 持有视觉辅助调用误列与技能包装修复，其 Proposal 明确"首轮不改会话键、不新增持久化父子关系"，与本文机制不重叠。
- [empty-session-identity-migration](./2026-10-27-empty-session-identity-migration.md) 已交付，解决的是 Hermes hook 空串 session 规范化为缺失的问题；本次 hook 请求头里根本没有 session 字段（不是空串），属于新缺口。
- [hermes-purpose-recognition](../feature/2026-10-27-hermes-purpose-recognition.md) 与本文无关。

## Decision

实现提交：`9629a57` feat(hook): group hook requests by first-content digest when session is absent。回归测试在 `tests/hook-identity.test.ts`。

只对新数据生效，不含存量回填。

### hook 落库时自算会话摘要

ATC 在接收 hook envelope 时，从请求消息中取首条 `role:"user"` 元素，按其 JSON 字节（使用与既有 magpie 会话口径一致的序列化方式）计算 SHA-256，取前 12 字节的十六进制表示，加 `magpie-` 前缀得到会话摘要。

这个摘要的口径与上游 magpie 原生的 `conversationID` 一致——magpie 本身就是用首条 user 消息的指纹做会话归组。因此两个使用相同首条 user 消息的会话在 magpie 看来本来就是同一会话；这里只是把这个归组依据显式化。

摘要算得出时：

- `conv_key` 落成 `["conv", "magpie-<digest>"]`，与同一会话的路由行归入同一组。
- `conv_source` 新增值 `conv-digest`，用于区分归组依据是自算摘要而非上游直接给出的 conv。

摘要算不出时（请求没有 user 消息、user 消息为空数组、或请求正文 partial 到无法提取——如 req 65497、68123），保持现状 `["hook", hookId]`，不退回时间近邻或任何猜测。

### 不改变既有物理合并逻辑

现有按 `response_id_norm` 将 hook 行并入账本目标请求的逻辑保持不变；不新增按时间窗的匹配规则；不改 `mergeHookInto`。摘要归组只影响 hook 行自身的 conv_key 选择，不影响 hook 与账本之间的关联路径。

归组后，同组内的标题派生按现有 `derive_queue` 逻辑自然恢复（conv_key 与路由行对齐后，`conv_key + actor` join 就能命中），不需要在 hook 侧再做标题推断。

### 明确不做（各一句理由）

- **不做 ±250 ms 时间窗启发式配对。** 并发下候选不唯一，规则会持续 pending、无法证伪，等于失效。
- **不新增任何 UI 标记。** 不加「正文(推断)」角标、不改 pill 语义、不做悬停解释——UI 层不感知归组依据。
- **不改 magpie 本体、不改 hook 插件。** 上游已经有 conversationID 的口径，本次只是在 ATC 侧复现它；跨进程改动成本远高于 ATC 侧自算。
- **不做存量回填。** 63 条旧孤儿保持现状——回填需要显式迁移入口（如同已交付的空 session 迁移），且本次只针对新数据；新数据自然生效，旧数据不会再新增同类孤儿。

## Alternatives considered

**时间窗启发式配对。** 63 条孤儿在 ≤241 ms 内有账本对应行，看起来可以直接用上。但并发下多个失败调用集中在短时间内时候选不唯一；而且账本侧本身已经是同一请求的另一份证据，配对逻辑会与既有 response_id 合并形成两套归组路径，增加维护负担。放弃。

**让 hook 插件传 session。** 需要改 magpie 本体或 hook 插件代码、跨进程部署。magpie 本身已经有 conversationID 的计算逻辑，ATC 侧复现更直接，且不需要改动上游。放弃。

**存量回填。** 现有 63 条孤儿保持现状，回填需要独立迁移入口、读写真实库、重算派生组，且只改善 63 条历史记录的展示。新数据自然生效，旧孤儿不再增加，投入产出比低。放弃。

**在 UI 层做「推断」标记。** 用户不关心归组依据是上游 conv 还是自算摘要，只关心会话合并了。增加 UI 标记会让页面语义复杂化，且 conv-digest 是确定性的 hash，不算"推断"。放弃。

**改写 mergeHookInto 按摘要匹配。** mergeHookInto 解决的是 hook ↔ 账本 的物理合并；conv_key 选择解决的是 hook 自身归入哪个逻辑会话。两个问题分离，把它们耦合到同一函数会增加后续维护成本。放弃。

## Consequences

- **新数据不再新增同类孤儿。** 失败 hook 只要首条 user 消息可提取，就会与同会话的路由行归入同一 conv 组，标题派生恢复可命中。
- **存量不回填。** 63 条旧孤儿保持现状；新数据自然生效，旧数据不会再新增同类孤儿。
- **同一笔失败调用仍可能显示两行。** 正文行（conv-digest 组）与账本侧「缺正文」行（route conv 组）是同一请求的两份来源证据，各自 conv_key 不同；两行都归到正确会话后不再是孤儿，但计数仍是两笔，是否合并留作后续范围。
- **序列化口径偏差是主要风险。** 如果 ATC 侧自算摘要时的 JSON 序列化方式与 magpie 原生 conversationID 使用的方式不完全一致（空格、字段顺序、编码细节），真实样本可能对不上。真实库 63/63 摘要保真度仍作为独立验收项保留。
- **摘要碰撞与正文 partial 仍会残留。** 两个不同会话首条 user 消息字节级完全相同会得到同一摘要；首条 user 消息不完整的请求仍留在 `["hook", hookId]` 组。前者是上游 magpie 也有的行为，后者是本机制覆盖不到的范围。

## Verification

### 合成回归

由 `tests/hook-identity.test.ts` 覆盖：

- **有摘要 → conv 组键**：带 user 消息的 hook envelope 落库后 conv_key 为 `["conv", "magpie-<12字节hex>"]`，conv_source 为 `conv-digest`；同 conv 下后续路由行与 hook 行同组。
- **无摘要 → hook 组键**：无 user 消息或正文 partial 的 envelope，conv_key 保持 `["hook", hookId]`，conv_source 保持既有值。
- **同首条 user → 同组**：两个请求携带完全相同的首条 user 消息，得到相同 digest、归入同一 conv_key；不同首条 user → 不同 digest → 不同组，即使请求在同一毫秒到达。
- **mergeHookInto 不变**：已有 response_id 的 hook 仍走既有物理合并路径，conv-digest 不影响它。

### 真实库摘要保真度

对 63 条失败 hook 从已存正文重算摘要、与同会话路由行的 conv 值比对 63/63 的验收口径保留；本轮提交只带合成回归，未包含真实库 63/63 的复测记录。存量 63 条不回填。

### 测试与会话列表语义

摘要归组后，同 conv 内的标题派生按现有 `derive_queue` 逻辑恢复；`tests/session-list-oracle.ts` 的受影响断言已在同一批次审视。归组结果用测试或只读查询证明，不靠推断。
