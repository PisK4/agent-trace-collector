/**
 * 容量报告与预算的共享形状。
 *
 * 负载端写报告、门槛端读报告与预算，两边必须使用同一份字段定义。
 * 门槛加载与判定在 Task 7 追加；当前只有类型，不在这里实现任何阈值。
 */
import type { DurationSummary } from '../src/capacity';

export type { DurationSummary };

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

export type StorageReading = {
  db_bytes: number;
  wal_bytes: number;
  temp_bytes: number;
  body_bytes: number;
  total_bytes: number;
  freelist_count: number;
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
    /** 页面读取轮询的非 2xx 或网络失败次数；非零时报告不能算通过。 */
    query_failed: number;
    /** 按计划发出的请求数（含 burst 的重放）。 */
    launched: number;
    /** 到点的刻度数：计划速率乘实际时长。 */
    ticks_scheduled: number;
    /** 到点却因在途上限已满而没发出的刻度数；非零说明计划速率没被真正施加上去。 */
    ticks_dropped: number;
    /** 在途请求峰值；贴住 `config.concurrency` 说明负载端自己成了瓶颈。 */
    in_flight_peak: number;
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
    storage_peak: StorageReading;
    storage_end: StorageReading;
    /** 峰值来自几次实际快照；0 表示只有最终快照且采样失败。 */
    peak_samples: number;
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
    /** 停止输入后仍未对账合并的 hook 行数；非零表示请求数还会变。 */
    pending_hooks: number;
    /** 停止后仍未关闭的来源缺口数；非零表示账本还没读完。 */
    open_gaps: number;
    missing: string[];
  };
  notes: string[];
  ok: boolean;
};
