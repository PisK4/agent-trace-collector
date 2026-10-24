import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type { Config } from './config';
import type { Store } from './store';
import { measureStorage } from './retention';
import type { StorageUsage } from './retention';
import { queuePendingSql } from './derive-state';

/**
 * 进程内容量观测。只保留固定原因码、计数与有界时延样本，不保存被拒正文、
 * 请求头、来源字符串或任意错误文本；所有值都从当前进程重新计算。
 */

export const REJECT_REASONS = [
  'hook_unavailable', 'host', 'origin', 'unauthorized', 'method_not_allowed',
  'busy', 'envelope_too_large', 'invalid_json', 'missing_hook_id',
  'origin_not_local', 'insufficient_storage', 'writer_failed',
] as const;
export type RejectReason = typeof REJECT_REASONS[number];

export type DurationSummary = {
  count: number;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  max_ms: number | null;
};

function percentile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

/** 最近秩分位；空样本返回 null，不把 0 当缺失。 */
export function summarizeDurations(values: readonly number[]): DurationSummary {
  if (values.length === 0) {
    return { count: 0, p50_ms: null, p95_ms: null, p99_ms: null, max_ms: null };
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50_ms: percentile(sorted, 0.5),
    p95_ms: percentile(sorted, 0.95),
    p99_ms: percentile(sorted, 0.99),
    max_ms: sorted[sorted.length - 1]!,
  };
}

function emptyReasons(): Record<RejectReason, number> {
  return Object.fromEntries(REJECT_REASONS.map(reason => [reason, 0])) as Record<RejectReason, number>;
}

export type IngestMetrics = {
  reject(reason: RejectReason): void;
  accept(input: { duplicate: boolean; requestBytes: number; replyBytes: number }): void;
  snapshot(now?: number): {
    started_at_ms: number; now_ms: number; uptime_ms: number;
    accepted: number; duplicates: number;
    accepted_request_bytes: number; accepted_reply_bytes: number;
    rejected_total: number; rejected_by_reason: Record<RejectReason, number>;
  };
};

export function createIngestMetrics(startedAt = Date.now()): IngestMetrics {
  let accepted = 0;
  let duplicates = 0;
  let requestBytes = 0;
  let replyBytes = 0;
  const rejected = emptyReasons();
  return {
    reject(reason) {
      if (!REJECT_REASONS.includes(reason)) throw new Error('invalid_reject_reason');
      rejected[reason] += 1;
    },
    accept(input) {
      accepted += 1;
      if (input.duplicate) duplicates += 1;
      requestBytes += input.requestBytes;
      replyBytes += input.replyBytes;
    },
    snapshot(now = Date.now()) {
      const byReason = { ...rejected };
      return {
        started_at_ms: startedAt,
        now_ms: now,
        uptime_ms: now - startedAt,
        accepted,
        duplicates,
        accepted_request_bytes: requestBytes,
        accepted_reply_bytes: replyBytes,
        rejected_total: REJECT_REASONS.reduce((sum, reason) => sum + byReason[reason], 0),
        rejected_by_reason: byReason,
      };
    },
  };
}

export type CapacityMetrics = {
  startedAt: number;
  ingest: IngestMetrics;
  route: {
    record(input: { files: number; decoded: number; unchanged: number; errors: number }): void;
    snapshot(): { polls: number; files_seen: number; decoded: number; unchanged: number; errors: number };
  };
  jobs: {
    record(name: string, ms: number): void;
    snapshot(): Record<string, { count: number; total_ms: number; max_ms: number }>;
  };
  eventLoop: {
    start(): void;
    stop(): void;
    snapshot(): DurationSummary & { interval_ms: number };
  };
  snapshot(store: Store, dataDir: string): Record<string, unknown>;
};

function tableColumns(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name);
}

/**
 * 未发布组的积压。组数只数队列行；JOIN request 后的 COUNT 会变成请求数。
 * `oldest_dirty_age_ms` 是排队年龄，`oldest_request_age_ms` 只是最老请求年龄。
 */
export function queueSnapshot(store: Store): {
  pending_groups: number;
  oldest_dirty_since_ms: number | null; oldest_dirty_age_ms: number | null;
  oldest_request_started_ms: number | null; oldest_request_age_ms: number | null;
} {
  const columns = tableColumns(store.read, 'derive_queue');
  const hasState = columns.includes('state');
  const hasDirtySince = columns.includes('dirty_since_ms');
  // 待办判定用唯一片段；v6 构建中的组仍为 dirty，不新增状态。
  const filter = hasState ? `WHERE ${queuePendingSql()}` : '';
  const pending = store.read.query<{ n: number }, []>(
    `SELECT COUNT(*) AS n FROM derive_queue ${filter}`).get()?.n ?? 0;
  const dirty = hasDirtySince
    ? store.read.query<{ oldest: number | null }, []>(
      `SELECT MIN(dirty_since_ms) AS oldest FROM derive_queue ${filter}`).get()?.oldest ?? null
    : null;
  const request = store.read.query<{ oldest: number | null }, []>(`
    SELECT MIN(r.started_ms) AS oldest
    FROM derive_queue q JOIN request r ON r.conv_key=q.conv_key AND r.actor=q.actor
    ${hasState ? `WHERE ${queuePendingSql('q')}` : ''}`).get()?.oldest ?? null;
  const now = Date.now();
  return {
    pending_groups: pending,
    oldest_dirty_since_ms: dirty,
    oldest_dirty_age_ms: dirty === null ? null : now - dirty,
    oldest_request_started_ms: request,
    oldest_request_age_ms: request === null ? null : now - request,
  };
}

function hasTable(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== null;
}
function numeric(db: Database, sql: string, params: unknown[] = []): number {
  const row = db.query(sql).get(...(params as SQLQueryBindings[])) as Record<string, unknown> | null;
  return row === null ? 0 : Number(Object.values(row)[0] ?? 0);
}
function byteSum(db: Database, table: string, columns: readonly string[],
  where = ''): number {
  const available = tableColumns(db, table);
  const picked = columns.filter(name => available.includes(name));
  if (picked.length === 0) return 0;
  const expression = picked
    .map(name => `COALESCE(length(CAST(${name} AS BLOB)),0)`).join('+');
  return numeric(db, `SELECT COALESCE(SUM(${expression}),0) FROM ${table} ${where}`);
}

/**
 * 元数据增长只按逻辑载荷计：clean 组队列行、来源与投影 JSON、已发布代结果字段。
 * clean 行由 C 保留，不能只数 dirty 组；来源 JSON 单独计长，不解析、不截断。
 */
export function metadataSnapshot(store: Store): {
  clean_groups: number;
  source_facts_json_bytes: number;
  projection_meta_json_bytes: number;
  queue_clean_bytes: number;
  result_metadata_bytes: number;
  total_bytes: number;
  per_clean_group_bytes: number | null;
  per_request_bytes: number | null;
} {
  const queueColumns = tableColumns(store.read, 'derive_queue');
  const hasState = queueColumns.includes('state');
  const cleanGroups = hasState
    ? numeric(store.read, "SELECT COUNT(*) FROM derive_queue WHERE state='clean'")
    : numeric(store.read, 'SELECT COUNT(*) FROM derive_queue');
  const queueCleanBytes = byteSum(store.read, 'derive_queue',
    ['conv_key', 'actor', 'from_sort', 'group_epoch', 'input_revision', 'published_revision',
      'published_algorithm'], hasState ? "WHERE state='clean'" : '');
  const sourceFactsBytes = byteSum(store.read, 'request', ['source_facts_json']);
  const projectionMetaBytes = byteSum(store.read, 'request', ['projection_meta_json']);
  const resultColumns = tableColumns(store.read, 'derive_request_result');
  const resultMetadataBytes = resultColumns.length === 0 || !hasTable(store.read, 'derive_generation')
    ? 0
    : byteSum(store.read, 'derive_request_result',
      ['title', 'title_source', 'input_preview', 'input_preview_kind', 'reply_preview',
        'basis_json', 'delta_ordinals', 'purpose_chain'],
      'JOIN derive_queue q ON q.published_generation=derive_request_result.generation');
  const requestCount = numeric(store.read, 'SELECT COUNT(*) FROM request');
  const total = queueCleanBytes + sourceFactsBytes + projectionMetaBytes + resultMetadataBytes;
  return {
    clean_groups: cleanGroups,
    source_facts_json_bytes: sourceFactsBytes,
    projection_meta_json_bytes: projectionMetaBytes,
    queue_clean_bytes: queueCleanBytes,
    result_metadata_bytes: resultMetadataBytes,
    total_bytes: total,
    per_clean_group_bytes: cleanGroups === 0 ? null : total / cleanGroups,
    per_request_bytes: requestCount === 0 ? null : total / requestCount,
  };
}

function eventLoopValues(ring: Float64Array, ringIndex: number, ringCount: number, limit: number): number[] {
  const values: number[] = [];
  for (let index = 0; index < ringCount; index++) {
    values.push(ring[(ringIndex - ringCount + index + limit) % limit]!);
  }
  return values;
}

export function createCapacityMetrics(store: Store, dataDir: string, startedAt = Date.now()): CapacityMetrics {
  const ingest = createIngestMetrics(startedAt);
  const route = { polls: 0, files_seen: 0, decoded: 0, unchanged: 0, errors: 0 };
  const jobs = new Map<string, { count: number; total_ms: number; max_ms: number }>();
  const intervalMs = 50;
  const limit = 8192;
  const ring = new Float64Array(limit);
  let ringIndex = 0;
  let ringCount = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let expected = 0;
  const eventLoop = () => ({
    interval_ms: intervalMs,
    ...summarizeDurations(eventLoopValues(ring, ringIndex, ringCount, limit)),
  });

  return {
    startedAt,
    ingest,
    route: {
      record(input) {
        route.polls += 1;
        route.files_seen += input.files;
        route.decoded += input.decoded;
        route.unchanged += input.unchanged;
        route.errors += input.errors;
      },
      snapshot() { return { ...route }; },
    },
    jobs: {
      record(name, ms) {
        const current = jobs.get(name) ?? { count: 0, total_ms: 0, max_ms: 0 };
        current.count += 1;
        current.total_ms += ms;
        current.max_ms = Math.max(current.max_ms, ms);
        jobs.set(name, current);
      },
      snapshot() { return Object.fromEntries(jobs); },
    },
    eventLoop: {
      start() {
        if (timer !== null) return;
        expected = performance.now() + intervalMs;
        timer = setInterval(() => {
          const now = performance.now();
          const lag = Math.max(0, now - expected);
          expected = now + intervalMs;
          ring[ringIndex] = lag;
          ringIndex = (ringIndex + 1) % limit;
          ringCount = Math.min(limit, ringCount + 1);
        }, intervalMs);
        if (typeof (timer as { unref?: () => void }).unref === 'function') {
          (timer as { unref(): void }).unref();
        }
      },
      stop() {
        if (timer !== null) clearInterval(timer);
        timer = null;
      },
      snapshot() { return eventLoop(); },
    },
    snapshot(target, targetDir) {
      const storage: StorageUsage = measureStorage(target, targetDir);
      const now = Date.now();
      return {
        started_at_ms: startedAt,
        now_ms: now,
        uptime_ms: now - startedAt,
        ingest: ingest.snapshot(),
        route: { ...route },
        jobs: Object.fromEntries(jobs),
        writer: { ...target.writeStats,
          by_name: Object.fromEntries(Object.entries(target.writeStats.by_name)
            .map(([name, stats]) => [name, { ...stats }])),
        } satisfies Store['writeStats'],
        event_loop: eventLoop(),
        rss_bytes: process.memoryUsage().rss,
        storage,
        metadata: metadataSnapshot(target),
        derive_queue: queueSnapshot(target),
      };
    },
  };
}

/**
 * 容量配置必须指向调用方刚创建的临时根。
 *
 * 只做路径相等断言，不解析环境变量；默认 dataDir、真实 magpie 端口和任何
 * 逃出根的路径都直接拒绝，避免漏配的字段把实验带到真实数据上。
 */
export function assertCapacityIsolation(input: {
  root: string; config: Config; upstreamPort: number;
}): void {
  const root = realpathSync(input.root);
  const temp = realpathSync(tmpdir());
  const fromTemp = relative(temp, root);
  if (fromTemp === '' || fromTemp.startsWith('..') || isAbsolute(fromTemp)) {
    throw new Error('capacity_root_outside_tmp');
  }
  if (!basename(root).startsWith('atc-capacity-')) throw new Error('capacity_root_name');
  const expected: Array<[keyof Config, string]> = [
    // 与调用方使用同一个 root 字符串拼路径；realpath 只用于判断根是否落在临时目录内。
    ['dataDir', join(input.root, 'data')],
    ['ledgerPath', join(input.root, 'sources', 'usage.jsonl')],
    ['routingDir', join(input.root, 'sources', 'routing')],
  ];
  for (const [key, path] of expected) {
    if (resolve(String(input.config[key])) !== resolve(path)) {
      throw new Error(`capacity_${key}_mismatch`);
    }
  }
  if (input.upstreamPort === 3425) throw new Error('capacity_upstream_is_real_magpie');
  const upstream = `http://127.0.0.1:${input.upstreamPort}`;
  if (input.config.magpieUrl !== upstream) throw new Error('capacity_upstream_mismatch');
  if (!(input.config.bodyBudget > 0 && input.config.bodyBudget < input.config.diskLimit)) {
    throw new Error('capacity_budget_order');
  }
}
