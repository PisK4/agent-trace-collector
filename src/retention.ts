import { readdirSync, statfsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { Store } from './store';
import { commitUnit } from './store';
import { capacityMeterBodyBytes, capacityMeterEvictableBytes } from './capacity-meter';
import { markRequestInputTx } from './derive/state';
import { SOURCE_PROJECTION_VERSION, projectRequestTx } from './sources/projection';

/**
 * 容量与保留。
 *
 * 三件事共用一条写入路径：
 * - 写前准入：按数据目录实际占用、正文逻辑预算和文件系统剩余空间决定还能不能收新正文；
 * - 正文回收：按 day/started_ms/req_id 从旧到新清掉正文，共享块只在最后一个引用消失时删；
 * - 原始层清理与缺口记录：raw 层到期先标证据过期再删原文，暂停期间的提交偏移不动，
 *   只把"看到了但没入库"的区间记成缺口，恢复后补采，补不回来的永久可见。
 *
 * 所有回收都在一个 immediate 事务里完成；事务间没有"删了引用还没标状态"的中间态。
 */

/**
 * 正文与会话原始层 payload 的逻辑占用，不扫目录。
 *
 * 计数由 schema v14 的触发器在写入事务里维护；这里只读四行，成本与历史规模无关。
 * 回收判断读的是当前已提交值，不使用异步快照。
 */
export function measureBodyBytes(store: Store): number {
  return capacityMeterBodyBytes(store.read);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

export type StorageUsage = {
  body_bytes: number;
  db_bytes: number;
  wal_bytes: number;
  temp_bytes: number;
  other_bytes: number;
  total_bytes: number;
  free_bytes: number;
  page_size: number;
  page_count: number;
  freelist_count: number;
};

export type AdmissionMode = 'normal' | 'metadata_only' | 'paused';
export type Admission = { mode: AdmissionMode; reason: string | null };
export type AdmissionLimits = { bodyBudget: number; diskLimit: number };

export type EvictResult = { requests: number; blocks: number; releasedLogicalBytes: number; day: string | null };
export type PruneResult = {
  ledger: number; route: number; hook: number; otlpSpan: number; otlpLog: number; session: number;
};
export type ResumeResult = { recoverable: number; unrecoverable: number };

const MiB = 1024 * 1024;

/** 写前余量下限；实际取 max(这个值, 2 × 本批上界)。 */
export const MIN_WRITE_MARGIN = 256 * MiB;
/** 正文预算触发回收后要降到这个比例才恢复收新正文。 */
export const EVICT_TARGET_RATIO = 0.9;
export const DISK_METADATA_RATIO = 0.8;
export const DISK_PAUSED_RATIO = 0.95;
export const DISK_RESUME_METADATA_RATIO = 0.9;
export const DISK_RESUME_NORMAL_RATIO = 0.75;
export const RAW_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const EVICT_BATCH = 100;
const EVICT_REF_LIMIT = 10_000;
const PRUNE_BATCH = 100;
/**
 * 单批 raw 清理的载荷上限：行数之外再按字节截断，避免一条大 payload 把写事务拖长。
 * 单行超过预算时仍删这一行——一行是一个不可再分的删除单位。
 */
export const PRUNE_PAYLOAD_BUDGET_BYTES = 4 * MiB;
/** 单次准备的候选行上限（每张表）；其余留给下一个 tick，避免准备阶段自己变成尖刺。 */
const PRUNE_PREPARE_ROWS = 2_000;
/**
 * 单次有界清理的批数上限。每小时一个 tick × 每批各表 100 行 × 200 批
 * ≈ 2 万行/表/时，覆盖观测到的日增量（otlp span 峰值单日 150,603 行）还有余量。
 * 单批边界由行数与载荷预算共同保证，外层分批只负责让出事件循环。
 */
export const PRUNE_MAX_BATCHES = 200;
/** 单次有界清理的墙钟上限：批间让出事件循环，超时即停，余量留给下一个 tick。 */
export const PRUNE_WALL_BUDGET_MS = 200;
/** 在线增量 vacuum 的显式上限：单次最多轮数、每轮页数与批间墙钟预算。 */
export const SHRINK_MAX_ROUNDS = 32;
export const SHRINK_PAGES_PER_ROUND = 256;
export const SHRINK_WALL_BUDGET_MS = 500;
/** 正文回收循环的显式上限；单批自身仍由 EVICT_BATCH 与 EVICT_REF_LIMIT 限定。 */
export const RETENTION_MAX_BATCHES = 20;
export const RETENTION_WALL_BUDGET_MS = 2_000;
/**
 * 磁盘压力的独立目标水位：触发线是 DISK_METADATA_RATIO（80%），
 * 回收目标是 75%，与暂停后恢复正常模式的回落线一致。
 */
export const DISK_EVICT_TARGET_RATIO = 0.75;

function databaseFile(store: Store): string {
  const filename = (store.db as unknown as { filename?: unknown }).filename;
  return typeof filename === 'string' && filename.length > 0 ? basename(filename) : 'trace.db';
}

type WalkTotals = { db: number; wal: number; temp: number; other: number };

function classify(name: string, dbName: string): keyof WalkTotals {
  if (name === dbName) return 'db';
  if (name === `${dbName}-wal` || name === `${dbName}-shm` || name === `${dbName}-journal`) return 'wal';
  if (/^(temp|etilqs_)/i.test(name) || /\.(?:tmp|temp)$/i.test(name)) return 'temp';
  return 'other';
}

/**
 * 只统计数据目录里的普通文件。符号链接一律跳过：
 * 目录外的东西不属于本服务管理，跟随过去会把别人的文件算进预算。
 */
function walk(dir: string, dbName: string, totals: WalkTotals, depth: number): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (depth > 0) walk(full, dbName, totals, depth - 1);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      totals[classify(entry.name, dbName)] += statSync(full).size;
    } catch {
      // 文件可能在列目录和 stat 之间被删除。
    }
  }
}

function freeBytes(dir: string): number {
  try {
    const stats = statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return 0;
  }
}

type DiskUsage = Omit<StorageUsage, 'body_bytes'>;

/** 目录扫描、statfs 与页计数；个位数毫秒，闸门每次同步取这部分。 */
function measureDiskUsage(store: Store, dataDir: string): DiskUsage {
  const totals: WalkTotals = { db: 0, wal: 0, temp: 0, other: 0 };
  walk(dataDir, databaseFile(store), totals, 3);

  const pageCount = store.read.query<{ page_count: number }, []>('PRAGMA page_count').get()?.page_count ?? 0;
  const pageSize = store.read.query<{ page_size: number }, []>('PRAGMA page_size').get()?.page_size ?? 0;
  const freelist = store.read.query<{ freelist_count: number }, []>('PRAGMA freelist_count').get()?.freelist_count ?? 0;

  return {
    db_bytes: totals.db,
    wal_bytes: totals.wal,
    temp_bytes: totals.temp,
    other_bytes: totals.other,
    total_bytes: totals.db + totals.wal + totals.temp + totals.other,
    free_bytes: freeBytes(dataDir),
    page_size: pageSize,
    page_count: pageCount,
    freelist_count: freelist,
  };
}

/**
 * 存储量测：物理用量逐项 stat，正文取四源计数行。
 *
 * 逻辑预算回答"正文占了多少"，物理用量回答"盘还剩多少"；正文不再全表求和，
 * 两部分都是常数成本，报告、准入与回收判断共用这一份读数。
 */
export function measureStorage(store: Store, dataDir: string): StorageUsage {
  return { ...measureDiskUsage(store, dataDir), body_bytes: measureBodyBytes(store) };
}

/**
 * 写前准入。门槛带滞回，避免在阈值附近反复切换：
 * - 总盘 95% 暂停（跌回 90% 以下才考虑恢复），80% 起只接元数据（跌回 75% 以下才恢复）；
 * - 正文预算满时也只接元数据，先靠回收降到 90% 预算；
 * - 不论哪种模式，剩余空间不足 max(256 MiB, 2 × 本批上界) 都算暂停。
 */
export function admission(
  usage: StorageUsage,
  limits: AdmissionLimits,
  batchUpperBytes: number,
  previous: AdmissionMode,
): Admission {
  const batchUpper = Number.isFinite(batchUpperBytes) && batchUpperBytes > 0 ? batchUpperBytes : 0;
  const ratio = limits.diskLimit > 0 ? usage.total_bytes / limits.diskLimit : 1;
  const pausedFloor = previous === 'paused' ? DISK_RESUME_METADATA_RATIO : DISK_PAUSED_RATIO;
  if (ratio >= pausedFloor) return { mode: 'paused', reason: 'disk_budget' };

  const margin = Math.max(MIN_WRITE_MARGIN, batchUpper * 2);
  if (usage.free_bytes < margin) return { mode: 'paused', reason: 'disk_free' };

  const metadataFloor = previous === 'normal' ? DISK_METADATA_RATIO : DISK_RESUME_NORMAL_RATIO;
  if (ratio >= metadataFloor) return { mode: 'metadata_only', reason: 'disk_budget' };

  // 本批可能写进来的量也要算进去，否则贴着预算上限时这一批仍会被收下。
  const bodyFloor = previous === 'normal' ? limits.bodyBudget : limits.bodyBudget * EVICT_TARGET_RATIO;
  if (usage.body_bytes + batchUpper >= bodyFloor) return { mode: 'metadata_only', reason: 'body_budget' };

  return { mode: 'normal', reason: null };
}

export type AdmissionGate = {
  /** 按本批上界评估；内部按 TTL 复用量测结果。 */
  check(batchUpperBytes: number): Admission;
  /** 刚回收或清理过，丢掉缓存迫使下次重新计量。 */
  invalidate(): void;
  last(): { mode: AdmissionMode; reason: string | null; usage: StorageUsage | null; at_ms: number | null };
};

const ADMISSION_KEY = JSON.stringify(['retention', 'admission']);

function persistedMode(store: Store): AdmissionMode | null {
  const row = store.read.query<{ value_json: string }, [string]>(
    'SELECT value_json FROM collector_state WHERE key=?',
  ).get(ADMISSION_KEY);
  if (row == null) return null;
  try {
    const parsed = JSON.parse(row.value_json) as { mode?: unknown };
    return parsed.mode === 'normal' || parsed.mode === 'metadata_only' || parsed.mode === 'paused'
      ? parsed.mode
      : null;
  } catch {
    return null;
  }
}

export type AdmissionGateOptions = {
  ttlMs?: number;
  clock?: () => number;
  /** 同步量测（目录扫描 + 计数行读取）的耗时，供进程观测计数。 */
  onMeasure?: (ms: number) => void;
};

/**
 * 准入闸门。量测有代价，所以按 TTL 缓存 usage；模式在变化时才落库，
 * 重启后滞回仍从上次的模式接着算，不会一次重启就把暂停状态忘掉。
 *
 * 正文读 v14 的四行计数，不再有分块刷新与第二份缓存：`check()` 同步现取，
 * `invalidate()` 只丢缓存，下一次检查直接读当前已提交值。
 */
export function createAdmissionGate(
  store: Store,
  dataDir: string,
  limits: AdmissionLimits,
  options: AdmissionGateOptions = {},
): AdmissionGate {
  const ttl = options.ttlMs ?? 2000;
  const clock = options.clock ?? Date.now;
  let usage: StorageUsage | null = null;
  let measuredAt = Number.NEGATIVE_INFINITY;
  let mode: AdmissionMode = persistedMode(store) ?? 'normal';
  let reason: string | null = null;

  const refresh = (): StorageUsage => {
    const now = clock();
    if (usage === null || now - measuredAt >= ttl) {
      const started = performance.now();
      usage = measureStorage(store, dataDir);
      options.onMeasure?.(performance.now() - started);
      measuredAt = now;
    }
    return usage;
  };

  return {
    check(batchUpperBytes) {
      const current = refresh();
      const decision = admission(current, limits, batchUpperBytes, mode);
      if (decision.mode !== mode) {
        mode = decision.mode;
        store.write(db => db.run(
          'INSERT INTO collector_state(key,value_json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json',
          [ADMISSION_KEY, JSON.stringify({ mode, reason: decision.reason, at_ms: clock() })],
        ));
      }
      reason = decision.reason;
      return decision;
    },
    invalidate() {
      // 只丢缓存；下一次 check 直接读当前已提交的计数与磁盘占用。
      usage = null;
      measuredAt = Number.NEGATIVE_INFINITY;
    },
    last() {
      return { mode, reason, usage, at_ms: usage === null ? null : measuredAt };
    },
  };
}

/**
 * 回收一批最旧的正文。
 *
 * 候选只认"还有正文存储"的请求（骨架非空且未回收）；pending 且没有正文的不入候选。
 * 排序先 day 再 started_ms/req_id，单批最多 100 笔、正文引用 10,000 条；
 * 单笔就超过引用上限时独占一批，不切半笔事务。
 *
 * 删引用、删孤儿块、清骨架、改状态在同一事务里完成；
 * 已回收的请求不覆盖 body_prev_state，重复执行是幂等的。
 */
/**
 * 预算触顶时的回收执行。
 *
 * 正文占用到了预算的 EVICT_TARGET_RATIO、或总盘占用到了 DISK_METADATA_RATIO
 * 就开始回收，不为空着等正文顶满。两条触发各有自己的目标：
 * - 正文预算回收到 `bodyBudget × 0.9`；
 * - 磁盘压力回收到 `diskLimit × 0.75`，先收空闲页，再按「空闲页 + 可淘汰正文」
 *   能否覆盖缺口决定要不要继续删正文。逻辑载荷到不了磁盘目标时直接收手：
 *   每轮继续删只会清空历史，文件并不会降到目标线以下。
 *
 * 单次调用按批限量，批间检查墙钟；单批事务仍同步执行，不能抢占。
 * 磁盘目标不可达时停止为磁盘压力淘汰，正文预算独立执行。返回回收的请求数。
 */
export type RetentionBudget = { maxBatches?: number; wallMs?: number; shrink?: ShrinkBudget };

export function enforceBodyBudget(store: Store, dataDir: string,
  limits: { bodyBudget: number; diskLimit: number },
  hooks: { invalidate(): void },
  budget: RetentionBudget = {}): number {
  const maxBatches = budget.maxBatches ?? RETENTION_MAX_BATCHES;
  const wallMs = budget.wallMs ?? RETENTION_WALL_BUDGET_MS;
  const started = performance.now();
  const bodyTarget = limits.bodyBudget * EVICT_TARGET_RATIO;
  const diskTrigger = limits.diskLimit * DISK_METADATA_RATIO;
  const diskTarget = limits.diskLimit * DISK_EVICT_TARGET_RATIO;

  let usage = measureStorage(store, dataDir);
  const bodyFull = usage.body_bytes >= bodyTarget;
  let diskTight = usage.total_bytes >= diskTrigger;
  if (!bodyFull && !diskTight) return 0;

  let shrunk = false;
  let diskBudget = 0;
  if (diskTight) {
    // 先收已经空闲的页：这是唯一不丢历史的回收，也决定正文淘汰是否还有意义。
    shrinkStorage(store, budget.shrink);
    shrunk = true;
    usage = measureStorage(store, dataDir);
    diskTight = usage.total_bytes >= diskTrigger;
    if (!bodyFull && !diskTight) {
      hooks.invalidate();
      return 0;
    }
    if (diskTight) {
      const freePageBytes = usage.freelist_count * (usage.page_size || 4096);
      const gap = Math.max(0, usage.total_bytes - diskTarget);
      const evictable = capacityMeterEvictableBytes(store.read);
      // 磁盘目标不可达时只停磁盘淘汰，正文预算仍独立执行。
      if (gap > freePageBytes + evictable) diskTight = false;
      else diskBudget = Math.max(0, gap - freePageBytes);
    }
  }

  let evicted = 0;
  let diskReclaimed = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const bodyBytes = measureBodyBytes(store);
    const needBody = bodyFull && bodyBytes > bodyTarget;
    const needDisk = diskTight && diskReclaimed < diskBudget;
    if (!needBody && !needDisk) break;
    const result = evictOldestBodyBatch(store, Date.now());
    if (result.requests === 0) break;
    evicted += result.requests;
    diskReclaimed += result.releasedLogicalBytes;
    if (performance.now() - started >= wallMs) break;
  }
  if (evicted > 0) {
    shrinkStorage(store, budget.shrink);
    shrunk = true;
  }
  if (shrunk) hooks.invalidate();
  return evicted;
}

export function evictOldestBodyBatch(store: Store, now: number, limit = EVICT_BATCH): EvictResult {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('invalid_evict_limit');
  const maxRequests = Math.min(limit, EVICT_BATCH);
  return store.write(db => {
    db.exec('CREATE TEMP TABLE IF NOT EXISTS evict_requests(req_id INTEGER PRIMARY KEY)');
    db.exec('CREATE TEMP TABLE IF NOT EXISTS evict_blocks(block_id INTEGER PRIMARY KEY)');
    db.run('DELETE FROM evict_requests');
    db.run('DELETE FROM evict_blocks');

    const candidates = db.query<{ req_id: number; day: string }, [number]>(`
      SELECT req_id, day FROM request
      WHERE skeleton_z IS NOT NULL AND body_state <> 'evicted'
      ORDER BY day, started_ms, req_id LIMIT ?`).all(maxRequests);

    const insertRequest = db.prepare('INSERT INTO evict_requests(req_id) VALUES (?)');
    const refCount = db.query<{ n: number }, [number]>(
      'SELECT COUNT(*) AS n FROM request_block WHERE req_id=?',
    );
    let requests = 0;
    let refs = 0;
    let day: string | null = null;
    for (const row of candidates) {
      const count = refCount.get(row.req_id)?.n ?? 0;
      if (requests > 0 && refs + count > EVICT_REF_LIMIT) break;
      insertRequest.run(row.req_id);
      requests += 1;
      refs += count;
      day = row.day;
    }
    if (requests === 0) return { requests: 0, blocks: 0, releasedLogicalBytes: 0, day: null };

    db.run(`INSERT INTO evict_blocks(block_id)
            SELECT DISTINCT block FROM request_block WHERE req_id IN (SELECT req_id FROM evict_requests)`);

    // 只有最后一个引用消失的块才会真正释放；共享块留在原地。
    // 必须在删掉本批引用之后再统计，否则候选块仍被 evict_requests 自己引用着，
    // NOT EXISTS 恒为假，releasedLogicalBytes 会漏掉全部块字节。
    const skeletonBytes = db.query<{ n: number }, []>(`
      SELECT IFNULL(SUM(length(skeleton_z)),0) AS n FROM request
      WHERE req_id IN (SELECT req_id FROM evict_requests)`).get()?.n ?? 0;

    db.run('DELETE FROM request_block WHERE req_id IN (SELECT req_id FROM evict_requests)');
    const blockBytes = db.query<{ n: number }, []>(`
      SELECT IFNULL(SUM(length(z)),0) AS n FROM block
      WHERE id IN (SELECT block_id FROM evict_blocks)
        AND NOT EXISTS (SELECT 1 FROM request_block rb WHERE rb.block=block.id)`).get()?.n ?? 0;
    const deletedBlocks = db.run(`
      DELETE FROM block
      WHERE id IN (SELECT block_id FROM evict_blocks)
        AND NOT EXISTS (SELECT 1 FROM request_block rb WHERE rb.block=block.id)`).changes;

    const evicted = db.run(
      `UPDATE request SET skeleton_z=NULL,
         body_prev_state=CASE WHEN body_state='evicted' THEN body_prev_state ELSE body_state END,
         body_state='evicted', body_evicted_at=?, body_evict_reason='budget', updated_at=?
       WHERE req_id IN (SELECT req_id FROM evict_requests)`,
      [now, now],
    ).changes;

    // 正文删掉的同一事务里推进修订：引用没了，序列指纹就不可比，
    // 派生结论必须重算而不是继续沿用删除前的结果。
    for (const row of candidates.slice(0, requests)) markRequestInputTx(db, row.req_id);

    db.run('DELETE FROM evict_requests');
    db.run('DELETE FROM evict_blocks');
    return { requests: evicted, blocks: deletedBlocks, releasedLogicalBytes: blockBytes + skeletonBytes, day };
  });
}

/**
 * 候选只取键，不取 payload；载荷预算在写事务里逐行取长度后才决定，保证
 * 「准备阶段不读大 TEXT」且单批读入量约为预算加一行（超大首行不可切分）。
 */
type PruneCursor = {
  ledger: number; route: number; hook: number; otlpSpan: number; otlpLog: number; session: number;
};

type LedgerCandidate = { source_kind: string; file_generation: string; byte_offset: number };
type RouteCandidate = { route_id: number };
type HookCandidate = { hook_id: string };
type OtlpSpanCandidate = { trace_id: Uint8Array; span_id: Uint8Array };
type OtlpLogCandidate = { record_hash: Uint8Array };
type SessionCandidate = { file_generation: string; byte_offset: number };
type PruneCandidates = {
  ledger: LedgerCandidate[];
  route: RouteCandidate[];
  hook: HookCandidate[];
  otlpSpan: OtlpSpanCandidate[];
  otlpLog: OtlpLogCandidate[];
  session: SessionCandidate[];
};

const emptyCandidates = (): PruneCandidates => ({
  ledger: [], route: [], hook: [], otlpSpan: [], otlpLog: [], session: [],
});

function emptyResult(): PruneResult {
  return { ledger: 0, route: 0, hook: 0, otlpSpan: 0, otlpLog: 0, session: 0 };
}

function zeroCursor(): PruneCursor {
  return { ledger: 0, route: 0, hook: 0, otlpSpan: 0, otlpLog: 0, session: 0 };
}

function hasCandidates(candidates: PruneCandidates): boolean {
  return candidates.ledger.length + candidates.route.length + candidates.hook.length
    + candidates.otlpSpan.length + candidates.otlpLog.length + candidates.session.length > 0;
}

function hasRemaining(candidates: PruneCandidates, cursor: PruneCursor): boolean {
  return cursor.ledger < candidates.ledger.length || cursor.route < candidates.route.length
    || cursor.hook < candidates.hook.length || cursor.otlpSpan < candidates.otlpSpan.length
    || cursor.otlpLog < candidates.otlpLog.length || cursor.session < candidates.session.length;
}

type SourceCursorRow = { fingerprint: string | null; last_ok_ms: number };

/** source_cursor 是几十行的小表；每批读一次，避免逐代际重复查询。 */
function loadSessionCursors(db: Database): Map<string, SourceCursorRow[]> {
  const byGeneration = new Map<string, SourceCursorRow[]>();
  const rows = db.query<{ file_generation: string; fingerprint: string | null; last_ok_ms: number }, []>(
    'SELECT file_generation, fingerprint, last_ok_ms FROM source_cursor',
  ).all();
  for (const row of rows) {
    const list = byGeneration.get(row.file_generation);
    if (list === undefined) byGeneration.set(row.file_generation, [row]);
    else list.push(row);
  }
  return byGeneration;
}

function sessionGenerationDead(cursors: Map<string, SourceCursorRow[]>,
  generation: string, beforeMs: number): boolean {
  const rows = cursors.get(generation);
  return rows === undefined || rows.length === 0
    || rows.some(row => row.fingerprint !== null && row.last_ok_ms < beforeMs);
}

/**
 * 代际轮转游标。按主键 `(file_generation, byte_offset)` 逐代际 seek：
 * 一条 `file_generation > ? ORDER BY file_generation LIMIT 1` 就跳到下一代，
 * 不读同代际的 payload，也不做 DISTINCT 全表扫描。到达末尾后回卷。
 */
const sessionGenerationCursors = new WeakMap<Database, string>();
const PRUNE_SESSION_GENERATION_SEEKS = 4096;

/**
 * 一次只读扫描准备候选键，后续所有批次都从这份清单里取。
 *
 * 每张表只在调用开始时扫描一次，避免「外层 200 批 × 每批全表扫」；
 * 只取键，不读 payload。没有 ORDER BY 的表不加排序，让 LIMIT 在扫描到
 * 足够候选时立即停止。会话代际按主键 seek 枚举，活动代际只花一次 seek。
 */
function prepareRawPrune(db: Database, beforeMs: number, limit: number): PruneCandidates {
  const candidates = emptyCandidates();
  if (limit <= 0) return candidates;

  candidates.ledger = db.query<LedgerCandidate, [number, number]>(`
    SELECT source_kind, file_generation, byte_offset
    FROM raw_ledger WHERE t_ms < ? ORDER BY t_ms LIMIT ?`).all(beforeMs, limit);

  candidates.route = db.query<RouteCandidate, [number, number]>(`
    SELECT r.route_id FROM raw_route r
    WHERE r.time_ms < ?
      AND (EXISTS(SELECT 1 FROM route_summary s WHERE s.route_id=r.route_id)
           OR NOT EXISTS(SELECT 1 FROM request q WHERE q.route_id=r.route_id))
    LIMIT ?`).all(beforeMs, limit);

  candidates.hook = db.query<HookCandidate, [number, number]>(`
    SELECT h.hook_id FROM raw_hook h WHERE h.received_at < ?
      AND ((h.request_z IS NULL AND h.response_z IS NULL)
        OR EXISTS (SELECT 1 FROM request_evidence e JOIN request q ON q.req_id=e.req_id
          WHERE e.source_kind='hook' AND e.ref_key=h.hook_id AND q.skeleton_z IS NOT NULL)
        OR NOT EXISTS (SELECT 1 FROM ingest_issue i WHERE i.source_kind='hook'
          AND i.ref_key=h.hook_id AND i.reason='raw_hook_body_unlinked'))
    LIMIT ?`).all(beforeMs, limit);

  candidates.otlpSpan = db.query<OtlpSpanCandidate, [number, number]>(`
    SELECT trace_id, span_id FROM raw_otlp_span WHERE received_at < ? LIMIT ?`)
    .all(beforeMs, limit);

  candidates.otlpLog = db.query<OtlpLogCandidate, [number, number]>(`
    SELECT record_hash FROM raw_otlp_log WHERE received_at < ? LIMIT ?`)
    .all(beforeMs, limit);

  // 追加文件的重放需要当前代际的完整原始行，不能按年龄删；这里只清两类
  // 已不可达的代际：游标已换代留下的孤儿，以及内容不会变的封口文件。
  const cursors = loadSessionCursors(db);
  const previous = sessionGenerationCursors.get(db) ?? '';
  let after = previous;
  let seeks = 0;
  while (candidates.session.length < limit && seeks < PRUNE_SESSION_GENERATION_SEEKS) {
    const next = db.query<{ file_generation: string }, [string]>(`
      SELECT file_generation FROM raw_session_event
      WHERE file_generation > ? ORDER BY file_generation LIMIT 1`).get(after);
    if (next === null) {
      after = '';
      break;
    }
    const generation = next.file_generation;
    const beforeGeneration = after;
    seeks += 1;
    if (!sessionGenerationDead(cursors, generation, beforeMs)) {
      after = generation;
      continue;
    }
    const remaining = limit - candidates.session.length;
    const rows = db.query<SessionCandidate, [string, number]>(`
      SELECT file_generation, byte_offset FROM raw_session_event
      WHERE file_generation=? LIMIT ?`).all(generation, remaining);
    candidates.session.push(...rows);
    if (rows.length < remaining) {
      after = generation;
      continue;
    }
    // 命中行预算时停在代际中间：游标留在这代之前，下一轮仍从同一代续取，
    // 不能把没取完的代际跳过去。
    after = beforeGeneration;
    break;
  }
  sessionGenerationCursors.set(db, after);
  return candidates;
}

type PruneTxOutcome = { result: PruneResult; consumed: number };

/**
 * 删除一批已准备的候选；会话代际在写事务里重新确认仍不可达，防止准备后被游标认领。
 * 载荷预算在逐行取长度后才决定，首行超大时仍删这一行（不可再分），
 * 所以单批读入量是「预算 + 一行」，不是严格的墙钟上界。
 */
function prunePreparedRawTx(db: Database, beforeMs: number, candidates: PruneCandidates,
  cursor: PruneCursor, limit: number, payloadBudget: number): PruneTxOutcome {
  const expiredOwners = new Set<number>();
  const expire = db.prepare(
    "UPDATE request_evidence SET payload_state='expired' WHERE source_kind=? AND ref_key=?",
  );
  // 证据过期会改变投影完整度（current 变 false、reason 换成 expired），
  // 这里与删原文同一事务重算投影：读模型不会看到"raw 已删但还标 current"的中间态。
  // 长期 kind 集合不因 raw 缺失而撤销——那是长期事实，不是本次证据缺失。
  const ownersOf = db.prepare(
    'SELECT req_id FROM request_evidence WHERE source_kind=? AND ref_key=?',
  );
  const expireEvidence = (kind: string, refKey: string): void => {
    for (const row of ownersOf.all(kind, refKey) as { req_id: number }[]) expiredOwners.add(row.req_id);
    expire.run(kind, refKey);
  };
  let consumed = 0;

  const deleteLedger = db.prepare(
    'DELETE FROM raw_ledger WHERE source_kind=? AND file_generation=? AND byte_offset=?',
  );
  const ledgerSize = db.prepare(
    'SELECT length(CAST(payload_json AS BLOB)) AS n FROM raw_ledger WHERE source_kind=? AND file_generation=? AND byte_offset=?',
  );
  let ledger = 0;
  let processed = 0;
  let used = 0;
  while (cursor.ledger < candidates.ledger.length && processed < limit) {
    const row = candidates.ledger[cursor.ledger]!;
    const size = (ledgerSize.get(row.source_kind, row.file_generation, row.byte_offset) as { n: number } | null)?.n ?? 0;
    if (processed > 0 && used + size > payloadBudget) break;
    cursor.ledger += 1;
    processed += 1;
    used += size;
    deleteLedger.run(row.source_kind, row.file_generation, row.byte_offset);
    expireEvidence('ledger', JSON.stringify(['file', row.file_generation, row.byte_offset]));
    ledger += 1;
  }
  consumed += processed;

  // route 只删已经落到 route_summary 或根本没被请求引用的行；候选是准备阶段
  // 取的，写事务里重新确认，避免这期间新建的引用被删掉。
  const routeSize = db.prepare(
    'SELECT length(CAST(payload_json AS BLOB)) AS n FROM raw_route WHERE route_id=?',
  );
  const deleteRoute = db.prepare(`
    DELETE FROM raw_route
    WHERE route_id=?
      AND (EXISTS(SELECT 1 FROM route_summary s WHERE s.route_id=raw_route.route_id)
           OR NOT EXISTS(SELECT 1 FROM request q WHERE q.route_id=raw_route.route_id))`);
  let route = 0;
  processed = 0;
  used = 0;
  while (cursor.route < candidates.route.length && processed < limit) {
    const row = candidates.route[cursor.route]!;
    const size = (routeSize.get(row.route_id) as { n: number } | null)?.n ?? 0;
    if (processed > 0 && used + size > payloadBudget) break;
    cursor.route += 1;
    processed += 1;
    used += size;
    route += deleteRoute.run(row.route_id).changes;
  }
  consumed += processed;

  const deleteHook = db.prepare('DELETE FROM raw_hook WHERE hook_id=?');
  const hookState = db.prepare(`
    SELECT (request_z IS NOT NULL OR response_z IS NOT NULL) AS has_body,
           (SELECT COUNT(*) FROM request_evidence e JOIN request q ON q.req_id=e.req_id
             WHERE e.source_kind='hook' AND e.ref_key=raw_hook.hook_id AND q.skeleton_z IS NOT NULL) AS linked,
           IFNULL(length(request_z),0) + IFNULL(length(response_z),0) AS bytes
    FROM raw_hook WHERE hook_id=?`);
  let hook = 0;
  processed = 0;
  used = 0;
  while (cursor.hook < candidates.hook.length && processed < limit) {
    const row = candidates.hook[cursor.hook]!;
    const current = hookState.get(row.hook_id) as {
      has_body: number; linked: number; bytes: number;
    } | null;
    const size = current?.bytes ?? 0;
    if (processed > 0 && used + size > payloadBudget) break;
    cursor.hook += 1;
    processed += 1;
    used += size;
    if (current === null) continue;
    if (current.has_body !== 0 && current.linked === 0) {
      db.run(
        `INSERT INTO ingest_issue(source_kind,ref_key,reason,observed_at,byte_length) VALUES ('hook',?,?,?,NULL)
         ON CONFLICT(source_kind,ref_key,reason) DO UPDATE SET observed_at=excluded.observed_at`,
        [row.hook_id, 'raw_hook_body_unlinked', beforeMs],
      );
      continue;
    }
    deleteHook.run(row.hook_id);
    expireEvidence('hook', row.hook_id);
    hook += 1;
  }
  consumed += processed;

  // OTLP 原始层同受 TTL 约束：span 删除时把 otlp_span 证据标 expired
  // （行身份在 request.sort_key 里，长期不依赖 raw）；log 记录无证据联动，直接删。
  const deleteOtlpSpan = db.prepare('DELETE FROM raw_otlp_span WHERE trace_id=? AND span_id=?');
  const spanSize = db.prepare(
    'SELECT length(CAST(attributes_json AS BLOB)) AS n FROM raw_otlp_span WHERE trace_id=? AND span_id=?',
  );
  let otlpSpan = 0;
  processed = 0;
  used = 0;
  while (cursor.otlpSpan < candidates.otlpSpan.length && processed < limit) {
    const row = candidates.otlpSpan[cursor.otlpSpan]!;
    const size = (spanSize.get(row.trace_id, row.span_id) as { n: number } | null)?.n ?? 0;
    if (processed > 0 && used + size > payloadBudget) break;
    cursor.otlpSpan += 1;
    processed += 1;
    used += size;
    deleteOtlpSpan.run(row.trace_id, row.span_id);
    expireEvidence('otlp_span', `${Buffer.from(row.trace_id).toString('hex')}/${Buffer.from(row.span_id).toString('hex')}`);
    otlpSpan += 1;
  }
  consumed += processed;

  const deleteOtlpLog = db.prepare('DELETE FROM raw_otlp_log WHERE record_hash=?');
  const logSize = db.prepare(`
    SELECT IFNULL(length(CAST(body AS BLOB)),0) + length(CAST(attributes_json AS BLOB)) AS n
    FROM raw_otlp_log WHERE record_hash=?`);
  let otlpLog = 0;
  processed = 0;
  used = 0;
  while (cursor.otlpLog < candidates.otlpLog.length && processed < limit) {
    const row = candidates.otlpLog[cursor.otlpLog]!;
    const size = (logSize.get(row.record_hash) as { n: number } | null)?.n ?? 0;
    if (processed > 0 && used + size > payloadBudget) break;
    cursor.otlpLog += 1;
    processed += 1;
    used += size;
    deleteOtlpLog.run(row.record_hash);
    otlpLog += 1;
  }
  consumed += processed;

  const sessionSize = db.prepare(
    'SELECT length(CAST(payload_json AS BLOB)) AS n FROM raw_session_event WHERE file_generation=? AND byte_offset=?',
  );
  const deleteSession = db.prepare(
    'DELETE FROM raw_session_event WHERE file_generation=? AND byte_offset=?',
  );
  const sessionCursors = loadSessionCursors(db);
  let session = 0;
  processed = 0;
  used = 0;
  while (cursor.session < candidates.session.length && processed < limit) {
    const row = candidates.session[cursor.session]!;
    const size = (sessionSize.get(row.file_generation, row.byte_offset) as { n: number } | null)?.n ?? 0;
    if (processed > 0 && used + size > payloadBudget) break;
    cursor.session += 1;
    processed += 1;
    used += size;
    if (!sessionGenerationDead(sessionCursors, row.file_generation, beforeMs)) continue;
    deleteSession.run(row.file_generation, row.byte_offset);
    session += 1;
  }
  consumed += processed;

  // 过期证据的归属请求要重算：投影与派生输入都变了。
  for (const reqId of expiredOwners) {
    projectRequestTx(db, reqId, { now: beforeMs, mappingVersion: SOURCE_PROJECTION_VERSION });
    markRequestInputTx(db, reqId);
  }
  return {
    result: { ledger, route, hook, otlpSpan, otlpLog, session },
    consumed,
  };
}

/**
 * 原始层到期清理。长期读数（attempt 字段、route_summary、解析状态、正文）不依赖 raw 层，
 * 所以先标证据过期再删原文；仍带正文又没完成关联的 hook 原文不按到期删，只在 issue 里记一笔。
 *
 * `limit` 限制每张表的候选行数，`payloadBudget` 再限制每张表的载荷字节。
 * 候选在写事务之前一次准备，单批写入有界；整代际一次删掉的旧行为已取消。
 */
export function pruneRaw(store: Store, beforeMs: number, limit = PRUNE_BATCH,
  payloadBudget = PRUNE_PAYLOAD_BUDGET_BYTES): PruneResult {
  const candidates = prepareRawPrune(store.read, beforeMs, limit);
  if (!hasCandidates(candidates)) return emptyResult();
  const cursor = zeroCursor();
  return store.write(
    db => prunePreparedRawTx(db, beforeMs, candidates, cursor, limit, payloadBudget).result,
    'raw_prune',
  );
}

export type PruneBudget = { maxBatches?: number; wallMs?: number };

/**
 * 有界的多批清理：候选键在调用开始时只读扫描一次，之后每批从清单里取，
 * 每批是独立提交的小事务，批间让出事件循环，到批数或墙钟上限即停。
 * 单批内部另受行数与载荷预算约束，所以一次调用不会出现「外层有预算、
 * 里层一条 DELETE 无界」或「每批重扫整张表」的长事务。
 * 超期存量大的首轮靠连续多个 tick 收敛；返回各表累计处理行数。
 *
 * 准备阶段的扫描可能自己就超过墙钟预算，所以首批无条件执行：
 * 否则每个 tick 都会在尚未删除任何行时退出，永远不推进。
 * 单个超大行不可切分，首批仍可能超过载荷预算；这里不宣称每个同步单位严格墙钟有界。
 */
export async function pruneRawBounded(store: Store, beforeMs: number,
  budget: PruneBudget = {}): Promise<PruneResult> {
  const maxBatches = budget.maxBatches ?? PRUNE_MAX_BATCHES;
  const wallMs = budget.wallMs ?? PRUNE_WALL_BUDGET_MS;
  const started = performance.now();
  const total = emptyResult();
  const prepareLimit = Math.min(PRUNE_PREPARE_ROWS, Math.max(PRUNE_BATCH, maxBatches * PRUNE_BATCH));
  const candidates = prepareRawPrune(store.read, beforeMs, prepareLimit);
  if (!hasCandidates(candidates)) return total;
  const cursor = zeroCursor();
  for (let batch = 0; batch < maxBatches; batch++) {
    if (batch > 0 && performance.now() - started >= wallMs) break;
    if (!hasRemaining(candidates, cursor)) break;
    const outcome = store.write(
      db => prunePreparedRawTx(db, beforeMs, candidates, cursor, PRUNE_BATCH, PRUNE_PAYLOAD_BUDGET_BYTES),
      'raw_prune',
    );
    total.ledger += outcome.result.ledger;
    total.route += outcome.result.route;
    total.hook += outcome.result.hook;
    total.otlpSpan += outcome.result.otlpSpan;
    total.otlpLog += outcome.result.otlpLog;
    total.session += outcome.result.session;
    if (outcome.consumed === 0) break;
    await yieldToEventLoop();
    if (performance.now() - started >= wallMs) break;
  }
  return total;
}

export type ShrinkBudget = { maxRounds?: number; pagesPerRound?: number; wallMs?: number };
export type ShrinkResult = {
  freelist_before: number;
  freelist_after: number;
  rounds: number;
  checkpoint: string;
};

/**
 * 物理收缩：分批增量回收空闲页，再截断 WAL。不做在线全库 VACUUM。
 *
 * 单次调用有显式上限（轮数、每轮页数、批间墙钟）；回收不完的留给下一个 tick，
 * 不在一次调用里制造无界停顿。checkpoint 受连接 busy_timeout 约束，忙时返回 busy。
 */
export function shrinkStorage(store: Store, budget: ShrinkBudget = {}): ShrinkResult {
  const maxRounds = budget.maxRounds ?? SHRINK_MAX_ROUNDS;
  const pagesPerRound = budget.pagesPerRound ?? SHRINK_PAGES_PER_ROUND;
  const wallMs = budget.wallMs ?? SHRINK_WALL_BUDGET_MS;
  const started = performance.now();
  const freelist = (): number =>
    store.db.query<{ freelist_count: number }, []>('PRAGMA freelist_count').get()?.freelist_count ?? 0;
  const before = freelist();
  let rounds = 0;
  for (; rounds < maxRounds; rounds++) {
    if (freelist() <= 0) break;
    store.db.exec(`PRAGMA incremental_vacuum(${pagesPerRound})`);
    if (performance.now() - started >= wallMs) {
      rounds += 1;
      break;
    }
  }
  const after = freelist();
  let checkpoint = 'ok';
  try {
    const row = store.db.query<{ busy: number; log: number; checkpointed: number }, []>(
      'PRAGMA wal_checkpoint(TRUNCATE)',
    ).get();
    if (row !== null && row.busy !== 0) checkpoint = 'busy';
  } catch {
    checkpoint = 'busy';
  }
  return { freelist_before: before, freelist_after: after, rounds, checkpoint };
}

export type PausedBatch = {
  source_kind: string;
  source_name: string;
  generation: string;
  from_off: number;
  to_off: number;
};

/**
 * 暂停期间的"看到但没入库"区间。同一来源代际里连续或重叠的区间合并成一行，
 * committed_off 不动，只推进 observed_off：下次读取仍从 committed_off 开始。
 */
export function recordPausedBatchTx(
  db: Database,
  batch: PausedBatch,
  now: number,
): { recorded: boolean; from_off: number; to_off: number } {
  const { source_kind, source_name, generation, from_off, to_off } = batch;
  if (!Number.isInteger(from_off) || !Number.isInteger(to_off) || to_off <= from_off) {
    return { recorded: false, from_off, to_off };
  }
  const overlapping = db.query<{ from_off: number; to_off: number }, [string, string, string, number, number]>(`
    SELECT from_off, to_off FROM source_gap
    WHERE source_kind=? AND source_name=? AND file_generation=?
      AND state IN ('open','resumable') AND to_off >= ? AND from_off <= ?
    ORDER BY from_off`).all(source_kind, source_name, generation, from_off, to_off);

  let start = from_off;
  let end = to_off;
  const remove = db.prepare(
    'DELETE FROM source_gap WHERE source_kind=? AND source_name=? AND file_generation=? AND from_off=?',
  );
  for (const gap of overlapping) {
    start = Math.min(start, gap.from_off);
    end = Math.max(end, gap.to_off);
    remove.run(source_kind, source_name, generation, gap.from_off);
  }
  db.run(
    `INSERT INTO source_gap(source_kind,source_name,file_generation,from_off,to_off,reason,state,updated_at)
     VALUES (?,?,?,?,?,'disk_paused','open',?)`,
    [source_kind, source_name, generation, start, end, now],
  );
  db.run(
    `UPDATE source_cursor SET observed_off=MAX(observed_off,?)
     WHERE source_kind=? AND source_name=? AND file_generation=?`,
    [end, source_kind, source_name, generation],
  );
  return { recorded: true, from_off: start, to_off: end };
}

export function recordPausedBatch(
  store: Store,
  batch: PausedBatch,
  now: number,
): { recorded: boolean; from_off: number; to_off: number } {
  return store.write(db => recordPausedBatchTx(db, batch, now));
}

/**
 * 读取端追平后关闭缺口。只有整段落在已提交区间里的缺口才标 filled；
 * 部分覆盖时把已读部分从缺口里切掉，剩下的继续可见。
 */
export function closeSourceGapsTx(
  db: Database,
  sourceKind: string,
  sourceName: string,
  generation: string,
  from: number,
  to: number,
  now: number,
): number {
  if (to <= from) return 0;
  const rows = db.query<{ from_off: number; to_off: number }, [string, string, string, number, number]>(`
    SELECT from_off, to_off FROM source_gap
    WHERE source_kind=? AND source_name=? AND file_generation=?
      AND state IN ('open','resumable') AND to_off > ? AND from_off < ?`).all(sourceKind, sourceName, generation, from, to);
  let closed = 0;
  for (const gap of rows) {
    if (gap.from_off >= from && gap.to_off <= to) {
      db.run(
        `UPDATE source_gap SET state='filled', updated_at=?
         WHERE source_kind=? AND source_name=? AND file_generation=? AND from_off=?`,
        [now, sourceKind, sourceName, generation, gap.from_off],
      );
      closed += 1;
      continue;
    }
    // 部分覆盖：先删旧行，再把剩下的一侧写回去。PK 里带 from_off，原行必须先删。
    db.run(
      'DELETE FROM source_gap WHERE source_kind=? AND source_name=? AND file_generation=? AND from_off=?',
      [sourceKind, sourceName, generation, gap.from_off],
    );
    if (gap.from_off < from) {
      db.run(
        `INSERT INTO source_gap(source_kind,source_name,file_generation,from_off,to_off,reason,state,updated_at)
         VALUES (?,?,?,?,?,'disk_paused','open',?)`,
        [sourceKind, sourceName, generation, gap.from_off, from, now],
      );
    }
    if (gap.to_off > to) {
      db.run(
        `INSERT INTO source_gap(source_kind,source_name,file_generation,from_off,to_off,reason,state,updated_at)
         VALUES (?,?,?,?,?,'disk_paused','open',?)`,
        [sourceKind, sourceName, generation, to, gap.to_off, now],
      );
    }
  }
  return closed;
}

/**
 * 换到新代际时，旧代际的缺口再也没法按偏移重读：留在表里，但改标不可补。
 * 这一步必须在游标换代之后立刻做，否则恢复逻辑会把它们当可补的区间去重读别的文件。
 */
export function markStaleGapsTx(
  db: Database,
  sourceKind: string,
  sourceName: string,
  now: number,
): number {
  return db.run(`
    UPDATE source_gap SET state='unrecoverable', updated_at=?
    WHERE source_kind=? AND source_name=? AND state IN ('open','resumable')
      AND file_generation <> (SELECT file_generation FROM source_cursor
                              WHERE source_kind=? AND source_name=?)`,
  [now, sourceKind, sourceName, sourceKind, sourceName]).changes;
}

/**
 * 恢复前给缺口定性：文件还是同一代际就能按 committed_off 重读补采，
 * 换了代际（文件被重写/截断）就补不回来了，标记永久可见。
 */
export function resumeSourceGaps(store: Store, sourceName: string): ResumeResult {
  const result = { recoverable: 0, unrecoverable: 0 };
  commitUnit(store, 'gap', read => {
    const rows = read.query<{ source_kind: string; source_name: string; file_generation: string;
      from_off: number; state: string; same: number }, [string]>(`
      SELECT g.source_kind,g.source_name,g.file_generation,g.from_off,g.state,
        COALESCE(g.file_generation=c.file_generation,0) AS same FROM source_gap g
      LEFT JOIN source_cursor c ON c.source_kind=g.source_kind AND c.source_name=g.source_name
      WHERE g.source_name=? AND g.state IN ('open','resumable')`).all(sourceName);
    const changed = rows.filter(row => row.state !== (row.same ? 'resumable' : 'unrecoverable')).slice(0, 100);
    const committed = new Set(changed);
    for (const row of rows) {
      if (row.same) result.recoverable += 1;
      else if (committed.has(row)) result.unrecoverable += 1;
    }
    if (changed.length === 0) return null;
    return db => {
      for (const row of changed) {
        db.run(`UPDATE source_gap SET state=?,updated_at=?
          WHERE source_kind=? AND source_name=? AND file_generation=? AND from_off=?`,
        [row.same ? 'resumable' : 'unrecoverable', Date.now(), row.source_kind,
          row.source_name, row.file_generation, row.from_off]);
      }
    };
  });
  return result;
}
