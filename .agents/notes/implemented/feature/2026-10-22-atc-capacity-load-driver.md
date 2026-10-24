# Agent Note: 容量负载由场景矩阵驱动并只写合成报告

Status: implemented

## Problem

容量基线要能重复跑同一组请求速率、时长与正文混合，并且每次只碰临时数据。手工用压测工具打本机采集器，既没有统一的报告形状，也无法保证不读到真实账本、路由或默认数据目录。把采集器放进负载进程还会让两侧共用事件循环，量到的延迟不再反映真实调度。

## Decision

`scripts/capacity.ts` 把场景参数集中在 `scenarioPlan`：默认 10 秒，只有 `--full` 才启用 600 秒，且必须同时给 `--acknowledge-long-run`。`requiresLongRunAck` 把 10 分钟、10,000 笔长组与 `all` 收在同一个闸门里。测试只查矩阵，不启动负载。CLI 还接受 `--duration-ms`、`--rps`、`--requests`、`--seed`、`--report`、`--body-budget` 与 `--disk-limit`，所有数值都有上界。

每个 HTTP 场景都建 `mkdtempSync(join(tmpdir(), 'atc-capacity-'))` 新根，起假上游，写 `collector.json`，再用 `scripts/capacity-collector.ts` 在子进程里启动采集器。负载端只在回环端口发请求：先追加账本与路由行，再按种子与序号生成 `hook_id` 并发送。读线程按间隔访问会话、请求与正文页，非 2xx 计入 `client.query_failed` 并使报告失败。另一个 1 秒定时器取 `/api/ingest-metrics`，记录 rss 与存储峰值。刻度按绝对时间推进，`scheduledTicks(durationMs, rps)` 决定总数，落后不补也不顺延。所以在途上限 `plan.concurrency`（5 rps 为 4，1 rps 与其余场景为 1）满了就记 `client.ticks_dropped`，不会自动降速。`launched`、`ticks_scheduled`、`ticks_dropped`、`in_flight_peak` 四个计数一起进报告；`offeredShortfall` 把少发的刻度写成 `offered:<launched><<ticks_scheduled>` 进 `conservation.missing`，使报告失败。停止输入后每 100 ms 读一次队列快照与 `/api/stats`。三个计数（未发布组、`pending_hooks`、`open_gaps`）要连续静默 `SETTLE_STABLE_MS`（5 秒，长于采集器最慢的来源间隔）才算收敛，或等到超时（场景时长加 120 秒）。只等派生队列，末尾几个还没与账本对账的 hook 会多出请求行，守恒随即失败；只看"这一刻为 0"，则会撞上账本读取与 hook 对账的下一个间隔——收敛读数为 0、紧接着的终值快照又出现脏组。终值快照里的脏组由 `finalQueueMissing` 写成 `pending_groups_final:` 缺口，报告失败。随后取最终快照、停子进程、用只读连接做守恒核对并写报告。`pending_hooks` 与 `open_gaps` 进 `conservation`，非零时同时写入 `missing` 并使报告失败。`rss_peak_bytes`、`storage_peak`、`peak_samples` 来自这些实际快照，`storage_end` 保留停止后的终值。

`burst` 先为十笔请求写好账本与路由行，再同时发 10 个 4 MiB 请求，第一个请求体用分块流延迟 50 ms 以覆盖 `ingesting` 互斥，完成后重放第一个 `hook_id`。没有账本行时，hook 只能留下永不收敛的 `pending_hook`。429/503 的重试窗口约 2.55 秒，足够单线程采集器把十笔大请求排空，短窗口会让最后一笔耗尽重试。`long` 直接 `openStore` 建临时库，用 `persistBody` 写一笔组内全部请求并逐笔入队，再 `drainDeriveTx`。增量结果与 `rebuildDerived` 后的全量结果各算一次指纹，写进 `full_incremental_equal`。`route` 在同一个采集器上追加路由、把当日文件替换成 gzip、写坏 gzip 后修复，并增加跨午夜文件。`retention` 注入 5 秒 retention/raw_prune 与 10 秒 cost 间隔，预置 8 天前的 raw 行。用户未显式给预算时，把正文预算压到 4 KiB 以触发驱逐；停止后用只读连接核对预置 raw 行已清空。

报告的字段形状与预算形状只在 `scripts/capacity-gate.ts` 里定义类型，负载端、预算端与门槛端共用同一份。`budget` 子命令从 `all` 的汇总报告冻结预算，写 `--out` 指定的文件并输出其 sha256 与未达成项，退出 0。输入不合或预算生成失败时退出 2，不产出一份半成品预算。`calibrate` 仍未实现，以退出码 2 明确拒绝，不伪造校准结果。预算的判定规则与「未达成目标留在预算里」的口径见[容量预算从计划刻度冻结](2026-10-22-atc-capacity-budget-gate.md)，决策收敛见[容量决策](2026-10-22-atc-capacity-decision.md)。

守恒核对把 `request_evidence` 按 `req_id` 去重。账本与 hook 各留一行证据是正常关联结果，不代表多收了一笔。报告在计划形状上增加 `config.dataDir`、`config.concurrency`、`client.query_failed`、`client.launched/scheduled/dropped/in_flight`、`collector.storage_end` 与 `collector.peak_samples`；burst 的并发峰值与周期负载共用 `client.in_flight_peak`。

## Alternatives considered

**直接用本机压测工具打真实采集器。** 没有统一的报告形状，参数靠操作者记，且很容易把真实来源或默认数据目录带进来。

**在负载进程内启动采集器。** 两侧共用事件循环，事件循环延迟与写事务时延都会被负载端自己的调度污染。子进程还能由停止条件显式控制。

**每个场景各写一份启动逻辑。** 临时根、假上游、令牌、守恒与报告会重复五份，任何一份漏掉隔离断言都可能读真实数据。

**`--full` 不要求确认。** 一次误输入就会跑 10 分钟并占用本机。闸门放在参数解析与场景规划两处，测试覆盖禁用分支。

**等响应再睡、一次只在途一笔。** 每轮的睡眠量由"上一笔耗时"决定，采集器慢就自动少发，于是 5 rps 档在 10 分钟里只发出 1,703 笔（约 2.84 rps），报告却仍 `ok:true`，任何档位都能这样"通过"。改成绝对刻度加有界在途后，"计划发多少"与"实际发多少"分开记账，少发的刻度直接让报告失败。

**在途请求不设上限。** 开放回路能让计划速率一定发出去，但采集器跟不上时会把几千个 1 MiB 正文压在负载端内存里，量出来的失败原因变成负载端的 OOM。上限取 `plan.concurrency`，逼近上限的情况由 `in_flight_peak` 暴露出来。

**少发刻度只记在 `notes` 里。** 只写在说明里，读者仍会看到 `ok:true` 的 5 rps 报告。缺口进 `conservation.missing`，才能让门槛与人都停在同一处事实上。

**三个计数第一次同时为 0 就收工。** 停输入不等于来源读完。账本要按自己的间隔补读，hook 要按对账间隔合并，两次都会再插进请求并把组标脏，于是收敛读数是 0、终值快照却有脏组。要求连续静默一个窗口，并把终值快照里的脏组也计入缺口。

**按证据行数核对守恒。** 账本与 hook 对同一请求各有一行证据，按全部行数会把正常关联算成缺口。按请求去重才对齐负载端账目。

**用目标正文大小写报告。** 序列化后的 envelope 会多出协议字段，目标值不是测量值；报告只认实际 `request_bytes`。

## Consequences

- 报告全部来自合成数据与临时根，可以直接保存。子进程退出后临时根删除，只剩调用方指定的报告文件。
- `drain_ms` 包含采集器默认的 2 秒派发间隔与 5 秒静默窗口。短场景的 `drain_ms` 因此主要是这两个等待，不能当作派生耗时读。
- 有界在途让时延分位包含排队。`hook_latency` 读出的是计划速率下客户端看到的总时延，采集器的处理耗时只是其中一部分。这层含义由 `config.concurrency` 与 `in_flight_peak` 一起限定，读数不得当作单笔服务时间。
- 刻度总数由时长与速率算出（10 分钟 5 rps 为 3,000），因此报告能自证是否真把这一档施加上去。采集器跟不上时，报告给出的是 `ticks_dropped` 与 `offered:` 缺口，而不是一份看起来更慢但通过的基线。
- `long` 的 `comparisons` 按单组前缀比较数 `n(n-1)/2` 计算，`decodes` 按可解码正文行数统计，二者都在 `notes` 里注明口径，不是进程内计数器。
- `rss_peak_bytes` 与 `storage_peak` 是采样最大值，不是连续监控：HTTP 场景每 1 秒一次，burst 两次，long 三次。`peak_samples` 让读者判断分辨率。
- 1 秒一次的峰值采样本身会给采集器增加读取与存储度量开销。报告记录采样次数，预算冻结时要把这部分开销算进基线。
- 路由场景按文件源的三态（`decoded` / `unchanged` / `error`）计数：`.gz` 命中指纹、`.jsonl` 无新提交偏移都记 `unchanged`，因此 `route.unchanged` 就是这一轮真正跳过的文件数，可用于判断去重效果。
- 正文页按服务端的 `PAGE_MAX` 取一页。计划示例里的 65536 超过上限，只会得到 `invalid_body_range`，量不到正文序列化。
- 不可重试的 HTTP 失败立即计入 `client.failed`，不等最后一次尝试。重试只留给 429、503 与网络错误，窗口约 2.55 秒。
- 回收场景默认 4 KiB 正文预算只在用户未显式给 `--body-budget` 时生效。正文峰值低于预算 90% 时，报告注明回收未触发，报告仍可能 `ok:true`。
- `conservation.pending_hooks` 与 `open_gaps` 只在 HTTP 场景可测。`long` 直接建库，两者恒为 0。非零会让报告 `ok:false`，不会静默通过。
- 停输入后的收敛等待包含账本读取与 hook 对账，通常要多等一个 5 秒读取周期。这段时间计入 `drain_ms`，短场景的 `drain_ms` 因此明显大于派生耗时。
- `calibrate` 退出 2，不会伪造校准结果。`budget` 已可用，从 `all` 的汇总报告冻结，单场景报告会被拒绝。
- 计划示例测试与 `scenarioPlan` 有三处不一致：`full: true` 的示例没有写 `acknowledgeLongRun`，正文混合写的是 0.35 MiB 而不是代码里的 350 KiB，10,000 笔长组也没有确认。测试按代码取显式确认、350 KiB 与长组闸门。

## Testing

`bun test tests/capacity.test.ts`：场景矩阵固定 600 秒/1 rps/350 KiB 与 2 MiB 混合（5 rps 的并发上限为 4）、5 rps、突发 10 并发 4 MiB、长组 2,000 与 10,000 笔，以及未确认长跑被拒；另覆盖 `requiresLongRunAck` 的全场景/10 分钟/长组分支、`scheduledTicks` 的 3,000/600/零时长/零速率、`offeredShortfall` 的两条分支与峰值追踪。`bun run typecheck` 覆盖 CLI、报告与预算类型。

本任务实跑的短场景全部使用临时根与合成正文：smoke 5 秒（10 次接受、`query_failed=0`、峰值采样 6 次）、burst（观察到 `busy>0`，重试后 10 个唯一请求全部 200、重复一次不增加唯一计数、`pending_hooks=0`）、baseline-1rps 30 秒（30 次接受、请求行 30、`pending_hooks=0`、`open_gaps=0`）、5 rps 60 秒（300 个刻度全部发出、`ticks_dropped=0`、接受 300、在途峰值 4、`hook_latency` p95 208 ms、`pending_hooks=0`）、long 50 笔（`full_incremental_equal=true`、`pending_groups_end=0`）、route 21 秒（`decoded>0`、坏 gzip 产生 `errors`）、retention 12 秒（`raw_prune.count>=1`、预置 raw 行剩余 0、正文峰值高于终值，回收已触发）。10 分钟基线、2,000/10,000 笔长组与 `all` 未在本任务运行。
