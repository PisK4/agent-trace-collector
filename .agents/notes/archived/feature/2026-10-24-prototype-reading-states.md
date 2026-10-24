# Agent Note: 原型阅读状态分离与阅读任务验证

Status: implemented
Archived: 2026-10-24

## Problem

[生产迁移计划 Task 0](../../../../docs/superpowers/plans/2026-10-23-single-timeline-production-reader.md) 盘点的原型缺陷会误导阅读：local 模式工具行不显示任何关联或加载状态，展开才读取，静态分支把未读取写成「未记录」；`localSteps` 整体替换吞掉请求状态行，HTTP 失败且已有输入回复时没有失败记录；HTTP 成功与回复完整性不分，`finish_reason=length` 仍显示完成；Schema 读 `owner.request.tools`，本机入口该字段恒为 null，恒报「没有携带定义」；非末行渲染同宽空占位压缩摘要；默认选中最新落在可视区外。

## Decision

五组状态分立并各自可见：HTTP 状态、回复完整性（`replyView.finish` 映射，`length`/`max_tokens` 为截断、未知停止原因按原值显示）、正文状态、工具关联（resolved/pending/ambiguous/unpaired）、结果正文加载（未读取/读取中/已读/不可读/位置无效/失败）。`request()` 在数据层构建内容步骤与记录行并合并进 `localSteps`，`renderSteps` 只装配不再整体替换；「未读取」不写「未记录」，resolved 只代表关联已确认。

结果入口前移到工具行：关联已确认时显示「结果见请求 N · 待读取」，N 是当前载入窗口的展示号，数据属性保存稳定 `req_id`，加载更早后重新编号不影响身份；目标在窗口外时显示稳定请求号并标未在窗口，点击经 `readOutside` 只读目标详情并在右栏说明，不扫描全部历史。读取按发起请求的调用位置进行，同一 `call_id` 出现在两笔请求时不串用；失败保留原因与重试。Schema 改读 `localPage.capabilities.tools`，present 未声明、empty、missing/partial、unrecognized、同名多项分别表达；静态演示分支保留 `request.tools` 回退。辅助请求一笔一条辅助记录，分类器输入不画成用户消息；分支请求保留分支标记，增量不升级。默认选中最新后带入可见区域；URL 指定窗口外 trace 时读详情并在右栏说明，不静默改选最新。

新增 `prototypes/synthetic-server.ts` 提供合成场景与同源 API（18 笔请求覆盖上述全部状态，只监听回环地址），检查经实际 `createLocalReader` 与原型事件处理执行。非末行取消同宽空占位；215px 计量宽度保留，未引入新的固定值。本记录部分取代[本机读取原型](2026-10-23-local-trace-prototype-reader.md)中「结果关联与读取状态共用未记录文案」的描述，其只读与样本限制保持有效。

## Alternatives considered

**在 `renderSteps` 里补丁行级状态。** `localSteps` 整体替换会覆盖任何行级补丁，状态必须在数据层构建后一次投影。

**结果入口继续按全局 `call_id` 查找。** 同一 `call_id` 出现在两笔请求时会串用结果；按 owner 与调用位置读取才能精确到内容块。

**预设新的固定宽度或取消每请求计量。** 只在 1507×838 与 400px 实测占用；去掉空占位已释放摘要宽度，计量口径不动。

## Consequences

三项阅读任务在同一合成场景可完成且不伪造因果：最后回复、失败请求与后续（新请求而非重试）、工具调用到结果及承载请求均可定位；基线与复测数据、宽度实测和未覆盖项（无截图验收、本机入口未重测）见[验证记录](../../../../prototypes/README.md#验证范围)。用户可读性确认未取得，记为待确认。状态语义由生产迁移计划 Task 5/7 继承；原型不成为生产依赖，静态数据、独立服务与 `readOutside` 单次读取都不进入生产。
