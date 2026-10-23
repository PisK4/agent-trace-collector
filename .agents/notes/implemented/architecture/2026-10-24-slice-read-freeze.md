# Agent Note: 切片读侧未迁移，启用路径拒绝切片模式

Status: implemented

## Problem

发布指针这个 seam 只有写侧接电：`startCollector` 见到 `config.deriveBudget` 就设 `store.deriveRuntime`，deriveTick 从此把结果写进代际表并切指针；而读模型（`queries.ts` 的 `derivedStateOf`）只读 `request` 派生列，`readEffectiveGroup` 与 `effective_request` 视图零生产调用方。切片模式下 `request` 旧派生列不再被写，库里的旧值若恰好满足三连判据，读侧会把过期的派生结果当成现行结论——不报错，只显示错。

容量决策（[切片不启用](../feature/2026-10-22-atc-capacity-decision.md)，878.7 s 对 1.96 s 的实测）让这个缺口今天无害，但「不启用」记录在 note 里，不是代码里的结构保证：将来谁把派生预算接进生产配置，静默错读就发生。`docs/architecture-design.md` 还写着「读切片结果不走它们」，代码一直没有兑现这句承诺。

## Decision

生产启用路径放结构化断言：`startCollector` 见到 `deriveBudget` 且调用方未声明容量实验身份（新参数 `options.capacityExperiment`）时，以 `slice_read_unmigrated` 拒绝启动，拒绝发生在开库之前、维护锁检查之后。容量采集器（`scripts/capacity-collector.ts`）是唯一豁免方：它的读数走 `readEffectiveGroup`，不消费 `request` 派生列，显式传 `capacityExperiment: true` 起切片进程。`scripts/capacity.ts` 在自己的 store 上直接设 `deriveRuntime`，不经过 `startCollector`，不受影响。读模型改经 `published_generation` 取派生结果落地之日，断言与豁免参数一起拆除。

## Alternatives considered

**读模型接电发布指针，把 seam 读完。** 对称、彻底，但同步模式没有发布指针，读取得按模式分流，等于为一个实测后决定不启用的模式建读机制——替不存在的读者修路。冻结比接电便宜，也不碰[容量决策](../feature/2026-10-22-atc-capacity-decision.md)定下的口径。

**只写决策 note，不动代码。** 约束力与现状相同：依赖将来读 note 的人恰好记得这条。断言把同一句约束放进启用路径，忘了也过不去。

**断言放进 `drainDeriveEntry`，见到 runtime 就拒绝。** 容量实验台自己也走这个入口（`capacity.ts` 与 `capacity-collector.ts` 都调它），在那里拒绝等于拆掉实验台。拒绝只该拦生产启用，不该拦显式实验。

## Consequences

- 生产配置无论将来怎么接上派生预算，读模型迁移完成前切片模式起不来；错误码 `slice_read_unmigrated` 直接指回这里的决策。
- 容量采集器多一个显式参数：声明实验身份才能起切片进程，豁免留在调用点可见，不进配置文件——配置面是生产词汇，不该出现「允许已知错读」这种旋钮。
- `docs/architecture-design.md` 的读口径一节按现状改写：读模型未迁、视图无生产调用方、启用路径拒绝；「读切片结果不走它们」那句撤下，等迁移落地再写回。
- 首个 `main.ts` 直测文件（`tests/main.test.ts`）覆盖拒绝与豁免两条路径；进程装配的其余部分（timer、server、信号）仍留给端到端用例。
