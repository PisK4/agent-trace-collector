# Agent Note: 容量实验只用确定性合成来源与隔离子进程

Status: implemented

## Problem

容量基线必须可重复，且绝不能读到本机真实账本、路由或默认数据目录。手工准备合成数据容易把真实会话带进来，直接在测试进程里启动采集器又会让观测计时与负载端共用事件循环，量到的延迟不再干净。

## Decision

`scripts/capacity-support.ts` 提供固定种子伪随机数、合成 hook envelope、账本行与路由行，以及只由临时根构造的 `Config`。共享历史逐字节固定，只有末尾用户消息随 hook id 变化，便于验证增量与指纹。请求与回复的字节数取序列化后的实际值，目标尺寸只作输入。

`scripts/capacity-collector.ts` 是子进程入口：读取临时根里的 JSON 配置，先跑 `assertCapacityIsolation`，再调用 `startCollector`，打印 `collector_listening:<port>`。假上游只回答版本探针与空用量页，不做转发。`waitForCollector` 等待监听端口，超时或提前退出都显式失败。

## Alternatives considered

**在测试进程内直接启动采集器。** 负载端与采集器共用事件循环，测到的事件循环延迟没有意义；子进程还让停止条件可以显式控制。

**连接本机 magpie 取真实来源。** 真实账本与路由超出实验授权，且无法固定输入；合成行覆盖同样的解析路径。

**用随机数生成全部正文。** 每轮字节都不同，指纹与增量无法复现；固定种子只让规模与顺序变化。

**按目标字节数报告请求大小。** 序列化后会加协议字段，目标值不是测量值；报告只认实际 `request_bytes`。

## Consequences

- 合成正文里不含真实会话、账号或模型名；报告与日志可以提交。
- 生成器的目标字节数是下界，实际 envelope 会略大；报告用实际值。
- 假上游的响应形状只覆盖探针与用量页，不能验证 magpie 的真实分页行为。
- 子进程启动失败时 `waitForCollector` 必须由调用方杀掉进程并清理临时根。

## Testing

`bun test tests/capacity.test.ts`：同一种子产生同一序列；配置只落在临时根且上游端口不一致时被拒；合成 hook 与账本行可被真实解析器接受且请求/回复字节覆盖目标。`bun run typecheck` 覆盖子进程入口的配置类型。
