# Agent Note: 请求用途先于组结果完成，读模型按状态区分当前与保留

Status: implemented

> 请求用途的版本 1 解释已由[请求用途按版本 2 解释，主链身份只由已存用途决定](2026-10-22-request-purpose-and-chain.md)取代；两阶段入口、组内 pending 跳过与读模型状态仍以本记录为准。

## Problem

派生的两个粒度混在一个循环里。组阶段自己判断"这一笔是不是标题生成请求"，同时请求表里还留着 `purpose_pending` 等一套从没被任何代码消费的列。于是同一个问题有两个答案来源：一个在组里现算，一个在列里挂着。任何一处改了规则，另一处不会跟着变。

读模型的问题更直接：`request` 里存的是"上一次算出来是什么"，接口把它原样返回，调用方无从知道它还是不是当前结论。正文已回收的行标题与摘要按旧值保留，刚重算的行是新的，两者在 JSON 里长得完全一样。组还在 dirty 时，上一版的前驱、增量与工具配对也会照常返回，看起来像已经确认。

## Decision

请求阶段与组阶段在同一个事务里、按顺序跑，入口只有一个 `drainDeriveTx(db, {limit, scope?, purposeLimit?})`；`drainDerive(store, ...)` 退化成校验参数后开一个写事务的包装。

请求阶段（`drainLegacyPurposeTx`）把现有 title/chat 行为固化成可重放的结论：`purpose_status` 写 `recognized`/`unrecognized`/`retained`/`missing`，`purpose_rule` 写 `legacy.title`/`legacy.default`，`purpose_version` 写 `LEGACY_PURPOSE_VERSION=1`，同时定下 `purpose_chain`、`req_kind` 与 `model_title`，清 `purpose_pending` 并让 `purpose_revision` 追上 `input_revision`。正文不可读时有旧版本就保留原值标 `retained`，从未判过标 `missing`。

这个阶段**不推进自己请求的输入修订**：它消费输入，不改变输入。只有用途、链归属或正式标题真的变了，才标所属组重算。组阶段因此只读 `purpose_chain`，不再自己识别标题请求；组内还有 `purpose_pending=1` 的成员时整组跳过并保持 dirty。

`DrainResult` 增加 `purpose_processed` 与 `purpose_remaining`。维护的排空循环要求 `remaining` 与 `purpose_remaining` 同时为 0，任一阶段零进展即报 `derive_no_progress`。

读模型新增 `derivedStateOf`，按请求用途、组完成状态、修订与算法、摘要状态给出 `dirty`/`current`/`retained`/`legacy`。`listRequests` 与 `getRequest` 各自在一个只读事务里取行、组状态与工具行，只在 `current` 时把关系、增量、`chain_role`、折叠行摘要与工具结果位置放在顶层；非当前时它们是 `null`、`unknown` 与 `pending`。标题退到不依赖正文的那一档。详情另带 `historical` 白名单，把旧结论连同状态一起给出；列表不携带。

## Alternatives considered

**让组阶段继续自己识别标题请求。** 这就是当前的双写者问题：用途列说一套、关系按另一套算。D 要整体替换用途判定，留着组里的识别等于替换不干净。

**用途阶段顺手推进输入修订。** 会让"判定用途"这件事本身触发重算，用途判完组又变脏，形成自己喂自己的循环。判定是消费输入的动作，不该被记成输入变化。

**组内仍有 pending 时先算、之后再补。** 算出来的关系基于一个还没定的用途，等于猜；补算时输入修订已经变了，那次完成也不能复用。

**读模型直接返回原列，让界面自己判断。** 界面没有组状态、修订与算法，判断不出来；调用方也不能拿一个"可能是旧的"值当证据。状态判定必须与数据同源、同快照。

**非当前时返回空对象或 404。** 独立事实（耗时、费用、正文、模型）是有效的，屏蔽它们会把"派生未完成"错报成"这一笔没数据"。

## Consequences

- 同一事务里两个阶段都要排空，一批大组不再因为用途只判了 100 条而卡住；`purposeLimit` 是每批大小，不是总量上限。
- 未知归属的请求也会被判定用途，但不产生组；读模型里它没有组可加入，因此恒为 `dirty`，关系为 `unknown`。
- 读模型多一次 `LEFT JOIN derive_queue`，以及每次调用一个只读事务。列表不带摘要算法列，详情带。
- 非当前行的工具调用保留调用身份，`result_req`/`result_ord`/`result_path` 清空、`state` 退回 `pending`：不显示可能是旧的位置，正常态也不挂提示（「结果位置未确认」chip 后经[读数条与「无则不显」收敛](../../simplification/2026-10-24-rail-usage-strip-and-absence-hiding.md)删除）。
- 请求阶段按版本 2 解释，不能与版本 1 并行运行；历史 v1 行只有显式 `rebuild --session` 才升级。
- 会话标题只取已完成组且用途已结算的行，与会话的 `derived_state='current'` 同条件。

## Testing

`tests/derive.test.ts` 的「未知归属的请求也能完成兼容用途且不建哨兵组」锁定用途阶段与无组路径，「正文回收后保留原用途版本并消费当前修订」锁定 retained 与修订消费，「从未判定过又读不出正文的请求标missing」锁 missing，「组内仍有待判定用途时不完成该组」锁两阶段顺序与批量推进。

`tests/queries.test.ts` 的「已完成的组在列表与详情里都是current」锁当前投影与工具配对，「组dirty时关系与增量不作为当前值返回」锁屏蔽与 `historical`，「正文保留的组标retained且不冒充当前」锁 retained，「未归属请求的组关系为unknown但用途与输入可读」锁无组路径的读模型。

`tests/http.test.ts` 的「详情不返回账户字段也不返回骨架」改为断言 dirty 行的当前字段为 null、旧关系只在 `historical` 下出现；`tests/maintenance.test.ts` 的 rebuild 报告增加 `purpose_remaining` 与 `purpose_processed`。
