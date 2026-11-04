/**
 * 巡检：把巡查里能计算的部分固化成只读命令。
 *
 * 数据库用只读连接打开，磁盘读数走 statfs；不写库、不写文件、不重启进程。
 * 阈值只在这里定义，docs/patrol.md 讲节奏与误报边界，不复制数字。
 *
 * 用法：
 *   bun scripts/patrol.ts weekly [--data-dir PATH] [--json]
 *   bun scripts/patrol.ts smoke [--port N] [--data-dir PATH] [--json]
 *
 * 退出码：0 全部通过或只有信息项；1 有越界项；2 用法错误或读不到库。
 */
import { Database } from 'bun:sqlite';
import { existsSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { defaultDataDir } from '../src/config';
import { readToken } from './service-support';

const MB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60_000;

/**
 * 阈值与判定口径。数字随容量策略一起改；改这里等于改巡检标准，docs/patrol.md
 * 的阈值表要同步，但权威读数仍以本文件为准。
 */
export const PATROL_THRESHOLDS = {
  /** 正文（block + skeleton + raw_hook）占库文件的比例下限。 */
  bodyRatioMin: 0.45,
  /** 库还小于这个体量时比例没有意义，不判。 */
  bodyRatioMinBytes: 256 * MB,
  // 周环比没有脚本可依赖的历史，按本周输出与上周记录比较。
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
    detail: `正文 ${mb(bodyBytes)} MiB / 文件 ${mb(fileBytes)} MiB = ${pct(bodyRatio)}，下限 ${pct(PATROL_THRESHOLDS.bodyRatioMin)}`,
  });
  checks.push({
    id: 'growth',
    state: 'info',
    detail: `文件 ${mb(fileBytes)} MiB；与上周记录比日增（阈值 ${mb(PATROL_THRESHOLDS.growthDailyBytes)} MiB/日）与周增（阈值 ${mb(PATROL_THRESHOLDS.growthWeeklyBytes)} MiB/周）`,
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
    const blockBytes = db.query<{ n: number }, []>('SELECT IFNULL(SUM(length(z)),0) AS n FROM block').get()?.n ?? 0;
    const skeletonBytes = db.query<{ n: number }, []>(
      'SELECT IFNULL(SUM(length(skeleton_z)),0) AS n FROM request').get()?.n ?? 0;
    const rawHookBytes = db.query<{ n: number }, []>(
      'SELECT IFNULL(SUM(length(request_z)+length(response_z)),0) AS n FROM raw_hook').get()?.n ?? 0;
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

export function render(checks: Check[]): string {
  const lines = checks.map(check => `[${check.state}] ${check.id}: ${check.detail}`);
  const over = checks.filter(check => check.state === 'over').length;
  lines.push(over === 0 ? '结果：无越界项' : `结果：${over} 项越界`);
  return `${lines.join('\n')}\n`;
}

type Options = { command: string; dataDir: string; port: number; json: boolean };

function parseArgs(argv: string[]): Options | null {
  const command = argv[0];
  if (command !== 'weekly' && command !== 'smoke') return null;
  let dataDir = defaultDataDir(process.env);
  let port = 8320;
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') json = true;
    else if (arg === '--data-dir') {
      const value = argv[index + 1];
      if (value === undefined) return null;
      dataDir = value;
      index += 1;
    } else if (arg === '--port') {
      const value = argv[index + 1];
      if (value === undefined || !/^\d+$/.test(value)) return null;
      port = Number(value);
      index += 1;
    } else return null;
  }
  return { command, dataDir, port, json };
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (options === null) {
    process.stderr.write('usage: patrol weekly|smoke [--data-dir PATH] [--port N] [--json]\n');
    return 2;
  }
  const dbPath = join(options.dataDir, 'trace.db');
  if (!existsSync(dbPath)) {
    process.stderr.write(`patrol_failed:db_missing:${dbPath}\n`);
    return 2;
  }
  let checks: Check[];
  try {
    checks = options.command === 'weekly'
      ? evaluateWeekly(collectWeekly(dbPath, options.dataDir))
      : await runSmoke(options.dataDir, options.port);
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
