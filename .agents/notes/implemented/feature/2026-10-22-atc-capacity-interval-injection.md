# Agent Note: 作业计时与容量间隔只走显式配置

Status: implemented

## Problem

容量基线需要每个摄取作业的耗时、路由读取计数，以及比生产常量更短的调度间隔来压缩实验时间。如果间隔从环境变量读取，生产部署就多出九个可调参数；如果作业不计时，报告只能看到端到端延迟，分不清是某个 tick 慢还是写入通道慢。

## Decision

`Config` 增加可选的 `intervals`，只允许九个固定作业名，值必须是正安全整数；`intervalOf` 是唯一读取点，缺省返回调用处的现有常量，非法值抛 `invalid_capacity_interval`。生产 `loadConfig` 不设置该字段，容量子进程用对象字面量构造配置时注入。

`guard` 在任务进入后开始计时，成功、抛错与停止中的任务都记一笔到 `CapacityMetrics.jobs`；`routeTick` 在 `readRouteFiles` 返回后记录文件数、按 `error` 分类的读取数，`unchanged` 暂记 0，等路由文件三态落地后再细分。

## Alternatives considered

**从环境变量读取间隔。** 生产面多出九个可调参数，且环境变量可能被误设成 0 或负数；显式注入让容量路径自己持有配置。

**在各自作业里计时。** 九个作业各写一遍开始与结束，漏掉一个就少一类样本；`guard` 是所有定时作业的唯一入口。

**只测端到端。** 端到端无法区分调度间隔、作业耗时与写事务等待，报告无法给出优化方向。

## Consequences

- `Config` 多一个可选字段；`assertCapacityIsolation` 仍只比较三个来源路径，不检查间隔。
- 作业计时包含 `await` 的 I/O 等待，不是纯 CPU 时间；长作业的最大值容易被文件读取放大。
- 被防重入挡下的 tick 不计时，报告看到的是实际执行次数。
- `route.unchanged` 在路由三态落地前恒为 0，不能据此判断去重效果。

## Testing

`bun test tests/capacity.test.ts tests/maintenance.test.ts`：缺省返回常量、显式注入覆盖、未配置的作业保持缺省、0 与非整数被拒绝；`bun run typecheck` 检查 `Config` 新字段没有破坏现有构造点。
