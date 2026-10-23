# Agent Note: 发布代读取的整套选源

Status: implemented

## Problem

`derive_request_result` 视图早已存在，但 HTTP 查询仍读 `request` / `tool_call` 同步旧列：队列带 `published_generation` 指针的组，标题、摘要、关系与工具配对读不到发布代结果；发布代与同步旧值不同时会读到过期或诱饵值。

## Decision

列表、详情与会话标题的派生列按同一条件整组选源：有指针读 `derive_request_result` 与 `derive_tool_result`（摘要状态映射代际 `retention_state` / `algorithm` / `basis_json`，legacy 代不给算法号），没有指针读同步旧列。同步旧列同时是「上一次完成值」的家——dirty 组的 `historical` 与调用身份从它取，发布代缺行时工具也回退它保住 `call_id`。当前与否的屏蔽闸门不变：`derived_state` 非 `current` 时顶层照旧屏蔽，工具退 `pending`。`getRequest` 的 alias 解析移进同一只读事务。

同步可用性判据没有另立口径：`groupCurrentSql` / `groupIsCurrent` 是唯一所有者，`target = published`（任意算法号）即同步当前，不额外要求等于当前代码常量 `GROUP_ALGORITHM`——既有测试以算法 3 作为合成当前算法，把它夹死成常量会误伤算法升版后的合法组。组不 current 时摘要三列置 NULL，让 `derived_state` 落到非 current，堵住「指针缺失 + 算法号追平」的混读窗口。

## Alternatives considered

**按列各自选源。** 会出现标题取发布代、摘要取同步列的混拼；来源条件必须整组应用。

**同步可用另加 `target_algorithm = GROUP_ALGORITHM`。** 计划初稿曾这样写；实现时既有测试证明算法号是数据不是判据，任何 `target = published` 的干净组都可能是当前同步结果。

**缺行时判 dirty。** 发布代指针指向没有结果行的代时，摘要置 NULL 落到 `legacy`（同为屏蔽、不冒充 current）；与计划「缺行时 dirty」的措辞有偏差，屏蔽效果等价，记录在案。

## Consequences

发布代与同步旧值刻意不同的合成种子锁住了整套选源（标题、列表、会话标题、增量、摘要依据、工具路径同源），指针缺行不回退诱饵值，retained 与 dirty 的屏蔽行为保持。会话标题候选、工具身份与 `historical` 在 dirty 下不丢。契约变化只有 `RequestDetail.summary_state` 放宽为可空（无可用来源时如实为 null）。验证：`bun test tests/queries.test.ts tests/http.test.ts` 全过、`bun run typecheck` 通过（2026-10-24）。切片启用仍是另一个决定，本轮不切换运行模式。
