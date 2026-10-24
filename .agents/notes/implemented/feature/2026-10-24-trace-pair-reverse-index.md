# Agent Note: Trace Pair 读模型反向配对索引与结果原始块

Status: implemented

## Problem

右栏要同屏阅读一次工具调用的两端。从调用端进入有 `tool_calls` 正向配对。从结果端进入时，承载结果的请求只知道「我的 messages[N] 里有个结果块」，没有任何字段指出这个块属于哪次调用；浏览器窗口扫描也覆盖不了窗口外的调用方。同时按位置读取接口只返回 `content` 与 `is_error`，配对阅读拿不到协议原始块，与正文详情的精确对象口径不一致。

## Decision

`RequestDetail.tool_results` 提供反向配对：本请求承载的结果块指向的已发布调用，形状是既有 `ToolCallRow` 加 `owner_req`。与 `tool_calls` 同一事务、同源同闸门。组带发布指针时先读 `derive_tool_result`（`generation` 是无 rowid 主键前缀，代内扫描有界），非空不回退同步表。回退 `tool_call` 时用同组请求（conv_key/actor）的 IN 子查询驱动 `(req_id, ord)` 主键；候选规模是组内请求数，不全局扫描，顺带排除跨组脏行。非 current 时一律返回空数组（反向索引整条都是组结果，没有可保留的调用身份）。

工具结果读取成功响应增加 `raw`：Anthropic 是配对的整个 `tool_result` 块，Chat 是整条 `role=tool` 消息；其余状态 `raw` 为 null。精确读取的身份校验、状态机与固定原因词不变，见[阅读身份与按位置的工具结果读取](../../implemented/feature/2026-10-24-reading-identity-tool-results.md)。

## Alternatives considered

**给 `tool_call.result_req` 建索引后直接反查。** 单次查询 O(log n)，但要动 schema；现有库按版本拒绝原地迁移，为一条读路径加索引不划算，且详情是窗口加载的热路径，组内 IN 回退的有界代价可接受。

**`WHERE result_req = ?` 全局扫同步表。** 行为等价但随历史线性变慢；详情每笔请求读一次，窗口加载会放大。查询计划已验证：IN 子查询形态走 `SEARCH tool_call USING PRIMARY KEY` 与 request 覆盖索引。

**不在读模型建反向索引，前端按 call_id 逐请求搜索。** 违反「不跨请求搜索、不按名称或时间猜配」的读取约束，窗口外调用方也搜不到；确定身份必须由派生层给。

## Consequences

结果步骤进入配对有了确定身份，且与正向 `tool_calls` 永远同源同一发布代，两端不会各说各话。组 dirty/retained 时两端一起降级为空，不会出现一端旧一端新。代价是每笔详情多一条有界查询（代内主键扫描或组内 IN 回退）。`raw` 让配对页与正文详情共用同一份精确协议对象，不需要前端二次解析或另开读取通道。验证：`bun test tests/queries.test.ts tests/reading.test.ts` 48 例通过（同步反向、dirty/retained 清空、发布代优先于同步诱饵、raw 三态）。
