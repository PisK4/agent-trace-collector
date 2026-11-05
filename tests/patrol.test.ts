import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PATROL_THRESHOLDS, collectWeekly, compareSnapshots, dueState, evaluateWeekly, isoWeek, judgeSmoke,
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
    rawSessionBytes: 20 * MB,
    meterUsed: true,
    meterVersion: 1,
    meterError: null,
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
    spanEvidence: 149_200,
    llmSpans: 150_000,
    llmMatched: 149_000,
    nonLlmSpans: 30_000,
    unknownShapeSpans: 0,
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
    spans: 188_000, spanEvidence: 1, llmSpans: 16, llmMatched: 1,
    nonLlmSpans: 187_984, bodyRefs: 0,
    issueReasons: [{ reason: 'span_shape_unknown', n: 150 }],
  }));
  expect(checks.find(check => check.id === 'otlp_yield')?.state).toBe('over');
  expect(checks.find(check => check.id === 'otlp_issues')?.state).toBe('over');
});

test('纯内部 span 与没有正文来源的合法来源不报 OTLP 产出', () => {
  const checks = evaluateWeekly(reading({
    spans: 188_000, spanEvidence: 0, llmSpans: 0, llmMatched: 0,
    nonLlmSpans: 188_000, unknownShapeSpans: 0, bodyRefs: 0,
  }));
  expect(checks.find(check => check.id === 'otlp_yield')?.state).not.toBe('over');
  // 有 LLM span 且全部匹配、但该来源不写 body 时也不报。
  const noBody = evaluateWeekly(reading({
    spans: 20, spanEvidence: 10, llmSpans: 10, llmMatched: 10,
    nonLlmSpans: 10, bodyRefs: 0,
  }));
  expect(noBody.find(check => check.id === 'otlp_yield')?.state).toBe('ok');
});

test('真正遗漏的 LLM span 仍然越界', () => {
  const missed = evaluateWeekly(reading({
    spans: 20, spanEvidence: 10, llmSpans: 10, llmMatched: 0,
    nonLlmSpans: 10, bodyRefs: 0,
  }));
  expect(missed.find(check => check.id === 'otlp_yield')?.state).toBe('over');
  expect(missed.find(check => check.id === 'otlp_yield')?.detail).toContain('LLM span 10');
});

test('会话过大只算越界，>200 的个数留给周环比', () => {
  const checks = evaluateWeekly(reading({ maxRequests: 20_000, convsOver200: 120 }));
  expect(checks.find(check => check.id === 'conversation_size')?.state).toBe('over');
  const normal = evaluateWeekly(reading({ maxRequests: 4_400, convsOver200: 94 }));
  expect(normal.find(check => check.id === 'conversation_size')?.state).toBe('info');
});

test('契约冒烟：400 通过，已修 F20/F41 的旧返回码按回归越界', () => {
  const checks = judgeSmoke([
    { name: 'limit=0', status: 400 },
    { name: 'limit=1.5', status: 400 },
    { name: 'direction=sideways', status: 400 },
    { name: 'bad_pct', status: 500 },
    { name: 'body_from_1e20', status: 200 },
  ]);
  expect(checks.find(check => check.id === 'limit=0')?.state).toBe('ok');
  expect(checks.find(check => check.id === 'direction=sideways')?.state).toBe('ok');
  expect(checks.find(check => check.id === 'bad_pct')?.state).toBe('over');
  expect(checks.find(check => check.id === 'body_from_1e20')?.state).toBe('over');
  expect(judgeSmoke([{ name: 'bad_pct', status: 400 }, { name: 'body_from_1e20', status: 400 }])
    .every(check => check.state === 'ok')).toBe(true);
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

function rawIdentity(traceHex: string, spanHex: string): string {
  return `${traceHex}/${spanHex}`;
}

/** 合成原始 span：只写巡查需要的列，值全部自造。 */
function seedRawSpan(
  f: ReturnType<typeof fixture>,
  input: { traceHex: string; spanHex: string; service: string; name: string; receivedAt: number },
): string {
  f.store.write(db => db.run(
    `INSERT INTO raw_otlp_span(trace_id,span_id,received_at,service,scope_name,name,kind,start_ms,
       end_ms,status_code,attributes_json,mapping_version,privacy_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [Buffer.from(input.traceHex, 'hex'), Buffer.from(input.spanHex, 'hex'), input.receivedAt,
      input.service, null, input.name, 0, input.receivedAt, null, null, '{}', 4, 1],
  ));
  return rawIdentity(input.traceHex, input.spanHex);
}

function seedEvidence(f: ReturnType<typeof fixture>, refKey: string, reqId = 1): void {
  f.store.write(db => db.run(
    `INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,match_rule,added_at)
     VALUES (?,'otlp_span',?,'merged','trace_span.v1',?)`,
    [reqId, refKey, Date.now()],
  ));
}

test('只有窗口内物理 span 计入产出，TTL 后的长期证据不进分子', () => {
  const f = fixture();
  const NOW = 1_760_000_000_000;
  try {
    // 窗口内只有一条内部 span；它本来就不该产出 LLM 证据。
    seedRawSpan(f, {
      traceHex: 'aa'.repeat(16), spanHex: 'bb'.repeat(8),
      service: 'claude-code', name: 'fs.read_file', receivedAt: NOW - 1000,
    });
    // 窗口外的旧 LLM span 与其长期证据：raw 已过 TTL，证据仍在库里。
    const oldTrace = 'cc'.repeat(16);
    const oldSpan = 'dd'.repeat(8);
    seedRawSpan(f, {
      traceHex: oldTrace, spanHex: oldSpan,
      service: 'claude-code', name: 'claude_code.llm_request', receivedAt: NOW - 8 * DAY_MS,
    });
    seedEvidence(f, rawIdentity(oldTrace, oldSpan));
    // 没有对应 raw 的长期证据同样不进分子。
    seedEvidence(f, rawIdentity('ee'.repeat(16), 'ff'.repeat(8)));
    f.store.close();

    const collected = collectWeekly(join(f.dir, 'trace.db'), f.dir, NOW);
    expect(collected.spans).toBe(1);
    expect(collected.spanEvidence).toBe(0);
    expect(collected.llmSpans).toBe(0);
    expect(collected.nonLlmSpans).toBe(1);
    expect(evaluateWeekly(collected).find(check => check.id === 'otlp_yield')?.state).not.toBe('over');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('窗口内遗漏的 LLM span 仍然越界，身份匹配后放行', () => {
  const NOW = 1_760_000_000_000;
  const missed = fixture();
  try {
    for (let index = 0; index < 10; index++) {
      seedRawSpan(missed, {
        traceHex: index.toString(16).padStart(2, '0').repeat(16),
        spanHex: (index + 16).toString(16).padStart(2, '0').repeat(8),
        service: 'claude-code', name: 'claude_code.llm_request', receivedAt: NOW - 1000,
      });
    }
    missed.store.close();
    const readingMissed = collectWeekly(join(missed.dir, 'trace.db'), missed.dir, NOW);
    expect({ spans: readingMissed.spans, llm: readingMissed.llmSpans, matched: readingMissed.llmMatched })
      .toEqual({ spans: 10, llm: 10, matched: 0 });
    expect(evaluateWeekly(readingMissed).find(check => check.id === 'otlp_yield')?.state).toBe('over');
  } finally {
    rmSync(missed.dir, { recursive: true, force: true });
  }

  const matched = fixture();
  try {
    for (let index = 0; index < 10; index++) {
      const refKey = seedRawSpan(matched, {
        traceHex: (index + 32).toString(16).padStart(2, '0').repeat(16),
        spanHex: (index + 48).toString(16).padStart(2, '0').repeat(8),
        service: 'claude-code', name: 'claude_code.llm_request', receivedAt: NOW - 1000,
      });
      seedEvidence(matched, refKey);
    }
    matched.store.close();
    const readingMatched = collectWeekly(join(matched.dir, 'trace.db'), matched.dir, NOW);
    expect({ llm: readingMatched.llmSpans, matched: readingMatched.llmMatched, bodyRefs: readingMatched.bodyRefs })
      .toEqual({ llm: 10, matched: 10, bodyRefs: 0 });
    expect(evaluateWeekly(readingMatched).find(check => check.id === 'otlp_yield')?.state).toBe('ok');
  } finally {
    rmSync(matched.dir, { recursive: true, force: true });
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

test('四源预算单列，计数不可用时显式标出', () => {
  const healthy = evaluateWeekly(reading({ rawSessionBytes: 200 * MB }));
  expect(healthy.find(check => check.id === 'body_budget')?.detail).toContain('四源逻辑载荷 1950.0 MiB');
  expect(healthy.find(check => check.id === 'body_budget')?.detail).toContain('raw_session 200.0）');
  expect(healthy.find(check => check.id === 'capacity_meter')?.state).toBe('ok');

  // v13 旧库回退全表求和是预期状态，只做提示；结构坏了才越界。
  const legacy = evaluateWeekly(reading({
    meterUsed: false, meterVersion: null, meterError: 'capacity_meter_missing',
  }));
  expect(legacy.find(check => check.id === 'capacity_meter')?.state).toBe('info');
  const broken = evaluateWeekly(reading({
    meterUsed: false, meterVersion: null, meterError: 'capacity_meter_invalid',
  }));
  expect(broken.find(check => check.id === 'capacity_meter')?.state).toBe('over');
  expect(broken.find(check => check.id === 'capacity_meter')?.detail).toContain('增量计数未生效');
});

test('计量版本变化时提示读数不可直接比较', () => {
  const now = Date.now();
  const v2 = snapshot('2026-W45', now, 5_000, { meterVersion: 2 });
  const upgraded = compareSnapshots(v2, snapshot('2026-W44', now - 7 * DAY_MS, 4_800, { meterVersion: 1 }));
  expect(upgraded.find(check => check.id === 'meter_version')?.detail).toContain('计量版本 1 → 2');
  expect(upgraded.find(check => check.id === 'meter_version')?.detail).toContain('不可直接比较');
  const same = compareSnapshots(v2, snapshot('2026-W44', now - 7 * DAY_MS, 4_800, { meterVersion: 2 }));
  expect(same.find(check => check.id === 'meter_version')?.detail).toBe('计量 v2');
  const legacy = compareSnapshots(v2, snapshot('2026-W44', now - 7 * DAY_MS, 4_800));
  expect(legacy.find(check => check.id === 'meter_version')?.detail).toContain('legacy → 2');
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

test('到期闸门只看本期是否已有快照，无历史与损坏历史都算到期', () => {
  const now = new Date(2026, 10, 4).getTime();
  const thisWeek = isoWeek(now);
  const recent: Snapshot[] = [
    snapshot('2026-W44', now - 10 * DAY_MS, 4_800),
    snapshot(thisWeek, now - 3 * DAY_MS, 5_000),
  ];
  const fresh = dueState({ periods: recent, corrupt: false, path: '/tmp/history.json' }, now);
  expect(fresh.due).toBe(false);
  expect(fresh.ageDays).toBeCloseTo(3, 5);
  // 同周重跑把 takenAt 刷到今天，下一期头一天仍应放行，而不是整周被跳过。
  const rerun: Snapshot[] = [recent[0], { ...recent[1], takenAt: now }];
  const nextWeek = new Date(2026, 10, 11).getTime();
  expect(dueState({ periods: rerun, corrupt: false, path: '/tmp/history.json' }, nextWeek).due).toBe(true);
  expect(dueState({ periods: [recent[0]], corrupt: false, path: '/tmp/history.json' }, now).due).toBe(true);
  expect(dueState({ periods: [], corrupt: false, path: '/tmp/history.json' }, now)).toEqual({ due: true, ageDays: null });
  expect(dueState({ periods: [], corrupt: true, path: '/tmp/history.json' }, now).due).toBe(true);
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
