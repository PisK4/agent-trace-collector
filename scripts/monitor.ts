/**
 * 后台监控：300 秒一次的轻量采样、规则检查、按日报告，外加诊断日志的归档与保留。
 *
 * 采样只取 `/api/metrics` 的轻量字段与 `/api/stats` 的计数；超时或读不到也照实写一条，
 * 不把缺数据补成正常值。告警与采样都落在数据目录的 `monitor/` 下，按日 JSONL 保留 14 天。
 *
 * 用法：
 *   bun scripts/monitor.ts sample [--port N]
 *   bun scripts/monitor.ts check
 *   bun scripts/monitor.ts report [--days 1|7]
 */
import {
  appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync,
  renameSync, rmSync, statSync, truncateSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from '../src/config';
import {
  findServiceEntry, listeningPort, probeJson, probeStats, readServiceState, readToken,
} from './service-support';
import type { ServiceEntry } from './service-support';

const repository = dirname(import.meta.dir);

export const SAMPLE_INTERVAL_MS = 300_000;
/** 两倍采样间隔再加一分钟仍没有新样本，就当作中断，不把缺数据当恢复。 */
export const MISSING_SAMPLE_MS = SAMPLE_INTERVAL_MS * 2 + 60_000;
export const KEEP_DAYS = 14;
/** launchd 的两个日志各 64 MiB 上限；归档总量 512 MiB，先删最老。 */
export const LOG_MAX_BYTES = 64 * 1024 * 1024;
export const LOG_TOTAL_BYTES = 512 * 1024 * 1024;
export const REMIND_MS = 30 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;
const DAY_MS = 24 * 60 * 60_000;

export type Thresholds = {
  p99Ms: number;
  p99SpanMs: number;
  backlogMs: number;
  modeSpanMs: number;
  gapSpanMs: number;
  rssSpanMs: number;
  bodyRatio: number;
  freeBytes: number;
  rssBytes: number;
  /** 相邻样本超过这个间隔就算中断，连续时长判定要重新起算。 */
  maxGapMs: number;
};

export const THRESHOLDS: Thresholds = {
  p99Ms: 100,
  p99SpanMs: 10 * 60_000,
  backlogMs: 10 * 60_000,
  modeSpanMs: 10 * 60_000,
  gapSpanMs: 15 * 60_000,
  rssSpanMs: 15 * 60_000,
  bodyRatio: 0.9,
  freeBytes: 100 * 10 ** 9,
  rssBytes: 4 * 10 ** 9,
  maxGapMs: SAMPLE_INTERVAL_MS * 1.5,
};

/** 检查窗口要覆盖最长连续判定（15 分钟）再加一次中断容差。 */
const RULE_WINDOW_MS = Math.max(THRESHOLDS.gapSpanMs, THRESHOLDS.rssSpanMs) + MISSING_SAMPLE_MS;

export type StorageView = {
  body_bytes: number; db_bytes: number; wal_bytes: number; total_bytes: number; free_bytes: number;
};

export type MetricsView = {
  started_at_ms: number | null;
  uptime_ms: number | null;
  rss_bytes: number | null;
  ingest_accepted: number;
  ingest_duplicates: number;
  ingest_rejected: number;
  jobs: { name: string; count: number; total_ms: number; max_ms: number }[];
  storage: StorageView | null;
  storage_measured_at_ms: number | null;
  storage_measure: { count: number; total_ms: number; max_ms: number };
  event_loop: {
    count: number; p50_ms: number | null; p95_ms: number | null;
    p99_ms: number | null; max_ms: number | null; interval_ms: number | null;
  };
  derive_queue: { pending_groups: number; oldest_dirty_age_ms: number | null };
  admission: { mode: string; reason: string | null; at_ms: number | null } | null;
};

export type StatsView = {
  open_gaps: number;
  pending_hooks: number;
  requests: number;
  cursors: number;
  issues: number;
};

export type SampleState = 'ok' | 'timeout' | 'unreachable' | 'http_error' | 'no_token' | 'not_managed';

export type Sample = {
  ts_ms: number;
  instance: string | null;
  ok: boolean;
  state: SampleState;
  /** 采样耗时；超时与状态码都只记固定分类，不记自由文本。 */
  elapsed_ms: number;
  jobs_running: boolean | null;
  metrics: MetricsView | null;
  stats: StatsView | null;
};

export type Rule = 'service_unreadable' | 'event_loop_p99' | 'derive_backlog'
  | 'storage_mode' | 'collection_gap' | 'capacity';

export type RuleHit = { rule: Rule; detail: string };

export type AlertState = {
  active: Record<string, { since_ms: number; last_notified_ms: number }>;
};

export type AlertEvent = {
  ts_ms: number;
  rule: Rule;
  event: 'alert' | 'reminder' | 'recovered';
  since_ms?: number;
  detail?: string;
};

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const recordOf = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;

export function extractMetrics(body: unknown): MetricsView | null {
  const root = recordOf(body);
  if (root === null) return null;
  const ingest = recordOf(root.ingest);
  const jobsRecord = recordOf(root.jobs) ?? {};
  const storageRecord = recordOf(root.storage);
  const measure = recordOf(root.storage_measure);
  const loop = recordOf(root.event_loop);
  const queue = recordOf(root.derive_queue);
  const admission = recordOf(root.admission);
  return {
    started_at_ms: numberOrNull(root.started_at_ms),
    uptime_ms: numberOrNull(root.uptime_ms),
    rss_bytes: numberOrNull(root.rss_bytes),
    ingest_accepted: numberOrNull(ingest?.accepted) ?? 0,
    ingest_duplicates: numberOrNull(ingest?.duplicates) ?? 0,
    ingest_rejected: numberOrNull(ingest?.rejected_total) ?? 0,
    jobs: Object.entries(jobsRecord).map(([name, value]) => {
      const job = recordOf(value);
      return {
        name, count: numberOrNull(job?.count) ?? 0,
        total_ms: numberOrNull(job?.total_ms) ?? 0, max_ms: numberOrNull(job?.max_ms) ?? 0,
      };
    }),
    storage: storageRecord === null ? null : {
      body_bytes: numberOrNull(storageRecord.body_bytes) ?? 0,
      db_bytes: numberOrNull(storageRecord.db_bytes) ?? 0,
      wal_bytes: numberOrNull(storageRecord.wal_bytes) ?? 0,
      total_bytes: numberOrNull(storageRecord.total_bytes) ?? 0,
      free_bytes: numberOrNull(storageRecord.free_bytes) ?? 0,
    },
    storage_measured_at_ms: numberOrNull(root.storage_measured_at_ms),
    storage_measure: {
      count: numberOrNull(measure?.count) ?? 0,
      total_ms: numberOrNull(measure?.total_ms) ?? 0,
      max_ms: numberOrNull(measure?.max_ms) ?? 0,
    },
    event_loop: {
      count: numberOrNull(loop?.count) ?? 0,
      p50_ms: numberOrNull(loop?.p50_ms), p95_ms: numberOrNull(loop?.p95_ms),
      p99_ms: numberOrNull(loop?.p99_ms), max_ms: numberOrNull(loop?.max_ms),
      interval_ms: numberOrNull(loop?.interval_ms),
    },
    derive_queue: {
      pending_groups: numberOrNull(queue?.pending_groups) ?? 0,
      oldest_dirty_age_ms: numberOrNull(queue?.oldest_dirty_age_ms),
    },
    admission: admission === null ? null : {
      mode: typeof admission.mode === 'string' ? admission.mode : 'unknown',
      reason: typeof admission.reason === 'string' ? admission.reason : null,
      at_ms: numberOrNull(admission.at_ms),
    },
  };
}

export function extractStats(body: unknown): StatsView | null {
  const root = recordOf(body);
  if (root === null) return null;
  const count = (value: unknown): number => Array.isArray(value) ? value.length : 0;
  return {
    open_gaps: numberOrNull(root.open_gaps) ?? 0,
    pending_hooks: numberOrNull(root.pending_hooks) ?? 0,
    requests: numberOrNull(root.requests) ?? 0,
    cursors: count(root.cursors),
    issues: count(root.issues),
  };
}

/** 本地日界，报告按人看到的那一天分组。 */
export function localDay(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function monitorDir(dataDir: string): string { return join(dataDir, 'monitor'); }
export function samplesDir(dataDir: string): string { return join(monitorDir(dataDir), 'samples'); }
export function alertsDir(dataDir: string): string { return join(monitorDir(dataDir), 'alerts'); }
export function archivesDir(dataDir: string): string { return join(monitorDir(dataDir), 'logs'); }
export function alertStatePath(dataDir: string): string {
  return join(monitorDir(dataDir), 'alert-state.json');
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function ensureFile(path: string): void {
  if (!existsSync(path)) appendFileSync(path, '', { mode: 0o600 });
  chmodSync(path, 0o600);
}

function appendJsonl(dir: string, day: string, value: unknown): void {
  ensureDirectory(dir);
  const path = join(dir, `${day}.jsonl`);
  const existed = existsSync(path);
  appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  if (!existed) chmodSync(path, 0o600);
}

export function appendSample(dataDir: string, sample: Sample): void {
  appendJsonl(samplesDir(dataDir), localDay(sample.ts_ms), sample);
}

export function appendAlertEvents(dataDir: string, events: AlertEvent[]): void {
  for (const event of events) appendJsonl(alertsDir(dataDir), localDay(event.ts_ms), event);
}

export function loadSamples(dataDir: string, nowMs: number, windowMs: number): Sample[] {
  const samples: Sample[] = [];
  const oldest = nowMs - windowMs;
  // 按本地日逐天读，报告跨多天也能取到。
  for (let cursor = nowMs; cursor >= oldest; cursor -= DAY_MS) {
    const path = join(samplesDir(dataDir), `${localDay(cursor)}.jsonl`);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as Sample;
        if (typeof parsed.ts_ms === 'number' && parsed.ts_ms >= oldest) samples.push(parsed);
      } catch {
        // 半行写入或人工改动：跳过这一行，不让报告整体失败。
      }
    }
  }
  return samples.sort((left, right) => left.ts_ms - right.ts_ms);
}

export function loadAlertState(dataDir: string): AlertState {
  const path = alertStatePath(dataDir);
  if (!existsSync(path)) return { active: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as AlertState;
    return parsed !== null && typeof parsed === 'object' && typeof parsed.active === 'object'
      ? { active: parsed.active } : { active: {} };
  } catch {
    return { active: {} };
  }
}

export function saveAlertState(dataDir: string, state: AlertState, nowMs: number): void {
  ensureDirectory(monitorDir(dataDir));
  const path = alertStatePath(dataDir);
  ensureFile(path);
  // 状态只存规则与时间；写成临时文件再换名，崩溃时不会留下半个 JSON。
  const temp = `${path}.${nowMs}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

export type RuleContext = {
  now: number;
  jobRunning: boolean | null;
  thresholds: Thresholds;
  bodyBudget: number;
  /** 最新样本缺失或失败时为 true：保留已告警状态，不判恢复。 */
  stale: boolean;
};

function trailingRun(samples: Sample[], predicate: (sample: Sample) => boolean,
  maxGapMs: number): Sample[] {
  const run: Sample[] = [];
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index]!;
    if (!predicate(sample)) break;
    if (run.length > 0 && sample.ts_ms < run[run.length - 1]!.ts_ms - maxGapMs) break;
    run.push(sample);
  }
  return run.reverse();
}

const metricSample = (sample: Sample): MetricsView | null =>
  sample.ok ? sample.metrics : null;

export function evaluateRules(samples: Sample[], ctx: RuleContext): RuleHit[] {
  const latest = samples.length === 0 ? undefined : samples[samples.length - 1];
  const hits: RuleHit[] = [];
  if (ctx.jobRunning !== true || latest === undefined || !latest.ok) {
    hits.push({ rule: 'service_unreadable', detail:
      `job:${ctx.jobRunning === true ? 'running' : 'down'} sample:${latest?.state ?? 'missing'}` });
  }
  if (ctx.stale) return hits;
  if (latest === undefined) return hits;

  const loopRun = trailingRun(samples, sample => (metricSample(sample)?.event_loop.p99_ms ?? 0)
    > ctx.thresholds.p99Ms, ctx.thresholds.maxGapMs);
  if (loopRun.length > 0 && ctx.now - loopRun[0]!.ts_ms >= ctx.thresholds.p99SpanMs) {
    hits.push({ rule: 'event_loop_p99', detail:
      `p99:${Math.round(metricSample(loopRun[loopRun.length - 1]!)!.event_loop.p99_ms!)}` });
  }

  const pendingNow = metricSample(latest)?.derive_queue.pending_groups ?? 0;
  const backlogRun = trailingRun(samples, sample => {
    const metrics = metricSample(sample);
    return metrics !== null && metrics.derive_queue.pending_groups >= pendingNow
      && metrics.derive_queue.pending_groups > 0
      && (metrics.derive_queue.oldest_dirty_age_ms ?? 0) > ctx.thresholds.backlogMs;
  }, ctx.thresholds.maxGapMs);
  if (backlogRun.length > 0 && ctx.now - backlogRun[0]!.ts_ms >= ctx.thresholds.backlogMs) {
    const age = metricSample(latest)!.derive_queue.oldest_dirty_age_ms ?? 0;
    hits.push({ rule: 'derive_backlog', detail: `groups:${pendingNow} age:${Math.round(age)}` });
  }

  // 用样本的观测时间判定持续，不用最后一次量测时间：持续写入时闸门每 2 秒
  // 刷新量测时间，按它算会永远凑不满窗口。
  const modeRun = trailingRun(samples, sample => {
    const admission = metricSample(sample)?.admission;
    return admission !== null && admission !== undefined && admission.mode !== 'normal';
  }, ctx.thresholds.maxGapMs);
  if (modeRun.length > 0 && ctx.now - modeRun[0]!.ts_ms >= ctx.thresholds.modeSpanMs) {
    const mode = metricSample(modeRun[modeRun.length - 1]!)!.admission!.mode;
    hits.push({ rule: 'storage_mode', detail: `mode:${mode}` });
  }

  const gapsNow = latest.ok ? latest.stats?.open_gaps ?? 0 : 0;
  const gapRun = trailingRun(samples, sample => sample.ok
    && (sample.stats?.open_gaps ?? 0) >= gapsNow && (sample.stats?.open_gaps ?? 0) > 0,
  ctx.thresholds.maxGapMs);
  if (gapRun.length > 0 && ctx.now - gapRun[0]!.ts_ms >= ctx.thresholds.gapSpanMs) {
    hits.push({ rule: 'collection_gap', detail: `open:${gapsNow}` });
  }

  const storage = metricSample(latest)?.storage ?? null;
  if (storage !== null) {
    const bodyRatio = ctx.bodyBudget > 0 ? storage.body_bytes / ctx.bodyBudget : 0;
    if (bodyRatio >= ctx.thresholds.bodyRatio) {
      hits.push({ rule: 'capacity', detail: `body_ratio:${bodyRatio.toFixed(2)}` });
    } else if (storage.free_bytes < ctx.thresholds.freeBytes) {
      hits.push({ rule: 'capacity', detail: `free_bytes:${storage.free_bytes}` });
    }
  }
  const rssRun = trailingRun(samples, sample => (metricSample(sample)?.rss_bytes ?? 0)
    > ctx.thresholds.rssBytes, ctx.thresholds.maxGapMs);
  if (rssRun.length > 0 && ctx.now - rssRun[0]!.ts_ms >= ctx.thresholds.rssSpanMs) {
    hits.push({ rule: 'capacity', detail: `rss_bytes:${metricSample(latest)?.rss_bytes ?? 0}` });
  }
  return hits;
}

export function transitionAlerts(state: AlertState, hits: RuleHit[], ctx: RuleContext,
  remindMs = REMIND_MS): { state: AlertState; events: AlertEvent[] } {
  const active = { ...state.active };
  const events: AlertEvent[] = [];
  const hitMap = new Map(hits.map(hit => [hit.rule, hit]));
  for (const [rule, hit] of hitMap) {
    const previous = active[rule];
    if (previous === undefined) {
      const since = ctx.now;
      active[rule] = { since_ms: since, last_notified_ms: ctx.now };
      events.push({ ts_ms: ctx.now, rule: hit.rule, event: 'alert', since_ms: since, detail: hit.detail });
    } else if (ctx.now - previous.last_notified_ms >= remindMs) {
      active[rule] = { ...previous, last_notified_ms: ctx.now };
      events.push({ ts_ms: ctx.now, rule: hit.rule, event: 'reminder',
        since_ms: previous.since_ms, detail: hit.detail });
    }
  }
  if (!ctx.stale) {
    for (const [rule, previous] of Object.entries(active)) {
      if (hitMap.has(rule as Rule)) continue;
      if (rule === 'service_unreadable' && (ctx.jobRunning === null || ctx.jobRunning === undefined)) continue;
      delete active[rule];
      events.push({ ts_ms: ctx.now, rule: rule as Rule, event: 'recovered', since_ms: previous.since_ms });
    }
  }
  return { state: { active }, events };
}

export type RotateResult = { archived: boolean; removed: number; earliest_ms: number | null };

/** 复制后清空在写文件：launchd 还握着原 fd，不能改名或删除。
 * shortcut: 复制到清空之间写入的行会丢；升级为 launchd 重开 fd 的路径后再改。 */
export function rotateLog(path: string, archiveDir: string, nowMs: number,
  maxBytes = LOG_MAX_BYTES): RotateResult {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return { archived: false, removed: 0, earliest_ms: earliestArchivedMs(archiveDir) };
  }
  let archived = false;
  if (size >= maxBytes) {
    ensureDirectory(archiveDir);
    const target = join(archiveDir, `${path.split('/').pop() ?? 'log'}.${nowMs}.log`);
    copyFileSync(path, target);
    chmodSync(target, 0o600);
    truncateSync(path, 0);
    archived = true;
  }
  return { archived, removed: 0, earliest_ms: earliestArchivedMs(archiveDir) };
}

/** 先删超过保留期的归档，再按总量上限从最老开始删。 */
export function pruneArchives(archiveDir: string, nowMs: number, keepDays = KEEP_DAYS,
  totalBytes = LOG_TOTAL_BYTES): number {
  if (!existsSync(archiveDir)) return 0;
  let entries = readdirSync(archiveDir).flatMap(name => {
    const path = join(archiveDir, name);
    try {
      const stat = statSync(path);
      return stat.isFile() ? [{ path, size: stat.size, mtime: stat.mtimeMs }] : [];
    } catch {
      return [];
    }
  }).sort((left, right) => left.mtime - right.mtime);
  let removed = 0;
  const keepFrom = nowMs - keepDays * DAY_MS;
  while (entries.length > 0 && entries[0]!.mtime < keepFrom) {
    rmSync(entries[0]!.path, { force: true });
    entries = entries.slice(1);
    removed += 1;
  }
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  while (entries.length > 0 && total > totalBytes) {
    const oldest = entries[0]!;
    rmSync(oldest.path, { force: true });
    total -= oldest.size;
    entries = entries.slice(1);
    removed += 1;
  }
  return removed;
}

export function earliestArchivedMs(archiveDir: string): number | null {
  if (!existsSync(archiveDir)) return null;
  let earliest: number | null = null;
  for (const name of readdirSync(archiveDir)) {
    try {
      const mtime = statSync(join(archiveDir, name)).mtimeMs;
      if (earliest === null || mtime < earliest) earliest = mtime;
    } catch {
      // 并发删除时跳过。
    }
  }
  return earliest;
}

/** 采样与告警只留 14 天；诊断日志归档与 live 日志由 rotateLog/pruneArchives 处理。 */
export function pruneMonitorData(dataDir: string, nowMs: number, keepDays = KEEP_DAYS): number {
  const keepFrom = localDay(nowMs - keepDays * DAY_MS);
  let removed = 0;
  for (const dir of [samplesDir(dataDir), alertsDir(dataDir)]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const day = name.slice(0, -'.jsonl'.length);
      if (day < keepFrom) {
        rmSync(join(dir, name), { force: true });
        removed += 1;
      }
    }
  }
  return removed;
}

function serviceContext(): { entry: ServiceEntry | null; dataDir: string; token: string | null;
  port: number | null; jobRunning: boolean | null } {
  const entry = findServiceEntry(repository);
  const dataDir = loadConfig(entry?.env).dataDir;
  const token = readToken(dataDir);
  const state = entry === null ? null : readServiceState(entry.label);
  const pid = state?.pid ?? null;
  return {
    entry,
    dataDir,
    token,
    port: pid === null ? null : listeningPort(pid),
    jobRunning: state === null ? null : state.state === 'running' && pid !== null,
  };
}

export async function collectSample(input: {
  now: number;
  port: number | null;
  token: string | null;
  jobRunning: boolean | null;
}): Promise<Sample> {
  const base = {
    ts_ms: input.now, instance: null, ok: false, elapsed_ms: 0,
    jobs_running: input.jobRunning, metrics: null, stats: null,
  } satisfies Omit<Sample, 'state'>;
  if (input.token === null) return { ...base, state: 'no_token' };
  if (input.port === null) return { ...base, state: 'unreachable' };
  const started = performance.now();
  const [metrics, stats] = await Promise.all([
    probeJson<unknown>('/api/metrics', input.port, input.token, PROBE_TIMEOUT_MS),
    probeStats(input.port, input.token, PROBE_TIMEOUT_MS),
  ]);
  const elapsed = Math.round(performance.now() - started);
  if (metrics.state !== 'ok' || stats.state !== 'ok') {
    const failed = metrics.state !== 'ok' ? metrics : stats;
    return {
      ...base,
      ts_ms: Date.now(),
      state: failed.state === 'ok' ? 'http_error' : failed.state,
      elapsed_ms: elapsed,
    };
  }
  const metricsView = extractMetrics(metrics.body);
  const instance = recordOf(metrics.body)?.instance;
  return {
    ...base,
    ts_ms: Date.now(),
    instance: typeof instance === 'string' ? instance : null,
    ok: true,
    state: 'ok',
    elapsed_ms: elapsed,
    metrics: metricsView,
    stats: extractStats(stats.stats),
  };
}

export function buildReport(samples: Sample[], nowMs: number, thresholds = THRESHOLDS,
  earliestArchived: number | null = null): string[] {
  if (samples.length === 0) return ['没有可用样本：检查监控任务是否在运行。'];
  const lines: string[] = [];
  const failed = samples.filter(sample => !sample.ok);
  const restarts = samples.filter((sample, index) => index > 0
    && sample.instance !== samples[index - 1]!.instance);
  const missing: number[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    const gap = samples[index]!.ts_ms - samples[index - 1]!.ts_ms;
    if (gap > thresholds.maxGapMs) missing.push(gap);
  }
  const loops = samples.flatMap(sample => sample.ok && sample.metrics !== null
    ? [sample.metrics.event_loop] : []);
  const p99 = loops.map(loop => loop.p99_ms).filter((value): value is number => value !== null);
  const queues = samples.flatMap(sample => sample.ok && sample.metrics !== null
    ? [sample.metrics.derive_queue] : []);
  const maxPending = queues.reduce((max, queue) => Math.max(max, queue.pending_groups), 0);
  const maxAge = queues.reduce((max, queue) => Math.max(max, queue.oldest_dirty_age_ms ?? 0), 0);
  // 存储与准入是「现在怎样」，取窗口内最新一条有值的样本，不拿最早的旧值充数。
  const latestWith = <T>(pick: (sample: Sample) => T | null): T | null => {
    for (let index = samples.length - 1; index >= 0; index -= 1) {
      const value = pick(samples[index]!);
      if (value !== null) return value;
    }
    return null;
  };
  const storage = latestWith(sample => sample.ok ? sample.metrics?.storage ?? null : null);
  const admission = latestWith(sample => sample.ok ? sample.metrics?.admission ?? null : null);

  lines.push(`样本 ${samples.length} 条，覆盖 ${localDay(samples[0]!.ts_ms)} 至 ${localDay(nowMs)}。`);
  lines.push(`采集失败 ${failed.length} 条${failed.length > 0 ? `，最近状态 ${failed[failed.length - 1]!.state}` : ''}。`);
  lines.push(missing.length === 0 ? '采样连续，没有超过阈值的中断。'
    : `采集中断 ${missing.length} 处，最长 ${Math.round(Math.max(...missing) / 1000)} 秒。`);
  lines.push(p99.length === 0 ? '事件循环没有样本。'
    : `事件循环 p99 最高 ${Math.round(Math.max(...p99))} 毫秒，样本 ${loops.length} 个。`
      + (p99.some(value => value > thresholds.p99Ms) ? ' 有超过阈值的窗口。' : ''));
  lines.push(`派生队列峰值 ${maxPending} 组，最老排队 ${Math.round(maxAge / 1000)} 秒。`);
  lines.push(restarts.length === 0 ? '进程实例未变化。'
    : `进程实例变化 ${restarts.length} 次；实例变化后不跨进程做计数差。`);
  lines.push(storage === null ? '存储值未知（闸门尚未量测）。'
    : `正文 ${storage.body_bytes} 字节，总量 ${storage.total_bytes} 字节，可用 ${storage.free_bytes} 字节。`);
  lines.push(admission === null ? '准入模式 normal（无切换记录）。'
    : `准入模式 ${admission.mode}${admission.reason === null ? '' : `，原因 ${admission.reason}`}。`);
  lines.push(earliestArchived === null
    ? '没有更早的日志归档；报告只覆盖保留期内的按日文件。'
    : `日志归档最早可追到 ${new Date(earliestArchived).toISOString()}；更早的数据已清理。`);
  return lines;
}

function notify(event: AlertEvent): void {
  if (event.event === 'recovered') return;
  const detail = event.detail ?? event.rule;
  try {
    Bun.spawnSync(['osascript', '-e',
      `display notification "${detail}" with title "ATC 监控" subtitle "${event.rule}"`]);
  } catch {
    // 通知失败不影响采样与事件落盘。
  }
}

async function runSample(argv: string[]): Promise<number> {
  const context = serviceContext();
  const explicit = argv.indexOf('--port');
  const port = explicit >= 0 ? Number(argv[explicit + 1]) : context.port;
  const sample = await collectSample({
    now: Date.now(), port: Number.isFinite(port) ? port : null,
    token: context.token, jobRunning: context.jobRunning,
  });
  const dataDir = context.dataDir;
  appendSample(dataDir, sample);
  pruneMonitorData(dataDir, sample.ts_ms);
  const logs = [join(monitorDir(dataDir), 'monitor.log')];
  if (context.entry !== null) {
    if (context.entry.stdoutPath !== null) logs.push(context.entry.stdoutPath);
    if (context.entry.stderrPath !== null) logs.push(context.entry.stderrPath);
  }
  for (const path of logs) rotateLog(path, archivesDir(dataDir), sample.ts_ms);
  pruneArchives(archivesDir(dataDir), sample.ts_ms);
  process.stdout.write(`sample:${sample.state}:${sample.elapsed_ms}ms\n`);
  return sample.ok ? 0 : 1;
}

async function runCheck(): Promise<number> {
  const context = serviceContext();
  const now = Date.now();
  const samples = loadSamples(context.dataDir, now, RULE_WINDOW_MS);
  const latest = samples[samples.length - 1];
  const ctx: RuleContext = {
    now,
    jobRunning: context.jobRunning,
    thresholds: THRESHOLDS,
    bodyBudget: loadConfig(context.entry?.env).bodyBudget,
    stale: latest === undefined || !latest.ok || now - latest.ts_ms > MISSING_SAMPLE_MS,
  };
  const hits = evaluateRules(samples, ctx);
  const result = transitionAlerts(loadAlertState(context.dataDir), hits, ctx);
  saveAlertState(context.dataDir, result.state, now);
  appendAlertEvents(context.dataDir, result.events);
  for (const event of result.events) {
    notify(event);
    process.stdout.write(`${event.event}:${event.rule}${event.detail === undefined ? '' : `:${event.detail}`}\n`);
  }
  return 0;
}

function runReport(argv: string[]): number {
  const context = serviceContext();
  const explicit = argv.indexOf('--days');
  const days = explicit >= 0 ? Number(argv[explicit + 1]) : 1;
  const span = (Number.isFinite(days) && days > 0 ? days : 1) * DAY_MS;
  const now = Date.now();
  const samples = loadSamples(context.dataDir, now, span);
  for (const line of buildReport(samples, now, THRESHOLDS, earliestArchivedMs(archivesDir(context.dataDir)))) {
    process.stdout.write(`${line}\n`);
  }
  return 0;
}

export async function runMonitor(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === 'sample') return runSample(argv.slice(1));
  if (command === 'check') return runCheck();
  if (command === 'report') return runReport(argv.slice(1));
  process.stderr.write('usage: monitor sample|check|report [--days 1|7] [--port N]\n');
  return 2;
}

if (import.meta.main) process.exit(await runMonitor(process.argv.slice(2)));
