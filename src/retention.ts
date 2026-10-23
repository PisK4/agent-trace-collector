import { readdirSync, statfsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { Store } from './store';
import { markRequestInputTx } from './derive-state';
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

/** 只算正文逻辑占用，不扫目录；回收循环用它判断是否已降到目标。 */
export function measureBodyBytes(store: Store): number {
  const blockBytes = store.read.query<{ n: number }, []>(
    'SELECT IFNULL(SUM(length(z)),0) AS n FROM block',
  ).get()?.n ?? 0;
  const skeletonBytes = store.read.query<{ n: number }, []>(
    'SELECT IFNULL(SUM(length(skeleton_z)),0) AS n FROM request',
  ).get()?.n ?? 0;
  const rawHookBytes = store.read.query<{ n: number }, []>(
    'SELECT IFNULL(SUM(length(request_z) + length(response_z)),0) AS n FROM raw_hook',
  ).get()?.n ?? 0;
  return blockBytes + skeletonBytes + rawHookBytes;
}

export type StorageUsage = {
  body_bytes: number;
  db_bytes: number;
  wal_bytes: number;
  temp_bytes: number;
  other_bytes: number;
  total_bytes: number;
  free_bytes: number;
  page_count: number;
  freelist_count: number;
};

export type AdmissionMode = 'normal' | 'metadata_only' | 'paused';
export type Admission = { mode: AdmissionMode; reason: string | null };
export type AdmissionLimits = { bodyBudget: number; diskLimit: number };

export type EvictResult = { requests: number; blocks: number; releasedLogicalBytes: number; day: string | null };
export type PruneResult = { ledger: number; route: number; hook: number };
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

/**
 * 正文逻辑预算求和 block.z + skeleton_z + raw_hook 残留正文；共享块在 block 表里只有一行，天然只计一次。
 * 物理用量逐项 stat，和逻辑预算分开：逻辑预算回答"正文占了多少"，物理用量回答"盘还剩多少"。
 */
export function measureStorage(store: Store, dataDir: string): StorageUsage {
  const totals: WalkTotals = { db: 0, wal: 0, temp: 0, other: 0 };
  walk(dataDir, databaseFile(store), totals, 3);

  const pageCount = store.read.query<{ page_count: number }, []>('PRAGMA page_count').get()?.page_count ?? 0;
  const freelist = store.read.query<{ freelist_count: number }, []>('PRAGMA freelist_count').get()?.freelist_count ?? 0;

  return {
    body_bytes: measureBodyBytes(store),
    db_bytes: totals.db,
    wal_bytes: totals.wal,
    temp_bytes: totals.temp,
    other_bytes: totals.other,
    total_bytes: totals.db + totals.wal + totals.temp + totals.other,
    free_bytes: freeBytes(dataDir),
    page_count: pageCount,
    freelist_count: freelist,
  };
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

/**
 * 准入闸门。量测有代价，所以按 TTL 缓存 usage；模式在变化时才落库，
 * 重启后滞回仍从上次的模式接着算，不会一次重启就把暂停状态忘掉。
 */
export function createAdmissionGate(
  store: Store,
  dataDir: string,
  limits: AdmissionLimits,
  options: { ttlMs?: number; clock?: () => number } = {},
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
      usage = measureStorage(store, dataDir);
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
 * 就开始回收，不为空着等正文顶满；按批限量执行，收到目标水位为止，
 * 单批事务不阻塞写入。回收后收缩文件，并让准入缓存作废——回收改变了
 * 占用读数，闸门要重算。返回回收的请求数；0 表示没有触顶或没有可回收正文。
 */
export function enforceBodyBudget(store: Store, dataDir: string,
  limits: { bodyBudget: number; diskLimit: number },
  hooks: { invalidate(): void }): number {
  const usage = measureStorage(store, dataDir);
  const bodyFull = usage.body_bytes >= limits.bodyBudget * EVICT_TARGET_RATIO;
  const diskTight = usage.total_bytes >= limits.diskLimit * DISK_METADATA_RATIO;
  if (!bodyFull && !diskTight) return 0;
  const target = limits.bodyBudget * EVICT_TARGET_RATIO;
  let evicted = 0;
  for (let batch = 0; batch < 20; batch++) {
    if (measureBodyBytes(store) <= target && evicted > 0) break;
    const result = evictOldestBodyBatch(store, Date.now());
    if (result.requests === 0) break;
    evicted += result.requests;
  }
  if (evicted > 0) {
    shrinkStorage(store);
    hooks.invalidate();
  }
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
    const blockBytes = db.query<{ n: number }, []>(`
      SELECT IFNULL(SUM(length(z)),0) AS n FROM block
      WHERE id IN (SELECT block_id FROM evict_blocks)
        AND NOT EXISTS (SELECT 1 FROM request_block rb WHERE rb.block=block.id)`).get()?.n ?? 0;
    const skeletonBytes = db.query<{ n: number }, []>(`
      SELECT IFNULL(SUM(length(skeleton_z)),0) AS n FROM request
      WHERE req_id IN (SELECT req_id FROM evict_requests)`).get()?.n ?? 0;

    db.run('DELETE FROM request_block WHERE req_id IN (SELECT req_id FROM evict_requests)');
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
 * 原始层到期清理。长期读数（attempt 字段、route_summary、解析状态、正文）不依赖 raw 层，
 * 所以先标证据过期再删原文；仍带正文又没完成关联的 hook 原文不按到期删，只在 issue 里记一笔。
 */
export function pruneRaw(store: Store, beforeMs: number, limit = PRUNE_BATCH): PruneResult {
  return store.write(db => {
    const ledgerRows = db.query<{ source_kind: string; file_generation: string; byte_offset: number }, [number, number]>(`
      SELECT source_kind, file_generation, byte_offset FROM raw_ledger
      WHERE t_ms < ? ORDER BY t_ms LIMIT ?`).all(beforeMs, limit);
    const deleteLedger = db.prepare(
      'DELETE FROM raw_ledger WHERE source_kind=? AND file_generation=? AND byte_offset=?',
    );
    const expire = db.prepare(
      "UPDATE request_evidence SET payload_state='expired' WHERE source_kind=? AND ref_key=?",
    );
    // 证据过期会改变投影完整度（current 变 false、reason 换成 expired），
    // 这里与删原文同一事务重算投影：读模型不会看到"raw 已删但还标 current"的中间态。
    // 长期 kind 集合不因 raw 缺失而撤销——那是长期事实，不是本次证据缺失。
    const ownersOf = db.prepare(
      'SELECT req_id FROM request_evidence WHERE source_kind=? AND ref_key=?',
    );
    const expiredOwners = new Set<number>();
    const expireEvidence = (kind: string, refKey: string): void => {
      for (const row of ownersOf.all(kind, refKey) as { req_id: number }[]) expiredOwners.add(row.req_id);
      expire.run(kind, refKey);
    };
    for (const row of ledgerRows) {
      deleteLedger.run(row.source_kind, row.file_generation, row.byte_offset);
      expireEvidence('ledger', JSON.stringify(['file', row.file_generation, row.byte_offset]));
    }

    // route 只删已经落到 route_summary 或根本没被请求引用的行。
    const routeRows = db.query<{ route_id: number }, [number, number]>(`
      SELECT r.route_id FROM raw_route r
      WHERE r.time_ms < ?
        AND (EXISTS(SELECT 1 FROM route_summary s WHERE s.route_id=r.route_id)
             OR NOT EXISTS(SELECT 1 FROM request q WHERE q.route_id=r.route_id))
      ORDER BY r.time_ms LIMIT ?`).all(beforeMs, limit);
    const deleteRoute = db.prepare('DELETE FROM raw_route WHERE route_id=?');
    for (const row of routeRows) deleteRoute.run(row.route_id);

    const hookRows = db.query<{ hook_id: string; has_body: number; linked: number }, [number, number]>(`
      SELECT h.hook_id AS hook_id,
             (h.request_z IS NOT NULL OR h.response_z IS NOT NULL) AS has_body,
             (SELECT COUNT(*) FROM request_evidence e JOIN request q ON q.req_id=e.req_id
               WHERE e.source_kind='hook' AND e.ref_key=h.hook_id AND q.skeleton_z IS NOT NULL) AS linked
      FROM raw_hook h WHERE h.received_at < ? ORDER BY h.received_at LIMIT ?`).all(beforeMs, limit);
    const deleteHook = db.prepare('DELETE FROM raw_hook WHERE hook_id=?');
    let ledger = 0;
    let route = 0;
    let hook = 0;
    for (const row of hookRows) {
      if (row.has_body !== 0 && row.linked === 0) {
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
    ledger = ledgerRows.length;
    route = routeRows.length;
    // 过期证据的归属请求要重算：投影与派生输入都变了。
    for (const reqId of expiredOwners) {
      projectRequestTx(db, reqId, { now: beforeMs, mappingVersion: SOURCE_PROJECTION_VERSION });
      markRequestInputTx(db, reqId);
    }
    return { ledger, route, hook };
  });
}

/** 物理收缩：分批增量回收空闲页，再截断 WAL。不做在线全库 VACUUM。 */
export function shrinkStorage(store: Store): { freelist_before: number; freelist_after: number; checkpoint: string } {
  const freelist = (): number =>
    store.db.query<{ freelist_count: number }, []>('PRAGMA freelist_count').get()?.freelist_count ?? 0;
  const before = freelist();
  for (let round = 0; round < 128 && freelist() > 0; round++) {
    store.db.exec('PRAGMA incremental_vacuum(256)');
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
  return { freelist_before: before, freelist_after: after, checkpoint };
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
  return store.write(db => {
    const rows = db.query<{ source_kind: string; source_name: string; file_generation: string; from_off: number }, [string]>(`
      SELECT source_kind, source_name, file_generation, from_off FROM source_gap
      WHERE source_name=? AND state IN ('open','resumable')`).all(sourceName);
    let recoverable = 0;
    let unrecoverable = 0;
    const now = Date.now();
    for (const row of rows) {
      const cursor = db.query<{ file_generation: string }, [string, string]>(
        'SELECT file_generation FROM source_cursor WHERE source_kind=? AND source_name=?',
      ).get(row.source_kind, row.source_name);
      const same = cursor !== null && cursor.file_generation === row.file_generation;
      db.run(
        `UPDATE source_gap SET state=?, updated_at=?
         WHERE source_kind=? AND source_name=? AND file_generation=? AND from_off=?`,
        [same ? 'resumable' : 'unrecoverable', now, row.source_kind, row.source_name, row.file_generation, row.from_off],
      );
      if (same) recoverable += 1;
      else unrecoverable += 1;
    }
    return { recoverable, unrecoverable };
  });
}
