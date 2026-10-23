# ATC 容量基线与收敛实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 执行会话缺少上述技能时，逐任务执行相同的测试与复核，不虚构技能调用。本文编排合成容量实验、观测代码与条件切片，不授权真实库回填、服务切换、push 或外部发布。每个提交步骤只有在执行会话获得提交授权后才执行，否则保留可审阅改动。

**Goal:** 用可重复的合成负载建立 ATC 采集、查询和派生的容量基线，先冻结预算再做优化；测量达标时保留同步派生，测量失败且长组是主因时才迁移到 v6 切片派生。

**Architecture:** 复用 `startCollector(config)`、`createHandler` 和现有 `Config` 注入路径，在独立临时目录、合成来源、回环端口和合成上游上运行负载。生产侧只增加固定原因进程计数、有界时延记录、写事务统计和认证统计入口；基线报告写入临时路径，预算由报告生成并冻结到 `docs/superpowers/capacity/`，门槛脚本在预算缺失时拒绝宣布完成。路由文件先算哈希再决定是否解压。派生切片沿用 `drainDeriveTx(db,{limit,scope})` 唯一完整入口，在 v5 组记录之上增加 v6 代际、暂存结果、发布指针和预算调度，只有决策为长组主因时才实施。

**Tech Stack:** TypeScript、Bun 1.4.0、`bun:sqlite`、`node:zlib`、原生 JavaScript；不增加第三方运行依赖。

**Spec:** [v2 容量目标](../../architecture-evolution-v2.md#容量目标与验证方法)、[v2 派生执行](../../architecture-evolution-v2.md#派生执行与调度)、[总入口](2026-10-22-atc-evolution-implementation.md)、[A 同步派生计划](2026-10-22-atc-derive-correctness.md)、[拒绝观测边界](../../agent-request-kind-review.md#拒绝观测边界)、[现行架构](../../architecture-design.md)、[运维手册](../../operations.md)。

## Global Constraints

- 单进程 TypeScript + Bun、SQLite WAL 与单 writer、独立只读连接、原生 JavaScript 页面，不增加第三方运行依赖。
- 监听地址写死 `127.0.0.1`；数据目录在仓库外，文件权限 0600、目录 0700。
- 合成实验只使用 `mkdtempSync(join(tmpdir(), 'atc-capacity-'))` 创建的新目录；账本、路由、数据库、令牌、报告和临时上游都在该目录下，不使用默认数据路径。
- 测试与负载只用合成请求正文、合成账号、合成会话和合成模型名；真实请求正文、账号、令牌和用户配置不进入 fixture、日志、报告或提交。
- 不扩大准入：`MAX_ENVELOPE_BYTES`、单 envelope 的 `ingesting` 互斥、429 背压、正文预算和磁盘门槛保持现值；F 只观测拒绝，不放宽任何一道限制。
- 拒绝统计只保存固定原因码和计数，不保存被拒正文、请求头、来源字符串或任意错误文本；统计入口只走本地认证的读取路径。
- `limit` 继续表示一次 `drainDeriveTx` 选择的组数；`processed`/`remaining`/`groups` 沿用 A 的定义。切片预算通过可选配置进入，不改变这些字段含义。同步与切片都在单 writer 内执行，不引入并发写入者。
- A 的同步完整入口是切片等价性的 oracle。F 不另造第二套派生链，不恢复 A 已取消的 `pairToolCalls` 公共入口。
- `derive_version` 是旧计数器，不是算法版本。C 已移除增量写入；F 的观测、预算、迁移和等价性都不读取它来证明算法覆盖或重算范围。
- C 的 v5 schema 与 `src/derive-state.ts` 公共失效助手是切片前提。F 只读 C 的契约，不在本计划期间修改 C 的文件；v6 迁移只在决策成立后创建。
- 查询按整代读取。`published_generation` 非空时只读该代 `derive_request_result` 与 `derive_tool_result`，字段为 NULL 也保持 NULL；禁止逐字段 `COALESCE` 回退到 `request` 或 `tool_call`。只有整个组没有代际且迁移明确 `legacy_snapshot=1` 时，才整体读旧列。
- `state <> 'clean'` 的组在当前会话与请求列表中整体屏蔽；详情可以读原 `published_generation` 并附 `derive_state`。工具关联同样只认唯一代际，不跨代回退。
- 未测值不写成事实。基线报告记录原始观测；预算文件为每个门槛写明 `basis`，取值为 `code-constant`、`product-target`、`baseline-envelope` 或 `proposed`，后两类必须在最终报告中单列。
- 预算文件缺失、报告缺失或报告 schema 不匹配时，门槛脚本退出 2；任何检查失败退出 1。退出 2 或 1 都不能宣布容量目标完成。
- 真实库操作、服务切换、push 与提交均不在本计划中自动授权。10 分钟负载只在获得容量实验授权后运行；编写本计划时不运行。

---

## 执行前提与条件分支

### 基准与依赖

编写基准为 ATC `00e20a2`。A 计划完成后，`drainDeriveTx(db,{limit,scope,purposeLimit?})` 承担链、角色、工具、摘要和完成确认的完整同步事务；C 已冻结 `DeriveScope={convKey:string}`。F 的基线与切片都以该入口为准。C 的 v5 schema 是切片分支的硬前提：`request.input_epoch`、`request.input_revision`、`derive_queue.group_epoch`、`derive_queue.input_revision`、`derive_queue.published_revision`、`derive_queue.state` 与 `src/derive-state.ts` 的 `markRequestInputTx`、`markGroupDirtyTx`、`markRequestGroupsTx` 必须先存在。D 的统一 `drainDeriveTx` 顺序必须是 request purpose 在前、groups 在后；F 只在 group 阶段内部增加可选预算，不改变 purpose 门控。

执行每个任务前先核对：

```sh
cd /Users/pis/workspace_intelligence/creator-intelligence/repos/agent-trace-collector
git rev-parse HEAD
git status --short
bun --version
```

如果 HEAD 已前进，按函数名和文件职责定位，不把本文行号当补丁。A 未完成时只能执行 Part I 的观测与隔离任务，不能运行依赖完整 `drainDeriveTx` 的长组场景；C 未完成时不能进入 Part V。

### C 的 v5 共享契约

F 依赖 C 已冻结的以下事实，不重新定义：

- `request` 有 `input_epoch TEXT`、`input_revision INTEGER`、`purpose_*` 列、`source_facts_json`、`projection_meta_json`、`summary_algorithm INTEGER`、`summary_basis TEXT`、`summary_state TEXT`；`tool_call` 有 `algorithm_version INTEGER`、`basis_json TEXT`、`retention_state TEXT`。
- `derive_queue` 保留 clean 行，键为 `(conv_key, actor)`，含 `group_epoch`、`input_revision`、`published_revision`、`target_algorithm`、`published_algorithm`、`state`、`from_sort`、`dirty_since_ms INTEGER`（可空）。C 的 `markGroupDirtyTx` 在插入时写 `now`；冲突时 `input_revision + 1`，`dirty_since_ms` 用 `CASE WHEN state='clean' THEN excluded.dirty_since_ms ELSE COALESCE(derive_queue.dirty_since_ms,excluded.dirty_since_ms) END`，所以第一次从 clean 变 dirty 时取本次 `now`，已是 dirty 时保留最早值，旧行该列为 NULL 时补本次 `now`；ack 写 `published_revision=input_revision`、置 clean 并把 `dirty_since_ms` 置 NULL。F 的 v6 `publishGeneration` 走同一语义，不把 NULL 当 0 或历史时间。空组也保留 clean 行。
- C 的当前查询屏蔽条件是 `state <> 'clean'`。v6 不新增 `running` 状态，构建中的组仍是 `dirty`，用 `compute_generation IS NOT NULL` 表示已认领，因此 C 的读取判断不需要改。
- C 的公共 `DrainResult` 在 A 的 `processed`、`remaining`、`groups`、`recomputed`、`retained` 之外增加 `purpose_processed` 与 `purpose_remaining`。F 的切片返回值保留这两个字段，purpose 阶段继续由 D 的统一入口驱动，F 只处理其后的 group 阶段。
- C 移除增量 `derive_version` 写入；新 summary 与 tool 算法写固定的 actual metadata。F 不把 `derive_version` 当作算法版本或覆盖率，不重新解释旧 counter；迁移只搬运 `summary_algorithm`、`summary_basis`、`summary_state`、`tool_call.algorithm_version`、`tool_call.basis_json`、`tool_call.retention_state` 的现有值。
- C 提供 `src/derive-state.ts` 的 `markRequestInputTx(db, reqId)`、`markGroupDirtyTx(db, convKey, actor, fromSort)`、`markRequestGroupsTx(db, reqId)`。v5 没有 `compute_generation` 列；F v6 增加该列后，由 F 的 `markGroupDirtyV6Tx` 在调用 C 助手后保留它，C 的助手不引用不存在的列。
- `source_facts_json`、`projection_meta_json` 的 JSON 形状以 C 的文档为准。C 对这两个 JSON 列各设 16 KiB 硬上限；selected 的非错误字符串不超过 256 UTF-8 字节，error 摘要不超过 512 字符，`basis` 不超过 16×256 字节。超长身份写 null 并把族标成 `retained/invalid_input`，不截断后当成有效身份；序列化超预算时拒绝该事务且不清除旧事实。F 的迁移、观测和等价性只读取与计长，不截断、不修复、不重新解释这些值；来源 JSON 的字节数计入 Task 1 的 `metadataSnapshot`。F 的迁移只复制 `summary_basis`、`summary_algorithm`、`summary_state`、`tool_call.basis_json`、`tool_call.algorithm_version`、`tool_call.retention_state`，超过 4096 字节的 basis 写 `invalid_input` 标记并保持 `retained`，旧列值原样留在 v5 列中。
- C 负责在合并、归属变化和正文回收路径调用失效助手。F 在切片各阶段开始、每片结束和发布前校验修订；集成测试发现失效未传播时，先报告契约缺口，不在本计划中改 C 文件。

### 两条条件分支

本文只有两条完成路径，判定由 Task 11 的 `decideCapacity` 产生。

| 分支 | 条件 | 必须交付 |
| --- | --- | --- |
| A：保留同步 | 最终基线门槛通过，或失败项不属于长组主因 | 观测代码、负载器、冻结预算、最终报告、文档；不创建 v6 文件，不迁移 schema |
| B：长组切片 | 最终门槛失败，且失败严重度最高的场景是 `long-10000`，至少一项失败来自 `max_write_tx_ms`、`event_loop_p99_ms` 或 `drain_ms`，其它场景没有绝对门槛失败 | Task 13 至 Task 19 全部完成，v6 迁移、发布指针、同快照查询、等价性与切片容量门槛全部通过 |

失败但不是长组主因时，Task 11 写入 `stop-non-long`：它表示当前同步设计不能按现状发布，保留同步路径并列出实际失败项。该结果不能宣布容量目标完成。是否进入 Part V 由产品决定与脚本判定分开：`decideCapacity` 不为产品决定代签，产品目标未达成时按 Part V 的执行条件另行触发，触发理由记在决策文件之外。

### 观测口径

所有时间单位是毫秒，字节单位是字节。分位数使用最近秩：排序后取 `Math.min(n - 1, Math.ceil(q * n) - 1)`，空样本返回 `null`，不把 0 当缺失。

| 指标 | 来源 | 口径 |
| --- | --- | --- |
| `hook_latency` | 负载端 | 每次 POST `/hook/ingest` 从发出到响应头的墙钟时间，包含 429 重试的每次尝试 |
| `query_latency` | 负载端 | `/api/sessions`、`/api/sessions/:key/requests`、`/api/requests/:id/body` 的端到端时间 |
| `accepted` | 负载端与采集器 | 负载端最终 200 的 hook 数；采集器 `accepted` 含重复，`duplicates` 单列 |
| `rejected` | 采集器 | 固定原因进程计数，按 `REJECT_REASONS` 分类；注明 `started_at_ms` 与重启归零 |
| `retried` | 负载端 | 429 或 503 后再次尝试的次数，按原因记录 |
| `max_write_tx_ms` | `Store.writeStats` | 进程内所有 `store.write` 从进入包装到事务返回的最长墙钟时间，包含提交等待 |
| `event_loop` | 采集器 | 50 ms 定时器的实际间隔减 50 ms，负值记 0；环形缓冲上限 8192 个样本 |
| `rss_bytes` | 采集器 | `process.memoryUsage().rss`，采集器进程的常驻集 |
| `storage` | 采集器 | `measureStorage(store, dataDir)` 的 `db_bytes`、`wal_bytes`、`temp_bytes`、`body_bytes`、`freelist_count` |
| `metadata` | 采集器 | `metadataSnapshot(store)` 的逻辑字节：clean 组队列行、`source_facts_json`、`projection_meta_json`、已发布代结果字段。增长估算同时使用 `per_clean_group_bytes` 与 `per_request_bytes`，不能只数 dirty 组或只数结果表 |
| `derive_queue` | 采集器 | v5 起按 `state <> 'clean'` 计未发布组；v4 兼容路径计全部行。v6 构建中的组仍为 `dirty`，`compute_generation` 非空只表示已认领。`pending_groups` 是组数，用队列行单独 COUNT；`oldest_dirty_age_ms = now - MIN(dirty_since_ms)` 是排队年龄；`oldest_request_age_ms = now - MIN(request.started_ms)` 只是最老请求年龄，不能当积压年龄 |
| `drain_ms` | 负载端 | 停止输入后从最后一次 hook 响应到 `pending_groups` 首次为 0 的时间，包含 2 秒调度间隔 |
| `conservation` | 采集器停止后的只读连接 | `raw_hook`、`request_evidence`、`request`、`raw_route`、`route_summary` 的计数与负载端账目对齐 |

不把 `derive_version = MAX(...)` 当作算法覆盖证明，不把 HTTP 200 当作正文已持久化，不把进程重启前的计数带入重启后的报告。

### 预算与门槛文件

预算文件路径固定为 `docs/superpowers/capacity/2026-10-22-atc-capacity-budget.json`。该路径在 Task 7 由基线报告生成并冻结；执行会话没有提交授权时，文件留在工作区，不能声称已冻结到版本库。

预算文件的 TypeScript 形状：

```ts
export type ThresholdBasis = 'code-constant' | 'product-target' | 'baseline-envelope' | 'proposed';

export type ScenarioBudget = {
  basis: Record<string, ThresholdBasis>;
  max: Record<string, number>;
  min: Record<string, number>;
};

export type CapacityBudget = {
  schema: 1;
  frozen_at: string;
  source_report: string;
  source_report_sha256: string;
  bun_version: string;
  scenarios: Record<string, ScenarioBudget>;
  retention: {
    max: Record<string, number>;
    basis: Record<string, ThresholdBasis>;
  };
  slice?: {
    frozen_at: string;
    source_calibration: string;
    max: Record<string, number>;
    basis: Record<string, ThresholdBasis>;
    derive_budget: {
      max_requests_per_slice: number;
      max_writes_per_slice: number;
      max_candidates_per_call: number;
      max_fingerprints_per_request: number;
      max_slice_ms: number;
      max_generation_bytes: number;
      max_wal_bytes: number;
      retain_generations: number;
    };
  };
};
```

报告文件的 TypeScript 形状：

```ts
export type DurationSummary = {
  count: number;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  max_ms: number | null;
};

export type ScenarioReport = {
  schema: 1;
  scenario: string;
  mode: 'baseline' | 'optimized' | 'slice';
  started_at: string;
  duration_ms: number;
  seed: number;
  environment: { bun: string; platform: string; arch: string };
  config: Record<string, number | string | boolean | null>;
  client: {
    attempts: number;
    accepted: number;
    duplicates: number;
    retried: number;
    failed: number;
    hook_latency: DurationSummary;
    query_latency: DurationSummary;
  };
  collector: {
    started_at_ms: number;
    uptime_ms: number;
    ingest: {
      accepted: number;
      duplicates: number;
      rejected_total: number;
      rejected_by_reason: Record<string, number>;
      accepted_request_bytes: number;
      accepted_reply_bytes: number;
    };
    writer: { count: number; total_ms: number; max_ms: number };
    event_loop: DurationSummary & { interval_ms: number };
    jobs: Record<string, { count: number; total_ms: number; max_ms: number }>;
    route: { polls: number; files_seen: number; decoded: number; unchanged: number; errors: number };
    rss_peak_bytes: number;
    storage_peak: {
      db_bytes: number; wal_bytes: number; temp_bytes: number;
      body_bytes: number; total_bytes: number; freelist_count: number;
    };
    metadata: {
      clean_groups: number;
      source_facts_json_bytes: number;
      projection_meta_json_bytes: number;
      queue_clean_bytes: number;
      result_metadata_bytes: number;
      total_bytes: number;
      per_clean_group_bytes: number | null;
      per_request_bytes: number | null;
    };
    derive_queue: {
      pending_groups: number;
      oldest_dirty_since_ms: number | null; oldest_dirty_age_ms: number | null;
      oldest_request_started_ms: number | null; oldest_request_age_ms: number | null;
    };
  };
  derive: {
    backlog_max_age_ms: number | null;
    drain_ms: number | null;
    drain_polls: number;
    pending_groups_end: number;
    comparisons: number | null;
    decodes: number | null;
    full_incremental_equal: boolean | null;
    result_sha256: string | null;
    published_generations: number | null;
    discarded_generations: number | null;
  };
  conservation: {
    hook_accepted: number;
    raw_hook_rows: number;
    request_rows: number;
    evidence_rows: number;
    route_rows: number;
    missing: string[];
  };
  notes: string[];
  ok: boolean;
};
```

门槛检查从预算的 `max` 与 `min` 自变量读取，不写死在脚本里。`basis` 缺一项、值为非有限数、`schema` 不为 1、`source_report_sha256` 不是 64 位十六进制时，加载失败并退出 2。

已存在代码或配置给出的限制使用 `code-constant` 或 `product-target`：hook 端到端 2000 ms 来自 `gatewayTimeoutMs`，会话列表 100 ms 来自 v2 的验收目标，正文预算与磁盘门槛来自 `Config`。其余延迟、RSS、写事务、积压年龄和排空时间先由基线报告乘 1.25 形成 `baseline-envelope`；需要绝对上限的写事务、排空与积压项写 `proposed`，最终报告必须单列。`max_write_tx_ms=900` 不是 `busy_timeout` 的推导结果：`busy_timeout` 只决定其它连接等待写锁多久，不能证明 900 ms 事务必然提交成功，因此该值标为 `proposed`。任何 `proposed` 值都不是已验证事实。

---

## 文件与 Interface

| 文件 | 职责 | 本次是否创建运行时 |
| --- | --- | --- |
| `src/capacity.ts` | 固定原因计数、分位记录、事件循环采样、路由与作业计数、队列快照、隔离断言 | 执行时创建 |
| `src/store.ts` | `Store.writeStats` 记录写事务次数、总时长与最长时长 | 执行时修改 |
| `src/http.ts` | hook 拒绝分支计数、`GET /api/ingest-metrics` 认证入口 | 执行时修改 |
| `src/main.ts` | 创建观测运行时、采样事件循环、按可选间隔注入作业、把统计传给 handler | 执行时修改 |
| `src/config.ts` | Part I 只加可选 `intervals`；分支 B 才加可选 `deriveBudget`，缺省值保持现有常量 | 执行时修改 |
| `src/sources/files.ts` | 路由文件先哈希后解压，返回 `decoded`、`unchanged`、`error` 三态 | 执行时修改 |
| `scripts/capacity-support.ts` | 合成 payload、账本/路由行、假上游、配置构造与隔离检查 | 执行时创建 |
| `scripts/capacity-collector.ts` | 子进程入口，读取注入配置并调用 `startCollector` | 执行时创建 |
| `scripts/capacity.ts` | 场景规划、负载驱动、报告写入、预算生成与校准 | 执行时创建 |
| `scripts/capacity-gate.ts` | 读取预算与报告、执行门槛检查、决定退出码 | 执行时创建 |
| `tests/capacity.test.ts` | 计数、分位、隔离、场景规划与预算门槛单元测试 | 执行时创建 |
| `tests/capacity-gate.test.ts` | 预算缺失、字段缺失、通过/失败与退出码测试 | 执行时创建 |
| `tests/http.test.ts` | 拒绝计数、认证入口、拒绝正文不入统计 | 执行时修改 |
| `tests/files.test.ts` | 哈希先于解压、替换检测、损坏 gzip、跨午夜 | 执行时修改 |
| `tests/store.test.ts` | 写事务统计 | 执行时修改 |
| `docs/superpowers/capacity/2026-10-22-atc-capacity-budget.json` | 冻结预算，Task 7 生成 | 执行时创建 |
| `docs/superpowers/capacity/2026-10-22-atc-capacity-decision.json` | 分支判定与失败项，Task 11 生成 | 执行时创建 |
| `src/schema-v6.sql` | v6 代际、暂存结果、工作表、视图与队列重建 DDL | 仅分支 B 创建 |
| `scripts/migrate-v6.ts` | ~~v5 到 v6 的显式、可续跑迁移~~ | 不创建：迁移已按用户决定取消，旧库删除重建 |
| `src/maintenance.ts` | 只把 C 导出的 `RESTORABLE_SCHEMA_VERSIONS` 扩为 `[5,6]`（Task 13b） | 仅分支 B 修改 |
| `tests/maintenance.test.ts` | 在 C 的 bundle 用例旁补 v6 白名单与 incomplete 恢复用例 | 仅分支 B 修改 |
| `src/derive-slice.ts` | 代际调度、切片写入、发布、丢弃、清理与祖先索引 | 仅分支 B 创建 |
| `tests/derive-slice.test.ts` | 切片等价性、失效与重开 | 仅分支 B 创建（`tests/migrate-v6.test.ts` 不创建） |

公共 Interface：

```ts
// src/capacity.ts
export const REJECT_REASONS = [
  'hook_unavailable', 'host', 'origin', 'unauthorized', 'method_not_allowed',
  'busy', 'envelope_too_large', 'invalid_json', 'missing_hook_id',
  'origin_not_local', 'insufficient_storage', 'writer_failed',
] as const;
export type RejectReason = typeof REJECT_REASONS[number];

export type IngestMetrics = {
  reject(reason: RejectReason): void;
  accept(input: { duplicate: boolean; requestBytes: number; replyBytes: number }): void;
  snapshot(now?: number): {
    started_at_ms: number; now_ms: number; uptime_ms: number;
    accepted: number; duplicates: number;
    accepted_request_bytes: number; accepted_reply_bytes: number;
    rejected_total: number; rejected_by_reason: Record<RejectReason, number>;
  };
};

export type CapacityMetrics = {
  startedAt: number;
  ingest: IngestMetrics;
  route: {
    record(input: { files: number; decoded: number; unchanged: number; errors: number }): void;
    snapshot(): { polls: number; files_seen: number; decoded: number; unchanged: number; errors: number };
  };
  jobs: {
    record(name: string, ms: number): void;
    snapshot(): Record<string, { count: number; total_ms: number; max_ms: number }>;
  };
  eventLoop: {
    start(): void;
    stop(): void;
    snapshot(): DurationSummary & { interval_ms: number };
  };
  snapshot(store: Store, dataDir: string): Record<string, unknown>;
};

export function summarizeDurations(values: readonly number[]): DurationSummary;
export function createIngestMetrics(startedAt?: number): IngestMetrics;
export function createCapacityMetrics(store: Store, dataDir: string, startedAt?: number): CapacityMetrics;
export function assertCapacityIsolation(input: {
  root: string; config: Config; upstreamPort: number;
}): void;
export function queueSnapshot(store: Store): {
  pending_groups: number;
  oldest_dirty_since_ms: number | null; oldest_dirty_age_ms: number | null;
  oldest_request_started_ms: number | null; oldest_request_age_ms: number | null;
};

export type MetadataSnapshot = {
  clean_groups: number;
  source_facts_json_bytes: number;
  projection_meta_json_bytes: number;
  queue_clean_bytes: number;
  result_metadata_bytes: number;
  total_bytes: number;
  per_clean_group_bytes: number | null;
  per_request_bytes: number | null;
};
export function metadataSnapshot(store: Store): MetadataSnapshot;

// src/store.ts
export type WriteStats = { count: number; total_ms: number; max_ms: number };
export type Store = {
  db: Database; read: Database;
  write<T>(fn: (db: Database) => T): T;
  writeStats: WriteStats;
  close(): void;
};

// src/http.ts
export function createHandler(
  store: Store,
  config: Config,
  readToken: string,
  hook?: { token: string; salt: Uint8Array; admission?: () => HookAdmission },
  metrics?: CapacityMetrics,
): (req: Request) => Promise<Response>;

// scripts/capacity-gate.ts
export type GateFailure = {
  scenario: string; check: string; actual: number; limit: number;
  kind: 'max' | 'min'; basis: string;
};
export function evaluateGate(report: ScenarioReport, budget: CapacityBudget): GateFailure[];
export function loadBudget(path: string): CapacityBudget;
export function loadReport(path: string): ScenarioReport;
```

`Config` 的可选字段只在执行时添加，缺省值必须等于现有常量：

```ts
export type Config = {
  // 现有字段不变
  dataDir: string;
  port: number;
  ledgerPath: string;
  routingDir: string;
  magpieUrl: string;
  bodyBudget: number;
  diskLimit: number;
  gatewayTimeoutMs: number;
  /** 仅容量实验注入；缺省保持 main.ts 现有间隔。 */
  intervals?: Partial<Record<'ledger' | 'route' | 'cost' | 'probe' | 'pending' | 'derive' | 'retention' | 'rawPrune' | 'gap', number>>;
};
```

---

## Part I：基线与观测

### Task 1：建立进程观测模块与写事务统计

**Files:**
- Create: `src/capacity.ts`
- Modify: `src/store.ts`
- Test: `tests/capacity.test.ts`
- Test: `tests/store.test.ts`

**Interfaces:**
- Consumes: `Config`、`Store`、`measureStorage`、`StorageUsage`。
- Produces: 上文 `CapacityMetrics`、`IngestMetrics`、`DurationSummary`、`summarizeDurations`、`createIngestMetrics`、`createCapacityMetrics`、`queueSnapshot`、`metadataSnapshot`、`assertCapacityIsolation`；`Store.writeStats`。

- [ ] **Step 1：写失败的观测单元测试。** 在 `tests/capacity.test.ts` 写入以下测试。分位采用最近秩，空样本为 null；拒绝原因只能取固定枚举。

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REJECT_REASONS, assertCapacityIsolation, createCapacityMetrics, createIngestMetrics,
  metadataSnapshot, summarizeDurations,
} from '../src/capacity';
import { loadConfig } from '../src/config';
import { fixture } from './fixtures';

test('最近秩分位与空样本', () => {
  expect(summarizeDurations([])).toEqual({ count: 0, p50_ms: null, p95_ms: null, p99_ms: null, max_ms: null });
  expect(summarizeDurations([1, 2, 3, 4])).toEqual({
    count: 4, p50_ms: 2, p95_ms: 4, p99_ms: 4, max_ms: 4,
  });
});

test('拒绝计数只接受固定原因且不保留原因文本', () => {
  const metrics = createIngestMetrics(1000);
  for (const reason of REJECT_REASONS) metrics.reject(reason);
  metrics.reject('busy');
  metrics.accept({ duplicate: false, requestBytes: 10, replyBytes: 5 });
  const snapshot = metrics.snapshot(2000);
  expect(snapshot.rejected_total).toBe(REJECT_REASONS.length + 1);
  expect(snapshot.rejected_by_reason.busy).toBe(2);
  expect(snapshot.accepted).toBe(1);
  expect(snapshot.uptime_ms).toBe(1000);
  expect(() => (metrics as unknown as { reject(value: string): void })
    .reject('user supplied text')).toThrow('invalid_reject_reason');
});

test('容量快照包含写统计、事件循环、队列年龄与存储', () => {
  const f = fixture();
  try {
    const metrics = createCapacityMetrics(f.store, f.dir, 100);
    metrics.jobs.record('derive', 12);
    metrics.jobs.record('derive', 7);
    f.store.write(db => db.run(
      "INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at) VALUES (1,'c','a','known',100,'2026-10-22','hook','pending',0,1,1,1)"));
    f.store.write(db => db.run("INSERT INTO derive_queue(conv_key,actor,from_sort) VALUES ('c','a','')"));
    const snapshot = metrics.snapshot(f.store, f.dir) as any;
    expect(snapshot.writer.count).toBeGreaterThanOrEqual(2);
    expect(snapshot.jobs.derive).toEqual({ count: 2, total_ms: 19, max_ms: 12 });
    expect(snapshot.derive_queue.pending_groups).toBe(1);
    expect(snapshot.derive_queue.oldest_request_started_ms).toBe(100);
    expect(snapshot.derive_queue.pending_groups).toBe(1);
    expect(snapshot.storage.db_bytes).toBeGreaterThan(0);
    expect(snapshot.ingest.rejected_total).toBe(0);
    expect(snapshot.metadata).toMatchObject({ clean_groups: 0 });
  } finally { f.close(); }
});

test('元数据快照按clean组与来源JSON计长', () => {
  const f = fixture();
  try {
    f.store.write(db => {
      const requestColumns = (db.query('PRAGMA table_info(request)').all() as { name: string }[])
        .map(row => row.name);
      const source = requestColumns.includes('source_facts_json')
        ? ",source_facts_json" : '';
      const sourceValue = requestColumns.includes('source_facts_json') ? ",'{\"k\":1}'" : '';
      db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
        body_state,derive_version,have,created_at,updated_at${source})
        VALUES (1,'c1','a','known',100,'2026-10-22','hook','pending',0,1,1,1${sourceValue})`);
      db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
        body_state,derive_version,have,created_at,updated_at${source})
        VALUES (2,'c2','a','known',100,'2026-10-22','hook','pending',0,1,1,1${sourceValue})`);
      db.run(`INSERT INTO derive_queue(conv_key,actor,from_sort,group_epoch,input_revision,
        published_revision,target_algorithm,state,dirty_since_ms)
        VALUES ('c1','a','','g1',1,0,5,'clean',NULL),
               ('c2','a','','g1',1,0,5,'dirty',50)`);
    });
    const snapshot = metadataSnapshot(f.store);
    expect(snapshot.clean_groups).toBe(1);
    expect(snapshot.queue_clean_bytes).toBeGreaterThan(0);
    expect(snapshot.total_bytes).toBeGreaterThanOrEqual(snapshot.queue_clean_bytes);
    expect(snapshot.per_clean_group_bytes).toBe(snapshot.total_bytes);
    expect(snapshot.per_request_bytes).toBe(snapshot.total_bytes / 2);
  } finally { f.close(); }
});

test('隔离断言拒绝默认配置与真实上游端口', () => {
  const root = mkdtempSync(join(tmpdir(), 'atc-capacity-test-'));
  try {
    mkdirSync(join(root, 'sources', 'routing'), { recursive: true });
    const base = loadConfig({});
    expect(() => assertCapacityIsolation({ root, config: base, upstreamPort: 40123 }))
      .toThrow('capacity_dataDir_mismatch');
    const isolated = {
      ...base,
      dataDir: join(root, 'data'),
      ledgerPath: join(root, 'sources', 'usage.jsonl'),
      routingDir: join(root, 'sources', 'routing'),
      magpieUrl: 'http://127.0.0.1:3425',
      bodyBudget: 1_000,
      diskLimit: 2_000,
    };
    expect(() => assertCapacityIsolation({ root, config: isolated, upstreamPort: 3425 }))
      .toThrow('capacity_upstream_is_real_magpie');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2：验证失败。** Run: `bun test tests/capacity.test.ts`。Expected: FAIL，`src/capacity.ts` 不存在或导出缺失。记录实际错误，不把模块解析失败当成行为断言失败。

- [ ] **Step 3：实现 `src/capacity.ts`。** 完整代码：

```ts
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { Config } from './config';
import type { Store, WriteStats } from './store';
import { measureStorage } from './retention';
import type { StorageUsage } from './retention';

export const REJECT_REASONS = [
  'hook_unavailable', 'host', 'origin', 'unauthorized', 'method_not_allowed',
  'busy', 'envelope_too_large', 'invalid_json', 'missing_hook_id',
  'origin_not_local', 'insufficient_storage', 'writer_failed',
] as const;
export type RejectReason = typeof REJECT_REASONS[number];

export type DurationSummary = {
  count: number;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  max_ms: number | null;
};

function percentile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

export function summarizeDurations(values: readonly number[]): DurationSummary {
  if (values.length === 0) {
    return { count: 0, p50_ms: null, p95_ms: null, p99_ms: null, max_ms: null };
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50_ms: percentile(sorted, 0.5),
    p95_ms: percentile(sorted, 0.95),
    p99_ms: percentile(sorted, 0.99),
    max_ms: sorted[sorted.length - 1]!,
  };
}

function emptyReasons(): Record<RejectReason, number> {
  return Object.fromEntries(REJECT_REASONS.map(reason => [reason, 0])) as Record<RejectReason, number>;
}

export type IngestMetrics = {
  reject(reason: RejectReason): void;
  accept(input: { duplicate: boolean; requestBytes: number; replyBytes: number }): void;
  snapshot(now?: number): {
    started_at_ms: number; now_ms: number; uptime_ms: number;
    accepted: number; duplicates: number;
    accepted_request_bytes: number; accepted_reply_bytes: number;
    rejected_total: number; rejected_by_reason: Record<RejectReason, number>;
  };
};

export function createIngestMetrics(startedAt = Date.now()): IngestMetrics {
  let accepted = 0;
  let duplicates = 0;
  let requestBytes = 0;
  let replyBytes = 0;
  const rejected = emptyReasons();
  return {
    reject(reason) {
      if (!REJECT_REASONS.includes(reason)) throw new Error('invalid_reject_reason');
      rejected[reason] += 1;
    },
    accept(input) {
      accepted += 1;
      if (input.duplicate) duplicates += 1;
      requestBytes += input.requestBytes;
      replyBytes += input.replyBytes;
    },
    snapshot(now = Date.now()) {
      const byReason = { ...rejected };
      return {
        started_at_ms: startedAt,
        now_ms: now,
        uptime_ms: now - startedAt,
        accepted,
        duplicates,
        accepted_request_bytes: requestBytes,
        accepted_reply_bytes: replyBytes,
        rejected_total: REJECT_REASONS.reduce((sum, reason) => sum + byReason[reason], 0),
        rejected_by_reason: byReason,
      };
    },
  };
}

export type CapacityMetrics = {
  startedAt: number;
  ingest: IngestMetrics;
  route: {
    record(input: { files: number; decoded: number; unchanged: number; errors: number }): void;
    snapshot(): { polls: number; files_seen: number; decoded: number; unchanged: number; errors: number };
  };
  jobs: {
    record(name: string, ms: number): void;
    snapshot(): Record<string, { count: number; total_ms: number; max_ms: number }>;
  };
  eventLoop: {
    start(): void;
    stop(): void;
    snapshot(): DurationSummary & { interval_ms: number };
  };
  snapshot(store: Store, dataDir: string): Record<string, unknown>;
};

function tableColumns(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name);
}

export function queueSnapshot(store: Store): {
  pending_groups: number;
  oldest_dirty_since_ms: number | null; oldest_dirty_age_ms: number | null;
  oldest_request_started_ms: number | null; oldest_request_age_ms: number | null;
} {
  const columns = tableColumns(store.read, 'derive_queue');
  const hasState = columns.includes('state');
  const hasDirtySince = columns.includes('dirty_since_ms');
  // C 的现行屏蔽条件是 state <> 'clean'；v6 构建中的组仍为 dirty，不新增状态。
  const filter = hasState ? "WHERE state <> 'clean'" : '';
  // 组数必须只数队列行；JOIN request 后的 COUNT(*) 会变成请求数。
  const pending = store.read.query<{ n: number }, []>(
    `SELECT COUNT(*) AS n FROM derive_queue ${filter}`).get()?.n ?? 0;
  const dirty = hasDirtySince
    ? store.read.query<{ oldest: number | null }, []>(
      `SELECT MIN(dirty_since_ms) AS oldest FROM derive_queue ${filter}`).get()?.oldest ?? null
    : null;
  const request = store.read.query<{ oldest: number | null }, []>(`
    SELECT MIN(r.started_ms) AS oldest
    FROM derive_queue q JOIN request r ON r.conv_key=q.conv_key AND r.actor=q.actor
    ${hasState ? "WHERE q.state <> 'clean'" : ''}`).get()?.oldest ?? null;
  const now = Date.now();
  return {
    pending_groups: pending,
    oldest_dirty_since_ms: dirty,
    oldest_dirty_age_ms: dirty === null ? null : now - dirty,
    oldest_request_started_ms: request,
    oldest_request_age_ms: request === null ? null : now - request,
  };
}

function hasTable(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== null;
}
function numeric(db: Database, sql: string, params: unknown[] = []): number {
  const row = db.query(sql).get(...params) as Record<string, unknown> | null;
  return row === null ? 0 : Number(Object.values(row)[0] ?? 0);
}
function byteSum(db: Database, table: string, columns: readonly string[],
  where = ''): number {
  const available = tableColumns(db, table);
  const picked = columns.filter(name => available.includes(name));
  if (picked.length === 0) return 0;
  const expression = picked
    .map(name => `COALESCE(length(CAST(${name} AS BLOB)),0)`).join('+');
  return numeric(db, `SELECT COALESCE(SUM(${expression}),0) FROM ${table} ${where}`);
}

/**
 * 元数据增长只按逻辑载荷计：clean 组队列行、来源与投影 JSON、已发布代结果字段。
 * clean 行由 C 保留，不能只数 dirty 组；来源 JSON 单独计长，不解析、不截断。
 */
export function metadataSnapshot(store: Store): {
  clean_groups: number;
  source_facts_json_bytes: number;
  projection_meta_json_bytes: number;
  queue_clean_bytes: number;
  result_metadata_bytes: number;
  total_bytes: number;
  per_clean_group_bytes: number | null;
  per_request_bytes: number | null;
} {
  const queueColumns = tableColumns(store.read, 'derive_queue');
  const hasState = queueColumns.includes('state');
  const cleanGroups = hasState
    ? numeric(store.read, "SELECT COUNT(*) FROM derive_queue WHERE state='clean'")
    : numeric(store.read, 'SELECT COUNT(*) FROM derive_queue');
  const queueCleanBytes = byteSum(store.read, 'derive_queue',
    ['conv_key', 'actor', 'from_sort', 'group_epoch', 'input_revision', 'published_revision',
      'published_algorithm'], hasState ? "WHERE state='clean'" : '');
  const sourceFactsBytes = byteSum(store.read, 'request', ['source_facts_json']);
  const projectionMetaBytes = byteSum(store.read, 'request', ['projection_meta_json']);
  const resultColumns = tableColumns(store.read, 'derive_request_result');
  const resultMetadataBytes = resultColumns.length === 0 || !hasTable(store.read, 'derive_generation')
    ? 0
    : byteSum(store.read, 'derive_request_result',
      ['title', 'title_source', 'input_preview', 'input_preview_kind', 'reply_preview',
        'basis_json', 'delta_ordinals', 'purpose_chain'],
      'JOIN derive_queue q ON q.published_generation=derive_request_result.generation');
  const requestCount = numeric(store.read, 'SELECT COUNT(*) FROM request');
  const total = queueCleanBytes + sourceFactsBytes + projectionMetaBytes + resultMetadataBytes;
  return {
    clean_groups: cleanGroups,
    source_facts_json_bytes: sourceFactsBytes,
    projection_meta_json_bytes: projectionMetaBytes,
    queue_clean_bytes: queueCleanBytes,
    result_metadata_bytes: resultMetadataBytes,
    total_bytes: total,
    per_clean_group_bytes: cleanGroups === 0 ? null : total / cleanGroups,
    per_request_bytes: requestCount === 0 ? null : total / requestCount,
  };
}

export function createCapacityMetrics(store: Store, dataDir: string, startedAt = Date.now()): CapacityMetrics {
  const ingest = createIngestMetrics(startedAt);
  const route = { polls: 0, files_seen: 0, decoded: 0, unchanged: 0, errors: 0 };
  const jobs = new Map<string, { count: number; total_ms: number; max_ms: number }>();
  const intervalMs = 50;
  const limit = 8192;
  const ring = new Float64Array(limit);
  let ringIndex = 0;
  let ringCount = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let expected = 0;

  return {
    startedAt,
    ingest,
    route: {
      record(input) {
        route.polls += 1;
        route.files_seen += input.files;
        route.decoded += input.decoded;
        route.unchanged += input.unchanged;
        route.errors += input.errors;
      },
      snapshot() { return { ...route }; },
    },
    jobs: {
      record(name, ms) {
        const current = jobs.get(name) ?? { count: 0, total_ms: 0, max_ms: 0 };
        current.count += 1;
        current.total_ms += ms;
        current.max_ms = Math.max(current.max_ms, ms);
        jobs.set(name, current);
      },
      snapshot() { return Object.fromEntries(jobs); },
    },
    eventLoop: {
      start() {
        if (timer !== null) return;
        expected = performance.now() + intervalMs;
        timer = setInterval(() => {
          const now = performance.now();
          const lag = Math.max(0, now - expected);
          expected = now + intervalMs;
          ring[ringIndex] = lag;
          ringIndex = (ringIndex + 1) % limit;
          ringCount = Math.min(limit, ringCount + 1);
        }, intervalMs);
        if (typeof (timer as { unref?: () => void }).unref === 'function') {
          (timer as { unref(): void }).unref();
        }
      },
      stop() {
        if (timer !== null) clearInterval(timer);
        timer = null;
      },
      snapshot() {
        const values: number[] = [];
        for (let index = 0; index < ringCount; index++) {
          values.push(ring[(ringIndex - ringCount + index + limit) % limit]!);
        }
        return { interval_ms: intervalMs, ...summarizeDurations(values) };
      },
    },
    snapshot(target, targetDir) {
      const storage: StorageUsage = measureStorage(target, targetDir);
      return {
        started_at_ms: startedAt,
        now_ms: Date.now(),
        uptime_ms: Date.now() - startedAt,
        ingest: ingest.snapshot(),
        route: { ...route },
        jobs: Object.fromEntries(jobs),
        writer: { ...target.writeStats } satisfies WriteStats,
        event_loop: {
          interval_ms: intervalMs,
          ...(() => {
            const values: number[] = [];
            for (let index = 0; index < ringCount; index++) {
              values.push(ring[(ringIndex - ringCount + index + limit) % limit]!);
            }
            return summarizeDurations(values);
          })(),
        },
        rss_bytes: process.memoryUsage().rss,
        storage,
        metadata: metadataSnapshot(target),
        derive_queue: queueSnapshot(target),
      };
    },
  };
}

/**
 * 容量配置必须指向调用方刚创建的临时根。
 *
 * 只做路径相等断言，不解析环境变量；默认 dataDir、真实 magpie 端口和任何
 * 逃出根的路径都直接拒绝，避免漏配的字段把实验带到真实数据上。
 */
export function assertCapacityIsolation(input: {
  root: string; config: Config; upstreamPort: number;
}): void {
  const root = realpathSync(input.root);
  const temp = realpathSync(tmpdir());
  const fromTemp = relative(temp, root);
  if (fromTemp === '' || fromTemp.startsWith('..') || isAbsolute(fromTemp)) {
    throw new Error('capacity_root_outside_tmp');
  }
  if (!basename(root).startsWith('atc-capacity-')) throw new Error('capacity_root_name');
  const expected: Array<[keyof Config, string]> = [
    ['dataDir', join(root, 'data')],
    ['ledgerPath', join(root, 'sources', 'usage.jsonl')],
    ['routingDir', join(root, 'sources', 'routing')],
  ];
  for (const [key, path] of expected) {
    if (resolve(String(input.config[key])) !== resolve(path)) {
      throw new Error(`capacity_${key}_mismatch`);
    }
  }
  if (input.upstreamPort === 3425) throw new Error('capacity_upstream_is_real_magpie');
  const upstream = `http://127.0.0.1:${input.upstreamPort}`;
  if (input.config.magpieUrl !== upstream) throw new Error('capacity_upstream_mismatch');
  if (!(input.config.bodyBudget > 0 && input.config.bodyBudget < input.config.diskLimit)) {
    throw new Error('capacity_budget_order');
  }
}
```

- [ ] **Step 4：实现写事务统计。** 在 `src/store.ts` 的 `Store` 增加 `writeStats`，并在 `write` 包装内计时。计时从进入 `store.write` 到 `immediate()` 返回；失败事务也计数，便于看到回滚成本。

```ts
export type WriteStats = { count: number; total_ms: number; max_ms: number };

export type Store = {
  db: Database;
  read: Database;
  write<T>(fn: (db: Database) => T): T;
  writeStats: WriteStats;
  close(): void;
};

// openStore 内：
const writeStats: WriteStats = { count: 0, total_ms: 0, max_ms: 0 };
const write = <T>(fn: (db: Database) => T): T => {
  const started = performance.now();
  try {
    return db.transaction(() => {
      const result = fn(db);
      if (result instanceof Promise) throw new TypeError('async writer');
      return result;
    }).immediate();
  } finally {
    const elapsed = performance.now() - started;
    writeStats.count += 1;
    writeStats.total_ms += elapsed;
    writeStats.max_ms = Math.max(writeStats.max_ms, elapsed);
  }
};

return {
  db,
  read,
  write,
  writeStats,
  close() {
    if (closed) return;
    closed = true;
    read.close();
    db.close();
  },
};
```

- [ ] **Step 5：写 `tests/store.test.ts` 的统计断言。** 在现有 `openStore` 测试旁加入：

```ts
test('写事务统计覆盖成功与回滚', () => {
  const f = fixture();
  try {
    const before = f.store.writeStats.count;
    f.store.write(db => db.run("INSERT INTO collector_state(key,value_json) VALUES ('a','1')"));
    expect(f.store.writeStats.count).toBe(before + 1);
    expect(f.store.writeStats.max_ms).toBeGreaterThanOrEqual(0);
    expect(() => f.store.write(db => {
      db.run("INSERT INTO collector_state(key,value_json) VALUES ('b','1')");
      throw new Error('synthetic_rollback');
    })).toThrow('synthetic_rollback');
    expect(f.store.writeStats.count).toBe(before + 2);
    expect(f.store.read.query("SELECT COUNT(*) AS n FROM collector_state WHERE key='b'").get())
      .toEqual({ n: 0 });
  } finally { f.close(); }
});
```

- [ ] **Step 6：运行。** Run: `bun test tests/capacity.test.ts tests/store.test.ts`。Expected: PASS。若 `summarizeDurations([1,2,3,4])` 的 p50 不是 2，先检查最近秩实现，不调低断言。

- [ ] **Step 7：提交。** 获授权后执行：

```bash
git add src/capacity.ts src/store.ts tests/capacity.test.ts tests/store.test.ts .agents/notes/implemented/feature/2026-10-22-atc-capacity-metrics.md
git commit -m "feat(capacity): add bounded process metrics and write timing" \
  -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 2：固定原因拒绝计数与认证统计入口

**Files:**
- Modify: `src/http.ts`
- Modify: `src/main.ts`
- Test: `tests/http.test.ts`
- Test: `tests/capacity.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `CapacityMetrics`、`createIngestMetrics`、`createCapacityMetrics`。
- Produces: `/hook/ingest` 每条拒绝分支的固定原因计数；`GET /api/ingest-metrics` 的认证 JSON；`startCollector` 创建并暴露同一份观测运行时。

- [ ] **Step 1：写拒绝计数与认证测试。** 在 `tests/http.test.ts` 增加以下用例。测试只使用合成令牌和合成正文，断言响应与统计中都不出现正文标记。

```ts
test('hook拒绝按固定原因计数且不保留正文', async () => {
  const f = fixture();
  try {
    const metrics = createCapacityMetrics(f.store, f.dir, 1000);
    const handler = createHandler(f.store, loadConfig({}), 'synthetic-read-token', {
      token: 'synthetic-hook-token', salt: new Uint8Array(32),
    }, metrics);
    const make = (body: string, headers: Record<string, string>) =>
      new Request('http://127.0.0.1:8320/hook/ingest', {
        method: 'POST', headers: { host: '127.0.0.1:8320', ...headers }, body,
      });
    const marker = 'REJECTED_BODY_MARKER';
    // 未认证最先拒绝，正文甚至不必是合法 JSON。
    expect((await handler(make(`{"marker":"${marker}"`, {
      authorization: 'Bearer wrong',
    }))).status).toBe(401);
    // 认证和来源通过后，语法错误才是 invalid_json。
    expect((await handler(make(`{"marker":"${marker}"`, {
      authorization: 'Bearer synthetic-hook-token',
    }))).status).toBe(400);
    // 合法 JSON、缺 hook_id：必须走 422，而不是被当成语法错误。
    expect((await handler(make(JSON.stringify({ marker, origin: 'local' }), {
      authorization: 'Bearer synthetic-hook-token',
    }))).status).toBe(422);
    expect((await handler(make(JSON.stringify({ marker, hook_id: 'h1', origin: 'local' }), {
      authorization: 'Bearer synthetic-hook-token', origin: 'http://evil.example',
    }))).status).toBe(403);
    const snapshot = metrics.ingest.snapshot(2000);
    expect(snapshot.rejected_by_reason.unauthorized).toBe(1);
    expect(snapshot.rejected_by_reason.invalid_json).toBe(1);
    expect(snapshot.rejected_by_reason.missing_hook_id).toBe(1);
    expect(snapshot.rejected_by_reason.origin).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain('REJECTED_BODY_MARKER');
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 0 });
  } finally { f.close(); }
});

test('认证统计入口返回计数与启动时间，未认证返回401', async () => {
  const f = fixture();
  try {
    const metrics = createCapacityMetrics(f.store, f.dir, 5000);
    const handler = createHandler(f.store, loadConfig({}), 'synthetic-read-token', undefined, metrics);
    metrics.ingest.reject('busy');
    metrics.eventLoop.start();
    const denied = await handler(new Request('http://127.0.0.1:8320/api/ingest-metrics', {
      headers: { host: '127.0.0.1:8320' },
    }));
    expect(denied.status).toBe(401);
    const response = await handler(new Request('http://127.0.0.1:8320/api/ingest-metrics', {
      headers: { host: '127.0.0.1:8320', authorization: 'Bearer synthetic-read-token' },
    }));
    metrics.eventLoop.stop();
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.started_at_ms).toBe(5000);
    expect(body.ingest.rejected_by_reason.busy).toBe(1);
    expect(Object.keys(body).sort()).toContain('writer');
    expect(Object.keys(body).sort()).toContain('event_loop');
  } finally { f.close(); }
});
```

- [ ] **Step 2：验证失败。** Run: `bun test tests/http.test.ts -t 'hook拒绝按固定原因计数|认证统计入口'`。Expected: FAIL，接口未统计或路由不存在。

- [ ] **Step 3：修改 `handleHookIngest`。** 每个返回前记录固定原因，成功时记录接受。`metrics` 是可选参数；未提供时用本地 `createIngestMetrics()`，保证计数仍然存在，但入口只在传入完整 `CapacityMetrics` 时开放。

```ts
async function handleHookIngest(
  req: Request,
  store: Store,
  config: Config,
  hook: { token: string; salt: Uint8Array; admission?: () => HookAdmission } | undefined,
  metrics: IngestMetrics,
): Promise<Response> {
  if (hook === undefined) {
    metrics.reject('hook_unavailable');
    return json({ error: 'hook_unavailable' }, 404);
  }
  const host = req.headers.get('host');
  if (host === null || !allowedHosts(config.port).has(host)) {
    metrics.reject('host');
    return json({ error: 'host' }, 403);
  }
  const origin = req.headers.get('origin');
  if (origin !== null && origin !== `http://${host}`) {
    metrics.reject('origin');
    return json({ error: 'origin' }, 403);
  }
  const authorization = req.headers.get('authorization');
  if (authorization === null || !authorization.startsWith('Bearer ') ||
      !timingSafeEqual(authorization.slice(7), hook.token)) {
    metrics.reject('unauthorized');
    return json({ error: 'unauthorized' }, 401);
  }
  if (req.method !== 'POST') {
    metrics.reject('method_not_allowed');
    return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
  }
  if (ingesting) {
    metrics.reject('busy');
    return json({ error: 'busy' }, 429);
  }
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_ENVELOPE_BYTES) {
    metrics.reject('envelope_too_large');
    return json({ error: 'envelope_too_large' }, 413);
  }

  ingesting = true;
  try {
    const text = await readBounded(req, MAX_ENVELOPE_BYTES);
    if (text === null) {
      metrics.reject('envelope_too_large');
      return json({ error: 'envelope_too_large' }, 413);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      metrics.reject('invalid_json');
      return json({ error: 'invalid_json' }, 400);
    }
    if (!isRecord(parsed)) {
      metrics.reject('invalid_json');
      return json({ error: 'invalid_json' }, 400);
    }
    const envelope = parsed as unknown as HookEnvelope;
    if (typeof envelope.hook_id !== 'string' || envelope.hook_id.length === 0) {
      metrics.reject('missing_hook_id');
      return json({ error: 'missing_hook_id' }, 422);
    }
    if (envelope.origin !== 'local') {
      metrics.reject('origin_not_local');
      return json({ error: 'origin' }, 403);
    }
    try {
      const result = acceptHook(store, envelope, Date.now(), hook.salt, { admission: hook.admission });
      metrics.accept({
        duplicate: result.duplicate,
        requestBytes: envelope.request_bytes,
        replyBytes: envelope.reply_bytes,
      });
      return json(result, 200);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'unknown';
      if (code === 'disk_full') {
        metrics.reject('insufficient_storage');
        return json({ error: 'insufficient_storage' }, 507);
      }
      metrics.reject('writer_failed');
      return json({ error: 'writer_failed', code }, 503);
    }
  } finally {
    ingesting = false;
  }
}
```

- [ ] **Step 4：增加认证入口。** `createHandler` 保存 `ingestMetrics = metrics?.ingest ?? createIngestMetrics()`，hook 路由传入。新增路由放在 `/api/stats` 之前：

```ts
if (path === '/api/ingest-metrics') {
  if (metrics === undefined) return json({ error: 'metrics_unavailable' }, 404);
  return json(metrics.snapshot(store, config.dataDir));
}
```

`metrics.snapshot` 返回对象包含 `ingest`、`route`、`jobs`、`writer`、`event_loop`、`rss_bytes`、`storage`、`derive_queue`。该入口与页面读取共用 `checkAccess`，只接受读取令牌或同源导航，不接受 hook 令牌。

- [ ] **Step 5：接入 `startCollector`。** 在 `openStore` 后创建观测运行时，事件循环采样启动；`createHandler` 第五个参数传入；`stop` 中停止采样。拒绝计数只依赖进程，重启归零，报告以 `started_at_ms` 说明边界。

```ts
const metrics = createCapacityMetrics(store, config.dataDir, Date.now());
metrics.eventLoop.start();
// startCollector 里原本创建 handler 的位置，改为把 metrics 作为第五个参数传入；
// 其余定时器、监听与 stop 清理保持不变。
handler = createHandler(store, { ...config, port: boundPort }, readToken, {
  token: hookToken, salt, admission: () => gate.check(0),
}, metrics);
// stop() 中在关闭 server 与 store 之前追加一行：
metrics.eventLoop.stop();
```

- [ ] **Step 6：运行。** Run: `bun test tests/http.test.ts tests/capacity.test.ts`。Expected: PASS。若 `metrics_unavailable` 用例失败，确认 `startCollector` 已传第五参数，而不是让入口静默返回空统计。

- [ ] **Step 7：提交。** 获授权后：

```bash
git add src/http.ts src/main.ts tests/http.test.ts tests/capacity.test.ts .agents/notes/implemented/feature/2026-10-22-atc-hook-rejection-metrics.md
git commit -m "feat(capacity): count hook rejections by fixed reason" \
  -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 3：作业计时、事件循环与可选间隔注入

**Files:**
- Modify: `src/main.ts`
- Modify: `src/config.ts`
- Test: `tests/capacity.test.ts`
- Test: `tests/maintenance.test.ts`（只加可选间隔缺省断言）

**Interfaces:**
- Consumes: Task 1 的 `CapacityMetrics.jobs`、`eventLoop`、`route.record`；Task 2 的 handler 统计。
- Produces: `Config.intervals`；`guard` 对每个作业计时；`routeTick` 记录 `files/decoded/unchanged/errors`；缺省间隔等于现有常量。

- [ ] **Step 1：写缺省与注入测试。** 在 `tests/maintenance.test.ts` 或 `tests/capacity.test.ts` 加：

```ts
import { intervalOf, type Config } from '../src/config';

test('容量间隔只由显式Config注入，缺省保持常量', () => {
  const base = {} as Pick<Config, 'intervals'>;
  expect(intervalOf(base, 'retention', 3_600_000)).toBe(3_600_000);
  const configured = { intervals: { retention: 5_000, rawPrune: 5_000 } };
  expect(intervalOf(configured, 'retention', 3_600_000)).toBe(5_000);
  expect(intervalOf(configured, 'derive', 1_000)).toBe(1_000);
  expect(() => intervalOf({ intervals: { retention: 0 } }, 'retention', 1))
    .toThrow('invalid_capacity_interval');
});
```

- [ ] **Step 2：验证失败。** Run: `bun test tests/capacity.test.ts -t '容量间隔只由'`。Expected: FAIL，`intervalOf` 不存在。

- [ ] **Step 3：实现配置注入。** `Config.intervals` 只允许固定作业名的正安全整数。生产 `loadConfig` 不解析任何环境变量、不设置该字段；容量子进程用对象字面量构造 `Config` 时直接注入。`intervalOf` 是唯一读取点，缺省返回现有常量，非法值抛错，避免新增生产配置面。

```ts
const INTERVAL_KEYS = ['ledger', 'route', 'cost', 'probe', 'pending', 'derive', 'retention', 'rawPrune', 'gap'] as const;
export type IntervalKey = typeof INTERVAL_KEYS[number];

export function intervalOf(
  config: Pick<Config, 'intervals'>,
  key: IntervalKey,
  fallback: number,
): number {
  const value = config.intervals?.[key];
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('invalid_capacity_interval');
  return value;
}
```

- [ ] **Step 4：接入作业计时。** 修改 `main.ts` 的 `guard`：

```ts
const guard = (name: string, task: () => Promise<void> | void) => async () => {
  if (stopped || running.has(name)) return;
  running.add(name);
  const started = performance.now();
  try {
    await task();
  } catch (error) {
    if (stopped) return;
    const code = error instanceof Error ? error.message : 'unknown';
    process.stderr.write(`${name}_failed:${code}\n`);
  } finally {
    metrics.jobs.record(name, performance.now() - started);
    running.delete(name);
  }
};
```

定时器改为：

```ts
timers.push(setInterval(ledgerTick, intervalOf(config, 'ledger', LEDGER_INTERVAL_MS)));
timers.push(setInterval(routeTick, intervalOf(config, 'route', ROUTE_INTERVAL_MS)));
timers.push(setInterval(costTick, intervalOf(config, 'cost', COST_INTERVAL_MS)));
timers.push(setInterval(probeTick, intervalOf(config, 'probe', PROBE_INTERVAL_MS)));
timers.push(setInterval(pendingTick, intervalOf(config, 'pending', LEDGER_INTERVAL_MS)));
timers.push(setInterval(deriveTick, intervalOf(config, 'derive', DERIVE_INTERVAL_MS)));
timers.push(setInterval(retentionTick, intervalOf(config, 'retention', RETENTION_INTERVAL_MS)));
timers.push(setInterval(rawPruneTick, intervalOf(config, 'rawPrune', RAW_PRUNE_INTERVAL_MS)));
timers.push(setInterval(gapTick, intervalOf(config, 'gap', LEDGER_INTERVAL_MS)));
```

- [ ] **Step 5：记录路由读取。** 在 `routeTick` 中，`readRouteFiles` 返回后按 `state` 计数；`decoded` 表示本次真正解压并产出行的文件，`unchanged` 表示命中已提交指纹跳过，`errors` 表示读取或解压失败。Task 9 会实现三态，当前先在现有实现上记录 `decoded = files.length`、`unchanged = 0`、`errors = files.filter(f => f.error !== null).length`，Task 9 再改。

```ts
metrics.route.record({
  files: files.length,
  decoded: files.filter(file => file.error === null).length,
  unchanged: 0,
  errors: files.filter(file => file.error !== null).length,
});
```

- [ ] **Step 6：运行。** Run: `bun test tests/capacity.test.ts tests/maintenance.test.ts`。Expected: PASS。Run: `bun run typecheck`。Expected: PASS。

- [ ] **Step 7：提交。** 获授权后：

```bash
git add src/main.ts src/config.ts src/capacity.ts tests/capacity.test.ts tests/maintenance.test.ts .agents/notes/implemented/feature/2026-10-22-atc-capacity-interval-injection.md
git commit -m "feat(capacity): time ingest jobs and allow isolated interval injection" \
  -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 4：合成来源、假上游与隔离配置构造

**Files:**
- Create: `scripts/capacity-support.ts`
- Create: `scripts/capacity-collector.ts`
- Test: `tests/capacity.test.ts`

**Interfaces:**
- Consumes: `HookEnvelope`、`Config`、`assertCapacityIsolation`。
- Produces: `mulberry32(seed)`、`makeHookEnvelope(input)`、`makeLedgerLine(input)`、`makeRouteLine(input)`、`createFakeUpstream()`、`buildCapacityConfig(input)`、`waitForCollector(child)`。

- [ ] **Step 1：写确定性生成测试。** 在 `tests/capacity.test.ts` 增加：

```ts
import { buildCapacityConfig, makeHookEnvelope, mulberry32 } from '../scripts/capacity-support';

test('合成负载固定种子可复现', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  expect([a(), a(), a()]).toEqual([b(), b(), b()]);
});

test('合成配置只落在临时根内', () => {
  const root = mkdtempSync(join(tmpdir(), 'atc-capacity-config-'));
  try {
    mkdirSync(join(root, 'sources', 'routing'), { recursive: true });
    const config = buildCapacityConfig({ root, upstreamPort: 40123, bodyBudget: 1_000_000, diskLimit: 2_000_000 });
    expect(config.dataDir).toBe(join(root, 'data'));
    expect(config.ledgerPath).toBe(join(root, 'sources', 'usage.jsonl'));
    expect(config.routingDir).toBe(join(root, 'sources', 'routing'));
    expect(config.magpieUrl).toBe('http://127.0.0.1:40123');
    expect(config.port).toBe(0);
    expect(() => assertCapacityIsolation({ root, config, upstreamPort: 40124 }))
      .toThrow('capacity_upstream_mismatch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('合成hook与账本行形状可被真实解析器接受', () => {
  const envelope = makeHookEnvelope({
    hookId: 'hook-1', session: 'session-1', routeId: 7,
    requestBytes: 4096, replyBytes: 512, bodyOmitted: false, omitReason: null,
    model: 'synthetic-model', startedMs: 1_700_000_000_000,
  });
  expect(envelope.origin).toBe('local');
  expect(envelope.request_bytes).toBeGreaterThanOrEqual(4096);
  expect(envelope.reply_bytes).toBeGreaterThanOrEqual(512);
  expect(JSON.stringify(envelope.request)).toContain('synthetic');
  const line = makeLedgerLine({ routeId: 7, session: 'session-1', responseId: envelope.hook_id, startedMs: 1_700_000_000_000 });
  expect(JSON.parse(line)).toMatchObject({ route_id: 7, session: 'session-1', response_id: envelope.hook_id });
});
```

- [ ] **Step 2：验证失败。** Run: `bun test tests/capacity.test.ts -t '合成负载|合成配置|合成hook'`。Expected: FAIL，模块不存在。

- [ ] **Step 3：实现 `scripts/capacity-support.ts`。** 关键代码：

```ts
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { HookEnvelope } from '../src/hook';
import type { Config } from '../src/config';

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export type EnvelopeInput = {
  hookId: string; session: string; routeId: number;
  requestBytes: number; replyBytes: number;
  bodyOmitted: boolean; omitReason: string | null;
  model: string; startedMs: number;
};

function sizedText(target: number, fill: string): string {
  const base = `${fill}:`;
  if (target <= base.length) return base.slice(0, target);
  return base + fill.repeat(Math.ceil((target - base.length) / fill.length));
}

export function makeMessages(input: EnvelopeInput): unknown[] {
  const shared = [
    { role: 'system', content: [{ type: 'text', text: 'synthetic system' }] },
    { role: 'user', content: [{ type: 'text', text: 'synthetic shared history' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'synthetic answer' }] },
  ];
  const unique = {
    role: 'user',
    content: [{ type: 'text', text: sizedText(Math.max(1, input.requestBytes - 512), `unique-${input.hookId}`) }],
  };
  return [...shared, unique];
}

export function makeReply(input: EnvelopeInput): unknown {
  return {
    id: `msg_${input.hookId}`,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: sizedText(Math.max(1, input.replyBytes), `reply-${input.hookId}`) }],
  };
}

export function makeHookEnvelope(input: EnvelopeInput): HookEnvelope {
  const request = { model: input.model, messages: makeMessages(input), max_tokens: 128 };
  const reply = makeReply(input);
  const requestBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
  const replyBytes = Buffer.byteLength(JSON.stringify(reply), 'utf8');
  return {
    hook_id: input.hookId,
    observed_start_ms: input.startedMs,
    observed_finish_ms: input.startedMs + 10,
    protocol: 'anthropic',
    path: '/v1/messages',
    agent: 'claude',
    session: input.session,
    cwd: null,
    model: input.model,
    stream: true,
    origin: 'local',
    success: true,
    request,
    reply,
    request_bytes: requestBytes,
    reply_bytes: replyBytes,
    body_omitted: input.bodyOmitted,
    omit_reason: input.omitReason,
    magpie_version: '0.1.1296',
  };
}

export function makeLedgerLine(input: {
  routeId: number; session: string; responseId: string; startedMs: number;
}): string {
  return JSON.stringify({
    t: new Date(input.startedMs).toISOString(),
    route_id: input.routeId,
    response_id: input.responseId,
    session: input.session,
    subagent: input.session,
    agent: 'claude',
    provider: 'anthropic',
    model: 'synthetic-model',
    requested: 'synthetic-model',
    served: 'synthetic-model',
    status: 200,
    in: 100,
    out: 10,
    cache_read: 0,
    cache_write: 0,
    ms: 10,
    via: 'through',
    magpie_version: '0.1.1296',
  }) + '\n';
}

export function makeRouteLine(input: {
  routeId: number; session: string; startedMs: number;
}): string {
  return JSON.stringify({
    id: input.routeId,
    time: new Date(input.startedMs).toISOString(),
    agent: 'claude',
    session: input.session,
    model: 'synthetic-model',
    provider: 'anthropic',
    served: 'synthetic-model',
    status: 200,
    done: true,
    ms: 10,
    prompt: { tokens: 100, counted: true, window: 200_000, turns: 1, parts: [] },
  }) + '\n';
}

export function buildCapacityConfig(input: {
  root: string; upstreamPort: number; bodyBudget: number; diskLimit: number;
  intervals?: Config['intervals'];
}): Config {
  return {
    dataDir: join(input.root, 'data'),
    port: 0,
    ledgerPath: join(input.root, 'sources', 'usage.jsonl'),
    routingDir: join(input.root, 'sources', 'routing'),
    magpieUrl: `http://127.0.0.1:${input.upstreamPort}`,
    bodyBudget: input.bodyBudget,
    diskLimit: input.diskLimit,
    gatewayTimeoutMs: 2000,
    intervals: input.intervals,
  };
}

export function createFakeUpstream(): {
  port: number;
  stop(): void;
  requests: { path: string; status: number }[];
} {
  const requests: { path: string; status: number }[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push({ path: url.pathname + url.search, status: 200 });
      if (url.pathname === '/v1') {
        return Response.json({ version: '0.1.1296' });
      }
      if (url.pathname === '/v1/magpie/usage/requests') {
        return Response.json({
          offset: Number(url.searchParams.get('offset') ?? '0'),
          rows: [],
          pricing_version: 'synthetic',
        });
      }
      return new Response('not_found', { status: 404 });
    },
  });
  return {
    port: server.port ?? 0,
    stop() { void server.stop(true); },
    requests,
  };
}

export function waitForCollector(child: ReturnType<typeof Bun.spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('collector_start_timeout')), 15_000);
    const reader = child.stdout.getReader();
    const pump = async (): Promise<void> => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value);
        const match = /collector_listening:(\d+)/.exec(buffer);
        if (match !== null) {
          clearTimeout(timer);
          resolve(Number(match[1]));
          return;
        }
      }
      clearTimeout(timer);
      reject(new Error('collector_exited_before_listen'));
    };
    void pump();
  });
}
```

`makeMessages` 的 `requestBytes` 只作为目标尺寸，实际字节以序列化结果为准；报告记录实际 `request_bytes`，不把目标值当测量值。

- [ ] **Step 4：实现子进程入口。** `scripts/capacity-collector.ts` 读取 JSON 配置并调用 `startCollector`。它先执行隔离断言，任何路径不匹配都退出，不连接到真实上游。

```ts
import { readFileSync } from 'node:fs';
import { startCollector } from '../src/main';
import { assertCapacityIsolation } from '../src/capacity';
import { buildCapacityConfig } from './capacity-support';

const configPath = Bun.argv[2];
if (configPath === undefined) {
  process.stderr.write('capacity_config_missing\n');
  process.exit(2);
}
const input = JSON.parse(readFileSync(configPath, 'utf8')) as {
  root: string; upstream_port: number; body_budget: number; disk_limit: number;
  intervals?: Record<string, number>;
};
const config = buildCapacityConfig({
  root: input.root,
  upstreamPort: input.upstream_port,
  bodyBudget: input.body_budget,
  diskLimit: input.disk_limit,
  intervals: input.intervals as never,
});
assertCapacityIsolation({ root: input.root, config, upstreamPort: input.upstream_port });
const collector = await startCollector(config);
process.stdout.write(`collector_listening:${collector.port}\n`);
const stop = async (): Promise<void> => {
  await collector.stop();
  process.exit(0);
};
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
```

- [ ] **Step 5：运行。** Run: `bun test tests/capacity.test.ts`。Expected: PASS。Run: `bun run typecheck`。Expected: PASS。

- [ ] **Step 6：提交。** 获授权后：

```bash
git add scripts/capacity-support.ts scripts/capacity-collector.ts tests/capacity.test.ts .agents/notes/implemented/feature/2026-10-22-atc-synthetic-capacity-isolation.md
git commit -m "test(capacity): add deterministic synthetic sources and isolated config" \
  -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 5：负载驱动与场景矩阵

**Files:**
- Create: `scripts/capacity.ts`
- Test: `tests/capacity.test.ts`

**Interfaces:**
- Consumes: Task 4 的合成器与子进程入口；Task 2/3 的 `/api/ingest-metrics`。
- Produces: CLI `--scenario smoke|baseline-1rps|baseline-5rps|burst|long|route|retention|all|budget|calibrate`；`--full`、`--duration-ms`、`--rps`、`--requests`、`--seed`、`--report`、`--acknowledge-long-run`；报告 JSON。

- [ ] **Step 1：写场景规划测试。** 场景参数集中在 `scenarioPlan`，测试不启动负载。

```ts
import { scenarioPlan } from '../scripts/capacity';

test('场景矩阵固定请求速率、时长与正文混合', () => {
  expect(scenarioPlan('baseline-1rps', { full: true, acknowledgeLongRun: true })).toMatchObject({
    durationMs: 600_000, rps: 1, bodyMix: [350 * 1024, 2 * 1024 * 1024], concurrency: 1,
  });
  expect(scenarioPlan('baseline-5rps', { full: true, acknowledgeLongRun: true })).toMatchObject({
    durationMs: 600_000, rps: 5, concurrency: 1,
  });
  expect(scenarioPlan('burst', { full: false })).toMatchObject({ concurrency: 10, requestBytes: 4 * 1024 * 1024 });
  expect(scenarioPlan('long', { full: false, requests: 2_000 })).toMatchObject({ requests: 2_000 });
  expect(scenarioPlan('long', { full: false, requests: 10_000, acknowledgeLongRun: true }))
    .toMatchObject({ requests: 10_000 });
  expect(() => scenarioPlan('long', { full: false, requests: 10_000 }))
    .toThrow('capacity_long_run_not_acknowledged');
  expect(() => scenarioPlan('baseline-5rps', { full: true, acknowledgeLongRun: false }))
    .toThrow('capacity_long_run_not_acknowledged');
});
```

- [ ] **Step 2：验证失败。** Run: `bun test tests/capacity.test.ts -t '场景矩阵'`。Expected: FAIL，`scenarioPlan` 不存在。

- [ ] **Step 3：实现参数解析与场景规划。** 默认时长 10 秒，`--full` 才启用 600 秒；10 分钟运行、10,000 笔长组与 `all` 都必须同时给 `--acknowledge-long-run`，`requiresLongRunAck` 是唯一判定点。所有数值有上限校验，避免误把真实流量参数带进来。

```ts
export type ScenarioName =
  | 'smoke' | 'baseline-1rps' | 'baseline-5rps' | 'burst'
  | 'long' | 'route' | 'retention' | 'all' | 'budget' | 'calibrate';

export type PlanOptions = {
  full: boolean; requests?: number; acknowledgeLongRun?: boolean;
  durationMs?: number; rps?: number;
};

export type ScenarioPlan = {
  durationMs: number; rps: number; bodyMix: readonly number[];
  concurrency: number; requestBytes: number; replyBytes: number[];
  sessions: number; readerIntervalMs: number; requests?: number;
};

export function scenarioPlan(name: ScenarioName, options: PlanOptions): ScenarioPlan {
  const long = options.full ? 600_000 : 10_000;
  if (options.full && options.acknowledgeLongRun !== true) {
    throw new Error('capacity_long_run_not_acknowledged');
  }
  switch (name) {
    case 'smoke':
      return { durationMs: options.durationMs ?? 5_000, rps: options.rps ?? 2, bodyMix: [64 * 1024], concurrency: 1, requestBytes: 64 * 1024, replyBytes: [1024], sessions: 2, readerIntervalMs: 500 };
    case 'baseline-1rps':
      return { durationMs: options.durationMs ?? long, rps: 1, bodyMix: [350 * 1024, 2 * 1024 * 1024], concurrency: 1, requestBytes: 0, replyBytes: [1024, 64 * 1024], sessions: 20, readerIntervalMs: 500 };
    case 'baseline-5rps':
      return { durationMs: options.durationMs ?? long, rps: 5, bodyMix: [350 * 1024, 2 * 1024 * 1024], concurrency: 1, requestBytes: 0, replyBytes: [1024, 64 * 1024], sessions: 20, readerIntervalMs: 500 };
    case 'burst':
      return { durationMs: options.durationMs ?? 30_000, rps: 0, bodyMix: [4 * 1024 * 1024], concurrency: 10, requestBytes: 4 * 1024 * 1024, replyBytes: [1024, 64 * 1024, 512 * 1024, 2 * 1024 * 1024], sessions: 4, readerIntervalMs: 500 };
    case 'long':
      return { durationMs: 0, rps: 0, bodyMix: [], concurrency: 1, requestBytes: 0, replyBytes: [256], sessions: 1, readerIntervalMs: 0, requests: options.requests ?? 2_000 };
    case 'route':
      return { durationMs: options.durationMs ?? 30_000, rps: 1, bodyMix: [64 * 1024], concurrency: 1, requestBytes: 0, replyBytes: [1024], sessions: 2, readerIntervalMs: 500 };
    case 'retention':
      return { durationMs: options.durationMs ?? 120_000, rps: options.rps ?? 1, bodyMix: [2 * 1024 * 1024], concurrency: 1, requestBytes: 0, replyBytes: [1024], sessions: 4, readerIntervalMs: 500 };
    default:
      throw new Error('capacity_scenario_requires_subcommand');
  }
}
```

- [ ] **Step 4：实现负载主循环。** 关键顺序固定：建根与文件、起假上游、写配置、起子进程、等端口、读令牌、起读线程、按速率发 hook、停止输入、轮询排空、最终快照、停子进程、守恒计数、写报告。

```ts
async function runBaseline(name: 'baseline-1rps' | 'baseline-5rps', args: Args): Promise<ScenarioReport> {
  const plan = scenarioPlan(name, args);
  const root = mkdtempSync(join(tmpdir(), 'atc-capacity-'));
  mkdirSync(join(root, 'sources', 'routing'), { recursive: true });
  writeFileSync(join(root, 'sources', 'usage.jsonl'), '');
  const upstream = createFakeUpstream();
  const configPath = join(root, 'collector.json');
  writeFileSync(configPath, JSON.stringify({
    root,
    upstream_port: upstream.port,
    body_budget: args.bodyBudget,
    disk_limit: args.diskLimit,
  }));
  const child = Bun.spawn(['bun', join(import.meta.dir, 'capacity-collector.ts'), configPath], {
    stdout: 'pipe', stderr: 'pipe',
  });
  let metricsUrl = '';
  try {
    const port = await waitForCollector(child);
    const readToken = readFileSync(join(root, 'data', 'read.token'));
    const hookToken = readFileSync(join(root, 'data', 'hook.token'));
    metricsUrl = `http://127.0.0.1:${port}/api/ingest-metrics`;
    const headers = {
      host: `127.0.0.1:${port}`,
      authorization: `Bearer ${Buffer.from(readToken).toString('base64url')}`,
    };
    const hookHeaders = {
      host: `127.0.0.1:${port}`,
      authorization: `Bearer ${Buffer.from(hookToken).toString('base64url')}`,
      'content-type': 'application/json',
    };
    const hookLatency = new DurationRecorder();
    const queryLatency = new DurationRecorder();
    const client = newClientCounters();
    const inFlight = new Set<Promise<void>>();
    const limit = plan.concurrency;
    const startedAt = Date.now();
    const tickMs = 1000 / plan.rps;
    const readerTimer = setInterval(() => {
      void readOnce(port, headers).then(ms => queryLatency.record(ms)).catch(() => {});
    }, plan.readerIntervalMs);
    const launch = (tick: number): void => {
      const bodyBytes = plan.bodyMix[tick % plan.bodyMix.length]!;
      const session = `session-${tick % plan.sessions}`;
      const routeId = tick + 1;
      const hookId = `cap-${seed}-${routeId}`;
      const startedMs = Date.now();
      const envelope = makeHookEnvelope({
        hookId, session, routeId, requestBytes: bodyBytes,
        replyBytes: plan.replyBytes[tick % plan.replyBytes.length]!,
        bodyOmitted: false, omitReason: null, model: 'synthetic-model', startedMs,
      });
      // 账本与路由先落盘，hook 后到，覆盖乱序与后补两条路径。
      appendFileSync(join(root, 'sources', 'usage.jsonl'), makeLedgerLine({
        routeId, session, responseId: hookId, startedMs,
      }));
      appendRouteLine(root, routeId, session, startedMs);
      client.launched += 1;
      client.in_flight_peak = Math.max(client.in_flight_peak, inFlight.size + 1);
      const done = postWithRetry(`http://127.0.0.1:${port}/hook/ingest`, hookHeaders,
        () => JSON.stringify(envelope), client, hookLatency).finally(() => inFlight.delete(done));
      inFlight.add(done);
    };
    for (let tick = 0; tick < scheduledTicks(plan.durationMs, plan.rps); tick += 1) {
      const tickAt = startedAt + tick * tickMs;
      if (Date.now() < tickAt) await Bun.sleep(tickAt - Date.now());
      client.ticks_scheduled += 1;
      if (inFlight.size >= limit) client.ticks_dropped += 1;
      else launch(tick);
    }
    await Promise.all([...inFlight]);
    clearInterval(readerTimer);
    const stopAtMs = Date.now();
    const final = await pollDrain(metricsUrl, statsUrl, headers, stopAtMs);
    const snapshot = await fetchSnapshot(metricsUrl, headers);
    const childExit = await stopChild(child);
    const conservation = {
      ...countConservation(join(root, 'data', 'trace.db'), client.accepted),
      ...offeredShortfall(client),
    };
    return buildReport({
      plan: { ...plan, scenario: name, mode: 'baseline', seed: args.seed ?? 1 },
      args, client, hookLatency, queryLatency, snapshot, final, conservation,
      derive: {
        comparisons: null, decodes: null, full_incremental_equal: null,
        result_sha256: null, published_generations: null, discarded_generations: null,
      },
      startedAt, stopAt: stopAtMs,
      notes: [],
    });
  } finally {
    upstream.stop();
    if (child.exitCode === null) child.kill('SIGTERM');
    rmSync(root, { recursive: true, force: true });
  }
}
```

刻度按绝对时间推进，落后不补也不顺延。等响应再睡、一次只在途一笔的写法把速率交给采集器自己决定：采集器慢就少发，于是任何档位都"通过"。负载端因此在途上限取 `plan.concurrency`（5 rps 为 4，1 rps 为 1），到点却因在途已满没发出的刻度记进 `client.ticks_dropped`，并由 `offeredShortfall` 写进 `conservation.missing`，报告 `ok:false`；此时守恒为真只说明发出去的那部分收敛了。`hook_latency` 与 `query_latency` 记录每次尝试的耗时，读数间隔由 `plan.readerIntervalMs` 决定。

`postWithRetry` 在 429 和 503 时最多重试 8 次，退避 10、20、40、80、160、320、640、1,280 ms；十笔 4 MiB 并发在单线程采集器上串行排空，短窗口会让最后一笔耗尽重试。只记录状态码与响应中的固定 `error` 字段，不把请求体写进失败记录。不可重试状态码立即计入 `client.failed`，不等最后一次尝试；网络错误与重试耗尽也计入 `client.failed`。

- [ ] **Step 5：实现读取与排空轮询。** `readOnce` 依次请求会话列表、首个会话的请求列表和首条请求的正文页，任一非 2xx 都算读取失败并计入 `client.query_failed`，不能把 401/404 的 JSON 当样本。`pollDrain` 每 100 ms 读 `/api/ingest-metrics` 与 `/api/stats`，直到 `derive_queue.pending_groups === 0`、`pending_hooks === 0` 且 `open_gaps === 0`，或超时（`plan.durationMs + 120_000`，调用方显式传入）；只等派生队列会让末尾几个还没对账的 hook 多出请求行。超时把 `pending_groups_end` 保留为队列值，`pending_hooks` 与 `open_gaps` 写进 `conservation` 与 `missing`，报告 `ok:false`。

```ts
async function readOnce(port: number, headers: Record<string, string>): Promise<number> {
  const started = performance.now();
  const base = `http://127.0.0.1:${port}`;
  const sessions = await fetch(`${base}/api/sessions?limit=50`, { headers }).then(r => r.json()) as any;
  const key = sessions.items?.[0]?.conv_key;
  if (typeof key === 'string') {
    const requests = await fetch(`${base}/api/sessions/${encodeURIComponent(key)}/requests?limit=100`, { headers })
      .then(r => r.json()) as any;
    const id = requests.items?.[0]?.req_id;
    if (typeof id === 'number') {
      await fetch(`${base}/api/requests/${id}/body?from=0&to=${PAGE_MAX}`, { headers });
    }
  }
  return performance.now() - started;
}

async function pollDrain(url: string, headers: Record<string, string>, stopAtMs: number) {
  const deadline = Date.now() + 120_000;
  let polls = 0;
  let maxAge: number | null = null;
  for (;;) {
    polls += 1;
    const snapshot = await fetch(url, { headers }).then(r => r.json()) as any;
    const queue = snapshot.derive_queue;
    // 积压年龄优先用 dirty_since_ms；最老请求年龄只作回退观测。
    const age = queue.oldest_dirty_age_ms ?? queue.oldest_request_age_ms;
    if (age !== null) maxAge = Math.max(maxAge ?? 0, age);
    if (queue.pending_groups === 0) return { drain_ms: Date.now() - stopAtMs, polls, max_age_ms: maxAge, pending: 0 };
    if (Date.now() > deadline) return { drain_ms: null, polls, max_age_ms: maxAge, pending: queue.pending_groups };
    await Bun.sleep(100);
  }
}
```

- [ ] **Step 5a：补齐负载端 helper。** 下面这些函数是 Step 4 主循环与报告的直接依赖，必须随本任务一起实现；不接受以注释代替。

```ts
// scripts/capacity.ts 顶部 import 追加：
import { Database } from 'bun:sqlite';
import { summarizeDurations, type DurationSummary } from '../src/capacity';
import type { ScenarioReport } from './capacity-gate';

class DurationRecorder {
  private readonly values: number[] = [];
  record(ms: number): void { this.values.push(ms); }
  summary(): DurationSummary { return summarizeDurations(this.values); }
}

async function postWithRetry(url: string, headers: Record<string, string>,
  body: string, client: { attempts: number; accepted: number; duplicates: number;
    retried: number; failed: number }, recorder: DurationRecorder): Promise<unknown | null> {
  const delays = [0, 10, 20, 40, 80, 160];
  let lastError: string | null = null;
  for (const [index, delay] of delays.entries()) {
    if (delay > 0) { client.retried += 1; await Bun.sleep(delay); }
    client.attempts += 1;
    const started = performance.now();
    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', headers, body });
    } catch {
      lastError = 'network_error';
      continue;
    } finally {
      recorder.record(performance.now() - started);
    }
    const payload = await response.json().catch(() => ({})) as { error?: string; duplicate?: boolean };
    if (response.status === 200) {
      client.accepted += 1;
      if (payload.duplicate === true) client.duplicates += 1;
      return payload;
    }
    if (response.status === 429 || response.status === 503) {
      lastError = payload.error ?? `http_${response.status}`;
      continue;
    }
    if (index === delays.length - 1) {
      client.failed += 1;
      lastError = payload.error ?? `http_${response.status}`;
    }
    return null;
  }
  client.failed += 1;
  process.stderr.write(`capacity_hook_failed:${lastError ?? 'unknown'}\n`);
  return null;
}

async function fetchSnapshot(url: string, headers: Record<string, string>): Promise<any> {
  return fetch(url, { headers }).then(response => response.json());
}

async function stopChild(child: ReturnType<typeof Bun.spawn>): Promise<number | null> {
  if (child.exitCode === null) child.kill('SIGTERM');
  const deadline = Date.now() + 10_000;
  while (child.exitCode === null && Date.now() < deadline) await Bun.sleep(50);
  return child.exitCode;
}

function countConservation(dbPath: string, hookAccepted: number): {
  hook_accepted: number; raw_hook_rows: number; request_rows: number; evidence_rows: number;
  route_rows: number; missing: string[];
} {
  const db = new Database(dbPath, { readonly: true });
  try {
    const count = (table: string): number => Number((db.query(
      `SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    const rawHook = count('raw_hook');
    const requests = count('request');
    // 账本与 hook 对同一请求各留一行证据，按 req_id 去重才对得上唯一请求数。
    const evidence = Number((db.query(
      'SELECT COUNT(DISTINCT req_id) AS n FROM request_evidence').get() as { n: number }).n);
    const route = count('route_summary');
    const missing: string[] = [];
    if (rawHook !== hookAccepted) missing.push(`raw_hook:${rawHook}!=${hookAccepted}`);
    if (requests !== hookAccepted) missing.push(`request:${requests}!=${hookAccepted}`);
    if (evidence !== hookAccepted) missing.push(`request_evidence:${evidence}!=${hookAccepted}`);
    return {
      hook_accepted: hookAccepted, raw_hook_rows: rawHook, request_rows: requests,
      evidence_rows: evidence, route_rows: route, missing,
    };
  } finally {
    db.close();
  }
}

function buildReport(input: {
  plan: ScenarioPlan & { scenario: string; mode: 'baseline' | 'optimized' | 'slice'; seed: number };
  args: Args;
  client: { attempts: number; accepted: number; duplicates: number; retried: number; failed: number };
  hookLatency: DurationRecorder; queryLatency: DurationRecorder;
  snapshot: any;
  final: { drain_ms: number | null; polls: number; max_age_ms: number | null; pending: number };
  conservation: { hook_accepted: number; raw_hook_rows: number; request_rows: number;
    evidence_rows: number; route_rows: number; missing: string[] };
  derive: { comparisons: number | null; decodes: number | null;
    full_incremental_equal: boolean | null; result_sha256: string | null;
    published_generations: number | null; discarded_generations: number | null };
  startedAt: number; stopAt: number; notes: string[];
}): ScenarioReport {
  const ingest = input.snapshot.ingest;
  const storage = input.snapshot.storage;
  return {
    schema: 1,
    scenario: input.plan.scenario,
    mode: input.plan.mode,
    started_at: new Date(input.startedAt).toISOString(),
    duration_ms: input.stopAt - input.startedAt,
    seed: input.plan.seed,
    environment: { bun: Bun.version, platform: process.platform, arch: process.arch },
    config: {
      rps: input.plan.rps, sessions: input.plan.sessions, requests: input.plan.requests ?? 0,
      body_budget: input.args.bodyBudget, disk_limit: input.args.diskLimit,
    },
    client: {
      ...input.client,
      hook_latency: input.hookLatency.summary(),
      query_latency: input.queryLatency.summary(),
    },
    collector: {
      started_at_ms: ingest.started_at_ms,
      uptime_ms: ingest.uptime_ms,
      ingest: {
        accepted: ingest.accepted, duplicates: ingest.duplicates,
        rejected_total: ingest.rejected_total, rejected_by_reason: ingest.rejected_by_reason,
        accepted_request_bytes: ingest.accepted_request_bytes,
        accepted_reply_bytes: ingest.accepted_reply_bytes,
      },
      writer: input.snapshot.writer,
      event_loop: input.snapshot.event_loop,
      jobs: input.snapshot.jobs,
      route: input.snapshot.route,
      rss_peak_bytes: input.snapshot.rss_bytes,
      storage_peak: {
        db_bytes: storage.db_bytes, wal_bytes: storage.wal_bytes,
        temp_bytes: storage.temp_bytes, body_bytes: storage.body_bytes,
        total_bytes: storage.db_bytes + storage.wal_bytes + storage.temp_bytes,
        freelist_count: storage.freelist_count,
      },
      metadata: input.snapshot.metadata,
      derive_queue: input.snapshot.derive_queue,
    },
    derive: {
      backlog_max_age_ms: input.final.max_age_ms,
      drain_ms: input.final.drain_ms,
      drain_polls: input.final.polls,
      pending_groups_end: input.final.pending,
      comparisons: input.derive.comparisons,
      decodes: input.derive.decodes,
      full_incremental_equal: input.derive.full_incremental_equal,
      result_sha256: input.derive.result_sha256,
      published_generations: input.derive.published_generations,
      discarded_generations: input.derive.discarded_generations,
    },
    conservation: input.conservation,
    notes: input.notes,
    ok: input.conservation.missing.length === 0 && input.client.failed === 0
      && input.final.drain_ms !== null && input.final.pending === 0,
  };
}
```

- [ ] **Step 6：实现突发、长组、路由与回收场景。** 突发场景先为十笔请求落账本与路由行，再用 `Promise.all` 发 10 个并发，其中第 1 个请求体用分块流延迟 50 ms，保证 `ingesting` 互斥被观测到；重复发送第一个 `hook_id` 一次。长组场景直接 `openStore` 建合成库，调用 `persistBody`、`enqueueDerive`，再 `store.write(db => drainDeriveTx(db,{limit}))`，记录比较次数与解码次数；每写一笔就入队，积压年龄覆盖整个写入阶段。路由场景在同一个采集器上按时序追加、替换 gzip、增加跨午夜文件；回收场景注入 5 秒 retention/raw_prune 与 10 秒 cost 间隔，并预置 8 天前的 raw 行；停止后只读核对预置 raw 行已清空，残量非零时报告 `ok:false`。

**实现偏差（已按代码校正）。** 报告在最终快照之外按 1 秒采样 rss 与存储峰值（burst 在并发结束与排空后各一次，long 在写入、增量排空、全量重排后各一次），字段为 `rss_peak_bytes`、`storage_peak`、`storage_end`、`peak_samples`，采样次数写进 `notes`；`buildReport` 的 `config` 增加临时 `dataDir`，磁盘总量取 `StorageUsage.total_bytes` 而不是只加 db/wal/temp。`client` 增加 `query_failed`，非零时 `ok:false`。`hook_id` 由 `seed` 与序号生成，不再用随机 UUID，重放同一场景时关联可复现。`scenarioPlan` 对 10,000 笔长组同样要求 `acknowledgeLongRun`，`all`、`--full` 与 600,000 ms 由 `requiresLongRunAck` 统一判定。长组重建后的排空循环补 `processed===0` 的卡死守卫。`conservation` 增加 `pending_hooks` 与 `open_gaps`：收敛等待同时读 `/api/stats`，两者非零进 `missing` 并使报告失败；burst 先落账本与路由行，避免留下永不收敛的 `pending_hook`；`long` 直接建库，两者恒为 0。回收场景在正文峰值低于预算 90% 时写明未触发回收，不把未执行写成通过；用户未显式给 `--body-budget` 时，回收场景把预算压到 4 KiB（且小于盘上限的一半），`all` 中其余场景不受影响。

- [ ] **Step 7：运行冒烟。** Run:

```sh
bun scripts/capacity.ts --scenario smoke --duration-ms 5000 --rps 2 \
  --report /private/tmp/atc-capacity-smoke.json
```

Expected: 退出 0；报告 `ok:true`；`client.accepted` 等于发送数；`conservation.missing` 为空；`collector.ingest.rejected_by_reason` 各固定原因可读；`derive_queue.pending_groups` 最终为 0。若失败，先修采集器或合成器，不开始 10 分钟负载。

- [ ] **Step 8：提交。** 获授权后：

```bash
git add scripts/capacity.ts scripts/capacity-gate.ts scripts/capacity-support.ts scripts/capacity-collector.ts tests/capacity.test.ts .agents/notes/implemented/feature/2026-10-22-atc-capacity-load-driver.md
git commit -m "test(capacity): add isolated load driver and scenario matrix" \
  -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 6：运行完整基线

**Files:**
- Read: `scripts/capacity.ts`
- Create outside repo: `/private/tmp/atc-capacity-reports/` 下的报告
- No source changes

**Interfaces:**
- Consumes: Task 5 的 CLI 与报告。
- Produces: 每个场景一份 `ScenarioReport`；供 Task 7 冻结预算。

- [ ] **Step 1：确认没有连接真实来源。** 启动前检查命令只引用 `scripts/capacity.ts`，没有传 `--db`、`ATC_DATA_DIR` 或真实路径。Run:

```sh
mkdir -p /private/tmp/atc-capacity-reports
bun scripts/capacity.ts --scenario smoke --duration-ms 5000 --rps 2 \
  --report /private/tmp/atc-capacity-reports/smoke.json
```

Expected: 报告 `ok:true`；`config.dataDir` 的 basename 以 `atc-capacity-` 开头并落在 `tmpdir()` 下（macOS 上通常是 `/var/folders/…`，不是 `/private/tmp`）；假上游请求列表里没有 `:3425`。

- [ ] **Step 2：运行 1 请求/秒与 5 请求/秒各 10 分钟。** 这里需要容量实验授权，并显式确认长跑。两条命令分开运行，避免两个采集器争用机器。

```sh
bun scripts/capacity.ts --scenario baseline-1rps --full --acknowledge-long-run \
  --report /private/tmp/atc-capacity-reports/baseline-1rps.json
bun scripts/capacity.ts --scenario baseline-5rps --full --acknowledge-long-run \
  --report /private/tmp/atc-capacity-reports/baseline-5rps.json
```

Expected: 每个报告 `duration_ms=600000`；`client.ticks_scheduled` 为 600 与 3,000，`client.ticks_dropped=0`，`client.accepted` 等于 `client.launched` 且等于刻度数（1 rps 为 600，5 rps 为 3,000；边界上少发会以 `offered:` 缺口出现，报告记录实际值）；`derive.pending_groups_end=0`、`conservation.pending_hooks=0`、`conservation.open_gaps=0`，请求行数等于唯一接受数。正常持续负载不出现 `writer_failed`，`insufficient_storage` 为 0；`busy` 可以有值，负载端重试后应全部接受。若出现 `ok:false`，先修采集器或负载器，不调整预算掩盖。5 rps 若通过 `ticks_dropped` 落空，说明采集器在这一档跟不上，这正是要如实记下的容量结论。

- [ ] **Step 3：运行突发场景。** 10 个并发、4 MiB 请求、不同回复大小、同一 `hook_id` 重复一次。

```sh
bun scripts/capacity.ts --scenario burst \
  --report /private/tmp/atc-capacity-reports/burst.json
```

Expected: `client.in_flight_peak=10`；`collector.ingest.rejected_by_reason.busy > 0`；所有唯一请求最终 200；重复 `hook_id` 的响应 `duplicate:true`；`raw_hook` 与 `request` 唯一计数不因重复增加；至少一个请求的 `body_state=available`，不能用 200 代替正文存在；`rss_peak_bytes` 有界且记录。若并发没有重叠，报告 `busy=0` 并在 `notes` 写明，不能声称已观测背压。

- [ ] **Step 4：运行 2,000 与 10,000 笔长会话。** 先 2,000 确认脚本，再 10,000 作为压力点；两者都直接使用临时库，不经过默认数据目录。

```sh
bun scripts/capacity.ts --scenario long --requests 2000 \
  --report /private/tmp/atc-capacity-reports/long-2000.json
bun scripts/capacity.ts --scenario long --requests 10000 --acknowledge-long-run \
  --report /private/tmp/atc-capacity-reports/long-10000.json
```

Expected: `derive.pending_groups_end=0`；`derive.full_incremental_equal=true`；`derive.result_sha256` 在两次运行中一致；报告 `comparisons`、`decodes`、`max_write_tx_ms`、`drain_ms`。10,000 笔可能明显慢于 2,000 笔；这是观察结果，不是失败重试的理由。

- [ ] **Step 5：运行路由目录场景。** 不变轮询、追加、替换 gzip、跨午夜、损坏 gzip 恢复。

```sh
bun scripts/capacity.ts --scenario route \
  --report /private/tmp/atc-capacity-reports/route.json
```

Expected: 报告 `route.unchanged` 随轮询增长；`route.decoded` 只在追加、替换和新增日期文件时增长；替换后新路由进入 `route_summary`；损坏 gzip 记录 `route_gzip_invalid` 且游标不前进；修复后下一轮重新解压；`conservation.route_rows` 等于唯一路由数。

- [ ] **Step 6：运行回收与费用场景。** 正文预算设小、间隔注入 5 秒；预置 8 天前 raw 行；假上游返回可匹配的费用行。

```sh
bun scripts/capacity.ts --scenario retention --duration-ms 120000 \
  --body-budget 4096 --disk-limit 536870912 \
  --report /private/tmp/atc-capacity-reports/retention.json
```

Expected: `collector.jobs.retention.count >= 2`；`collector.jobs.raw_prune.count >= 1`；`collector.jobs.cost.count >= 1`；`storage_peak.body_bytes > storage_end.body_bytes`（回收后下降）；报告注明预置 raw 行剩余为 0；请求数与分页结果不因正文回收改变；`query_latency` 有样本；`db/wal/temp` 峰值已记录。若 raw 清理没有触发，检查预置行时间与 TTL，不把未执行写成通过。

- [ ] **Step 7：运行汇总。** 汇总命令按顺序重跑全部场景并写一份报告，供预算生成。只有在已获得长跑授权时执行。

```sh
bun scripts/capacity.ts --scenario all --full --acknowledge-long-run \
  --report /private/tmp/atc-capacity-reports/baseline-all.json
```

Expected: 退出 0；报告 `scenarios` 含全部场景；每个场景 `ok:true`；汇总 `conservation.missing` 为空。若任一场景失败，保留原报告并在 `notes` 记录失败阶段，不删报告重跑掩盖。

### Task 7：冻结预算与实现门槛脚本

**Files:**
- Create: `scripts/capacity-gate.ts`
- Modify: `scripts/capacity.ts`（`budget` 子命令）
- Create: `docs/superpowers/capacity/2026-10-22-atc-capacity-budget.json`
- Test: `tests/capacity-gate.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `baseline-all.json` 与单场景报告。
- Produces: `CapacityBudget`、`ScenarioReport`、`flattenReport(report): Record<string, number | null>`、`deriveBudget(report, input): CapacityBudget`、`evaluateGate(report, budget): GateFailure[]`、`loadBudget(path)`、`loadReport(path)`；CLI 退出码 0/1/2。

- [ ] **Step 1：写门槛测试。** 用合成报告与合成预算，不写真实测量值。覆盖预算缺失、字段缺失、通过、最大/最小失败与退出码。

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveBudget, evaluateGate, flattenReport, loadBudget, loadReport,
} from '../scripts/capacity-gate';
import type { ScenarioReport } from '../scripts/capacity-gate';

function report(): ScenarioReport {
  return {
    schema: 1, scenario: 'baseline-1rps', mode: 'baseline',
    started_at: '2026-10-22T00:00:00.000Z', duration_ms: 600000, seed: 7,
    environment: { bun: '1.4.0', platform: 'darwin', arch: 'arm64' },
    config: {}, client: {
      attempts: 600, accepted: 600, duplicates: 0, retried: 0, failed: 0,
      hook_latency: { count: 600, p50_ms: 5, p95_ms: 20, p99_ms: 30, max_ms: 40 },
      query_latency: { count: 100, p50_ms: 2, p95_ms: 8, p99_ms: 12, max_ms: 20 },
    },
    collector: {
      started_at_ms: 1, uptime_ms: 600000,
      ingest: { accepted: 600, duplicates: 0, rejected_total: 0, rejected_by_reason: {}, accepted_request_bytes: 1, accepted_reply_bytes: 1 },
      writer: { count: 10, total_ms: 10, max_ms: 5 },
      event_loop: { interval_ms: 50, count: 10, p50_ms: 1, p95_ms: 2, p99_ms: 3, max_ms: 4 },
      jobs: { derive: { count: 10, total_ms: 10, max_ms: 5 } },
      route: { polls: 1, files_seen: 1, decoded: 1, unchanged: 0, errors: 0 },
      rss_peak_bytes: 1000,
      storage_peak: { db_bytes: 10, wal_bytes: 2, temp_bytes: 1, body_bytes: 8, total_bytes: 13, freelist_count: 0 },
      derive_queue: {
        pending_groups: 0, oldest_dirty_since_ms: null, oldest_dirty_age_ms: null,
        oldest_request_started_ms: null, oldest_request_age_ms: null,
      },
    },
    derive: { backlog_max_age_ms: 10, drain_ms: 20, drain_polls: 1, pending_groups_end: 0, comparisons: 1, decodes: 1, full_incremental_equal: true, result_sha256: 'a'.repeat(64), published_generations: null, discarded_generations: null },
    conservation: { hook_accepted: 600, raw_hook_rows: 600, request_rows: 600, evidence_rows: 600, route_rows: 600, missing: [] },
    notes: [], ok: true,
  };
}

test('预算缺失与字段缺失都拒绝完成', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capacity-gate-'));
  try {
    expect(() => loadBudget(join(dir, 'missing.json'))).toThrow('capacity_budget_missing');
    writeFileSync(join(dir, 'budget.json'), JSON.stringify({ schema: 1 }));
    expect(() => loadBudget(join(dir, 'budget.json'))).toThrow('capacity_budget_invalid');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('预算生成只使用测量值与已声明上限', () => {
  const budget = deriveBudget(report(), {
    sourceReport: 'baseline-all.json', sourceReportSha256: 'b'.repeat(64),
  });
  expect(budget.scenarios['baseline-1rps']!.max.hook_latency_p95_ms).toBe(25);
  expect(budget.scenarios['baseline-1rps']!.max.max_write_tx_ms).toBe(900);
  expect(budget.scenarios['baseline-1rps']!.max.query_latency_p95_ms).toBe(100);
  expect(budget.scenarios['baseline-1rps']!.min.accepted).toBe(594);
  expect(budget.scenarios['baseline-1rps']!.basis.max_write_tx_ms).toBe('proposed');
});

test('门槛逐项报告最大值、最小值与缺失指标', () => {
  const budget = deriveBudget(report(), { sourceReport: 'x', sourceReportSha256: 'c'.repeat(64) });
  expect(evaluateGate(report(), budget)).toEqual([]);
  const slow = report();
  slow.client.hook_latency.p95_ms = 26;
  slow.derive.drain_ms = null;
  const failures = evaluateGate(slow, budget);
  expect(failures).toContainEqual({ scenario: 'baseline-1rps', check: 'hook_latency_p95_ms', actual: 26, limit: 25, kind: 'max', basis: 'baseline-envelope' });
  expect(failures.some(failure => failure.check === 'drain_ms' && failure.actual === -1)).toBe(true);
});
```

- [ ] **Step 2：验证失败。** Run: `bun test tests/capacity-gate.test.ts`。Expected: FAIL，模块不存在。

- [ ] **Step 3：实现 `scripts/capacity-gate.ts` 的加载与扁平化。** 所有报告指标先扁平化为数字或 null；缺字段与 null 都产生 `metric_missing`，不跳过。

```ts
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export type ThresholdBasis = 'code-constant' | 'product-target' | 'baseline-envelope' | 'proposed';
export type ScenarioBudget = {
  basis: Record<string, ThresholdBasis>;
  max: Record<string, number>;
  min: Record<string, number>;
};
export type CapacityBudget = {
  schema: 1; frozen_at: string; source_report: string; source_report_sha256: string;
  bun_version: string; scenarios: Record<string, ScenarioBudget>;
  retention: { max: Record<string, number>; basis: Record<string, ThresholdBasis> };
  slice?: { frozen_at: string; source_calibration: string; max: Record<string, number>; basis: Record<string, ThresholdBasis>; derive_budget: Record<string, number> };
};
export type GateFailure = {
  scenario: string; check: string; actual: number; limit: number;
  kind: 'max' | 'min'; basis: string;
};

export function loadReport(path: string): ScenarioReport {
  const text = readFileSync(path, 'utf8');
  const parsed = JSON.parse(text) as ScenarioReport;
  if (parsed.schema !== 1 || typeof parsed.scenario !== 'string') {
    throw new Error('capacity_report_invalid');
  }
  return parsed;
}

export function loadBudget(path: string): CapacityBudget {
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('capacity_budget_missing');
    throw error;
  }
  let parsed: CapacityBudget;
  try { parsed = JSON.parse(text) as CapacityBudget; }
  catch { throw new Error('capacity_budget_invalid'); }
  if (parsed.schema !== 1 || typeof parsed.frozen_at !== 'string' ||
      !/^[0-9a-f]{64}$/.test(parsed.source_report_sha256) ||
      parsed.scenarios === null || typeof parsed.scenarios !== 'object') {
    throw new Error('capacity_budget_invalid');
  }
  for (const scenario of Object.values(parsed.scenarios)) {
    if (scenario.max === null || scenario.min === null || scenario.basis === null) {
      throw new Error('capacity_budget_invalid');
    }
    for (const [key, value] of [...Object.entries(scenario.max), ...Object.entries(scenario.min)]) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('capacity_budget_invalid');
      if (scenario.basis[key] === undefined) throw new Error('capacity_budget_invalid');
    }
  }
  return parsed;
}

export function flattenReport(report: ScenarioReport): Record<string, number | null> {
  const rejected = report.collector.ingest.rejected_by_reason;
  const storage = report.collector.storage_peak;
  return {
    hook_latency_p95_ms: report.client.hook_latency.p95_ms,
    hook_latency_p99_ms: report.client.hook_latency.p99_ms,
    query_latency_p95_ms: report.client.query_latency.p95_ms,
    max_write_tx_ms: report.collector.writer.max_ms,
    event_loop_p99_ms: report.collector.event_loop.p99_ms,
    rss_peak_bytes: report.collector.rss_peak_bytes,
    backlog_max_age_ms: report.derive.backlog_max_age_ms,
    drain_ms: report.derive.drain_ms,
    rejected_total: report.collector.ingest.rejected_total,
    rejected_busy: rejected.busy ?? 0,
    rejected_insufficient_storage: rejected.insufficient_storage ?? 0,
    rejected_writer_failed: rejected.writer_failed ?? 0,
    client_failed: report.client.failed,
    accepted: report.client.accepted,
    db_bytes: storage.db_bytes,
    wal_bytes: storage.wal_bytes,
    temp_bytes: storage.temp_bytes,
    db_wal_temp_bytes: storage.db_bytes + storage.wal_bytes + storage.temp_bytes,
    body_bytes_peak: storage.body_bytes,
    metadata_total_bytes: report.collector.metadata.total_bytes,
    metadata_per_clean_group_bytes: report.collector.metadata.per_clean_group_bytes,
    metadata_per_request_bytes: report.collector.metadata.per_request_bytes,
    source_facts_json_bytes: report.collector.metadata.source_facts_json_bytes,
  };
}
```

- [ ] **Step 4：实现预算生成。** 规则写死在代码里并可复现；每个 `max` 的 `basis` 同时写入。`hook`、`query`、`write_tx`、`event_loop` 使用已有目标或代码常量；`backlog` 与 `drain` 标记 `proposed`；其余采用基线 1.25 倍。

**负载完整性阈值取自计划，不取自实测。** 速率场景的 `min.accepted` 与 `min.request_rows` 用 `client.ticks_scheduled`（即 `durationMs × rps`，由 `scheduledTicks` 算出，与实测无关）乘 0.99 取整，标 `product-target`；`max.ticks_dropped` 为 0，同样 `product-target`；`long` 用 `config.requests` 精确取 `min.request_rows`。这样「采集器跟不上就把目标悄悄降到自己的水平」在预算层被堵住：`baseline-5rps` 实测只发出 2,016 笔时，冻结出来的下限仍是 2,970。

冻结时同时写入 `unmet`：用 `evaluateGate` 跑一遍源报告，把失败项按场景记进预算文件，让「这份预算里哪些门槛当前构型没达到」成为预算自身的事实，而不是靠读 code review 记得。门槛在该场景保持退出 1，直到重新测量并重写预算。

```ts
const MIB = 1024 * 1024;

function ceilMargin(value: number, margin = 1.25): number {
  return Math.ceil(value * margin) + 1;
}

export function deriveBudget(
  report: ScenarioReport,
  input: { sourceReport: string; sourceReportSha256: string },
): CapacityBudget {
  const flat = flattenReport(report);
  const max: Record<string, number> = {};
  const min: Record<string, number> = {};
  const basis: Record<string, ThresholdBasis> = {};
  const putMax = (key: string, value: number | null, source: ThresholdBasis, fallback: number): void => {
    max[key] = value === null ? fallback : Math.max(1, Math.ceil(value));
    basis[key] = source;
  };
  putMax('hook_latency_p95_ms', 2000, 'product-target', 2000);
  putMax('hook_latency_p99_ms', 2500, 'product-target', 2500);
  putMax('query_latency_p95_ms', 100, 'product-target', 100);
  putMax('max_write_tx_ms', 900, 'proposed', 900);
  putMax('event_loop_p99_ms', 100, 'product-target', 100);
  putMax('rss_peak_bytes', flat.rss_peak_bytes === null ? null : ceilMargin(flat.rss_peak_bytes), 'baseline-envelope', 512 * MIB);
  putMax('backlog_max_age_ms', 30_000, 'proposed', 30_000);
  putMax('drain_ms', 120_000, 'proposed', 120_000);
  putMax('rejected_total', flat.rejected_total, 'baseline-envelope', 0);
  putMax('rejected_busy', flat.rejected_busy === null ? null : flat.rejected_busy + 1, 'baseline-envelope', 1);
  putMax('rejected_insufficient_storage', 0, 'code-constant', 0);
  putMax('rejected_writer_failed', 0, 'code-constant', 0);
  putMax('client_failed', 0, 'code-constant', 0);
  putMax('db_wal_temp_bytes', flat.db_wal_temp_bytes === null ? null : ceilMargin(flat.db_wal_temp_bytes), 'baseline-envelope', 256 * MIB);
  putMax('body_bytes_peak', flat.body_bytes_peak === null ? null : ceilMargin(flat.body_bytes_peak), 'baseline-envelope', 256 * MIB);
  min.accepted = Math.max(0, Math.floor((flat.accepted ?? 0) * 0.99));
  basis.accepted = 'baseline-envelope';

  return {
    schema: 1,
    frozen_at: new Date().toISOString(),
    source_report: input.sourceReport,
    source_report_sha256: input.sourceReportSha256,
    bun_version: report.environment.bun,
    scenarios: { [report.scenario]: { max, min, basis } },
    retention: {
      max: {
        retention_max_ms: max.max_write_tx_ms!,
        cost_max_ms: max.max_write_tx_ms!,
        raw_prune_max_ms: max.max_write_tx_ms!,
      },
      basis: {
        retention_max_ms: 'proposed',
        cost_max_ms: 'proposed',
        raw_prune_max_ms: 'proposed',
      },
    },
  };
}
```

`max_write_tx_ms` 使用 900 而不是基线最大值，但它的来源只能写 `proposed`：`busy_timeout=1000` 说明其它连接最多等待写锁 1000 ms，不能证明 900 ms 的事务必然提交，也不能从它推导成功上界。`backlog_max_age_ms=30000` 与 `drain_ms=120000` 同样是 `proposed`，不是已验证事实；最终报告必须单列。

- [ ] **Step 5：实现门槛评估。** 缺指标、null、超上限、低于下限都产生失败；`basis` 随失败项输出。

```ts
export function evaluateGate(report: ScenarioReport, budget: CapacityBudget): GateFailure[] {
  const failures: GateFailure[] = [];
  for (const [scenario, limits] of Object.entries(budget.scenarios)) {
    if (report.scenario !== scenario) {
      failures.push({ scenario, check: 'scenario', actual: -1, limit: 1, kind: 'max', basis: 'schema' });
      continue;
    }
    const flat = flattenReport(report);
    for (const [check, limit] of Object.entries(limits.max)) {
      const actual = flat[check];
      if (actual === null || actual === undefined) {
        failures.push({ scenario, check, actual: -1, limit, kind: 'max', basis: limits.basis[check] ?? 'missing' });
      } else if (actual > limit) {
        failures.push({ scenario, check, actual, limit, kind: 'max', basis: limits.basis[check] ?? 'missing' });
      }
    }
    for (const [check, limit] of Object.entries(limits.min)) {
      const actual = flat[check];
      if (actual === null || actual === undefined || actual < limit) {
        failures.push({
          scenario, check, actual: actual ?? -1, limit, kind: 'min',
          basis: limits.basis[check] ?? 'missing',
        });
      }
    }
  }
  return failures;
}
```

- [ ] **Step 6：实现 CLI 与汇总预算。** `budget` 子命令读取 `--report`，只接受包含 `scenarios` 的汇总报告；没有汇总时拒绝生成，避免用单场景预算冒充全部。汇总报告中的每个场景单独生成预算，`source_report_sha256` 对整个文件计算。`gate` 子命令两种输入都收：单场景报告只判它自己，汇总报告逐场景判，预算里缺的场景与汇总里多出来的场景都记失败项，不静默跳过。

```ts
if (import.meta.main) {
  const args = parseFlags(Bun.argv.slice(2));
  if (args.command === 'gate') {
    const budgetPath = required(args, '--budget');
    const reportPath = required(args, '--report');
    let budget: CapacityBudget;
    let report: ScenarioReport;
    try {
      budget = loadBudget(budgetPath);
      report = loadReport(reportPath);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : 'capacity_gate_invalid'}\n`);
      process.exit(2);
    }
    const failures = evaluateGate(report, budget);
    process.stdout.write(JSON.stringify({ ok: failures.length === 0, failures }, null, 2) + '\n');
    process.exit(failures.length === 0 ? 0 : 1);
  }
  // budget 子命令读取汇总报告，写入 docs/superpowers/capacity/...
}
```

- [ ] **Step 7：生成并冻结预算。** Run:

```sh
mkdir -p docs/superpowers/capacity
bun scripts/capacity.ts budget \
  --report /private/tmp/atc-capacity-reports/baseline-all.json \
  --out docs/superpowers/capacity/2026-10-22-atc-capacity-budget.json
bun scripts/capacity-gate.ts gate \
  --budget docs/superpowers/capacity/2026-10-22-atc-capacity-budget.json \
  --report /private/tmp/atc-capacity-reports/baseline-all.json
```

Expected: 预算文件写入成功并打印 sha256；门槛命令退出 0 或 1。退出 1 时记录失败项作为决策输入，不改预算隐藏失败。退出 2 表示预算或报告缺失，不能宣布完成。冻结后预算文件不再因单次优化结果改写；切片专用字段在 Task 18 另行追加 `slice` 段并记录 `source_calibration`。

- [ ] **Step 8：运行门槛测试。** Run: `bun test tests/capacity-gate.test.ts`。Expected: PASS。若 `deriveBudget` 的 `hook_latency_p95_ms` 断言为 2000，检查测试是否误用了单场景 25 ms 的报告；测试报告里的 20 ms 应得到 25。

- [ ] **Step 9：提交。** 获授权后：

```bash
git add scripts/capacity-gate.ts scripts/capacity.ts tests/capacity-gate.test.ts \
  .agents/notes/implemented/feature/2026-10-22-atc-capacity-budget-gate.md
  docs/superpowers/capacity/2026-10-22-atc-capacity-budget.json
git commit -m "test(capacity): freeze measured budget and gate reports" \
  -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 8：基线门槛与报告复核

**Files:**
- Read: 预算与报告
- No source changes
- Agent Note: `.agents/notes/implemented/process/2026-10-22-atc-capacity-baseline.md`

**Interfaces:**
- Consumes: Task 7 的预算与 Task 6 的报告。
- Produces: 基线门槛结果；失败项清单；`docs/superpowers/capacity/2026-10-22-atc-capacity-baseline.md` 记录实验环境、命令、报告哈希与结论；process note 记录测量方法、机器与种子、实测数字与置信口径。保留同步路径这个运行时决策另记在 `implemented/architecture/2026-10-22-capacity-baseline-keeps-sync.md`，本 note 不复述决策。

- [ ] **Step 1：逐场景跑门槛。** 对 `baseline-1rps`、`baseline-5rps`、`burst`、`long-2000`、`long-10000`、`route`、`retention` 分别生成单场景预算或从汇总预算中取对应项。当前 `deriveBudget` 按单报告生成；汇总报告的 `budget` 子命令必须逐场景写 `scenarios`，不合并指标。

```sh
for scenario in baseline-1rps baseline-5rps burst long-2000 long-10000 route retention; do
  bun scripts/capacity-gate.ts gate \
    --budget docs/superpowers/capacity/2026-10-22-atc-capacity-budget.json \
    --report "/private/tmp/atc-capacity-reports/${scenario}.json"
done
```

Expected: 每个命令输出 `{ok,...}` 与失败项；退出码 0 或 1。若某场景报告不在预算中，先补汇总预算，不跳过。

- [ ] **Step 2：复核测量口径。** 检查报告中 `client.accepted` 与 `collector.ingest.accepted - duplicates` 的差异，差异必须能由重试、重复或边界请求解释；`conservation.missing` 必须为空；`storage_peak` 与 `storage_end` 不同是正常的，报告用 `peak_samples` 与 `notes` 写明采样口径。不能把 `accepted` 与发送数不等直接判为丢失。

- [ ] **Step 3：写基线记录。** 创建 `docs/superpowers/capacity/2026-10-22-atc-capacity-baseline.md`，写明基准提交、Bun 版本、机器、每个场景命令、报告路径与 sha256、预算哈希、门槛失败项及 `basis`。记录不写真实请求内容；报告路径可以写临时路径，提交前确认报告没有进入仓库。process note `.agents/notes/implemented/process/2026-10-22-atc-capacity-baseline.md` 只写测量方法（合成负载、隔离与固定原因计数口径）、机器与固定种子、实测数字与置信口径，不写运行时结构决策；`keep-sync` 的决策与理由已在 `implemented/architecture/2026-10-22-capacity-baseline-keeps-sync.md`，本 note 不另立第二份。

- [ ] **Step 4：判断是否进入优化。** 若全部门槛通过，Task 11 选择 `keep-sync`，仍执行 Task 9 的路由测量，因为路由解码是独立的已验证优化点；若失败，保留失败项，进入 Task 9 与 Task 11。此时不创建 v6 文件。

已定：`baseline-5rps` 的失败**不改产品目标**。实测 20 会话、350 KiB–2 MiB 混合下只投递 3.36 rps（3,000 个刻度丢弃 984 个），derive 占 600 s 的 48%、单轮 max 5.46 s；把目标降到 3 rps 等于让实现反向改需求。该场景在预算里保持红门，主因指向派生成本，Task 11 按此判定进入 Part V；改造完成后重新测量并重写预算，才解除该项。

- [ ] **Step 5：提交基线记录。** 获授权后：

```bash
git add docs/superpowers/capacity/2026-10-22-atc-capacity-baseline.md \
  .agents/notes/implemented/process/2026-10-22-atc-capacity-baseline.md
git commit -m "docs(capacity): record baseline environment and gate outcome" \
  -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Part II：路由解码优化

### Task 9：路由文件先哈希后解压

**Files:**
- Modify: `src/sources/files.ts`
- Modify: `src/main.ts`
- Test: `tests/files.test.ts`
- Test: `tests/capacity.test.ts`

**Interfaces:**
- Consumes: 现有 `readRouteFiles(dir)`、`source_cursor.fingerprint`、`ingestRoute`。
- Produces: `RouteFile.state: 'decoded' | 'unchanged' | 'error'`；`readRouteFiles(dir, known: (name, fingerprint) => boolean)`；`route_gzip_invalid`、`route_gzip_limit`、`route_file_unreadable` 三种固定错误。

- [ ] **Step 1：写三态与替换检测测试。** 在 `tests/files.test.ts` 增加以下用例。测试通过 `known` 回调模拟已提交指纹，不访问真实路由目录。

```ts
test('未变gzip不再解压，追加与替换仍被检出', async () => {
  const f = fixture();
  try {
    const dir = join(f.dir, 'routing');
    mkdirSync(dir, { recursive: true });
    const name = '2026-10-22.jsonl.gz';
    const path = join(dir, name);
    const first = gzipSync(Buffer.from('{"id":1,"time":"2026-10-22T00:00:00Z"}\n'));
    writeFileSync(path, first);
    const digest = createHash('sha256').update(first).digest('hex');

    const decoded = await readRouteFiles(dir);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toMatchObject({ name, state: 'decoded', error: null });
    expect(decoded[0]!.lines).toHaveLength(1);

    const unchanged = await readRouteFiles(dir, (fileName, fingerprint) =>
      fileName === name && fingerprint === digest);
    expect(unchanged[0]).toMatchObject({ name, state: 'unchanged', error: null });
    expect(unchanged[0]!.lines).toEqual([]);

    const appended = Buffer.concat([gunzipSync(first), Buffer.from('{"id":2,"time":"2026-10-22T00:01:00Z"}\n')]);
    const replaced = gzipSync(appended);
    writeFileSync(path, replaced);
    const changed = await readRouteFiles(dir, (fileName, fingerprint) =>
      fileName === name && fingerprint === digest);
    expect(changed[0]).toMatchObject({ name, state: 'decoded', error: null });
    expect(changed[0]!.lines).toHaveLength(2);
  } finally { f.close(); }
});

test('损坏gzip保留指纹并报告固定错误，替换后恢复', async () => {
  const f = fixture();
  try {
    const dir = join(f.dir, 'routing');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, '2026-10-22.jsonl.gz');
    writeFileSync(path, Buffer.from('not a gzip stream'));
    const broken = await readRouteFiles(dir);
    expect(broken[0]).toMatchObject({ state: 'error', error: 'route_gzip_invalid' });
    expect(broken[0]!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const fixed = gzipSync(Buffer.from('{"id":1,"time":"2026-10-22T00:00:00Z"}\n'));
    writeFileSync(path, fixed);
    const recovered = await readRouteFiles(dir, () => false);
    expect(recovered[0]).toMatchObject({ state: 'decoded', error: null });
  } finally { f.close(); }
});

test('跨午夜只解压新增日期文件', async () => {
  const f = fixture();
  try {
    const dir = join(f.dir, 'routing');
    mkdirSync(dir, { recursive: true });
    const day1 = '2026-10-22.jsonl.gz';
    const day2 = '2026-10-23.jsonl.gz';
    writeFileSync(join(dir, day1), gzipSync(Buffer.from('{"id":1,"time":"2026-10-22T23:59:00Z"}\n')));
    const known = new Map<string, string>();
    for (const file of await readRouteFiles(dir)) known.set(file.name, file.fingerprint);
    writeFileSync(join(dir, day2), gzipSync(Buffer.from('{"id":2,"time":"2026-10-23T00:00:00Z"}\n')));
    const files = await readRouteFiles(dir, (name, fingerprint) => known.get(name) === fingerprint);
    expect(files.map(file => [file.name, file.state])).toEqual([
      [day1, 'unchanged'],
      [day2, 'decoded'],
    ]);
  } finally { f.close(); }
});
```

- [ ] **Step 2：验证失败。** Run: `bun test tests/files.test.ts -t '未变gzip|损坏gzip|跨午夜'`。Expected: FAIL，`state` 不存在或 gzip 每次都解压。

- [ ] **Step 3：实现三态。** 修改 `RouteFile` 与 `readRouteFiles`。读取一次字节，先算 SHA-256；命中 `known` 时直接返回 `unchanged`，不解压、不按行切分。解压失败与读取失败分开，失败时保留已算出的指纹，调用方不推进 cursor。

```ts
export type RouteFile = {
  name: string;
  fingerprint: string;
  kind: 'jsonl' | 'gz';
  state: 'decoded' | 'unchanged' | 'error';
  lines: string[];
  error: string | null;
};

export type RouteKnown = (name: string, fingerprint: string) => boolean;

export async function readRouteFiles(
  dir: string,
  known: RouteKnown = () => false,
): Promise<RouteFile[]> {
  const names = readdirSync(dir)
    .filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl(?:\.gz)?$/.test(name))
    .sort();
  const files: RouteFile[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const kind = name.endsWith('.gz') ? 'gz' as const : 'jsonl' as const;
    let bytes: Buffer;
    try {
      if (!statSync(path).isFile()) continue;
      bytes = readFileSync(path);
    } catch {
      files.push({ name, fingerprint: '', kind, state: 'error', lines: [], error: 'route_file_unreadable' });
      continue;
    }
    const fingerprint = createHash('sha256').update(bytes).digest('hex');
    if (known(name, fingerprint)) {
      files.push({ name, fingerprint, kind, state: 'unchanged', lines: [], error: null });
      continue;
    }
    let text: string;
    try {
      text = kind === 'gz'
        ? gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 }).toString('utf8')
        : bytes.toString('utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      files.push({
        name, fingerprint, kind, state: 'error', lines: [],
        error: code === 'ERR_BUFFER_TOO_LARGE' ? 'route_gzip_limit' : 'route_gzip_invalid',
      });
      continue;
    }
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    files.push({ name, fingerprint, kind, state: 'decoded', lines, error: null });
  }
  return files;
}
```

失败语义固定如下：

| 情形 | `state` | `error` | cursor |
| --- | --- | --- | --- |
| 文件消失、非普通文件、读取失败 | `error` | `route_file_unreadable` | 不推进 |
| gzip 解压失败 | `error` | `route_gzip_invalid` | 不推进，下一轮同指纹重试 |
| gzip 输出超过 512 MiB | `error` | `route_gzip_limit` | 不推进 |
| 指纹命中已提交值 | `unchanged` | `null` | 不推进 |
| 解压与按行切分成功 | `decoded` | `null` | 由调用方在 ingest 成功后推进 |

替换检测以同一次读取的字节哈希为准。文件在读取过程中继续追加时，本次批次只代表读到的那个字节快照；下一轮指纹变化会重新解压。哈希碰撞不作为运行时分支处理，SHA-256 碰撞不在本计划的失败模型内。

- [ ] **Step 4：修改 `routeTick`。** 每次 tick 只查一次已提交指纹，传给 `readRouteFiles`。`unchanged` 与 `error` 都不进入 ingest。`error` 只写 stderr 与指标，不推进 cursor。`decoded` 且 ingest 成功后写 cursor，指纹取本次读取的哈希。

```ts
const cursors = new Map(
  store.read.query<{ source_name: string; fingerprint: string | null }, []>(
    "SELECT source_name, fingerprint FROM source_cursor WHERE source_kind IN ('route_file','route_gz')",
  ).all().map(row => [row.source_name, row.fingerprint] as const),
);
const files = await readRouteFiles(
  config.routingDir,
  (name, fingerprint) => cursors.get(name) === fingerprint,
);
metrics.route.record({
  files: files.length,
  decoded: files.filter(file => file.state === 'decoded').length,
  unchanged: files.filter(file => file.state === 'unchanged').length,
  errors: files.filter(file => file.state === 'error').length,
});
for (const file of files) {
  if (file.state !== 'decoded') {
    if (file.state === 'error') process.stderr.write(`route_file_error:${file.name}:${file.error}\n`);
    continue;
  }
  const kind = file.kind === 'gz' ? 'route_gz' : 'route_file';
  const now = Date.now();
  const records: unknown[] = [];
  for (const line of file.lines) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      store.write(db => db.run(
        `INSERT INTO ingest_issue(source_kind,ref_key,reason,observed_at) VALUES (?,?,?,?)
         ON CONFLICT DO UPDATE SET observed_at=excluded.observed_at`,
        ['route', JSON.stringify([file.name, file.fingerprint]), 'route_invalid_json', now],
      ));
    }
  }
  ingestRoute(store, records, now, salt);
  const committed = file.lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
  store.write(db => db.run(
    `INSERT INTO source_cursor(source_kind,source_name,file_generation,committed_off,fingerprint,last_ok_ms)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(source_kind,source_name) DO UPDATE SET
       file_generation=excluded.file_generation,committed_off=excluded.committed_off,
       fingerprint=excluded.fingerprint,last_ok_ms=excluded.last_ok_ms`,
    [kind, file.name, file.fingerprint, committed, file.fingerprint, now],
  ));
}
```

- [ ] **Step 5：运行测试。** Run: `bun test tests/files.test.ts tests/http.test.ts`。Expected: PASS。Run: `bun run typecheck`。Expected: PASS。

- [ ] **Step 6：提交。** 获授权后：

```bash
git add src/sources/files.ts src/main.ts tests/files.test.ts tests/capacity.test.ts .agents/notes/implemented/feature/2026-10-22-atc-route-hash-before-decode.md
git commit -m "feat(files): hash route files before decompression" \
  -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 10：路由优化前后对照

**Files:**
- Read: `scripts/capacity.ts`、报告
- No source changes
- Modify: `.agents/notes/implemented/feature/2026-10-22-atc-route-hash-before-decode.md`（在其证据段追加前后对比）

**Interfaces:**
- Consumes: Task 6 的 `route.json` 与 Task 9 的新实现。
- Produces: 路由场景对照数字；`decoded` 下降与替换检出的证据，写入 Task 9 那份 feature note 的证据段，不另立一份记录。

- [ ] **Step 1：重跑路由场景。** Run:

```sh
bun scripts/capacity.ts --scenario route \
  --report /private/tmp/atc-capacity-reports/route-after.json
bun scripts/capacity-gate.ts gate \
  --budget docs/superpowers/capacity/2026-10-22-atc-capacity-budget.json \
  --report /private/tmp/atc-capacity-reports/route-after.json
```

Expected: `route.unchanged` 大于优化前；稳定轮询下 `route.decoded` 接近 0；追加、替换、跨午夜各触发一次 `decoded`；损坏 gzip 报告 `route_gzip_invalid`；替换后路由证据集合不漏不重。若 `decoded` 没有下降，检查 `known` 是否用了错误 kind 的 cursor，或文件是否每轮都在变化。

- [ ] **Step 2：记录对照。** 在 `docs/superpowers/capacity/2026-10-22-atc-capacity-baseline.md` 增加「路由解码对照」一节，写优化前后 `decoded`、`unchanged`、`errors` 与命令；同一组数字并入 `implemented/feature/2026-10-22-atc-route-hash-before-decode.md` 的证据段（改动是 feature，对比结果属于它的证据，不另立第二份 note）。两处只写测量值，不写推测的吞吐提升。

- [ ] **Step 3：提交。** 获授权后：

```bash
git add docs/superpowers/capacity/2026-10-22-atc-capacity-baseline.md \
  .agents/notes/implemented/feature/2026-10-22-atc-route-hash-before-decode.md
git commit -m "docs(capacity): compare route decode before and after hashing" \
  -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Part III：分支决策

### Task 11：判定保留同步或进入切片

**Files:**
- Create: `scripts/capacity-decision.ts`
- Create: `docs/superpowers/capacity/2026-10-22-atc-capacity-decision.json`
- Test: `tests/capacity-gate.test.ts`

**Interfaces:**
- Consumes: `GateFailure[]`、`ScenarioReport`、预算。
- Produces: `CapacityDecision = 'keep-sync' | 'slice' | 'stop-non-long'`；`decideCapacity(input)`；决策 JSON。

- [ ] **Step 1：写判定测试。** 覆盖通过、长组主因、非长组失败与并列失败。

```ts
test('决策只在长组主因且无其它绝对失败时进入切片', () => {
  const longFailure = {
    scenario: 'long-10000', check: 'max_write_tx_ms',
    actual: 5000, limit: 900, kind: 'max' as const, basis: 'proposed',
  };
  expect(decideCapacity({ failures: [longFailure], scenarios: ['baseline-1rps', 'long-10000'] }))
    .toMatchObject({ decision: 'slice', primary: 'long-10000' });
  expect(decideCapacity({ failures: [], scenarios: ['baseline-1rps'] }))
    .toMatchObject({ decision: 'keep-sync' });
  expect(decideCapacity({
    failures: [{ ...longFailure, scenario: 'baseline-5rps' }],
    scenarios: ['baseline-5rps', 'long-10000'],
  })).toMatchObject({ decision: 'stop-non-long', primary: 'baseline-5rps' });
  expect(decideCapacity({
    failures: [longFailure, {
      scenario: 'baseline-1rps', check: 'query_latency_p95_ms',
      actual: 200, limit: 100, kind: 'max', basis: 'product-target',
    }],
    scenarios: ['baseline-1rps', 'long-10000'],
  })).toMatchObject({ decision: 'stop-non-long' });
});
```

- [ ] **Step 2：验证失败。** Run: `bun test tests/capacity-gate.test.ts -t '决策只在长组主因'`。Expected: FAIL，`decideCapacity` 不存在。

- [ ] **Step 3：实现判定。** 严重度按 `actual / limit`；最小值失败按 `limit / max(actual, 1)`。主因是严重度最高的失败所在场景。进入切片需要同时满足：主因场景是 `long-10000`；该场景至少一项失败属于 `max_write_tx_ms`、`event_loop_p99_ms`、`drain_ms`、`backlog_max_age_ms`；其它场景没有 `code-constant` 或 `product-target` 失败。

```ts
export type CapacityDecision = 'keep-sync' | 'slice' | 'stop-non-long';

export function decideCapacity(input: {
  failures: GateFailure[]; scenarios: string[];
}): { decision: CapacityDecision; primary: string | null; severity: number } {
  if (input.failures.length === 0) {
    return { decision: 'keep-sync', primary: null, severity: 0 };
  }
  const scored = input.failures.map(failure => ({
    failure,
    score: failure.kind === 'max'
      ? failure.actual / Math.max(1, failure.limit)
      : failure.limit / Math.max(1, failure.actual),
  }));
  scored.sort((left, right) => right.score - left.score);
  const primary = scored[0]!.failure.scenario;
  const longChecks = new Set(['max_write_tx_ms', 'event_loop_p99_ms', 'drain_ms', 'backlog_max_age_ms']);
  const longHasPrimaryCheck = scored.some(item =>
    item.failure.scenario === 'long-10000' && longChecks.has(item.failure.check));
  const otherAbsolute = input.failures.some(failure =>
    failure.scenario !== 'long-10000' &&
    (failure.basis === 'code-constant' || failure.basis === 'product-target'));
  const decision = primary === 'long-10000' && longHasPrimaryCheck && !otherAbsolute
    ? 'slice'
    : 'stop-non-long';
  return { decision, primary, severity: scored[0]!.score };
}
```

`stop-non-long` 不是完成路径。它保留同步入口，报告实际失败项与主因，不创建 v6 文件，不把未解决项写成已通过。

**实测与判定条件的冲突（需在 Task 11 执行前改条件，不能机械照抄）。** 上面的规则把进入切片的前提写成"主因是 `long-10000`，且其它场景没有 `product-target` 失败"。`baseline-5rps` 的实测推翻了这个前提：它失败在 `min.accepted`/`max.ticks_dropped`/`event_loop_p99_ms` 上（都是 `product-target`），而它的主因与长组是同一处机制 —— `drainDeriveTx` 每个脏组整组重算，5 rps 下 20 个会话每轮全脏，derive 占 600 s 的 48%、单轮 max 5.46 s，writer 占 56%。也就是说"同步写入成本只在长组咬人"这一假设不成立，按现规则会判成 `stop-non-long` 并把已经知道原因的失败留在一个不被执行的路径上。

改法（二选一，执行前定）：把"主因场景是 `long-10000`"放宽为"主因场景属于同步派生成本场景（`long-10000` 或速率基线）且该场景至少一项失败属于 `max_write_tx_ms`、`event_loop_p99_ms`、`drain_ms`、`backlog_max_age_ms`、`min.accepted`"；或者保留 `decideCapacity` 作为"当前同步设计能否按现状发布"的自动闸门，把 Part V 的执行条件改成"决策为 `slice` **或** 产品目标明确未达成"。**已定：取后者。** `decideCapacity` 的判定规则一字不改，`stop-non-long` 照旧表示"当前同步设计不能按现状发布"，脚本不为产品决定代签；Part V 由"5 rps 必须达成"这个产品决定触发，并在决策文件之外单独记录触发理由。

- [ ] **Step 4：写决策文件。** 决策 JSON 包含报告 sha256、预算 sha256、失败项、主因、严重度、`decided_at` 与执行命令。没有预算时先由 Task 7 退出 2，不生成决策。

```json
{
  "schema": 1,
  "decision": "keep-sync",
  "primary": null,
  "severity": 0,
  "report_sha256": "<64 hex>",
  "budget_sha256": "<64 hex>",
  "failures": [],
  "decided_at": "<ISO-8601>"
}
```

上面的 JSON 是字段形状示例，`decision` 与哈希必须由脚本从实际报告写入，不能手填。Run:

```sh
bun scripts/capacity-decision.ts \
  --report /private/tmp/atc-capacity-reports/baseline-all.json \
  --budget docs/superpowers/capacity/2026-10-22-atc-capacity-budget.json \
  --out docs/superpowers/capacity/2026-10-22-atc-capacity-decision.json
```

Expected: 输出 `{decision,primary,severity}`；退出 0。若 `decision=stop-non-long`，停止 F 的完成声明，列出失败项；Task 12 与 Part V 都不执行。

- [ ] **Step 5：提交。** 获授权后：

```bash
git add scripts/capacity-decision.ts tests/capacity-gate.test.ts \
  .agents/notes/implemented/feature/2026-10-22-atc-capacity-decision.md
  docs/superpowers/capacity/2026-10-22-atc-capacity-decision.json
git commit -m "test(capacity): decide sync or slice from measured gate failures" \
  -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Part IV：条件分支 A，保留同步派生

### Task 12：保留同步路径的验收与文档

**执行条件：** Task 11 的决策为 `keep-sync`。决策为 `slice` 时跳过本任务；决策为 `stop-non-long` 时也不执行，先报告失败项。

**Files:**
- Modify: `docs/operations.md`
- Modify: `docs/architecture-design.md`（只写已交付的观测与容量当前状态）
- Create: `.agents/notes/implemented/architecture/2026-10-22-capacity-baseline-keeps-sync.md`
- Read: 预算、报告、决策

**Interfaces:**
- Consumes: Task 7 的预算、Task 8 的基线记录、Task 11 的决策。
- Produces: 保留同步的完成记录；不产生 v6 schema、迁移脚本或切片代码。

- [ ] **Step 1：确认没有预建切片。** Run:

```sh
test ! -e src/schema-v6.sql
test ! -e scripts/migrate-v6.ts
test ! -e src/derive-slice.ts
grep -R "published_generation" src tests || true
rg -n "SCHEMA_VERSION" src/store.ts
```

Expected: 前三条退出 0；`published_generation` 只出现在计划、报告或文档，不出现在运行时 schema；`SCHEMA_VERSION` 等于 C 的 v5 值，不做 v6 升级。

- [ ] **Step 2：更新运维文档。** 在 `docs/operations.md` 增加「容量实验」一节，写清：

```sh
# 冒烟，不连真实数据
bun scripts/capacity.ts --scenario smoke --duration-ms 5000 --rps 2 \
  --report /private/tmp/atc-capacity-reports/smoke.json

# 门槛，预算缺失退出 2
bun scripts/capacity-gate.ts gate \
  --budget docs/superpowers/capacity/2026-10-22-atc-capacity-budget.json \
  --report /private/tmp/atc-capacity-reports/baseline-all.json

# 采集器统计，使用读取令牌
curl -s -H "Authorization: Bearer $(cat '<dataDir>/read.token' | base64)" \
  http://127.0.0.1:8320/api/ingest-metrics
```

文档同时写明：计数按进程重启归零；`busy` 是 429 背压，不是 503；`insufficient_storage` 是 507；报告里的 `proposed` 阈值不是已验证事实。命令中的 `<dataDir>` 是占位路径，不写真实路径。

- [ ] **Step 3：更新架构文档。** 在 `docs/architecture-design.md` 的容量与保留一节写明：采集器提供固定原因拒绝计数、写事务与事件循环时延、认证统计入口；路由文件先哈希再解压；派生仍走 A 的同步完整入口；本轮不引入代际表或 worker。只写现行机制，不写变更史。

- [ ] **Step 4：写 Agent Note。** note 只记录为什么保留同步、预算与门槛的实际结果、否决切片的理由和代价，不复制字段与命令。至少包含：

```markdown
## Decision

容量基线在已冻结预算下通过。派生仍由 `drainDeriveTx` 的单 writer 同步事务完成，不引入代际表、暂存结果或 worker。

## Consequences

长组仍占用单个写事务；超过 `max_write_tx_ms` 预算的组会使门槛失败并重新进入切片决策。观测计数按进程重启归零，不能跨重启累计。
```

若实际门槛有 `proposed` 失败项但决策仍是 `keep-sync`，note 必须列出这些项并说明未把它们当成已验证事实。

- [ ] **Step 5：最终门槛。** Run:

```sh
bun scripts/capacity-gate.ts gate \
  --budget docs/superpowers/capacity/2026-10-22-atc-capacity-budget.json \
  --report /private/tmp/atc-capacity-reports/baseline-all.json
bun run verify:notes
bun run typecheck
```

Expected: 门槛退出 0；`verify:notes` PASS；typecheck PASS。任一失败都保留报告，不宣布完成。

- [ ] **Step 6：提交。** 获授权后：

```bash
git add docs/operations.md docs/architecture-design.md \
  .agents/notes/implemented/architecture/2026-10-22-capacity-baseline-keeps-sync.md
git commit -m "docs(capacity): record measured baseline and keep synchronous derivation" \
  -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Part V：条件分支 B，长组切片

**执行条件：** Task 11 的决策为 `slice`，**或**产品目标明确未达成（本计划已如此决定：`baseline-5rps` 的 5 rps 目标保持未达成，实测只投递 3.36 rps，主因是派生整组重算）。此时决策文件里的 `decision` 应为 `stop-non-long`，它表示"当前同步设计不能按现状发布"，不是"不得开工"；触发理由单独记在决策文件之外。决策为 `keep-sync` 时，本部分全部任务保持未勾选，不创建任何 v6 文件，不运行迁移。

### Task 13：v6 代际 schema（迁移部分已按用户决定取消）

**执行前提变更（用户决定，2026-10-23）。** 原计划在这里按两阶段标记与 keyset 分批写 v5→v6 的可续跑迁移（`scripts/migrate-v6.ts`、`tests/fixtures/schema-v5.sql`、`migration:v5/v6` 标记）。用户明确「不需要数据库迁移」，与既定的破坏式立场一致（[旧库删除重建](../../../../.agents/notes/implemented/architecture/2026-10-23-destructive-schema-replacement.md)）。实际落地为：只建 v6 结构，`openStore` 的空库路径在同一事务里写 v5 基础结构 + v6 结构与 `user_version=6`；低版本一律 `schema_rebuild_required`，没有完成标记、没有续跑入口、也没有半迁移状态。

因此下方 Step 1、2、5、6（v5 fixture、迁移测试、迁移实现、迁移 CLI）整段不执行；Step 4 的 DDL 与 Step 7 的版本门按破坏式简化执行（无 `assertV6Complete`、无标记写入）；Step 3 的"验证失败"由"用例不存在"变成"结构不存在"；Step 8 只跑 `tests/store.test.ts` 与 `tests/maintenance.test.ts`。为什么仍然要 v6 结构、为什么不做迁移，见 [v6 派代际结构](../../../../.agents/notes/implemented/architecture/2026-10-22-atc-schema-v6-generations.md)。

**Files：**
- Create: `src/schema-v6.sql`
- Modify: `src/store.ts`
- Modify: `src/maintenance.ts`（白名单改值，见 Task 13b）
- Test: `tests/store.test.ts`、`tests/maintenance.test.ts`
- Agent Note: `.agents/notes/implemented/architecture/2026-10-22-atc-schema-v6-generations.md`

**Interfaces:**
- Consumes: v5 的 `src/schema.sql`、`derive_queue`、`request` 与 `tool_call` 的既有列。
- Produces: v6 表、索引与视图；`SCHEMA_VERSION=6`；空库建到 v6；低版本 `schema_rebuild_required`。

**原计划的 Files（不执行）：** `scripts/migrate-v6.ts`、`tests/fixtures/schema-v5.sql`、`tests/migrate-v6.test.ts`。

- [ ] **Step 1：冻结 v5 fixture。** 从 C 的 v5 提交取只读 fixture，并在首行记录来源提交。Run:

```sh
C_V5_COMMIT=$(git log -1 --format=%H -- src/schema.sql)
{
  printf '%s\n' "-- frozen v5 schema from $C_V5_COMMIT; do not edit"
  git show "$C_V5_COMMIT":src/schema.sql
} > tests/fixtures/schema-v5.sql
```

Expected: fixture 第一行是实际 v5 提交；迁移测试只读这份 fixture，不依赖执行时的 `src/schema.sql`。

- [ ] **Step 2：写迁移测试。** 覆盖成功迁移、完整标记、重复运行、批中断续跑、失败保留 v5 值和旧列、purpose 字段消费、结果表不复制 D 的权威字段。

```ts
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateV6 } from '../scripts/migrate-v6';

const SCHEMA_V5 = readFileSync(new URL('./fixtures/schema-v5.sql', import.meta.url), 'utf8');

function requestRow(db: Database, id: number, started: number): void {
  db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
    body_state,derive_version,have,created_at,updated_at,sort_source,sort_key,
    title,title_source,input_epoch,input_revision,summary_algorithm,summary_basis,
    summary_state,purpose_revision,purpose_version,req_kind,model_title)
    VALUES (?, 'c','a','known',?,'2026-10-22','hook','available',0,1,1,1,
      'ledger',?,'legacy title','user_delta','epoch-1',7,4,'v5-basis','retained',
      11,3,'chat','model title')`, [id, started, `ledger|${String(started).padStart(20, '0')}`]);
}

function v5Database(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA_V5);
  db.exec('PRAGMA user_version=5');
  requestRow(db, 1, 100);
  requestRow(db, 2, 200);
  db.run(`INSERT INTO block(id,hash,fingerprint,z,raw_size) VALUES (1,x'01','fp-1',x'02',2)`);
  db.run('INSERT INTO request_block(req_id,ord,role,block) VALUES (1,0,0,1)');
  db.run(`INSERT INTO tool_call(call_id,req_id,ord,tool_name,state,derive_version,
    algorithm_version,basis_json,retention_state)
    VALUES ('call-1',1,0,'read','resolved',99,4,'tool-basis','retained')`);
  db.run(`INSERT INTO derive_queue(conv_key,actor,from_sort,group_epoch,input_revision,
    published_revision,target_algorithm,published_algorithm,state,dirty_since_ms)
    VALUES ('c','a','','epoch-group',7,7,4,4,'clean',NULL)`);
  db.run(`INSERT INTO collector_state(key,value_json) VALUES ('migration:v5',?)`,
    [JSON.stringify({ format: 1, target: 5, phase: 'complete', cursor: null,
      scope: 'all', complete: true, report: {} })]);
  return db;
}

test('v5迁移按keyset复制并写完整marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-v6-migrate-'));
  try {
    const path = join(dir, 'trace.db');
    const db = v5Database(path);
    const report = migrateV6(db, { now: 1000, batchRows: 1 });
    expect(report).toMatchObject({ ok: true, groups: 1, requests: 2, tools: 1, batches: 2 });
    expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 6 });
    expect(JSON.parse((db.query(
      "SELECT value_json FROM collector_state WHERE key='migration:v6'").get() as any).value_json))
      .toMatchObject({ format: 1, target: 6, complete: true, phase: 'complete' });
    const queue = db.query('SELECT * FROM derive_queue').get() as any;
    expect(queue.legacy_snapshot).toBe(1);
    expect(queue.published_generation).toMatch(/^legacy-/);
    expect(queue.compute_generation).toBeNull();
    expect(queue.dirty_since_ms).toBeNull();
    expect(queue.state).toBe('clean');
    const generation = db.query('SELECT * FROM derive_generation').get() as any;
    expect(generation.state).toBe('published');
    expect(generation.stage).toBe('done');
    expect(generation.cursor_req_id).toBe(2);
    expect(generation.request_count).toBe(generation.source_request_count);
    expect(generation.tool_count).toBe(generation.source_tool_count);
    expect(generation.source_request_sha256).toBe(generation.copied_request_sha256);
    expect(generation.source_tool_sha256).toBe(generation.copied_tool_sha256);

    const request = db.query(`SELECT * FROM derive_request_result
      WHERE generation=? AND req_id=1`).get(generation.generation) as any;
    expect(request.algorithm).toBe(4);
    expect(request.retention_state).toBe('retained');
    expect(request.purpose_revision).toBe(11);
    expect(request.purpose_version).toBe(3);
    expect(JSON.parse(request.basis_json)).toMatchObject({ source: 'v5-legacy', summary_basis: 'v5-basis' });
    const resultColumns = (db.query('PRAGMA table_info(derive_request_result)').all() as { name: string }[])
      .map(row => row.name);
    expect(resultColumns).not.toContain('req_kind');
    expect(resultColumns).not.toContain('model_title');
    expect(resultColumns).not.toContain('fingerprints_json');
    const effective = db.query('SELECT * FROM effective_request WHERE req_id=1').get() as any;
    expect(effective).toMatchObject({
      req_kind: 'chat', model_title: 'model title', title: 'legacy title',
      group_state: 'clean', legacy_snapshot: 1,
      current_purpose_revision: 11, consumed_purpose_revision: 11,
    });
    expect(() => migrateV6(db, { now: 2000 })).toThrow('schema_already_v6');
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('批中断保留旧列、incomplete marker与游标，修复后从游标续跑', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-v6-fail-'));
  try {
    const path = join(dir, 'trace.db');
    const db = v5Database(path);
    // 第二行违反 v6 的 CHECK(req_id > 0)，让第一批成功、第二批失败。
    db.run('UPDATE request SET req_id=-1 WHERE req_id=2');
    expect(() => migrateV6(db, { now: 1000, batchRows: 1 }))
      .toThrow('schema_v6_copy_failed');
    expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 6 });
    expect(JSON.parse((db.query(
      "SELECT value_json FROM collector_state WHERE key='migration:v6'").get() as any).value_json))
      .toMatchObject({ target: 6, complete: false });
    expect((db.query('SELECT * FROM derive_queue').get() as any).published_generation).toBeNull();
    expect((db.query('SELECT title FROM request WHERE req_id=1').get() as any).title).toBe('legacy title');
    const building = db.query('SELECT * FROM derive_generation').get() as any;
    expect(building.state).toBe('building');
    expect(building.cursor_req_id).toBe(1);
    expect(building.request_count).toBe(1);

    db.run('UPDATE request SET req_id=2 WHERE req_id=-1');
    const report = migrateV6(db, { now: 2000, batchRows: 1 });
    expect(report.ok).toBe(true);
    expect(report.requests).toBe(2);
    expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 6 });
    const done = db.query('SELECT * FROM derive_generation').get() as any;
    expect(done.state).toBe('published');
    expect(done.request_count).toBe(2);
    expect(done.source_request_sha256).toBe(done.copied_request_sha256);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 3：验证失败。** Run: `bun test tests/migrate-v6.test.ts`。Expected: FAIL，`migrateV6` 不存在或 v6 对象不存在。记录实际错误，不把模块解析失败当成行为断言失败。

- [ ] **Step 4：写完整 v6 DDL。** `src/schema-v6.sql` 只包含 v6 新对象、对既有 `derive_queue` 的列增补和视图。`derive_queue` 不 drop、不 rename；v5 没有限制这三个状态的 CHECK，因此原地 `ALTER` 即可。

```sql
-- ATC schema v6: derive generations, staged results, work tables, publish pointer.
-- Executed by openStore() when it creates a brand-new database. v6 is not migrated into:
-- an existing lower-version database is refused and rebuilt by the operator.
-- Legacy request/tool_call columns stay in place and are never mixed field-by-field.

ALTER TABLE derive_queue ADD COLUMN legacy_snapshot INTEGER NOT NULL DEFAULT 0;
ALTER TABLE derive_queue ADD COLUMN compute_generation TEXT;
ALTER TABLE derive_queue ADD COLUMN published_generation TEXT;
ALTER TABLE derive_queue ADD COLUMN compute_started_ms INTEGER;
ALTER TABLE derive_queue ADD COLUMN last_claimed_ms INTEGER;
ALTER TABLE derive_queue ADD COLUMN last_completed_ms INTEGER;
ALTER TABLE derive_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE derive_queue ADD COLUMN last_error TEXT;

CREATE INDEX IF NOT EXISTS i_derive_queue_dirty
  ON derive_queue(state, dirty_since_ms);
CREATE INDEX IF NOT EXISTS i_derive_queue_compute
  ON derive_queue(compute_generation) WHERE compute_generation IS NOT NULL;

CREATE TABLE IF NOT EXISTS derive_generation (
  generation          TEXT PRIMARY KEY,
  conv_key            TEXT NOT NULL,
  actor               TEXT NOT NULL,
  group_epoch         TEXT NOT NULL,
  input_revision      INTEGER NOT NULL,
  algorithm           INTEGER NOT NULL,
  state               TEXT NOT NULL CHECK(state IN ('building','ready','published','retired','discarded')),
  stage               TEXT NOT NULL CHECK(stage IN ('requests','roles','role_assign','tools','summary','ready','done')),
  created_at          INTEGER NOT NULL,
  sealed_at           INTEGER,
  published_at        INTEGER,
  source_request_count INTEGER NOT NULL DEFAULT 0,
  source_tool_count   INTEGER NOT NULL DEFAULT 0,
  request_count       INTEGER NOT NULL DEFAULT 0,
  tool_count          INTEGER NOT NULL DEFAULT 0,
  cursor_req_id       INTEGER NOT NULL DEFAULT 0,
  role_scan_ord       INTEGER NOT NULL DEFAULT -1,
  role_assign_ord     INTEGER NOT NULL DEFAULT -1,
  role_root_req       INTEGER,
  tool_cursor_ord     INTEGER NOT NULL DEFAULT -1,
  summary_cursor_ord  INTEGER NOT NULL DEFAULT -1,
  ready_cursor_ord    INTEGER NOT NULL DEFAULT -1,
  source_request_sha256 TEXT NOT NULL DEFAULT '',
  source_tool_sha256    TEXT NOT NULL DEFAULT '',
  copied_request_sha256 TEXT NOT NULL DEFAULT '',
  copied_tool_sha256    TEXT NOT NULL DEFAULT '',
  staged_bytes        INTEGER NOT NULL DEFAULT 0,
  CHECK(length(generation) >= 16)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS i_derive_generation_group
  ON derive_generation(conv_key, actor, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS i_derive_generation_published
  ON derive_generation(conv_key, actor) WHERE state='published';

CREATE TABLE IF NOT EXISTS derive_request_result (
  generation         TEXT NOT NULL,
  req_id             INTEGER NOT NULL CHECK(req_id > 0),
  input_epoch        TEXT,
  input_revision     INTEGER,
  sort_source        TEXT,
  sort_key           TEXT,
  started_ms         INTEGER NOT NULL,
  prev_req_id        INTEGER,
  prev_relation      TEXT,
  delta_ordinals     TEXT,
  chain_role         TEXT,
  title              TEXT,
  title_source       TEXT,
  input_preview      TEXT,
  input_preview_kind TEXT,
  reply_preview      TEXT,
  traversal_ord      INTEGER NOT NULL DEFAULT -1,
  purpose_revision   INTEGER NOT NULL,
  purpose_version    INTEGER,
  purpose_chain      TEXT NOT NULL DEFAULT 'participate'
                     CHECK(purpose_chain IN ('participate','exclude')),
  algorithm          INTEGER NOT NULL,
  retention_state    TEXT NOT NULL CHECK(retention_state IN ('recomputed','retained','legacy')),
  basis_json         TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(generation, req_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS i_derive_request_result_req
  ON derive_request_result(req_id);
CREATE INDEX IF NOT EXISTS i_derive_request_result_order
  ON derive_request_result(generation, traversal_ord);

-- Build-only ancestor fingerprints. Deleted on publish/discard; never a long-term copy.
CREATE TABLE IF NOT EXISTS derive_chain_work (
  generation      TEXT NOT NULL,
  req_id          INTEGER NOT NULL,
  traversal_ord   INTEGER NOT NULL,
  fingerprints_json TEXT,
  participating   INTEGER NOT NULL DEFAULT 1,
  byte_length     INTEGER NOT NULL,
  PRIMARY KEY(generation, req_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS i_derive_chain_work_order
  ON derive_chain_work(generation, traversal_ord);

-- Build-only chain scan state. One row per participating request; the ancestor
-- keyset cursor lives here so a crash resumes instead of rescanning from the head.
CREATE TABLE IF NOT EXISTS derive_role_work (
  generation         TEXT NOT NULL,
  req_id             INTEGER NOT NULL,
  traversal_ord      INTEGER NOT NULL,
  started_ms         INTEGER NOT NULL,
  participating      INTEGER NOT NULL,
  parent_req_id      INTEGER,
  relation           TEXT,
  fingerprints_json  TEXT,
  scan_ord           INTEGER NOT NULL DEFAULT -1,
  best_parent_req    INTEGER,
  best_parent_len    INTEGER,
  saw_earlier        INTEGER NOT NULL DEFAULT 0,
  unreadable_earlier INTEGER NOT NULL DEFAULT 0,
  state              TEXT NOT NULL CHECK(state IN ('scanning','done')),
  in_trunk           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(generation, req_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS i_derive_role_work_order
  ON derive_role_work(generation, traversal_ord, req_id);

CREATE TABLE IF NOT EXISTS derive_tool_result (
  generation        TEXT NOT NULL,
  req_id            INTEGER NOT NULL,
  ord               INTEGER NOT NULL,
  call_id           TEXT NOT NULL,
  tool_name         TEXT,
  result_req        INTEGER,
  result_ord        INTEGER,
  result_path       TEXT,
  state             TEXT NOT NULL,
  algorithm_version INTEGER,
  basis_json        TEXT NOT NULL DEFAULT '{}',
  retention_state   TEXT NOT NULL CHECK(retention_state IN ('recomputed','retained','legacy')),
  PRIMARY KEY(generation, req_id, ord)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS i_derive_tool_result_call
  ON derive_tool_result(generation, call_id);

CREATE TABLE IF NOT EXISTS derive_call_work (
  generation    TEXT NOT NULL,
  req_id        INTEGER NOT NULL,
  ord           INTEGER NOT NULL,
  call_id       TEXT NOT NULL,
  tool_name     TEXT,
  request_index INTEGER NOT NULL,
  traversal_ord INTEGER NOT NULL,
  PRIMARY KEY(generation, req_id, ord)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS i_derive_call_work_id
  ON derive_call_work(generation, call_id);

CREATE TABLE IF NOT EXISTS derive_result_work (
  generation    TEXT NOT NULL,
  req_id        INTEGER NOT NULL,
  ord           INTEGER NOT NULL,
  path          TEXT NOT NULL,
  call_id       TEXT NOT NULL,
  preview       TEXT,
  request_index INTEGER NOT NULL,
  traversal_ord INTEGER NOT NULL,
  confirmed     INTEGER NOT NULL,
  PRIMARY KEY(generation, req_id, ord, path)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS i_derive_result_work_id
  ON derive_result_work(generation, call_id);

CREATE VIEW IF NOT EXISTS published_derive_request AS
SELECT q.conv_key AS conv_key, q.actor AS actor,
       q.published_generation AS generation,
       q.legacy_snapshot AS legacy_snapshot,
       d.req_id AS req_id, d.prev_req_id AS prev_req_id,
       d.prev_relation AS prev_relation, d.delta_ordinals AS delta_ordinals,
       d.title AS title, d.title_source AS title_source,
       d.chain_role AS chain_role, d.input_preview AS input_preview,
       d.input_preview_kind AS input_preview_kind,
       d.reply_preview AS reply_preview,
       d.purpose_revision AS consumed_purpose_revision,
       d.purpose_version AS consumed_purpose_version,
       d.algorithm AS algorithm, d.retention_state AS retention_state,
       d.basis_json AS basis_json
FROM derive_queue q
JOIN derive_request_result d ON d.generation = q.published_generation
WHERE q.published_generation IS NOT NULL;

CREATE VIEW IF NOT EXISTS effective_request AS
SELECT r.req_id AS req_id, r.conv_key AS conv_key, r.actor AS actor,
       r.started_ms AS started_ms,
       r.req_kind AS req_kind, r.model_title AS model_title,
       r.purpose_revision AS current_purpose_revision,
       q.state AS group_state, q.legacy_snapshot AS legacy_snapshot,
       d.generation AS generation,
       d.title AS title, d.title_source AS title_source,
       d.chain_role AS chain_role, d.prev_req_id AS prev_req_id,
       d.prev_relation AS prev_relation, d.delta_ordinals AS delta_ordinals,
       d.input_preview AS input_preview,
       d.input_preview_kind AS input_preview_kind,
       d.reply_preview AS reply_preview,
       d.purpose_revision AS consumed_purpose_revision,
       d.purpose_version AS consumed_purpose_version,
       d.algorithm AS algorithm, d.retention_state AS retention_state
FROM request r
LEFT JOIN derive_queue q ON q.conv_key = r.conv_key AND q.actor = r.actor
LEFT JOIN derive_request_result d
  ON d.generation = q.published_generation AND d.req_id = r.req_id;
```

`derive_request_result` 不保存 `req_kind`、`model_title` 或任何指纹列表。`req_kind`/`model_title` 是 D 的用途权威，generation 只记录消费到的 `purpose_revision`/`purpose_version`；查询在同一快照内同时读 `effective_request` 的当前用途和结果代，发布前校验两者修订一致。`published_derive_request` 只按整代连接，不对 `title`、`role` 等逐字段回退到旧 `request` 列；`effective_request` 中 `d.*` 为 NULL 就是没有当前代结果，调用方必须按 `group_state` 屏蔽，而不是 `COALESCE` 拼旧值。

- [ ] **Step 5：实现迁移。** `scripts/migrate-v6.ts` 的复制算法如下。摘要用链式 SHA-256：每批把上一批的十六进制摘要作为种子，再把本批规范化行写入；因此崩溃续跑不会重算已提交批次。源摘要从 `request`/`tool_call` 读，复制摘要从 `derive_request_result`/`derive_tool_result` 读，最后比较的是两条真实读取路径，不是同一个查询自比。

```ts
import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { acquireMaintenanceLock } from '../src/maintenance';

const SCHEMA_V6 = readFileSync(new URL('../src/schema-v6.sql', import.meta.url), 'utf8');
const ZERO_HASH = '0'.repeat(64);
const BATCH_ROWS = 500;

type Row = Record<string, unknown>;
export type MigrateReport = {
  ok: true; groups: number; requests: number; tools: number;
  legacy_generations: number; batches: number;
};
export type MigrateOptions = { now?: number; batchRows?: number };

function scalar(db: Database, sql: string, params: unknown[] = []): number {
  const row = db.query(sql).get(...params) as Record<string, unknown> | null;
  return row === null ? 0 : Number(Object.values(row)[0]);
}
function hasTable(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== null;
}
function columns(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name);
}
function assertMigratable(db: Database): void {
  const version = scalar(db, 'PRAGMA user_version');
  if (version === 6) {
    const marker = readV6Marker(db);
    if (marker?.complete === true) throw new Error('schema_already_v6');
    if (marker === null) throw new Error('schema_v6_incomplete');
    return; // incomplete v6：从持久游标续跑。
  }
  if (version !== 5) throw new Error('schema_v5_required');
  if (!hasTable(db, 'collector_state')) throw new Error('schema_v5_collector_state_missing');
  for (const name of ['group_epoch', 'input_revision', 'published_revision',
    'target_algorithm', 'state', 'dirty_since_ms']) {
    if (!columns(db, 'derive_queue').includes(name)) throw new Error(`schema_v5_queue_${name}_missing`);
  }
  for (const name of ['input_epoch', 'input_revision', 'summary_algorithm', 'summary_state',
    'purpose_revision', 'purpose_version']) {
    if (!columns(db, 'request').includes(name)) throw new Error(`schema_v5_request_${name}_missing`);
  }
  for (const name of ['algorithm_version', 'basis_json', 'retention_state']) {
    if (!columns(db, 'tool_call').includes(name)) throw new Error(`schema_v5_tool_${name}_missing`);
  }
}

// 规范化顺序固定，源行与结果行必须使用同一函数。
function reqCanon(row: Row): string {
  return JSON.stringify([row.req_id, row.input_epoch, row.input_revision,
    row.sort_source, row.sort_key, row.started_ms, row.prev_req_id, row.prev_relation,
    row.delta_ordinals, row.chain_role, row.title, row.title_source,
    row.input_preview, row.input_preview_kind, row.reply_preview,
    row.purpose_revision, row.purpose_version, row.purpose_chain]);
}
function toolCanon(row: Row): string {
  return JSON.stringify([row.req_id, row.ord, row.call_id, row.tool_name,
    row.result_req, row.result_ord, row.result_path, row.state,
    row.algorithm_version, row.retention_state]);
}
function chainHash(previous: string, rows: readonly Row[], canon: (row: Row) => string): string {
  const hash = createHash('sha256');
  hash.update(previous === '' ? ZERO_HASH : previous);
  for (const row of rows) hash.update(canon(row)).update('\n');
  return hash.digest('hex');
}

type V6Marker = {
  format: 1; target: 6; phase: 'ddl'|'copy'|'complete'; cursor: null;
  scope: 'all'; complete: boolean; report: Record<string, number>;
};
function readV6Marker(db: Database): V6Marker | null {
  const row = db.query("SELECT value_json FROM collector_state WHERE key='migration:v6'")
    .get() as { value_json: string } | null;
  if (row === null) return null;
  const value = JSON.parse(row.value_json) as V6Marker;
  if (value.format !== 1 || value.target !== 6 || typeof value.complete !== 'boolean') {
    throw new Error('migration_v6_marker_invalid');
  }
  return value;
}
function phaseOne(db: Database, now: number): void {
  const marker = readV6Marker(db);
  if (marker?.complete === true) throw new Error('schema_already_v6');
  if (marker !== null) return; // 上次已在复制阶段中断，DDL 已提交。
  db.transaction(() => {
    db.exec(SCHEMA_V6);
    const pending: V6Marker = { format: 1, target: 6, phase: 'copy', cursor: null,
      scope: 'all', complete: false, report: { groups: 0, requests: 0, tools: 0 } };
    db.run("INSERT INTO collector_state(key,value_json) VALUES ('migration:v6',?)",
      [JSON.stringify(pending)]);
    db.exec('PRAGMA user_version=6');
  }).immediate();
}

function groupGeneration(db: Database, group: {
  conv_key: string; actor: string; group_epoch: string; input_revision: number;
}, now: number): string {
  const existing = db.query<{ generation: string }, [string, string]>(`
    SELECT generation FROM derive_generation
    WHERE conv_key=? AND actor=? AND state='building'
    ORDER BY created_at DESC LIMIT 1`).get(group.conv_key, group.actor);
  if (existing !== null) return existing.generation;
  const generation = `legacy-${randomUUID().replaceAll('-', '')}`;
  const sourceRequests = scalar(db, `SELECT COUNT(*) FROM request
    WHERE conv_key=? AND actor=?`, [group.conv_key, group.actor]);
  const sourceTools = scalar(db, `SELECT COUNT(*) FROM tool_call t
    JOIN request r ON r.req_id=t.req_id WHERE r.conv_key=? AND r.actor=?`,
    [group.conv_key, group.actor]);
  db.transaction(() => {
    db.run(`INSERT INTO derive_generation(
      generation,conv_key,actor,group_epoch,input_revision,algorithm,state,stage,
      created_at,source_request_count,source_tool_count,request_count,tool_count,
      cursor_req_id,source_request_sha256,source_tool_sha256,
      copied_request_sha256,copied_tool_sha256,staged_bytes)
      VALUES (?,?,?,?,?,-1,'building','requests',?,?,?,0,0,0,?,?,?,?,0)`,
      [generation, group.conv_key, group.actor, group.group_epoch, group.input_revision,
        now, sourceRequests, sourceTools, ZERO_HASH, ZERO_HASH, ZERO_HASH, ZERO_HASH]);
    db.run(`UPDATE derive_queue SET compute_generation=?,compute_started_ms=?,
      last_claimed_ms=?,attempts=attempts+1,last_error='migrating_v6'
      WHERE conv_key=? AND actor=?`, [generation, now, now, group.conv_key, group.actor]);
  }).immediate();
  return generation;
}

function copyGroup(db: Database, group: { conv_key: string; actor: string },
  generation: string, batchRows: number, now: number): { requests: number; tools: number; batches: number } {
  const state = db.query(`SELECT source_request_count,source_tool_count,cursor_req_id
    FROM derive_generation WHERE generation=?`).get(generation) as {
      source_request_count: number; source_tool_count: number; cursor_req_id: number;
    };
  const sourceRequests = scalar(db, 'SELECT COUNT(*) FROM request WHERE conv_key=? AND actor=?',
    [group.conv_key, group.actor]);
  const sourceTools = scalar(db, `SELECT COUNT(*) FROM tool_call t
    JOIN request r ON r.req_id=t.req_id WHERE r.conv_key=? AND r.actor=?`,
    [group.conv_key, group.actor]);
  if (sourceRequests !== state.source_request_count || sourceTools !== state.source_tool_count) {
    throw new Error('schema_v6_source_changed');
  }

  let cursor = state.cursor_req_id;
  let requests = 0;
  let tools = 0;
  let batches = 0;
  for (;;) {
    const rows = db.query<Row, [string, string, number, number]>(`
      SELECT req_id,input_epoch,input_revision,sort_source,sort_key,started_ms,
        prev_req_id,prev_relation,delta_ordinals,chain_role,title,title_source,
        input_preview,input_preview_kind,reply_preview,purpose_revision,purpose_version,
        purpose_chain,summary_algorithm,summary_state,summary_basis
      FROM request WHERE conv_key=? AND actor=? AND req_id>?
      ORDER BY req_id LIMIT ?`)
      .all(group.conv_key, group.actor, cursor, batchRows);
    if (rows.length === 0) break;
    const ids = rows.map(row => Number(row.req_id));
    const placeholders = ids.map(() => '?').join(',');
    const sourceToolRows = db.query<Row, unknown[]>(`
      SELECT req_id,ord,call_id,tool_name,result_req,result_ord,result_path,state,
        algorithm_version,retention_state
      FROM tool_call WHERE req_id IN (${placeholders}) ORDER BY req_id,ord`).all(...ids);

    try {
      db.transaction(() => {
        db.run(`INSERT INTO derive_request_result(
          generation,req_id,input_epoch,input_revision,sort_source,sort_key,started_ms,
          prev_req_id,prev_relation,delta_ordinals,chain_role,title,title_source,
          input_preview,input_preview_kind,reply_preview,purpose_revision,purpose_version,
          purpose_chain,algorithm,retention_state,basis_json)
          SELECT ?,req_id,input_epoch,input_revision,sort_source,sort_key,started_ms,
            prev_req_id,prev_relation,delta_ordinals,chain_role,title,title_source,
            input_preview,input_preview_kind,reply_preview,purpose_revision,purpose_version,
            COALESCE(purpose_chain,'participate'),
            COALESCE(summary_algorithm,-1),
            CASE WHEN summary_state IN ('recomputed','retained','legacy')
              THEN summary_state ELSE 'legacy' END,
            json_object('source','v5-legacy','summary_basis',summary_basis,
              'summary_algorithm',summary_algorithm,'summary_state',summary_state,
              'input_epoch',input_epoch,'input_revision',input_revision)
          FROM request WHERE req_id IN (${placeholders})`, [generation, ...ids]);
        const inserted = db.run(`INSERT INTO derive_tool_result(
          generation,req_id,ord,call_id,tool_name,result_req,result_ord,result_path,
          state,algorithm_version,basis_json,retention_state)
          SELECT ?,req_id,ord,call_id,tool_name,result_req,result_ord,result_path,
            state,algorithm_version,
            json_object('source','v5-legacy','tool_basis',basis_json,
              'algorithm_version',algorithm_version,'retention_state',retention_state),
            CASE WHEN retention_state IN ('recomputed','retained','legacy')
              THEN retention_state ELSE 'legacy' END
          FROM tool_call WHERE req_id IN (${placeholders})`, [generation, ...ids]).changes;

        const copiedRequests = db.query<Row, [string, ...number[]]>(`
          SELECT req_id,input_epoch,input_revision,sort_source,sort_key,started_ms,
            prev_req_id,prev_relation,delta_ordinals,chain_role,title,title_source,
            input_preview,input_preview_kind,reply_preview,purpose_revision,purpose_version,
            purpose_chain
          FROM derive_request_result WHERE generation=? AND req_id IN (${placeholders})
          ORDER BY req_id`).all(generation, ...ids);
        const copiedTools = db.query<Row, [string, ...number[]]>(`
          SELECT req_id,ord,call_id,tool_name,result_req,result_ord,result_path,state,
            algorithm_version,retention_state
          FROM derive_tool_result WHERE generation=? AND req_id IN (${placeholders})
          ORDER BY req_id,ord`).all(generation, ...ids);

        const sourceRequestHash = chainHash(String((db.query(
          'SELECT source_request_sha256 FROM derive_generation WHERE generation=?')
          .get(generation) as any).source_request_sha256), rows, reqCanon);
        const copiedRequestHash = chainHash(String((db.query(
          'SELECT copied_request_sha256 FROM derive_generation WHERE generation=?')
          .get(generation) as any).copied_request_sha256), copiedRequests, reqCanon);
        const sourceToolHash = chainHash(String((db.query(
          'SELECT source_tool_sha256 FROM derive_generation WHERE generation=?')
          .get(generation) as any).source_tool_sha256), sourceToolRows, toolCanon);
        const copiedToolHash = chainHash(String((db.query(
          'SELECT copied_tool_sha256 FROM derive_generation WHERE generation=?')
          .get(generation) as any).copied_tool_sha256), copiedTools, toolCanon);
        const last = ids[ids.length - 1]!;
        db.run(`UPDATE derive_generation SET
          cursor_req_id=?,request_count=request_count+?,tool_count=tool_count+?,
          source_request_sha256=?,copied_request_sha256=?,
          source_tool_sha256=?,copied_tool_sha256=?,
          staged_bytes=staged_bytes+?
          WHERE generation=?`,
          [last, rows.length, inserted, sourceRequestHash, copiedRequestHash,
            sourceToolHash, copiedToolHash,
            rows.length * 512 + sourceToolRows.length * 256, generation]);
      }).immediate();
    } catch (error) {
      const code = error instanceof Error ? error.message : 'unknown';
      throw new Error(`schema_v6_copy_failed:${code}`);
    }
    cursor = ids[ids.length - 1]!;
    requests += rows.length;
    tools += insertedCount(db, generation, ids);
    batches += 1;
  }

  const done = db.query('SELECT * FROM derive_generation WHERE generation=?').get(generation) as any;
  if (done.request_count !== done.source_request_count ||
      done.tool_count !== done.source_tool_count ||
      done.source_request_sha256 !== done.copied_request_sha256 ||
      done.source_tool_sha256 !== done.copied_tool_sha256) {
    throw new Error('schema_v6_copy_verify_failed');
  }
  db.run(`UPDATE derive_generation SET state='ready',stage='done',sealed_at=?
    WHERE generation=?`, [now, generation]);
  return { requests, tools: done.tool_count, batches };
}

function insertedCount(db: Database, generation: string, ids: number[]): number {
  const placeholders = ids.map(() => '?').join(',');
  return scalar(db, `SELECT COUNT(*) FROM derive_tool_result
    WHERE generation=? AND req_id IN (${placeholders})`, [generation, ...ids]);
}

export function migrateV6(db: Database, options: MigrateOptions = {}): MigrateReport {
  const now = options.now ?? Date.now();
  const batchRows = options.batchRows ?? BATCH_ROWS;
  if (!Number.isSafeInteger(batchRows) || batchRows <= 0) throw new Error('invalid_batch_rows');
  assertMigratable(db);
  phaseOne(db, now);

  const groups = db.query<{
    conv_key: string; actor: string; group_epoch: string; input_revision: number;
  }, []>(`SELECT conv_key,actor,group_epoch,input_revision
    FROM derive_queue ORDER BY dirty_since_ms,conv_key,actor`).all();
  let requests = 0;
  let tools = 0;
  let batches = 0;
  for (const group of groups) {
    const generation = groupGeneration(db, group, now);
    const copied = copyGroup(db, group, generation, batchRows, now);
    requests += copied.requests;
    tools += copied.tools;
    batches += copied.batches;
  }

  const unfinished = db.query(`SELECT 1 FROM derive_generation WHERE state<>'ready' LIMIT 1`).get();
  if (unfinished !== null) throw new Error('schema_v6_generation_unfinished');

  db.transaction(() => {
    db.run(`UPDATE derive_queue SET
      published_generation=(SELECT g.generation FROM derive_generation g
        WHERE g.conv_key=derive_queue.conv_key AND g.actor=derive_queue.actor
          AND g.state='ready' ORDER BY g.created_at DESC LIMIT 1),
      published_algorithm=-1,legacy_snapshot=1,compute_generation=NULL,
      compute_started_ms=NULL,last_completed_ms=?,last_error='migrated_v6',
      dirty_since_ms=CASE WHEN state='clean' THEN NULL ELSE dirty_since_ms END
      WHERE EXISTS (SELECT 1 FROM derive_generation g
        WHERE g.conv_key=derive_queue.conv_key AND g.actor=derive_queue.actor
          AND g.state='ready')`, [now]);
    db.run(`UPDATE derive_generation SET state='published',published_at=?
      WHERE state='ready'`, [now]);
    const complete: V6Marker = { format: 1, target: 6, phase: 'complete', cursor: null,
      scope: 'all', complete: true, report: {
        groups: groups.length, requests, tools, batches } };
    db.run("UPDATE collector_state SET value_json=? WHERE key='migration:v6'",
      [JSON.stringify(complete)]);
    db.exec('PRAGMA user_version=6');
  }).immediate();

  return { ok: true, groups: groups.length, requests, tools,
    legacy_generations: groups.length, batches };
}
```

`copyGroup` 的失败语义：插入、工具复制、游标、计数、摘要与暂存字节在同一 `IMMEDIATE` 事务内，任何一步失败整批回滚；已提交批次保留。`cursor_req_id` 只前进到已提交批次，重跑从它继续。组开始时重新数源行数，若源在迁移期间变化则 `schema_v6_source_changed`，不继续拼一个混合快照。

- [ ] **Step 6：实现 CLI 与维护锁。** 默认只预览，`--apply` 才复制。先取维护锁并确认没有采集器，再做 `PRAGMA quick_check`，然后调用 `migrateV6`。CLI 打开数据库必须走 C 导出的 `withStoppedDatabase(dbPath, fn)`，盐绑定读取走 C 导出的 `loadBoundSaltTx(db, dataDir)`；不自行 `new Database` 或重新读取盐文件。`withStoppedDatabase` 的排他复制与 finally 关闭是迁移期间「没有采集器」的唯一依据，`migrateV6` 本身只接受调用方传入的 Database。

```ts
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!, process.argv[i + 1] ?? '');
const dbPath = args.get('--db');
if (dbPath === undefined) throw new Error('migrate_v6_db_required');
const lock = acquireMaintenanceLock(dbPath);
try {
  const db = new Database(dbPath);
  try {
    const check = db.query('PRAGMA quick_check').get() as Record<string, string>;
    if (Object.values(check)[0] !== 'ok') throw new Error('migrate_v6_quick_check_failed');
    const preview = {
      groups: Number((db.query('SELECT COUNT(*) AS n FROM derive_queue').get() as any).n),
      requests: Number((db.query('SELECT COUNT(*) AS n FROM request').get() as any).n),
      tools: Number((db.query('SELECT COUNT(*) AS n FROM tool_call').get() as any).n),
    };
    if (!process.argv.includes('--apply')) {
      process.stdout.write(JSON.stringify({ ok: true, preview }) + '\n');
    } else {
      const report = migrateV6(db, { now: Date.now() });
      process.stdout.write(JSON.stringify(report) + '\n');
    }
  } finally { db.close(); }
} catch (error) {
  process.stderr.write(`migrate_v6_failed:${error instanceof Error ? error.message : 'unknown'}\n`);
  process.exitCode = 1;
} finally { lock.release(); }
```

Run:

```sh
bun scripts/migrate-v6.ts --db /private/tmp/atc-capacity-reports/v5.db
bun scripts/migrate-v6.ts --db /private/tmp/atc-capacity-reports/v5.db --apply
```

- [ ] **Step 7：修改 `store.ts` 版本门。** 全新库在同一事务写 v5 schema、v6 DDL、complete marker 和 `user_version=6`；v5 库拒绝普通启动；v6 库要求 marker complete 与关键对象齐全。这里不按列是否存在推断版本。

```ts
const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const SCHEMA_V6 = readFileSync(new URL('./schema-v6.sql', import.meta.url), 'utf8');
const SCHEMA_VERSION = 6;

function tableNames(db: Database): string[] {
  return (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[]).map(row => row.name);
}
function objectSql(db: Database, type: 'table' | 'view', name: string): string | null {
  const row = db.query("SELECT sql FROM sqlite_master WHERE type=? AND name=?")
    .get(type, name) as { sql: string } | null;
  return row?.sql ?? null;
}
function assertV6Complete(db: Database): void {
  const v5 = db.query("SELECT value_json FROM collector_state WHERE key='migration:v5'")
    .get() as { value_json: string } | null;
  if (v5 === null || JSON.parse(v5.value_json).complete !== true) {
    throw new Error('schema_v5_incomplete');
  }
  const marker = db.query("SELECT value_json FROM collector_state WHERE key='migration:v6'")
    .get() as { value_json: string } | null;
  if (marker === null || JSON.parse(marker.value_json).complete !== true) {
    throw new Error('schema_v6_incomplete');
  }
  const queueColumns = (db.query('PRAGMA table_info(derive_queue)').all() as { name: string }[])
    .map(row => row.name);
  for (const name of ['compute_generation', 'published_generation', 'legacy_snapshot',
    'last_claimed_ms', 'attempts', 'last_error']) {
    if (!queueColumns.includes(name)) throw new Error('schema_v6_incomplete');
  }
  for (const view of ['published_derive_request', 'effective_request']) {
    if (objectSql(db, 'view', view) === null) throw new Error('schema_v6_incomplete');
  }
  for (const table of ['derive_generation', 'derive_request_result', 'derive_tool_result',
    'derive_call_work', 'derive_result_work', 'derive_chain_work', 'derive_role_work']) {
    if (objectSql(db, 'table', table) === null) throw new Error('schema_v6_incomplete');
  }
}

function migrate(db: Database): void {
  const version = pragmaNumber(db, 'user_version');
  const tables = tableNames(db);
  if (version === 0 && tables.length === 0) {
    db.exec('PRAGMA auto_vacuum=INCREMENTAL');
    db.exec('PRAGMA journal_mode=WAL');
    db.transaction(() => {
      db.exec(SCHEMA);
      db.exec(SCHEMA_V6);
      const newDb = { format: 1, target: 5, phase: 'complete', cursor: null,
        scope: 'all', complete: true, report: {} };
      db.run("INSERT INTO collector_state(key,value_json) VALUES ('migration:v5',?)",
        [JSON.stringify(newDb)]);
      db.run("INSERT INTO collector_state(key,value_json) VALUES ('migration:v6',?)",
        [JSON.stringify({ ...newDb, target: 6 })]);
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    }).immediate();
    return;
  }
  if (version === 0) throw new Error('schema_unknown');
  if (version === 5) throw new Error('schema_migration_required');
  if (version < 5) throw new Error('schema_rebuild_required');
  if (version > SCHEMA_VERSION) throw new Error('schema_version_unsupported');
  assertV6Complete(db);
  if (pragmaNumber(db, 'auto_vacuum') !== 2) throw new Error('auto_vacuum_requires_migration');
}
```

- [ ] **Step 8：运行迁移测试与类型检查。** Run: `bun test tests/migrate-v6.test.ts tests/store.test.ts`。Expected: PASS。Run: `bun run typecheck`。Expected: PASS。重点确认失败用例中 `user_version=6`、marker incomplete、队列没有发布指针、普通 `openStore` 抛 `schema_v6_incomplete`，且修复后从 `cursor_req_id` 继续而不是从头重扫。

- [ ] **Step 9：提交。** 获授权后：

```bash
git add src/schema-v6.sql scripts/migrate-v6.ts tests/fixtures/schema-v5.sql \
  tests/migrate-v6.test.ts src/store.ts \
  .agents/notes/implemented/architecture/2026-10-22-atc-schema-v6-generations.md
git commit -m "feat(schema): add v6 derive generations with resumable v5 migration" \
  -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```


### Task 13b：bundle 白名单只含当前版本

**执行前提变更（用户决定，2026-10-23）。** 迁移取消之后，v5 的包搬回来也打不开（`openStore` 报 `schema_rebuild_required`），所以白名单不扩到 `[5, 6]`，而是从 `[5]` 改成只含当前版本 `[6]`。恢复侧的迁移标记校验与 `allowIncompleteMigration` 选项不实现 —— 那两样是给半迁移库用的，而半迁移库现在不存在。因此 Step 3 的实现是 `src/maintenance.ts` 里一处常量改值；Step 1 的用例收为一条：v6 库备份写出 `schema: 6` 并可恢复，白名单外版本在备份与恢复两侧都被拒。原先设计的「未完成 v6 只允许显式迁移恢复」「manifest 与包内版本不一致」两条用例随之取消。

**Files：**
- Modify: `src/maintenance.ts`（一处常量）
- Modify: `tests/maintenance.test.ts`（一条用例）

**原计划的 Files（不执行）：** `.agents/notes/implemented/feature/2026-10-22-atc-bundle-schema-v6.md`（该决策并入 Task 13 的 note）。

**Interfaces:**
- Consumes: `RESTORABLE_SCHEMA_VERSIONS`、`backupBundle(sourceDir, destinationDir)`、`restoreBundle(bundleDir, destinationDir)` 及其 manifest 与包内 `PRAGMA user_version`、`withStoppedDatabase(source, fn)`。
- Produces: `RESTORABLE_SCHEMA_VERSIONS` 取值 `[6]`。

**实现偏差（已按代码校正）。** 原计划假设恢复侧已经读 `migration:v{version}` marker 并支持 `allowIncompleteMigration`。实际代码里没有这两样（仓库里也没有 `restore_migration_incomplete` 这个码）：`restoreBundle` 只查白名单、包内 `user_version` 与清单哈希。既然迁移取消，这两样也不补 —— 它们的唯一用途是为半迁移库开口子，而现在不存在这种库。

bundle 版本判断本来就只有一处常量：`export const RESTORABLE_SCHEMA_VERSIONS: readonly number[] = [5];`，备份与恢复都只查这一处。备份读源库 `PRAGMA user_version`，不在白名单内抛 `backup_schema_unsupported`，并把该实际值写进 manifest 的 `schema`；恢复依次查白名单、包内 `user_version === manifest.schema`、清单哈希与盐标识，任一项不符都是 `restore_bundle_invalid`。这次只把该常量改成 `[6]`：「私有父目录 + `mkdirSync` 原子预留 + `rename` 替换本进程刚建的空目录」协议、salt 绑定与独占读取全部保持不变。

- [ ] **Step 1：写失败测试。** 覆盖两件事：v6 库备份写实际版本（`schema: 6`）且可恢复；白名单外版本在备份与恢复两侧都被拒。断言只使用既有错误码。

```ts
import { Database } from 'bun:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backupBundle, restoreBundle } from '../src/maintenance';
import { openStore } from '../src/store';

test('v6库备份写实际版本，白名单外的版本两侧都拒', () => {
  const f = fixture();
  try {
    loadBoundSalt(f.store, f.dir);
    f.store.close();
    const bundle = join(f.dir, 'bundle-v6');
    backupBundle(f.dir, bundle);
    const manifestPath = join(bundle, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    expect(manifest.schema).toBe(6);
    const restored = join(f.dir, 'restored-v6');
    restoreBundle(bundle, restored);
    const store = openStore(join(restored, 'trace.db'));
    try {
      expect(store.read.query('PRAGMA user_version').get()).toEqual({ user_version: 6 });
    } finally { store.close(); }

    // 白名单只有当前版本：低版本没有升级路径，搬回来也打不开。
    const db = new Database(join(f.dir, 'trace.db'));
    db.run('PRAGMA user_version=5');
    db.close();
    expect(() => backupBundle(f.dir, join(f.dir, 'bundle-v5')))
      .toThrow('backup_schema_unsupported');

    const db6 = new Database(join(f.dir, 'trace.db'));
    db6.run('PRAGMA user_version=6');
    db6.close();
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, schema: 5 }));
    expect(() => restoreBundle(bundle, join(f.dir, 'bad-version')))
      .toThrow('restore_bundle_invalid');
  } finally { f.close(); }
});
```

- [ ] **Step 2：验证失败。** Run: `bun test tests/maintenance.test.ts -t 'v6库备份'`。Expected: FAIL，白名单仍是 `[5]`，备份 v6 库抛 `backup_schema_unsupported`。

- [ ] **Step 3：白名单只留当前版本。** 白名单是唯一版本位点，这次只改它的取值，版本判断、备份写入、恢复校验、目录发布与 salt 校验全部不动：

```ts
// src/maintenance.ts（唯一版本位点；除下面的数组内容外不改本文件其它行）
export const RESTORABLE_SCHEMA_VERSIONS: readonly number[] = [6];
```

不新增 `bundleSchema`、`requireMigrationMarker` 之类的第二份规则，也不新增恢复错误码：备份侧白名单外是 `backup_schema_unsupported`；恢复侧的清单不支持版本、包内版本与清单不一致、哈希或盐标识不符都是 `restore_bundle_invalid`。

- [ ] **Step 4：运行。** Run: `bun test tests/maintenance.test.ts tests/secrets.test.ts tests/store.test.ts`。Expected: PASS，v5 时代的 bundle 用例（完整库的备份与恢复）继续通过且不再有半迁移包用例。确认 v6 库的清单写的是 `schema: 6`，且换成 v5 的清单会被拒。

- [ ] **Step 5：提交。** 与 Task 13 同一提交落地（两者是一件事：v6 结构上线且旧库重建）：

```bash
git add src/maintenance.ts tests/maintenance.test.ts
```

### Task 14：代际生命周期、发布指针与同快照读取

**Files:**
- Create: `src/derive-slice.ts`
- Modify: `src/derive.ts`（只导出既有纯 helper，不改 A 的同步结果）
- Modify: `src/queries.ts`
- Modify: `src/store.ts`（`Store.deriveBudget?`，仅分支 B）
- Test: `tests/derive-slice.test.ts`
- Agent Note: `.agents/notes/implemented/feature/2026-10-22-atc-generation-publish-pointer.md`

**Interfaces:**
- Consumes: Task 13 的 `derive_generation`、`derive_request_result`、`derive_tool_result`、`derive_*_work`、`derive_queue.published_generation`。
- Produces: `DERIVE_ALGORITHM`、`DeriveBudget`、`beginGeneration`、`discardGeneration`、`publishGeneration`、`recoverSlice`、`readEffectiveGroup`、`sliceGroupStep`。

```ts
export const DERIVE_ALGORITHM = 5;
export type DeriveBudget = {
  maxRequestMs: number;
  maxStageBatchMs: number;
  maxCandidatesPerBatch: number;
  maxWritesPerBatch: number;
  maxStagedBytes: number;
  maxWalGrowthBytes: number;
  maxRetiredGenerations: number;
};
export const DEFAULT_DERIVE_BUDGET: DeriveBudget = {
  maxRequestMs: 10,
  maxStageBatchMs: 250,
  maxCandidatesPerBatch: 100,
  maxWritesPerBatch: 500,
  maxStagedBytes: 64 * 1024 * 1024,
  maxWalGrowthBytes: 32 * 1024 * 1024,
  maxRetiredGenerations: 2,
};
export type SliceStep = {
  status: 'idle' | 'advanced' | 'published' | 'discarded' | 'rotated';
  generation: string | null; stage: string | null; rows: number; batch_ms: number;
};
```

- [ ] **Step 1：写生命周期测试。** 覆盖发布指针原子切换、旧代结果保留、修订过期拒绝、重开丢弃未发布、同快照屏蔽与「不逐字段回退」。

```ts
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { fixture } from './fixtures';
import { drainDeriveTx } from '../src/derive';
import {
  DEFAULT_DERIVE_BUDGET, beginGeneration, discardGeneration, publishGeneration,
  readEffectiveGroup, recoverSlice, sliceGroupStep, sliceReadyStage, sliceRequestsStage,
  sliceRolesStage, sliceSummaryStage, sliceToolsStage,
} from '../src/derive-slice';

function seedGroup(f: ReturnType<typeof fixture>) {
  f.store.write(db => {
    db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
      body_state,derive_version,have,created_at,updated_at,title,title_source,
      input_epoch,input_revision,purpose_revision,purpose_version,req_kind,model_title)
      VALUES (1,'c','a','known',100,'2026-10-22','hook','available',0,1,1,1,
        'old title','model_time','e1',7,11,3,'chat','model title')`);
    db.run(`INSERT INTO derive_queue(conv_key,actor,from_sort,group_epoch,input_revision,
      published_revision,target_algorithm,published_algorithm,state,dirty_since_ms)
      VALUES ('c','a','','g1',7,7,5,5,'dirty',50)`);
  });
}

function seedResult(f: ReturnType<typeof fixture>, generation: string, title: string | null) {
  f.store.write(db => db.run(`INSERT INTO derive_request_result(
    generation,req_id,input_epoch,input_revision,sort_source,sort_key,started_ms,
    title,title_source,traversal_ord,purpose_revision,purpose_version,algorithm,
    retention_state,basis_json)
    VALUES (?,1,'e1',7,NULL,NULL,100,?,'model_time',0,11,3,5,'recomputed','{}')`,
    [generation, title]));
}

test('发布指针原子切换并保留旧代结果', () => {
  const f = fixture();
  try {
    seedGroup(f);
    const first = beginGeneration(f.store, 'c', 'a', 1000)!;
    expect(first).toStartWith('gen-');
    seedResult(f, first, 'first title');
    f.store.write(db => db.run(`UPDATE derive_generation SET state='ready',stage='done',
      request_count=1 WHERE generation=?`, [first]));
    expect(publishGeneration(f.store.db, first, 1100)).toBe(true);
    let queue = f.store.read.query('SELECT * FROM derive_queue').get() as any;
    expect(queue).toMatchObject({ state: 'clean', published_generation: first,
      published_revision: 7, published_algorithm: 5, legacy_snapshot: 0 });
    expect(queue.compute_generation).toBeNull();

    f.store.write(db => db.run(`UPDATE derive_queue SET state='dirty',
      input_revision=8,dirty_since_ms=1200 WHERE conv_key='c' AND actor='a'`));
    const second = beginGeneration(f.store, 'c', 'a', 1300)!;
    seedResult(f, second, 'second title');
    f.store.write(db => db.run(`UPDATE derive_generation SET state='ready',stage='done',
      request_count=1 WHERE generation=?`, [second]));
    expect(publishGeneration(f.store.db, second, 1400)).toBe(true);
    queue = f.store.read.query('SELECT * FROM derive_queue').get() as any;
    expect(queue.published_generation).toBe(second);
    expect(f.store.read.query('SELECT state FROM derive_generation WHERE generation=?')
      .get(first)).toEqual({ state: 'retired' });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM derive_request_result WHERE generation=?')
      .get(first)).toEqual({ n: 1 });
  } finally { f.close(); }
});

test('修订变化使旧代失去发布资格并丢弃结果', () => {
  const f = fixture();
  try {
    seedGroup(f);
    const generation = beginGeneration(f.store, 'c', 'a', 1000)!;
    seedResult(f, generation, 'stale title');
    f.store.write(db => db.run(`UPDATE derive_generation SET state='ready',stage='done',
      request_count=1 WHERE generation=?`, [generation]));
    f.store.write(db => db.run(`UPDATE derive_queue SET input_revision=8 WHERE conv_key='c' AND actor='a'`));
    expect(publishGeneration(f.store.db, generation, 1100)).toBe(false);
    expect(f.store.read.query('SELECT state FROM derive_generation WHERE generation=?')
      .get(generation)).toEqual({ state: 'discarded' });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM derive_request_result WHERE generation=?')
      .get(generation)).toEqual({ n: 0 });
    expect((f.store.read.query('SELECT * FROM derive_queue').get() as any).published_generation).toBeNull();
  } finally { f.close(); }
});

test('重开丢弃未发布代际，不碰上一代已发布结果', () => {
  const f = fixture();
  try {
    seedGroup(f);
    const published = beginGeneration(f.store, 'c', 'a', 1000)!;
    seedResult(f, published, 'published title');
    f.store.write(db => db.run(`UPDATE derive_generation SET state='ready',stage='done',
      request_count=1 WHERE generation=?`, [published]));
    publishGeneration(f.store.db, published, 1100);
    f.store.write(db => db.run(`UPDATE derive_queue SET state='dirty',input_revision=8,
      dirty_since_ms=1200 WHERE conv_key='c' AND actor='a'`));
    const building = beginGeneration(f.store, 'c', 'a', 1300)!;
    seedResult(f, building, 'unpublished');
    expect(recoverSlice(f.store.db, 1400)).toBe(1);
    const queue = f.store.read.query('SELECT * FROM derive_queue').get() as any;
    expect(queue.state).toBe('dirty');
    expect(queue.compute_generation).toBeNull();
    expect(queue.published_generation).toBe(published);
    expect(f.store.read.query('SELECT state FROM derive_generation WHERE generation=?')
      .get(building)).toEqual({ state: 'discarded' });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM derive_request_result WHERE generation=?')
      .get(published)).toEqual({ n: 1 });
  } finally { f.close(); }
});

test('同快照读取按组状态屏蔽且不回退旧请求列', () => {
  const f = fixture();
  try {
    seedGroup(f);
    const generation = beginGeneration(f.store, 'c', 'a', 1000)!;
    seedResult(f, generation, null);
    f.store.write(db => db.run(`UPDATE derive_generation SET state='ready',stage='done',
      request_count=1 WHERE generation=?`, [generation]));
    publishGeneration(f.store.db, generation, 1100);
    f.store.write(db => db.run(`UPDATE derive_queue SET state='dirty',input_revision=8,
      dirty_since_ms=1200 WHERE conv_key='c' AND actor='a'`));
    const masked = readEffectiveGroup(f.store.read, 'c', 'a');
    expect(masked.state).toBe('masked');
    expect(masked.rows).toEqual([]);

    f.store.write(db => db.run(`UPDATE derive_queue SET state='clean',input_revision=7,
      published_revision=7 WHERE conv_key='c' AND actor='a'`));
    const current = readEffectiveGroup(f.store.read, 'c', 'a');
    expect(current.state).toBe('current');
    expect(current.rows[0]).toMatchObject({
      generation, req_kind: 'chat', model_title: 'model title', title: null,
    });
    // request.title 仍是 'old title'；结果 title 为 NULL 时必须保持 NULL。
    expect(current.rows[0]!.title).toBeNull();
  } finally { f.close(); }
});
```

- [ ] **Step 2：验证失败。** Run: `bun test tests/derive-slice.test.ts`。Expected: FAIL，模块与导出不存在。

- [ ] **Step 3：实现代际与指针。** 所有状态变更使用 `IMMEDIATE` 事务。`beginGeneration` 只认领一个组；`publishGeneration` 在同一事务内校验组键、修订、逐请求用途修订和结果覆盖，再切换指针；`discardGeneration` 只删除未发布代的结果与工作行，已发布代先转 `retired`。

```ts
import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { Store } from './store';

function one<T>(db: Database, sql: string, params: unknown[] = []): T | null {
  return db.query(sql).get(...params) as T | null;
}
function n(db: Database, sql: string, params: unknown[] = []): number {
  const row = one<Record<string, unknown>>(db, sql, params);
  return row === null ? 0 : Number(Object.values(row)[0]);
}

export function beginGeneration(store: Store, convKey: string, actor: string, now: number): string | null {
  return store.write(db => {
    const queue = one<{ state: string; input_revision: number; group_epoch: string;
      target_algorithm: number; compute_generation: string | null }>(db,
      `SELECT state,input_revision,group_epoch,target_algorithm,compute_generation
       FROM derive_queue WHERE conv_key=? AND actor=?`, [convKey, actor]);
    if (queue === null || queue.state === 'clean' || queue.compute_generation !== null) return null;
    if (queue.target_algorithm !== DERIVE_ALGORITHM) throw new Error('derive_algorithm_mismatch');
    const generation = `gen-${randomUUID().replaceAll('-', '')}`;
    db.run(`INSERT INTO derive_generation(generation,conv_key,actor,group_epoch,
      input_revision,algorithm,state,stage,created_at)
      VALUES (?,?,?,?,?,?,'building','requests',?)`,
      [generation, convKey, actor, queue.group_epoch, queue.input_revision,
        DERIVE_ALGORITHM, now]);
    db.run(`UPDATE derive_queue SET compute_generation=?,compute_started_ms=?,
      last_claimed_ms=?,attempts=attempts+1,last_error=NULL
      WHERE conv_key=? AND actor=?`, [generation, now, now, convKey, actor]);
    return generation;
  });
}

export function discardGeneration(db: Database, generation: string, reason: string, now: number): void {
  db.transaction(() => {
    const gen = one<{ state: string; conv_key: string; actor: string }>(db,
      'SELECT state,conv_key,actor FROM derive_generation WHERE generation=?', [generation]);
    if (gen === null || gen.state === 'published' || gen.state === 'retired') return;
    db.run('DELETE FROM derive_result_work WHERE generation=?', [generation]);
    db.run('DELETE FROM derive_call_work WHERE generation=?', [generation]);
    db.run('DELETE FROM derive_chain_work WHERE generation=?', [generation]);
    db.run('DELETE FROM derive_role_work WHERE generation=?', [generation]);
    db.run('DELETE FROM derive_tool_result WHERE generation=?', [generation]);
    db.run('DELETE FROM derive_request_result WHERE generation=?', [generation]);
    db.run(`UPDATE derive_generation SET state='discarded',last_error=NULL WHERE generation=?`,
      [generation]);
    db.run(`UPDATE derive_queue SET compute_generation=NULL,compute_started_ms=NULL,
      last_completed_ms=?,last_error=? WHERE conv_key=? AND actor=? AND compute_generation=?`,
      [now, reason, gen.conv_key, gen.actor, generation]);
  }).immediate();
}

export function publishGeneration(db: Database, generation: string, now: number): boolean {
  return db.transaction(() => {
    const gen = one<{ state: string; stage: string; conv_key: string; actor: string;
      group_epoch: string; input_revision: number; algorithm: number; request_count: number;
      tool_count: number }>(db, `SELECT state,stage,conv_key,actor,group_epoch,input_revision,
        algorithm,request_count,tool_count FROM derive_generation WHERE generation=?`, [generation]);
    if (gen === null || gen.state !== 'ready' || gen.stage !== 'done') return false;
    const queue = one<{ state: string; group_epoch: string; input_revision: number;
      target_algorithm: number }>(db, `SELECT state,group_epoch,input_revision,target_algorithm
        FROM derive_queue WHERE conv_key=? AND actor=?`, [gen.conv_key, gen.actor]);
    const requests = n(db, `SELECT COUNT(*) FROM request
      WHERE conv_key=? AND actor=? AND actor_state='known'`, [gen.conv_key, gen.actor]);
    const missing = n(db, `SELECT COUNT(*) FROM request r
      WHERE r.conv_key=? AND r.actor=? AND r.actor_state='known' AND NOT EXISTS
        (SELECT 1 FROM derive_request_result d WHERE d.generation=? AND d.req_id=r.req_id)`,
      [gen.conv_key, gen.actor, generation]);
    const tools = n(db, 'SELECT COUNT(*) FROM derive_tool_result WHERE generation=?', [generation]);
    // 发布事务只做指针级校验；逐请求的修订比较与 basis 大小已在 ready 阶段分批完成。
    if (queue === null || queue.group_epoch !== gen.group_epoch ||
        queue.input_revision !== gen.input_revision ||
        queue.target_algorithm !== gen.algorithm || requests !== gen.request_count ||
        missing !== 0 || tools !== gen.tool_count) {
      discardGeneration(db, generation, 'publish_invalidated', now);
      return false;
    }
    db.run(`UPDATE derive_generation SET state='retired'
      WHERE conv_key=? AND actor=? AND state='published'`, [gen.conv_key, gen.actor]);
    db.run(`UPDATE derive_generation SET state='published',published_at=
      CASE WHEN published_at IS NULL THEN ? ELSE published_at END WHERE generation=?`,
      [now, generation]);
    db.run(`UPDATE derive_queue SET published_generation=?,published_revision=input_revision,
      published_algorithm=?,state='clean',dirty_since_ms=NULL,legacy_snapshot=0,
      compute_generation=NULL,compute_started_ms=NULL,last_completed_ms=?,last_error=NULL
      WHERE conv_key=? AND actor=?`,
      [generation, gen.algorithm, now, gen.conv_key, gen.actor]);
    return true;
  }).immediate();
}

function idle(generation: string | null, stage: string | null): SliceStep {
  return { status: 'idle', generation, stage, rows: 0, batch_ms: 0 };
}
function advanced(generation: string, stage: string | null, rows: number, started: number): SliceStep {
  return { status: 'advanced', generation, stage, rows, batch_ms: performance.now() - started };
}
function discarded(generation: string, started: number): SliceStep {
  return { status: 'discarded', generation, stage: null, rows: 0,
    batch_ms: performance.now() - started };
}
function assertQueueRevision(db: Database, gen: {
  conv_key: string; actor: string; group_epoch: string; input_revision: number;
}): boolean {
  const queue = one<{ group_epoch: string; input_revision: number }>(db,
    `SELECT group_epoch,input_revision FROM derive_queue WHERE conv_key=? AND actor=?`,
    [gen.conv_key, gen.actor]);
  return queue !== null && queue.group_epoch === gen.group_epoch &&
    queue.input_revision === gen.input_revision;
}

export function recoverSlice(db: Database, now: number): number {
  const rows = db.query<{ generation: string }, []>(`
    SELECT q.compute_generation AS generation FROM derive_queue q
    JOIN derive_generation g ON g.generation=q.compute_generation
    WHERE q.compute_generation IS NOT NULL AND g.state IN ('building','ready')`).all();
  for (const row of rows) discardGeneration(db, row.generation, 'reopened_unpublished', now);
  return rows.length;
}
```

`publishGeneration` 的校验必须在切换指针之前完成。因此过期代不会短暂出现在 `published_generation` 上。旧代只转 `retired`，其 `derive_*_result` 行保留，供历史详情与原算法对照；清理只由 Task 18 的保留上限执行。

- [ ] **Step 4：实现同快照读取。** `readEffectiveGroup` 在只读连接上显式 `BEGIN DEFERRED`，一次事务内读队列指针和整组结果；组不 clean 时不返回任何当前行，绝不逐字段回退到 `request` 旧列。

```ts
export type EffectiveRow = Record<string, unknown> & { generation: string | null };
export type EffectiveGroup = {
  state: 'current' | 'masked';
  generation: string | null;
  rows: EffectiveRow[];
};

export function readEffectiveGroup(read: Database, convKey: string, actor: string): EffectiveGroup {
  read.exec('BEGIN DEFERRED');
  try {
    const queue = one<{ state: string; published_generation: string | null }>(read,
      `SELECT state,published_generation FROM derive_queue WHERE conv_key=? AND actor=?`,
      [convKey, actor]);
    if (queue === null || queue.state !== 'clean' || queue.published_generation === null) {
      return { state: 'masked', generation: queue?.published_generation ?? null, rows: [] };
    }
    const rows = read.query<EffectiveRow, [string, string]>(`
      SELECT * FROM effective_request WHERE conv_key=? AND actor=?
      ORDER BY started_ms,req_id`).all(convKey, actor);
    for (const row of rows) {
      if (row.generation !== queue.published_generation) throw new Error('derive_snapshot_mismatch');
    }
    return { state: 'current', generation: queue.published_generation, rows };
  } finally {
    read.exec('COMMIT');
  }
}
```

- [ ] **Step 5：在启动时恢复。** `startCollector` 在打开 store、启动定时器和 handler 之前调用 `recoverSlice(store.db, Date.now())`。测试直接调用它模拟进程重开；返回值写入容量报告的 `discarded_generations`。

- [ ] **Step 6：运行。** Run: `bun test tests/derive-slice.test.ts`。Expected: PASS。若「不回退旧请求列」失败，检查 `effective_request` 是否被改成了 `COALESCE(d.title,r.title)`；计划禁止这种逐字段回退。

- [ ] **Step 7：提交。** 获授权后：

```bash
git add src/derive-slice.ts src/derive.ts src/queries.ts src/store.ts tests/derive-slice.test.ts \
  .agents/notes/implemented/feature/2026-10-22-atc-generation-publish-pointer.md
git commit -m "feat(derive): add generation lifecycle and atomic publish pointer" \
  -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

**Step 8（执行时的偏差记录）**

1. **`discardGeneration` 拆成两半。** `publishGeneration` 在事务里校验失败时也要丢弃这一代，若直接调用带 `BEGIN IMMEDIATE` 的 `discardGeneration` 就是嵌套事务，`bun:sqlite` 会抛 `cannot start a transaction within a transaction`。因此实现拆成 `discardGenerationTx(db, generation, reason, now)`（调用方已处于事务中）与包一层事务的 `discardGeneration`。两者共用同一段删除逻辑，测试两条路径都覆盖。
2. **`src/derive.ts` 的 helper 导出、`src/queries.ts` 的接线、`Store.deriveBudget?` 在本任务里没有做。** 这三项都要等到有调用点才有意义：helper 与 `queries.ts` 是 Task 15—17 各阶段要用的，`Store.deriveBudget` 是 Task 18 的 `drainDeriveEntry` 才读的。Task 14 里凭空加出未被引用的导出只会让本模块的接口面先于用途增长。相应地，本任务的测试文件只导入已经存在的符号（`beginGeneration`、`discardGeneration`、`publishGeneration`、`readEffectiveGroup`、`recoverSlice`），不含 `sliceGroupStep`/`slice*Stage`/`drainDeriveTx`；阶段函数在 Task 15—17 落地时，测试再在同一文件里扩展。
3. **`target_algorithm` 的布线缺口（Task 18/19 必须处理）。** `markGroupDirtyTx` 目前写 `GROUP_ALGORITHM = 1`，而 `beginGeneration` 要求 `target_algorithm === DERIVE_ALGORITHM`（5），否则抛 `derive_algorithm_mismatch`。也就是说切片模式一开，认领就会硬失败。切换算法号的钩子必须在切片模式启用之前接上（组变脏时按运行模式写 `target_algorithm`），否则 `--slice` 的容量场景跑不起来。Task 15 起的所有阶段测试若要端到端跑，也都需要先解决这一点；本任务的测试直接种入 `target_algorithm=5` 的队列行，绕开布线。
4. **`DEFAULT_DERIVE_BUDGET` 与 `SliceStep` 在 Task 14 里未被使用。** 两者是 Task 15—19 的接口形状，先按计划定义出来（`DeriveBudget` 的字段名就是后面读预算的地方要对齐的），但 `sliceGroupStep` 尚未实现，因此 `SliceStep` 暂无生产者。这是有意的：接口先定死，实现分批填。

### Task 15：请求、候选与逻辑顺序切片

**Files:**
- Modify: `src/derive.ts`（导出既有 `sortKeyOf`、`fingerprintsOf`、`replyInfoOf`、`anthropicReplyCalls`、`anthropicRequestResults`、`bodyInTx`；新增共享比较器。清单与 A Task 1 Interfaces 的导出行保持同一处，缺项请 A 一并补入该行，F 不另立清单）
- Modify: `src/derive-slice.ts`
- Test: `tests/derive-slice.test.ts`
- Agent Note: `.agents/notes/implemented/feature/2026-10-22-atc-sliced-request-candidates.md`

**Interfaces:**
- Consumes: Task 14 的 `beginGeneration`、`discardGeneration`、`DeriveBudget`。
- Produces: `sliceRequestsStage(store, generation, budget, now): SliceStep`；`compareTraversalOrder`；结果行 `traversal_ord`、`derive_call_work`、`derive_result_work`。

请求阶段只做三件事，不计算链、不配对工具、不写最终摘要：

1. 按 `req_id` keyset 分批把请求事实写入 `derive_request_result`，同时从回复和请求正文抽取工具调用/结果候选，写入两张 work 表。
2. 所有请求事实齐备后，只把轻量的 `(req_id, started_ms, sort_source, sort_key)` 读入内存，用 A 的同一比较器排序，分批写 `traversal_ord`。
3. 设置 `stage='roles'`，不把整组正文或完整结果装进内存。

- [ ] **Step 1：写失败测试。** 先把只建请求行的 helper 加到 `tests/fixtures.ts` 并导出，正文仍用 `src/body.ts` 的 `persistBody`。helper 内容如下：

```ts
// tests/fixtures.ts
export function seedRequest(
  store: ReturnType<typeof fixture>['store'],
  rows: readonly { req_id: number; started_ms: number;
    sort_source: string | null; sort_key: string | null }[],
): number[] {
  store.write(db => {
    for (const row of rows) {
      db.run(`INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,
        day,via,body_state,derive_version,have,created_at,updated_at,title,title_source,
        sort_source,sort_key,input_epoch,input_revision,purpose_revision,purpose_version,
        req_kind) VALUES (?,?,?,'a','known',?,'2026-10-22','hook','pending',0,1,1,1,
        'seed','model_time',?,?,'e1',1,0,1,'chat')`,
        [row.req_id, JSON.stringify(['session', 'chain']), 'session', row.started_ms,
          row.sort_source, row.sort_key]);
    }
  });
  return rows.map(row => row.req_id);
}
```

```ts
import { persistBody } from '../src/body';
import { fixture, seedRequest } from './fixtures';
// beginGeneration、DEFAULT_DERIVE_BUDGET、sliceRequestsStage 已在本文件顶部导入。

test('请求切片分批物化并按A比较器写traversal_ord', () => {
  const f = fixture();
  try {
    const ids = seedRequest(f.store, [
      { req_id: 1, started_ms: 200, sort_source: 'ledger', sort_key: '1:1:1:1|00000000000000000001' },
      { req_id: 2, started_ms: 100, sort_source: 'ledger', sort_key: '1:1:1:1|00000000000000000002' },
      { req_id: 3, started_ms: 100, sort_source: 'ledger', sort_key: '1:1:1:1|00000000000000000001' },
      { req_id: 4, started_ms: 300, sort_source: null, sort_key: null },
    ]);
    persistBody(f.store, 1, {
      protocol: 'anthropic',
      request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }] },
      reply: { content: [{ type: 'tool_use', id: 'call-1', name: 'read' }] },
      redact_version: 1,
    });
    persistBody(f.store, 2, {
      protocol: 'anthropic',
      request: { messages: [{ role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }] }] },
      reply: { content: [{ type: 'text', text: 'done' }] },
      redact_version: 1,
    });
    f.store.write(db => db.run(`UPDATE request SET body_state='missing' WHERE req_id=4`));
    f.store.write(db => db.run(`INSERT INTO derive_queue(conv_key,actor,from_sort,
      group_epoch,input_revision,published_revision,target_algorithm,state,dirty_since_ms)
      VALUES ('c','a','','g1',1,0,5,'dirty',1)`));
    const generation = beginGeneration(f.store, 'c', 'a', 10)!;
    const budget = { ...DEFAULT_DERIVE_BUDGET, maxCandidatesPerBatch: 2, maxWritesPerBatch: 8 };
    let step = sliceRequestsStage(f.store, generation, budget, 20);
    while (step.status === 'advanced') step = sliceRequestsStage(f.store, generation, budget, 20);
    expect(step.stage).toBe('roles');
    const rows = f.store.read.query(`SELECT req_id,traversal_ord,retention_state
      FROM derive_request_result WHERE generation=? ORDER BY traversal_ord`).all(generation) as any[];
    expect(rows.map(row => row.req_id)).toEqual([3, 2, 1, 4]);
    expect(rows[3].retention_state).toBe('retained');
    expect(f.store.read.query(`SELECT COUNT(*) AS n FROM derive_call_work
      WHERE generation=?`).get(generation)).toEqual({ n: 1 });
    expect(f.store.read.query(`SELECT COUNT(*) AS n FROM derive_result_work
      WHERE generation=?`).get(generation)).toEqual({ n: 1 });
  } finally { f.close(); }
});
```

- [ ] **Step 2：验证失败。** Run: `bun test tests/derive-slice.test.ts -t '请求切片分批物化'`。Expected: FAIL，`sliceRequestsStage` 不存在。

- [ ] **Step 3：导出 A 的比较器。** 在 `derive.ts` 中把 A 计划新增的 `LogicalRow`、`compareLogicalOrder`、`compareTraversalOrder` 原样导出；`derive-slice.ts` 只 import，不保留任何实现副本，否则切片与同步会各有一套顺序规则。若 A 最终只导出一个比较器（例如 `compareTraversalOrder` 内部就是完整规则），F 以 A 的最终签名为准，不补第二个同义函数。

```ts
import { compareTraversalOrder, type LogicalRow } from './derive';

// 只使用 A 的导出；这里不定义 compareLogicalOrder 或 compareTraversalOrder 的副本。
```

- [ ] **Step 4：实现请求物化。** 每批一个事务；事务内按行检查 `maxRequestMs`，整批检查 `maxStageBatchMs`、`maxWritesPerBatch`、`maxCandidatesPerBatch`。超过单请求预算时不能把请求切成两半，直接 `discardGeneration(..., 'slice_request_budget')`。

```ts
export function sliceRequestsStage(store: Store, generation: string,
  budget: DeriveBudget, now: number): SliceStep {
  const started = performance.now();
  return store.write(db => {
    const gen = one<{ state: string; stage: string; conv_key: string; actor: string;
      input_revision: number; cursor_req_id: number; request_count: number }>(db,
      `SELECT state,stage,conv_key,actor,input_revision,cursor_req_id,request_count
       FROM derive_generation WHERE generation=?`, [generation]);
    if (gen === null || gen.state !== 'building') return { status: 'idle', generation,
      stage: gen?.stage ?? null, rows: 0, batch_ms: 0 };
    if (gen.stage === 'roles') return { status: 'advanced', generation, stage: 'roles',
      rows: 0, batch_ms: performance.now() - started };
    if (!assertQueueRevision(db, gen)) {
      discardGeneration(db, generation, 'slice_group_revision_changed', now);
      return { status: 'discarded', generation, stage: null, rows: 0,
        batch_ms: performance.now() - started };
    }

    let writes = 0;
    let rows = 0;
    for (;;) {
      const page = db.query<RequestFact, [string, string, number, number]>(`
        SELECT req_id,input_epoch,input_revision,sort_source,sort_key,started_ms,
          body_state,title,title_source,input_preview,input_preview_kind,reply_preview,
          purpose_revision,purpose_version,purpose_chain
        FROM request WHERE conv_key=? AND actor=? AND actor_state='known' AND req_id>?
        ORDER BY req_id LIMIT ?`)
        .all(gen.conv_key, gen.actor, gen.cursor_req_id,
          Math.min(50, budget.maxCandidatesPerBatch));
      if (page.length === 0) {
        finishRequestOrder(db, generation);
        return { status: 'advanced', generation, stage: 'roles', rows,
          batch_ms: performance.now() - started };
      }
      const last = page[page.length - 1]!.req_id;
      db.transaction(() => {
        for (const row of page) {
          const rowStart = performance.now();
          if (row.input_revision !== gen.input_revision) {
            throw new Error('slice_request_revision_changed');
          }
          const readable = row.body_state === 'available' || row.body_state === 'partial';
          const body = readable ? bodyInTx(db, row.req_id) : null;
          const calls = body === null ? [] : anthropicReplyCalls(body.reply);
          const results = body === null ? [] : anthropicRequestResults(body.request);
          db.run(`INSERT INTO derive_request_result(
            generation,req_id,input_epoch,input_revision,sort_source,sort_key,started_ms,
            title,title_source,input_preview,input_preview_kind,reply_preview,
            purpose_revision,purpose_version,purpose_chain,algorithm,retention_state,basis_json)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'{}')`,
            [generation, row.req_id, row.input_epoch, row.input_revision, row.sort_source,
              row.sort_key, row.started_ms, readable ? null : row.title,
              readable ? null : row.title_source, readable ? null : row.input_preview,
              readable ? null : row.input_preview_kind, row.reply_preview,
              row.purpose_revision, row.purpose_version, row.purpose_chain, DERIVE_ALGORITHM,
              readable ? 'recomputed' : 'retained']);
          for (const call of calls) {
            db.run(`INSERT INTO derive_call_work(generation,req_id,ord,call_id,tool_name,
              request_index,traversal_ord) VALUES (?,?,?,?,?,0,-1)`,
              [generation, row.req_id, call.ord, call.id, call.name]);
            writes += 1;
          }
          for (const result of results) {
            db.run(`INSERT INTO derive_result_work(generation,req_id,ord,path,call_id,
              preview,request_index,traversal_ord,confirmed)
              VALUES (?,?,?,?,?,?,0,-1,0)`,
              [generation, row.req_id, result.ord, result.path, result.id,
                previewText(result.value)]);
            writes += 1;
          }
          if (performance.now() - rowStart > budget.maxRequestMs) {
            throw new Error('slice_request_budget');
          }
          rows += 1; writes += 1;
        }
        db.run('UPDATE derive_generation SET cursor_req_id=?,request_count=request_count+? WHERE generation=?',
          [last, page.length, generation]);
      }).immediate();
      const elapsed = performance.now() - started;
      if (elapsed >= budget.maxStageBatchMs || writes >= budget.maxWritesPerBatch) {
        return { status: 'advanced', generation, stage: 'requests', rows,
          batch_ms: elapsed };
      }
    }
  });
}
```

`finishRequestOrder` 读取本代全部轻量排序键，使用 `compareTraversalOrder` 排序，然后每 500 行一个事务写 `traversal_ord`；同一函数也把 `derive_call_work`/`derive_result_work` 的 `traversal_ord` 更新为对应请求的顺序。请求数增多时内存只增长排序元组，不增长正文。

- [ ] **Step 4a：实现排序收敛。** 该函数只在 `cursor_req_id` 到达组尾后执行一次；失败重跑时若 `stage='requests'` 但已有全部结果，也会重新计算并保持一致。

```ts
type RequestFact = {
  req_id: number; input_epoch: string | null; input_revision: number | null;
  sort_source: string | null; sort_key: string | null; started_ms: number;
  body_state: string; title: string | null; title_source: string | null;
  input_preview: string | null; input_preview_kind: string | null;
  reply_preview: string | null; purpose_revision: number; purpose_version: number | null;
  purpose_chain: string;
};
function previewText(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return text.slice(0, 200);
}
function finishRequestOrder(db: Database, generation: string): void {
  const rows = db.query<LogicalRow, [string]>(`
    SELECT req_id,started_ms,sort_source,sort_key FROM derive_request_result
    WHERE generation=?`).all(generation);
  rows.sort(compareTraversalOrder);
  for (let start = 0; start < rows.length; start += 500) {
    db.transaction(() => {
      const batch = rows.slice(start, start + 500);
      for (const [index, row] of batch.entries()) {
        const ord = start + index;
        db.run(`UPDATE derive_request_result SET traversal_ord=?
          WHERE generation=? AND req_id=?`, [ord, generation, row.req_id]);
        db.run(`UPDATE derive_call_work SET traversal_ord=?,request_index=?
          WHERE generation=? AND req_id=?`, [ord, ord, generation, row.req_id]);
        db.run(`UPDATE derive_result_work SET traversal_ord=?,request_index=?
          WHERE generation=? AND req_id=?`, [ord, ord, generation, row.req_id]);
      }
    }).immediate();
  }
  db.run(`UPDATE derive_generation SET stage='roles',role_scan_ord=-1 WHERE generation=?`,
    [generation]);
}
```

- [ ] **Step 5：实现 work 的候选预算。** 每个请求的工具调用/结果候选数也受 `maxCandidatesPerBatch` 约束；超过时该请求整体失败并丢弃代际，返回 `slice_candidate_budget`，不允许只写一半候选。`previewText` 只截断为 200 字符，不保留完整结果正文。

- [ ] **Step 6：运行。** Run: `bun test tests/derive-slice.test.ts -t '请求切片'`。Expected: PASS。再 Run: `bun test tests/derive.test.ts`。Expected: A 的同步测试保持 PASS，证明导出没有改变 A 行为。

- [ ] **Step 7：提交。** 获授权后：

```bash
git add src/derive.ts src/derive-slice.ts tests/derive-slice.test.ts tests/fixtures.ts \
  .agents/notes/implemented/feature/2026-10-22-atc-sliced-request-candidates.md
git commit -m "feat(derive): slice request materialization and traversal ordering" \
  -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

**Step 8（执行时的偏差记录）**

1. **计划点名的 `sortKeyOf` 与 `bodyInTx` 都不存在。** 排序键本来就是 `request.sort_source`/`sort_key` 两列，直接读；正文读取用 `src/body.ts` 已有的 `readBodyTx(db, reqId)`。本任务只从 `derive.ts` 导出切片真正要复用的三处：`anthropicReplyCalls`、`anthropicRequestResults`、`flattenToolContent`——候选怎么算、结果正文怎么压平各只有一处实现，切片与同步各写一份会让同一份输入得到两种摘要。`fingerprintsOf`/`replyInfoOf` 推迟到 Task 16（它们的第一批消费者）才导出，理由同 Task 14 偏差 2。
2. **逐请求的 `row.input_revision !== gen.input_revision` 检查被删掉。** 这不是"更严格"，是量纲错了：请求行的 `input_revision` 是它自己的变更计数，组的 `input_revision` 是"组内发生过多少次输入变化"的计数（`markGroupDirtyTx` 每次冲突就 +1）。组内没变过的成员修订天然低于组修订，所以这个等式几乎对每一组都不成立——照计划实现会把每一代都判成过期。真正表达"这一代消费的输入已经变了"的条件是 `assertQueueRevision`（组身份 + 组修订），现在每页开头都验一次，页与页之间夹进来的变更能被抓住。`slice_request_revision_changed` 因此成了没有生产者的错误码。
3. **可读性按"读得出正文"判，不按 `body_state`。** 计划写的是 `body_state === 'available' || 'partial'`。骨架或块引用损坏时 `body_state` 仍是 `available`，但正文读不出来——同步路径的 `fingerprintsOf` 判成不可比较，`request` 旧列原样保留。照计划实现会给这一行写 `title=NULL`、标 `recomputed`，把旧标题丢掉。现在用 `readBodyTx(db, req_id) !== null` 判定，与同步路径的判据在效果上对齐。
4. **可读行的 `reply_preview` 也留空。** 计划只对 `title`/`title_source`/`input_preview`/`input_preview_kind` 加了 `readable ? null : ...`，`reply_preview` 却无条件写旧值。标成 `recomputed` 的行不能带任何从旧列抄来的值，否则"发布的一代全部来自本次重算"这句话就不成立；回复摘要有正文就一定重算得出来，由摘要阶段填。
5. **一页一个事务，而不是整个阶段一个事务。** 计划把整个循环包在 `store.write` 里、每页再开一个嵌套 `db.transaction`。实测 `bun:sqlite` 的嵌套 `transaction()` **不是 savepoint**：内层抛错会把外层一起回滚（探针：外层插 1、内层插 2 后抛错，提交后表里是 0 行）。这带来两个后果——内层的"每页一个事务"是假的；更严重的是，若在同一个 `store.write` 里 catch 住预算错误再调 `discardGeneration`，这次丢弃会被同一个回滚一起带走，那一代就以"半套请求事实、state 仍是 building"的形态留在库里，而它正是最不该被续跑的东西。现在每次 `store.write` 就是一次页事务，超预算的错误在事务**外**接住，再用一次新的写事务丢弃整代。
6. **"阶段已经过到角色阶段"的早退返回 `status: 'idle'`，不是 `'advanced'`。** 计划片段在 `stage === 'roles'` 时返回 `advanced`，而驱动写法是 `while (step.status === 'advanced')` —— 那会死循环。语义上这次调用确实什么都没做，返回 idle 让调度方推进到下一个阶段函数。相应地，"本批做完、阶段已推进"的返回仍是 `advanced` + `stage: 'roles'`。
7. **`finishRequestOrder` 不再嵌套事务，也不写 `role_scan_ord`。** 它已经在页事务里（空页那次调用），再包一层没有意义。`role_scan_ord` 默认就是 -1，且它是 Task 16 角色扫描的游标，初始化属于那一阶段的事，请求阶段只推进 `stage`。
8. **候选工作行的未排序哨兵统一成 -1。** 计划里 `request_index` 写 0、`traversal_ord` 写 -1，两个"还没排序"的值形状不同；现在两张 work 表都写 -1，`request_index` 与 `traversal_ord` 在 `finishRequestOrder` 里一起回填。
9. **测试的组键要对齐。** 计划给的 `seedRequest` 把 `conv_key` 写成 `JSON.stringify(['session','chain'])`（与真实摄入一致），但同一个测试又把队列行插成 `('c','a')`——两个组键永远匹配不上。现在 `conv_key`/`actor` 由 `tests/fixtures.ts` 的 `SEED_GROUP` 一处定义，队列行、请求行、代际共用它。另外这一组没有正文，`seedRequest` 不会经摄入路径造出队列行，需要由测试自己种。
10. **Step 2（验证失败）没有作为红灯步骤执行。** 实现与测试是同一轮写出来的，没有先跑出一个 `sliceRequestsStage` 不存在的失败。这一条如实记录，不当作已通过。

### Task 16：链匹配与角色阶段

**Files:**
- Modify: `src/derive.ts`（导出既有 `commonPrefix`；不改 A 的同步结果）
- Modify: `src/derive-slice.ts`
- Test: `tests/derive-slice.test.ts`
- Agent Note: `.agents/notes/implemented/feature/2026-10-22-atc-sliced-chain-roles.md`

**Interfaces:**
- Consumes: Task 15 的 `traversal_ord`、`derive_request_result.purpose_chain`、`derive_call_work`；A 的 `matchPredecessor` 判据与 `assignChainRoles` 语义。
- Produces: `sliceRolesStage(store, generation, budget, now): SliceStep`；`derive_role_work` 的扫描状态与 `in_trunk`；`derive_chain_work` 的参与指纹；结果中的 `prev_req_id`、`prev_relation`、`delta_ordinals`、`chain_role`；阶段从 `roles` 走到 `role_assign` 再走到 `tools`。

这段不另写简化算法。链关系逐条复刻 A 的 `matchPredecessor`：祖先按遍历顺序给出，parent 取「完整前缀最长，长度相同取先遇到的那个」；`sawEarlier` 表示前面存在任一参与请求（包括正文不可读的），`unreadableEarlier` 表示其中至少一笔不可读；分支关系遇到 `unreadableEarlier` 降为 `unknown`。角色逐条复刻 A 的 `assignChainRoles`：参与且 `prev_relation != 'unknown'` 的请求按 `started_ms, req_id` 排序，第一个根为 trunk，从它可达的整棵子树是 `main`，其余是 `branch`；没有「按后代数重新选 trunk」这一步。

参与判定只有一种写法：C 已把取值域封在 DDL（`purpose_chain TEXT NOT NULL DEFAULT 'participate' CHECK(purpose_chain IN ('participate','exclude'))`），F 的 v6 结果表同样带这条 CHECK，所以 F 逐处照 D 第 1779 行的形式写 `row.purpose_chain === 'participate'` 决定是否参与，写 `row.purpose_chain === 'exclude'` 决定链身份与工具配对；两者在封闭域下等价，读取期不再为未知值另定政策。`exclude` 的行不写 `chain_work`、不进角色森林、`chain_role` 为 `aux`，与 D 的工具配对排除 aux 一致。

F 的等价性基准是 **D 之后的同步路径**，不是 A 的裸实现：D 已经把 `isAux` 与 `isTitle` 拆开（链身份与工具配对看 `purpose_chain`，标题字段看 `req_kind`，且 aux 非标题行不得从用户增量取标题），Task 19 的 oracle 跑的就是那份同步入口。执行者按 A 在 D 之前的旧分支去对齐会写出与 oracle 不一致的切片，本计划的转录与用例都以 D 之后的形态为准。

有界性靠持久状态，不靠把祖先装进内存：每个参与请求在 `derive_role_work` 有一行，`scan_ord` 是本请求已扫到的祖先 `traversal_ord`；每次 `sliceRolesStage` 调用只读取一页或连续几页 `derive_chain_work`，把累计状态写回该行，单次事务受 `maxStageBatchMs` 限制。崩溃或丢弃后重跑从 `scan_ord` 继续，不重头扫描，不把祖先数组跨页保留。

- [ ] **Step 1：写失败测试。** 覆盖线性链、分叉树（含相同 `started_ms` 时按 `req_id` 选根）、不可读祖先、D 的排除用途，以及与 A 同步结果逐行一致。

```ts
// tests/fixtures.ts
export function seedChain(
  store: ReturnType<typeof fixture>['store'],
  sessions: readonly { texts: string[]; startedMs?: number; purposeChain?: string }[],
): number[] {
  const ids: number[] = [];
  store.write(db => {
    for (const [index, session] of sessions.entries()) {
      const reqId = index + 1;
      const started = session.startedMs ?? 1000 + index;
      db.run(`INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,
        day,via,body_state,derive_version,have,created_at,updated_at,title,title_source,
        sort_source,sort_key,input_epoch,input_revision,purpose_revision,purpose_version,
        purpose_chain,req_kind)
        VALUES (?,?,?,'actor-a','known',?,'2026-10-22','hook','pending',0,1,1,1,
        'seed','model_time','ledger',?,'e1',1,0,1,?, 'chat')`,
        [reqId, JSON.stringify(['session', 'chain']), 'session', started,
          `ledger|${String(index).padStart(4, '0')}`,
          session.purposeChain ?? 'participate']);
      persistBody(store, reqId, {
        protocol: 'anthropic',
        request: { messages: session.texts.map(text => ({ role: 'user', content: [{ type: 'text', text }] })) },
        reply: { id: `msg_${reqId}`, content: [{ type: 'text', text: 'ok' }] },
        redact_version: 1,
      });
      ids.push(reqId);
    }
  });
  return ids;
}

function enqueueChainGroup(f: ReturnType<typeof fixture>): void {
  f.store.write(db => db.run(`INSERT INTO derive_queue(conv_key,actor,from_sort,
    group_epoch,input_revision,published_revision,target_algorithm,state,dirty_since_ms)
    VALUES ('c','actor-a','','g1',1,0,5,'dirty',1)`));
}

function runStage(f: ReturnType<typeof fixture>, generation: string,
  stage: (store: ReturnType<typeof fixture>['store'], generation: string,
    budget: typeof DEFAULT_DERIVE_BUDGET, now: number) => SliceStep,
  budget = DEFAULT_DERIVE_BUDGET): SliceStep {
  let step = stage(f.store, generation, budget, 20);
  while (step.status === 'advanced' && step.stage !== 'tools' && step.stage !== 'summary') {
    step = stage(f.store, generation, budget, 20);
  }
  return step;
}

test('链与角色切片和A同步逐行一致', () => {
  const chain = [['S'], ['S', 'A'], ['S', 'B'], ['S', 'A', 'C'], ['S', 'B', 'D']];
  const f = fixture();
  try {
    seedChain(f.store, chain.map(texts => ({ texts })));
    enqueueChainGroup(f);
    const generation = beginGeneration(f.store, 'c', 'actor-a', 10)!;
    const budget = { ...DEFAULT_DERIVE_BUDGET, maxCandidatesPerBatch: 1 };
    runStage(f, generation, sliceRequestsStage, budget);
    runStage(f, generation, sliceRolesStage, budget);
    const rows = f.store.read.query(`SELECT req_id,prev_req_id,prev_relation,
      delta_ordinals,chain_role FROM derive_request_result
      WHERE generation=? ORDER BY req_id`).all(generation);
    expect(rows).toEqual([
      { req_id: 1, prev_req_id: null, prev_relation: 'first', delta_ordinals: '[0]', chain_role: 'main' },
      { req_id: 2, prev_req_id: 1, prev_relation: 'confirmed', delta_ordinals: '[1]', chain_role: 'main' },
      { req_id: 3, prev_req_id: 1, prev_relation: 'confirmed', delta_ordinals: '[1]', chain_role: 'main' },
      { req_id: 4, prev_req_id: 2, prev_relation: 'confirmed', delta_ordinals: '[2]', chain_role: 'main' },
      { req_id: 5, prev_req_id: 3, prev_relation: 'confirmed', delta_ordinals: '[2]', chain_role: 'main' },
    ]);
    const oracle = fixture();
    try {
      seedChain(oracle.store, chain.map(texts => ({ texts })));
      enqueueChainGroup(oracle);
      oracle.store.write(db => drainDeriveTx(db, { limit: 100 }));
      expect(rows).toEqual(oracle.store.read.query(`SELECT req_id,prev_req_id,
        prev_relation,delta_ordinals,chain_role FROM request
        WHERE conv_key='c' AND actor='actor-a' ORDER BY req_id`).all());
    } finally { oracle.close(); }
  } finally { f.close(); }
});

test('相同started_ms时根按req_id取第一个', () => {
  const f = fixture();
  try {
    // 5 与 2 都是根且 started_ms 相同；A 按 req_id 取 2 为 trunk。
    seedChain(f.store, [
      { texts: ['S'], startedMs: 1000 },
      { texts: ['S', 'A'], startedMs: 2000 },
      { texts: ['S', 'B'], startedMs: 2000 },
      { texts: ['S', 'B', 'C'], startedMs: 3000 },
    ]);
    enqueueChainGroup(f);
    const generation = beginGeneration(f.store, 'c', 'actor-a', 10)!;
    runStage(f, generation, sliceRequestsStage);
    runStage(f, generation, sliceRolesStage);
    expect(f.store.read.query(`SELECT req_id,chain_role FROM derive_request_result
      WHERE generation=? ORDER BY req_id`).all(generation)).toEqual([
      { req_id: 1, chain_role: 'main' },
      { req_id: 2, chain_role: 'main' },
      { req_id: 3, chain_role: 'branch' },
      { req_id: 4, chain_role: 'branch' },
    ]);
  } finally { f.close(); }
});

test('不可读祖先只把后续关系降为unknown并保留旧摘要', () => {
  const f = fixture();
  try {
    seedChain(f.store, [['S'], ['S', 'A'], ['S', 'A', 'B']].map(texts => ({ texts })));
    f.store.write(db => db.run(`UPDATE request SET body_state='missing',
      title='kept title',title_source='user_delta' WHERE req_id=2`));
    enqueueChainGroup(f);
    const generation = beginGeneration(f.store, 'c', 'actor-a', 10)!;
    runStage(f, generation, sliceRequestsStage);
    runStage(f, generation, sliceRolesStage);
    expect(f.store.read.query(`SELECT prev_req_id,prev_relation,delta_ordinals
      FROM derive_request_result WHERE generation=? AND req_id=3`).get(generation))
      .toEqual({ prev_req_id: null, prev_relation: 'unknown', delta_ordinals: null });
    expect(f.store.read.query(`SELECT title,title_source,retention_state
      FROM derive_request_result WHERE generation=? AND req_id=2`).get(generation))
      .toEqual({ title: 'kept title', title_source: 'user_delta', retention_state: 'retained' });
  } finally { f.close(); }
});

test('排除用途不写chain_work也不进角色森林', () => {
  const f = fixture();
  try {
    seedChain(f.store, [
      { texts: ['S'], purposeChain: 'participate' },
      { texts: ['S', 'A'], purposeChain: 'exclude' },
      { texts: ['S', 'A', 'B'], purposeChain: 'participate' },
    ]);
    enqueueChainGroup(f);
    const generation = beginGeneration(f.store, 'c', 'actor-a', 10)!;
    runStage(f, generation, sliceRequestsStage);
    runStage(f, generation, sliceRolesStage);
    expect(f.store.read.query(`SELECT prev_req_id,prev_relation,chain_role
      FROM derive_request_result WHERE generation=? AND req_id=2`).get(generation))
      .toEqual({ prev_req_id: null, prev_relation: 'aux', chain_role: 'aux' });
    expect(f.store.read.query(`SELECT prev_req_id,prev_relation,chain_role
      FROM derive_request_result WHERE generation=? AND req_id=3`).get(generation))
      .toEqual({ prev_req_id: 1, prev_relation: 'confirmed', chain_role: 'main' });
    expect(f.store.read.query(`SELECT COUNT(*) AS n FROM derive_chain_work
      WHERE generation=? AND req_id=2`).get(generation)).toEqual({ n: 0 });
  } finally { f.close(); }
});
```

- [ ] **Step 2：验证失败。** Run: `bun test tests/derive-slice.test.ts -t '链与角色'`。Expected: FAIL，`sliceRolesStage` 或 `derive_role_work` 新列不存在。

- [ ] **Step 3：实现可恢复的祖先扫描。** 扫描状态全部落在 `derive_role_work`。`sliceRolesStage` 只负责阶段分派；`scanRolePage` 一次事务里推进若干页祖先，直到当前请求扫完并结算，或达到 `maxStageBatchMs`。结算时写回关系、`chain_work` 和 `role_scan_ord`，然后继续下一个请求。不递归进写事务，不跨页保留祖先数组。

```ts
type RoleWork = {
  generation: string; req_id: number; traversal_ord: number; started_ms: number;
  participating: number; parent_req_id: number | null; relation: string | null;
  fingerprints_json: string | null; scan_ord: number;
  best_parent_req: number | null; best_parent_len: number | null;
  saw_earlier: number; unreadable_earlier: number;
  state: 'scanning' | 'done'; in_trunk: number;
};
type RoleGen = {
  state: string; stage: string; conv_key: string; actor: string; group_epoch: string;
  input_revision: number; role_scan_ord: number; role_assign_ord: number;
  role_root_req: number | null;
};

export function sliceRolesStage(store: Store, generation: string,
  budget: DeriveBudget, now: number): SliceStep {
  const started = performance.now();
  return store.write(db => {
    const gen = one<RoleGen>(db, `SELECT state,stage,conv_key,actor,group_epoch,
      input_revision,role_scan_ord,role_assign_ord,role_root_req
      FROM derive_generation WHERE generation=?`, [generation]);
    if (gen === null || gen.state !== 'building') return idle(generation, gen?.stage ?? null);
    if (gen.stage === 'tools' || gen.stage === 'summary' || gen.stage === 'ready'
        || gen.stage === 'done') return advanced(generation, gen.stage, 0, started);
    if (!assertQueueRevision(db, gen)) {
      discardGeneration(db, generation, 'slice_group_revision_changed', now);
      return discarded(generation, started);
    }
    if (gen.stage === 'role_assign') return assignRolePage(db, generation, gen, budget, started);
    return scanRolePage(db, generation, gen, budget, started, now);
  });
}

function requestPurposeRevision(db: Database, reqId: number): number {
  const row = db.query<{ purpose_revision: number }, [number]>(
    'SELECT purpose_revision FROM request WHERE req_id=?').get(reqId) as
    { purpose_revision: number } | null;
  return row?.purpose_revision ?? -1;
}

function finishRoleWork(db: Database, generation: string, work: RoleWork): void {
  let relation = 'unknown';
  let parent: number | null = null;
  let delta: number[] | null = null;
  if (work.participating !== 1) {
    relation = 'aux';
  } else if (work.fingerprints_json === null) {
    relation = 'unknown';
  } else if (work.best_parent_len !== null) {
    relation = work.best_parent_len === 0 ? 'first' : 'confirmed';
    parent = work.best_parent_req;
    const current = JSON.parse(work.fingerprints_json) as string[];
    delta = current.slice(work.best_parent_len).map((_, offset) => offset + work.best_parent_len!);
  } else if (work.saw_earlier === 0) {
    relation = 'first';
    const current = JSON.parse(work.fingerprints_json) as string[];
    delta = current.map((_, index) => index);
  } else {
    relation = work.unreadable_earlier === 1 ? 'unknown' : 'branch';
  }
  db.run(`UPDATE derive_request_result SET prev_req_id=?,prev_relation=?,delta_ordinals=?
    WHERE generation=? AND req_id=?`,
    [parent, relation, delta === null ? null : JSON.stringify(delta), generation, work.req_id]);
  db.run(`UPDATE derive_role_work SET relation=?,state='done' WHERE generation=? AND req_id=?`,
    [relation, generation, work.req_id]);
  if (work.participating === 1) {
    db.run(`INSERT OR REPLACE INTO derive_chain_work(generation,req_id,traversal_ord,
      fingerprints_json,participating,byte_length) VALUES (?,?,?,?,1,?)`,
      [generation, work.req_id, work.traversal_ord, work.fingerprints_json,
        work.fingerprints_json === null ? 0 : work.fingerprints_json.length]);
  }
  db.run(`UPDATE derive_generation SET role_scan_ord=? WHERE generation=?`,
    [work.traversal_ord, generation]);
}

function scanRolePage(db: Database, generation: string, gen: RoleGen,
  budget: DeriveBudget, started: number, now: number): SliceStep {
  let writes = 0;
  for (;;) {
    let work = one<RoleWork>(db, `SELECT * FROM derive_role_work
      WHERE generation=? AND state='scanning' ORDER BY traversal_ord LIMIT 1`, [generation]);
    if (work === null) {
      const next = one<{ req_id: number; traversal_ord: number; started_ms: number;
        purpose_chain: string | null; purpose_revision: number }>(db, `
        SELECT req_id,traversal_ord,started_ms,purpose_chain,purpose_revision
        FROM derive_request_result WHERE generation=? AND traversal_ord>?
        ORDER BY traversal_ord LIMIT 1`, [generation, gen.role_scan_ord]);
      if (next === null) {
        // relation='unknown' 的行不进森林；root 只在参与且可确认的根里按时序取第一个。
        const root = one<{ req_id: number }>(db, `SELECT req_id FROM derive_role_work
          WHERE generation=? AND participating=1 AND relation<>'unknown'
            AND parent_req_id IS NULL ORDER BY started_ms,req_id LIMIT 1`, [generation]);
        db.run(`UPDATE derive_generation SET stage='role_assign',role_assign_ord=-1,
          role_root_req=? WHERE generation=?`, [root?.req_id ?? null, generation]);
        return advanced(generation, 'role_assign', writes, started);
      }
      if (next.purpose_revision !== requestPurposeRevision(db, next.req_id)) {
        discardGeneration(db, generation, 'slice_purpose_revision_changed', now);
        return discarded(generation, started);
      }
      const participating = next.purpose_chain === 'participate' ? 1 : 0;
      const fingerprints = participating === 1 ? fingerprintsOf(db, next.req_id) : null;
      db.run(`INSERT INTO derive_role_work(generation,req_id,traversal_ord,started_ms,
        participating,parent_req_id,relation,fingerprints_json,scan_ord,best_parent_req,
        best_parent_len,saw_earlier,unreadable_earlier,state,in_trunk)
        VALUES (?,?,?,?,?,NULL,NULL,?,-1,NULL,NULL,0,0,'scanning',0)`,
        [generation, next.req_id, next.traversal_ord, next.started_ms, participating,
          fingerprints === null ? null : JSON.stringify(fingerprints)]);
      writes += 1;
      continue;
    }
    if (work.participating === 1 && work.fingerprints_json !== null) {
      const current = JSON.parse(work.fingerprints_json) as string[];
      const page = db.query<{ req_id: number; traversal_ord: number;
        fingerprints_json: string | null }, [string, number, number, number]>(`
        SELECT req_id,traversal_ord,fingerprints_json FROM derive_chain_work
        WHERE generation=? AND traversal_ord>? AND traversal_ord<?
        ORDER BY traversal_ord LIMIT ?`)
        .all(generation, work.scan_ord, work.traversal_ord, budget.maxCandidatesPerBatch);
      let bestReq = work.best_parent_req;
      let bestLen = work.best_parent_len;
      let saw = work.saw_earlier;
      let unreadable = work.unreadable_earlier;
      for (const ancestor of page) {
        saw = 1;
        if (ancestor.fingerprints_json === null) { unreadable = 1; continue; }
        const previous = JSON.parse(ancestor.fingerprints_json) as string[];
        const shared = commonPrefix(previous, current);
        // 与 A 相同：完整前缀且更长才替换；长度相同保留先遇到者（严格大于）。
        if (shared === previous.length && (bestLen === null || previous.length > bestLen)) {
          bestReq = ancestor.req_id;
          bestLen = previous.length;
        }
      }
      const last = page.length === 0 ? work.traversal_ord
        : page[page.length - 1]!.traversal_ord;
      db.run(`UPDATE derive_role_work SET scan_ord=?,best_parent_req=?,best_parent_len=?,
        saw_earlier=?,unreadable_earlier=? WHERE generation=? AND req_id=?`,
        [last, bestReq, bestLen, saw, unreadable, generation, work.req_id]);
      writes += 1;
      if (page.length > 0) {
        if (performance.now() - started >= budget.maxStageBatchMs) {
          return advanced(generation, 'roles', writes, started);
        }
        continue;
      }
      work = one<RoleWork>(db, `SELECT * FROM derive_role_work
        WHERE generation=? AND req_id=?`, [generation, work.req_id])!;
      finishRoleWork(db, generation, work);
      continue;
    }
    finishRoleWork(db, generation, work);
    continue;
  }
}
```

扫描游标只用祖先的 `traversal_ord`：`derive_chain_work` 已按该列建索引，下一页继续 `traversal_ord > scan_ord`；页为空才把 `scan_ord` 设为当前请求的 `traversal_ord` 并结算。不能用 `req_id` 或指纹长度推进游标。

- [ ] **Step 4：实现角色成员传播。** 扫描阶段把每个参与请求的 `relation` 和 `parent_req_id` 都写好后，`role_assign` 按时序选出的 `role_root_req` 已在 Step 3 写入。本步按 `traversal_ord` 分批：`relation='unknown'` 或非参与的行保持 `main`/`aux` 中性，参与且可确认的行由父行继承 `in_trunk`，根行只有 `role_root_req` 为 1；其余为 0。父行一定先于子行处理，因为 parent 是遍历序更早的祖先。每批写 `role_work.in_trunk` 与结果 `chain_role`，`role_assign_ord` 同事务前进。

```ts
function assignRolePage(db: Database, generation: string, gen: RoleGen,
  budget: DeriveBudget, started: number): SliceStep {
  const pageSize = Math.max(1, Math.min(budget.maxCandidatesPerBatch,
    Math.max(1, Math.floor(budget.maxWritesPerBatch))));
  let cursor = gen.role_assign_ord;
  let writes = 0;
  for (;;) {
    const rows = db.query<RoleWork, [string, number, number]>(`
      SELECT * FROM derive_role_work WHERE generation=? AND traversal_ord>?
      ORDER BY traversal_ord LIMIT ?`).all(generation, cursor, pageSize);
    if (rows.length === 0) {
      db.run(`UPDATE derive_generation SET stage='tools' WHERE generation=?`, [generation]);
      return advanced(generation, 'tools', writes, started);
    }
    // 每页一个独立事务；外层循环只受 maxStageBatchMs 约束，游标同事务前进。
    db.transaction(() => {
      for (const row of rows) {
        let inTrunk = 0;
        let role = 'main';
        if (row.participating !== 1) {
          role = 'aux';
        } else if (row.relation === null || row.relation === 'unknown') {
          role = 'main';
        } else if (row.parent_req_id !== null) {
          const parent = one<{ participating: number; relation: string | null; in_trunk: number }>(db,
            `SELECT participating,relation,in_trunk FROM derive_role_work
             WHERE generation=? AND req_id=?`, [generation, row.parent_req_id]);
          inTrunk = parent !== null && parent.participating === 1 && parent.relation !== 'unknown'
            ? parent.in_trunk : 0;
          role = inTrunk === 1 ? 'main' : 'branch';
        } else {
          inTrunk = row.req_id === gen.role_root_req ? 1 : 0;
          role = inTrunk === 1 ? 'main' : 'branch';
        }
        db.run(`UPDATE derive_role_work SET in_trunk=? WHERE generation=? AND req_id=?`,
          [inTrunk, generation, row.req_id]);
        db.run(`UPDATE derive_request_result SET chain_role=? WHERE generation=? AND req_id=?`,
          [role, generation, row.req_id]);
      }
      db.run(`UPDATE derive_generation SET role_assign_ord=? WHERE generation=?`,
        [rows[rows.length - 1]!.traversal_ord, generation]);
    }).immediate();
    cursor = rows[rows.length - 1]!.traversal_ord;
    writes += rows.length;
    if (performance.now() - started >= budget.maxStageBatchMs) {
      return advanced(generation, 'role_assign', writes, started);
    }
  }
}
```

`chain_role` 的三种取值与 A/D 对齐：排除用途 `aux`；参与但关系 `unknown` 保持中性 `main`；参与且可确认的按 trunk 子树 `main`/`branch`。角色阶段不写标题、预览或摘要，摘要留到工具配对之后的 Task 18，保持链→角色→工具→摘要的顺序。

`assignRolePage` 与 `scanRolePage` 一样是有界的：每次调用在 `maxStageBatchMs` 内连续提交多页，每页一个独立事务，`role_assign_ord` 与 `in_trunk` 同事务前进；超时保留游标返回 `advanced`，下一次从该游标继续，不重头遍历。父行一定先于子行处理，因为 parent 的 `traversal_ord` 更早。

- [ ] **Step 5：验证等价与有界。** Run: `bun test tests/derive-slice.test.ts -t '链与角色'`。Expected: PASS。再 Run: `bun test tests/derive.test.ts`。Expected: PASS。分叉用例比较完整关系与角色，不比较 `main` 的数量。断言 `maxCandidatesPerBatch=1` 时同一条链仍得到相同结果，证明分页不依赖单次读取全部祖先。

- [ ] **Step 6：提交。** 获授权后：

```bash
git add src/derive.ts src/derive-slice.ts tests/derive-slice.test.ts tests/fixtures.ts \
  .agents/notes/implemented/feature/2026-10-22-atc-sliced-chain-roles.md
git commit -m "feat(derive): resume chain matching and exact role assignment in slices" \
  -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

**Step 7（执行时的偏差记录）**

1. **`finishRoleWork` 必须把 `parent_req_id` 写回 `derive_role_work`。** 计划的实现在结算时只更新 `relation` 与 `state`，而角色传播读的正是工作行的 `parent_req_id`——它永远是 NULL，于是每个节点都长得像根，trunk 继承整段失效。实测三笔（第 2 笔正文不可读）：切片把第 3 笔判成 `branch`，同步给的是 `main`。这是"逐行一致"用例第一次跑就抓出来的真缺陷。
2. **顺序未证实（`uncertainOrderIds`）计划完全没处理。** 同步路径把"同毫秒桶里来源位置不足以证明先后"的请求排除在祖先候选之外，但仍让后续请求知道"前面有参与请求、而且那段证据不可比"。切片用同一个信息量表示：这类请求照旧在 `derive_chain_work` 占一行，但 `fingerprints_json` 写 NULL——与"正文不可读"共用同一种"不可作祖先"的表示。它因此照样计入 `saw_earlier`/`unreadable_earlier`，只是不参与前缀比对。实测（2 与 3 同毫秒、排序键是 `ledger|000N`）两边都得到 `first`/`unknown`/`unknown`/`confirmed`。
3. **未证实只在同一 `started_ms` 桶内判定。** `uncertainOrderIds` 的判据本来就只看桶内位置、不跨桶，所以按请求查一次同毫秒的排序键就够，不必把整组的排序键读进内存逐轮重算（那样每步都是 O(组大小)，合计 O(n²)）。
4. **零长度祖先不构成父节点。** 同步的 `matchPredecessor` 要求 `shared > 0`：空序列是任何序列的前缀，认它当父节点等于用"那一笔没有消息"证明"本笔续自它"。计划里的 `best_parent_len === 0 ? 'first' : 'confirmed'` 分支在这条规则下不可能到达，已删除。
5. **主链根按遍历序选，且"根"的定义与同步一致。** 计划用 `ORDER BY started_ms,req_id` 且要求 `parent_req_id IS NULL`。排序键错了（A 的判据是遍历序），条件也漏了一档：父节点存在但不是可比参与请求（不可读、顺序未证实、或排除用途）时，同步把它当根，计划把它排除在根之外，两边的 trunk 会分叉。现在按 `traversal_ord` 取第一个"父节点为空、或父节点不是可比参与请求"的参与请求。
6. **每一步一个写事务。** 与 Task 15 同一条实测结论：把整个阶段包在一个 `store.write` 里、内部再嵌套 `db.transaction` 不是 savepoint，"每页一个独立事务"是假象；而丢弃整代必须在失败事务之外另开一次写。现在驱动的每一步（一页祖先、一次结算、一页角色）各自一次 `store.write`，超预算就停在可续跑的位置。
7. **逐请求的用途修订校验保留，但把它覆盖的范围写清楚。** 用途重判改了链身份或请求类别时会 `markKnownGroup` 把组标脏，那种情况组级校验已经拦下；剩下的是"重判到同一结论但换了修订"这一档，只有逐请求比对能发现——结果行里记的 `purpose_revision` 是发布出去的事实，不能停在旧值上。
8. **计划里两条用例的期望值是错的，已改用真实同步实现算出来的对照。** 实测：同毫秒那组是 `[first/main, unknown/null/main, unknown/null/main, confirmed→1 delta[1,2]/main]`（计划写的是第 3 笔 `branch`、第 4 笔 `branch`）；不可读祖先那组是 `[first/main, unknown/null/main, confirmed→1 delta[1,2]/main]`（计划写的是第 3 笔 `unknown`、`prev_req_id` 为空）。测试改成两条路径逐行比对 + 已核对的具体值，另补"两个互不相接的根（delta 为整段）"一例——那才真正覆盖 trunk 选取。
9. **`seedChain` 冻结用途（`purpose_pending=0`）。** 不冻结的话，同步侧的用途阶段会把种下的 `purpose_chain` 重判掉（实测：种成 `exclude` 的第 2 笔被改回 `participate`），排除用途那一条就根本测不到。链与角色阶段本来就只消费已定下来的用途，冻结正是它的真实前置条件。
10. **Step 2（验证失败）没有作为红灯步骤执行。** 与 Task 15 同样的情况：实现与测试同一轮写出。如实记录，不当作已通过。

### Task 17：工具配对阶段

**Files:**
- Modify: `src/derive-slice.ts`
- Test: `tests/derive-slice.test.ts`
- Agent Note: `.agents/notes/implemented/feature/2026-10-22-atc-sliced-tool-pairing.md`

**Interfaces:**
- Consumes: Task 15 的 `derive_call_work`/`derive_result_work`，Task 16 的 `prev_relation`、`delta_ordinals`、`chain_role`。
- Produces: `sliceToolsStage(store, generation, budget, now): SliceStep`；每代完整的 `derive_tool_result`，不写入 `request`/`tool_call` 旧表。

工具阶段逐请求读取 call work，按 `call_id` 读取全部候选 call/result。规则与 A 的 `pairToolCalls` 相同：多候选一律 `ambiguous`；结果必须晚于调用；未确认结果只给 `pending`；已确认结果给 `resolved`；已 resolved 不被后续重复结果降级。

- [ ] **Step 1：写失败测试。** 覆盖唯一配对、重复 call_id、结果早于调用、未确认位置。

```ts
function seedToolWork(f: ReturnType<typeof fixture>, generation: string): void {
  f.store.write(db => {
    for (let id = 1; id <= 6; id++) {
      db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
        body_state,derive_version,have,created_at,updated_at,input_epoch,input_revision,
        purpose_revision,purpose_version,req_kind)
        VALUES (?,'c','a','known',?,'2026-10-22','hook','available',0,1,1,1,'e1',1,11,1,'chat')`,
        [id, 100 + id]);
      db.run(`INSERT INTO derive_request_result(generation,req_id,input_epoch,
        input_revision,started_ms,traversal_ord,purpose_revision,purpose_version,
        chain_role,algorithm,retention_state,basis_json)
        VALUES (?,?,'e1',1,?,?,11,1,'main',5,'recomputed','{}')`,
        [generation, id, 100 + id, id - 1]);
    }
    const calls: [number, number, string, number][] = [
      [1, 0, 'call-resolved', 0], [3, 0, 'call-dup', 2],
      [4, 0, 'call-dup', 3], [6, 0, 'call-early', 5],
    ];
    for (const [reqId, ord, callId, order] of calls) {
      db.run(`INSERT INTO derive_call_work(generation,req_id,ord,call_id,tool_name,
        request_index,traversal_ord) VALUES (?,?,?,?, 'read',?,?)`,
        [generation, reqId, ord, callId, order, order]);
    }
    const results: [number, number, string, string, number, number][] = [
      [2, 0, 'call-resolved', 'tool result text', 1, 1],
      [5, 0, 'call-dup', 'dup result', 4, 1],
      [5, 1, 'call-early', 'early result', 4, 1],
    ];
    for (const [reqId, ord, callId, preview, order, confirmed] of results) {
      db.run(`INSERT INTO derive_result_work(generation,req_id,ord,path,call_id,preview,
        request_index,traversal_ord,confirmed) VALUES (?,?,?,?,?,?,?,?,?)`,
        [generation, reqId, ord, String(ord), callId, preview, order, order, confirmed]);
    }
    db.run(`UPDATE derive_generation SET stage='tools',request_count=6,
      tool_cursor_ord=-1 WHERE generation=?`, [generation]);
  });
}

test('工具切片与A配对规则一致且按批提交', () => {
  const f = fixture();
  try {
    f.store.write(db => db.run(`INSERT INTO derive_queue(conv_key,actor,from_sort,
      group_epoch,input_revision,published_revision,target_algorithm,state,dirty_since_ms)
      VALUES ('c','a','','g1',1,0,5,'dirty',1)`));
    const generation = beginGeneration(f.store, 'c', 'a', 10)!;
    seedToolWork(f, generation);
    const budget = { ...DEFAULT_DERIVE_BUDGET, maxCandidatesPerBatch: 1, maxWritesPerBatch: 2 };
    let step = sliceToolsStage(f.store, generation, budget, 20);
    while (step.status === 'advanced' && step.stage === 'tools') {
      step = sliceToolsStage(f.store, generation, budget, 20);
    }
    expect(step.stage).toBe('summary');
    const rows = f.store.read.query(`SELECT call_id,state,result_req,result_ord
      FROM derive_tool_result WHERE generation=? ORDER BY req_id,ord`).all(generation);
    expect(rows).toEqual([
      { call_id: 'call-resolved', state: 'resolved', result_req: 2, result_ord: 0 },
      { call_id: 'call-dup', state: 'ambiguous', result_req: 5, result_ord: 0 },
      { call_id: 'call-dup', state: 'ambiguous', result_req: 5, result_ord: 0 },
      { call_id: 'call-early', state: 'pending', result_req: null, result_ord: null },
    ]);
  } finally { f.close(); }
});
```

- [ ] **Step 2：验证失败。** Run: `bun test tests/derive-slice.test.ts -t '工具切片'`。Expected: FAIL，`sliceToolsStage` 不存在。

- [ ] **Step 3：实现配对。** 每批以请求为边界；一个请求的所有 call 在同一事务写完，`tool_cursor_ord` 与结果计数同事务前进。候选查询只按 `call_id` 读 work 行，不读正文。

```ts
export function sliceToolsStage(store: Store, generation: string,
  budget: DeriveBudget, now: number): SliceStep {
  const started = performance.now();
  return store.write(db => {
    const gen = one<{ state: string; stage: string; conv_key: string; actor: string;
      input_revision: number; tool_cursor_ord: number }>(db,
      `SELECT state,stage,conv_key,actor,input_revision,tool_cursor_ord
       FROM derive_generation WHERE generation=?`, [generation]);
    if (gen === null || gen.state !== 'building') return idle(generation, gen?.stage ?? null);
    if (gen.stage === 'summary' || gen.stage === 'ready' || gen.stage === 'done') {
      return advanced(generation, gen.stage, 0, started);
    }
    if (!assertQueueRevision(db, gen)) {
      discardGeneration(db, generation, 'slice_group_revision_changed', now);
      return discarded(generation, started);
    }
    // D 的排除用途不进工具配对；候选与结果同样只取非 aux 请求。
    const requests = db.query<{ req_id: number; traversal_ord: number }, [string, number, number]>(`
      SELECT DISTINCT c.req_id,c.traversal_ord FROM derive_call_work c
      JOIN derive_request_result d ON d.generation=c.generation AND d.req_id=c.req_id
      WHERE c.generation=? AND c.traversal_ord>? AND COALESCE(d.chain_role,'main')<>'aux'
      ORDER BY c.traversal_ord,c.req_id LIMIT ?`)
      .all(generation, gen.tool_cursor_ord, Math.min(20, budget.maxCandidatesPerBatch));
    if (requests.length === 0) {
      db.run(`UPDATE derive_generation SET stage='summary',summary_cursor_ord=-1
        WHERE generation=?`, [generation]);
      return advanced(generation, 'summary', 0, started);
    }

    let writes = 0;
    db.transaction(() => {
      for (const request of requests) {
        const calls = db.query<CallWork, [string, number]>(`
          SELECT req_id,ord,call_id,tool_name,traversal_ord FROM derive_call_work
          WHERE generation=? AND req_id=? ORDER BY ord`).all(generation, request.req_id);
        for (const call of calls) {
          const callStart = performance.now();
          const candidates = db.query<CallWork, [string, string]>(`
            SELECT c.req_id,c.ord,c.call_id,c.tool_name,c.traversal_ord
            FROM derive_call_work c
            JOIN derive_request_result d ON d.generation=c.generation AND d.req_id=c.req_id
            WHERE c.generation=? AND c.call_id=? AND COALESCE(d.chain_role,'main')<>'aux'
            ORDER BY c.traversal_ord,c.req_id,c.ord`)
            .all(generation, call.call_id);
          const results = db.query<ResultWork, [string, string]>(`
            SELECT w.req_id,w.ord,w.path,w.call_id,w.preview,w.traversal_ord,w.confirmed
            FROM derive_result_work w
            JOIN derive_request_result d ON d.generation=w.generation AND d.req_id=w.req_id
            WHERE w.generation=? AND w.call_id=? AND COALESCE(d.chain_role,'main')<>'aux'
            ORDER BY w.traversal_ord,w.req_id,w.ord,w.path`).all(generation, call.call_id);
          let state: 'pending' | 'ambiguous' | 'resolved' =
            candidates.length > 1 ? 'ambiguous' : 'pending';
          let location: ResultWork | null = null;
          for (const result of results) {
            if (candidates.length > 1) { location = result; continue; }
            if (call.traversal_ord >= result.traversal_ord) continue;
            if (state === 'resolved') continue;
            if (result.confirmed === 0) {
              if (location === null) location = result;
              continue;
            }
            state = 'resolved';
            location = result;
            break;
          }
          db.run(`INSERT INTO derive_tool_result(generation,req_id,ord,call_id,tool_name,
            result_req,result_ord,result_path,state,algorithm_version,basis_json,retention_state)
            VALUES (?,?,?,?,?,?,?,?,?,?,'{}','recomputed')`,
            [generation, call.req_id, call.ord, call.call_id, call.tool_name,
              location?.req_id ?? null, location?.ord ?? null, location?.path ?? null,
              state, DERIVE_ALGORITHM]);
          if (performance.now() - callStart > budget.maxRequestMs) {
            throw new Error('slice_tool_budget');
          }
          writes += 1;
        }
      }
      db.run('UPDATE derive_generation SET tool_cursor_ord=?,tool_count=tool_count+? WHERE generation=?',
        [requests[requests.length - 1]!.traversal_ord, writes, generation]);
    }).immediate();
    return advanced(generation, 'tools', writes, started);
  });
}
```

- [ ] **Step 4：验证结果覆盖。** 工具阶段结束后，每个 call work 必须恰好有一行 `derive_tool_result`；数量不符时 `slice_tool_coverage` 并丢弃。`tool_count` 只数本代结果行，不能沿用 C 的 `published_revision` 计数。

- [ ] **Step 5：运行。** Run: `bun test tests/derive-slice.test.ts -t '工具切片'`。Expected: PASS。再 Run: `bun test tests/derive.test.ts -t '工具'`。Expected: PASS，A 的同步配对未被改动。

- [ ] **Step 6：提交。** 获授权后：

```bash
git add src/derive-slice.ts tests/derive-slice.test.ts \
  .agents/notes/implemented/feature/2026-10-22-atc-sliced-tool-pairing.md
git commit -m "feat(derive): slice tool candidate pairing" \
  -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

**Step 7（执行时的偏差记录）**

1. **`derive_result_work.confirmed` 必须由角色阶段写。** 计划把它留成物化时的 0，但它的判据是"结果的 ord 落在确定增量里"，而增量只有角色阶段算完才有。不写的后果是：所有结果都不算本轮新增，配对只能建立 `pending` 候选——唯一配对永远升不到 `resolved`。现在在 `finishRoleWork` 结算关系时按同步的 `ordinalConfirmed` 写回（`first` 全部算，`confirmed` 只看增量的 ord，其余不算）。端到端用例（两笔请求、一次工具往返）第一次跑就是这个缺口。
2. **候选与行的筛选按 `purpose_chain`，不按 `chain_role`。** 计划写的是 `COALESCE(d.chain_role,'main')<>'aux'`。D 之后链身份与工具配对的判据就是 `purpose_chain`；`chain_role` 是角色传播的产物，两者在封闭域下等价，但一个是事实、一个是推论。按事实筛。
3. **`tool_count` 由工具阶段累加。** 计划没写它，而 `publishGeneration` 的覆盖校验要求它等于本代工具结果行数；停在 0 的话每一代都发布不了。
4. **`retention_state` 恒为 `recomputed`。** 同步要把正文已回收的请求在 `tool_call` 旧表上标 `retained`，因为那是跨轮持久表、里面有历史行。切片的 `derive_tool_result` 每代新建：正文不可读的请求根本不产生候选 work 行，也就没有行需要标保留。
5. **`basis_json` 记代际身份**（`{generation, call_id, algorithm}`），不抄同步的组键——代际已经带着组身份，再存一份只会多一个可能不一致的地方。
6. **`algorithm_version` 写切片算法号。** 同步写 `GROUP_ALGORITHM`；`derive_tool_result` 也没有 `derive_version` 列（那是 `tool_call` 旧表的列）。
7. **同一 call 的结果顺序按 `(traversal_ord, req_id, ord, path)`。** 同步按消息序号加内容下标读结果；`path` 是字符串，同一条消息里多个结果时字典序与下标序可能不同。差别只落在"保留首次位置"这一条上，且只在同一条消息里出现重复 `call_id` 这种病态输入才显现；不为它再加一列排序键。
8. **`slice_tool_coverage` 这个收尾校验今天是**不可能触发的**：它的筛选条件（参与用途 + 有结果行）与配对函数自己早期返回的条件是同一套，凡是进不了配对的行也进不了这条校验。留着它是因为它断言的是阶段边界上的不变量（"参与请求的每一笔候选都有结果行"），而这条不变量目前由配对函数的实现细节保证；代价是每代一次 COUNT 查询。`publishGeneration` 的 `tools === tool_count` 是同一件事的另一个说法（计数相等）。
9. **一步一页一个写事务，丢弃在失败事务之外。** 与 Task 15/16 同一条实测结论。
10. **Step 2（验证失败）没有作为红灯步骤执行。** 与前三项同样的情况：实现与测试同一轮写出。

### Task 18：完成、发布、磁盘预算与失效回收

**Files:**
- Modify: `src/derive-slice.ts`
- Modify: `src/derive.ts`（按 A Task 1 Interfaces 已列出的导出一一对应：类型 `LogicalRow`、`ResolvedTool`，`uncertainOrderIds`、`fingerprintsOf`、`toolResultPreview`，以及既有 `firstUserPreview`、`tailUserPreview`、`messageAt`、`deriveTitle`、`previewOf`、`replyInfoOf`；这些只暴露取值与格式化，不含事务步骤。不请求导出 `clock`；`modelTimeTitle` 仍从 `src/sources/magpie.ts` 导入）
- Modify: `src/main.ts`
- Modify: `src/maintenance.ts`
- Modify: `src/config.ts`（仅分支 B 增加可选 `deriveBudget`）
- Modify: `scripts/backfill-fingerprint.ts`
- Test: `tests/derive-slice.test.ts`
- Test: `tests/maintenance.test.ts`
- Agent Note: `.agents/notes/implemented/feature/2026-10-22-atc-slice-ready-invalidation.md`

**Interfaces:**
- Consumes: Task 17 的完整 `derive_tool_result`、`derive_generation.staged_bytes`、`Config.deriveBudget`。
- Produces: `sliceReadyStage`、`sliceGroupStep`、`drainDeriveEntry`；`Store.deriveBudget?`；发布后构建期表清理与 retired 代际上限。

- [ ] **Step 1：写完成与失效测试。** 覆盖摘要阶段写标题与工具结果预览、排除用途行不从用户增量取标题、发布、覆盖校验、暂存超预算丢弃、迟到修订失效、retired 上限、热点轮转。

```ts
test('summary阶段写标题与工具结果预览并发布', () => {
  const f = fixture();
  try {
    f.store.write(db => {
      db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
        body_state,derive_version,have,created_at,updated_at,title,title_source,
        input_epoch,input_revision,purpose_revision,purpose_version,purpose_chain,req_kind,
        model_served)
        VALUES (1,'c','a','known',100,'2026-10-22','hook','available',0,1,1,1,
          NULL,NULL,'e1',1,11,1,'participate','chat','模型X'),
               (2,'c','a','known',200,'2026-10-22','hook','available',0,1,1,1,
          NULL,NULL,'e1',1,11,1,'participate','chat','模型X')`);
      db.run(`INSERT INTO derive_queue(conv_key,actor,from_sort,group_epoch,input_revision,
        published_revision,target_algorithm,state,dirty_since_ms)
        VALUES ('c','a','','g1',1,0,5,'dirty',1)`);
    });
    const generation = beginGeneration(f.store, 'c', 'a', 10)!;
    f.store.write(db => {
      db.run(`INSERT INTO derive_request_result(generation,req_id,input_epoch,input_revision,
        started_ms,traversal_ord,purpose_revision,purpose_version,chain_role,delta_ordinals,
        algorithm,retention_state,basis_json)
        VALUES (?,1,'e1',1,100,0,11,1,'main','[0]',5,'recomputed','{}'),
               (?,2,'e1',1,200,1,11,1,'main','[0]',5,'recomputed','{}')`,
        [generation, generation]);
      db.run(`INSERT INTO derive_call_work(generation,req_id,ord,call_id,tool_name,
        request_index,traversal_ord) VALUES (?,1,0,'call-1','read',0,0)`, [generation]);
      db.run(`INSERT INTO derive_result_work(generation,req_id,ord,path,call_id,preview,
        request_index,traversal_ord,confirmed)
        VALUES (?,2,0,'0','call-1','tool result text',1,1,1)`, [generation]);
      db.run(`INSERT INTO derive_tool_result(generation,req_id,ord,call_id,tool_name,
        result_req,result_ord,result_path,state,algorithm_version,basis_json,retention_state)
        VALUES (?,1,0,'call-1','read',2,0,'0','resolved',5,'{}','recomputed')`, [generation]);
      db.run(`UPDATE derive_generation SET stage='summary',summary_cursor_ord=-1,
        request_count=2,tool_count=1 WHERE generation=?`, [generation]);
    });
    let step = sliceSummaryStage(f.store, generation, DEFAULT_DERIVE_BUDGET, 20);
    while (step.status === 'advanced' && step.stage === 'summary') {
      step = sliceSummaryStage(f.store, generation, DEFAULT_DERIVE_BUDGET, 20);
    }
    expect(step.stage).toBe('ready');
    const row = f.store.read.query(`SELECT input_preview,input_preview_kind,title
      FROM derive_request_result WHERE generation=? AND req_id=2`).get(generation) as any;
    expect(row.input_preview).toBe('工具结果 · tool result text');
    expect(row.input_preview_kind).toBe('tool_result');
    expect(typeof row.title).toBe('string');
    const published = sliceReadyStage(f.store, generation, DEFAULT_DERIVE_BUDGET, 20,
      join(f.dir, 'trace.db'));
    expect(published.status).toBe('published');
    expect((f.store.read.query('SELECT * FROM derive_queue').get() as any).published_generation)
      .toBe(generation);
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM derive_chain_work WHERE generation=?')
      .get(generation)).toEqual({ n: 0 });
  } finally { f.close(); }
});

test('排除用途的行不从用户增量取标题', () => {
  const run = (modelTitle: string | null) => {
    const f = fixture();
    try {
      f.store.write(db => {
        db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
          body_state,derive_version,have,created_at,updated_at,title,title_source,
          input_epoch,input_revision,purpose_revision,purpose_version,purpose_chain,req_kind,
          model_title,model_served)
          VALUES (1,'c','a','known',100,'2026-10-22','hook','available',0,1,1,1,
            '旁路旧标题','user_delta','e1',1,11,1,'exclude','chat',?, '模型X')`, [modelTitle]);
        db.run(`INSERT INTO derive_queue(conv_key,actor,from_sort,group_epoch,input_revision,
          published_revision,target_algorithm,state,dirty_since_ms)
          VALUES ('c','a','','g1',1,0,5,'dirty',1)`);
      });
      persistBody(f.store, 1, {
        protocol: 'anthropic',
        request: { messages: [{ role: 'user', content: [{ type: 'text', text: '用户增量标题' }] }] },
        reply: { id: 'msg_1', content: [{ type: 'text', text: 'ok' }] },
        redact_version: 1,
      });
      const generation = beginGeneration(f.store, 'c', 'a', 10)!;
      f.store.write(db => {
        // 正常流程里 aux 行由匹配阶段给出 delta=null，走不到 delta 分支；
        // 这里直接写非空 delta，专门触发 delta 分支里的 aux 判据。
        db.run(`INSERT INTO derive_request_result(generation,req_id,input_epoch,input_revision,
          started_ms,traversal_ord,purpose_revision,purpose_version,chain_role,delta_ordinals,
          algorithm,retention_state,basis_json)
          VALUES (?,1,'e1',1,100,0,11,1,'aux','[0]',5,'recomputed','{}')`, [generation]);
        db.run(`UPDATE derive_generation SET stage='summary',summary_cursor_ord=-1,
          request_count=1 WHERE generation=?`, [generation]);
      });
      let step = sliceSummaryStage(f.store, generation, DEFAULT_DERIVE_BUDGET, 20);
      while (step.status === 'advanced' && step.stage === 'summary') {
        step = sliceSummaryStage(f.store, generation, DEFAULT_DERIVE_BUDGET, 20);
      }
      expect(step.stage).toBe('ready');
      return f.store.read.query(`SELECT title,title_source,input_preview,input_preview_kind
        FROM derive_request_result WHERE generation=? AND req_id=1`).get(generation) as any;
    } finally { f.close(); }
  };
  // model_title 为空：标题保持时间兜底，不写由用户增量推导的标题，也不沿用库里旧标题。
  const plain = run(null);
  expect(plain.title_source).toBe('model_time');
  expect(plain.title).not.toContain('用户增量标题');
  expect(plain.title).not.toBe('旁路旧标题');
  // 输入摘要仍走同一 delta 分支，不显示成标题请求。
  expect(plain.input_preview_kind).toBe('delta');
  expect(plain.input_preview).toContain('用户增量标题');
  // model_title 存在：保持模型标题来源，同样不取用户增量。
  const titled = run('模型标题');
  expect(titled).toMatchObject({ title: '模型标题', title_source: 'model_title' });
  expect(titled.title).not.toContain('用户增量标题');
});

test('组修订在阶段间变化时丢弃代际', () => {
  const f = fixture();
  try {
    seedGroup(f);
    const generation = beginGeneration(f.store, 'c', 'a', 10)!;
    f.store.write(db => db.run(`UPDATE derive_queue SET input_revision=8
      WHERE conv_key='c' AND actor='a'`));
    const step = sliceRolesStage(f.store, generation, DEFAULT_DERIVE_BUDGET, 20);
    expect(step.status).toBe('discarded');
    expect((f.store.read.query('SELECT * FROM derive_queue').get() as any).published_generation)
      .toBeNull();
  } finally { f.close(); }
});

test('暂存超预算与retired上限', () => {
  const f = fixture();
  try {
    seedGroup(f);
    const generation = beginGeneration(f.store, 'c', 'a', 10)!;
    f.store.write(db => db.run(`UPDATE derive_generation SET stage='ready',request_count=1,
      staged_bytes=? WHERE generation=?`,
      [DEFAULT_DERIVE_BUDGET.maxStagedBytes + 1, generation]));
    const step = sliceReadyStage(f.store, generation,
      { ...DEFAULT_DERIVE_BUDGET, maxStagedBytes: 1 }, 20, join(f.dir, 'trace.db'));
    expect(step.status).toBe('discarded');
    expect(f.store.read.query('SELECT state FROM derive_generation WHERE generation=?')
      .get(generation)).toEqual({ state: 'discarded' });
  } finally { f.close(); }
});

test('多个dirty组按last_claimed轮转', () => {
  const f = fixture();
  try {
    f.store.write(db => {
      for (const [actor, key] of [['a', 'c1'], ['b', 'c2']] as const) {
        db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
          body_state,derive_version,have,created_at,updated_at,input_epoch,input_revision,
          purpose_revision,purpose_version,req_kind)
          VALUES (?,?,?,'known',1,'2026-10-22','hook','pending',0,1,1,1,'e1',1,0,1,'chat')`,
          [actor === 'a' ? 1 : 2, key, actor]);
        db.run(`INSERT INTO derive_queue(conv_key,actor,from_sort,group_epoch,input_revision,
          published_revision,target_algorithm,state,dirty_since_ms)
          VALUES (?,?,'','g1',1,0,5,'dirty',1)`, [key, actor]);
      }
    });
    const runtime = { budget: DEFAULT_DERIVE_BUDGET, dataDir: f.dir,
      dbPath: join(f.dir, 'trace.db') };
    const first = sliceGroupStep(f.store, runtime, 1000);
    const second = sliceGroupStep(f.store, runtime, 1001);
    expect(first.status).not.toBe('idle');
    expect(second.status).not.toBe('idle');
    expect(f.store.read.query(`SELECT DISTINCT actor FROM derive_queue
      WHERE last_claimed_ms IS NOT NULL ORDER BY actor`).all())
      .toEqual([{ actor: 'a' }, { actor: 'b' }]);
  } finally { f.close(); }
});
```

- [ ] **Step 2：验证失败。** Run: `bun test tests/derive-slice.test.ts -t 'ready阶段'`。Expected: FAIL，`sliceReadyStage` 不存在。

- [ ] **Step 3：实现概述阶段与完成阶段。** 先按 A 的顺序在工具配对之后写标题、输入摘要与回复摘要（展示分支逐条复刻 A 的 `writePresentationTx`，见下方说明）；再做覆盖、basis 大小与修订校验，最后调用 Task 14 的发布。磁盘/WAL 检查在写事务外执行，避免 checkpoint 与 writer 事务互相阻塞。

```ts
export type SliceRuntime = { budget: DeriveBudget; dataDir: string; dbPath: string };

function walBytes(dbPath: string): number {
  try { return statSync(`${dbPath}-wal`).size; } catch { return 0; }
}

type SummaryRow = {
  req_id: number; traversal_ord: number; started_ms: number; delta_ordinals: string | null;
  purpose_chain: string; req_kind: string | null; model_served: string | null;
  model_title: string | null; live_title: string | null; live_title_source: string | null;
  live_input_preview: string | null; live_input_preview_kind: string | null;
  live_reply_preview: string | null;
  staged_purpose_revision: number; live_purpose_revision: number;
};

export function sliceSummaryStage(store: Store, generation: string,
  budget: DeriveBudget, now: number): SliceStep {
  const started = performance.now();
  return store.write(db => {
    const gen = one<{ state: string; stage: string; conv_key: string; actor: string;
      input_revision: number; summary_cursor_ord: number }>(db, `SELECT state,stage,conv_key,
      actor,input_revision,summary_cursor_ord FROM derive_generation WHERE generation=?`,
      [generation]);
    if (gen === null || gen.state !== 'building') return idle(generation, gen?.stage ?? null);
    if (gen.stage !== 'summary') return advanced(generation, gen.stage, 0, started);
    if (!assertQueueRevision(db, gen)) {
      discardGeneration(db, generation, 'slice_group_revision_changed', now);
      return discarded(generation, started);
    }
    const page = db.query<SummaryRow, [string, number, number]>(`
      SELECT d.req_id,d.traversal_ord,d.started_ms,d.delta_ordinals,
        d.purpose_revision AS staged_purpose_revision,r.purpose_revision AS live_purpose_revision,
        r.purpose_chain,r.req_kind,r.model_served,r.model_title,r.title AS live_title,
        r.title_source AS live_title_source,r.input_preview AS live_input_preview,
        r.input_preview_kind AS live_input_preview_kind,r.reply_preview AS live_reply_preview
      FROM derive_request_result d JOIN request r ON r.req_id=d.req_id
      WHERE d.generation=? AND r.actor_state='known' AND d.traversal_ord>?
      ORDER BY d.traversal_ord LIMIT ?`)
      .all(generation, gen.summary_cursor_ord, Math.min(50, budget.maxCandidatesPerBatch));
    if (page.length === 0) {
      db.run(`UPDATE derive_generation SET stage='ready',ready_cursor_ord=-1 WHERE generation=?`,
        [generation]);
      return advanced(generation, 'ready', 0, started);
    }
    // 本页的已配对工具一次读出，按 A 的 ResolvedTool 形状交给 A 导出的 toolResultPreview；
    // 名称因此来自本代已 resolve 的关联，不读已发布的 tool_call 旧值。
    const ids = page.map(row => row.req_id);
    const placeholders = ids.map(() => '?').join(',');
    const associations = db.query<ResolvedTool, unknown[]>(`
      SELECT req_id AS callReq,ord AS callOrd,call_id AS callId,tool_name AS name,
        result_req AS resultReq,result_ord AS resultOrd,result_path AS resultPath
      FROM derive_tool_result WHERE generation=? AND state='resolved'
        AND req_id IN (${placeholders})`).all(generation, ...ids);
    let writes = 0;
    db.transaction(() => {
      for (const row of page) {
        const rowStart = performance.now();
        // 分类器在同一写入里更新 purpose_chain/req_kind/model_title 并 bump purpose_revision；
        // 修订不同说明用途分类已变，本次代际作废，不用新分类配旧链结果。
        if (row.live_purpose_revision !== row.staged_purpose_revision) {
          throw new Error('slice_purpose_revision_changed');
        }
        const current = fingerprintsOf(db, row.req_id);
        const replyInfo = current === null
          ? { preview: row.live_reply_preview, modelTitle: null }
          : replyInfoOf(db, row.req_id);
        const isTitle = row.req_kind === 'title';
        const isAux = row.purpose_chain === 'exclude';
        const modelTitle = replyInfo.modelTitle ?? row.model_title;
        const delta = row.delta_ordinals === null ? null
          : JSON.parse(row.delta_ordinals) as number[];
        const fallback = modelTimeTitle(row.model_served, row.started_ms);
        let title = fallback;
        let source: 'user_delta' | 'model_time' | 'model_title' = 'model_time';
        let inputPreview: string | null = null;
        let inputKind: 'delta' | 'tail' | 'tool_result' | 'title' | null = null;
        if (isTitle) {
          title = modelTitle ?? (current === null ? row.live_title ?? fallback : fallback);
          source = modelTitle !== null ? 'model_title'
            : current === null && row.live_title_source === 'model_title'
              ? 'model_title' : 'model_time';
          inputPreview = firstUserPreview(db, row.req_id) ?? '生成会话标题';
          inputKind = 'title';
        } else if (current === null) {
          title = row.live_title ?? fallback;
          source = row.live_title_source === 'user_delta' || row.live_title_source === 'model_time'
            || row.live_title_source === 'model_title' ? row.live_title_source : 'model_time';
          inputPreview = row.live_input_preview;
          inputKind = row.live_input_preview_kind === 'delta'
            || row.live_input_preview_kind === 'tail'
            || row.live_input_preview_kind === 'tool_result'
            || row.live_input_preview_kind === 'title'
            ? row.live_input_preview_kind : null;
        } else if (delta !== null && delta.length > 0) {
          const messages = delta.map(ordinal => messageAt(db, row.req_id, ordinal));
          if (isAux) {
            // 排除用途的非标题行不得从用户增量取标题：保持模型标题或时间兜底，
            // 不调 deriveTitle；输入摘要仍按同一 delta 分支取值。
            title = modelTitle ?? fallback;
            source = modelTitle !== null ? 'model_title' : 'model_time';
          } else {
            const derived = deriveTitle(messages, delta.map((_, index) => index), fallback);
            title = derived.title;
            source = derived.source;
          }
          const fresh = previewOf(messages);
          if (fresh !== null) { inputPreview = fresh; inputKind = 'delta'; }
          else {
            inputPreview = toolResultPreview(db, row.req_id, delta, associations);
            inputKind = inputPreview === null ? null : 'tool_result';
          }
        } else if (delta !== null) {
          inputPreview = '输入是上一轮的工具结果，没有新的用户消息';
          inputKind = 'tool_result';
        } else {
          inputPreview = tailUserPreview(db, row.req_id);
          inputKind = inputPreview === null ? null : 'tail';
        }
        const replyPreview = current === null ? row.live_reply_preview : replyInfo.preview;
        db.run(`UPDATE derive_request_result SET title=?,title_source=?,input_preview=?,
          input_preview_kind=?,reply_preview=?,retention_state=? WHERE generation=? AND req_id=?`,
          [title, source, inputPreview, inputKind, replyPreview,
            current === null ? 'retained' : 'recomputed', generation, row.req_id]);
        if (performance.now() - rowStart > budget.maxRequestMs) {
          throw new Error('slice_summary_budget');
        }
        writes += 1;
      }
      db.run(`UPDATE derive_generation SET summary_cursor_ord=? WHERE generation=?`,
        [page[page.length - 1]!.traversal_ord, generation]);
    }).immediate();
    return advanced(generation, 'summary', writes, started);
  });
}

export function sliceReadyStage(store: Store, generation: string,
  budget: DeriveBudget, now: number, dbPath: string): SliceStep {
  const started = performance.now();
  // checkpoint 必须在事务外；只做 PASSIVE，不强迫其它读者退出。
  if (walBytes(dbPath) > budget.maxWalGrowthBytes) store.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  return store.write(db => {
    const gen = one<{ state: string; stage: string; conv_key: string; actor: string;
      input_revision: number; request_count: number; tool_count: number;
      staged_bytes: number }>(db, `SELECT state,stage,conv_key,actor,input_revision,
      request_count,tool_count,staged_bytes FROM derive_generation WHERE generation=?`,
      [generation]);
    if (gen === null || gen.state !== 'building') return idle(generation, gen?.stage ?? null);
    if (gen.stage !== 'ready') return advanced(generation, gen.stage, 0, started);
    if (!assertQueueRevision(db, gen)) {
      discardGeneration(db, generation, 'slice_group_revision_changed', now);
      return discarded(generation, started);
    }
    if (gen.staged_bytes > budget.maxStagedBytes || walBytes(dbPath) > budget.maxWalGrowthBytes) {
      discardGeneration(db, generation, 'slice_disk_budget', now);
      return discarded(generation, started);
    }

    const oversizedBasis = n(db, `SELECT COUNT(*) FROM derive_request_result
      WHERE generation=? AND length(CAST(basis_json AS BLOB))>4096`, [generation])
      + n(db, `SELECT COUNT(*) FROM derive_tool_result
      WHERE generation=? AND length(CAST(basis_json AS BLOB))>4096`, [generation]);
    if (oversizedBasis !== 0) {
      discardGeneration(db, generation, 'slice_basis_budget', now);
      return discarded(generation, started);
    }

    // 逐请求修订在 ready 阶段分批比较；发布事务不重新扫整组结果。
    const stale = n(db, `SELECT COUNT(*) FROM derive_request_result d
      JOIN request r ON r.req_id=d.req_id
      WHERE d.generation=? AND r.actor_state='known'
        AND (r.input_revision<>d.input_revision OR r.purpose_revision<>d.purpose_revision)`,
      [generation]);
    if (stale !== 0) {
      discardGeneration(db, generation, 'slice_stamp_invalidated', now);
      return discarded(generation, started);
    }

    const missingCalls = n(db, `SELECT COUNT(*) FROM derive_call_work c
      WHERE c.generation=? AND COALESCE((SELECT d.chain_role FROM derive_request_result d
        WHERE d.generation=c.generation AND d.req_id=c.req_id),'main')<>'aux'
        AND NOT EXISTS (SELECT 1 FROM derive_tool_result t
        WHERE t.generation=c.generation AND t.req_id=c.req_id AND t.ord=c.ord)`, [generation]);
    const missingRequests = n(db, `SELECT COUNT(*) FROM request r
      WHERE r.conv_key=? AND r.actor=? AND r.actor_state='known'
        AND NOT EXISTS (SELECT 1 FROM derive_request_result d
        WHERE d.generation=? AND d.req_id=r.req_id)`, [gen.conv_key, gen.actor, generation]);
    const requests = n(db, `SELECT COUNT(*) FROM request
      WHERE conv_key=? AND actor=? AND actor_state='known'`, [gen.conv_key, gen.actor]);
    if (missingCalls !== 0 || missingRequests !== 0 || requests !== gen.request_count) {
      discardGeneration(db, generation, 'slice_coverage_budget', now);
      return discarded(generation, started);
    }
    db.run(`UPDATE derive_generation SET state='ready',stage='done' WHERE generation=?`,
      [generation]);
    if (!publishGeneration(db, generation, now)) {
      return discarded(generation, started);
    }
    db.run('DELETE FROM derive_chain_work WHERE generation=?', [generation]);
    db.run('DELETE FROM derive_role_work WHERE generation=?', [generation]);
    gcRetired(db, gen.conv_key, gen.actor, budget.maxRetiredGenerations);
    return { status: 'published', generation, stage: 'done', rows: 0,
      batch_ms: performance.now() - started };
  });
}

function gcRetired(db: Database, convKey: string, actor: string, keep: number): void {
  const old = db.query<{ generation: string }, [string, string, number]>(`
    SELECT generation FROM derive_generation
    WHERE conv_key=? AND actor=? AND state='retired'
    ORDER BY published_at DESC LIMIT -1 OFFSET ?`).all(convKey, actor, keep);
  for (const row of old) {
    db.run('DELETE FROM derive_result_work WHERE generation=?', [row.generation]);
    db.run('DELETE FROM derive_call_work WHERE generation=?', [row.generation]);
    db.run('DELETE FROM derive_chain_work WHERE generation=?', [row.generation]);
    db.run('DELETE FROM derive_role_work WHERE generation=?', [row.generation]);
    db.run('DELETE FROM derive_tool_result WHERE generation=?', [row.generation]);
    db.run('DELETE FROM derive_request_result WHERE generation=?', [row.generation]);
    db.run('DELETE FROM derive_generation WHERE generation=?', [row.generation]);
  }
}
```

`gcRetired` 只删除超过 `maxRetiredGenerations` 的 retired 代，当前 published 与最近两代原算法结果保留。若产品要求保留更多历史，调大预算值，不改变发布指针。

`sliceSummaryStage` 的展示选择是 `writePresentationTx` 的逐条转录，且验收基准是**D 之后的**同步路径，不是 A 的裸实现；执行者不要按 A 在 D 之前的旧分支去对齐。分支顺序固定为 `isTitle` → `current === null` → `delta.length > 0` → `delta !== null` → `else`；`fallback` 恒为 `modelTimeTitle(row.model_served,row.started_ms)`，不把库里旧标题提前塞进 fallback；`source` 提升保留 `current === null && 标题来源为 model_title` 那一支。只允许两处替换：

- 读值全部取当前 `request` 行（`r.title`、`r.title_source`、`r.input_preview`、`r.input_preview_kind`、`r.reply_preview`、`r.model_served`、`r.model_title`、`r.req_kind`、`r.purpose_chain`），不取本代 `derive_request_result` 里的暂存值；写回目标是 `derive_request_result`。
- `toolResultPreview(db, reqId, delta, associations)` 直接调 A 导出的那份，`associations` 由本代 `derive_tool_result` 的 resolved 行按 A 的 `ResolvedTool` 形状拼出；因此名称选取、内容兜底、同名合并计数与字符截断都只有 A 一份实现，F 不复制，也不读已发布的 `tool_call` 旧值。

D 的 aux 规则也在 delta 分支内照写：`isAux && !isTitle` 且正文可比较、`delta` 非空时，`title = modelTitle ?? fallback`、`source = modelTitle !== null ? 'model_title' : 'model_time'`，不调 `deriveTitle`，输入摘要仍走 `previewOf`/`toolResultPreview`；`isAux && !isTitle` 且 `current === null` 时不因 aux 改写，照样保留库里旧标题与旧来源（与其它行共用第二个分支）。`isTitle` 优先于 `isAux`：`req_kind='title'` 且用途为排除的行走标题分支，保持 A 的标题取值、`model_title` 来源提升与 `生成会话标题` 输入摘要。注意正常流程里 aux 行由匹配阶段给出 `delta = null`，所以 delta 分支的 aux 判据是防御性的，只有暂存行被写成非空 delta 时才生效（见下方定向用例）。

`retention_state` 与 `body_state` 不参与分支选择：`current = fingerprintsOf(db, req_id)` 是分支用的唯一可读性判据（与角色阶段同源），只有 `current === null` 才写 `retention_state='retained'`，否则 `'recomputed'`。`delta` 由 `delta_ordinals` 还原成 A 的 `match.delta`（`null` 表示 branch/unknown，空数组表示首次即无可比增量），两种取值都要保留区别。

标题判定与链参与判定是两个不同谓词，不合并：标题字段走 `row.req_kind === 'title'`（D 的 Task 4 原文：标题字段仍只给真正的标题请求，不要把排除用途都当标题），链身份与工具配对才用 `row.purpose_chain === 'exclude'`。合并会让一笔被排除但不是标题请求的行拿到 `input_preview_kind='title'` 与 `生成会话标题`，同步侧不这样写，等价性用例会失败。若 A 的最终实现保留了原式里的 `replyInfo.modelTitle !== null ||` 析取项，F 照抄同一析取，不能只留一半。

本段依赖的导出：`fingerprintsOf`、`replyInfoOf`、`deriveTitle`、`previewOf`、`messageAt`、`firstUserPreview`、`tailUserPreview`、`toolResultPreview` 与类型 `ResolvedTool` 来自 `src/derive.ts`（都是既有私有函数，A 只加导出）；`modelTimeTitle` 已是 `src/sources/magpie.ts` 的既有导出，F 只加导入。`purpose_revision` 逐行校验依赖 D 的分类器在同一写入里更新 `purpose_chain`/`req_kind`/`model_title` 并 bump 该修订；不一致即抛 `slice_purpose_revision_changed`，由 `sliceGroupStep` 转成丢弃。

- [ ] **Step 4：实现组选择与轮转。** `sliceGroupStep` 每次最多推进一个组的一个阶段批次，更新 `last_claimed_ms`。选择顺序是：先继续已有 `compute_generation`，否则选最久未认领的 dirty 组，按 `dirty_since_ms` 打破平局。这样单个长组不会连续占满事件循环。

```ts
export function sliceGroupStep(store: Store, runtime: SliceRuntime,
  now: number, scope?: { convKey: string }): SliceStep {
  const candidate = store.read.query<{ conv_key: string; actor: string;
    compute_generation: string | null }, [string]>(`
    SELECT conv_key,actor,compute_generation FROM derive_queue
    WHERE state<>'clean' AND (? IS NULL OR conv_key=?)
    ORDER BY last_claimed_ms IS NOT NULL, last_claimed_ms, dirty_since_ms, conv_key, actor
    LIMIT 1`)
    .get(scope?.convKey ?? null, scope?.convKey ?? null);
  if (candidate === null) return { status: 'idle', generation: null, stage: null, rows: 0, batch_ms: 0 };
  const generation = candidate.compute_generation ??
    beginGeneration(store, candidate.conv_key, candidate.actor, now);
  if (generation === null) return { status: 'rotated', generation: null, stage: null, rows: 0, batch_ms: 0 };
  const gen = store.read.query('SELECT stage FROM derive_generation WHERE generation=?')
    .get(generation) as { stage: string } | null;
  if (gen === null) return { status: 'idle', generation: null, stage: null, rows: 0, batch_ms: 0 };
  const stage = gen.stage === 'requests' ? sliceRequestsStage
    : gen.stage === 'roles' || gen.stage === 'role_assign' ? sliceRolesStage
    : gen.stage === 'tools' ? sliceToolsStage
    : gen.stage === 'summary' ? sliceSummaryStage : null;
  store.write(db => db.run(`UPDATE derive_queue SET last_claimed_ms=?
    WHERE conv_key=? AND actor=?`, [now, candidate.conv_key, candidate.actor]));
  try {
    return stage === null
      ? sliceReadyStage(store, generation, runtime.budget, now, runtime.dbPath)
      : stage(store, generation, runtime.budget, now);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'slice_stage_failed';
    discardGeneration(store.db, generation, reason, now);
    return { status: 'discarded', generation, stage: null, rows: 0, batch_ms: 0 };
  }
}

export function drainDeriveEntry(store: Store, limit = 100,
  scope?: { convKey: string }): DrainResult {
  if (store.deriveBudget === undefined) {
    return store.write(db => drainDeriveTx(db, { limit, scope }));
  }
  const processed: { conv_key: string; actor: string }[] = [];
  let published = 0;
  let discarded = 0;
  const started = Date.now();
  for (let index = 0; index < limit; index++) {
    const step = sliceGroupStep(store, store.deriveRuntime!, Date.now(),
      scope === undefined ? undefined : { convKey: scope.convKey });
    if (step.status === 'idle') break;
    if (step.status === 'published') {
      published += 1;
      const row = store.read.query(`SELECT g.conv_key,g.actor FROM derive_generation g
        WHERE g.generation=?`).get(step.generation) as { conv_key: string; actor: string } | null;
      if (row !== null) processed.push(row);
    }
    if (step.status === 'discarded') discarded += 1;
  }
  const remaining = store.read.query<{ n: number }, [string]>(`
    SELECT COUNT(*) AS n FROM derive_queue WHERE state<>'clean'
      AND (? IS NULL OR conv_key=?)`).get(scope?.convKey ?? null, scope?.convKey ?? null)!.n;
  return { processed: published, remaining, groups: processed,
    recomputed: 0, retained: 0, discarded, batch_ms: Date.now() - started };
}
```

`DrainResult` 在分支 B 扩展 `discarded` 与 `batch_ms`；A 的同步入口返回相同字段（`discarded:0`），所以三个调用点不需要分支。`sliceGroupStep` 的 `stage` 调用签名对 `sliceRequestsStage` 等是 `(store,generation,budget,now)`；`sliceReadyStage` 多一个 `dbPath`，在包装里统一传参，不另造第二个入口。

- [ ] **Step 5：接入配置与启动。** 分支 B 在 `Config` 增加可选 `deriveBudget?: DeriveBudget`；`startCollector(config)` 在 `openStore` 后设置 `store.deriveBudget = config.deriveBudget`、`store.deriveRuntime = { budget: config.deriveBudget ?? DEFAULT_DERIVE_BUDGET, dataDir: config.dataDir, dbPath: store.path }`，并在定时器启动前 `recoverSlice`。`main.ts`、`maintenance.ts`、`scripts/backfill-fingerprint.ts` 的 drain 调用统一改成 `drainDeriveEntry(store, limit, scope)`。

- [ ] **Step 6：运行。** Run: `bun test tests/derive-slice.test.ts tests/maintenance.test.ts`。Expected: PASS。再 Run: `bun run typecheck`。Expected: PASS。确认 keep-sync 分支不创建 `src/derive-slice.ts`，因此 `Config.deriveBudget` 的类型引用只在分支 B 存在。

- [ ] **Step 7：提交。** 获授权后：

```bash
git add src/derive-slice.ts src/main.ts src/maintenance.ts src/config.ts \
  scripts/backfill-fingerprint.ts tests/derive-slice.test.ts tests/maintenance.test.ts \
  .agents/notes/implemented/feature/2026-10-22-atc-slice-ready-invalidation.md
git commit -m "feat(derive): slice ready stage with disk budgets and invalidation" \
  -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 19：等价性、切片容量门槛与交接

**Files:**
- Modify: `scripts/capacity.ts`
- Modify: `scripts/capacity-gate.ts`
- Modify: `src/capacity.ts`
- Test: `tests/capacity-slice.test.ts`
- Modify: `docs/operations.md`
- Modify: `docs/architecture-design.md`
- Agent Note: `.agents/notes/implemented/feature/2026-10-22-atc-slice-equivalence.md`

**Interfaces:**
- Consumes: `drainDeriveEntry`、`Config.deriveBudget`、`CapacityBudget.slice`、`ScenarioReport.derive.published_generations/discarded_generations`。
- Produces: `comparisonSnapshot(store)`、`runEquivalenceFuzz(seed, groups)`、`long-10000-slice` 场景、切片门槛与最终交接报告。

- [ ] **Step 1：写等价性测试。** 用同一合成种子建两个独立库；一个跑 D 之后的同步 `drainDerive`（Task 19 的 oracle 就是这份同步入口，不是 A 的裸实现），另一个跑切片入口并把预算压到每批 1 行。比较请求关系、角色、标题、预览、工具状态与最终队列；比较前去掉 generation id 与时间戳。另外单独固定三处展示分支：正文不可读的标题型请求、正文可读但 `model_title` 为空的标题型请求、排除用途但不是标题的请求。

```ts
import type { Store } from '../src/store';

function comparisonSnapshot(store: Store, mode: 'sync' | 'slice'): unknown {
  const requests = mode === 'sync'
    ? store.read.query(`SELECT req_id,prev_req_id,prev_relation,delta_ordinals,chain_role,
        title,title_source,input_preview,input_preview_kind,reply_preview FROM request
        WHERE conv_key='c' AND actor='actor-a' ORDER BY req_id`).all()
    : store.read.query(`SELECT req_id,prev_req_id,prev_relation,delta_ordinals,chain_role,
        title,title_source,input_preview,input_preview_kind,reply_preview FROM effective_request
        WHERE conv_key='c' AND actor='actor-a' ORDER BY req_id`).all();
  const tools = mode === 'sync'
    ? store.read.query(`SELECT req_id,ord,call_id,tool_name,result_req,result_ord,
        result_path,state FROM tool_call WHERE req_id IN (SELECT req_id FROM request
        WHERE conv_key='c' AND actor='actor-a') ORDER BY req_id,ord`).all()
    : store.read.query(`SELECT req_id,ord,call_id,tool_name,result_req,result_ord,
        result_path,state FROM derive_tool_result WHERE generation=(SELECT published_generation
        FROM derive_queue WHERE conv_key='c' AND actor='actor-a') ORDER BY req_id,ord`).all();
  return { requests, tools };
}

function seedEquivalenceCase(store: Store): void {
  seedChain(store, [['S'], ['S', 'A'], ['S', 'A', 'B'], ['OTHER']]);
  store.write(db => {
    // 一笔正文不可读、一笔 title 旁路；A 与切片都必须保留/隐藏相同字段。
    db.run("UPDATE request SET body_state='missing',title='retained title' WHERE req_id=4");
    db.run(`INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,
      day,via,body_state,derive_version,have,created_at,updated_at,title,title_source,
      sort_source,sort_key,input_epoch,input_revision,purpose_revision,purpose_version,
      purpose_chain,req_kind)
      VALUES (5,'c','session','actor-a','known',1300,'2026-10-22','hook','available',0,1,1,1,
      'title request','model_time','ledger','ledger|0005','e1',1,0,1,'exclude','title')`);
    // 用例 1：正文不可读的标题型请求，旧 title_source 是 user_delta。
    // A 先判标题分支并写 model_time；若先判不可读，就会错留 user_delta 与旧 input_preview_kind。
    db.run(`INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,
      day,via,body_state,derive_version,have,created_at,updated_at,title,title_source,
      sort_source,sort_key,input_epoch,input_revision,purpose_revision,purpose_version,
      purpose_chain,req_kind)
      VALUES (6,'c','session','actor-a','known',1400,'2026-10-22','hook','missing',0,1,1,1,
      'retained title user_delta','user_delta','ledger','ledger|0006','e1',1,0,1,'exclude','title')`);
    // 用例 2：正文可读、model_title 为空、库里有旧标题的标题型请求。
    // A 用 modelTimeTitle 兜底；若把旧标题当成 fallback，就会把库里的旧标题写成新结果。
    db.run(`INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,
      day,via,body_state,derive_version,have,created_at,updated_at,title,title_source,
      sort_source,sort_key,input_epoch,input_revision,purpose_revision,purpose_version,
      purpose_chain,req_kind,model_title)
      VALUES (7,'c','session','actor-a','known',1500,'2026-10-22','hook','available',0,1,1,1,
      '旧库里标题','user_delta','ledger','ledger|0007','e1',1,0,1,'exclude','title',NULL)`);
    // 用例 3：排除用途但不是标题请求。标题判定只看 req_kind，不能和 purpose_chain 合成一个谓词，
    // 否则这笔会拿到 input_preview_kind='title' 与「生成会话标题」。
    db.run(`INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,
      day,via,body_state,derive_version,have,created_at,updated_at,title,title_source,
      sort_source,sort_key,input_epoch,input_revision,purpose_revision,purpose_version,
      purpose_chain,req_kind)
      VALUES (8,'c','session','actor-a','known',1600,'2026-10-22','hook','available',0,1,1,1,
      '旁路旧标题','user_delta','ledger','ledger|0008','e1',1,0,1,'exclude','chat')`);
    db.run(`INSERT INTO derive_queue(conv_key,actor,from_sort,group_epoch,input_revision,
      published_revision,target_algorithm,state,dirty_since_ms)
      VALUES ('c','actor-a','','g1',1,0,5,'dirty',1)`);
  });
  // 用例 2 与 3 需要真的可读正文，否则 current 仍为 null，测不到 fallback 与标题分支的差别。
  persistBody(store, 7, {
    protocol: 'anthropic',
    request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'preferred titles' }] }] },
    reply: { id: 'msg_7', content: [{ type: 'text', text: 'ok' }] },
    redact_version: 1,
  });
  persistBody(store, 8, {
    protocol: 'anthropic',
    request: { messages: [{ role: 'user', content: [{ type: 'text', text: '旁路问题' }] }] },
    reply: { id: 'msg_8', content: [{ type: 'text', text: 'ok' }] },
    redact_version: 1,
  });
}

test('切片与A同步在压缩预算下等价', () => {
  const sync = fixture();
  const slice = fixture();
  try {
    seedEquivalenceCase(sync.store);
    seedEquivalenceCase(slice.store);
    sync.store.write(db => drainDeriveTx(db, { limit: 100 }));
    slice.store.deriveBudget = { ...DEFAULT_DERIVE_BUDGET, maxCandidatesPerBatch: 1,
      maxWritesPerBatch: 1, maxStageBatchMs: 1 };
    slice.store.deriveRuntime = { budget: slice.store.deriveBudget, dataDir: slice.dir,
      dbPath: join(slice.dir, 'trace.db') };
    for (let i = 0; i < 200; i++) {
      const result = drainDeriveEntry(slice.store, 1);
      if (result.remaining === 0) break;
    }
    expect(comparisonSnapshot(slice.store, 'slice')).toEqual(comparisonSnapshot(sync.store, 'sync'));
    expect((slice.store.read.query('SELECT state FROM derive_queue').get() as any).state)
      .toBe('clean');

    // 展示分支的三个定点：任一处与 A 不同，下面的逐行断言或上面的整体比较都会失败。
    const show = (store: Store, mode: 'sync' | 'slice') => store.read.query(`
      SELECT req_id,title,title_source,input_preview,input_preview_kind,reply_preview FROM
      ${mode === 'sync' ? 'request' : 'effective_request'}
      WHERE conv_key='c' AND actor='actor-a' AND req_id IN (6,7,8) ORDER BY req_id`).all();
    const sliceRows = show(slice.store, 'slice') as any[];
    expect(sliceRows).toEqual(show(sync.store, 'sync'));
    // 用例 1：不可读的标题型请求仍走标题分支，来源提升为 model_time。
    expect(sliceRows[0]).toMatchObject({ title_source: 'model_time',
      input_preview_kind: 'title', input_preview: '生成会话标题' });
    // 用例 2：可读且 model_title 为空时用模型与时间兜底，不沿用库里的旧标题。
    expect(sliceRows[1]?.title_source).toBe('model_time');
    expect(sliceRows[1]?.title).not.toBe('旧库里标题');
    // 用例 3：排除用途的非标题请求走普通分支，不显示成标题请求，标题也不来自用户增量。
    // 注意：正常流程里 aux 行由匹配阶段给出 delta=null，所以这里无法构造「aux 且 delta 非空」；
    // 那条 aux 判据由 `tests/derive-slice.test.ts` 的「排除用途的行不从用户增量取标题」
    // 直接写暂存行覆盖，本用例只保证整行与 D 之后的同步 oracle 逐字相同。
    expect(sliceRows[2]?.input_preview_kind).not.toBe('title');
    expect(sliceRows[2]?.title).not.toContain('旁路问题');
  } finally { sync.close(); slice.close(); }
});
```

- [ ] **Step 2：写种子模糊测试。** `seedEquivalenceCase` 使用固定 PRNG，生成 50 组、每组最多 20 请求：乱序到达、同毫秒账本偏移、缺正文、title 旁路、排除用途的非标题请求、重复 call_id、结果早于调用、迟到合并与回收墓碑。每组都跑上面的同步/切片比较；任何字段差异输出首个不同请求与生成快照，测试失败。禁止用随机时间或随机端口，种子写死。

- [ ] **Step 3：增加切片场景。** `scripts/capacity-collector.ts` 接受 `--slice`，构造 `Config` 时设置 `deriveBudget`（来自预算文件的 `slice.derive_budget`，没有则拒绝启动，不猜默认值）。`scripts/capacity.ts` 增加 `long-10000-slice`：输入与 `long-10000` 完全相同，只在启动配置中启用切片；报告写 `published_generations`、`discarded_generations`、`result_sha256`、`full_incremental_equal`，并在 `derive` 中写 `slice_budget_source`。

```ts
const scenario = { id: 'long-10000-slice', kind: 'long', sessions: 1,
  requestsPerSession: 10_000, rps: 0, slice: true };
if (config.deriveBudget === undefined) throw new Error('capacity_slice_budget_missing');
```

- [ ] **Step 4：扩展门槛。** `capacity-gate.ts` 对 `long-10000-slice` 检查：`max_write_tx_ms`、`event_loop_p99_ms`、`drain_ms`、`backlog_max_age_ms` 全部通过；`discarded_generations === 0`；`published_generations >= 1`；`full_incremental_equal === true`。任一失败退出 1；预算文件或报告缺失退出 2。切片预算的 `basis` 必须来自 `slice.source_calibration` 指向的实测报告，不能把 `max_write_tx_ms=900` 复制成 `code-constant`。

```ts
if (report.scenario === 'long-10000-slice') {
  if (report.derive.discarded_generations !== 0) {
    failures.push({ scenario: report.scenario, check: 'discarded_generations',
      actual: report.derive.discarded_generations ?? -1, limit: 0, kind: 'max', basis: 'proposed' });
  }
  if ((report.derive.published_generations ?? 0) < 1) {
    failures.push({ scenario: report.scenario, check: 'published_generations',
      actual: report.derive.published_generations ?? -1, limit: 1, kind: 'min', basis: 'proposed' });
  }
  if (report.derive.full_incremental_equal !== true) {
    failures.push({ scenario: report.scenario, check: 'full_incremental_equal',
      actual: 0, limit: 1, kind: 'max', basis: 'proposed' });
  }
}
```

- [ ] **Step 5：运行等价性与门槛测试。** Run: `bun test tests/capacity-slice.test.ts tests/derive-slice.test.ts`。Expected: PASS。Run: `bun test tests/capacity-gate.test.ts`。Expected: PASS，包括缺少 slice 预算时退出 2。不要在本计划阶段实际跑完 10,000 请求的容量场景；只运行固定种子的等价性样本和 5 秒冒烟。

- [ ] **Step 6：更新文档与决定记录。** `docs/operations.md` 增加：v5 及更低版本库拒绝普通启动、由运维删除重建（没有迁移命令，也没有续跑入口）、切片预算与 WAL 上限、`recoverSlice` 在启动时丢弃未发布代、retired 代保留上限。`docs/architecture-design.md` 增加代际键、发布指针、同快照读、旧代保留与 v6 的版本门。Agent Note 记录两个反例：逐字段 `COALESCE` 把旧标题当新结果；把未发布代的暂存行当成可读结果。

- [ ] **Step 7：最终交接门槛。** 只有以下全部成立才勾选本任务：

  - Task 11 决策为 `slice`，且决策 JSON 仍在；
  - Task 13 的迁移测试、Task 14—18 的切片测试、Task 19 的等价性与门槛测试全部 PASS；
  - `long-10000-slice` 报告存在且对应预算存在，`basis` 可追溯；任何 `proposed` 值在报告中单列；
  - `discarded_generations=0` 且 `full_incremental_equal=true`；
  - 失败时写 `slice_not_converged`，保留同步路径，不宣布容量完成。

- [ ] **Step 8：提交。** 获授权后：

```bash
git add scripts/capacity.ts scripts/capacity-gate.ts src/capacity.ts \
  tests/capacity-slice.test.ts docs/operations.md docs/architecture-design.md \
  .agents/notes/implemented/feature/2026-10-22-atc-slice-equivalence.md
git commit -m "test(capacity): gate sliced derivation on equivalence and measured budgets" \
  -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## 执行完成判定

- 基线报告、预算文件、门槛报告三者齐全，且预算的 `source_report_sha256` 与报告一致；缺失任一文件退出 2，不进入「完成」。
- `keep-sync`：Task 1—12 全绿，`long-10000` 的写事务、事件循环与排空在预算内；保留 A 的同步入口。
- `slice`：Task 1—19 全绿，迁移 marker complete、发布指针原子、等价性通过、切片容量门槛通过；否则停在 `slice_not_converged`，不声称容量收敛。
- `stop-non-long`：只交付基线与失败报告，写清最高严重度场景与未满足的 `code-constant`/`product-target`；不创建 v6 文件，不把非长组失败包装成「容量完成」。
