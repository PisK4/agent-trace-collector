# Agent Note: 维护 CLI 的输入门与退出码口径

Status: implemented

## Problem

2026-11-04 的系统巡查在维护 CLI 上查出四个输入与失败口径缺口（[缺陷清单](../../proposed/bug-fix/2026-11-04-open-bug-findings.md) F35/F34/F32/F08）：

- `purge-metadata --before` 只做 `YYYY-MM-DD` 形状正则，不校验日历也没有上界；删除谓词是字符串比较 `day < ?`，`--before 2027-01-01` 或 `2026-13-01` 会把当时全库 77,417 行全部命中，`--apply --approval-id` 一过就删。
- `maintain verify` 无论 `integrity`、悬空块、重复证据是什么都输出 `ok:true`、退出 0；以退出码或 `ok` 字段判定的自动化会把损坏库当成通过。
- `hook-delivery` 的日期简写走 `Date.parse`，纯日期按 UTC 零点解析，而 `day` 列与页面按本地日；Asia/Shanghai 下窗口整体偏 8 小时，漏掉本地日的前 8 小时、带入次日的前 8 小时。
- 装监控、换机器、数据目录指向旧库时，没有启动前的 schema 兼容预检；不兼容要等服务启动失败才暴露，浪费一次停服窗口。

`purge-metadata` 的预览与 `--approval-id` 门来自[维护锁与备份探测](../process/2026-10-20-maintenance-lock-and-backup-probe.md)，本篇在它之上补输入侧的门，不反转原有语义。

## Decision

### purge-metadata 的日期门与全库放行

`--before` 在 CLI 解析层过三道门：`YYYY-MM-DD` 形状、日历合法性、不得晚于今天的本地日。日历校验用字段回读（构造后 `getUTCFullYear/Month/Date` 必须与输入一致），`2026-02-31` 这类会被 `Date` 构造静默滚到 3 月的输入直接拒绝，报 `invalid_before`，退出 2；未来日报 `before_after_today`，同样退出 2。删除谓词永远见不到非法输入。

全库命中要求显式放行：预览后若命中数等于 `request` 全表行数且大于 0，`--apply` 必须再带 `--allow-all`，否则输出 `ok:false`、`error: allow_all_required` 并退出 1，拒绝输出里带预览计数。`--approval-id` 的语义不动，仍是执行授权；`--allow-all` 表达的是「这个范围我确认要删」。预览（不带 `--apply`）不受门限制，命中全库也照常计数。`purgeMetadata` 与删除主干 `purgeTargetsTx` 零改动。

## Testing

`tests/maintenance.test.ts` 新增 CLI 用例：非法日历（`2026-13-01`、`2026-02-31`、`2026-1-01`）与未来日退出 2，库未被改动；部分命中 `--apply` 不需要 `--allow-all`；全库命中拒绝、带 `--allow-all` 后删除数与预览一致。全部合成数据。

## Alternatives considered

**F35 只靠预览让人发现全量命中。** 预览确实把 `requests` 显示为全量，但自动化或赶时间的操作员会直接接 `--apply`；输入侧拒绝把错误挡在删除谓词之前，预览留给人核对，不承担拦截。落选。

## Consequences

未来日期不能再用于预清理（例如提前导入的数据要按未来日截断）；真有这个需求时加显式旗标，而不是放开上界。`--before` 等于今天仍允许，「删今天之前」的语义不变，命中是否全库由计数门兜底。校验只长在 CLI 入口，直接调 `purgeMetadata` 的代码路径（目前只有 CLI 与测试）不受保护。
