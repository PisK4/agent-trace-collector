import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveBudget, deriveScenarioBudget, evaluateGate, evaluateReports, flattenReport,
  loadBudget, loadReport, loadScenarioReports, loadSummary,
} from '../scripts/capacity-gate';
import type { CapacityBudget, ScenarioReport, ScenarioSummary } from '../scripts/capacity-gate';

/** 全部为占位数字的合成报告：形状与负载端产出一致，不含任何真实测量值。 */
function report(input: {
  scenario?: string; ticks?: number; dropped?: number; accepted?: number;
  requests?: number; rows?: number; p95?: number; eventLoopP99?: number;
} = {}): ScenarioReport {
  const ticks = input.ticks ?? 600;
  const accepted = input.accepted ?? ticks;
  const rows = input.rows ?? accepted;
  // 长组不发 HTTP：样本数为 0 时分位是 null，与负载端的空样本口径一致。
  const hookLatency = accepted === 0
    ? { count: 0, p50_ms: null, p95_ms: null, p99_ms: null, max_ms: null }
    : { count: accepted, p50_ms: 10, p95_ms: input.p95 ?? 200, p99_ms: 250, max_ms: 400 };
  return {
    schema: 1, scenario: input.scenario ?? 'baseline-1rps', mode: 'baseline',
    started_at: '2026-10-23T00:00:00.000Z', duration_ms: 600_000, seed: 7,
    environment: { bun: '1.4.0', platform: 'darwin', arch: 'arm64' },
    config: { rps: ticks > 0 ? 1 : 0, sessions: 20, requests: input.requests ?? 0, concurrency: 1 },
    client: {
      attempts: accepted, accepted, duplicates: 0, retried: 0, failed: 0, query_failed: 0,
      launched: accepted, ticks_scheduled: ticks, ticks_dropped: input.dropped ?? 0, in_flight_peak: 1,
      hook_latency: hookLatency,
      query_latency: accepted === 0
        ? { count: 0, p50_ms: null, p95_ms: null, p99_ms: null, max_ms: null }
        : { count: 10, p50_ms: 5, p95_ms: 30, p99_ms: 50, max_ms: 60 },
    },
    collector: {
      started_at_ms: 1, uptime_ms: 600_000,
      ingest: {
        accepted, duplicates: 0, rejected_total: 0, rejected_by_reason: {},
        accepted_request_bytes: 1_000, accepted_reply_bytes: 100,
      },
      writer: { count: 10, total_ms: 1_000, max_ms: 500 },
      event_loop: { interval_ms: 50, count: 10, p50_ms: 1, p95_ms: 5, p99_ms: input.eventLoopP99 ?? 90, max_ms: 100 },
      jobs: { derive: { count: 10, total_ms: 100, max_ms: 50 } },
      route: { polls: 1, files_seen: 1, decoded: 1, unchanged: 0, errors: 0 },
      rss_peak_bytes: 300_000_000,
      storage_peak: { db_bytes: 10, wal_bytes: 2, temp_bytes: 1, body_bytes: 8, total_bytes: 13, freelist_count: 0 },
      storage_end: { db_bytes: 10, wal_bytes: 1, temp_bytes: 0, body_bytes: 8, total_bytes: 11, freelist_count: 0 },
      peak_samples: 600,
      metadata: {
        clean_groups: 20, source_facts_json_bytes: 1, projection_meta_json_bytes: 1,
        queue_clean_bytes: 1, result_metadata_bytes: 0, total_bytes: 100,
        per_clean_group_bytes: 5, per_request_bytes: 1,
      },
      derive_queue: {
        pending_groups: 0, oldest_dirty_since_ms: null, oldest_dirty_age_ms: null,
        oldest_request_started_ms: null, oldest_request_age_ms: null,
      },
    },
    derive: {
      backlog_max_age_ms: 10, drain_ms: 5_400, drain_polls: 12, pending_groups_end: 0,
      comparisons: null, decodes: null, full_incremental_equal: null, result_sha256: null,
      published_generations: null, discarded_generations: null,
    },
    conservation: {
      hook_accepted: accepted, raw_hook_rows: accepted, request_rows: rows,
      evidence_rows: accepted, route_rows: accepted, pending_hooks: 0, open_gaps: 0, missing: [],
    },
    notes: [], ok: true,
  };
}

function summaryOf(reports: readonly ScenarioReport[]): ScenarioSummary {
  return {
    schema: 1, kind: 'capacity-summary',
    started_at: '2026-10-23T00:00:00.000Z', duration_ms: 1_800_000,
    environment: { bun: '1.4.0', platform: 'darwin', arch: 'arm64' },
    scenarios: Object.fromEntries(reports.map(item => [item.scenario, item])),
    notes: [], ok: reports.every(item => item.ok),
  };
}

function budgetOf(scenario: string, scenarioBudget: ReturnType<typeof deriveScenarioBudget>): CapacityBudget {
  return {
    schema: 1, frozen_at: '2026-10-23T00:00:00.000Z',
    source_report: 'summary.json', source_report_sha256: 'a'.repeat(64), bun_version: '1.4.0',
    scenarios: { [scenario]: scenarioBudget }, unmet: {},
    retention: { max: {}, basis: {} },
  };
}

test('预算缺失与形状不符都拒绝完成', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capacity-gate-'));
  try {
    expect(() => loadBudget(join(dir, 'missing.json'))).toThrow('capacity_budget_missing');
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ schema: 1 }));
    expect(() => loadBudget(join(dir, 'bad.json'))).toThrow('capacity_budget_invalid');
    writeFileSync(join(dir, 'hash.json'), JSON.stringify({
      schema: 1, frozen_at: 'x', source_report: 'y', source_report_sha256: 'short',
      bun_version: '1.4.0', scenarios: {}, unmet: {}, retention: { max: {}, basis: {} },
    }));
    expect(() => loadBudget(join(dir, 'hash.json'))).toThrow('capacity_budget_invalid');
    writeFileSync(join(dir, 'metric.json'), JSON.stringify({
      schema: 1, frozen_at: 'x', source_report: 'y', source_report_sha256: 'a'.repeat(64),
      bun_version: '1.4.0', unmet: {}, retention: { max: {}, basis: {} },
      scenarios: { smoke: { max: { accepted: 1 }, min: {}, basis: {} } },
    }));
    expect(() => loadBudget(join(dir, 'metric.json'))).toThrow('capacity_budget_invalid');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('报告缺失、非法与汇总形状都拒绝读取', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capacity-report-'));
  try {
    expect(() => loadReport(join(dir, 'missing.json'))).toThrow('capacity_report_missing');
    writeFileSync(join(dir, 'bad.json'), '{"schema":2}');
    expect(() => loadReport(join(dir, 'bad.json'))).toThrow('capacity_report_invalid');
    expect(() => loadSummary(join(dir, 'bad.json'))).toThrow('capacity_report_invalid');
    const single = join(dir, 'smoke.json');
    writeFileSync(single, JSON.stringify(report({ scenario: 'smoke' })));
    expect(loadScenarioReports(single).map(item => item.scenario)).toEqual(['smoke']);
    const many = join(dir, 'all.json');
    writeFileSync(many, JSON.stringify(summaryOf([report({ scenario: 'smoke' }), report({ scenario: 'route' })])));
    expect(loadScenarioReports(many).map(item => item.scenario)).toEqual(['smoke', 'route']);
    expect(loadSummary(many).kind).toBe('capacity-summary');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('有目标值的指标用目标本身，包络只用于单调量', () => {
  const budget = deriveScenarioBudget(report({ p95: 200, eventLoopP99: 90 }));
  // 单轮包络的方差比一成半余量大，时延与写事务直接用目标值，不用包络收紧。
  expect(budget.max.hook_latency_p95_ms).toBe(2_000);
  expect(budget.basis.hook_latency_p95_ms).toBe('product-target');
  expect(budget.max.event_loop_p99_ms).toBe(100);
  expect(budget.basis.event_loop_p99_ms).toBe('product-target');
  expect(budget.max.max_write_tx_ms).toBe(900);
  expect(budget.basis.max_write_tx_ms).toBe('proposed');
  // rss 与存储字节是单调量：只涨不抖，包络留一成半余量仍然有意义。
  expect(budget.max.rss_peak_bytes).toBe(375_000_001);
  expect(budget.basis.rss_peak_bytes).toBe('baseline-envelope');
  expect(budget.max.ticks_dropped).toBe(0);
  expect(budget.basis.ticks_dropped).toBe('product-target');
  expect(budget.max.pending_groups_end).toBe(0);
  expect(budget.basis.pending_groups_end).toBe('code-constant');
});

test('速率场景的下限来自计划刻度，不来自实发数', () => {
  const fiveRps = report({ scenario: 'baseline-5rps', ticks: 3_000, dropped: 984, accepted: 2_016 });
  const budget = deriveScenarioBudget(fiveRps);
  expect(budget.min.accepted).toBe(2_970);
  expect(budget.min.request_rows).toBe(2_970);
  expect(budget.min.launched).toBe(2_970);
  expect(budget.basis.accepted).toBe('product-target');
  const failures = evaluateGate(fiveRps, budgetOf('baseline-5rps', budget));
  expect(failures).toContainEqual({
    scenario: 'baseline-5rps', check: 'ticks_dropped', actual: 984, limit: 0, kind: 'max', basis: 'product-target',
  });
  expect(failures.some(failure => failure.check === 'accepted' && failure.kind === 'min')).toBe(true);
});

test('长组按计划笔数取行数下限，不发 HTTP 时不要求接受数', () => {
  const long = report({ scenario: 'long-10000', ticks: 0, accepted: 0, requests: 10_000, rows: 10_000 });
  const budget = deriveScenarioBudget(long);
  expect(budget.min.request_rows).toBe(10_000);
  expect(budget.basis.request_rows).toBe('product-target');
  expect(budget.min.accepted).toBe(0);
  expect(budget.basis.accepted).toBe('baseline-envelope');
  expect(evaluateGate(long, budgetOf('long-10000', budget))).toEqual([]);
});

test('门槛逐项报告超上限、低于下限与缺失指标', () => {
  const clean = report();
  const budget = budgetOf('baseline-1rps', deriveScenarioBudget(clean));
  expect(evaluateGate(clean, budget)).toEqual([]);

  const slow = report();
  slow.collector.event_loop.p99_ms = 300;
  slow.derive.drain_ms = null;
  slow.conservation.request_rows = 500;
  const failures = evaluateGate(slow, budget);
  expect(failures).toContainEqual({
    scenario: 'baseline-1rps', check: 'event_loop_p99_ms', actual: 300, limit: 100,
    kind: 'max', basis: 'product-target',
  });
  // null 是"没测到"，必须记成失败并给出 -1，不能当 0 蒙过去。
  expect(failures).toContainEqual({
    scenario: 'baseline-1rps', check: 'drain_ms', actual: -1, limit: 120_000,
    kind: 'max', basis: 'proposed',
  });
  expect(failures).toContainEqual({
    scenario: 'baseline-1rps', check: 'request_rows', actual: 500, limit: 594,
    kind: 'min', basis: 'product-target',
  });
});

test('报告场景不在预算里、预算场景不在报告里都记失败', () => {
  const budget = budgetOf('baseline-1rps', deriveScenarioBudget(report()));
  expect(evaluateGate(report({ scenario: 'route' }), budget)).toEqual([
    { scenario: 'route', check: 'scenario', actual: -1, limit: 1, kind: 'max', basis: 'schema' },
  ]);
  const failures = evaluateReports([report()], budget);
  expect(failures).toEqual([]);
  const missing = evaluateReports([report()], {
    ...budget,
    scenarios: { ...budget.scenarios, burst: deriveScenarioBudget(report({ scenario: 'burst' })) },
  });
  expect(missing).toEqual([
    { scenario: 'burst', check: 'scenario', actual: -1, limit: 1, kind: 'max', basis: 'schema' },
  ]);
});

test('汇总预算逐场景冻结，并把源报告已越过的门槛写进 unmet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capacity-freeze-'));
  try {
    const path = join(dir, 'baseline-all.json');
    const summary = summaryOf([
      report({ scenario: 'baseline-1rps' }),
      report({ scenario: 'baseline-5rps', ticks: 3_000, dropped: 984, accepted: 2_016 }),
    ]);
    writeFileSync(path, JSON.stringify(summary));
    const budget = deriveBudget(summary, { sourceReport: path });
    expect(Object.keys(budget.scenarios).sort()).toEqual(['baseline-1rps', 'baseline-5rps']);
    expect(budget.source_report_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(budget.unmet)).toEqual(['baseline-5rps']);
    expect(budget.unmet['baseline-5rps']!.map(failure => failure.check)).toContain('ticks_dropped');
    expect(budget.retention.basis.retention_max_ms).toBe('proposed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('扁平化把正文与队列读数一起交给判定', () => {
  const flat = flattenReport(report({ ticks: 3_000, dropped: 984, accepted: 2_016 }));
  expect(flat.ticks_scheduled).toBe(3_000);
  expect(flat.ticks_dropped).toBe(984);
  expect(flat.in_flight_peak).toBe(1);
  expect(flat.request_rows).toBe(2_016);
  expect(flat.pending_hooks).toBe(0);
  expect(flat.db_wal_temp_bytes).toBe(13);
  expect(flat.metadata_per_request_bytes).toBe(1);
});