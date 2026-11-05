/**
 * 巡检：把巡查里能计算的部分固化成只读命令。
 *
 * 数据库用只读连接打开，磁盘读数走 statfs；不写库、不改 schema、不重启进程。
 * 唯一的写点是周快照：写到维护者的状态目录（默认 <data>/patrol，可用
 * ATC_PATROL_STATE_DIR 或 --state-dir 改），不写库、不写仓库工作区。
 * 阈值只在这里定义，docs/patrol.md 讲节奏与误报边界，不复制数字。
 *
 * 用法：
 *   bun scripts/patrol.ts weekly [--data-dir PATH] [--state-dir PATH] [--if-due] [--json]
 *   bun scripts/patrol.ts smoke [--port N] [--data-dir PATH] [--json]
 *
 * 退出码：0 全部通过或只有信息项；1 有越界项；2 用法错误或读不到库。
 */
import { Database } from 'bun:sqlite';
import {
  existsSync, mkdirSync, readFileSync, renameSync, statfsSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { defaultDataDir } from '../src/config';
import {
  CAPACITY_METER_VERSION, capacityMeterStatus, exactCapacitySums,
} from '../src/capacity-meter';
import { readToken } from './service-support';

const MB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60_000;
const HISTORY_FILE = 'history.json';
const HISTORY_LIMIT = 12;

/**
 * 阈值与判定口径。数字随容量策略一起改；改这里等于改巡检标准，docs/patrol.md
 * 的阈值表要同步，但权威读数仍以本文件为准。
 */
export const PATROL_THRESHOLDS = {
  /** 正文（block + skeleton + raw_hook）占库文件的比例下限。 */
  bodyRatioMin: 0.45,
  /** 库还小于这个体量时比例没有意义，不判。 */
  bodyRatioMinBytes: 256 * MB,
  // 周环比依赖状态目录里的上一期快照，见 compareSnapshots。
  growthDailyBytes: 500 * MB,
  growthWeeklyBytes: 2.5 * 1024 * MB,
  freelistPages: 200,
  walBytes: 32 * MB,
  freeRatioMin: 0.2,
  evidenceGapRatio: 0.005,
  pendingHookMultiple: 2,
  hookAbsentDaily: 500,
  otlpMinSpans: 10_000,
  otlpEvidenceRatioMin: 0.001,
  issueDaily: 100,
  convMaxRequests: 10_000,
  convWarnRequests: 200,
} as const;

export type CheckState = 'ok' | 'over' | 'info';

export type Check = { id: string; state: CheckState; detail: string };

export type WeeklyReading = {
  pageSize: number;
  pageCount: number;
  freelist: number;
  blockBytes: number;
  skeletonBytes: number;
  rawHookBytes: number;
  /** 四源预算总量里的会话原始层部分；不并入三源正文比例。 */
  rawSessionBytes: number;
  /** 正文读数来自 v14 计数还是回退到全表求和。 */
  meterUsed: boolean;
  meterVersion: number | null;
  meterError: string | null;
  walBytes: number;
  freeBytes: number;
  diskBytes: number;
  tables: { name: string; bytes: number }[];
  pairs: number;
  over5m: number;
  pendingHook: number;
  pendingOldestDays: number | null;
  pendingToday: number;
  pendingPriorAvg: number;
  hookAbsentLatest: { day: string; n: number } | null;
  hookAbsentPriorMean: number;
  hookAbsentTopAgent: { agent: string; n: number } | null;
  spans: number;
  spanEvidence: number;
  bodyRefs: number;
  issueReasons: { reason: string; n: number }[];
  convs: number;
  maxRequests: number;
  convsOver200: number;
  topConvs: { convKey: string; n: number }[];
};

const mb = (bytes: number): string => (bytes / MB).toFixed(1);
const pct = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`;

export function evaluateWeekly(reading: WeeklyReading): Check[] {
  const fileBytes = reading.pageSize * reading.pageCount;
  const bodyBytes = reading.blockBytes + reading.skeletonBytes + reading.rawHookBytes;
  const bodyRatio = fileBytes > 0 ? bodyBytes / fileBytes : 0;
  const freeRatio = reading.diskBytes > 0 ? reading.freeBytes / reading.diskBytes : 0;
  const gapRatio = reading.pairs > 0 ? reading.over5m / reading.pairs : 0;
  const otlpRatio = reading.spans > 0 ? reading.spanEvidence / reading.spans : 0;
  const maxIssue = reading.issueReasons.reduce((top, row) => Math.max(top, row.n), 0);
  const checks: Check[] = [];

  checks.push({
    id: 'body_ratio',
    state: fileBytes < PATROL_THRESHOLDS.bodyRatioMinBytes
      ? 'info'
      : bodyRatio < PATROL_THRESHOLDS.bodyRatioMin ? 'over' : 'ok',
    detail: `三源正文 ${mb(bodyBytes)} MiB / 文件 ${mb(fileBytes)} MiB = ${pct(bodyRatio)}，下限 ${pct(PATROL_THRESHOLDS.bodyRatioMin)}`,
  });
  checks.push({
    id: 'body_budget',
    state: 'info',
    // 四源预算总量与三源正文比例含义不同，单独表达，不混进 body_ratio。
    detail: `四源逻辑载荷 ${mb(bodyBytes + reading.rawSessionBytes)} MiB（block ${mb(reading.blockBytes)} + 骨架 ${mb(reading.skeletonBytes)} + raw_hook ${mb(reading.rawHookBytes)} + raw_session ${mb(reading.rawSessionBytes)}）`,
  });
  checks.push({
    id: 'capacity_meter',
    state: reading.meterUsed
      ? 'ok' : (reading.meterError === 'capacity_meter_missing' ? 'info' : 'over'),
    detail: reading.meterUsed
      ? `计数 v${reading.meterVersion ?? CAPACITY_METER_VERSION}`
      : `计数不可用（${reading.meterError ?? 'unknown'}），正文按全表求和；增量计数未生效`,
  });
  checks.push({
    id: 'growth',
    state: 'info',
    detail: `文件 ${mb(fileBytes)} MiB；日增与周增的环比见 growth_delta`,
  });
  checks.push({
    id: 'freelist',
    state: reading.freelist > PATROL_THRESHOLDS.freelistPages ? 'over' : 'ok',
    detail: `${reading.freelist} 页，上限 ${PATROL_THRESHOLDS.freelistPages} 页`,
  });
  checks.push({
    id: 'wal',
    state: reading.walBytes > PATROL_THRESHOLDS.walBytes ? 'over' : 'ok',
    detail: `-wal ${mb(reading.walBytes)} MiB，上限 ${mb(PATROL_THRESHOLDS.walBytes)} MiB`,
  });
  checks.push({
    id: 'free_space',
    state: reading.diskBytes > 0 && freeRatio < PATROL_THRESHOLDS.freeRatioMin ? 'over' : 'ok',
    detail: `可用 ${mb(reading.freeBytes)} MiB / ${mb(reading.diskBytes)} MiB = ${pct(freeRatio)}，下限 ${pct(PATROL_THRESHOLDS.freeRatioMin)}`,
  });
  checks.push({
    id: 'evidence_gap',
    state: gapRatio > PATROL_THRESHOLDS.evidenceGapRatio ? 'over' : 'ok',
    detail: `hook/ledger 成对 ${reading.pairs}，gap>5min ${reading.over5m} = ${pct(gapRatio)}，上限 ${pct(PATROL_THRESHOLDS.evidenceGapRatio)}`,
  });
  checks.push({
    id: 'pending_hook',
    state: reading.pendingPriorAvg > 0
      && reading.pendingToday > PATROL_THRESHOLDS.pendingHookMultiple * reading.pendingPriorAvg
      ? 'over' : 'ok',
    detail: `在库 ${reading.pendingHook}，今日新增 ${reading.pendingToday}，前 7 日均值 ${reading.pendingPriorAvg.toFixed(1)}，最老 ${reading.pendingOldestDays === null ? '无' : `${reading.pendingOldestDays.toFixed(1)} 天`}`,
  });
  checks.push({
    id: 'hook_absent',
    state: reading.hookAbsentLatest !== null
      && reading.hookAbsentLatest.n > PATROL_THRESHOLDS.hookAbsentDaily
      && reading.hookAbsentPriorMean > 0
      && reading.hookAbsentLatest.n > PATROL_THRESHOLDS.pendingHookMultiple * reading.hookAbsentPriorMean
      ? 'over' : 'ok',
    detail: `最近完整一天 ${reading.hookAbsentLatest === null ? '无' : `${reading.hookAbsentLatest.day} ${reading.hookAbsentLatest.n}`}，前 7 日均值 ${reading.hookAbsentPriorMean.toFixed(1)}，单 agent 最多 ${reading.hookAbsentTopAgent === null ? '无' : `${reading.hookAbsentTopAgent.agent} ${reading.hookAbsentTopAgent.n}`}`,
  });
  checks.push({
    id: 'otlp_yield',
    state: (reading.spans >= PATROL_THRESHOLDS.otlpMinSpans
      && otlpRatio < PATROL_THRESHOLDS.otlpEvidenceRatioMin)
      || (reading.spans > 0 && reading.bodyRefs === 0)
      ? 'over' : 'ok',
    detail: `span ${reading.spans}，span 证据 ${reading.spanEvidence} = ${pct(otlpRatio)}，body_ref ${reading.bodyRefs}`,
  });
  checks.push({
    id: 'otlp_issues',
    state: maxIssue > PATROL_THRESHOLDS.issueDaily ? 'over' : 'ok',
    detail: `近 7 日单条理由最多 ${maxIssue}，上限 ${PATROL_THRESHOLDS.issueDaily}；${reading.issueReasons.map(row => `${row.reason}:${row.n}`).join(' ') || '无'}`,
  });
  checks.push({
    id: 'conversation_size',
    state: reading.maxRequests > PATROL_THRESHOLDS.convMaxRequests ? 'over' : 'info',
    detail: `会话 ${reading.convs}，最大 ${reading.maxRequests} 请求，>${PATROL_THRESHOLDS.convWarnRequests} 的 ${reading.convsOver200} 个`,
  });
  checks.push({
    id: 'dbstat',
    state: 'info',
    detail: reading.tables.map(row => `${row.name}:${mb(row.bytes)}`).join(' ') || '无',
  });
  return checks;
}

export function collectWeekly(dbPath: string, dataDir: string, nowMs = Date.now()): WeeklyReading {
  const db = new Database(dbPath, { readonly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const pageSize = db.query<{ page_size: number }, []>('PRAGMA page_size').get()?.page_size ?? 0;
    const pageCount = db.query<{ page_count: number }, []>('PRAGMA page_count').get()?.page_count ?? 0;
    const freelist = db.query<{ freelist_count: number }, []>('PRAGMA freelist_count').get()?.freelist_count ?? 0;
    // 计数可用时只读四行；v13 旧库回退到全表求和，并明确标记不是计数读数。
    const meter = capacityMeterStatus(db);
    const exact = meter.ok ? null : exactCapacitySums(db);
    const blockBytes = meter.ok ? meter.sources.block.bytes : exact!.block.bytes;
    const skeletonBytes = meter.ok ? meter.sources.request.bytes : exact!.request.bytes;
    const rawHookBytes = meter.ok ? meter.sources.raw_hook.bytes : exact!.raw_hook.bytes;
    const rawSessionBytes = meter.ok
      ? meter.sources.raw_session_event.bytes : exact!.raw_session_event.bytes;
    const walPath = `${dbPath}-wal`;
    const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;
    const space = diskSpace(dataDir);
    const tables = db.query<{ name: string; bytes: number }, []>(
      'SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 12').all();

    const pairRow = db.query<{ pairs: number; over_5m: number | null }, []>(
      `WITH h AS (SELECT req_id, MIN(added_at) AS t FROM request_evidence WHERE source_kind='hook' GROUP BY req_id),
            l AS (SELECT req_id, MIN(added_at) AS t FROM request_evidence WHERE source_kind='ledger' GROUP BY req_id)
       SELECT COUNT(*) AS pairs, SUM(CASE WHEN l.t-h.t>300000 THEN 1 ELSE 0 END) AS over_5m
         FROM h JOIN l USING(req_id)`).get();
    const pendingRow = db.query<{ n: number; oldest: number | null }, []>(
      'SELECT COUNT(*) AS n, MIN(first_seen) AS oldest FROM pending_hook').get();
    const pendingDays = db.query<{ day: string; n: number }, []>(
      `SELECT day, n FROM (SELECT date(first_seen/1000,'unixepoch','localtime') AS day, COUNT(*) AS n
         FROM pending_hook GROUP BY day) ORDER BY day DESC LIMIT 8`).all();
    const hookAbsentDays = db.query<{ day: string; n: number }, []>(
      `SELECT day, COUNT(*) AS n FROM request WHERE miss_reason='hook_absent'
        GROUP BY day ORDER BY day DESC LIMIT 8`).all();
    const topAgentRow = hookAbsentDays[0] === undefined ? null : db.query<{ agent: string | null; n: number }, [string]>(
      `SELECT agent, COUNT(*) AS n FROM request WHERE miss_reason='hook_absent' AND day >= ?
        GROUP BY agent ORDER BY n DESC LIMIT 1`).get(hookAbsentDays[0].day);

    const spans = count(db, 'raw_otlp_span');
    const spanEvidence = db.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM request_evidence WHERE source_kind='otlp_span'").get()?.n ?? 0;
    const bodyRefs = count(db, 'otlp_body_ref');
    const issueReasons = db.query<{ reason: string; n: number }, [number]>(
      'SELECT reason, COUNT(*) AS n FROM ingest_issue WHERE observed_at >= ? GROUP BY reason ORDER BY n DESC LIMIT 6')
      .all(nowMs - 7 * DAY_MS);

    const convRow = db.query<{ convs: number; max_req: number }, []>(
      'SELECT COUNT(*) AS convs, IFNULL(MAX(c),0) AS max_req FROM (SELECT COUNT(*) AS c FROM request GROUP BY conv_key)').get();
    const convsOver200 = db.query<{ n: number }, [number]>(
      `SELECT COUNT(*) AS n FROM (SELECT COUNT(*) AS c FROM request GROUP BY conv_key) WHERE c > ?`)
      .get(PATROL_THRESHOLDS.convWarnRequests)?.n ?? 0;
    const topConvs = db.query<{ conv_key: string | null; n: number }, []>(
      'SELECT conv_key, COUNT(*) AS n FROM request GROUP BY conv_key ORDER BY n DESC LIMIT 5').all();

    const arrivalDays = pendingDays.slice(1, 8);
    const pendingToday = pendingDays[0]?.day === localDay(nowMs) ? pendingDays[0].n : 0;
    const pendingPriorAvg = average(arrivalDays.map(row => row.n));
    // 今天只过了一部分，按整天均值判会偏漏报；取最近一个完整日。
    const fullDays = hookAbsentDays.filter(row => row.day !== localDay(nowMs));
    const absentLatest = fullDays[0] ?? hookAbsentDays[0] ?? null;
    const absentHistory = fullDays.slice(1);
    const absentPriorMean = average(absentHistory.map(row => row.n));

    return {
      pageSize,
      pageCount,
      freelist,
      blockBytes,
      skeletonBytes,
      rawHookBytes,
      rawSessionBytes,
      meterUsed: meter.ok,
      meterVersion: meter.ok ? meter.version : null,
      meterError: meter.ok ? null : meter.error,
      walBytes,
      freeBytes: space.freeBytes,
      diskBytes: space.totalBytes,
      tables,
      pairs: pairRow?.pairs ?? 0,
      over5m: pairRow?.over_5m ?? 0,
      pendingHook: pendingRow?.n ?? 0,
      pendingOldestDays: pendingRow?.oldest === null || pendingRow?.oldest === undefined
        ? null : (nowMs - pendingRow.oldest) / DAY_MS,
      pendingToday,
      pendingPriorAvg,
      hookAbsentLatest: absentLatest,
      hookAbsentPriorMean: absentPriorMean,
      hookAbsentTopAgent: topAgentRow === null ? null : { agent: topAgentRow.agent ?? '未知', n: topAgentRow.n },
      spans,
      spanEvidence,
      bodyRefs,
      issueReasons,
      convs: convRow?.convs ?? 0,
      maxRequests: convRow?.max_req ?? 0,
      convsOver200,
      topConvs: topConvs.map(row => ({ convKey: row.conv_key ?? '', n: row.n })),
    };
  } finally {
    db.close();
  }
}

function count(db: Database, table: string): number {
  return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function localDay(nowMs: number): string {
  const date = new Date(nowMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function diskSpace(path: string): { freeBytes: number; totalBytes: number } {
  try {
    const info = statfsSync(path);
    return {
      freeBytes: Number(info.bavail) * Number(info.bsize),
      totalBytes: Number(info.blocks) * Number(info.bsize),
    };
  } catch {
    return { freeBytes: 0, totalBytes: 0 };
  }
}

export type SmokeProbe = { name: string; status: number | null };

/** 契约冒烟：每个探测只认一个期望码；F41 未修的区间基线与 200 合法截断单独记。 */
export function judgeSmoke(probes: SmokeProbe[]): Check[] {
  return probes.map(probe => {
    if (probe.status === null) return { id: probe.name, state: 'over', detail: '请求未完成' };
    if (probe.name === 'body_from_1e20') {
      if (probe.status === 400) return { id: probe.name, state: 'ok', detail: '400' };
      if (probe.status === 200) {
        return { id: probe.name, state: 'info', detail: '200，F41 未修前的已知基线，修好后应变 400' };
      }
      return { id: probe.name, state: 'over', detail: `${probe.status}` };
    }
    if (probe.name === 'bad_pct') {
      if (probe.status === 400) return { id: probe.name, state: 'ok', detail: '400' };
      if (probe.status === 500) {
        return { id: probe.name, state: 'info', detail: '500，F20 未修前的已知基线，修好后应变 400' };
      }
      return { id: probe.name, state: 'over', detail: `${probe.status}` };
    }
    if (probe.name === 'limit=201' && probe.status === 200) {
      return { id: probe.name, state: 'info', detail: '200：产品若改成截断则合法，以响应体 error 字段为准' };
    }
    return probe.status === 400
      ? { id: probe.name, state: 'ok', detail: '400' }
      : { id: probe.name, state: 'over', detail: `${probe.status}` };
  });
}

export async function runSmoke(dataDir: string, port: number): Promise<Check[]> {
  const token = readToken(dataDir);
  if (token === null) return [{ id: 'read_token', state: 'over', detail: '读不到 read.token' }];
  const dbPath = join(dataDir, 'trace.db');
  const db = existsSync(dbPath) ? new Database(dbPath, { readonly: true }) : null;
  let reqId = '';
  let convKey = '';
  try {
    reqId = String(db?.query<{ id: number | null }, []>('SELECT MAX(req_id) AS id FROM request').get()?.id ?? '');
    convKey = db?.query<{ key: string | null }, []>(
      'SELECT conv_key AS key FROM request GROUP BY conv_key ORDER BY COUNT(*) DESC LIMIT 1').get()?.key ?? '';
  } finally {
    db?.close();
  }
  const base = `http://127.0.0.1:${port}`;
  const targets: { name: string; path: string }[] = [
    { name: 'limit=0', path: '/api/sessions?limit=0' },
    { name: 'limit=201', path: '/api/sessions?limit=201' },
    { name: 'limit=1.5', path: '/api/sessions?limit=1.5' },
    { name: 'bad_pct', path: '/api/sessions/%ZZ/requests' },
  ];
  if (convKey !== '') {
    targets.push({
      name: 'direction=sideways',
      path: `/api/sessions/${encodeURIComponent(convKey)}/requests?direction=sideways`,
    });
  }
  if (reqId !== '') {
    targets.push({ name: 'body_from_1e20', path: `/api/requests/${reqId}/body?from=99999999999999999999` });
  }
  const probes: SmokeProbe[] = [];
  for (const target of targets) {
    try {
      const response = await fetch(`${base}${target.path}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      probes.push({ name: target.name, status: response.status });
    } catch {
      probes.push({ name: target.name, status: null });
    }
  }
  return judgeSmoke(probes);
}

/** 一期快照：够做周环比，不复制判定细节。 */
export type Snapshot = {
  period: string;
  takenAt: number;
  fileBytes: number;
  /** 三源正文；历史快照没有 meterVersion，与 v14 口径分开比较。 */
  bodyBytes: number;
  /** 四源预算总量，v14 起才有。 */
  bodyBudgetBytes?: number;
  meterVersion?: number;
  pairs: number;
  over5m: number;
  spans: number;
  spanEvidence: number;
  convs: number;
  maxRequests: number;
  convsOver200: number;
  checks: { id: string; state: CheckState }[];
};

export type History = { periods: Snapshot[]; corrupt: boolean; path: string };

/** 状态目录默认跟着数据目录走（<data>/patrol），可被 ATC_PATROL_STATE_DIR 覆盖。 */
export function patrolStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ATC_PATROL_STATE_DIR;
  return override !== undefined && override.trim() !== '' ? override : join(defaultDataDir(env), 'patrol');
}

/** 期号用 ISO 周，同一周重跑只覆盖本期。 */
export function isoWeek(nowMs: number): string {
  const local = new Date(nowMs);
  const thursday = new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()));
  const day = thursday.getUTCDay() || 7;
  thursday.setUTCDate(thursday.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((thursday.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function isSnapshot(value: unknown): value is Snapshot {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Partial<Snapshot>;
  return typeof row.period === 'string'
    && typeof row.takenAt === 'number'
    && typeof row.fileBytes === 'number'
    && typeof row.bodyBytes === 'number'
    && typeof row.pairs === 'number'
    && typeof row.convs === 'number'
    && typeof row.convsOver200 === 'number'
    && Array.isArray(row.checks);
}

/** 缺失返回空历史；解析失败或形状不符记 corrupt，调用方退化成「无上期可比」。 */
export function loadHistory(stateDir: string): History {
  const path = join(stateDir, HISTORY_FILE);
  if (!existsSync(path)) return { periods: [], corrupt: false, path };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const raw = (parsed as { periods?: unknown } | null)?.periods;
    if (!Array.isArray(raw)) return { periods: [], corrupt: true, path };
    const periods = raw.filter(isSnapshot);
    return { periods, corrupt: periods.length !== raw.length, path };
  } catch {
    return { periods: [], corrupt: true, path };
  }
}

/** 写入本期并裁剪到最近 HISTORY_LIMIT 期；先写临时文件再改名，避免半写。 */
export function saveSnapshot(stateDir: string, snapshot: Snapshot, limit = HISTORY_LIMIT): History {
  const path = join(stateDir, HISTORY_FILE);
  mkdirSync(stateDir, { recursive: true });
  const existing = loadHistory(stateDir);
  const periods = [...existing.periods.filter(row => row.period !== snapshot.period), snapshot]
    .sort((a, b) => (a.period < b.period ? 1 : -1))
    .slice(0, limit)
    .sort((a, b) => (a.period < b.period ? -1 : 1));
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ periods }, null, 2)}\n`);
  renameSync(temp, path);
  return { periods, corrupt: false, path };
}

/** 只比严格更早的期；同一周重跑不与自己比。 */
export function previousSnapshot(history: History, period: string): Snapshot | null {
  return history.periods
    .filter(row => row.period < period)
    .sort((a, b) => (a.period < b.period ? 1 : -1))[0] ?? null;
}

/** `--if-due`：本期已有快照就算未到期；没有历史或历史损坏视为到期。
 *  同周不带闸门重跑会覆盖本期并刷新 takenAt，用天数判断会让下一期整周被跳过。 */
export function dueState(
  history: History,
  nowMs: number,
): { due: boolean; ageDays: number | null } {
  const latest = history.periods[history.periods.length - 1];
  if (latest === undefined) return { due: true, ageDays: null };
  const ageDays = Math.max((nowMs - latest.takenAt) / DAY_MS, 0);
  return { due: !history.periods.some(row => row.period === isoWeek(nowMs)), ageDays };
}

export function toSnapshot(reading: WeeklyReading, checks: Check[], nowMs = Date.now()): Snapshot {
  return {
    period: isoWeek(nowMs),
    takenAt: nowMs,
    fileBytes: reading.pageSize * reading.pageCount,
    bodyBytes: reading.blockBytes + reading.skeletonBytes + reading.rawHookBytes,
    bodyBudgetBytes: reading.blockBytes + reading.skeletonBytes + reading.rawHookBytes + reading.rawSessionBytes,
    meterVersion: reading.meterVersion ?? undefined,
    pairs: reading.pairs,
    over5m: reading.over5m,
    spans: reading.spans,
    spanEvidence: reading.spanEvidence,
    convs: reading.convs,
    maxRequests: reading.maxRequests,
    convsOver200: reading.convsOver200,
    checks: checks.map(check => ({ id: check.id, state: check.state })),
  };
}

/** 周环比：增量、占上期百分比、日均，以及是否越过日增/周增阈值。 */
export function compareSnapshots(current: Snapshot, previous: Snapshot): Check[] {
  const days = Math.max((current.takenAt - previous.takenAt) / DAY_MS, 0.5 / 24);
  const delta = current.fileBytes - previous.fileBytes;
  const ratio = previous.fileBytes > 0 ? delta / previous.fileBytes : 0;
  const perDay = delta / days;
  const sign = (value: string): string => (value.startsWith('-') ? value : `+${value}`);
  const convDelta = current.convsOver200 - previous.convsOver200;
  return [
    {
      id: 'growth_delta',
      state: perDay > PATROL_THRESHOLDS.growthDailyBytes || delta > PATROL_THRESHOLDS.growthWeeklyBytes
        ? 'over' : 'ok',
      detail: `文件 ${sign(mb(delta))} MiB（${sign(pct(ratio))}），跨 ${days.toFixed(1)} 天，日均 ${sign(mb(perDay))} MiB；阈值 ${mb(PATROL_THRESHOLDS.growthDailyBytes)} MiB/日、${mb(PATROL_THRESHOLDS.growthWeeklyBytes)} MiB/周`,
    },
    {
      id: 'conversation_delta',
      state: 'info',
      detail: `>${PATROL_THRESHOLDS.convWarnRequests} 会话 ${previous.convsOver200} → ${current.convsOver200}（${sign(String(convDelta))}），最大请求 ${previous.maxRequests} → ${current.maxRequests}`,
    },
    {
      id: 'meter_version',
      state: 'info',
      // 公式或来源集合改变后，正文与预算读数不能跨版本直接比较。
      detail: previous.meterVersion === current.meterVersion
        ? `计量 v${current.meterVersion ?? 'legacy'}`
        : `计量版本 ${previous.meterVersion ?? 'legacy'} → ${current.meterVersion ?? 'legacy'}，正文与预算读数不可直接比较`,
    },
  ];
}

export function render(checks: Check[]): string {
  const lines = checks.map(check => `[${check.state}] ${check.id}: ${check.detail}`);
  const over = checks.filter(check => check.state === 'over').length;
  lines.push(over === 0 ? '结果：无越界项' : `结果：${over} 项越界`);
  return `${lines.join('\n')}\n`;
}

type Options = { command: string; dataDir: string; port: number; stateDir: string; json: boolean; ifDue: boolean };

function parseArgs(argv: string[]): Options | null {
  const command = argv[0];
  if (command !== 'weekly' && command !== 'smoke') return null;
  let dataDir = defaultDataDir(process.env);
  let stateDir = patrolStateDir(process.env);
  let port = 8320;
  let json = false;
  let ifDue = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') json = true;
    else if (arg === '--if-due') ifDue = true;
    else if (arg === '--data-dir') {
      const value = argv[index + 1];
      if (value === undefined) return null;
      dataDir = value;
      index += 1;
    } else if (arg === '--state-dir') {
      const value = argv[index + 1];
      if (value === undefined) return null;
      stateDir = value;
      index += 1;
    } else if (arg === '--port') {
      const value = argv[index + 1];
      if (value === undefined || !/^\d+$/.test(value)) return null;
      port = Number(value);
      index += 1;
    } else return null;
  }
  if (ifDue && command !== 'weekly') return null;
  return { command, dataDir, stateDir, port, json, ifDue };
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (options === null) {
    process.stderr.write('usage: patrol weekly [--data-dir PATH] [--state-dir PATH] [--if-due] [--json] | patrol smoke [--port N] [--data-dir PATH] [--json]\n');
    return 2;
  }
  const dbPath = join(options.dataDir, 'trace.db');
  if (!existsSync(dbPath)) {
    process.stderr.write(`patrol_failed:db_missing:${dbPath}\n`);
    return 2;
  }
  let checks: Check[];
  try {
    if (options.command === 'weekly') {
      const now = Date.now();
      if (options.ifDue) {
        const due = dueState(loadHistory(options.stateDir), now);
        if (!due.due && due.ageDays !== null) {
          const detail = `未到期（${isoWeek(now)} 本期已采，距上期 ${due.ageDays.toFixed(1)} 天），跳过`;
          process.stdout.write(options.json ? `${JSON.stringify([{ id: 'due', state: 'info', detail }], null, 2)}\n` : `${detail}\n`);
          return 0;
        }
      }
      const reading = collectWeekly(dbPath, options.dataDir);
      const evaluated = evaluateWeekly(reading);
      const period = isoWeek(now);
      const history = loadHistory(options.stateDir);
      const current = toSnapshot(reading, evaluated, now);
      const previous = history.corrupt ? null : previousSnapshot(history, period);
      if (previous !== null) checks = [...evaluated, ...compareSnapshots(current, previous)];
      else checks = evaluated;
      const saved = saveSnapshot(options.stateDir, current);
      const kept = saved.periods.length;
      checks = [...checks, {
        id: 'history',
        state: 'info',
        detail: history.corrupt
          ? `历史不可读（${history.path}），本期按无上期可比处理并已记入，保留 ${kept} 期`
          : previous === null
            ? `无上期可比；本期 ${period} 已记入 ${saved.path}，保留 ${kept} 期`
            : `与上一期 ${previous.period} 比较；本期 ${period} 已记入 ${saved.path}，保留 ${kept} 期`,
      }];
    } else {
      checks = await runSmoke(options.dataDir, options.port);
    }
  } catch (error) {
    process.stderr.write(`patrol_failed:${error instanceof Error ? error.message : 'unknown'}\n`);
    return 2;
  }
  process.stdout.write(options.json ? `${JSON.stringify(checks, null, 2)}\n` : render(checks));
  return checks.some(check => check.state === 'over') ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
