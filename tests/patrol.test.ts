import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  PATROL_THRESHOLDS, collectWeekly, evaluateWeekly, judgeSmoke, localDay,
} from '../scripts/patrol';
import type { WeeklyReading } from '../scripts/patrol';
import { fixture } from './fixtures';

const MB = 1024 * 1024;

function reading(overrides: Partial<WeeklyReading> = {}): WeeklyReading {
  return {
    pageSize: 4096,
    pageCount: 120_000,
    freelist: 12,
    blockBytes: 600 * MB,
    skeletonBytes: 1_100 * MB,
    rawHookBytes: 50 * MB,
    walBytes: 2 * MB,
    freeBytes: 300_000 * MB,
    diskBytes: 1_000_000 * MB,
    tables: [],
    pairs: 50_000,
    over5m: 1,
    pendingHook: 1_400,
    pendingOldestDays: 11,
    pendingToday: 20,
    pendingPriorAvg: 20,
    hookAbsentLatest: { day: localDay(Date.now()), n: 400 },
    hookAbsentPriorMean: 300,
    hookAbsentTopAgent: { agent: 'claude', n: 300 },
    spans: 180_000,
    spanEvidence: 200,
    bodyRefs: 5,
    issueReasons: [],
    convs: 1_600,
    maxRequests: 4_400,
    convsOver200: 90,
    topConvs: [],
    ...overrides,
  };
}

test('健康读数只有信息项，没有越界项', () => {
  const checks = evaluateWeekly(reading());
  expect(checks.filter(check => check.state === 'over')).toHaveLength(0);
  expect(checks.find(check => check.id === 'growth')?.state).toBe('info');
});

test('库体量太小的时候不判正文占比', () => {
  const checks = evaluateWeekly(reading({
    pageCount: 1000, blockBytes: 0, skeletonBytes: 0, rawHookBytes: 0,
  }));
  expect(checks.find(check => check.id === 'body_ratio')?.state).toBe('info');
});

test('正文占比、freelist、WAL、可用空间越界各自报出', () => {
  const checks = evaluateWeekly(reading({
    blockBytes: 100 * MB, skeletonBytes: 100 * MB, rawHookBytes: 0,
    freelist: 500, walBytes: 60 * MB, freeBytes: 100_000 * MB,
  }));
  for (const id of ['body_ratio', 'freelist', 'wal', 'free_space']) {
    expect(checks.find(check => check.id === id)?.state).toBe('over');
  }
  expect(PATROL_THRESHOLDS.walBytes).toBe(32 * MB);
});

test('证据缺口、pending_hook 突增、hook_absent 突增各自报出', () => {
  const checks = evaluateWeekly(reading({
    pairs: 1000, over5m: 20, pendingToday: 100, pendingPriorAvg: 20,
    hookAbsentLatest: { day: '2026-11-04', n: 900 }, hookAbsentPriorMean: 300,
  }));
  for (const id of ['evidence_gap', 'pending_hook', 'hook_absent']) {
    expect(checks.find(check => check.id === id)?.state).toBe('over');
  }
});

test('OTLP 只收不产出与单条 issue 超量报出', () => {
  const checks = evaluateWeekly(reading({
    spans: 188_000, spanEvidence: 1, bodyRefs: 0,
    issueReasons: [{ reason: 'span_shape_unknown', n: 150 }],
  }));
  expect(checks.find(check => check.id === 'otlp_yield')?.state).toBe('over');
  expect(checks.find(check => check.id === 'otlp_issues')?.state).toBe('over');
});

test('会话过大只算越界，>200 的个数留给周环比', () => {
  const checks = evaluateWeekly(reading({ maxRequests: 20_000, convsOver200: 120 }));
  expect(checks.find(check => check.id === 'conversation_size')?.state).toBe('over');
  const normal = evaluateWeekly(reading({ maxRequests: 4_400, convsOver200: 94 }));
  expect(normal.find(check => check.id === 'conversation_size')?.state).toBe('info');
});

test('契约冒烟：400 通过，5xx 越界，F20/F41 的已知基线记 info', () => {
  const checks = judgeSmoke([
    { name: 'limit=0', status: 400 },
    { name: 'limit=1.5', status: 400 },
    { name: 'direction=sideways', status: 400 },
    { name: 'bad_pct', status: 500 },
    { name: 'body_from_1e20', status: 200 },
  ]);
  expect(checks.find(check => check.id === 'limit=0')?.state).toBe('ok');
  expect(checks.find(check => check.id === 'direction=sideways')?.state).toBe('ok');
  expect(checks.find(check => check.id === 'bad_pct')?.state).toBe('info');
  expect(checks.find(check => check.id === 'body_from_1e20')?.state).toBe('info');
  const broken = judgeSmoke([{ name: 'direction=sideways', status: 200 }, { name: 'bad_pct', status: 503 }]);
  expect(broken[0]?.state).toBe('over');
  expect(broken[1]?.state).toBe('over');
});

test('空库能收集读数且不误报 OTLP 产出', () => {
  const f = fixture();
  f.store.close();
  try {
    const collected = collectWeekly(join(f.dir, 'trace.db'), f.dir);
    expect(collected.pageCount).toBeGreaterThan(0);
    expect(collected.pairs).toBe(0);
    expect(collected.spans).toBe(0);
    const checks = evaluateWeekly(collected);
    expect(checks.find(check => check.id === 'otlp_yield')?.state).toBe('ok');
    expect(checks.find(check => check.id === 'body_ratio')?.state).toBe('info');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
