# Agent Note: hook 投递分层诊断

Status: implemented

## Problem

Hermes 流量的钩子缺口需要分层判断，不能直接归因成投递丢失。截至 2026-10-27T05:33:18Z 的只读快照，1,242 笔 Hermes 请求里有 210 笔已有关联账本与路由、没有关联 hook 正文（`have=6`、`body_state='pending'`），其中 205 笔已标 `miss_reason='hook_absent'`；等待队列 605 条里 603 条没有 response ID。

`have=6` 与 `hook_absent` 只能证明本行没有已关联的 hook 证据。失败或被取消的请求可能仍触发完成期 hook，但回复为 null、没有 response ID，ATC 无法按 `response_id_norm` 精确关联；单列未知，不按时间邻近强行配对。

投递丢失仍是假设。[magpie 机制研究](../../../../docs/magpie-mechanisms-research.md)在 `开源源码@magpie-2374ffe` 下区分了 HTTP 失败、回复不可用与回调缺失，该源码结论不替代当前安装版的运行验证。宿主 `gatewayTimeoutMs` 默认 1000 ms（可调到 10000），薄插件自身还有 1500 ms 总预算与 600 ms 单次 fetch 上限，两套截止同时生效；调大宿主预算只能验证宿主提前终止这一种路径，`ingest_issue` 没有错误也不能排除未到达、请求超时或 HTTP 拒收。

## Decision

诊断分两侧。ATC 侧新增只读窗口聚合 [maintenance/delivery.ts](../../../../src/maintenance/delivery.ts)，命令为 [maintain hook-delivery](../../../../docs/operations.md#hook-delivery)；插件侧把投递结果收敛成固定码，写进 `ctx.state.collector_code`，宿主只保存在该次 run 的插件状态里，ATC 不读取。

### 窗口聚合

请求侧按 `started_ms` 落窗，`raw_hook` 按 `received_at`、`ingest_issue` 按 `observed_at`。窗口以 `--since` 与 `--until` 给定，`--until` 同时是观察时点：缺 hook 证据的行以 `until - HOOK_ABSENT_THRESHOLD_MS` 为界分 `settled_missing` 与 `young_missing`，后者只是还没等到。

缺口不只是"没到达"。报告把同一批缺证据的行分成四个可区分的出口：

| 字段 | 含义 |
| --- | --- |
| `missing_with_sources` | 已有账本、路由或 OTLP 的行仍缺 hook：回调阶段没接上 |
| `missing_without_response_id` | 没有 response ID，回调即使到达也无法按 ID 关联，只能留未知 |
| `awaiting_candidate` | 等待队列里已有指向本行的回调，差一次合并，不是投递缺失 |
| `miss_reasons` | 已写下的原因分布（`hook_absent`、`collector_object_limit`、`disk_body_paused`…） |

按 agent、状态码、请求类别与 `prompt_tokens` 分档计数；未知值单列，不归并进已知档。`raw_hooks` 报已到达回调的总数、回复缺失（`reply_state='absent'`）与正文降级数；`pending_hooks` 报当前队列与其中无 response ID 的条数；`issues` 按来源与原因聚合。输出只有计数与固定码，不含正文、令牌或账号。

### 插件侧固定码

[plugins/collector.hooks.ts](../../../../plugins/collector.hooks.ts) 把一次投递的结果分成六个码：

| 码 | 条件 | 重试 |
| --- | --- | --- |
| `collector_delivered` | 收到 2xx 且在单次截止内 | — |
| `collector_attempt_timeout` | 单次 fetch 超过 600 ms，被插件自己的计时器中止 | 一次 |
| `collector_host_abort` | 宿主的 `ctx.signal` 中止 | 不重试 |
| `collector_network_error` | 连接层失败 | 一次 |
| `collector_http_rejected` | 非 2xx，`collector_status` 记状态码 | 408/429/5xx 一次，4xx 不重试 |
| `collector_deadline` | 1500 ms 总预算用尽，或被总预算压低的单次上限触发 | — |

归因顺序先宿主后自己：宿主信号已中止时不把结果记成单次超时。接收方在单次截止之后才返回成功，也记失败——`postOnce` 在响应到达时复核经过的时间，超过上限同样按 `timeout` 处理，不因为最终拿到了响应改写成投递成功。宿主预算更大（例如 5000 ms）不会改变这个结论，因为插件自己的计时器先到。

这些码只存在宿主内存里的插件状态，ATC 的窗口统计看不到；跨进程观测需要另立持久化通道，本次不做。

## Alternatives considered

**仅调大宿主超时后判断丢因。** 插件自身截止、宿主生命周期、HTTP 拒收与无法关联都会表现为请求缺 hook，单一配置实验不足以区分。

**把 null ID 回调按时间邻近配对。** 时间邻近不是身份证据，强行配对会把失败请求的回复挂到别的请求上。

**把插件投递码持久化到 ATC。** 宿主不读回 `ctx.state`，插件也没有第二条通道；加持久化要么改宿主，要么让插件自己写库，两者都超出诊断需要。先把可观察的一侧做完整，缺的跨进程观测在证据要求时另立。

**只做插件侧诊断。** 失败码只在宿主进程内，运维拿不到；反过来，只做 ATC 侧又分不清单次超时与宿主中止。两侧各交付能交付的部分，不承诺单侧给出完整因果。

**先修投递再接用途。** 用途识别与投递诊断的证据互不依赖，可以分开交付；缺正文行继续如实保留缺口。

## Consequences

报告回答的是"哪个阶段没接上"，不能写成"回调从未发生"：`missing_hook` 只说明本行没有已关联的 hook 证据，没有 hook 证据不等于没有回调。聚合口径在字段命名与文档里保留这条区分。

插件失败码在当前安装版上不可远程读取，只能靠合成测试与宿主日志间接验证。调大宿主 `gatewayTimeoutMs` 只影响 `collector_host_abort` 一种原因，实验结果不能外推到其余五种。

窗口比较要求前后两次使用同一组端点；`--until` 是观察时点，两次窗口的右端不同，`settled_missing` 的阈值也随之移动。命令只读，不取维护锁，可以在采集器运行时执行。

提高超时不恢复历史正文，也不提供持久投递保证；没有稳定关联锚点的失败回调仍可能无法对账。ATC 既有缺失标注保持原义，历史无正文不因配置变化宣称已恢复。

## Testing

[tests/hook-delivery.test.ts](../../../../tests/hook-delivery.test.ts) 覆盖窗口切分（窗口外请求不进、早于阈值才算 settled）、四个缺口出口（`missing_with_sources`、`missing_without_response_id`、`awaiting_candidate`）、按状态码/类别/体积分档与未知值单列、hook 到达侧的回复缺失与正文降级、`ingest_issue` 聚合，以及命令的窗口校验（缺端点或非法值退出 2、倒置区间退出 1 并报 `invalid_window`）。

[tests/hook.test.ts](../../../../tests/hook.test.ts) 锁定插件侧归因：单次超时重试后仍是 `collector_attempt_timeout`；宿主中止只调用一次、记 `collector_host_abort`；连接失败重试两次后记 `collector_network_error`；成功记 `collector_delivered` 且不留状态码；接收方在 650 ms 后返回 200 仍记 `collector_attempt_timeout`，两次尝试的总耗时不短于一次单次截止。

`tests/hook-delivery.test.ts`、`tests/hook.test.ts`、`tests/hook-identity.test.ts`、`tests/evidence.test.ts`、`tests/maintenance.test.ts` 共 85 项通过，`tsc --noEmit` 通过。真实流量的窗口对比未执行：本轮只有合成数据，生产快照仅用于确定问题形状。
