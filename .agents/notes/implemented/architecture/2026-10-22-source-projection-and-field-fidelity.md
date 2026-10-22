# Agent Note: 来源字段按上游真实键读取并保留类型状态

Status: implemented

## Problem

来源 Adapter 按记忆中的键名读取上游账本与路由行，读不到的键静默落成 NULL，页面再把 NULL 解释成"本地估计"或"无此数据"。三处键名或类型读错，三处都不会让任何测试失败：

- 请求模型读 `requested`，magpie 的 JSON tag 是 `req`。
- 客户自报费用读 `own_cost` / `ownCost`，tag 是 `cost`。
- `prompt.counted` 是布尔，被 `optionalNumber` 读成数字，`prompt_counted` 因此恒为 NULL。
- vendor 错误原话在 `err`，Adapter 只映射了 `err_type`。

同样的读取方式把四种不同的事实压成一个 null：上游没有这个键、写了空串、写了别的类型、写了合法值。合并之后无法回答"这一笔到底是没报，还是报了个空值，还是报了读不懂的东西"。

## Decision

`src/sources/magpie.ts` 用 `stringField` / `numberField` / `promptFields` 读取，每个字段带 `FieldState`：`reported`（读到值）、`empty`（空串）、`absent`（没有键或显式 null）、`invalid`（类型不对）。`invalid` 不抛错、不转类型，值保持 null，状态记下来。空串既不是值也不是撤销。

模型三列各读自己的键：`model` 是 provider 侧模型 id，`requested` 读 `req`（agent 请求的模型：别名、路由组或 `provider/model`），`served` 读 `served`。三者不互相顶替。费用只读 `cost`；旧账本的 `own_cost` / `ownCost` 不再是来源。account 读 `account`，缺失时退回 `providerAccount`。

`prompt.counted` 走三态：`true` / `false` 分别写 1 / 0；键省略时写 0 但状态记 `absent`（合法省略等于未校准，不等于 false）；其他类型写 null 并记 `invalid`。`prompt.tokens` 不是合法非负数时整组记 `invalid`，窗口、轮数与 parts 一并留空——没有分母的比例不能单独拿出去当事实。

`LedgerShape` 与 `RouteShape` 随字段一起返回，供投影层判断完整性；本批只把它们带到 `mapLedgerRow` / `mapRouteRow` 的返回值，消费它们的完整性判断与事实选择归[来源投影计划](../../../../docs/superpowers/plans/2026-10-22-atc-source-projection.md)后续任务。

## Alternatives considered

**继续用 `optionalString` / `optionalNumber`。** 它们把缺失、空串与非法类型合并成 null，正是这轮要修的问题；保留它们只会让下游无法区分"上游没报"与"上游报了读不懂"。

**读错时抛错拒绝整行。** 一条类型不对的字段会让整笔来源记录被丢弃，代价远大于收益：其余字段仍然可用，读者更需要知道哪个字段没读懂，而不是整笔消失。

**保留 `requested` / `own_cost` 作为后备键。** 本机账本里这两列从未有值，后备读取只会掩盖键名错误；真正的历史兼容在迁移批次里显式处理，不在 Adapter 里静默兜底。

**`counted` 省略时写 NULL。** 省略是"未校准"这一合法状态，写 NULL 会让它看起来像"读不出"，也无法与 `invalid` 区分。

## Consequences

- `request.model_requested` 与 `request.own_cost` 从此可能真有值；此前它们恒为 NULL，任何"这两个字段没有数据"的判断都要重新核对。
- 字段状态目前只到 Adapter 返回值，不进数据库。要把它变成长期可读的事实，需要投影层与迁移批次，见[长期信息与显式重建计划](../../../../docs/superpowers/plans/2026-10-22-atc-durable-rebuild.md)。
- 旧账本里的 `own_cost` 不再被读取。若存在只写了旧键的来源，它的自报费用会表现为 `absent`，而不是一个可疑的数值。
- 非法类型不再被静默吞掉成"没有值"，但也没有日志：状态字段是唯一出口，读它的人必须显式检查。

## Testing

`tests/magpie.test.ts` 的「账本来源字段按 req 与 cost 读取并给出类型状态」「账本旧键、空串与非法类型分开记录且都不当新值」「路由 Prompt 只在校准布尔与 tokens 合法时给出 counted」锁定读取与状态；上游键名以锚定检出 `开源源码@magpie-2374ffe` 的 `internal/usage/usage.go` 与 `internal/gateway/prompt.go` 为准。
