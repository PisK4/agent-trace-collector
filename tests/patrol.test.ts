import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PATROL_THRESHOLDS, collectWeekly, compareSnapshots, evaluateWeekly, isoWeek, judgeSmoke,
  loadHistory, localDay, patrolStateDir, previousSnapshot, saveSnapshot, toSnapshot,
} from '../scripts/patrol';
import type { Snapshot, WeeklyReading } from '../scripts/patrol';
import { fixture } from './fixtures';

const MB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60_000;

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

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'patrol-state-'));
}

function snapshot(period: string, takenAt: number, fileMb: number, overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    period,
    takenAt,
    fileBytes: fileMb * MB,
    bodyBytes: 0,
    pairs: 0,
    over5m: 0,
    spans: 0,
    spanEvidence: 0,
    convs: 0,
    maxRequests: 0,
    convsOver200: 0,
    checks: [],
    ...overrides,
  };
}

test('首次运行没有上期，写下一期后不再说无上期', () => {
  const dir = tempStateDir();
  try {
    const empty = loadHistory(dir);
    expect(empty.corrupt).toBe(false);
    expect(empty.periods).toHaveLength(0);
    expect(previousSnapshot(empty, '2026-W45')).toBeNull();
    const saved = saveSnapshot(dir, snapshot('2026-W45', Date.now(), 5_000));
    expect(saved.periods).toHaveLength(1);
    expect(existsSync(join(dir, 'history.json'))).toBe(true);
    expect(previousSnapshot(loadHistory(dir), '2026-W46')?.period).toBe('2026-W45');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('周环比给出增量、占上期百分比和是否越过阈值', () => {
  const now = Date.now();
  const previous = snapshot('2026-W44', now - 7 * DAY_MS, 4_800, { convsOver200: 90 });
  const current = snapshot('2026-W45', now, 5_000, { convsOver200: 94 });
  const checks = compareSnapshots(current, previous);
  const growth = checks.find(check => check.id === 'growth_delta');
  expect(growth?.state).toBe('ok');
  expect(growth?.detail).toContain('+200.0 MiB');
  expect(growth?.detail).toContain('+4.2%');
  expect(growth?.detail).toContain('日均 +28.6 MiB');
  expect(checks.find(check => check.id === 'conversation_delta')?.detail).toContain('90 → 94（+4）');

  const steep = compareSnapshots(snapshot('2026-W45', now, 7_800), previous);
  expect(steep.find(check => check.id === 'growth_delta')?.state).toBe('over');
});

test('历史文件损坏时退化成无上期可比，下一次写入重建', () => {
  const dir = tempStateDir();
  try {
    writeFileSync(join(dir, 'history.json'), '{ periods: [ 半截');
    const history = loadHistory(dir);
    expect(history.corrupt).toBe(true);
    expect(history.periods).toHaveLength(0);
    expect(previousSnapshot(history, '2026-W45')).toBeNull();
    saveSnapshot(dir, snapshot('2026-W45', Date.now(), 5_000));
    expect(loadHistory(dir).corrupt).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'history.json'), 'utf8')).periods).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('只保留最近 12 期', () => {
  const dir = tempStateDir();
  try {
    let saved = loadHistory(dir);
    for (let week = 1; week <= 15; week += 1) {
      const period = `2026-W${String(week).padStart(2, '0')}`;
      saved = saveSnapshot(dir, snapshot(period, week * DAY_MS, 4_000 + week));
    }
    expect(saved.periods).toHaveLength(12);
    expect(saved.periods[0]?.period).toBe('2026-W04');
    expect(saved.periods[11]?.period).toBe('2026-W15');
    expect(loadHistory(dir).periods).toHaveLength(12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('状态目录可被环境变量覆盖，期号是 ISO 周', () => {
  expect(patrolStateDir({ ATC_PATROL_STATE_DIR: '/tmp/patrol-x' } as NodeJS.ProcessEnv)).toBe('/tmp/patrol-x');
  expect(patrolStateDir({} as NodeJS.ProcessEnv).endsWith(join('tracery', 'patrol'))).toBe(true);
  expect(isoWeek(new Date(2026, 10, 4).getTime())).toMatch(/^\d{4}-W\d{2}$/);
});

test('快照落下采集时间、计数、体积与当次判定', () => {
  const checks = evaluateWeekly(reading());
  const snap = toSnapshot(reading(), checks, new Date(2026, 10, 4).getTime());
  expect(snap.period).toMatch(/^2026-W\d{2}$/);
  expect(snap.fileBytes).toBe(4096 * 120_000);
  expect(snap.bodyBytes).toBe(1_750 * MB);
  expect(snap.convsOver200).toBe(90);
  expect(snap.checks.map(check => check.id)).toContain('body_ratio');
});
