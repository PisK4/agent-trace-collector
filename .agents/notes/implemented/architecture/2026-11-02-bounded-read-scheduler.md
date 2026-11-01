# Agent Note: 读取调度的有界并发与 owner 取消

Status: implemented

## Problem

读取架构提案（[读取架构与多客户端演进](../../proposed/architecture/2026-11-02-read-architecture-and-client-seams.md)）要求读取执行有界：活动槽、待发队列、公平性与 scope 取消。此前页面读取没有统一排队，长会话准备会并发堆满在途请求，弹窗与统计另走直接 Fetch 无取消边界。

## Decision

`web/read-scheduler.js` 提供具名任务的有界执行，仅被 reader-store 内部使用（Task 3 接线），不要求业务调用者排队。

- 初始上限：活动 4、待发 64、后台活动最多占 3、连续交互最多 8，全部可在构造参数注入测试。参数只在这一处定义，不散布在 feature。
- 待发满时新的交互任务淘汰最旧待发后台；无可淘汰后台则 `queue_full`。后台任务满队列直接 `queue_full`，不用堆积 Promise 充当背压。
- 取消分两段：未执行任务立即移出队列并 settle `cancelled`；已执行任务只收到内部 AbortController 的 abort，settle 后才释放活动槽。忽略取消的任务不会被记为已停止，也不提前释放槽——提前放下一个会造成超并发。
- 连续服务 8 个交互任务后，若后台有可用槽则先放行一个最早的后台；公平规则只在存在合适槽时执行，不中断在跑任务。
- `stats()` 只返回活动数、待发数与累计计数（排队/执行时间的 sum 与 max、取消、淘汰、满队、错误），计时用注入的 monotonic clock；scope 对象与任务正文不进入任何统计输出。

## Alternatives considered

**无界并发 + 靠调用者自觉。** 准备流程会一次登记整场读取，长会话下在途请求与并发连接失控，且无法为中期 macOS 宿主提供统一取消。否决。

**取消即从计数里移除。** 忽略取消的任务若提前释放槽，实际并发会超过上限；被 abort 的同步 SQLite 读取也仍在占线程。槽只在任务 settle 后释放。

**跨 owner 共享在途任务。** 两个 owner 共享一个任务时，任一 owner 取消都会影响另一个。本轮不建立跨 owner 共享；同记录去重仍由 store 持有。

## Consequences

- 调度无法抢占已运行的同步 JavaScript，也不能中断 Bun 的同步 SQLite 读取；后台大事务造成的响应尖刺仍由独立性能分支处理。
- 队列淘汰意味着被淘汰的后台任务需要调用者重试或放弃，store 的准备流程（Task 5）负责不把整场任务塞进队列。
- 行为有确定性测试（`tests/read-scheduler.test.ts`）：槽释放、淘汰、保留槽、公平计数、抛错释放、待发与在途取消、dispose 幂等与拒绝新任务。
