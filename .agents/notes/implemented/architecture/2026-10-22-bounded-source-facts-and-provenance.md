# Agent Note: 来源事实有界落盘，结果按实际算法版本记录

Status: implemented

## Problem

原始层按保留期删除。删掉 `raw_ledger`、`raw_route`、`raw_hook` 之后，有两类结论再也推不出来：这一笔请求见过哪些来源用途、hook 独立报告了什么模型与成败、最终尝试是哪一条、它用的是什么模型与供应商。读模型只能看到行级事实列，而列里没有"这份结论是按哪版规则算出来的"，于是保留值与本次重算值在界面上长得一样。

`derive_version` 试图回答这件事，但它逐次累加，只表示"被重算过几次"。拿它的 MAX 当当前算法会把正文已回收、从未重算的行也报成最新，正是要修的那类误报。

## Decision

新增 `src/sources/facts.ts`，用纯函数维护两列有界 JSON，与行级事实在同一个投影事务里写：

- `source_facts_json`：按来源分开的用途集合（`ledger`/`route`/`state`/`value`）、hook 的模型与成功集合、`selected` 整对象。单值 256 字节、每来源 8 个值，按字节序去重排序；溢出发 `overflow`，非法值发 `invalid`。
- `projection_meta_json`：`order` 与 models/attempts/prompt 三个族的 `actualVersion`/`state`/`reason`/`basis`。basis 每条 256 字节、最多 16 条。

集合运算满足交换与幂等，所以同一批观测无论到达顺序与重复次数都得到同一个集合；这正是"排列不影响结果"能被测试锁住的前提。集合只增不减：raw 过期是本次证据缺失，不是从未观测，长期集合不因此撤销。

`selected` 整对象替换，绝不字段级拼接——拼字段会造出一条同时带着两笔不同请求模型与错误的记录。顺序不可证时写 `pending_final` 全 null，不沿用旧值假装知道。

三个族的版本语义分开：`recomputed` 的 `actualVersion` 是本次版本；`retained` 保留原实际版本（原值可能是 null，那就是 `legacy_unknown`），不把本次版本冒充成它算出来的；`missing` 表示从未观测过，没有实际版本可继承。basis 超预算时只保存稳定样本并降为 retained。

序列化守住 16 KiB：超限先去掉只用于展示的 `error`/`errorType`，仍超限抛 `source_facts_budget_exceeded` 让整个投影事务回滚。截断会留下半个对象，清空旧事实等于假装从没观测到，两者都不接受。

原始行同时写 `mapping_version` 与 `privacy_version`（`PRIVACY_TRANSFORM_VERSION`），四个 raw helper 共用同一份列清单。摘要记 `summary_algorithm`/`summary_basis`/`summary_state`，工具行记 `algorithm_version`/`basis_json`/`retention_state`；`derive_version` 不再累加，也不再被读作算法目标。

维护报告拆成 `target_algorithm`、`actual_algorithms`（按实际算法分组计数，null 归 `legacy`）与 `legacy_requests`，分别回答目标、实际与保留；旧的 `queued`/`unavailable`/`reasons` 保留，只表示正文状态。

## Alternatives considered

**把 payload 原样再存一份。** 原始层的存在理由就是按保留期删除；再存一份等于取消保留期，容量与隐私边界都守不住。

**只存在行级列里。** 列只能容纳单一值，来源冲突、溢出与"这一版是谁算的"都表达不了；而且列没有版本，保留值与重算值无法区分。

**用 `derive_version` 的 MAX 当当前算法。** 它逐次累加，与"按哪版算出来"无关；正文已回收的行从未重算，MAX 会把它们报成最新。

**超预算时截断 JSON 或写 null。** 截断留下半个对象；写 null 会让读模型把"从没观测到"与"曾经观测但丢了"混为一谈。

## Consequences

- 每个请求多两列 JSON，单条上限 16 KiB；实际大小由有界集合约束，具体分布交容量测量，不拿 SQL TEXT 无上限当预算。
- raw 过期后来源集合与选定尝试仍在，`current=false` 与 `expired` 只表示本次证据缺失。
- 保留行不会因为一次重算被提升版本，报告里能区分"目标算法""实际算法"与"从未重算"。
- `error`/`errorType` 在超预算时会被丢弃：它们是展示字段，不是判定依据。
- 事实 JSON 不接受外部写入；投影是唯一写入者，形状校验失败的旧值按缺失处理。

## Testing

`tests/facts.test.ts` 锁定集合排列无关、溢出与非法标记、两来源 agree/single/conflict、`selected` 整对象替换、raw 过期保留集合、`pending_final` 全 null、三族版本语义、预算拒绝与损坏 JSON 按缺失处理。`tests/reconcile.test.ts` 的「在线摄入的原始行带映射与隐私版本」锁 raw 版本列，「部分raw过期后旧尝试合计不缩小」补事实层保留断言。`tests/derive.test.ts` 的「工具行记算法依据，保留行不改原版本」锁工具元数据与重复运行稳定；`tests/maintenance.test.ts` 的「维护报告分别计入可重算与缺正文保留请求」锁目标/实际/保留三者的报告。
