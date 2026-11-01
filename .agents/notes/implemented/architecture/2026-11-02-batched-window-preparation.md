# Agent Note: 窗口准备的批量块与聚合通知

Status: implemented

## Problem

读取架构提案 Task 5：窗口准备仍按「每批四组并发单项读」推进，一个 30 笔窗口付 60+ 次往返（每组 detail + meta，增量再各一次）；Task 4 的批端点没有消费方。同时旧通知签名 `(id, dependencies)` 让块内多组完成时逐组触发渲染，失去聚合机会。

## Decision

- `reader-store` 新增三个批入口：`readRequests(ids)` 一次 readings 批逐项合入详情与元信息；`readRanges(wants)` 一次 bodyRanges 批合入区间页，逐项错误留缺口返回 `null`；`loadDeltas(ids, pages)` 跨请求打包 delta 片，逐请求核对所需 ordinal 全到齐后才推进各自的 `delta.next`。三者共同约束：整批形状验证（index 唯一在界、`requested_id` 对应，重复或缺失报 `invalid_response` 整批不写入）、每轮重新捕获资格、`batch_too_large` 折半后保持不放大、在跑的 id 不重复登记（`batchInflight`/`deltaInflight`）。
- `trace-preparation` 的 `prepareWindow` 保留目标优先：目标组走完整单项链（详情→依赖→增量，供选中响应不被块拖累）；其余按最多 32 笔读取块获取 bundle，窗口内依赖一次批补齐，增量按每请求两片、窗口总预算二十片打包区间块。块内资格仍逐组判断，完成一块聚合一次通知；通知签名改为 `(ids, dependencies)`。
- 提交资格在 `prepareWindow` 计算完 wanted 后统一撤下（重试与批量补读期间无资格，逐组重新判断后恢复），不依赖单项 `prepare` 的删除时点。
- 失败策略：不新增版本探测回退循环——当前同版本生产与合成服务器都支持批次，批级失败（4xx/5xx/网络断）整调用拒绝、落各组失败态，不展开单项风暴；批响应的 `oversized` 项回退单项路径（单项无批预算），回退次数累计在 `store.batchFallbackCount()` 供验收观察。失败保留旧显示与现有重试入口。

## Alternatives considered

**目标组也进读取块。** 选中响应与块首请求竞争，选中反馈被拖慢一个块的量级；目标单项链是窗口里唯一值得付单价的读取。否决。

**批失败自动降级为逐项单项重试。** 503/401/断网场景会把一次失败放大成 32 次单项风暴，正是读取架构要消灭的形态；失败落组状态、走现有重试入口，由用户决定何时重试。否决。

**`next_index` 后缀交给下一轮重新排序。** 已返回项覆盖 `[0, next_index)` 的契约允许直接把未结算后缀拼回队首，重排反而让 index 语义与块边界难对账。沿用直接拼接。

## Consequences

- 迟到任务的身份守卫集中在 store 层：`readRequests` 逐项合入走 `applyBundle` 资格检查，`loadDelta` 返回前校验 `reads.get(id) === rec && rec.token === myToken`，旧任务不得返回新快照——prepare 层不再自判版本。
- `prepareWindow` 不再把后继任务预排进有限队列；块按需推进，追加中点选只需把新目标插到当前块之后，不重启整个窗口。
- `onPrepared` 的批量签名要求消费方（app.js）对 ids 循环清理 preparing 态；依赖并集一次 `renderRail` 判断。
