# Agent Note: 生产切片启用等待读取完整性与容量验收

Status: implemented

## Problem

切片派生把结果写入代际表，读侧必须按发布指针取得整组一致的结果。旧同步列继续存在，任何遗漏的读取路径都有可能把过期结果当成现行结论；仅有结果表和指针无法证明实际页面读取完整。查询与 reading token 已接入发布代，依据见[整套选源](../feature/2026-10-24-published-derivation-reading.md)，但生产切片的实际发布、算法切换与长组容量仍需单独验收。

[切片等价性与容量实测](../feature/2026-10-22-atc-slice-equivalence.md)记录长组切片排空 878.7 s、同步 1.96 s；[容量决策](../feature/2026-10-22-atc-capacity-decision.md)保留 5 rps 目标未达成的判断。生产冻结必须由启用路径保证，不能因为一组读取测试通过就顺带改变运行模式。

## Decision

生产启用路径放结构化断言：`startCollector` 见到 `deriveBudget` 且调用方未声明容量实验身份（新参数 `options.capacityExperiment`）时，以 `slice_read_unmigrated` 拒绝启动，拒绝发生在开库之前、维护锁检查之后。容量采集器（`scripts/capacity-collector.ts`）是唯一豁免方：它的读数走 `readEffectiveGroup`，不消费 `request` 派生列，显式传 `capacityExperiment: true` 起切片进程。`scripts/capacity.ts` 在自己的 store 上直接设 `deriveRuntime`，不经过 `startCollector`，不受影响。解除冻结需要读取完整性与容量同时满足，读代接入本身不解除断言。当前接口与剩余验证范围见[架构设计](../../../../docs/architecture-design.md#派生代际与发布指针)。

## Alternatives considered

**以发布代读取接入作为解除冻结的依据。** 查询接入解决选源，但不验证实际切片的发布与算法切换，也不能缩短长组排空时间；运行模式仍遵守[容量决策](../feature/2026-10-22-atc-capacity-decision.md)。

**只写决策 note，不动代码。** 约束力与现状相同：依赖将来读 note 的人恰好记得这条。断言把同一句约束放进启用路径，忘了也过不去。

**断言放进 `drainDeriveEntry`，见到 runtime 就拒绝。** 容量实验台使用[派生工作单元](../../../../src/derive-unit.ts)的排空入口，容量采集器使用同模块的在线入口；在那里拒绝会阻止实验台工作。拒绝只拦生产启用，显式实验继续验证切片。

## Consequences

- 生产配置不能通过派生预算启用切片；保留错误码 `slice_read_unmigrated`，它表达启用尚未验收，不能再用于断言查询完全没有发布代读取。
- 容量采集器多一个显式参数：声明实验身份才能起切片进程，豁免留在调用点可见，不进配置文件——配置面是生产词汇，不该出现「允许已知错读」这种旋钮。
- 架构设计分别描述现有读代能力与启用限制，避免把合成读代验收写成容量已达标。
- `tests/main.test.ts` 覆盖拒绝与豁免两条路径，并验证在线来源接线；信号与真实进程生命周期仍留给端到端用例。
