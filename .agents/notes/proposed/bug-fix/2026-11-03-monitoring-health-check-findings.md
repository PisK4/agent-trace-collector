# Agent Note: 后台监控体检发现的缺陷清单（持续记账）

Status: proposed

## Problem

2026-11-03 后台监控（`local.agent-trace-monitor`，每 300 秒采样、每 30 分钟巡检）已连续运行 3 小时 27 分，采样链路健康，但告警通道从 14:24 起常亮，巡检的几条判据（退出码、诊断错误、告警配对、断档阈值）实际不可信。用户决定今天只记账、不修，晚上统一处理。

这份记录是当晚修复的工作清单，不是监控方案本身：方案见 [后台监控提案](../process/2026-11-03-background-monitoring.md)。记录时间 2026-11-03 17:45–18:00，全部读数来自只读检查（未启动/停止服务、未改文件、未写库）。

读数基线：`monitor/samples/2026-11-03.jsonl` 43 行、14:12:08–17:39:45、70,108 字节、43/43 `ok:true`；`monitor/alerts/2026-11-03.jsonl` 7 行；`monitor/logs/` 为空；采集器 instance `56474-mw0ai9cm`，启动 14:11:32，运行版本 `46240dd`（当前 HEAD `a9107df`，未重启）。22:57 复核：samples 105 行、alerts 21 行、`monitor/logs/` 仍为空、实例为 `27838-mw0ra0dm`（22:01 启动）；F26–F32 的库内读数取 22:57 只读快照（`request` 53,224 行）。

F26–F30 记录于 2026-11-03 晚，来源是重启后新实例 `27838-mw0ra0dm`（代码 `868882f`）上 `/api/sessions` 退化的只读诊断：全部读数来自 `VACUUM INTO` 快照副本，未改代码、未写生产库、未重启、未提交。F31–F32 来自同日晚另一路只读核查（主页左栏空卡），证据来自生产库只读查询与既有代码行号，同样未改代码、未重启。

## 今日汇总（F01–F32）

| 编号 | 严重度 | 一句话现象 | 证据等级 | 状态 | 修复依赖 |
| --- | --- | --- | --- | --- | --- |
| F18 | P0 | Codex 集成的 schema 9→10 半成品改动（已补完并合并上线） | 实测 | 已修 | — |
| F23 | P0 | 迁移失败即停机，且无自动重建、无自动备份 | 实测 | 已修（流程入 operations.md；执行随 11-04 回归窗口） | 先于任何重启 |
| F26 | P0 | `/api/sessions` 跨组标题绑定是相关标量子查询，O(页内会话数 × request 行数) | 实测 | 已修 | 已落地（`396342b`）；绑定未验证，依赖 F28 |
| F27 | P0 | 会话列表在主线程同步计算，服务端零并发保护 | 实测 | 已修（A 单飞） | 排 F26 之后评估 |
| F28 | P0 | `user_fingerprint` / `turn_ref` 存量全空；title 指纹通道断 | 实测+代码 | 已修（title 通道） | 独立；先于 F24 回填验收 |
| F32 | P0 | unknown-actor 的 `["request",…]` 组从不进派生队列，标题恒空 | 实测 | 待修（P2） | 展示已由 tool_event 折叠兜住；另立批次 |
| F07 | P1 | 探针 5066 ms 尖峰；17:20–17:24 有 7.8–10.8 s 停顿未被捕获 | 实测+推断 | 待修 | 与 F06/F09 合并 |
| F08 | P1 | `check` 恒 `return 0`，作业层看不见 `sample` 失败 | 实测 | 已修 | 无 |
| F09 | P1 | `event_loop_p99` 阈值 100 ms 未校准，告警常亮 | 实测 | 已修（330 ms/30 min + max 2 s 通道） | 采纳 F22 的 330 ms |
| F10 | P1 | 命中消失即写 `recovered`，无持续窗口 | 实测 | 已修（15 分钟恢复窗口） | 与 F12 同处合并 |
| F11 | P1 | `derive_failed` 不进结构化诊断 | 实测 | 已修 | 无 |
| F14 | P1 | `spawnSync('launchctl')` 无容错，受限环境栈崩 | 实测 | 已修 | 无 |
| F16 | P1 | 日志轮转分支从未被真实触发 | 待查 | 已验证（launchd fd 实测 O_APPEND） | 需非生产副本实测 |
| F17 | P1 | 巡检任务自身没有执行记录 | 待查 | 已修（inspect 落盘） | 无 |
| F19 | P1 | 活跃会话的已知偏离（排序、活跃区、降级文案） | 待查 | 待查 | 先补证据 |
| F20 | P1 | v9→v10 迁移在 3.91 GB 副本上阻塞 2.04 s | 实测 | 已完成 | 生产已迁移 |
| F22 | P1 | p99 阈值建议 330 ms（区间 310–350） | 实测 | 已采纳 | 并入 F09 |
| F24 | P1 | 仅重启不会让四条 Codex 会话收敛，需显式 rebuild | 实测 | 执行层（11-04 回归窗口做） | 依赖 F28 |
| F25 | P1 | 运维语义：重启 ≠ Codex 集成生效 | 实测 | 已修（operations.md 部署顺序） | 依赖 F24 |
| F29 | P1 | 前端 `sessionsLoading` 是布尔闸门，不共享 Promise | 实测（代码） | 已修（Promise 共享） | 放大 F27 |
| F31 | P1 | `source:web_search` 被判成主链参与（实为辅助） | 实测+代码推断 | 已修（判据+折叠） | 存量行 retained 不翻判，见收起方案 note |
| F01 | P2 | `schema_rebuild_required` 13 段崩溃栈 + 10-12 至 10-24 数据缺口 | 实测+待查 | 已修（错误信息带版本；预检未做） | 无 |
| F02 | P2 | `derive_failed:database is locked` 1 条 | 实测 | 已修（写连接等锁 5 s） | 无 |
| F03 | P2 | `hook_absent_marked` 5,114 批次 / 7,420 行 | 实测+推断 | 待修 | 与 F04 |
| F04 | P2 | `pending_hooks` 1,348 行只增不减（22:57：1,351 / 孤儿 1,349） | 实测 | 已修（孤儿 14 天保留期） | 与 F03 |
| F05 | P2 | `cost_health = null` 属正常态 | 实测 | 已作废（非缺陷） | — |
| F06 | P2 | 慢请求 top：stats 常态 200–571 ms、ingest-metrics 2.5 s | 实测 | 已修（世代缓存 + 量测复用） | 与 F09/F27 |
| F12 | P2 | `trailingRun` 超 `maxGapMs` 截断，语义混用 | 实测 | 已修（连续性容差=存活阈值） | 与 F10 |
| F13 | P2 | 11 分钟断档阈值与巡检时延偏松 | 实测 | 已修（sample_gap 提醒） | 无 |
| F15 | P2 | `storage=null` 被当 0 参与容量比较 | 复核未复现 | 未证实（疑似误报） | — |
| F21 | P2 | 重启前基线：stats p95 1.16 s、sessions p50 39.3 ms | 实测 | 已完成（待复采） | 重启后复采 |
| F30 | P2 | 冷页缓存固定成本 ~2.4 s 会定期复发（F26 影响下的上界） | 实测（上界） | 待查 | 修完 F26 复测 |

今日无 P3 条目。

## 同日其它 bug-fix 笔记（交叉引用，不改其正文）

- [2026-11-03-session-title-dirty-scan.md](./2026-11-03-session-title-dirty-scan.md)：脏组会话标题子查询做全量扫描（`GET /api/sessions?limit=50` p50 462 ms，四个标题子查询 226 ms；包 `CASE WHEN EXISTS(clean 队列行)` 后 0.4 ms）。与 F26 是**同一类**「相关子查询在无命中时仍扫完整组」的写法，只是触发条件是组 dirty、位置在原有标题四路；F26 是跨组绑定这一路的同类放大。两者修法可复用同一短路思路，但候选①只短路跨组分支，不覆盖 F04 之外的脏组场景，验收要分开写。
- [2026-11-03-admission-storage-measure-block.md](./2026-11-03-admission-storage-measure-block.md)：准入量测 `measureStorage` 在本机 3.85 GB 库上单次 111–190 ms，ledger tick 每 5 秒调用一次，是事件循环 p99 的独立来源。这条与 F27 的「主线程同步」同属事件循环阻塞，但发生在准入闸门而非 sessions 查询，修复路径独立（分块刷新 + 闸门读缓存值），不能与 F27 的 A/B/C/D/E 混为一谈。
- 上述两篇都是 `Status: proposed` 的方案笔记，没有 F 编号；本表不替它们编号，只做交叉引用。

## 今天尚未归档的待定项（不属于 finding，尚未归档）

1. **主页样式 8 组问题**：用户已批准方向，等 HTML Demo 定稿后再落方案，暂不进入 finding 清单。
2. **6 条 `(无标题)` 及 18:34 那批可疑数据核查**：已核查完毕并归档为 **F31 / F32**（18 张 `source:web_search` 卡的成因、414 个 `["request"` 前缀 key 不进派生队列、18:34 三条为同一次编排广播）。剩余「是否还有其他批次」不单列，若发现新证据再开新 finding。
3. **`maintain rebuild` 未执行**：Codex 集成因此尚未真正生效；属 F24/F25 的执行层待办，不是新 finding。
4. **master 领先 origin 二十余笔未 push**：发布节奏问题，非缺陷。
5. **监控定时任务频率待定**：10 分钟断档阈值、巡检 15 vs 30 分钟仍未拍板，属 F13 的方案分支，不单列。

## Findings

### F01 `schema_rebuild_required` 的 13 段崩溃栈

- **现象**：`agent-trace-collector.err.log` 开头有 13 段完全相同的启动期崩溃，全部停在 `migrate`。
- **证据**：`grep -c "^error: schema_rebuild_required$"` = **13**；栈固定为 `at migrate (src/store.ts:42:43)` → `at openStore (src/store.ts:68:3)` → `at startCollector (src/main.ts:61:17)`，随后是 `Bun v1.4.0 (macOS arm64)`。栈里的 `store.ts:42` 与当前代码不符：当前 HEAD（f96a5df，合并 Codex 集成后）`SCHEMA_VERSION` 在 src/store.ts:145、抛错在 src/store.ts:241，说明这是旧构建的栈。`err.log` birth **2026-10-21 16:04:32**，13 段位于最前 176 行；`trace.db` birth **2026-10-24 10:48:03**。精确到分钟的崩溃时间**拿不到**（stderr 无时间戳）。
- **当前一致性**：`PRAGMA user_version` = **9**，代码 `SCHEMA_VERSION` = **9**，一致，无待迁移版本。
- **数据缺口**：库内 `request` 最早 2026-10-24 10:48:03，按日统计 10-24 起才有行；源侧 `~/.config/magpie/usage.jsonl` 最早记录是 2026-10-12。10-12 至 10-24 的请求**没有进库**。这是「首跑从文件尾部起算」还是「崩溃期丢弃」**未证实**：`source_cursor` 只记录当前偏移，没有初始偏移证据，`source_gap` 为 0。
- **影响**：历史数据完整性存疑（用户可见的历史缺口）；对今天的实时采集无影响。
- **可能根因**（已证实部分）：旧库 `user_version < SCHEMA_VERSION`，当时 v3 起没有原地升级路径，src/store.ts:240-241 直接抛错（当前代码已支持 v6+ 原地升级）；launchd `KeepAlive` 反复拉起，形成 13 次启动失败，最后删库重建（10-24 10:48）。
- **建议修法**：`migrate()` 的错误信息里带上 `version` 与 `SCHEMA_VERSION`，让 stderr 直接说明「旧库 vN 需删库重建」；`verify-cutover`/`maintenance` 增加只读预检，避免装完监控才发现。数据缺口需另开任务核对 `usage.jsonl` 的初始游标语义。
- **优先级**：P2。**是否阻塞其它工作**：否（已恢复）。

### F02 `derive_failed:database is locked`（1 条）

- **现象**：stderr 里 583 条 `derive_failed` 中有 1 条不是 `derive_input_changed`，而是 SQLite 写锁失败。
- **证据**：`err.log:186`（第 186 行）原文 `derive_failed:database is locked`，紧跟在 13 段崩溃后的首次成功启动（`hook_absent_marked:81`）之后；**精确时间拿不到**（stderr 无时间戳），按位置推断在 2026-10-24 重建后首轮摄取/重放期间。
- **并发场景**：写事务统一 `BEGIN IMMEDIATE` + `PRAGMA busy_timeout=1000`（src/store.ts:249-264，Worker 侧 src/derive/worker-entry.ts:32）。任何写锁被占用超过 1 秒，竞争写者就抛 `database is locked`。重建首轮 `derive` 落盘、`pending`、`cost`、`retention` 同时在跑，最可能撞车。具体是哪两个写者竞争**未证实**（无锁等待日志）。
- **影响**：该轮派生整轮丢弃、组重新标脏，下一轮重算；无请求失败、无用户可见丢数据（按 `derive_input_changed` 同路径处理）。
- **可能根因**（推断）：`busy_timeout=1000` 短于首轮重放时的写冲突窗口。
- **建议修法**：把 `derive` 落地事务的等待上限提高（如 5s）或让重放在启动期串行化（`main.ts` 定时器在首次 replay 完成前不启动 `derive`）；并把该错误写进结构化诊断（见 F11）。
- **优先级**：P2。**是否阻塞其它工作**：否。

### F03 `hook_absent_marked` 5114 行

- **现象**：stderr 每隔 5 秒就可能打印一次 `hook_absent_marked:<n>`，累计 5114 行。
- **证据**：`hook.ts` 的 src/hook.ts:480 = 1 小时，src/hook.ts:495-520 每轮把「等满 1 小时仍无正文、且等待队列没有指向本行」的 request 标成 `miss_reason='hook_absent'`，每轮上限 200。5114 是**批次数**不是行数：17 种批次大小，绝大多数是 1，最大一批 81。
- **规模与分布**：库内 `miss_reason='hook_absent'` 共 **7,420** 条；按 agent：claude 6,269、hermes 639、magpie 344、omp 113、zcode 37、curl 5、codex 5、Python-urllib 4、AsyncOpenAI 3、OpenAI 1。今天新增约 91 条。
- **影响**：正文缺失的请求被明确标注，属数据完整性问题，不是监控噪音；claude 占 84%，说明回调大面积没有送达或无法关联。
- **可能根因**（推断）：设计内的兜底标注 + claude 侧 hook 未安装/未回调（或 response_id 缺失导致无法关联）。不是监控代码 bug。
- **建议修法**：不需要改标注逻辑；需要排查 claude 侧 hook 安装与 `response_id` 回传（见 F04 的孤儿队列），并考虑把该标记做成结构化诊断计数而不是 stderr 噪音。
- **优先级**：P2。**是否阻塞其它工作**：否。

### F04 `pending_hooks` 1348 与 `issues` 2

- **现象**：`pending_hook` 表 1348 行，只增不减；`issues` 恒定 2 条。22:57 复核 1,351 行，其中 1,349 条无 `response_id`；同时出现 2 条带 `response_id` 的新回调（22:53），说明正常回填路径存在，无 `response_id` 的孤儿仍没有淘汰。
- **证据**：43 条样本里 `pending_hooks` 从 **1339 → 1348**（197 分钟 +9，约 65 条/天），`requests` 52,056 → 52,875。库内查询：1348 行全部 `response_id_norm IS NULL`、全部 `candidates IS NULL`；最早 `first_seen` **2026-10-24 10:59:45**（积压 10 天），最新 2026-11-03 17:37:40。src/hook.ts:442-474 只做「合并」，没有 TTL 清理，因此这些无 response_id 的孤儿回调永远留在表里。
- **issues 明细**（`ingest_issue` 表，`/api/stats` 的 `count` 实为行数）：7 行 `service_not_registered`，ref_key 为 `service/codex_exec/2026-10-26`、`service/codex-app-server/{2026-10-26,11-01,11-02,11-03}`、`service/codex-exec-server/{2026-10-26,11-03}`；1 行 `span_shape_unknown`，ref_key `8147cca770477c7d53e99897e4a38152/c0785a355b3efb36`，观测于 2026-10-26 12:02:13。
- **影响**：孤儿队列无界增长（当前 1348 行，量小）；`issues` 反映 codex 服务未登记，属 F18 集成未完成的连带现象。
- **可能根因**（已证实部分）：`pending_hook` 无淘汰路径；`response_id_norm` 为 NULL 时永远不可能有候选。`span_shape_unknown` 是单个祖父 span 形状未识别，**未证实**具体形状（需要 raw 层属性）。
- **建议修法**：给 `pending_hook` 增加保留期（如 14 天）并在 `reconcilePending` 里顺手清理，或在 `/api/stats` 里把「无 response_id 的孤儿」单列；codex 服务登记随 F18 一起解决。
- **优先级**：P2。**是否阻塞其它工作**：否。

### F05 `cost_health = null`

- **现象**：`/api/stats` 返回 `cost_health: null`。
- **证据**：src/queries/stats.ts:55-70 只在 `collector_state` 存在 `["cost","clock_conflict"]` 时返回值；库内该 key **不存在**，所以 null 表示「从未检测到系统时钟回退」，不是链路断了。旁证：`cost-window` 10-24 至 11-03 全部 `done:true`，今天 `full_done_at` = 1793698415333（17:33:35），`total` 2356；`jobs.cost` 运行 203 次、`write|cost` 慢日志 81 条。
- **影响**：无。属正常态。
- **可能根因**（已证实）：无回退事件，字段按设计为 null。
- **建议修法**：不改逻辑；可在文档/巡检说明里写清「null = 正常」，避免巡检误判为缺失。
- **状态**：已作废（非缺陷）。
- **优先级**：P2。**是否阻塞其它工作**：否。

### F06 慢请求 top（原文与频率）

- **现象**：诊断日志 3 小时 35 分内 222 条 `kind:"slow"`，0 条 error、0 条 unclassified。
- **证据**（UTC 原文，本地 +8）：
  - `/api/ingest-metrics` 4 条，max 2581 ms：
    `{"ts":"2026-11-03T06:43:40.669Z","kind":"slow","op":"http.read","phase":"/api/ingest-metrics","dur_ms":2581}`
  - `derive.compute` 49 条，max 1458 ms：
    `{"ts":"2026-11-03T09:12:17.544Z","kind":"slow","op":"derive.compute","corr":"round-1","phase":"compute","dur_ms":1458,"suppressed":10}`
  - `/api/stats` 46 条，max 571 ms：
    `{"ts":"2026-11-03T07:34:16.047Z","kind":"slow","op":"http.read","phase":"/api/stats","dur_ms":571}`
  - `write|cost` 81 条，max 391 ms：
    `{"ts":"2026-11-03T07:58:35.815Z","kind":"slow","op":"write","phase":"cost","dur_ms":391,"suppressed":1}`
- **触发条件与频率**：`/api/ingest-metrics` 是全量快照（含 `measureStorage`/metadata），每次调用固定 ~2.2–2.6 s，3.5 小时内只被调用 4 次，属**按需长尾**；`/api/stats` 每次探针（5 分钟）都会调用，46 条 ≈ 基本每次 > 阈值，属**常态**；`derive.compute` 每 2 秒一轮，49 条超阈值，属**常态长尾**（单组大、compute 在 Worker 内）；`write|cost` 每 60 秒一次，81/≈210 次 ≈ 39%，属**常态**。
- **影响**：`/api/stats` 常态 200–571 ms 是事件循环 p99 被顶高的直接来源之一（F09）；`/api/ingest-metrics` 2.5 s 会拖慢所有并发探针（F07）。
- **可能根因**：全量快照同步测量 + 4 GB 库上的聚合查询。
- **建议修法**：`/api/stats` 的 `pending_hooks`/`body_states` 走缓存或增量（src/queries/stats.ts:35-72）；`/api/ingest-metrics` 复用最近量测或改成异步任务；监控探针不要同时打两个重端点。
- **优先级**：P2。**是否阻塞其它工作**：否。

### F07 探针 5066 ms 尖峰

- **现象**：17:19:42 那条样本 `elapsed_ms=5066`，是 43 条里唯一 >1s 的探针，`state` 仍 `ok`。
- **证据**：同一采样点 `event_loop.max_ms=3589.9`、`jobs.pending.max_ms=3552`、`jobs.derive.max_ms=3758`、`jobs.retention.max_ms=3144`；前后两条探针为 157/204 ms。**它不是 7792/7816 那次停顿**：17:19 样本的累计最大值还是 3552/3758，7792/7816 在 17:24:43 才出现，且同一时刻 `event_loop.max_ms=10855`（17:24 的探针本身只有 204 ms，没抓到）。17:14:36 已有 2946/2826/2319 的前兆。
- **影响**：探针会被并发重任务拖慢，但离 15s 上限还远（34%）；更值得记的是 17:20–17:24 之间有一次 ~7.8–10.8 s 的停顿，没有被任何探针捕获。
- **可能根因**（推断，未证实）：`pending`（5s）、`derive`（2s）、`retention`（30s）在同一时刻堆叠，同步落盘占满主线程。需要看 17:20–17:24 的结构化日志才能确认具体是哪一轮。
- **建议修法**：把长事务移出主线程（`derive` 已在 Worker，检查 `pending`/`retention` 的同步写）；给探针加重试/分段计时，避免两个端点串行累加。
- **优先级**：P1（性能问题，可能影响摄取延迟）。**是否阻塞其它工作**：否。

### F08 `check` 退出码恒 0，作业层看不见 `sample` 失败

- **现象**：plist 的 `ProgramArguments` 是 `sh -c "<runtime> monitor.ts sample; <runtime> monitor.ts check"`，shell 取最后一条的退出码，而 `check` 恒 `return 0`。
- **证据**：scripts/monitor.ts:630-651 末尾 `return 0`（第 650 行）；`runSample` 失败时返回 1（第 608 行），但被 `;` 丢弃。`launchctl print` 读数**拿不到**（`permission denied: launchctl`，exit 126，绕沙箱重试同样失败）。
- **影响**：作业永远显示成功；采样失败只能靠人看 `monitor.log`。巡检的「作业是否成功」判据无效。
- **可能根因**（已证实）：`sh -c` 串行取末条退出码。
- **建议修法**：`sh -c '... sample && ... check'` 或拆成两个 Job；`runCheck` 在 `sample` 失败时返回非 0（把 sample 结果传入）。
- **优先级**：P1。**是否阻塞其它工作**：阻塞「用 launchd 状态判断监控健康」的验收方式。

### F09 `event_loop_p99` 阈值未校准，告警常亮

- **现象**：43/43 条样本 `event_loop.p99 > 100`（最小 139.8、中位 199.4、最大 260.5），告警从 14:24 起 active 195 分钟，6 次提醒、0 恢复。
- **证据**：`alerts/2026-11-03.jsonl` 7 行（1 alert + 6 reminder，14:54–17:24）；`alert-state.json` `since_ms` 对应 14:24；`THRESHOLDS.p99Ms=scripts/monitor.ts:310-370` 为 100。
- **影响**：告警失去区分力，巡检每次都看到「有告警」；真实故障会被噪音淹没。
- **可能根因**（已证实）：阈值按理想基线设定，未按本机常态（p99 中位 ~199）校准；`/api/stats` 与 `ingest-metrics` 自身就会把 p99 顶到 140–260。
- **建议修法**：阈值改到 300 ms 或改成「p99 > 300 且持续 30 分钟」；同时把 `/api/stats` 慢读排除出事件循环统计（F06）。
- **优先级**：P1。**是否阻塞其它工作**：阻塞「告警是否可信」的所有结论。

### F10 误恢复：命中消失即 `recovered`

- **现象**：`transitionAlerts` 在命中消失的当轮就写 `recovered`，没有持续窗口。
- **证据**：scripts/monitor.ts:375-403；此前复现：睡眠 40 分钟后再跑 `sample`+`check`，`hits=[]`、`events=[recovered:event_loop_p99]`，而最新样本 p99=198；停摆 12 小时同样静默；单样本回落（300→90）一次即 recovered。
- **影响**：睡眠/停摆/单点抖动会伪造恢复；巡检的「触发与恢复成对」判据不可信。
- **可能根因**（已证实）：状态机没有「连续 N 轮不命中」与「缺数据不判恢复」。
- **建议修法**：`transitionAlerts` 增加恢复窗口（如连续 3 个样本/15 分钟不命中）；`ctx.stale` 时只允许 `service_unreadable`，不得写 recovered。
- **优先级**：P1。**是否阻塞其它工作**：与 F12 同一处，合并修。

### F11 `derive_failed` 不进结构化诊断

- **现象**：583 条派生失败只在 stderr（`derive_failed:...`），结构化日志 0 条 `kind:"error"`。
- **证据**：`~/Library/Logs/agent-trace-collector.log` 974 条 JSON 里 `kind` 只有 `derive`(751)、`slow`(222)、`lifecycle`(1)；`derive_failed` 全部在 `.err.log`。巡检按「诊断日志里的错误」查得到 0。
- **影响**：Worker 失败/整轮丢弃成为巡检盲区（F02 的那条真实失败就是这么被漏掉的）。
- **可能根因**：运行版本 `46240dd` 的派生失败只写 stderr；当前 HEAD 源码里已找不到该字符串，无法直接引用行号（**未证实**是重构还是改写）。
- **建议修法**：派生失败统一走 `diagnostics.error('derive.run', {code:'derive_failed', phase})`，并按错误码限流；巡检同时读 stderr 作为兜底。
- **优先级**：P1。**是否阻塞其它工作**：阻塞「Worker 失败」判据。

### F12 `trailingRun` 超 `maxGapMs` 截断

- **现象**：相邻样本间隔超过 `maxGapMs`（7.5 分钟）就把连续命中窗口清零。
- **证据**：scripts/monitor.ts:295-305；一个 9 分钟断档就能让 p99 窗口从头开始，可能掩盖连续高延迟并触发 F10 的伪恢复。
- **影响**：断档后的判定与恢复都不可信。
- **可能根因**（已证实）：截断逻辑同时承担「防误判」与「连续性」，语义混用。
- **建议修法**：截断只影响「连续性」指标；告警窗口改用「时间跨度内命中占比」而不是「尾部连续段」。
- **优先级**：P2。**是否阻塞其它工作**：否（与 F10 一起改更省事）。

### F13 10 分钟断档阈值与巡检时延

- **现象**：`MISSING_SAMPLE_MS = 2 × 300s + 60s = 11 分钟`，对「存活」合适，对「连续」偏松；作业整体死掉时 `check` 也死，只剩 30 分钟巡检能发现。
- **证据**：scripts/monitor.ts:25-27；实测间隔 110/301/306 s，>360 s 断档 0，>600 s 0；最坏发现时延约 30–40 分钟。
- **影响**：监控停摆可能半小时以上才被发现；9 分钟的小断档又可能被当成正常。
- **可能根因**（已证实）：阈值按「允许丢 2 个采样点」设，未区分存活与连续性。
- **建议修法**：保留 11 分钟做「存活」判据，另加「连续性」判据（如 3 个周期内缺 1 条即提醒）；巡检降到 15 分钟，或加外部 mtime 心跳。
- **优先级**：P2。**是否阻塞其它工作**：否。

### F14 `spawnSync('launchctl')` 无容错

- **现象**：权限受限时 `monitor.ts report` 直接栈崩，而不是返回「读不到」。
- **证据**：scripts/service-support.ts:50-82、scripts/service-support.ts:123-129、`listeningPort`(lsof) 都没有 try/catch；今天跑 `bun scripts/monitor.ts report --days 1` 时因 `EACCES` 崩溃；`launchctl print` 读数**拿不到**。
- **影响**：巡检/人工排查在受限环境不可用；第 1 项体检读数缺失。
- **可能根因**（已证实）：`Bun.spawnSync` 抛异常未捕获。
- **建议修法**：三处包 try/catch，失败返回 `null` 并在报告里标「不可读」；`findServiceEntry` 的精确匹配失败也要有明确输出（scripts/service-support.ts:83-102）。
- **优先级**：P1。**是否阻塞其它工作**：阻塞「用 launchctl 验收」的巡检。

### F15 `storage=null` 的消费端行为（未证实，疑似误报）

- **现象**：`lightSnapshot` 在从未量测时返回 `storage:null`。原判断是「下游规则把 null 当 0 比较」，本次复核未能复现。
- **证据**：`src/capacity.ts:372-400` 只负责返回 null；唯一的下游容量规则在 `scripts/monitor.ts:358-359`，从监控作业引入起就显式 `if (storage !== null) {…}`（`686990d`，11-03 14:09），null 时整段跳过，不会参与比较。全仓未找到其他把 `storage=null` 当 0 的路径。本次 `storage` 全程新鲜（年龄 0.4–5.0 s），也未触发。
- **影响**：未观察到实际影响。
- **结论**：证据不足以定为缺陷，降为观察项；除非找到新的消费端证据，否则不建议改动。
- **建议修法（保留备用）**：若未来有消费端把 null 当 0，再对它显式产出 `storage_unmeasured`，不要让未知态参与容量比较。
- **优先级**：P2。**是否阻塞其它工作**：否。

### F16 日志轮转路径从未被真实触发

- **现象**：`monitor.log` 878 B、`monitor/logs/` 空，64 MiB 轮转分支一次没跑过。
- **证据**：scripts/monitor.ts:407-426 用 `copyFileSync` + `truncateSync`（launchd 持 fd，不能 rename）；实测 64 MiB copy 在 APFS 约 0.1 ms，理论窗口最多丢 1 行；launchd 打开的 fd 是否 `O_APPEND` **未验证**。
- **影响**：轮转可能静默丢行；「没报错」不能当验证通过。
- **可能根因**（理论风险）：fd 非追加模式时，截断后写入位置错乱。
- **建议修法**：用一个临时小阈值（如 1 MiB）在非生产副本上跑一次轮转，核对行数与首行；或把 rotate 改成「先写新文件、再切换符号链接」。
- **优先级**：P1（验证缺口）。**是否阻塞其它工作**：阻塞轮转的验收。

### F17 巡检任务自身没有执行记录

- **现象**：巡检每 30 分钟一次、据称已跑 6 次，但没有任何落盘记录。
- **证据**：`monitor/` 下只有 samples/alerts/monitor.log，没有巡检结果文件；`launchctl print` 读数拿不到；用户说的下次 17:31 在检查时（17:45）已过。**巡检执行次数/结果拿不到**。
- **影响**：无法核对「巡检是否真的在跑、上次结果如何」，也无法审计「沉默=正常」。
- **可能根因**（未证实）：巡检是外部调度（Agent 定时任务），不写仓库/数据目录。
- **建议修法**：巡检每次追加一行 JSON 到 `monitor/checks/<day>.jsonl`（时间、判据结果、告警数、退出码），成功也写。
- **优先级**：P1。**是否阻塞其它工作**：阻塞监控验收的闭环。

### F18 Codex 集成留下 schema 9→10 半成品改动

- **现象**：前一执行会话因输出窗口超限中断，仓库里留下 schema 版本 9→10 的未完成改动。
- **证据**：当时 master `SCHEMA_VERSION=9`（src/store.ts:144），DB `user_version=9`；半成品改动在另一会话/分支，**具体文件与 diff 状态未拿到**（已转交另一会话盘点，回执待收）。
- **影响**：若半成品被误合并/重启，会触发 F01 同类重建，可能造成数据缺口。
- **可能根因**（已证实部分）：长会话中断，未清理未提交改动。
- **建议修法**：盘点该分支的未提交文件，二选一：补完迁移与回放验证，或全部 stash/丢弃；在完成前禁止重启采集器。
- **优先级**：**P0**。**是否阻塞其它工作**：**是**，先于所有监控修复，避免又一次 schema 重建。
- **状态更新（2026-11-03 晚）**：半成品已补完并合并（前置 `11cd736`（P2 输入清洗）、`5d39fb9`（P0/P1），merge `a8c9752`）；生产实例已运行 v10（`PRAGMA user_version=10`）。**本条已修，关闭**。

### F19 活跃会话的已知偏离

- **现象**：排序立即生效、活跃区只覆盖已加载列表、断连/未知无降级文案、完成时间不参与最近活动。
- **证据**：来自前序 review 的已知偏离，**本次未重新取证**（未读活跃区实现与测试）。按用户要求记账。
- **影响**：用户可见的排序/会话列表行为与预期不一致。
- **可能根因**（未证实）。
- **建议修法**：待补：读 `src/queries`/活跃区实现与对应测试后再定，避免泛泛而谈。
- **优先级**：P1。**是否阻塞其它工作**：否。

### F20 v9→v10 迁移试跑：3.91 GB 副本上 openStore 阻塞 2.04 s

- **现象**：生产库只读 `VACUUM INTO` 快照 3.91 GB；用 HEAD 代码 `openStore` 触发 v9→v10 成功。迁移提交本体约 2.03 s，热缓存下总 open 2.04 s；`user_version=10`、两列与两个部分索引均就位，`integrity_check=ok`。存量 53,047 行新列为 NULL。
- **证据**：
  - 生产库 `trace.db` 4,030,124,032 B，`page_count=983,924`，`user_version=9`，WAL；只读快照 `/tmp/atc-migration/trace-v9.db` = 3,913,723,904 B，`VACUUM INTO` 耗时 4.35 s，快照 `integrity_check=ok`、`user_version=9`。
  - `openStore` 首次（v9→v10）：2,043.6 ms；同一副本迁移后再开：11.1 ms；差值 ≈ 2,032.5 ms，即迁移本体。逐条计时（bun:sqlite，另起干净副本）：ALTER `user_fingerprint` 0.41 ms、`turn_ref` 0.20 ms、`CREATE INDEX i_request_user_fingerprint` 2,047.3 ms、`CREATE INDEX i_request_turn_ref` 35.5 ms，合计 2,085.1 ms；首个索引扫描把整表读进页缓存，第二个索引因此只花 35 ms。
  - 迁移后：`PRAGMA user_version=10`；`request` 表新增 `user_fingerprint TEXT`、`turn_ref TEXT`；两个索引 SQL 与 `schema-v10.sql` 一致；`PRAGMA integrity_check=ok`；`request=53,047` 行，`user_fingerprint` 非空 0、`turn_ref` 非空 0；抽查最新 5 行两列为空。
  - 重启路径只调用 `openStore`（[main.ts:88]），启动代码不调用 `upgradePurposeTargetTx`/`drainDeriveTx`。副本上队列 1,134 组全部 `clean`，`purpose_pending=0`，空转 `drainDeriveTx` 1.9 ms（0 组/0 用途）。
  - 结论：**生产重启的迁移阻塞约 2.0–2.1 s（热缓存实测 2.04 s）；按 docs 的冷缓存基线 3.1 GB≈6.2 s、按 4.03 GB 线性外推约 8 s，规划上限取 8 s**。
- **影响**：重启窗口内 HTTP/ingest 停顿约 2 s（保守 8 s），一次性；不重写数据，不自动升级存量用途/组（见 F24）。
- **复现**：
  ```
  sqlite3 -readonly "$DB" "VACUUM INTO '/tmp/atc-migration/trace-v9.db'"
  bun /tmp/atc-migration/open-timed.ts /tmp/atc-migration/trace-openstore.db
  bun /tmp/atc-migration/breakdown.ts /tmp/atc-migration/trace-breakdown.db
  sqlite3 -readonly /tmp/atc-migration/trace-openstore.db "PRAGMA user_version; PRAGMA integrity_check; ..."
  ```
  全程只写 /tmp 副本；未对生产库写入、未 openStore 生产库、未重启或 kill 进程。
- **严重度**：P1（一次性启动停顿，非数据损坏；但必须按 ≥2 s、保守 8 s 预留重启窗口）。
- **建议**：低流量窗口重启；重启前按 F23 做人工备份；启动后先只读核对 `user_version=10` 与索引，再放流量；不要把 2 s 当成 SLA，冷缓存按 8 s 规划。
- **状态**：已完成。**状态更新（2026-11-03 晚）**：生产实例重启时已完成 v9→v10（`PRAGMA user_version=10`），原「生产未执行」的描述作废；上述 2.04 s / 外推 8 s 保留为迁移预算依据。

### F21 重启前基线：21:29:40–21:30:06，三端点各 15 轮 GET

- **现象**：实例 `56474-mw0ai9cm` 于 14:11:32 启动，已运行 7 h 19 m；RSS 237.8 MB；容量 4.03 GB（db 4.03 / body 1.51 / WAL 3.70 MB）；`pending_groups=0` 且无 `oldest_dirty_age_ms`；`event_loop` p99 285–287 ms、累计 max 5,589.7 ms。
- **证据**：
  - 采集窗口 2026-11-03 21:29:40.338–21:30:06.477（26.1 s），15 轮；HTTP 往返（ms）：

    | 端点 | min | p50 | p95 | p99 | max |
    | --- | --- | --- | --- | --- | --- |
    | metrics | 3.3 | 5.2 | 989.8 | 1,031.6 | 1,042.0 |
    | stats | 190.7 | 262.4 | 1,161.8 | 1,992.0 | 2,199.6 |
    | sessions | 25.9 | 39.3 | 225.4 | 275.6 | 288.1 |

  - `instance=56474-mw0ai9cm`、`started_at_ms=1793686292950`（14:11:32.950）；`uptime_ms` 26,287,358→26,313,585（7 h 18 m 07 s→7 h 19 m 34 s）。
  - RSS 237.7–237.8 MB；`storage.db_bytes=4,030,144,512`、`body_bytes=1,505,454,698`、`wal_bytes=3,699,600`、`total_bytes=4,033,992,207`、`free_bytes=395,293,933,568`；`storage_measured_at_ms` 新鲜度 63–4,722 ms（末轮 2,938 ms）。
  - `derive_queue.pending_groups=0`、`oldest_dirty_since_ms=null`、`oldest_dirty_age_ms=null`；`admission.mode=normal`。
  - `/api/stats`：`requests=53,047`、`pending_hooks=1,350`、`open_gaps=0`；`issues` 为 `otlp_span/service_not_registered=7`、`otlp_span/span_shape_unknown=1`；`body_states` 为 available 31,094 / evicted 13,074 / partial 61 / pending 8,817 / summary 1；`probe` version 0.1.2850 verified。
  - `event_loop` 每轮：p50 1.0、p95 25.0–25.7、p99 285.0–287.3、max 5,589.7（累计计数器，非窗口内新增）。
  - 任务给的 PID `8320` **不存在**；`lsof` 显示 `127.0.0.1:8320` 由 **PID 56474** 监听，与 `instance` 一致；`ps -p 8320` 拿不到数据。
- **影响**：`stats` p95 1.16 s、p99 1.99 s 与 `metrics` p95 0.99 s 说明重启前已有偶发慢读；`sessions` 最大 288 ms。容量与队列本身健康。
- **复现**：`/tmp/atc-baseline.sh 15`（三端点顺序 GET，间隔 1 s，`curl -w time_total`）；令牌由 `read.token` 原始字节转 base64url 生成，只发 GET。
- **严重度**：P2（基线记录，无阻塞项；但慢尾需在重启后对比）。
- **建议**：重启后用同一脚本、同一窗口复采；对比 p50/p95/p99 与 `event_loop`、RSS、storage 新鲜度；把 `stats` 慢读纳入 F06/F13 的缓存讨论。
- **状态**：已完成。**复采（2026-11-04 凌晨，跨组修复后）**：metrics p50 2.1 ms、stats p50 0.9 ms、sessions p50 39.9 ms / p95 83.7 ms；stats 的世代缓存把常态读从 262 ms 压到 1 ms 内；事件循环 p99 268–488 ms 仍在（F07 观察项）。

### F22 event_loop p99 阈值校准：建议 330 ms（区间 310–350 ms），为 F09 补依据

- **现象**：F09 拟用 100 ms，但冻结样本中 91 个有效样本的 p99 **全部 ≥100 ms（91/91）**，阈值等于常亮。按真实分布，建议把 F09 阈值改为 330 ms（可接受区间 310–350 ms），另保留 `max_ms > 2 s` 的独立告警。
- **证据**：
  - 22:51 复核当前样本（104 个有效样本）：p99 的 p50=198.8、p95=284.8；≥100 ms 104/104、≥300 ms 5 条（4.8%）、≥330 ms 4 条（3.8%），与冻结样本的结论一致。
  - 21:50 冻结 `monitor/samples/2026-11-03.jsonl` 到 `/tmp/atc-migration/monitor-samples-2026-11-03.frozen.jsonl`：92 行（91 有 metrics，1 条 20:31:07 timeout 无 metrics），覆盖 14:12:08–21:46:30（7.57 h）；采样间隔 p50 301.0 s、p95 305.7 s、p99 315.7 s、max 316.1 s，>360 s 的缺口 0。
  - 每样本 `event_loop` 各统计量的跨样本分布（91 个有效样本）：p50 的 p50=1.02、p95=1.34、max=1.99；p95 的 p50=4.01、p95=25.57、max=36.44；p99 的 p25=147.13、p50=187.55、p75=219.14、p90=256.86、p95=**294.05**、p99=6,029.75、max=6,117.25；max 的 p50=588.02、p95=10,614.29、max=16,600.39 ms。
  - 剔除 2 个 >1,000 ms 离群后（n=89）：p99 的 p95=263.40、p99=388.53、max=793.46 ms。
  - 超阈计数：≥100 ms 91/91（100%）、≥200 ms 38/91（41.8%）、≥250 ms 10/91（11.0%）、≥300 ms 5/91（5.5%）、≥320 ms 4/91（4.4%）、≥350 ms 3/91（3.3%）。
  - 稳健上界：p75 + 1.5×IQR = 219.14 + 1.5×72.01 ≈ **327.15 ms**；取 p95×1.15 ≈ **338.15 ms**。两个独立算法落在 327–338，故单阈值取 **330 ms**；310–350 为可接受区间。
  - 离群不是阈值问题：p99 6,029.75/6,117.25 ms 与 `max_ms` 6,117/16,600.39 ms 对应 F07 的 7.8–10.8 s 主线程停顿；探针自身 `elapsed_ms` p50 230、p95 4,826、p99 14,947、max 15,003 ms（1 条 15 s timeout），`jobs.probe.max_ms` p50 637.8、p95 15,776.5。
- **影响**：100 ms 阈值让告警永远处于触发态，F09 的“报警”不可用于判断；过高则会漏掉真实的 10 s 级停顿。
- **复现**：Python 读取上述冻结 jsonl，对 `metrics.event_loop.p50/p95/p99/max`、`elapsed_ms`、`ts_ms` 差分做分位；口径与样本路径见证据。
- **严重度**：P1（告警可信度；非数据风险）。
- **建议**：把 F09 的 100 ms 改为 **330 ms（310–350 可接受）**，并要求连续 30 min 超阈才告警，避免单点尖峰；另设 `event_loop.max_ms > 2,000 ms` 或探针 `elapsed_ms > 2,000 ms` 的独立通道抓 F07 类停顿；重启后重算一次样本分位再定稿。这是对 F09 的补证据，不另立重复问题。
- **状态**：已采纳（330 ms 落进 `THRESHOLDS.p99Ms`，跨度 30 分钟；重启后按 F21 复采复核）。

### F23 重启风险：迁移失败不自动重建，且没有自动备份

- **现象**：重启时的 v9→v10 若失败，`openStore` 抛错并关闭连接，进程退出；没有自动重建/自动回滚逻辑。`backup` 也不是启动步骤：只在人工维护命令里执行，且要求源库已停。
- **证据**：
  - [store.ts:171-188] 是 v10 迁移；[store.ts:208] 版本 >10 抛 `schema_version_unsupported`；[store.ts:235-242] v9 走就地迁移；[store.ts:267-273] `openStore` 捕获异常后 `db.close()` 再抛出，没有“失败后重建”的 catch 分支。
  - [main.ts:88] 启动即 `openStore`；顶层 [main.ts:341-345] 没有 try/catch，异常使进程以非零退出。launchd 若配置 KeepAlive 会反复拉起，每次重新执行约 2 s 的索引扫描（F01 的 13 次崩溃即此类循环）。
  - 事务性：迁移在单事务内执行，docs [operations.md:549] 说明失败后回滚，`user_version` 保持旧值、索引不存在，下一次启动重试；不会留下半迁移库。
  - 备份：`backup.ts` 只在 [maintenance/cli.ts:103-118] 的 `backup` 命令里调用，启动路径没有备份调用；`backupDatabase` [backup.ts:91-143] 先做独占探测 [backup.ts:44-76]，采集器还开着会报 `source_must_be_stopped`；目标必须不存在，剩余空间 ≥ 源库 1.1 倍。落点由 `--out` 指定，没有默认目录；当前数据目录下没有任何备份产物，**拿不到“现有备份大小”**。
  - 本次只读快照可作体积基准：3,913,723,904 B（3.91 GB）；源库 4,030,124,032 B，1.1 倍需 4,433,136,435 B（4.43 GB）。bundle 另含 `redaction.salt` 与 `manifest.json`，体积接近。
- **影响**：迁移失败 = 服务起不来，且无本地回滚快照；只能修因（空间/锁/权限）后重试。若重启前不停服备份，就没有“回到 v9”的人工退路（尽管 v10 是 additive，数据风险低）。
- **复现**：代码路径见上；可在 /tmp 副本上把目录设为只读或写满后 `openStore`，观察抛错与 `user_version` 保持 9。本次未做破坏性注入，只做代码与文档取证。
- **严重度**：P0（迁移失败即停机；无自动重建、无自动备份）。
- **建议**：重启顺序改为：停服 → `bun run maintain bundle --db … --out <外部路径>`（或至少 `backup`，预留 ≥4.43 GB）→ 启新代码 → 只读核对 `user_version=10`、索引、`integrity_check`；失败时保留库与 WAL，不要删除 `-wal/-shm`，按错误码处理后在低峰重试。注意备份要求停服，不能边跑边备。
- **修复方案**：边界与状态机见 [迁移失败即停机：自动重建的边界设计（F23）](./2026-11-03-migration-failure-autorebuild.md)。结论是默认 A（快速失败 + 打印自救指令），只有显式开关（`--auto-rebuild` / `ATC_AUTO_REBUILD=1`）且唯一命中 `schema_rebuild_required` 时才允许 C（同卷改名备份后重建空库、不回填），B（自动备份 + 重建 + 回填）因 R1 之后无数据可填而否决。该篇只出设计，实现与验收未开始。
- **状态**：已修（流程）：备份→重启→显式 rebuild→验证 写入 [operations.md 部署顺序](../../docs/operations.md#部署顺序重启只完成迁移不回填存量)；本次回归窗口按该顺序执行。

### F24 重启本身不会让存量 Codex 会话收敛/改标题；验收需显式 rebuild

- **现象**：v10 迁移只加列，存量 53,047 行 `user_fingerprint`/`turn_ref` 全为 NULL；用途/派生队列没有待处理项，启动路径不调用 `upgradePurposeTargetTx`/`drainDeriveTx`。因此仅重启不会把四条 Codex 线程重判为“主/标题/背景”，标题仍是 `# AGENTS.md instructions…`。
- **证据**：
  - 迁移后副本：`user_fingerprint` 非空 0、`turn_ref` 非空 0；`purpose_target` 分布 7=37,962、8=15,085、10=0；`purpose_pending=0`；`derive_queue` 1,134 组全部 `clean`，`target_algorithm` 4=239、6=646、7=249。启动 [main.ts:88] 只 `openStore`。
  - 显式升级入口：[request-purpose.ts:491] `upgradePurposeTargetTx` 由 [maintenance/rebuild.ts:37] 调用，命令入口 [maintenance/cli.ts:53]。副本抽样：最大会话 4,433 行，`upgradePurposeTargetTx` 1,755.9 ms，置 4,433 行 `purpose_pending=1`、1 组 dirty；完整 drain 未跑（属写操作，重启路径也不需要）。
  - Codex 提案验收 [2026-11-03-codex-integration.md:275] 明确要求“对本次批次完成显式重建后”，main 标题为「重绘 ATC 矩阵 IP」。当前生产 API `GET /api/sessions?limit=100` 的 100 条截止到 16:01，只覆盖主卡 `01a19fc1-b301…`，标题仍为 AGENTS.md；另外 3 条（`b4ae`、`d007`、`b46a`）比截止时间更早，**top-100 拿不到**，只读库按 `conv_key` 能确认 4 条都在。
  - 只读验证字段：`GET /api/sessions?limit=100[&cursor=…]` → `items[].conv_key/title/agents/flags/request_count`；主卡 `agents=["codex"]`、`title` 应为「重绘 ATC 矩阵 IP」；标题线程应带 `bypass`，`b4ae` 应带 `background`（其 499 未知行仍 participate），`d007` 应折叠；`GET /api/sessions/<urlencoded conv_key>/turns` 复核轮次；`GET /api/metrics` 看新 `instance/started_at_ms/uptime_ms`；`GET /api/stats` 看 `requests` 增长、`issues` 是否停止新增。
  - 迁移后新流量才会写入两列；只读核对：`SELECT COUNT(*) FROM request WHERE user_fingerprint IS NOT NULL` 应从 0 开始增长。
- **影响**：若把“重启”当作 Codex 验收，会得到假阴性：4 张卡不收敛、标题不变，容易被误判为集成失败；真实缺口是存量未重建。
- **复现**：重启 → `GET /api/sessions?limit=100`（必要时翻页）过滤 `agents=codex`；对比标题/flags/request_count。要看到预期结果，需先对 4 个 `conv_key` 各跑一次 `maintain rebuild`（写操作，另行安排）。
- **严重度**：P1（验收口径错误；不改变服务可用性）。
- **建议**：把 Codex 验收拆成两步：重启后先只读确认迁移与新流量写入；再在允许写操作的窗口内对 4 个 `conv_key` 显式 rebuild，然后用上述 GET 复核。不要在重启窗口里顺手跑全量 rebuild（最大会话 4,433 行的升级已 1.76 s，完整重排更久且会占主线程）。
- **状态**：执行层待办：rebuild 随 2026-11-04 回归窗口执行，验收命令见上。

### F25 运维语义缺口：重启只完成迁移，不等于 Codex 集成生效

- **现象**：合并 Codex 集成后，很容易按「部署完就重启」的习惯操作，默认「重启服务 = 集成生效」。实际 v9→v10 只新增 `user_fingerprint` / `turn_ref` 两列，存量 53,047 行两列全为 NULL；派生队列 `pending_groups=0`，启动不跑任何重算，因此**重启不会回填存量**。要让四条 Codex 线程收敛为一张主卡并换成「重绘 ATC 矩阵 IP」，必须显式跑 `maintain rebuild`。技术事实见 F24，本条记运维/文档语义缺口。
- **证据**：
  - `/tmp/atc-migration` 迁移试跑副本：迁移后 `user_fingerprint` 非空 **0**、`turn_ref` 非空 **0**；`derive_queue` 1,134 组全部 `clean`，`pending_groups=0`；`purpose_pending=0`。
  - 启动路径 [main.ts:88] 只调用 `openStore`，不调用 `upgradePurposeTargetTx` / `drainDeriveTx`；显式升级只在 [maintenance/rebuild.ts:37]，命令入口 [maintenance/cli.ts:53]。
  - Codex 验收前提 [2026-11-03-codex-integration.md:275] 明确是「对本次批次完成显式重建后」，不是「重启后」。
  - 只重启时会看到：`GET /api/sessions` 的四条 Codex 线程仍各自成卡，主卡 `title` 仍是 `# AGENTS.md instructions…`；这与未合并代码时的表现相同。
- **影响**：运维或使用者会误判「功能没生效」或「改动没合进去」，进而重复重启、重复部署，甚至怀疑迁移把数据弄坏；实际只差一次显式 rebuild。
- **复现**：拿一个已有大量存量请求的库，合并带 schema 变更与新派生规则的改动，只重启、不跑 `maintain rebuild`；然后 `GET /api/sessions` 看 `title` / `flags` / `request_count`，四条 Codex 线程不会收敛，标题不变。
- **严重度**：P1（运维语义与验收口径；不改变服务可用性，但会稳定地制造误判和重复操作）。
- **建议**：在 [operations.md](file:///path/to/agent-trace-collector/docs/operations.md) 的发布/升级章节写清部署顺序：**重启（完成 v9→v10 迁移）→ `maintain rebuild`（回填/重判存量）→ 验证**，并明确「仅重启只完成迁移，不回填存量」。验收命令固化为：
  ```
  bun run maintain rebuild --db "$DB" --session '<conv_key>'
  GET /api/sessions?limit=100          # 过滤 agents=codex，看 title/flags/request_count
  GET /api/sessions/<urlencoded conv_key>/turns
  ```
  另建议在文档里加一条只读自检：迁移后 `user_fingerprint` 非空计数应从 0 开始增长，用于区分「迁移成功」与「回填完成」。
- **状态**：已修：部署顺序与只读自检写入 [operations.md](../../docs/operations.md#部署顺序重启只完成迁移不回填存量)，schema 节同步到 v10。

### F26 `/api/sessions` 跨组标题绑定写成相关标量子查询，复杂度 O(页内会话数 × request 行数)

- **现象**：重启后新实例 `27838-mw0ra0dm`（代码 `868882f`）上 `GET /api/sessions` 从基线 p50 39.3 ms / p99 275.6 ms（F21）退化到 15 轮采样 p50 **5,761 ms**、p95 5,909 ms、max 5,922 ms；主日志连续 `5,885 / 5,722 / 13,111 / 7,416 / 5,922 / 5,819 ms`。同一时刻 `/api/metrics`、`/api/stats` 变慢，属排队而非各自变慢（见 F27）。
- **证据**（生产库 `VACUUM INTO` 只读快照 3.6 GB；`request`=53,057 行、`conv_key`=1,278 个、`req_kind='title'`=144 行、`user_fingerprint`/`turn_ref` 非空均为 0；副本进程内预热后中位/逐次）：
  - 分块耗时（差值计时：同一阶段二 SQL，只把 `CROSS_GROUP_TITLE_SQL` 换成 `NULL`）：

    | 分块 | limit=20 | limit=50 | limit=100 |
    | --- | ---: | ---: | ---: |
    | 阶段一：候选会话（原有） | — | 1.7 ms | 1.7 ms |
    | 阶段二：原有标题四路 + 组闸门（原路径合计 2.5–3.3） | 2.5 ms | 2.7–2.9 ms | 3.0–3.3 ms |
    | 阶段二：跨组标题绑定（本次新增） | **~300 ms** | **~795 ms** | **~1,285 ms** |
    | 阶段二：`background` / `has_recognized_main` 聚合（本次新增） | <1 ms | <1 ms | <1 ms |
    | `listSessions` 合计 | 302–315 ms | 795–830 ms | 1,285–1,350 ms |

  - 逐次读数：limit=20 `current 300.3 / 302.7`、`no-cross 2.5 / 2.7`；limit=50 `current 795.8 / 803.4 / 827.2`、`no-cross 2.7 / 2.7 / 2.9`；limit=100 `current 1,285–1,350`。单会话增量 ≈ 795/50 ≈ **15–16 ms**，与全表 53,057 行吻合。
  - `EXPLAIN QUERY PLAN` 原文片段（limit=50；省略参数值）：
    ```
    SEARCH request USING INDEX i_req_session_time (conv_key=?)
    CORRELATED SCALAR SUBQUERY 8
      SEARCH qt USING INDEX i_derive_queue_dirty (state=?)
      SEARCH t USING INDEX i_req_conv (conv_key=? AND actor=?)
      CORRELATED LIST SUBQUERY 4
      SEARCH ra USING INDEX i_req_session_time (conv_key=?)
      CORRELATED SCALAR SUBQUERY 5
      SEARCH m USING INDEX i_request_user_fingerprint (user_fingerprint=?)
      SEARCH qm USING PRIMARY KEY (conv_key=? AND actor=?)
      CORRELATED SCALAR SUBQUERY 6
      SEARCH t2 USING INDEX i_request_user_fingerprint (user_fingerprint=?)
      CORRELATED SCALAR SUBQUERY 7
      USE TEMP B-TREE FOR count(DISTINCT)
      SEARCH m2 USING INDEX i_request_user_fingerprint (user_fingerprint=?)
      USE TEMP B-TREE FOR ORDER BY
    ```
  - 计划没有字面 `SCAN request`，但驱动表是 `qt`（`derive_queue` 的全部 current 组），再经 `i_req_conv` 反查每个组的全部请求：**每次求值等价走一遍 53k 行**，而这条相关标量子查询在页内每个会话各执行一次（20/50/100 次）。
  - `req_kind='title'` 只有 144 行，且 `i_req_model_title`（`WHERE req_kind='title'` 的部分索引）存在，planner 没有选它做驱动。
- **已排除的假设**（避免以后重走）：
  - **不是「部分索引对 NULL 失效」**：在副本上把 `user_fingerprint` 部分索引换成全量 `CREATE INDEX i_fp_full ON request(user_fingerprint)` 后为 **782.3 ms**（原 767–795 ms），无改善；内层 `EXISTS`/`COUNT` 本来就命中 `i_request_user_fingerprint`。外层扫描才是成本，外层与内层索引无关。
  - **不是「逐会话逐条查库，N×M 次 SQL」**：整条 `listSessions` 只有 2 条 SQL（阶段一 + 阶段二）；N×M 发生在 SQLite **内部**的相关子查询求值，同一条语句被重算 N 次，每次内部走 M 行。
  - **不是 HTTP / JSON 开销**：同一 SQL 直接 `store.read.query` 就是 795 ms（limit=50），HTTP 与 `JSON.stringify` 不在主因。
  - **不是背景 tick 单独造成**：同机无背景任务的副本上可稳定复现 300/795/1,285 ms（limit=20/50/100）。
- **影响**：左栏首屏与刷新不可用级慢；同进程内所有读接口排队（F27）；把 F28 的「title 指纹仍为空」事实放大成空转成本——一次绑定都没发生，却付了全表扫描。
- **根因（已证实）**：跨组标题绑定被写成 `CASE`/`COALESCE` 内的相关标量子查询，缺少「本会话没有可绑定指纹就整段不做」的短路，也没有按页批量求值；命中率 0 时仍按会话数 × 全表行数付费。
- **候选修法（均未采纳，待用户拍板；不要按本笔记开工）**：
  1. **① 指纹短路（最小改动）**：在 `SESSION_TITLE_SQL` 里把 `${CROSS_GROUP_TITLE_SQL}` 包成
     `CASE WHEN EXISTS (SELECT 1 FROM request x WHERE x.conv_key = request.conv_key AND x.user_fingerprint IS NOT NULL) THEN ${CROSS_GROUP_TITLE_SQL} END`。
     - 改动面：`src/queries/sessions.ts`，约 **4 行**。
     - 预期收益（实测）：limit=20/50/100 → **1.5 / 1.5 / 1.9 ms**；22:57 快照复核 limit=50：current 881.8 ms → 候选① 0.7 ms（页内 50 组仅 2 组有指纹）；计划变为 `SEARCH x USING INDEX i_req_session_time (conv_key=?)`，跨组子查询不再进入。
     - 风险：语义不变（写笔记时全库指纹 NULL；22:57 复核 participate 指纹已写到 79 条，但 title 指纹仍为 0，绑定仍不可能命中）；一旦某会话有 title 指纹，走完整逻辑与现在一致。副作用是指纹写入侧若坏（F28），这条路径继续「快但永远不绑定」，必须与 F28 一起验收。
     - 依赖：无；建议与 F28 同批验证。
  2. **② 索引方案（已否决）**：全量索引实测 782 ms，无收益；若坚持索引，必须 `INDEXED BY i_req_model_title` 让 144 条 title 行驱动，或建 `(user_fingerprint) WHERE req_kind='title' AND user_fingerprint IS NOT NULL` 并承担 planner 行为差异。**未采纳**。
  3. **③ 批量预取（结构更正确，回归风险高）**：阶段二之前先按页内 20/50 个 `conv_key` 取一次指纹集合，单查 title 行并在 SQL 或 JS 内配对，再把结果作为列注入，替换「每 group 一个相关子查询」。
     - 改动面：`src/queries/sessions.ts`，约 **40–60 行**（聚合内不能再直接引用 `request.conv_key` 的标量子查询，需改 `JOIN`/预取 map）。
     - 预期收益：今天零行 → **~1 ms**；有数据时只扫与页内指纹相关的少量行（未实测，按 144 行量级估算 <5 ms）。
     - 风险：标题优先级链与游标/翻页语义要逐条对齐；多 actor、同毫秒、迟到旧请求用例需重跑；比 ① 更容易引入回归。
     - 依赖：与 ① 互斥（同处）。
- **复现**：见附录 A.2（快照命令、两段 SQL、计时方法、不依赖 `/tmp` 脚本）。
- **修复记录（2026-11-03，候选 ① 已落地）**：
  - **代码**：`fix/session-cross-group-title-shortcircuit`（commit `7d0983c`），`git merge --no-ff` 进 master（merge commit **`396342b`**）。改动 `src/queries/sessions.ts` +12/-1：新增常量 `HAS_USER_FINGERPRINT_SQL`（`EXISTS (SELECT 1 FROM request x WHERE x.conv_key = request.conv_key AND x.user_fingerprint IS NOT NULL)`），并把 `SESSION_TITLE_SQL` 里的 `${CROSS_GROUP_TITLE_SQL},` 换成 `CASE WHEN ${HAS_USER_FINGERPRINT_SQL} THEN ${CROSS_GROUP_TITLE_SQL} END,`。未做候选 ③、未做 F27/F29，未改 `web/`，未动 `scripts/monitor.ts`。
  - **修复后实测**（同一份 23:24 只读快照，旧码 = master `29e33f3`，新码 = merge 后；`listSessions` 预热 5 次取中位，单位 ms）：

    | limit | 旧码首跑 | 旧码预热中位 | 新码首跑 | 新码预热中位 | 新码 min–max |
    | ---: | ---: | ---: | ---: | ---: | ---: |
    | 20 | 62.4 | 59.9 | 5.4 | **2.4** | 2.3–2.5 |
    | 50 | 592.7 | 566.2 | 7.3 | **7.5** | 6.9–8.6 |
    | 100 | 1,160.0 | 1,187.4 | 7.6 | **8.0** | 7.4–8.4 |

    - 与写笔记时的 300/795/1,285 ms 不同，是因为快照时点不同（现在库里有 126 条 participate 指纹、页内组合也不同）；**同一快照新旧码对比才是本条修复的验收口径**。三档全部远低于 40 ms 目标。
  - **执行计划原文**（新码，limit=20）：
    ```
    SEARCH request USING INDEX i_req_session_time (conv_key=?)
    CORRELATED SCALAR SUBQUERY 1
      SEARCH g USING PRIMARY KEY (conv_key=?)
    CORRELATED SCALAR SUBQUERY 2
      SEARCH r1 USING INDEX i_req_session_time (conv_key=?)
      SEARCH q1 USING PRIMARY KEY (conv_key=? AND actor=?)
    CORRELATED SCALAR SUBQUERY 3
      SEARCH x USING INDEX i_req_session_time (conv_key=?)
    CORRELATED SCALAR SUBQUERY 8
      SEARCH qt USING INDEX i_derive_queue_dirty (state=?)
      SEARCH t USING INDEX i_req_conv (conv_key=? AND actor=?)
      ...
    ```
    外层入口已从 `qt` 改为 `x`（单会话区间索引，`SUBQUERY 3` 先于 `SUBQUERY 8`）。**`SEARCH qt USING INDEX i_derive_queue_dirty` 仍作为 `CASE` 分支的静态计划保留**，但只在 guard 为真（存在非空指纹）时执行；全库 title 指纹为 0 时该分支不会被求值。旧码的计划没有 `SEARCH x`，`CORRELATED SCALAR SUBQUERY 7` 直接由 `qt` 驱动。
  - **语义等价**：同一快照翻完 1,297 个会话，标题 + flags 逐条对比 **差异 0 条**（key 差异 0、值差异 0）。
  - **新增测试**：`tests/queries.test.ts` 新增「跨组标题短路：有指纹时绑定语义不变，闸门先于相关子查询求值」（+56 行），覆盖唯一命中照旧绑定、零命中不绑、多命中歧义不绑，以及计划中 `SEARCH x USING INDEX i_req_session_time` 先于 `i_derive_queue_dirty`。
  - **旧码必红证据**：把 `src/queries/sessions.ts` 的改动临时回退后单跑该用例，`0 pass / 1 fail`；失败断言是 `expect(plan).toContain('SEARCH x USING INDEX i_req_session_time')`（tests/queries.test.ts:1440）。它之前的 6 条语义断言全部通过，说明短路没有改变绑定结果。
  - **验收口径（必须保留）**：F28 尚未定性（23:24 快照里 126 条指纹全是 `participate`/`chat`，`req_kind='title'` 指纹仍为 0，`turn_ref` 仍为 0），所以本次只能写「**耗时回到 40 ms 内、执行计划不再由跨组子查询驱动**；无指纹数据下标题行为与修复前逐条等价」。**不代表跨组标题绑定已恢复**。
- **严重度**：P0。
- **状态**：已修（merge `396342b`；绑定未验证，待 F28 定性后复验）。
- **状态更新（2026-11-04 凌晨）**：候选①的退化预警成真——部署后活库实测原始 SQL 75 ms（1,310 current 组、页内 4 组指纹），模拟页内 50 组指纹 367 ms。追加 `CROSS JOIN` 定死 title 侧驱动（merge 见批次 note）：同状态 14.7 ms、模拟态 6.9 ms、1,310 会话语义差异 0，成本不再随指纹覆盖增长。HTTP 层残余差距（复采 p50 287 ms → 修后复测见下）来自事件循环停顿叠加，归 F07/F06 观察项。

### F27 会话列表在主线程同步计算，服务端零并发保护

- **现象**：`/api/sessions` 单发慢会同时拖垮 metrics/stats；多标签页/刷新会线性叠加，且这段时间内**任何**请求都得不到执行。用户判断「反复刷新就能把主线程阻塞」本身是 bug，速度只是表象。
- **证据**（代码，行号）：
  - [http.ts](file:///path/to/agent-trace-collector/src/http.ts#L519-L525) L519-525：`/api/sessions` 分支 `parseLimit(...)` → `listSessions(...)` → `json(...)`，**三者之间没有任何 `await`**；`async` 只是签名。
  - [sessions.ts](file:///path/to/agent-trace-collector/src/queries/sessions.ts#L196-L225) L196-225：`store.read.transaction(...).deferred()` 是 bun:sqlite **同步**事务，两条 SQL 全同步；`.deferred()` 只是 `BEGIN DEFERRED`，不排队、不让出。
  - [http.ts](file:///path/to/agent-trace-collector/src/http.ts#L105-L115) L105-115：`json()` 内 `JSON.stringify` 同步（对 20–50 行是小项，非主因）。
  - [main.ts](file:///path/to/agent-trace-collector/src/main.ts#L279-L283) L279-283：`Bun.serve({ fetch: (req) => handler(req) })`，单进程单事件循环。
- **并发实测**（副本，limit=20，预热；「推迟」= 与任务同时 `setTimeout(0)` 的纯内存 metrics 探针实际触发时间）：
  | 并发 | 墙钟 | 各请求完成偏移 | 纯内存 metrics 被推迟 |
  | ---: | ---: | --- | ---: |
  | 1 | 312.9 ms | 310.9 | 311.1 ms |
  | 2 | 683.4 ms | 327.0 / 355.1 | 682.2 ms |
  | 3 | 995.0 ms | 350.5 / 315.6 / 327.5 | 993.6 ms |
  | 5 | 1,603.7 ms | 315.3 / 313.4 / 317.7 / 338.7 / 317.2 | 1,602.2 ms |
  - 基线：metrics 纯内存路径自身 **0.01 ms**；`getStats` 自身 **59.7 ms**；紧随一次 sessions 之后，stats 要等 **+315.8 ms** 才能开始。
  - 换算：**3 个标签页同时刷新 = 最后一张卡 ~1.0 s；5 个 ≈ 1.6 s**；此窗口内 metrics 的内存路径（0.01 ms 的活）同样等整段墙钟。
- **现有防护：服务端一条都没有**：无 single-flight、无结果缓存、无 TTL、无并发上限、无超时/取消（`AbortSignal` 只出现在 ingest 路径，[http.ts](file:///path/to/agent-trace-collector/src/http.ts) 内无 `Map`/cache）。前端只有一道同 tab 去重：[reader-store.js](file:///path/to/agent-trace-collector/web/reader-store.js#L279-L299) L279-299 的 `sessionsLoading` 布尔闸门（不共享 Promise）；[read-scheduler.js](file:///path/to/agent-trace-collector/web/read-scheduler.js#L22-L26) L22-26 的 `activeLimit=4`/`pendingLimit=64` 只约束单页；`web/` 全量搜索确认**无轮询、无自动重试、无 `setInterval`**，只有首屏一次 `limit=20` 与「加载更多」（[app.js](file:///path/to/agent-trace-collector/web/app.js#L2226-L2249) L2226-2249，且主动把 stats 排在列表之后）。
- **影响**：任意一个慢会话列表都会冻结整个进程的读写接口；并发客户端数直接乘到延迟上；metrics/stats 的「变慢」是排队，不是它们自身退化（stats 自身 59.7 ms）。
- **根因（已证实）**：同步 SQL 在 HTTP 回调里执行，中间无让出点；服务端没有任何并发合并或缺省策略，进程只有一条事件循环 + 一条同步连接。
- **候选修法（全部未采纳，待用户拍板）**：

  | 方案 | 改动面 | 预期收益（实测/推算） | 风险与副作用 | 依赖 | 判定 |
  | --- | --- | --- | --- | --- | --- |
  | A. single-flight | `src/http.ts` 新增 `Map<key, Promise<Page>>`，key=`limit+cursor`，约 **20 行** | 3 标签页 995→**315 ms**；5→1,604→**315 ms**；单发仍 300 ms | 同 key 共享同一快照（毫秒级差）；错误要广播给所有等待者，避免永久挂起 | F26 | **建议保留**（兜底） |
  | B. 短 TTL 结果缓存 | 新 `src/queries/session-cache.ts` + `http.ts` 接入，约 **40–60 行** | 稳态重复刷新 ≈ **0 ms**；首次仍 300 ms（未实测缓存命中，按定义推算） | 新会话最多晚 TTL 出现；**必须把 live 字段排除在缓存外**，否则 60 s 活跃区假死；摄入 epoch 失效要接 | F26；live 窗口 | 暂不需要 |
  | C. 移到 Worker | 新 worker 入口 + 独立只读连接 + 消息协议，约 **80–100 行** | 主线程饥饿归零；sessions 自身仍 300 ms，worker 内仍串行 | 库文件替换/重启生命周期；`read-http.js` 是前端传输层，不改边界但要确认请求契约不变 | F26（否则 worker 里也慢） | 暂不需要 |
  | D. 时间预算 + 分段响应 | `sessions.ts` 拆 `title` 可选 + `http.ts` 增 `?titles=1`（或第二个端点），约 **30–50 行** | 首屏 **300→3 ms**；重字段 300 ms 转后台 | 标题会晚到/闪一次；前端要处理两段合并 | F26 | 暂不需要 |
  | E. 并发上限 + 降级 | `http.ts` 单飞闸 + 最近结果快照 + 响应头 `x-degraded`，约 **25 行** | 最坏 (N−1)×300 压到 ~2×300 ms | 高并发时可能看到**上一次**标题；需要明确的降级文案 | F26 + B 的快照 | 暂不需要 |

  **为什么 B/C/D/E 暂不需要、什么条件下重新需要**：F26 修回后单发 ≈1.5–3 ms；40 ms 口径下 3 标签页 ≈120 ms、5 并发 ≈200 ms（冷页 ×4 ≈480/800 ms），metrics 最多被推迟同样时间——不构成「主线程阻塞」级事故。只有出现以下任一情况才重新评估：① 单发生成字段回到 >50 ms（新增重列/更大数据量）；② 需要支持 10+ 并发客户端；③ 冷页成本（F30）修后仍 >1 s。
- **复现**：见附录 A.3（并发探针与推迟测量方法）。
- **严重度**：P0。
- **状态**：已修（A 单飞）：`src/http.ts` 同 key 共享在途 Promise，错误走共享 rejection 各自映射响应，完成后立即出表；`listSessions` 每页只执行一次（测试断言 inflight 调用数）。

### F28 `user_fingerprint` / `turn_ref` 存量全空；title 指纹通道断

- **现象**：写笔记时（22:00 前后）`user_version=10`、`request`=53,057 行，`user_fingerprint` 与 `turn_ref` 非空均为 **0**。22:57 只读快照复核：`user_fingerprint` 已随新流量写到 **79 条 / 2 个 `["session",…]` 组**（全部 `participate`/claude，22:18 后写入），`turn_ref` 仍全库为 0。23:24 快照复查：`user_fingerprint` 非空 **126 条**（全部 `participate`/`chat`），`req_kind='title'` 的指纹仍为 **0**，`turn_ref` 仍为 **0**——写入侧没有整体损坏，断的是 title 通道。
- **证据**：
  - 写入条件不是「每条走到判定的请求都写」：`src/request-purpose.ts:466-469` 只在 `decision.kind === 'title'` 或 `decision.chain === 'participate'` 时调用 `purposeUserFingerprintTx`；`turn_ref` 由 OTLP 映射写入（`mapping.turnRef`）。
  - participate 通道正常：上述 79 条指纹来自正常会话（`["session",…]`，两个组都是 known actor 且在 `derive_queue` 中）。
  - **title 通道断了**：两条 v10 title 行（req_id 95339 / 95481，22:18 / 22:49）指纹仍为 NULL。只读解压其首条 user 块，正文是 `<session>…</session>\n\nWrite the title in 中文…`，**不含 `User prompt:`**；而 `purposeUserFingerprintTx` 的 title 分支只找 `'User prompt:'`（`src/request-purpose.ts:268-275`），找不到就 `continue`，最终返回 null。现有测试只覆盖 Codex 的 `User prompt:` 形态（`tests/request-purpose.test.ts` 的「Codex 内容指纹」用例）。
  - 存量未重判的旁证仍然成立：多数行 `purpose_version=7/8`、`purpose_pending=0`；启动路径 [main.ts:88] 只 `openStore`，不调 `upgradePurposeTargetTx`/`drainDeriveTx`（与 F24 一致）。
- **影响**：跨组标题绑定仍**永远没有 title 指纹可配**——F26 修完也绑不上，四条 Codex 会话不会收敛；按内容身份关联的验收会出现假阴性。
- **核查方案（只读/副本）**：
  1. 已按 `started_ms > 重启时刻（1793714461546）` 统计：recognized 的新行全部 `exclude`（按条件不写指纹，符合预期）；unrecognized 的 participate 行写入了指纹。写入侧没有整体损坏。
  2. 待办：在 `/tmp` 副本上给 Claude title 请求补一条最小用例，确认 `<session>` 模板提取失败；`turn_ref` 另查 OTLP `mapping.turnRef` 是否有新数据。
  3. 加结构化计数（`purpose.fingerprint.written` / `.skipped(reason)`）随 `/api/stats` 输出，避免以后靠猜。
- **建议修法**：先修 title 指纹提取（Claude `<session>…</session>` 模板取 `<session>` 内文本，Codex `User prompt:` 保留），再跑 F24 的显式 rebuild 回填存量；`turn_ref` 单独核查。
- **严重度**：P0（绑定功能仍不可用，且掩盖 F26 的修复效果）。
- **状态**：title 通道已修（`titlePromptText`：`User prompt:` 标记保留原语义，`<session>` 壳内文本按同一套解释清洗；测试覆盖两形状与主/标题指纹一致）；`turn_ref` 仍待查。

### F29 前端 `sessionsLoading` 是布尔闸门，不共享 Promise

- **现象**：同一标签页同一 tick 的第二次 `loadSessions` 被直接丢弃（返回 `undefined`），没有共享在途结果；跨标签页没有任何约束。
- **证据**：[reader-store.js](file:///path/to/agent-trace-collector/web/reader-store.js#L279-L299) L279-299：`if (state.sessionsLoading) return; state.sessionsLoading = true; … finally { state.sessionsLoading = false; }`；`web/` 全量搜索无 `setInterval`/轮询/自动重试；首屏一次 `limit=20`，另有「加载更多」。
- **影响**：多标签页是天然放大器，配合 F27 把排队叠起来；同 tab 的并发调用被静默丢弃，调用方拿不到结果也无从重试。
- **建议修法**：把 `sessionsLoading` 改成 `sessionsInFlight: Promise|null`，并发调用返回同一个 Promise；跨 tab 只能靠服务端（F27-A）。改动面 `web/reader-store.js` 约 **10 行**。
- **严重度**：P1（功能/体验缺陷，非数据风险）。
- **状态**：已修：`sessionsLoading` 布尔闸门改 `sessionsInflight` Promise 共享，并发调用等待同一结果而不是被丢弃。

### F30 冷页缓存固定成本 ~2.4 s 会定期复发（上界）

- **现象**：同一进程首跑 vs 预热差距明显；重启后页缓存变冷时，列表会额外付出一次页读成本。
- **证据**（副本，同一进程内首跑与预热对比）：

  | 档位 | 首跑 | 预热 | 冷加成 |
  | --- | ---: | ---: | ---: |
  | limit=20 | **2,721 ms** | 302 ms | ≈ +2.4 s（9×） |
  | limit=50 | **3,287 ms** | 825 ms | ≈ +2.4 s（4×） |

- **口径警告（必须保留）**：这两组数是在**挂着 F26 重查询**的条件下量的，属**上界**。F26 修回后实际触碰的页会少很多，真实冷成本很可能远低于 2.4 s；**必须修完 F26 再实测，不能把这个数当结论**。
- **影响**：重启后第一波请求的 p99 会被页读成本抬高；若 WAL/派生写入持续驱逐页，冷成本可能周期性复发。
- **建议**：作为观察项，不单独修；F26 落地后按同一方法复测（首跑 vs 预热），再决定是否需要预热/缓存策略。
- **状态**：已复测（2026-11-04 凌晨）：冷 83.7 ms vs 预热 39.6 ms，冷加成约 44 ms——2,721/3,287 的旧读数是 F26 退化查询的伪象，观察项关闭，不需要预热策略。


### F31 `source:web_search` 被判成主链参与，实为辅助（Claude 侧）

- **现象**：主页左栏有 6 条「只有一笔、空无正文」的卡（截图里第 13–18 行）。核查结论：它们不是真会话，是 Claude Code 侧 **WebSearch 工具执行产生的 `source=search` 账本子事件**。当时首屏（limit=20）可见同族 **18 张卡**：14 条 `["request",…]` 请求级卡 + 4 张 `["conv","magpie-…"]` 卡（标题 `<model> · <time>`）。**全库口径更正（11-03 22:57 读数）：同族共 136 张，67 个 `["request",…]` + 69 个 `["conv","magpie-…"]`，今天新增 88 条（16 点集中）；top50 覆盖 37 张、top100 覆盖 86 张。**
- **证据**：
  - 共同特征（逐行列值一致）：`conv_source=request`、`sort_source=ledger`、`req_kind=source:web_search`、`purpose_chain=participate`、`purpose_rule=source.kind.v1`、`chain_role=main`、`via=through`、`body_state=pending`、`have=2`（只有 ledger 位）、`miss_reason=hook_absent`、`actor=NULL`、`session=NULL`、token/cost 全 0、`raw_ledger` payload 为 `{"kind":"web_search","source":"search","status":200,"in":0,"out":0,…}`。
  - Claude 侧真正的 web_search 辅助识别**依赖正文尾巴模板**：[claude.ts L113-119](file:///path/to/agent-trace-collector/src/harness/claude.ts#L113-L119)，L117 `'Perform a web search for the query: '` → `rule='claude.web-search.v1'`、`kind='web_search'`、`chain='exclude'`。
  - 这批行 `body_state=pending` / `miss_reason=hook_absent`，正文不存在 → 模板判据无法执行 → 掉到 [semantics.ts L186-206](file:///path/to/agent-trace-collector/src/semantics.ts#L186-L206) 的 `source.kind.v1` 兜底：非 `title` 一律 `chain='participate'`、`kind='source:${kindValue}'`（L198-206）。
  - 对照：库里 Claude 辅助线程的真实形态（`title`、`auto-mode-classifier`、`action_description`、`suggestion_mode`、`recap`、`context_compaction`、`web_search`）全部是 `exclude/aux`；只有这批 `source:web_search` 卡（当时首屏 18 张，全库 136 张）是 `participate/main`。
  - 与 Codex 的区别：Codex 是「有元数据（`thread_source`/`turn_trigger`）但没接线」；Claude 是「只有正文模板、正文丢了」。**成因不同，不要混成一条**。
- **影响**：这批辅助事件（当时首屏 18 张，全库 136 张）被当成主卡参与列表，token/cost 全 0、无正文，用户看到空卡；同时污染按 participate 链的标题候选。
- **根因（已证实）**：辅助判据单点依赖正文模板，`hook_absent` 时没有任何不依赖正文的兜底。
- **修复方向（未采纳，待用户拍板；状态待修）**：
  1. 给 `source.kind.v1` 增加一条不依赖正文的判据：`raw_ledger.kind='web_search' && source='search'` → `exclude` / aux；
  2. 或在 `sourceDecision` 名单里补 `source:web_search` → `exclude`。
  - **单独改规则无收敛效果**：这些卡没有派生组（见 F32），列表读的是原始列回退；必须与 F32 同批。
- **严重度**：P1。
- **状态**：展示与判据已修（2026-11-03，见[收起方案](../../implemented/bug-fix/2026-11-03-websearch-subevent-cards.md)）：读侧 `tool_event` 折叠全族 136 张；`source.kind.v1` 增加无正文 web_search 判据（PURPOSE_VERSION 11），对存量无正文行因 retained 保留不翻判，只对新增行生效。数据层自描述随 F32 的 P2 批次。

### F32 unknown-actor 的 `["request",…]` 组从不进入派生队列，导致无法收敛

- **现象**：`conv_key` 以 `["request"` 开头的组没有任何派生队列行，读侧四个标题候选全部落空，最终空标题。
- **证据**：
  - [state.ts L191-196](file:///path/to/agent-trace-collector/src/derive/state.ts#L191-L196)：`requestGroupTx` 在 `actor_state !== 'known'` 时直接 `return null`，不进派生队列；[markRequestGroupsTx L199-204](file:///path/to/agent-trace-collector/src/derive/state.ts#L199-L204) 因此也不会把这类组标脏。
  - 库里实测：`conv_key` 以 `["request"` 开头的 key **414 个**，其中 `derive_queue` 有组的 **0 条**。
  - 读侧：[sessions.ts L128-159](file:///path/to/agent-trace-collector/src/queries/sessions.ts#L128-L159) 的 r1–r4 四个标题候选全部 `JOIN derive_queue` 落空；[L172-173](file:///path/to/agent-trace-collector/src/queries/sessions.ts#L172-L173) 的 `SESSION_TITLE_GUARD_SQL` 的 `EXISTS` 为假 → [L217](file:///path/to/agent-trace-collector/src/queries/sessions.ts#L217) `CASE WHEN guard THEN ${SESSION_TITLE_SQL} END` → 空标题。请求行上虽然存了 `title='<model> · <time>'`、`title_source='model_time'`，但组不存在，连 r4 的 `derivedColSql` 回退都轮不到。
  - **最关键的一条**：即使把 F31 的规则改成 `source:web_search → exclude`，当时首屏这 18 张卡（全库同族 136 张）**也不会自动收走**——它们根本没有派生组，列表读的是原始列回退。要收走，必须先让 unknown-actor 的请求组进派生，或单独做一次归并/回填。这条是 F32 的核心结论。
- **影响**：所有 unknown-actor 会话标题为空、flags 缺失（组闸门为假），也无法通过重派生收敛；F31 的修复被这层卡死。
- **根因（已证实）**：派生队列只接收 `actor_state='known'` 的组；unknown-actor 组没有任何派生或回填路径，读侧却仍把它们当会话展示。
- **修复方向（未采纳，待用户拍板）**：让 unknown-actor 组以独立键进派生队列（或对前缀组做一次性归并/回填），并把 `sessions.ts` 的 guard/候选从 `JOIN derive_queue` 改为可回退原始列；需补多 actor / unknown-actor 用例与回填脚本。
  - **改动面比 F26 大**（派生键、队列基数、回填与读侧回退都要动），需单独评估风险，不要写成顺手能修。
- **严重度**：P0。
- **状态**：待修（P2 另立批次，需单独评估风险）；展示缺口已由 `tool_event` 折叠兜住（见[收起方案](../../implemented/bug-fix/2026-11-03-websearch-subevent-cards.md)）。

### 主页卡片核查结论（F31/F32 的定性，非独立 finding）

- **四类归属**：真会话 4 个（`4abeeb02` 336 笔、`189dd9bd` 124 笔、`ad65da93` 20 笔、`97cedc47` 96 笔 Scout）；辅助/派生 = 上述这批（当时首屏 18 张）；孤儿 = 14 条 request 卡（`hook_absent`、ledger-only、`actor/session=NULL`）；**应补正文 = 无**（拿不到 body，不应伪造）。
- **不是父子链**：16:25:14 四条只与 Scout 会话时间吻合（route 823/824/825，`session=NULL`，provider codex），16:26:12 两条紧跟 jingle-lab 的 `WebSearch` tool_use（provider workbuddy）；DB 里没有 session/actor 外键，**不能确证**，标「无法判定」。
- **18:34 三条**是三个独立顶层会话（`4abeeb02` / `189dd9bd` / `ad65da93`，`isSidechain` 全 false、`subagent`/`parent_agent` 全空）；同时冒头是**同一次编排广播**（三条最后一条用户消息都带 `<gugu_delivery route="session-direct" from="咕宝｜协调" … at="2026-11-03 18:34">`），不是并行子代理。
- **标记语义**：`×` = 组内 `status>=400`（`has_failed`）；`○` = 缺正文（`via='through'` 要求 body+ledger+route 三路且 `body_state='available'`）。这批卡全是 `○`，不是 `×`。
- **历史数据未重派生**：17:03 那批 Codex 行仍是 `purpose_version=8` 旧派生（`source:thread_title` / `source:ambient_suggestions` 仍为 `participate/main`），合并进 master 的新规则还没在存量上体现——与 F28（指纹全库为空）互相引用，共同指向「必须跑一次 rebuild/回填」。


## Proposal

今晚按以下顺序处理，先修「让读数可信」的，再修「产生噪音」的，最后做加固：

1. **F18**（P0）：先盘点半成品，决定补完或丢弃；在结论出来前不重启采集器。
2. **F08 + F09**：退出码语义与 p99 阈值。这两条决定告警是否可信；阈值先按本机 p99 中位 ~199 ms 校准到 300 ms。
3. **F10 + F12**：同一处状态机，加恢复持续窗口、`stale` 不判恢复、截断只影响连续性。
4. **F11**：`derive_failed` 进结构化诊断，巡检恢复「Worker 失败」判据。
5. **F14 + F16 + F17**：`spawnSync` 容错、轮转实测、巡检落盘。三项都属于「能不能验收」。
6. **F15 + F04 + F06 + F13**：storage 未知态、pending_hook 清理、重端点缓存、双阈值拆分。
7. **F01/F02/F03/F05/F07**：历史结论与性能观察，视时间修；F05 不改代码。
8. **F19**：单独排期，先补证据再改。

## 修复顺序与依赖（F26–F32 并入今晚清单）

**用户倾向（当时建议，记录于 2026-11-03 诊断阶段；候选 ① 已按此落地，F27-A 仍未动，最终由用户决定）**：本轮诊断倾向 **F26 候选 ① + F27 候选 A，约二十余行，语义不变，但需先确认 F28 写入侧是否损坏**。理由：① 是唯一实测把 300/795/1,285 ms 压回 **1.5/1.5/1.9 ms** 且不改语义的最小改动；A 只处理「并发排队」这一层，不改变 SQL 正确性。F28 若确认写入侧坏了，① 会让跨组绑定「快但永远不绑定」，因此 F28 的定性必须排在验收之前。

### 第一波（顺序固定）

1. **F26（P0）— 已完成**：候选 ① 指纹短路已落地并合入 master（`7d0983c` + merge `396342b`）。验收结果：同一快照新旧码对比，limit 20/50/100 预热中位 **2.4 / 7.5 / 8.0 ms**（旧码 59.9 / 566.2 / 1,187.4 ms）；1,297 个会话标题与 flags 差异 0 条；计划外层入口为 `SEARCH x USING INDEX i_req_session_time`。**F28 未定性，绑定仍未验证**。候选 ③ 未采纳，不要再顺手改。
2. **F28（P0，待查 → 必须核实写入侧）**：只读统计 `started_ms > 重启时刻` 的行里 `purpose_status='recognized'` 数与 `user_fingerprint` 非空数；若「已识别 >0 且指纹=0」，即写入侧被跳过，走 F28 的 (b)。
   - **F28 未定性前，F26 的收益只能写成「消除空转成本」，不能写成「标题绑定修好」**。
3. **重新验证 Codex 四卡 / 标题绑定**：在允许写操作的窗口跑 `maintain rebuild` → `GET /api/sessions?limit=100`（必要时翻页）过滤 `agents=codex`，核对主卡标题「重绘 ATC 矩阵 IP」、`b4ae` 的 `background`、`d007` 折叠、标题线程 `bypass`。这一步同时覆盖 F24/F25 的「仅重启不收敛」与 F28 的回填验证。

### 第二波（与第一波同批或紧接）

4. **F32 + F31（P0/P1，必须同批）**：F31 单独改规则**无收敛效果**（这些卡没有派生组）；F32（让 unknown-actor 组进派生 / 归并回填）改动面比 F26 大，需单独评估风险，不要写成顺手能修。验收：当时首屏那 18 张 `source:web_search` 卡（库内同族 136 张）从主列表消失或降级为辅助；414 个 `["request"` 前缀 key 中至少本次涉及的组有派生行，标题不再为空。
5. **F27 候选 A（single-flight，`src/http.ts` 约 20 行）是否跟随 F26 同批**：**建议跟随，但不阻塞 F26 验收**。依据：F26 修回后 3 标签页 ≈120 ms、5 并发 ≈200 ms；A 把最坏 (N−1)×单发压成 1×单发（实测 995→315 ms）。若今晚有多标签页/多客户端并发验收，同批上；否则可晚一批。
6. **F29（P1，可选，`web/reader-store.js` 约 10 行）**：同 tab 共享 Promise；跨 tab 只能靠 F27-A。F26/A 落地后可只做同 tab 共享。

### 并入晚上统一修复（原有清单，不改变上面的顺序）

- F08 + F09（采纳 F22 的 330 ms）、F10 + F12、F11、F14 + F16 + F17、F15 + F04 + F06 + F13、F03/F02、F01。
- **F18 已修，关闭**（见条目末尾状态更新）。
- **F23 必须在任何重启前完成**（人工 bundle 备份 + 迁移窗口），不要与 F26/F27 的代码改动混在同一个重启窗口。
- F24/F25 是执行层（rebuild + 文档），随第一波第 3 步一起闭环。

### 纯观察项（不修代码，只复测）

- **F30**：冷页成本 ~2.4 s 是 F26 影响下的上界，F26 修完必须用同一方法（同进程首跑 vs 预热）复测后再定论，不能把该数写死。
- **F05**：正常态，不改逻辑。
- **F21**：重启后同脚本同窗口复采，作为 F26/F27 的前后对比基线。
- **F19**：先补证据再决定是否修。
- **F31/F32 的 18:34 归属**：已定性为「同一次编排广播」，不是并行子代理；无新证据不再重查。

### 依赖图（文字版）

```
F18（已修）→ F23（重启前备份）→ 迁移/重启 → F28（写入侧核实）→ F24/F25（rebuild 验收）
F26（①，已修 `396342b`）→ F27（A，待拍板）→ F29（可选）
F32（unknown-actor 进派生）→ F31（规则改 exclude 才可能收敛）→ 首屏 18 张卡收走
F30 依赖 F26 完成；F21 依赖新实例稳定运行
```

## 修复记录（2026-11-04 凌晨批次）

> 本节是批次摘要；决策、取舍与验证细节以 [批次修复 note](../implemented/bug-fix/2026-11-04-monitoring-health-batch-fixes.md) 为准。

分支 `fix/monitor-health-checks`（worktree `atc-monitor-health`），七个单元提交 `--no-ff` 合并 master。全量 `bun test` 1151 通过、`tsc --noEmit` 绿。纯观察项（F03/F05/F07/F15/F19/F30）不改代码；F32 按原计划另立批次。

| 单元 | 提交内容 | 覆盖 |
| --- | --- | --- |
| fix(monitor) | `check` 退出码交代采样证据；p99 330 ms/30 min + `event_loop.max_ms>2 s` 独立通道；`transitionAlerts` 15 分钟恢复窗口、stale 不计时；连续性容差改存活阈值（断档 ≤11 分钟不清窗口）；`sample_gap` 提醒；`inspect` 子命令落盘 `monitor/checks/<day>.jsonl`；`service-support` 三处 spawnSync 包 `spawnText` 容错 | F08/F09/F22/F10/F12/F13/F17/F14 |
| fix(purpose) | `titlePromptText`（input-interpretation 共享导出）：`User prompt:` 标记保留原语义，`<session>` 壳内文本经同一套解释清洗后作指纹 | F28（title 通道） |
| fix(store) | 迁移错误信息带 db/code 版本号；写连接 `busy_timeout` 1 s→5 s | F01/F02 |
| fix(hook) | `reconcilePending` 淘汰无 `response_id` 且超 14 天的孤儿行；带 response_id 的行保留 | F04 |
| perf(stats) | `getStats` 按写世代缓存（`store.writeStats.count` 不变即复用）；`/api/ingest-metrics` 存储复用闸门最近量测，无闸门环境退回现算 | F06 |
| fix(derive) | 轮失败错误码归一（`database_locked`/`table_locked`），`kind:"error"` 记 `op=derive.run` | F11 |
| fix(http) + fix(web) | `/api/sessions` 同 key 单飞（错误共享 rejection，完成即出表）；`reader-store` 布尔闸门改 Promise 共享 | F27-A/F29 |

### 关键验证

- **F16（轮转）**：临时 launchd 探针作业（StandardOutPath 指向临时文件）实测：外部 truncate 后写入从下一条无缝继续（`probe-line-7` 起），无稀疏洞、无丢行——launchd 打开 StandardOutPath 用 O_APPEND，`copyFileSync + truncateSync` 轮转对 launchd 持有的 fd 安全。Bun `FileSink` 非 append 语义的副本实验会出现稀疏洞（归档 2 MiB = 洞 + 数据），那是 Bun 写入器行为，不代表 launchd；探针作业已删除。
- **F09/F22（阈值）**：330 ms 采纳为 `THRESHOLDS.p99Ms`，跨度 30 分钟；`maxLoopMs=2000` 立即通道抓 F07 类单次停顿（事件循环环形窗口约 7 分钟自身限制存续）。
- **F12（截断）**：告警窗口的连续性容差改为 `MISSING_SAMPLE_MS`（11 分钟）：一个漏采样本与 9 分钟断档都不清窗口，超过存活阈值才重新起算；`maxGapMs`（7.5 分钟）只留给 `sample_gap` 判据与报告统计。
- **F08（退出码）**：`check` 以最新样本判定（`sampleEvidenceOk`：有样本、成功、在存活阈值内），`sample; check` 的 shell 语义不变。
- **测试**：新增/改写 monitor 6 条、`titlePromptText` 1 条、Claude 标题指纹 1 条、pending_hook TTL 1 条、stats 世代缓存 1 条、snapshot 复用 1 条、single-flight 1 条（含错误广播与出表）、reader-store 并发共享 1 条；store 版本断言收紧到含版本号。守门测试「结算代码不出现 harness 品牌字面」抓到过注释里的品牌词，已改写。

### 遗留

- F28 的 `turn_ref` 通道仍待查（OTLP `mapping.turnRef` 是否有新数据）。
- F01 的 `verify-cutover` 只读预检未做；F03 的 claude 侧 hook 排查、F07 的探针分段计时、F32（unknown-actor 进派生）、F19 证据补全各自另立批次。
- F24/F23 的执行层（显式 rebuild 四条 Codex 会话、停服 bundle 备份、重启）随 2026-11-04 回归窗口执行，结果回填本文。

## Acceptance criteria

- `launchctl print` 的 last exit code 能反映 `sample` 失败；人为制造一次失败后退出码非 0。
- 连续 6 小时无「p99 常亮」告警；人为把 p99 顶到 300 ms 以上时能触发，回落后需满足恢复窗口才写 `recovered`。
- `monitor/alerts/<day>.jsonl` 中触发与恢复成对，无单样本抖动造成的 recovered。
- `derive_failed` 在结构化日志中有对应 `kind:"error"` 记录，巡检计数非 0。
- `monitor/checks/<day>.jsonl` 每次巡检都有记录，含时间与判据结果。
- 用 1 MiB 临时阈值跑一次轮转，归档行数 + 当前行数 = 轮转前行数。
- `node scripts/verify-agent-note-format.mjs` 通过；`bun test` 与 `tsc --noEmit` 保持绿。
- **F26**：预热后 `GET /api/sessions?limit=50` 中位 ≤40 ms（纯 SQL 实测 1.5 ms 口径，允许 HTTP/JSON 开销）；`EXPLAIN QUERY PLAN` 里跨组标题子查询不再由 `i_derive_queue_dirty` 驱动，`limit=20/50/100` 三档都不再出现 ~300/795/1,285 ms 的线性增长。**已达成（2026-11-03）**：同快照 2.4 / 7.5 / 8.0 ms；计划外层入口为 `SEARCH x USING INDEX i_req_session_time`，`qt` 仅作为 CASE 分支的静态计划保留。
- **F27-A**：同一 `limit` 的 3 个并发请求只执行 1 次 SQL，三者返回同一快照；错误广播给所有等待者，无永久挂起；live 字段（60 s 活跃窗口）不参与缓存复用。
- **F28**：新请求的 `user_fingerprint` 非空计数随流量增长；若确认为通道跳过，必须能在诊断里看到 `skipped(reason)`，而不是继续为 0。
- **F30**：F26 修复后按「同进程首跑 vs 预热」复测，冷加成数字重新记录，不沿用 2,721/3,287 的上界。
- **F31 + F32**：当时首屏那 18 张 `source:web_search` 卡（库内同族 136 张）从主列表消失或标为辅助；`["request"` 前缀的 414 个 key 有派生组（或读侧有原始列回退且标题非空）；单独只改 F31 规则时，明确记录「卡仍在」作为反证。

## Risks

- 调高 p99 阈值会掩盖真实的事件循环停顿（今天已观测到 7.8–10.8 s 的一次），必须同时保留 `max_ms` 或「单次 >2 s」的独立告警。
- 给 `pending_hook` 加 TTL 可能删掉「迟到但会到」的回调；需要保留 `response_id` 可关联的行。
- 改 `sh -c` 的退出码语义后，launchd 可能开始频繁标记失败并触发通知；需要先确认失败判定不会把「单次探测超时」升级成噪音。
- 轮转改造若切换实现（符号链接/新文件），launchd 的 `StandardOutPath` 需要同步调整，否则日志会写进旧 inode。
- **F26 候选 ① 在 F28 未解决前会让跨组标题持续为空**：它把「本来就不会命中」变成「明确不尝试」。必须与 F28 一起验收，不能把「快了」当成「绑上了」。另：候选①的收益依赖「大部分组没有指纹」。22:57 快照实测 current 881.8 ms → 候选① 0.7 ms（页内 50 组只有 2 组有指纹）；F28 的 title 指纹修好、更多组有指纹后，这些组仍走完整子查询（每组约 15–18 ms），候选①会逐步退化，需复测，不能当成结构修复。
- **F26 候选 ③（批量预取）**改动标题优先级链与游标语义，需重跑多 actor / 同毫秒 / 迟到旧请求用例；回归风险高于 ①，未选前不要顺手改。
- **F27-A single-flight**：同 key 共享同一快照（毫秒级差异不可见）；错误必须广播，否则等待者永久挂起；不能与 live 字段共用缓存键。
- **F32 让 unknown-actor 组进派生**会显著增加派生队列基数（当前样本仅 `["request"` 前缀就有 414 个 key），首轮回填可能长时间占主线程；必须在允许写操作的窗口做，并先预估队列大小与耗时。

## 附录 A：复现与探针（不依赖 `/tmp`）

A.0 原则：所有读数来自 `VACUUM INTO` 只读快照；`/tmp` 只作临时落点，路径可随时被清掉，**方法与命令以本节为准**，不依赖任何历史脚本文件。生产库始终只读、未重启、未写库。

### A.1 生成只读快照

```bash
# 数据目录以实际部署为准；本机历史路径含空格，注意引号
DB="$HOME/Library/Application Support/agent-trace-collector/trace.db"
SNAP=/tmp/atc-diag/trace-snap.db
mkdir -p /tmp/atc-diag
sqlite3 -readonly "$DB" "VACUUM INTO '$SNAP'"
sqlite3 -readonly "$SNAP" "PRAGMA user_version; PRAGMA integrity_check; \
  SELECT COUNT(*) FROM request; SELECT COUNT(DISTINCT conv_key) FROM request; \
  SELECT COUNT(*) FROM request WHERE user_fingerprint IS NOT NULL; \
  SELECT COUNT(*) FROM request WHERE turn_ref IS NOT NULL;"
```

- `VACUUM INTO` 对源库只读，产物是单文件、无 `-wal/-shm`。3.6–3.9 GB 库约 4.35 s（F20 实测）。
- 冷/热对比必须在**同一进程**内先跑一次、再跑第二次；跨进程读数会混入页缓存差异。

### A.2 F26：两段 SQL 与计时

阶段一（候选会话；完整版 [sessions.ts L196-213](file:///path/to/agent-trace-collector/src/queries/sessions.ts#L196-L213)）：

```sql
SELECT conv_key, MAX(started_ms) AS last_ms FROM request
WHERE conv_key IS NOT NULL GROUP BY conv_key
ORDER BY last_ms DESC, conv_key DESC LIMIT ?;
```

阶段二（页内聚合，节选；完整版 [sessions.ts L215-223](file:///path/to/agent-trace-collector/src/queries/sessions.ts#L215-L223)）：

```sql
SELECT conv_key, MAX(started_ms) AS last_ms, COUNT(*) AS request_count,
       CASE WHEN EXISTS (SELECT 1 FROM derive_queue g
         WHERE g.conv_key = request.conv_key AND <groupCurrentSql(g)>)
       THEN <SESSION_TITLE_SQL> END AS title,
       GROUP_CONCAT(DISTINCT agent) AS agents, <SESSION_FLAG_COLUMNS>
FROM request WHERE conv_key IN (?,?,…) GROUP BY conv_key;
```

- `<SESSION_TITLE_SQL>` 见 [sessions.ts L128-159](file:///path/to/agent-trace-collector/src/queries/sessions.ts#L128-L159)，跨组分支 `CROSS_GROUP_TITLE_SQL` 见 [L101-116](file:///path/to/agent-trace-collector/src/queries/sessions.ts#L101-L116)。
- **归因方法（差值计时）**：同一份阶段二 SQL，只把 `${CROSS_GROUP_TITLE_SQL}` 换成 `NULL`，其余不变；两次结果差即跨组绑定成本（F26 表里 `no-cross` = 2.5–2.9 ms）。
- **候选 ① 的验证形态**：把 `${CROSS_GROUP_TITLE_SQL}` 包成 `CASE WHEN EXISTS (SELECT 1 FROM request x WHERE x.conv_key = request.conv_key AND x.user_fingerprint IS NOT NULL) THEN <原表达式> END`，同法计时。

`EXPLAIN QUERY PLAN`：

```ts
const plan = store.read.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params)
```

- `CROSS_GROUP_TITLE_SQL` 里 `request.conv_key` 出现 **4 次**，参数要按出现次数补齐（本次 `get(key,key,key,key)` 共 4 个），否则会报「参数个数不匹配」——这是本次踩过的坑。
- 判据：计划中出现 `SEARCH qt USING INDEX i_derive_queue_dirty (state=?)` 作为跨组子查询驱动、随后 `SEARCH t USING INDEX i_req_conv (conv_key=? AND actor=?)`，即命中 F26。

单发计时：

```ts
const t0 = performance.now();
const page = listSessions(store, limit, null, null);
const t1 = performance.now();  // 每档至少 3 次取中位；首跑与预热分开记
```

### A.3 F27：并发与「主线程推迟」探针

- 形态：`Bun.serve` 的 `fetch` 回调内**不 await** 地调用 `listSessions`（与 [http.ts L519-525](file:///path/to/agent-trace-collector/src/http.ts#L519-L525) 同形），并发 N 个 HTTP 请求。
- 「推迟」测法：与任务同一 tick 注册 `setTimeout(0)` 的纯内存探针（读常量或 `/api/metrics` 的内存字段），记录实际触发时间与发起时间差。
- **必须先 `await setTimeout(0)` 再读探针时间**，否则会得到「never」伪结果（本次踩过）。
- 基线：`/api/metrics` 纯内存路径自身 **0.01 ms**；`getStats` 自身 **59.7 ms**；紧随一次 sessions 之后，stats 要等 **+315.8 ms** 才开始。

```ts
// N 并发墙钟
const t0 = performance.now();
await Promise.all(Array.from({ length: n }, async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/sessions?limit=20`, { headers });
  await r.text();
}));
const wall = performance.now() - t0;

// 推迟探针
let probeAt = NaN;
setTimeout(() => { probeAt = performance.now(); }, 0);
const start = performance.now();
await tasks;
await setTimeout(0);
const delay = probeAt - start;
```

### A.4 关键数字速查（与正文各条一致）

| 项 | 数值 | 出处 |
| --- | --- | --- |
| 阶段一候选（limit=50/100） | 1.7 ms | F26 |
| 原有标题四路 + 组闸门 | 2.5–3.3 ms | F26 |
| 跨组绑定（limit=20/50/100） | ~300 / ~795 / ~1,285 ms | F26 |
| 单发合计（预热） | 302–315 / 795–830 / 1,285–1,350 ms | F26 |
| `no-cross` 替身 | 2.5–2.9 ms | F26 |
| 候选 ① 指纹短路 | 1.5 / 1.5 / 1.9 ms | F26 |
| 候选 ② 全量索引 | 782.3 ms（对照 767–795） | F26 |
| background / 识别主卡聚合 | <1 ms | F26 |
| 并发 1/2/3/5 墙钟 | 312.9 / 683.4 / 995.0 / 1,603.7 ms | F27 |
| 纯内存 metrics 被推迟 | 311.1 / 682.2 / 993.6 / 1,602.2 ms | F27 |
| 冷跑 vs 预热 limit=20 | 2,721 vs 302 ms | F30（上界） |
| 冷跑 vs 预热 limit=50 | 3,287 vs 825 ms | F30（上界） |

## Alternatives considered

- **直接写 `.agents/notes/daily/2026-11-03.md`（用户指定的位置）**：`scripts/agent-note-tree.mjs` 的活动生命周期是封闭集合 `proposed/implemented/rejected`，顶层出现 `daily/` 会被判为「未知生命周期目录」，`verify-agent-note-format.mjs` 必失败；`verify-change-notes.mjs` 的 note 路径正则也不接受 `daily/`。因此落选。
- **放到 `docs/` 或仓库根目录的 `daily/`**：不参与 note 门禁，但会形成第二套笔记体系，后续检索与归档都游离在既有约定之外。落选。
- **一条 finding 一篇 Agent Note**：字段更整齐，但 19 篇会稀释注意力、破坏「晚上逐条处理」的单页清单，且互相引用成本高。落选，改为单篇分节。
- **只写 stderr/monitor.log 摘要，不落仓库**：不满足用户「记账、晚上统一修」的可追溯要求。落选。
