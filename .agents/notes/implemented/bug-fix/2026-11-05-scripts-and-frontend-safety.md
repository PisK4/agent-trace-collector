# Agent Note: 排空守卫、日志不可读标注与 +N 清单随会话

Status: implemented

## Problem

2026-11-04 巡查清单（[open-bug-findings](../../proposed/bug-fix/2026-11-04-open-bug-findings.md)）里三笔 P2，各占一条优先级：F36 两个一次性回填脚本用 `for (;;) { drainDeriveEntry; if (remaining === 0) break; }` 排空派生队列，只看 `remaining`，不看本轮有没有完成任何组。派生引擎在组消失、`computeDeriveGroup` 返回 null 或用途滞留时会留下 `remaining > 0` 的无进展轮次，脚本随即原地空转：CPU 占满、不退出、无输出，与服务并行时还争抢写通道。`src/maintenance/rebuild.ts` 的同类循环已有 `derive_no_progress` 守卫，脚本没有。

F17 `tailLines` 读日志失败时 `catch { return [] }`，与「日志为空」完全同形；`service status` 只在有行时打印日志段，读失败就静默消失，排障会往「没有日志」方向走。

F29 中栏 `+N` 目标清单放在一张全局 Map，累计超过 500 条整表 `clear()`，但页面上的旧 chip 不重绘。长会话翻页越过 500 个目标后，先前渲染的 chip 悬停拿不到清单、静默失效；Map 也不按会话清理，跨会话浏览加速触顶。

## Decision

**F36 — 排空守卫。** 两个脚本（[backfill-summary-facts.ts](../../../../scripts/backfill-summary-facts.ts)、[backfill-omp-semantics.ts](../../../../scripts/backfill-omp-semantics.ts)）把排空循环收进各自导出的 `drainToEmpty`，照抄 rebuild 的三元守卫：有剩余组的一轮 `groups.length === 0 && purpose_processed === 0` 即抛 `derive_no_progress`，进程以明确错误退出。上限按连续无进展轮次计（1 轮即止），不引入墙钟。脚本用法不变，派生引擎一行未动。

**F17 — 读失败标注。** `tailLines` 改返回 `{lines, error}`：可读时 `error` 为 null（含可读但为空），读失败时 `lines` 为空数组、`error` 带原因。`service.ts` 的 `logTail` 透传为 `{lines, unreadable}`：`commandStatus` 读失败显式出一行「日志 … 不可读：<原因>」，`reportFailure` 在尾部行之后追加「日志不可读：…」；可读但为空仍不占版面，维持降噪约定。

**F29 — 清单随会话。** `moreTargets` 的生命周期独立成 `createMoreTargets()`（[app.js](../../../../web/app.js) 顶层导出，生产实例在 document 守卫内装配）：清单跟随当前会话的渲染行，不按条数清空——窗口内的行不离开，条目就不清理；换会话与显式刷新在 `resetReading()` 整表重置，随后窗口整体重投影、清单随渲染重新登记。`showMore` 与登记点改走工厂的 `remember`/`listOf`。

## Testing

- `tests/session-summary.test.ts` 与 `tests/backfill-omp.test.ts`：`drainToEmpty` 注入合成轮次各 2 例——有剩余、零进展一轮即抛 `derive_no_progress` 且不再重试；组进展与用途判定都算进展，排空后返回累计组数。
- `tests/service-support.test.ts`（新增）：`tailLines` 对空日志、截尾、文件缺失三种输入，断言 `{lines, error}` 把「可读为空」与「读失败」分开。
- `tests/web.test.ts`：601 个目标登记后首个 chip 的清单仍在，且经 `renderTraceRows` 断言真实行 HTML 的 `data-more-key` 与清单同键；reset 后 Map 清空、取键返回 undefined。
- `bun run typecheck` 通过；未在真浏览器复现 F29（本批边界），真机悬停行为留待下次页面走查。

## Related

Supersession check：在活动树里搜 `derive_no_progress`/`drainDeriveEntry`/`tailLines`/`moreTargets`，没有既有 note 持有这三条决策。[open-bug-findings](../../proposed/bug-fix/2026-11-04-open-bug-findings.md) 的 F17/F29/F36 三节是本篇实现的提案，其余 40 余条仍待修，该篇保持活跃、不归档不合并；[session-layout-and-row-hierarchy](../feature/2026-11-04-session-layout-and-row-hierarchy.md) 只提到 `+N` 真机未触发过的覆盖缺口，无决策重叠。findings 清单里这三条的状态列由主 agent 在合并批次里更新。

## Alternatives considered

**F36 只加 sleep。** 空转变慢转，仍不退出，CPU 照占，「不阻塞主线程」没有兑现。落选。

**F36 按总墙钟 30 秒超时。** 慢但正常的大组派生单轮可能远超 30 秒，会误杀合法回填；无进展才是「卡住」的信号。落选，改按连续无进展轮次。

**F36 按最大总轮次封顶。** 合法轮次随组数线性增长（1,467 个 clean 组、每轮 50 组，30 轮起步），常数上限要么太松要么误杀。落选。

**F17 只改文档，写明「读失败表现为空」。** 排障的人还是分不清两种空，故障照样被掩盖。落选，读失败必须在输出里可见。

**F17 让 `tailLines` 抛异常。** 状态脚本按 F14 约定「宁可少一项读数，不在巡检里栈崩」，抛异常破坏这条。落选，改返回形状保住约定。

**F29 把上限调大（如 5,000）。** 只后移触顶点，最长会话 4,433 笔请求仍会越过后静默失效。落选。

**F29 去掉上限、跨会话累积。** 翻页永远可用，但 Map 无界增长，跨会话不释放。落选——保留重置边界，上限改由「单会话渲染行数」承担。

**F29 有界 LRU（保留最近 500、按读取淘汰）。** 淘汰即失效：从未悬停过的在页 chip 一样丢清单，F29 的症状原样保留，只是从「全部失效」变「部分失效」。落选，改按渲染行生命周期。

## Consequences

- F36：脚本在卡死状态下一轮内退出，退出码非零、错误码 `derive_no_progress`，不再无限空转。代价是「一轮无进展但下一轮自愈」的状态会被判死——脚本要求先停采集器、独占写、库静止，这类状态在本脚本语境里是确定性卡死，与 rebuild 同判据。脚本维护锁（findings 建议方向之一）不在本批，仍是独立缺口。
- F17：读失败在 `status` 与失败报告里显式可见；`tailLines` 返回形状变了，全仓唯一消费方 `service.ts` 已同步，`scripts/patrol.ts` 不走这条链。
- F29：长会话翻到多深，先渲染的 chip 都能弹出；Map 生命期与单会话渲染行同界，换会话释放。代价是不再挡单会话内的清单总量——这个界由 DOM 本身承担，Map 只多持各行的字符串数组，最坏与页面可见内容同量级。
