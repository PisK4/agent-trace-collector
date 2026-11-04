# Agent Note: 读侧一致性与派生重试

Status: implemented

## Problem

[2026-11-04 巡检清单](../../proposed/bug-fix/2026-11-04-open-bug-findings.md)里四个读侧与派生调度缺陷（F15/F33/F40/F23）同批落地，按「性能优先、不阻塞主线程、数据保存正确性、展示顺序性」取舍：

- `session_usage` 主键 `(agent, session)` 以 `agent` 开头，会话摘要按 `session` 取累计用量（`WHERE session=? ORDER BY agent LIMIT 2`）只能全表扫描；droid 会话数上来后线性变差。
- `/api/stats` 缓存只按进程内写世代（`store.writeStats.count`）失效，外部进程（回填脚本、手工 SQL）的写不改计数，旧值可无限期留在缓存里；`computeStats` 十条独立查询不包读事务，外部写落在查询之间会把混合快照按旧世代缓存住。
- 请求列表 keyset 游标的排序键 `started_ms` 会被账本投影原地改写、行会被合并删除；forward 游标不绑定会话，跨会话复用静默返回另一会话的一页。
- 同步派生整轮失败后队列里没有 `attempts`/`last_error`，看不出失败原因；失败的组每 2 秒重试一次、无上限。

## Decision

### F15：`session_usage` 加 `(session, agent)` 读侧索引（schema v13）

`src/schema-v13.sql` 一条 `IF NOT EXISTS` 索引，`schema.sql` 同步；`store.ts` 升 `SCHEMA_VERSION` 到 13，新增 `execAdditiveV13` 并进所有迁移分支，v12 库有专属分支——生产库打开即建索引。备份白名单 `RESTORABLE_SCHEMA_VERSIONS` 补 13。索引只服务读侧，按 `agent` 前缀的写路径仍走主键，不回填数据。验收钉在测试里：`EXPLAIN QUERY PLAN` 从 `SCAN session_usage` 变为 `SEARCH … USING INDEX i_session_usage_session`。

### F33：stats 缓存加 TTL，十条聚合包进同一读快照

`STATS_TTL_MS = 5_000`：世代命中之外再要求缓存年龄小于 TTL，外部写最迟 5 秒反映到统计；同时把轮询放大的全量重算压到最多每 5 秒一次。`computeStats` 整体包进 `store.read.transaction`，十条查询吃同一个读快照，混合快照不再可能按旧世代缓存住。世代缓存本身保留，进程内安静期仍然零成本。

### F40：请求游标绑定会话与方向

两个方向的游标统一成 `['forward'|'older', conv_key, started_ms, req_id]`：标签校验方向（混用拒绝）、`conv_key` 校验会话（跨会话复用返回 `invalid_cursor`，HTTP 层映射 400）、`req_id` 是不可变键并按安全整数校验。缺会话绑定的旧两元组 forward 游标一并拒绝——部署后在途的旧游标收到一次 400，页面重取首屏即恢复。会话列表「翻页期间有新请求的会话会移到游标之前、本轮不再出现」与 `started_ms` 改写的漏行/重复窗口写进 [架构设计](../../../docs/architecture-design.md)的查询接口契约表，不改排序键。

### F23：派生失败写回队列，整轮失败指数退避

`claimGroupTx` 认领即写 `attempts=attempts+1, last_error=NULL`，与切片路径 `beginGeneration` 同义（认领计数，不是失败计数）；新增 `recordDeriveFailureTx` 在整轮异常后把错误码与 `last_completed_ms` 写回未完成组，队列里从此看得出哪个组、为什么反复重试。在线调度整轮失败按 `deriveRetryBackoffMs` 退避：2 秒起步、连续失败翻倍、60 秒封顶，成功一轮清零。永久失败的判据先固定口径写进注释——同一 `input_revision` 下 attempts 达上限仍失败且非锁类瞬态——「到上限即丢弃」等生产队列观察到 attempts/last_error 分布后再实现。

## Alternatives considered

- **F33 每次请求全量重算**：十条查询压到每个请求，冷页一次 200–570 ms，监控轮询会把 IO 放大一个量级。清单一开始就否决；TTL 是保留缓存的失效下界。
- **F40 上服务端快照（copy-on-read）**：翻页要冻结整份会话视图、引入快照生命周期，为 P3 的瞬时漏行买一个常驻机制不成比例。最小修先落，快照 id 留给真出现「一次翻到底必须完整」的需求。
- **F40 游标锚定 `req_id` 当前位置**：decode 时查回游标行最新的 `started_ms` 能治游标行自己被改写，但行前移时会重发已展示的区段——把一类错误换成另一类，不做。
- **F15 调整主键顺序使 `session` 成为前缀**：写侧按 `(agent, session)` upsert（`source_hash` 判变化的覆盖写）会退化，动主键还牵连 WITHOUT ROWID 的存储形状；additive 索引两边都不伤。
- **F23 全局超时并丢弃失败组**：没有可复现的永久失败组，丢弃不可逆且 attempts 分布未观察，先记录与退避，判据与上限留给下一批。

## Consequences

- 代价：schema v13 迁移（毫秒级，见[运维手册](../../../docs/operations.md#schema-版本)）；部署后在途旧 forward 游标收到一次 400；stats 每 5 秒最多一次全量重算；`attempts` 从 0 起持续累计；全局退避让失败之后到达的新工作最多等 60 秒才进派生；失败组仍按字母序挡在候选位上，永久失败期间它后面的组照旧不被处理（现状不变，只便宜了 30 倍）。
- 收益：droid 会话量的增长不再线性拖慢会话摘要；外部写最迟 5 秒可见、混合快照不可能再被缓存；跨会话游标复用与方向混用从静默错数据变成 400；派生失败从「每 2 秒空转且无痕迹」变成「可见、退避、有上限」。
- Supersession check：[监控健康批修](2026-11-04-monitoring-health-batch-fixes.md)持有 getStats 写世代缓存的决定并把「短 TTL 缓存」列为落选方案；本批部分取代它——世代缓存保留，TTL 为进程外写入补上失效下界，F06 的落选理由（进程内安静期付费）由世代命中继续成立，该 note 保留并在后续同步回链。[认领边界](../architecture/2026-11-03-derive-claim-boundary.md)的 `claim_from_sort` 语义不变，本批只在同一条 UPDATE 上补记账列。

## Testing

合成数据：v12 库降版重开验证索引就位；`session-summary` 的 EXPLAIN 钉住 `SEARCH` 形状；stats 的外部写 + 时钟推进验证 TTL 失效、spy 验证单读事务；游标的跨会话、方向混用与旧形状三路 400 加 1825 笔无漏重既有用例；`derive-state` 与 `derive-unit` 钉住认领计数、失败写回与退避序列（触发器制造合成失败）。主线程接线的指数退避常量由 `derive-state` 测试覆盖，`main.ts` 内的接线本身没有直接用例。
