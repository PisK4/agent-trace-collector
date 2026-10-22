# Agent Note: 容量负载由场景矩阵驱动并只写合成报告

Status: implemented

## Problem

容量基线要能重复跑同一组请求速率、时长与正文混合，并且每次只碰临时数据。手工用压测工具打本机采集器，既没有统一的报告形状，也无法保证不读到真实账本、路由或默认数据目录。把采集器放进负载进程还会让两侧共用事件循环，量到的延迟不再反映真实调度。

## Decision

`scripts/capacity.ts` 把场景参数集中在 `scenarioPlan`：默认 10 秒，只有 `--full` 才启用 600 秒，且必须同时给 `--acknowledge-long-run`；`requiresLongRunAck` 把 10 分钟、10,000 笔长组与 `all` 收在同一个闸门里；测试只查矩阵，不启动负载。CLI 还接受 `--duration-ms`、`--rps`、`--requests`、`--seed`、`--report`、`--body-budget` 与 `--disk-limit`，所有数值都有上界。

每个 HTTP 场景都建 `mkdtempSync(join(tmpdir(), 'atc-capacity-'))` 新根，起假上游，写 `collector.json`，再用 `scripts/capacity-collector.ts` 在子进程里启动采集器。负载端只在回环端口发请求：先追加账本与路由行，再按种子与序号生成 `hook_id` 并发送；读线程按间隔访问会话、请求与正文页，非 2xx 计入 `client.query_failed` 并使报告失败；另一个 1 秒定时器取 `/api/ingest-metrics` 记录 rss 与存储峰值。停止输入后每 100 ms 读一次队列快照，直到未发布组为 0 或超时（场景时长加 120 秒）；随后取最终快照、停子进程、用只读连接做守恒核对并写报告。`rss_peak_bytes`、`storage_peak`、`peak_samples` 来自这些实际快照，`storage_end` 保留停止后的终值。

`burst` 同时发 10 个 4 MiB 请求，第一个请求体用分块流延迟 50 ms 以覆盖 `ingesting` 互斥，完成后重放第一个 `hook_id`；429/503 的重试窗口约 2.55 秒，足够单线程采集器把十笔大请求排空，短窗口会让最后一笔耗尽重试。`long` 直接 `openStore` 建临时库，用 `persistBody` 写一笔组内全部请求并逐笔入队，再 `drainDeriveTx`；增量结果与 `rebuildDerived` 后的全量结果各算一次指纹，写进 `full_incremental_equal`。`route` 在同一个采集器上追加路由、把当日文件替换成 gzip、写坏 gzip 后修复，并增加跨午夜文件。`retention` 注入 5 秒 retention/raw_prune 与 10 秒 cost 间隔，预置 8 天前的 raw 行；用户未显式给预算时把正文预算压到 4 KiB 以触发驱逐，停止后只读核对预置 raw 行已清空。

报告的字段形状与预算形状只在 `scripts/capacity-gate.ts` 里定义类型，负载端与后续门槛端共用同一份；门槛加载与判定尚未实现。`budget` 与 `calibrate` 子命令只做分发，当前以退出码 2 明确表示未实现。

守恒核对把 `request_evidence` 按 `req_id` 去重：账本与 hook 各留一行证据是正常关联结果，不是多收了一笔。报告在计划形状上增加 `config.dataDir`、`client.query_failed`、`collector.storage_end` 与 `collector.peak_samples`；`client.concurrency_peak` 仍只出现在 burst。

## Alternatives considered

**直接用本机压测工具打真实采集器。** 没有统一的报告形状，参数靠操作者记，且很容易把真实来源或默认数据目录带进来。

**在负载进程内启动采集器。** 两侧共用事件循环，事件循环延迟与写事务时延都会被负载端自己的调度污染；子进程还能由停止条件显式控制。

**每个场景各写一份启动逻辑。** 临时根、假上游、令牌、守恒与报告会重复五份，任何一份漏掉隔离断言都可能读真实数据。

**`--full` 不要求确认。** 一次误输入就会跑 10 分钟并占用本机；闸门放在参数解析与场景规划两处，测试覆盖禁用分支。

**按证据行数核对守恒。** 账本与 hook 对同一请求各有一行证据，按全部行数会把正常关联算成缺口；按请求去重才对齐负载端账目。

**用目标正文大小写报告。** 序列化后的 envelope 会多出协议字段，目标值不是测量值；报告只认实际 `request_bytes`。

## Consequences

- 报告全部来自合成数据与临时根，可以直接保存；子进程退出后临时根删除，只剩调用方指定的报告文件。
- `drain_ms` 包含采集器默认的 2 秒派发间隔；短场景只能作为冒烟，不用于冻结预算。
- `long` 的 `comparisons` 按单组前缀比较数 `n(n-1)/2` 计算，`decodes` 按可解码正文行数统计，二者都在 `notes` 里注明口径，不是进程内计数器。
- `rss_peak_bytes` 与 `storage_peak` 是采样最大值，不是连续监控：HTTP 场景每 1 秒一次，burst 两次，long 三次；`peak_samples` 让读者判断分辨率。
- 1 秒一次的峰值采样本身会给采集器增加读取与存储度量开销；报告记录采样次数，但预算冻结时要把这部分开销算进基线。
- `route.unchanged` 仍由采集器的路由入口写死为 0，路由场景目前只能观测 `decoded` 与 `errors`；三态计数要等文件源改造后才能体现。
- 正文页按服务端的 `PAGE_MAX` 取一页；计划示例里的 65536 超过上限，只会得到 `invalid_body_range`，量不到正文序列化。
- 不可重试的 HTTP 失败立即计入 `client.failed`，不等最后一次尝试；重试只留给 429、503 与网络错误，窗口约 2.55 秒。
- 回收场景默认 4 KiB 正文预算只在用户未显式给 `--body-budget` 时生效；正文峰值低于预算 90% 时报告注明回收未触发，报告仍可能 `ok:true`。
- `budget` 与 `calibrate` 在 Task 7 前退出 2，不会伪造预算或校准结果。
- 计划示例测试与 `scenarioPlan` 有三处不一致：`full: true` 的示例没有写 `acknowledgeLongRun`，正文混合写的是 0.35 MiB 而不是代码里的 350 KiB，10,000 笔长组也没有确认；测试按代码取显式确认、350 KiB 与长组闸门。

## Testing

`bun test tests/capacity.test.ts`：场景矩阵固定 600 秒/1 rps/350 KiB 与 2 MiB 混合、5 rps、突发 10 并发 4 MiB、长组 2,000 与 10,000 笔，以及未确认长跑被拒；另覆盖 `requiresLongRunAck` 的全场景/10 分钟/长组分支与峰值追踪。`bun run typecheck` 覆盖 CLI、报告与预算类型。

本任务实跑的短场景全部使用临时根与合成正文：smoke 5 秒（10 次接受、`query_failed=0`、峰值采样 6 次）、burst（观察到 `busy>0`，重试后 10 个唯一请求全部 200、重复一次不增加唯一计数）、long 50 笔（`full_incremental_equal=true`、`pending_groups_end=0`）、route 21 秒（`decoded>0`、坏 gzip 产生 `errors`、`unchanged=0`）、retention 12 秒（`raw_prune.count>=1`、预置 raw 行剩余 0、正文峰值高于终值，回收已触发）。10 分钟基线、2,000/10,000 笔长组与 `all` 未在本任务运行。
