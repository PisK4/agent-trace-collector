# ATC 容量基线记录

本文件记录一次完整基线实验的环境、命令、产出与门槛结论。判据是 [2026-10-22-atc-capacity-budget.json](2026-10-22-atc-capacity-budget.json)；测量口径与实测数字在 [process note](../../../.agents/notes/implemented/process/2026-10-22-atc-capacity-baseline.md)；为什么把未达成的目标留在预算里，见 [plan](../../superpowers/plans/2026-10-22-atc-capacity-convergence.md) 的 Task 6 与 Task 11。

## 被测版本与环境

| 项 | 值 |
| --- | --- |
| 被测提交 | `4da9307`（`src/` 与 `scripts/capacity.ts` 的最后一次改动） |
| Bun | 1.4.0 |
| 系统 | macOS 27.0.1，Apple M5 Pro |
| 场景组合 | `all --full --acknowledge-long-run`，八段共 1,420,061 ms |
| 报告 | `/private/tmp/atc-capacity-reports/baseline-all.json`（sha256 `fc2eb638cb724e600cfb2b31507e6d549675df4c954a66281b8592db4d240b21`，留在仓外） |
| 预算 | `docs/superpowers/capacity/2026-10-22-atc-capacity-budget.json`（sha256 `3daf270a64978b4fa1ac7a1df18cc3e5db57a4b9057645d43bbcc8a55b388bb9`） |

## 命令

```sh
bun scripts/capacity.ts --scenario all --full --acknowledge-long-run \
  --report /private/tmp/atc-capacity-reports/baseline-all.json
bun scripts/capacity.ts budget \
  --report /private/tmp/atc-capacity-reports/baseline-all.json \
  --out docs/superpowers/capacity/2026-10-22-atc-capacity-budget.json
bun scripts/capacity-gate.ts gate \
  --budget docs/superpowers/capacity/2026-10-22-atc-capacity-budget.json \
  --report /private/tmp/atc-capacity-reports/baseline-all.json
```

门槛退出 1，输出 12 项失败。汇总与单场景两种报告输入都可判；本次用汇总一次覆盖全部场景，不逐个场景分文件。

## 门槛结论

| 场景 | 失败项（实际 / 上限，来源） |
| --- | --- |
| `baseline-1rps` | `query_latency_p95_ms` 152.85 / 100、`event_loop_p99_ms` 183.45 / 100 |
| `baseline-5rps` | `hook_latency_p95_ms` 3791.55 / 2000、`hook_latency_p99_ms` 4613.04 / 2500、`query_latency_p95_ms` 4086.10 / 100、`event_loop_p99_ms` 1994.51 / 100、`max_write_tx_ms` 5294.03 / 900（`proposed`）、`ticks_dropped` 969 / 0、`accepted` 与 `launched` 与 `request_rows` 2031 / 2970 |
| `long-10000` | `max_write_tx_ms` 1959.35 / 900（`proposed`） |

通过场景：`smoke`、`burst`、`long-2000`、`route`、`retention`。

三个失败场景记在预算的 `unmet` 段。它们的产品目标不下调：`baseline-5rps` 实测只投递 3.39 rps（3,000 个刻度丢弃 969 个），`long-10000` 的单笔写事务 1,959 ms，`baseline-1rps` 的事件循环 p99 越过 100 ms —— 三者指向同一处机制：`drainDeriveTx` 每个脏组整组重算，脏组集合大小与组内累计请求数共同决定每轮成本。

## 路由解码对照

路由入口改成"先按字节哈希、未变就不解压"（`4e36138`）之后重跑同一场景：

```sh
bun scripts/capacity.ts --scenario route \
  --report /private/tmp/atc-capacity-reports/route-after.json
bun scripts/capacity-gate.ts gate \
  --budget docs/superpowers/capacity/2026-10-22-atc-capacity-budget.json \
  --report /private/tmp/atc-capacity-reports/route-after.json
```

| 读数 | 优化前（`baseline-all.json` 的 `route` 段） | 优化后（`route-after.json`） |
| --- | --- | --- |
| 时长 / 轮询 | 29,006 ms / 38 | 29,004 ms / 38 |
| `route.files_seen` | 94 | 95 |
| `route.decoded` | 88 | 31 |
| `route.unchanged` | 0 | 58 |
| `route.errors` | 6 | 6 |
| `conservation.route_rows` | 40 | 40 |
| `conservation.evidence_rows` | 30 | 30 |
| `conservation.missing` | `[]` | `[]` |

解压次数从每轮每文件各一次降到 88 → 31；未变命中 0 → 58。剩余的解压来自本轮确实变过的文件：负载端每秒往当日 `.jsonl` 追加一行路由，3 秒一次的变更脚本还会替换成 `.gz`、写入损坏 gzip 与次日文件，这些都必须重新解压才能看见。

证据集合一一对应：`route_rows` 40 与 `evidence_rows` 30 在前后两轮相同，`missing` 两轮都为空，替换与跨午夜没有漏行也没有重复。

门槛对单场景报告照常判两项：`route` 自身零失败项；退出码 1 来自另外七个场景在这份单场景报告里缺席（这条判定是有意的，见 [feature note](../../../.agents/notes/implemented/feature/2026-10-22-atc-capacity-budget-gate.md)）。

## 口径与已知偏差

- 这一轮测量期间，同一台机器还跑过几秒的 `typecheck` 与测试（Task 7 的实现工作与基线重叠）。独立跑的那次 `baseline-1rps` 里 page 读 p95 是 33 ms、事件循环 p99 是 112 ms，这一轮分别是 152.85 ms 与 183.45 ms。两项在两轮里都超过 100 ms 的产品目标，事件循环这一项可信；page 读这一项按被污染记录，不作为结论。
- 正因单轮包络方差大于"一成半余量"，预算里有时延与写事务目标值的指标直接用目标值，不拿单轮包络收紧。
- 报告的 `storage_peak` 与 `storage_end` 不同属正常：前者是 1 秒采样的最大值，后者是停止后的终值，`peak_samples` 给出采样次数。
- `route` 的 `unchanged` 在这一轮基线里恒为 0：当时的采集器路由入口尚未区分"文件未变"，解压次数因此等于文件数 × 轮询数。该入口改成先哈希后解压之后，对照读数在「路由解码对照」一节。
- 报告与预算都在仓外或已提交的小文件里，不含真实请求正文、令牌或真实数据目录。