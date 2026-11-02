# Agent Note: 全部读取归一到一个生命周期与调度器

Status: implemented

## Problem

读取架构提案（[读取架构与多客户端演进](../../proposed/architecture/2026-11-02-read-architecture-and-client-seams.md)）Task 3：reader-store 仍以 URL 为读取单位（`createLanes` 固定 4 并发 + `getJson` 逐响应解析），弹窗与统计另走直接 Fetch，没有任何 owner 取消边界——离开会话、页面卸载后在途读取继续回写，也无处统一结算。

## Decision

- `createReaderStore(transport, ...)` 消费 Task 1 的 ReadTransport，内部创建 Task 2 调度器；`createLanes`/`getJson` 删除，URL 不再出现在 store。每个读取点是一次具名操作的 `execute`，响应解析在调度槽内完成。
- 三个取消边界：`pageScope`（会话列表、统计）、`sessionScope`（窗口与全部请求级读取，切换或离开会话即 cancelScope 并换新对象）、dialog scope（弹窗经 `readContextItem`/`readContextBody`，同一 AbortSignal 复用一个 scope，WeakMap 持有，不建跨弹窗去重）。`leaveSession` 先推进代次再取消再清缓存；`dispose` 取消全部并停调度，之后读取以 `cancelled` 拒绝。
- `rec.pages` 的成功 Promise 缓存拆成 `pageValues`（完成值）与 `pageInflight`（在途登记）：命中完成值直接返回；任务结束只清属于自己的在途登记。此前 `pending.catch(() => rec.pages.delete(key))` 在 validate 换版重置后可能删除其他代次刚登记的新任务；缺口页删除（`dropPage`）同时清两层。
- 页面装配只留一处 Fetch（HTTP adapter 的注入点）：统计改走 `store.loadStats`，弹窗改注入 `readDirectory`/`readEntry` 两个 facade；`entryBodyUrl` 换成纯函数 `entryReadTarget` 返回 ContextBodyTarget，顶层字段条目从「正文根读取」改为头部区间 `[0,40)`——request_fields 只在头部页返回，区间读取语义一致且适配契约的必填 from/to。
- popstate 无会话时 `leaveSession` 并清页面级缓存（folds、选中、汇总清单、弹窗、mainView）；`pagehide` 调 `dispose`，bfcache 恢复（`pageshow.persisted`）时 store 已失效，整页 reload 恢复现场——不复活已停止的调度器。
- 错误口径统一为 transport 稳定码：窗口与结构错误从 `http_503` 变为 `unavailable`，读取失败占位与 absent 语义不变。

## Alternatives considered

**保留 fetcher 签名、在 store 内部包一层 transport。** 调用者仍可绕过具名契约拼 URL，弹窗与统计继续旁路；迁移的意义就在消灭 URL 作为读取接口。否决。

**dispose 后重建 store 以支持 bfcache 恢复。** 需要重建全部闭包状态与回调绑定，只为一个低频恢复路径；reload 一次的代价更低且状态确定。否决。

**fixture respond 保持严格 DTO 类型。** 行为测试只需最小形状断言缓存、守卫与取消语义；逐测试补全 35 字段 RequestRow 是纯噪声。形状正确性归 read-contract 契约测试（HTTP 与进程内 transport 对照真实查询函数），fixture 的 respond 放宽为签名级输入函数。

## Consequences

- fixture 的 hold 点感知取消：被 abort 的执行立即以 `cancelled` 结算，与真实 transport 的 fetch 中断对齐；忽略取消的行为由调度器测试的专用 fixture 覆盖。
- 迟到的会话读取即便返回数据也不能复活窗口内容（缓存已清、守卫拒绝）；这一性质有测试（退出会话清窗口与缓存）。
- 新增公共 API：`leaveSession`/`dispose`/`loadStats`/`readContextItem`/`readContextBody`，reader-types 钉子同步更新。
