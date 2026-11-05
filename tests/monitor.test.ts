import { expect, test } from 'bun:test';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendSample, buildReport, countDiagnosticsErrors, evaluateRules, extractMetrics, extractStats,
  loadSamples, localDay, sampleEvidenceOk,
} from '../scripts/monitor';
import type { MetricsView, Sample, RuleContext, AlertState } from '../scripts/monitor';
import {
  KEEP_DAYS, THRESHOLDS, transitionAlerts, pruneArchives, rotateLog, pruneMonitorData,
} from '../scripts/monitor';
import { CAPACITY_METER_VERSION } from '../src/capacity-meter';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

const HEALTHY_METER = {
  ok: true, version: CAPACITY_METER_VERSION, source_count: 4, body_bytes: 1, error: null,
};

function metrics(overrides: Partial<MetricsView> = {}): MetricsView {
  return {
    started_at_ms: NOW - MINUTE,
    uptime_ms: MINUTE,
    rss_bytes: 300 * 1024 * 1024,
    ingest_accepted: 10,
    ingest_duplicates: 1,
    ingest_rejected: 0,
    jobs: [],
    storage: { body_bytes: 1, db_bytes: 2, wal_bytes: 0, total_bytes: 3, free_bytes: 200 * 10 ** 9 },
    storage_measured_at_ms: NOW - MINUTE,
    storage_measure: { count: 1, total_ms: 2, max_ms: 2 },
    event_loop: { count: 3, p50_ms: 1, p95_ms: 2, p99_ms: 3, max_ms: 4, interval_ms: 100 },
    derive_queue: { pending_groups: 0, oldest_dirty_age_ms: null },
    admission: null,
    ...overrides,
    capacity_meter: overrides.capacity_meter === undefined
      ? HEALTHY_METER : overrides.capacity_meter,
  };
}

function sample(ts: number, overrides: Partial<MetricsView> = {}, ok = true): Sample {
  return {
    ts_ms: ts,
    instance: 'proc-a',
    ok,
    state: ok ? 'ok' : 'timeout',
    elapsed_ms: 5,
    jobs_running: true,
    metrics: ok ? metrics(overrides) : null,
    stats: ok ? { open_gaps: 0, pending_hooks: 0, requests: 1, cursors: 1, issues: 0 } : null,
  };
}

function context(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    now: NOW, jobRunning: true, thresholds: THRESHOLDS,
    bodyBudget: 1_000, stale: false, ...overrides,
  };
}

test('采样只保留允许列表，正文与会话标题字段不进样本', () => {
  const body = {
    instance: 'proc-a', metadata: { canary: 'session-title-secret' },
    session_title: 'secret', sql: 'SELECT 1', ingest: { accepted: 2 },
  };
  const view = extractMetrics(body);
  expect(view?.ingest_accepted).toBe(2);
  expect(JSON.stringify(view)).not.toContain('session-title-secret');
  expect(JSON.stringify(view)).not.toContain('SELECT 1');
  expect(Object.keys(view ?? {})).not.toContain('metadata');
  const stats = extractStats({ open_gaps: 1, pending_hooks: 2, cursors: [1], issues: [] });
  expect(stats).toEqual({ open_gaps: 1, pending_hooks: 2, requests: 0, cursors: 1, issues: 0 });
});

test('计数结构缺失、非法、版本不符或少来源都单独告警', () => {
  const detail = (overrides: Partial<MetricsView>) =>
    evaluateRules([sample(NOW, overrides)], context())
      .find(hit => hit.rule === 'capacity_meter')?.detail;
  expect(detail({})).toBeUndefined();
  expect(detail({ capacity_meter: null })).toBe('missing');
  expect(detail({
    capacity_meter: { ...HEALTHY_METER, ok: false, error: 'capacity_meter_invalid' },
  })).toBe('capacity_meter_invalid');
  expect(detail({ capacity_meter: { ...HEALTHY_METER, version: 2 } })).toBe('version:2');
  expect(detail({ capacity_meter: { ...HEALTHY_METER, source_count: 3 } })).toBe('sources:3');
});

test('服务探不到时立即告警，不因缺样本判成正常', () => {
  const hits = evaluateRules([sample(NOW - MINUTE, {}, false)], context({ jobRunning: false }));
  expect(hits.map(hit => hit.rule)).toContain('service_unreadable');
});

test('事件循环 p99 连续超过 30 分钟才告警，2 秒级停顿走独立通道', () => {
  const at = (ts: number, loop: Partial<MetricsView['event_loop']> = {}) =>
    sample(ts, { event_loop: { ...metrics().event_loop, ...loop } });
  // 阈值 330：200 与 300 的常态窗口都不告警。
  expect(evaluateRules([at(NOW - 31 * MINUTE, { p99_ms: 300 }), at(NOW, { p99_ms: 300 })],
    context()).some(hit => hit.rule === 'event_loop_p99')).toBe(false);
  const sustained = [at(NOW - 30 * MINUTE, { p99_ms: 400 }), at(NOW - 20 * MINUTE, { p99_ms: 400 }),
    at(NOW - 10 * MINUTE, { p99_ms: 400 }), at(NOW, { p99_ms: 400 })];
  expect(evaluateRules(sustained, context()).some(hit => hit.rule === 'event_loop_p99')).toBe(true);
  // 单次停顿：max 通道立即命中，不需要凑跨度。
  const stalled = [at(NOW - MINUTE, { max_ms: 10_855 }), at(NOW, { max_ms: 10_855 })];
  expect(evaluateRules(stalled, context()).some(hit => hit.rule === 'event_loop_max')).toBe(true);
  expect(evaluateRules([at(NOW, { max_ms: 1_500 })], context())
    .some(hit => hit.rule === 'event_loop_max')).toBe(false);
});

test('断档在存活阈值内不清持续窗口，超过才重新起算', () => {
  const at = (ts: number) => sample(ts, { event_loop: { ...metrics().event_loop, p99_ms: 400 } });
  // 中间一个 9 分钟断档（采样停摆）： continuityGapMs=11 分钟，窗口不清。
  const bridged = [at(NOW - 30 * MINUTE), at(NOW - 20 * MINUTE), at(NOW - 11 * MINUTE), at(NOW)];
  expect(evaluateRules(bridged, context()).some(hit => hit.rule === 'event_loop_p99')).toBe(true);
  // 断档超过存活阈值：连续性重新起算，30 分钟窗口凑不满。
  const broken = [at(NOW - 45 * MINUTE), at(NOW - 30 * MINUTE), at(NOW)];
  expect(evaluateRules(broken, context()).some(hit => hit.rule === 'event_loop_p99')).toBe(false);
});

test('采样连续性：一个漏采周期在窗口内提醒，正常间隔不提醒', () => {
  const gapped = [sample(NOW - 10 * MINUTE), sample(NOW)];
  expect(evaluateRules(gapped, context()).some(hit => hit.rule === 'sample_gap')).toBe(true);
  // 断档已滑出窗口（样本只剩正常间隔）不再命中。
  const recovered = [sample(NOW - 20 * MINUTE), sample(NOW - 15 * MINUTE), sample(NOW - 10 * MINUTE),
    sample(NOW - 5 * MINUTE), sample(NOW)];
  expect(evaluateRules(recovered, context()).some(hit => hit.rule === 'sample_gap')).toBe(false);
  expect(evaluateRules([sample(NOW)], context()).some(hit => hit.rule === 'sample_gap')).toBe(false);
});

test('派生积压只在没有进展时告警', () => {
  const queue = { pending_groups: 3, oldest_dirty_age_ms: 20 * MINUTE };
  const stuck = [sample(NOW - 10 * MINUTE, { derive_queue: queue }),
    sample(NOW - 5 * MINUTE, { derive_queue: queue }), sample(NOW, { derive_queue: queue })];
  expect(evaluateRules(stuck, context()).some(hit => hit.rule === 'derive_backlog')).toBe(true);
  const progressing = [sample(NOW - 10 * MINUTE, { derive_queue: queue }),
    sample(NOW - 5 * MINUTE, { derive_queue: queue }),
    sample(NOW, { derive_queue: { pending_groups: 1, oldest_dirty_age_ms: 9 * MINUTE } })];
  expect(evaluateRules(progressing, context()).some(hit => hit.rule === 'derive_backlog')).toBe(false);
});

test('准入模式持续非 normal 超过 10 分钟告警', () => {
  const at = (ts: number) => ({ mode: 'read_only', reason: 'disk_low', at_ms: ts });
  // 量测时间一直新鲜（闸门持续在写），仍按样本跨度判定持续。
  const sustained = [sample(NOW - 10 * MINUTE, { admission: at(NOW - 10 * MINUTE) }),
    sample(NOW - 5 * MINUTE, { admission: at(NOW - 5 * MINUTE) }),
    sample(NOW, { admission: at(NOW) })];
  expect(evaluateRules(sustained, context()).some(hit => hit.rule === 'storage_mode')).toBe(true);
  // 单条旧量测不算持续。
  const single = [sample(NOW - MINUTE, { admission: at(NOW - 11 * MINUTE) })];
  expect(evaluateRules(single, context()).some(hit => hit.rule === 'storage_mode')).toBe(false);
});

test('缺样本或采样失败时保留告警，不判恢复', () => {
  const state: AlertState = { active: { event_loop_p99: { since_ms: NOW - MINUTE, last_notified_ms: NOW - MINUTE } } };
  const failed = [sample(NOW - 2 * MINUTE, {}, false)];
  const kept = transitionAlerts(state, evaluateRules(failed, context({ stale: true })), context({ stale: true }));
  expect(kept.state.active.event_loop_p99).toBeDefined();
  expect(kept.events.some(event => event.event === 'recovered')).toBe(false);
  // 条件消失先进恢复窗口：单样本回落不写 recovered（F10）。
  const dipping = transitionAlerts(state, [], context());
  expect(dipping.state.active.event_loop_p99).toBeDefined();
  expect(dipping.state.active.event_loop_p99!.recover_since_ms).toBe(NOW);
  expect(dipping.events.some(event => event.event === 'recovered')).toBe(false);
  // 窗口内条件重新命中：恢复计时作废。
  const rehit = transitionAlerts(dipping.state, [{ rule: 'event_loop_p99', detail: 'p99:400' }],
    context({ now: NOW + MINUTE }));
  expect(rehit.state.active.event_loop_p99!.recover_since_ms).toBeUndefined();
  // 恢复窗口（15 分钟）过后仍无命中才写 recovered。
  const healthy = transitionAlerts(dipping.state, [],
    context({ now: NOW + THRESHOLDS.recoverSpanMs + MINUTE }));
  expect(healthy.state.active.event_loop_p99).toBeUndefined();
  expect(healthy.events.some(event => event.event === 'recovered')).toBe(true);
});

test('采样证据缺失时 check 退出码非 0', () => {
  expect(sampleEvidenceOk(undefined, NOW)).toBe(false);
  expect(sampleEvidenceOk(sample(NOW - MINUTE, {}, false), NOW)).toBe(false);
  expect(sampleEvidenceOk(sample(NOW - 20 * MINUTE), NOW)).toBe(false);
  expect(sampleEvidenceOk(sample(NOW - MINUTE), NOW)).toBe(true);
});

test('未到提醒间隔不重复通知，到点只提醒一次', () => {
  const state: AlertState = { active: { event_loop_p99: { since_ms: NOW - MINUTE, last_notified_ms: NOW - MINUTE } } };
  const hit = { rule: 'event_loop_p99' as const, detail: 'p99:200' };
  const quiet = transitionAlerts(state, [hit], context());
  expect(quiet.events).toHaveLength(0);
  const old: AlertState = { active: { event_loop_p99: {
    since_ms: NOW - 40 * MINUTE, last_notified_ms: NOW - 31 * MINUTE } } };
  const reminded = transitionAlerts(old, [hit], context());
  expect(reminded.events).toHaveLength(1);
  expect(reminded.events[0]!.event).toBe('reminder');
  expect(reminded.state.active.event_loop_p99!.last_notified_ms).toBe(NOW);
});

test('报告标出采样中断与进程实例变化，不跨进程做计数差', () => {
  const before = sample(NOW - 20 * MINUTE);
  const after = { ...sample(NOW), instance: 'proc-b', metrics: metrics({ ingest_accepted: 99 }) };
  const lines = buildReport([before, after], NOW);
  expect(lines.join('\n')).toContain('采集中断 1 处');
  expect(lines.join('\n')).toContain('进程实例变化 1 次');
  expect(lines.join('\n')).toContain('不跨进程');
});

test('报告的存储与准入取窗口内最新值', () => {
  const old = sample(NOW - 10 * MINUTE, {
    storage: { body_bytes: 1, db_bytes: 2, wal_bytes: 0, total_bytes: 3, free_bytes: 4 },
    admission: { mode: 'normal', reason: null, at_ms: NOW - 10 * MINUTE },
  });
  const latest = sample(NOW, {
    storage: { body_bytes: 900, db_bytes: 2, wal_bytes: 0, total_bytes: 902, free_bytes: 4 },
    admission: { mode: 'metadata_only', reason: 'body_budget', at_ms: NOW },
  });
  const text = buildReport([old, latest], NOW).join('\n');
  expect(text).toContain('正文 900 字节');
  expect(text).toContain('准入模式 metadata_only');
});

test('日志归档按大小轮转，保留期与总量上限各自清理最老', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-monitor-'));
  try {
    const live = join(dir, 'collector.log');
    const archives = join(dir, 'archives');
    writeFileSync(live, 'x'.repeat(200));
    const rotated = rotateLog(live, archives, NOW, 100);
    expect(rotated.archived).toBe(true);
    expect(statSync(live).size).toBe(0);
    const archived = readdirSync(archives) as string[];
    expect(archived).toHaveLength(1);
    expect((statSync(join(archives, archived[0]!)).mode & 0o777)).toBe(0o600);

    const pruneDir = join(dir, 'prune');
    mkdirSync(pruneDir);
    const old = join(pruneDir, 'old.log');
    writeFileSync(old, 'y'.repeat(10));
    const oldTime = new Date(NOW - (KEEP_DAYS + 1) * 24 * 60 * MINUTE);
    utimesSync(old, oldTime, oldTime);
    expect(pruneArchives(pruneDir, NOW, KEEP_DAYS)).toBe(1);
    expect(existsSync(old)).toBe(false);

    const first = join(pruneDir, 'first.log');
    const second = join(pruneDir, 'second.log');
    writeFileSync(first, 'z'.repeat(10));
    writeFileSync(second, 'z'.repeat(10));
    utimesSync(first, new Date(NOW - MINUTE), new Date(NOW - MINUTE));
    utimesSync(second, new Date(NOW), new Date(NOW));
    expect(pruneArchives(pruneDir, NOW, KEEP_DAYS, 10)).toBe(1);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('采样按日追加重启不丢历史，14 天后按日清理', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-monitor-'));
  try {
    appendSample(dir, sample(NOW - 20 * MINUTE));
    appendSample(dir, sample(NOW));
    expect(loadSamples(dir, NOW, 30 * MINUTE)).toHaveLength(2);

    mkdirSync(join(dir, 'monitor', 'samples'), { recursive: true });
    const stale = join(dir, 'monitor', 'samples', '2026-01-01.jsonl');
    writeFileSync(stale, '{}\n');
    chmodSync(stale, 0o600);
    expect(pruneMonitorData(dir, NOW)).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(loadSamples(dir, NOW, 30 * MINUTE)).toHaveLength(2);
    expect(readFileSync(join(dir, 'monitor', 'samples', `${localDay(NOW)}.jsonl`), 'utf8')).toContain('proc-a');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('巡检记录按日落盘，成功也写；诊断错误计数带读不到与 0 的区分', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-monitor-'));
  try {
    mkdirSync(join(dir, 'monitor', 'checks'), { recursive: true });
    const stale = join(dir, 'monitor', 'checks', '2026-01-01.jsonl');
    writeFileSync(stale, '{}\n');
    chmodSync(stale, 0o600);
    expect(pruneMonitorData(dir, NOW)).toBe(1);
    expect(existsSync(stale)).toBe(false);

    const log = join(dir, 'collector.log');
    writeFileSync(log, [
      JSON.stringify({ ts: new Date(NOW - MINUTE).toISOString(), kind: 'error', op: 'derive.run', result: 'database_locked' }),
      JSON.stringify({ ts: new Date(NOW - 2 * 24 * 60 * MINUTE).toISOString(), kind: 'error', op: 'route.file', result: 'route_file_error' }),
      JSON.stringify({ ts: new Date(NOW - MINUTE).toISOString(), kind: 'slow', op: 'http.read', result: 'ok' }),
      '{"ts":"broken',
      '',
    ].join('\n'));
    expect(countDiagnosticsErrors(log, NOW - 24 * 60 * MINUTE)).toBe(1);
    expect(countDiagnosticsErrors(join(dir, 'missing.log'), NOW - 24 * 60 * MINUTE)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
