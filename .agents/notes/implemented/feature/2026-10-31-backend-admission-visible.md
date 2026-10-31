# Agent Note: 顶栏显示后端存储准入

Status: implemented

## Problem

存储准入降级是静默的。总盘占用到 80% 后，采集器切到 `metadata_only`：只收元数据，新请求的正文不再保存。库里有记录（`collector_state` 的 `["retention","admission"]`），`/api/stats` 不返回，页面也不显示。

本机出现的一次真实情况：数据目录里有 5 个开发期备份，共约 9.3 GB，把逻辑占用推到 12.79 GB，占 16 GB 阈值的 79.96%。准入在 14:23 切到 `metadata_only`，持续约 3.8 小时。这段时间采集的请求没有正文，读者在页面上只看到「正文未到」，找不到原因，也没有任何入口提示。恢复条件是跌回 75% 以下，滞回带卡住时不会自己退回。

容量门槛与恢复条件见[运维手册](../../../../docs/operations.md#容量与回收)；正文预算的判定在 `src/retention.ts` 的 `admission`。

## Decision

顶栏在降级时显示一个标签，正常态不占位置。

### 1. 状态从 `/api/stats` 读出

`getStats` 增加 `admission`：读 `collector_state` 的 `["retention","admission"]`，返回 `{mode, reason, at_ms}`；未记录、JSON 非法或缺 `mode` 时返回 null，等同 normal。只读一次表，不新增量测；`/api/ingest-metrics` 的完整快照不进页面。

### 2. 只在降级时出现

`web/backend-state.js` 的 `backendStateText` 决定标签：

| mode | 标签 | 说明 |
| --- | --- | --- |
| `metadata_only` | 存储降级 · 正文暂停（warn） | 只收元数据，新请求的正文不再保存；账本、路由与元数据仍在接收 |
| `paused` | 存储降级 · 采集暂停（bad） | 写入被拒绝，新证据不入库 |
| `normal`、null、未知模式 | 不渲染 | 正常态不带装饰性状态 |

原因短语只区分 `body_budget` / `disk_budget` / `disk_free` 三种已知码，其余按磁盘预算写；不推断哪些数据已经丢失。

### 3. 读取时机与交互

- 启动、显式刷新（`refreshWindow`）各读一次 `/api/stats`；不轮询，页面其余读取路径不增加请求。
- 标签本身是按钮：点按重新读一次。读取失败保留上一次显示，不把未知冒充正常，也不清掉已知降级。
- 文案放在 `title` 里，不加常驻说明文字，沿用前端降噪约定。

## Alternatives considered

**轮询准入状态。** 落选：页面没有轮询机制，为准入单独加一条定时请求，代价大于收益；准入变化是分钟级事件，显式刷新与点按足够。

**把完整容量快照接进页面（体积、页数、回收计数）。** 落选：读者需要的是「现在有没有降级、为什么」，完整快照属于运维诊断，留在 `/api/ingest-metrics` 更合适。

**在会话头或中栏显示。** 落选：准入是采集器全局状态，不属于某个会话或某笔请求；会话头已承载会话身份与合计，再加一层会挤占阅读。

**把降级原因写到每笔请求上。** 落选：`miss_reason` 已经写着 `disk_body_paused`，逐笔重复一遍是同一事实的第二个家，且会与请求级证据混淆。

## Consequences

收益：降级可见，读者能分清「上游没给正文」与「本机暂停保存正文」；点按即可确认是否已经恢复。

代价与风险：

- 顶栏在降级时多一个元素。正常态为空串，宽度不变；窄屏（≤620px）crumb 已隐藏，标签保留，实测宽 121px、高 26px。
- 只在启动、刷新与点按时更新，可能滞后于实际切换。标签写着「点按重新读取」，不承诺实时。
- 准则是全局的：同一时刻所有会话都受影响，标签不按会话区分。
- 本次没有自动清理磁盘，也没有提示备份该放在哪。数据目录内的旧备份继续计入 `total_bytes`，这是运维动作，不是产品行为。

### Testing

- `tests/queries.test.ts`：`collector_state` 写入准入记录后 `getStats().admission` 原样读出。
- `tests/http.test.ts`：`/api/stats` 的键集合含 `admission`；静态白名单覆盖 `backend-state.js`。
- `tests/web.test.ts`：`metadata_only` 与 `paused` 两种标签与原因短语；`normal`、null、未知模式返回空串，不占顶栏。
- `bun run typecheck` 通过。另起临时服务，向 `collector_state` 分别写入 `metadata_only`、`paused` 与 `normal`，在浏览器里确认前两种出标签（warn/bad）、`normal` 顶栏为空；截图已随临时目录清理。

### Deferred

- 准入切换时页面不主动刷新，需要读者刷新或点按。
- 数据目录内的旧备份没有自动移出机制，`maintain backup` 也不限制输出位置。
