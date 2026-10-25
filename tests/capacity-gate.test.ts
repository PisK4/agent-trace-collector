import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countPublishedGenerations, derivedHash, derivedHashSlice, parseArgs, scenarioPlan } from '../scripts/capacity';
import { SEED_GROUP, fixture, seedChain } from './fixtures';
import {
  deriveBudget, deriveScenarioBudget, evaluateGate, evaluateReports, evaluateSliceBasis,
  evaluateSliceChecks, flattenReport, loadBudget, loadReport, loadScenarioReports,
  loadSliceBudget, loadSummary, sha256File, sliceDeriveBudget,
} from '../scripts/capacity-gate';
import { buildDecisionFile, decideCapacity } from '../scripts/capacity-decision';
import type {
  CapacityBudget, GateFailure, ScenarioReport, ScenarioSummary, SliceDeriveBudgetFile, ThresholdBasis,
} from '../scripts/capacity-gate';

/** 全部为占位数字的合成报告：形状与负载端产出一致，不含任何真实测量值。 */
function report(input: {
  scenario?: string; ticks?: number; dropped?: number; accepted?: number;
  requests?: number; rows?: number; p95?: number; eventLoopP99?: number;
  mode?: 'baseline' | 'slice'; published?: number | null; discarded?: number | null;
  equal?: boolean | null; sliceSource?: string | null;
} = {}): ScenarioReport {
  const ticks = input.ticks ?? 600;
  const accepted = input.accepted ?? ticks;
  const rows = input.rows ?? accepted;
  // 长组不发 HTTP：样本数为 0 时分位是 null，与负载端的空样本口径一致。
  const hookLatency = accepted === 0
    ? { count: 0, p50_ms: null, p95_ms: null, p99_ms: null, max_ms: null }
    : { count: accepted, p50_ms: 10, p95_ms: input.p95 ?? 200, p99_ms: 250, max_ms: 400 };
  return {
    schema: 1, scenario: input.scenario ?? 'baseline-1rps', mode: input.mode ?? 'baseline',
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
      comparisons: null, decodes: null,
      full_incremental_equal: input.equal ?? null, result_sha256: null,
      published_generations: input.published ?? null, discarded_generations: input.discarded ?? null,
      slice_budget_source: input.sliceSource ?? null,
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

function budgetOf(
  scenario: string,
  scenarioBudget: ReturnType<typeof deriveScenarioBudget>,
  slice?: CapacityBudget['slice'],
): CapacityBudget {
  return {
    schema: 1, frozen_at: '2026-10-23T00:00:00.000Z',
    source_report: 'summary.json', source_report_sha256: 'a'.repeat(64), bun_version: '1.4.0',
    scenarios: { [scenario]: scenarioBudget }, unmet: {},
    retention: { max: {}, basis: {} },
    ...(slice === undefined ? {} : { slice }),
  };
}

/** 合成切片预算节：上限、出处与运行期预算全是占位值，形状与校准产物一致。 */
function sliceSection(input: {
  basis?: Record<string, ThresholdBasis>; calibration?: string;
} = {}): NonNullable<CapacityBudget['slice']> {
  return {
    frozen_at: '2026-10-23T00:00:00.000Z',
    source_calibration: input.calibration ?? 'docs/superpowers/capacity/synthetic-slice.md',
    max: { max_write_tx_ms: 900, max_wal_growth_bytes: 8_388_608 },
    basis: input.basis ?? { max_write_tx_ms: 'proposed', max_wal_growth_bytes: 'baseline-envelope' },
    derive_budget: {
      max_request_ms: 10, max_stage_batch_ms: 2_000, max_candidates_per_batch: 1_000,
      max_writes_per_batch: 2_000, max_staged_bytes: 134_217_728,
      max_wal_growth_bytes: 8_388_608, max_retired_generations: 2,
    },
  };
}

/** 切片长组的合成报告：输入与 `long-10000` 相同，只是排空走切片入口。 */
function sliceReport(input: {
  published?: number | null; discarded?: number | null; equal?: boolean | null;
  sliceSource?: string | null;
} = {}): ScenarioReport {
  // 显式传 null（"这个读数没测到"）与不传（用例不关心）要分开，`??` 会把前者吞掉。
  return report({
    scenario: 'long-10000-slice', mode: 'slice', ticks: 0, accepted: 0,
    requests: 10_000, rows: 10_000,
    published: input.published === undefined ? 1 : input.published,
    discarded: input.discarded === undefined ? 0 : input.discarded,
    equal: input.equal === undefined ? true : input.equal,
    sliceSource: input.sliceSource === undefined ? 'budget.json#slice.derive_budget' : input.sliceSource,
  });
}

/** 门槛命令行：读两个文件、打印失败项、按退出码表态，别处没有更便宜的入口。 */
function runGate(budgetPath: string, reportPath: string): { code: number | null; stderr: string } {
  const child = Bun.spawnSync({
    cmd: ['bun', join(import.meta.dir, '..', 'scripts', 'capacity-gate.ts'),
      'gate', '--budget', budgetPath, '--report', reportPath],
    stdout: 'pipe', stderr: 'pipe',
  });
  return { code: child.exitCode, stderr: child.stderr.toString() };
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

test('切片预算的键与运行期预算一一对应', () => {
  // 逐字段给出：映射写漏一个、或者某个键被抄成另一个字段的值，这条断言就会失败。
  const file: SliceDeriveBudgetFile = {
    max_request_ms: 10, max_stage_batch_ms: 2_000, max_candidates_per_batch: 1_000,
    max_writes_per_batch: 2_000, max_staged_bytes: 134_217_728,
    max_wal_growth_bytes: 8_388_608, max_retired_generations: 2,
  };
  expect(sliceDeriveBudget(file)).toEqual({
    maxRequestMs: 10, maxStageBatchMs: 2_000, maxCandidatesPerBatch: 1_000,
    maxWritesPerBatch: 2_000, maxStagedBytes: 134_217_728,
    maxWalGrowthBytes: 8_388_608, maxRetiredGenerations: 2,
  });
});

test('切片预算只从预算文件的切片节读，缺了就拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capacity-slice-budget-'));
  try {
    const baseline = budgetOf('baseline-1rps', deriveScenarioBudget(report()));
    const noSlice = join(dir, 'no-slice.json');
    writeFileSync(noSlice, JSON.stringify(baseline));
    // 冻结的基线预算就是这个形状：没有切片节时不许猜默认值，只报切片预算缺失。
    expect(() => loadSliceBudget(noSlice)).toThrow('capacity_slice_budget_missing');
    expect(() => loadSliceBudget(join(dir, 'missing.json'))).toThrow('capacity_budget_missing');

    const path = join(dir, 'budget.json');
    writeFileSync(path, JSON.stringify(budgetOf('baseline-1rps', deriveScenarioBudget(report()), sliceSection())));
    expect(loadSliceBudget(path)).toEqual({
      budget: sliceDeriveBudget(sliceSection().derive_budget),
      source: `${path}#slice.derive_budget`,
      sourceCalibration: sliceSection().source_calibration,
    });

    // 早期设计的 8 键形状：字段数对不上，按缺失拒绝，不做有损翻译。
    const stale = join(dir, 'stale.json');
    writeFileSync(stale, JSON.stringify({
      ...baseline,
      slice: { ...sliceSection(), derive_budget: { max_requests_per_slice: 1 } },
    }));
    expect(() => loadSliceBudget(stale)).toThrow('capacity_slice_budget_missing');
    expect(() => loadBudget(stale)).toThrow('capacity_budget_invalid');

    // 上限缺 basis 的记录同样非法：它没有可以回溯的出处。两个入口报的码不同：
    // `loadBudget` 是形状闸门（非法），`loadSliceBudget` 只回答"这份切片预算能不能用"（缺失）。
    const unbased = join(dir, 'unbased.json');
    writeFileSync(unbased, JSON.stringify({
      ...baseline,
      slice: { ...sliceSection(), basis: { max_write_tx_ms: 'proposed' } },
    }));
    expect(() => loadBudget(unbased)).toThrow('capacity_budget_invalid');
    expect(() => loadSliceBudget(unbased)).toThrow('capacity_slice_budget_missing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('切片场景的结构门槛逐条报告', () => {
  const clean = sliceReport();
  // 长组取 `config.requests` 当行数下限，切片场景与 `long-10000` 同一口径。
  const limits = deriveScenarioBudget(clean);
  const budget = budgetOf('long-10000-slice', limits);
  expect(limits.min.request_rows).toBe(10_000);
  expect(limits.min.accepted).toBe(0);
  expect(evaluateGate(clean, budget)).toEqual([]);

  // 同步场景不套切片门槛：`long-10000` 的那两个读数恒为 null。
  expect(evaluateSliceChecks(report({ scenario: 'long-10000', ticks: 0, accepted: 0, requests: 10_000, rows: 10_000 })))
    .toEqual([]);

  expect(evaluateSliceChecks(sliceReport({ discarded: 3 }))).toEqual([{
    scenario: 'long-10000-slice', check: 'discarded_generations', actual: 3, limit: 0,
    kind: 'max', basis: 'proposed',
  }]);
  expect(evaluateSliceChecks(sliceReport({ published: null }))).toEqual([{
    scenario: 'long-10000-slice', check: 'published_generations', actual: -1, limit: 1,
    kind: 'min', basis: 'proposed',
  }]);
  expect(evaluateSliceChecks(sliceReport({ published: 0 }))).toEqual([{
    scenario: 'long-10000-slice', check: 'published_generations', actual: 0, limit: 1,
    kind: 'min', basis: 'proposed',
  }]);
  expect(evaluateSliceChecks(sliceReport({ equal: false }))).toEqual([{
    scenario: 'long-10000-slice', check: 'full_incremental_equal', actual: 0, limit: 1,
    kind: 'max', basis: 'proposed',
  }]);
  // 报告没写预算来源就判不了它是拿哪份预算跑的。
  expect(evaluateSliceChecks(sliceReport({ sliceSource: null }))).toEqual([{
    scenario: 'long-10000-slice', check: 'slice_budget_source', actual: 0, limit: 1,
    kind: 'min', basis: 'schema',
  }]);

  // 写事务与事件循环上限照旧判：切片场景没有 HTTP 不代表它不写库。
  const slow = sliceReport();
  slow.collector.writer = { count: 10, total_ms: 9_000, max_ms: 1_200 };
  slow.collector.event_loop.p99_ms = 300;
  const failures = evaluateGate(slow, budgetOf('long-10000-slice', deriveScenarioBudget(slow)));
  expect(failures).toContainEqual({
    scenario: 'long-10000-slice', check: 'max_write_tx_ms', actual: 1_200, limit: 900,
    kind: 'max', basis: 'proposed',
  });
  expect(failures).toContainEqual({
    scenario: 'long-10000-slice', check: 'event_loop_p99_ms', actual: 300, limit: 100,
    kind: 'max', basis: 'product-target',
  });
  expect(failures.some(failure => failure.check === 'discarded_generations')).toBe(false);
});

test('切片上限的 basis 必须能回溯到校准报告', () => {
  expect(evaluateSliceBasis(budgetOf('baseline-1rps', deriveScenarioBudget(report()), sliceSection())))
    .toEqual([]);
  // 没有切片节就没有可核的上限；缺预算由调用方按"判不了"（退出 2）处理。
  expect(evaluateSliceBasis(budgetOf('baseline-1rps', deriveScenarioBudget(report())))).toEqual([]);
  // 把实测上限复制成 code-constant：它没有可回溯的实测值，记失败。
  expect(evaluateSliceBasis(budgetOf('baseline-1rps', deriveScenarioBudget(report()),
    sliceSection({ basis: { max_write_tx_ms: 'code-constant', max_wal_growth_bytes: 'baseline-envelope' } }))))
    .toEqual([{
      scenario: 'slice', check: 'slice_basis:max_write_tx_ms', actual: 1, limit: 0,
      kind: 'max', basis: 'code-constant',
    }]);
  expect(evaluateSliceBasis(budgetOf('baseline-1rps', deriveScenarioBudget(report()),
    sliceSection({ calibration: '' }))))
    .toContainEqual({
      scenario: 'slice', check: 'source_calibration', actual: 0, limit: 1, kind: 'min', basis: 'schema',
    });
});

test('切片报告缺切片预算时判不了，退出 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capacity-gate-slice-'));
  try {
    const reportPath = join(dir, 'slice.json');
    writeFileSync(reportPath, JSON.stringify(sliceReport()));

    const noSlicePath = join(dir, 'budget-no-slice.json');
    writeFileSync(noSlicePath, JSON.stringify(budgetOf('long-10000-slice', deriveScenarioBudget(sliceReport()))));
    const unjudged = runGate(noSlicePath, reportPath);
    expect(unjudged.stderr).toContain('capacity_slice_budget_missing');
    expect(unjudged.code).toBe(2);

    // 带上切片节，同一份合成报告就通过：判不了与失败是两回事。
    const slicePath = join(dir, 'budget-slice.json');
    writeFileSync(slicePath, JSON.stringify(
      budgetOf('long-10000-slice', deriveScenarioBudget(sliceReport()), sliceSection())));
    const passed = runGate(slicePath, reportPath);
    expect(passed.stderr).toBe('');
    expect(passed.code).toBe(0);

    // 上限的来源抄成常量：报告本身没问题，预算的来源不成立，退出 1。
    const copiedPath = join(dir, 'budget-copied.json');
    writeFileSync(copiedPath, JSON.stringify(budgetOf('long-10000-slice', deriveScenarioBudget(sliceReport()),
      sliceSection({ basis: { max_write_tx_ms: 'code-constant', max_wal_growth_bytes: 'baseline-envelope' } }))));
    expect(runGate(copiedPath, reportPath).code).toBe(1);

    // 报告自己越过门槛（丢了代、没发布）时同样退出 1，而不是"判不了"。
    const divergedPath = join(dir, 'slice-diverged.json');
    writeFileSync(divergedPath, JSON.stringify(sliceReport({ discarded: 2, published: 0, equal: false })));
    expect(runGate(slicePath, divergedPath).code).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('切片场景在没有切片预算时拒绝启动，退出 2', () => {
  // 场景与参数是纯函数：切片场景的输入必须与 `long-10000` 相同，笔数不接受覆盖。
  expect(scenarioPlan('long-10000-slice', { full: false, acknowledgeLongRun: true }))
    .toEqual(scenarioPlan('long', { full: false, acknowledgeLongRun: true, requests: 10_000 }));
  expect(() => scenarioPlan('long-10000-slice', { full: false }))
    .toThrow('capacity_long_run_not_acknowledged');
  expect(() => scenarioPlan('long-10000-slice', { full: false, acknowledgeLongRun: true, requests: 5_000 }))
    .toThrow('capacity_invalid_requests');
  expect(parseArgs(['long-10000-slice', '--acknowledge-long-run', '--slice-budget', 'budget.json']).sliceBudget)
    .toBe('budget.json');

  const dir = mkdtempSync(join(tmpdir(), 'capacity-slice-cli-'));
  try {
    const reportPath = join(dir, 'slice.json');
    const stalePath = join(dir, 'budget-no-slice.json');
    writeFileSync(stalePath, JSON.stringify(budgetOf('baseline-1rps', deriveScenarioBudget(report()))));
    const run = (...extra: string[]): { code: number | null; stderr: string } => {
      const child = Bun.spawnSync({
        cmd: ['bun', join(import.meta.dir, '..', 'scripts', 'capacity.ts'),
          'long-10000-slice', '--acknowledge-long-run', '--report', reportPath, ...extra],
        stdout: 'pipe', stderr: 'pipe',
      });
      return { code: child.exitCode, stderr: child.stderr.toString() };
    };
    const unbudgeted = run();
    expect(unbudgeted.stderr).toContain('capacity_slice_budget_missing');
    expect(unbudgeted.code).toBe(2);
    // 冻结的基线预算就是这样：文件在，切片节不在，同样拒绝而不是猜默认值。
    const stale = run('--slice-budget', stalePath);
    expect(stale.stderr).toContain('capacity_slice_budget_missing');
    expect(stale.code).toBe(2);
    // 三个拒绝分支都在跑之前退出：没有留下"跑了一半"的报告。
    expect(existsSync(reportPath)).toBe(false);
    // 预算给同步场景是把场景和预算配错，不能静默丢掉。
    const mispaired = Bun.spawnSync({
      cmd: ['bun', join(import.meta.dir, '..', 'scripts', 'capacity.ts'),
        'long', '--acknowledge-long-run', '--requests', '2000', '--slice-budget', stalePath,
        '--report', reportPath],
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(mispaired.stderr.toString()).toContain('capacity_slice_scenario_required');
    expect(mispaired.exitCode).toBe(2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('切片读数只认已发布的代际与它的 result 行', () => {
  // 切片长组跑一次是十分钟级的，但这两处读数的取值来源在这里就能钉住：
  // 代数只数 `state='published'` 的行，指纹只从发布指针指向的那一代的 result 行取。
  const f = fixture();
  try {
    const { convKey, actor } = SEED_GROUP;
    seedChain(f.store, [{ texts: ['S'] }, { texts: ['S', 'A'] }]);
    expect(countPublishedGenerations(f.store, convKey, actor)).toBe(0);
    f.store.write(db => {
      db.run(`INSERT INTO derive_generation(generation,conv_key,actor,group_epoch,input_revision,
        algorithm,state,stage,created_at)
        VALUES ('gen-00000000000000',?,?,'g1',1,5,'published','done',1)`, [convKey, actor]);
      // 写正文会把组标脏并入队，所以这里用 upsert 把发布指针指过去，不另开一行队列。
      db.run(`INSERT INTO derive_queue(conv_key,actor,from_sort,group_epoch,input_revision,
        published_revision,target_algorithm,published_algorithm,state,published_generation)
        VALUES (?,?,'','g1',1,1,5,5,'clean','gen-00000000000000')
        ON CONFLICT(conv_key,actor) DO UPDATE SET published_generation='gen-00000000000000',
          published_revision=input_revision, published_algorithm=target_algorithm, state='clean'`,
      [convKey, actor]);
      db.run(`INSERT INTO derive_request_result(generation,req_id,started_ms,purpose_revision,
        algorithm,retention_state)
        VALUES ('gen-00000000000000',1,1000,0,5,'recomputed')`);
    });
    expect(countPublishedGenerations(f.store, convKey, actor)).toBe(1);
    expect(derivedHashSlice(f.store, convKey, actor)).toMatch(/^[0-9a-f]{64}$/);
    // 退下来的代不再计入发布：指针之外的副本不是"这一轮发布的东西"。
    f.store.write(db => db.run("UPDATE derive_generation SET state='retired'"));
    expect(countPublishedGenerations(f.store, convKey, actor)).toBe(0);
  } finally { f.close(); }
});

test('同步与切片指纹共享同一份有序列清单', () => {
  // 两条取源路径对同一组派生值必须给出同一指纹：清单、顺序或 fact/derived
  // 归属有一处分叉，指纹就分开，long-10000 与 long-10000-slice 的对照随之失效。
  const f = fixture();
  try {
    const { convKey, actor } = SEED_GROUP;
    seedChain(f.store, [{ texts: ['S'] }]);
    f.store.write(db => {
      db.run(`INSERT INTO derive_generation(generation,conv_key,actor,group_epoch,input_revision,
        algorithm,state,stage,created_at)
        VALUES ('gen-00000000000000',?,?,'g1',1,5,'published','done',1)`, [convKey, actor]);
      db.run(`INSERT INTO derive_queue(conv_key,actor,from_sort,group_epoch,input_revision,
        published_revision,target_algorithm,published_algorithm,state,published_generation)
        VALUES (?,?,'','g1',1,1,5,5,'clean','gen-00000000000000')
        ON CONFLICT(conv_key,actor) DO UPDATE SET published_generation='gen-00000000000000',
          published_revision=input_revision, published_algorithm=target_algorithm, state='clean'`,
      [convKey, actor]);
      db.run(`UPDATE request SET prev_req_id=NULL,prev_relation=NULL,delta_ordinals=NULL,
        chain_role='main',title='t',title_source='user_delta',input_preview='p',
        input_preview_kind='delta',reply_preview='r',model_title='mt',req_kind='chat',
        purpose_chain='participate' WHERE conv_key=?`, [convKey]);
      db.run(`INSERT INTO derive_request_result(generation,req_id,started_ms,purpose_revision,
        algorithm,retention_state,chain_role,title,title_source,input_preview,input_preview_kind,
        reply_preview,purpose_chain)
        VALUES ('gen-00000000000000',1,1000,0,5,'recomputed','main','t','user_delta','p','delta',
        'r','participate')`);
    });
    expect(derivedHash(f.store, convKey)).toBe(derivedHashSlice(f.store, convKey, actor));
  } finally { f.close(); }
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

test('决策只在长组主因且无其它绝对失败时进入切片', () => {
  const longFailure: GateFailure = {
    scenario: 'long-10000', check: 'max_write_tx_ms',
    actual: 5_000, limit: 900, kind: 'max', basis: 'proposed',
  };
  expect(decideCapacity({ failures: [longFailure], scenarios: ['baseline-1rps', 'long-10000'] }))
    .toMatchObject({ decision: 'slice', primary: 'long-10000' });
  expect(decideCapacity({ failures: [], scenarios: ['baseline-1rps'] }))
    .toMatchObject({ decision: 'keep-sync' });
  expect(decideCapacity({
    failures: [{ ...longFailure, scenario: 'baseline-5rps' }],
    scenarios: ['baseline-5rps', 'long-10000'],
  })).toMatchObject({ decision: 'stop-non-long', primary: 'baseline-5rps' });
  // 别处的绝对失败压在长组之上：同步设计不能只靠切片长组就宣布可发布。
  expect(decideCapacity({
    failures: [longFailure, {
      scenario: 'baseline-1rps', check: 'query_latency_p95_ms',
      actual: 200, limit: 100, kind: 'max', basis: 'product-target',
    }],
    scenarios: ['baseline-1rps', 'long-10000'],
  })).toMatchObject({ decision: 'stop-non-long' });
});

test('决策按比值取主因，长组只有非同步派生项时也不切片', () => {
  const failures: GateFailure[] = [
    { scenario: 'baseline-5rps', check: 'accepted', actual: 2_031, limit: 2_970, kind: 'min', basis: 'product-target' },
    { scenario: 'long-10000', check: 'max_write_tx_ms', actual: 1_959, limit: 900, kind: 'max', basis: 'proposed' },
  ];
  // 下限类按 限值 / 实测 算：2,970 / 2,031 = 1.46；长组的 1,959 / 900 = 2.18 更大，所以主因是长组。
  // 但基线场景带 product-target 失败，长组做主因也不足以切片。
  const verdict = decideCapacity({ failures, scenarios: ['baseline-5rps', 'long-10000'] });
  expect(verdict.primary).toBe('long-10000');
  expect(verdict.severity).toBeCloseTo(1_959 / 900, 5);
  expect(verdict.decision).toBe('stop-non-long');

  // 长组的失败只有时延类（非同步派生成本）时，主因不足以支撑切片。
  const latencyOnly = decideCapacity({
    failures: [{ ...failures[1]!, check: 'hook_latency_p95_ms', actual: 4_000, limit: 2_000 }],
    scenarios: ['long-10000'],
  });
  expect(latencyOnly).toMatchObject({ decision: 'stop-non-long', primary: 'long-10000' });
});

test('没有失败项也没有被测量的场景时拒绝出决策', () => {
  expect(() => decideCapacity({ failures: [], scenarios: [] })).toThrow('capacity_decision_no_scenarios');
});

test('决策文件记下两侧哈希与失败项，并按给定时刻落盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capacity-decision-'));
  try {
    const reportPath = join(dir, 'summary.json');
    const budgetPath = join(dir, 'budget.json');
    writeFileSync(reportPath, JSON.stringify(summaryOf([report()])));
    const budget = budgetOf('baseline-1rps', deriveScenarioBudget(report()));
    writeFileSync(budgetPath, JSON.stringify(budget));
    const file = buildDecisionFile({
      failures: evaluateReports([report()], budget), scenarios: ['baseline-1rps'],
      report: reportPath, budget: budgetPath,
      command: 'bun scripts/capacity-decision.ts --report summary.json',
      decidedAt: '2026-10-23T12:00:00.000Z',
    });
    expect(file).toMatchObject({
      schema: 1, decision: 'keep-sync', primary: null, severity: 0,
      decided_at: '2026-10-23T12:00:00.000Z', failures: [],
    });
    expect(file.report_sha256).toBe(sha256File(reportPath));
    expect(file.budget_sha256).toBe(sha256File(budgetPath));
    expect(file.command).toContain('capacity-decision.ts');
    writeFileSync(join(dir, 'decision.json'), `${JSON.stringify(file, null, 2)}\n`);
    expect(JSON.parse(readFileSync(join(dir, 'decision.json'), 'utf8'))).toEqual(file);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});