import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, openSync, readFileSync, statfsSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { openStore } from './store';
import type { Store } from './store';
import { drainDerive, rebuildDerived } from './derive';
import { markGroupDirtyTx } from './derive-state';

/**
 * 离线维护。这些命令都要求在 collector 停止后运行：
 * 备份、校验、整链重排和元数据淘汰。在线写入时做这些事只会得到自相矛盾的快照。
 *
 * 维护锁是数据目录下的一个普通文件，用 `wx` 原子创建；内容记 pid 与持有者标识。
 * 陈旧锁不自动覆盖：只有确认原进程已不在、并且调用方明确允许时才清理。
 */

export type VerifyReport = {
  integrity: string[];
  dangling_blocks: number;
  duplicate_evidence: number;
  pending_derivations: number;
};

export type PurgePreview = {
  requests: number;
  first_day: string | null;
  last_day: string | null;
  estimated_bytes: number;
};

export type PublishResult = { deleted: number; event_id: number };

export const MAINTENANCE_LOCK = 'maintenance.lock';

export function lockPath(dataDir: string): string {
  return join(dataDir, MAINTENANCE_LOCK);
}

/** 服务启动时的检查：维护锁在盘上就拒绝启动，不猜它是不是陈旧锁。 */
export function maintenanceLockPresent(dataDir: string): string | null {
  const path = lockPath(dataDir);
  return existsSync(path) ? path : null;
}

export type LockHandle = { recovered: boolean; release(): void };

type LockOptions = {
  /** 判断锁里记录的进程是否还在；测试注入，生产用 kill(pid, 0)。 */
  pidAlive?: (pid: number) => boolean;
};

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(path: string): { pid?: unknown; holder?: unknown; started_ms?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * 取维护锁，失败返回 null。
 *
 * 锁存在时先看持有者：同一持有者（本进程重入）视为已持有；不同持有者只有在
 * 记录里的 pid 已不存在、且调用方允许时才会被清掉，否则一律拒绝。
 */
export function acquireMaintenanceLock(
  dataDir: string,
  holder: string,
  options: LockOptions = {},
): LockHandle | null {
  const path = lockPath(dataDir);
  const pidAlive = options.pidAlive ?? defaultPidAlive;
  let recovered = false;
  try {
    const fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, holder, started_ms: Date.now() }));
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = readLock(path);
    if (existing === null) return null;
    if (existing.holder === holder) {
      // 同一持有者重入：沿用这把锁，交由调用方在 finally 里释放。
    } else if (typeof existing.pid === 'number' && !pidAlive(existing.pid)) {
      try {
        unlinkSync(path);
      } catch {
        return null;
      }
      recovered = true;
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, holder, started_ms: Date.now() }));
      closeSync(fd);
    } else {
      return null;
    }
  }
  let released = false;
  return {
    recovered,
    release() {
      if (released) return;
      released = true;
      try {
        unlinkSync(path);
      } catch {
        // 已经被删掉就算了。
      }
    },
  };
}

/**
 * 只读校验。integrity 直出 `PRAGMA integrity_check`；
 * 另外查三类最容易悄悄积累的结构问题：没有引用的块、同一 ref_key 的多个 owner、未处理的派生分组。
 */
export function verifyDatabase(path: string): VerifyReport {
  const db = new Database(path, { readonly: true });
  try {
    const integrity = (db.query('PRAGMA integrity_check').all() as { integrity_check: string }[])
      .map(row => row.integrity_check);
    const dangling = db.query<{ n: number }, []>(`
      SELECT COUNT(*) AS n FROM block b
      WHERE NOT EXISTS (SELECT 1 FROM request_block rb WHERE rb.block=b.id)`).get();
    const duplicates = db.query<{ n: number }, []>(`
      SELECT COUNT(*) AS n FROM (
        SELECT source_kind, ref_key FROM request_evidence GROUP BY source_kind, ref_key HAVING COUNT(*) > 1
      )`).get();
    // clean 行是完成记录，不是积压。
    const pending = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM derive_queue WHERE state<>'clean'").get();
    return {
      integrity,
      dangling_blocks: dangling?.n ?? 0,
      duplicate_evidence: duplicates?.n ?? 0,
      pending_derivations: pending?.n ?? 0,
    };
  } finally {
    db.close();
  }
}

function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  const message = error instanceof Error ? error.message : '';
  return code === 'SQLITE_BUSY' || /database is locked/i.test(message);
}

/** 备份至少要留出源库大小 1.1 倍的余量；VACUUM INTO 会压缩，但页对齐留点富余。 */
const BACKUP_SPACE_FACTOR = 1.1;

type BackupOptions = {
  /** 目标目录剩余字节；测试注入，生产用 statfs。 */
  freeBytes?: (dir: string) => number;
};

function defaultFreeBytes(dir: string): number {
  const stats = statfsSync(dir);
  return stats.bavail * stats.bsize;
}

/**
 * 离线备份。源库必须已经没有任何连接——这里用 `locking_mode=EXCLUSIVE` 探测：
 * 独占模式下第一次读会向 WAL 索引申请排他，别的连接还开着就拿到 SQLITE_BUSY。
 * 只读连接上跑 `wal_checkpoint` 检测是行不通的（只读库会直接报错），
 * 看 `-wal` 文件大小也不可靠（TRUNCATE 之后在线库同样是 0 字节）。
 *
 * 探测与 `VACUUM INTO` 走同一个连接：中间不留“确认后又被别人打开”的窗口。
 * 直接拷裸文件会漏掉 WAL 里的已提交内容，所以用 VACUUM INTO 复制到一个不存在的目标。
 * 目标不存在、目录可写、剩余空间够源库的 1.1 倍，才动手。
 */
export function backupDatabase(
  source: string,
  destination: string,
  options: BackupOptions = {},
): { bytes: number; schema_version: number } {
  let existing: ReturnType<typeof statSync> | null = null;
  try {
    existing = statSync(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existing !== null) throw new Error('destination_exists');
  let sourceBytes = 0;
  try {
    sourceBytes = statSync(source).size;
  } catch {
    throw new Error('source_unreadable');
  }
  const targetDir = dirname(destination);
  try {
    if (!statSync(targetDir).isDirectory()) throw new Error('not_a_directory');
  } catch {
    throw new Error('destination_unreadable');
  }
  const free = (options.freeBytes ?? defaultFreeBytes)(targetDir);
  if (free < Math.ceil(sourceBytes * BACKUP_SPACE_FACTOR)) throw new Error('insufficient_space');

  let version = 0;
  const db = new Database(source);
  try {
    // 独占模式必须在第一次读之前设，否则已经被共享模式打开过的连接不会再申请排他；
    // 下面第一个读取就是探测点。
    db.query('PRAGMA locking_mode=EXCLUSIVE').get();
    let journal: Record<string, unknown> | null = null;
    try {
      journal = db.query('PRAGMA journal_mode').get() as Record<string, unknown> | null;
      const versionRow = db.query('PRAGMA user_version').get() as Record<string, unknown> | null;
      version = versionRow === null ? 0 : Number(Object.values(versionRow)[0]);
    } catch (error) {
      if (isBusy(error)) throw new Error('source_must_be_stopped');
      throw error;
    }
    if (journal !== null && String(Object.values(journal)[0]) !== 'wal') throw new Error('source_not_wal');
    db.query('VACUUM INTO ?').run(destination);
  } catch (error) {
    if (error instanceof Error && (error.message === 'source_not_wal' || error.message === 'source_must_be_stopped')) {
      throw error;
    }
    throw new Error('source_unreadable');
  } finally {
    db.close();
  }
  chmodSync(destination, 0o600);
  const report = verifyDatabase(destination);
  if (report.integrity.length !== 1 || report.integrity[0] !== 'ok') {
    try {
      unlinkSync(destination);
    } catch {
      // 删不掉也要把错误抛出去。
    }
    throw new Error('backup_integrity_failed');
  }
  return { bytes: statSync(destination).size, schema_version: version };
}

/** 淘汰范围预览：默认路径不带副作用，先把要删的东西数清楚。 */
export function previewMetadataPurge(store: Store, beforeDay: string): PurgePreview {
  const row = store.read.query<{
    n: number; first_day: string | null; last_day: string | null; bytes: number | null;
  }, [string]>(`
    SELECT COUNT(*) AS n, MIN(day) AS first_day, MAX(day) AS last_day,
           IFNULL(SUM(IFNULL(body_bytes,0) + IFNULL(length(skeleton_z),0)),0) AS bytes
    FROM request WHERE day < ?`).get(beforeDay);
  return {
    requests: row?.n ?? 0,
    first_day: row?.first_day ?? null,
    last_day: row?.last_day ?? null,
    estimated_bytes: row?.bytes ?? 0,
  };
}

/**
 * 主动淘汰长期元数据。只有在 CLI 显式 `--apply --approval-id` 时才会被调用，
 * 不挂后台定时器。整个批次在一个事务里完成：
 *
 * 1. 先按目标证据删掉费用观测——证据行一旦删掉就再也定位不到这些观测；
 * 2. 记墓碑（事件 + 逐证据键），来源重放命中时计 purged_skip；
 * 3. 删指向目标的别名（按 new_id 选，不能按 old_id 猜范围）；
 * 4. 删 request；route_summary 只在没有别的请求引用时清。
 *
 * 外键是 NO ACTION，所以顺序错了会直接失败，不会静默留下悬空引用。
 */
export function purgeMetadata(store: Store, beforeDay: string, approvalId: string): PublishResult {
  if (typeof approvalId !== 'string' || approvalId.trim().length === 0) {
    throw new Error('approval_id_required');
  }
  return store.write(db => {
    db.exec('CREATE TEMP TABLE IF NOT EXISTS purge_requests(req_id INTEGER PRIMARY KEY)');
    db.exec('CREATE TEMP TABLE IF NOT EXISTS purge_routes(route_id INTEGER PRIMARY KEY)');
    db.run('DELETE FROM purge_requests');
    db.run('DELETE FROM purge_routes');
    db.run(
      'INSERT INTO purge_requests(req_id) SELECT req_id FROM request WHERE day < ?',
      [beforeDay],
    );
    db.run(`INSERT INTO purge_routes(route_id)
            SELECT DISTINCT route_id FROM request
            WHERE req_id IN (SELECT req_id FROM purge_requests) AND route_id IS NOT NULL`);

    const targets = db.query<{ n: number; first_day: string | null; last_day: string | null }, []>(
      'SELECT COUNT(*) AS n, MIN(day) AS first_day, MAX(day) AS last_day FROM request WHERE req_id IN (SELECT req_id FROM purge_requests)',
    ).get();
    const count = targets?.n ?? 0;
    if (count === 0) {
      db.run('DELETE FROM purge_requests');
      db.run('DELETE FROM purge_routes');
      return { deleted: 0, event_id: 0 };
    }
    const now = Date.now();

    // 1) 费用观测按目标证据的 ref_key 精确删除。
    db.run(`DELETE FROM cost_observation WHERE ref_key IN (
              SELECT ref_key FROM request_evidence WHERE req_id IN (SELECT req_id FROM purge_requests))`);
    // 2) 墓碑：重放时按证据键跳过。
    db.run(`INSERT OR IGNORE INTO purged_evidence(source_kind,ref_key,purged_at)
            SELECT source_kind, ref_key, ? FROM request_evidence
            WHERE req_id IN (SELECT req_id FROM purge_requests)`, [now]);
    const event = db.run(
      `INSERT INTO retention_event(at_ms,action,first_day,last_day,request_count,reason,approval_id)
       VALUES (?,'purge_metadata',?,?,?,'metadata_retention',?)`,
      [now, targets?.first_day ?? null, targets?.last_day ?? null, count, approvalId],
    );
    // 3) 其他引用先清掉，再删别名与请求。
    //    删行前先记下受影响的组：这些请求消失后，同组剩下的成员要重算链与增量。
    const affected = db.query<{ conv_key: string; actor: string }, []>(`
      SELECT DISTINCT conv_key, actor FROM request
      WHERE req_id IN (SELECT req_id FROM purge_requests)
        AND conv_key IS NOT NULL AND actor IS NOT NULL AND actor_state='known'`).all();
    db.run('DELETE FROM tool_call WHERE req_id IN (SELECT req_id FROM purge_requests)');
    db.run('DELETE FROM tool_call WHERE result_req IN (SELECT req_id FROM purge_requests)');
    db.run('DELETE FROM request_block WHERE req_id IN (SELECT req_id FROM purge_requests)');
    // 引用删掉后同步回收正文块：不留下没有引用的孤儿，也不把回收推给下一轮维护。
    db.run(`DELETE FROM block WHERE NOT EXISTS (
              SELECT 1 FROM request_block rb WHERE rb.block=block.id)`);
    db.run('DELETE FROM request_evidence WHERE req_id IN (SELECT req_id FROM purge_requests)');
    db.run('UPDATE request SET prev_req_id=NULL WHERE prev_req_id IN (SELECT req_id FROM purge_requests)');
    db.run('DELETE FROM request_alias WHERE new_id IN (SELECT req_id FROM purge_requests)');
    db.run('DELETE FROM request WHERE req_id IN (SELECT req_id FROM purge_requests)');
    // 4) 只清没有其他请求引用的路由摘要与原始路由。
    db.run(`DELETE FROM route_summary WHERE route_id IN (
              SELECT route_id FROM purge_routes
              WHERE NOT EXISTS (SELECT 1 FROM request q WHERE q.route_id=route_summary.route_id)
                AND NOT EXISTS (SELECT 1 FROM raw_ledger l WHERE l.route_id=route_summary.route_id))`);
    db.run('DELETE FROM purge_requests');
    db.run('DELETE FROM purge_routes');
    // 5) 被删请求所在的组少成员，链与增量要重算；已经空掉的组没有产物可算，直接完成。
    for (const group of affected) {
      const remaining = db.query<{ n: number }, [string, string]>(
        `SELECT COUNT(*) AS n FROM request
         WHERE conv_key=? AND actor=? AND actor_state='known'`).get(group.conv_key, group.actor)?.n ?? 0;
      if (remaining === 0) {
        // 空组同步成 clean：保留完成记录，不把它算成积压。
        db.run(
          `INSERT INTO derive_queue(conv_key,actor,from_sort,group_epoch,input_revision,
             published_revision,target_algorithm,state,dirty_since_ms)
           VALUES (?,?,'',?,0,0,1,'clean',NULL)
           ON CONFLICT(conv_key,actor) DO UPDATE SET state='clean',dirty_since_ms=NULL,
             published_revision=input_revision,published_algorithm=target_algorithm`,
          [group.conv_key, group.actor, randomUUID()],
        );
      } else {
        markGroupDirtyTx(db, group.conv_key, group.actor, '');
      }
    }
    return { deleted: count, event_id: Number(event.lastInsertRowid) };
  });
}

export type PurgedCheck = { skip: boolean };

/** 来源重放前先问一句：这条证据是不是已经被主动淘汰了。 */
export function isPurgedEvidence(db: Database, sourceKind: string, refKey: string): boolean {
  return db.query('SELECT 1 AS hit FROM purged_evidence WHERE source_kind=? AND ref_key=?')
    .get(sourceKind, refKey) !== null;
}

function parseArgs(argv: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (!token.startsWith('--')) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.set(token.slice(2), true);
    } else {
      flags.set(token.slice(2), next);
      index += 1;
    }
  }
  return flags;
}

function stringFlag(flags: Map<string, string | true>, name: string): string | null {
  const value = flags.get(name);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const USAGE = `usage:
  maintain verify --db <path>
  maintain backup --db <path> --out <new-path>
  maintain rebuild --db <path> --session <conv_key>
  maintain purge-metadata --db <path> --before <YYYY-MM-DD> [--apply --approval-id <id>]
`;

/**
 * CLI 入口。退出码：0 成功，1 失败，2 用法错误。
 * 所有命令先取维护锁；取不到就退出，不猜是不是自己上一次留下的。
 */
export async function runMaintenance(argv: string[], io: {
  out?: (line: string) => void;
  err?: (line: string) => void;
} = {}): Promise<number> {
  const out = io.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = io.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  const [command, ...rest] = argv;
  const flags = parseArgs(rest);
  const dbPath = stringFlag(flags, 'db');
  if (command === undefined || dbPath === null) {
    err(USAGE.trimEnd());
    return 2;
  }

  if (command === 'backup') {
    const destination = stringFlag(flags, 'out');
    if (destination === null) {
      err(USAGE.trimEnd());
      return 2;
    }
    const lock = acquireMaintenanceLock(dirname(dbPath), `backup:${process.pid}`);
    if (lock === null) {
      err('maintenance_lock_held');
      return 1;
    }
    try {
      const result = backupDatabase(dbPath, destination);
      out(JSON.stringify({ ok: true, ...result }));
      return 0;
    } catch (error) {
      err(`backup_failed:${error instanceof Error ? error.message : 'unknown'}`);
      return 1;
    } finally {
      lock.release();
    }
  }

  if (command === 'verify' || command === 'purge-metadata' || command === 'rebuild') {
    // verify 只读，不需要锁；purge 与 rebuild 写库，必须有。
    let store: Store | null = null;
    let lock: LockHandle | null = null;
    try {
      if (command === 'verify') {
        out(JSON.stringify({ ok: true, ...verifyDatabase(dbPath) }));
        return 0;
      }
      if (command === 'rebuild') {
        const session = stringFlag(flags, 'session');
        if (session === null) {
          err(USAGE.trimEnd());
          return 2;
        }
        lock = acquireMaintenanceLock(dirname(dbPath), `rebuild:${process.pid}`);
        if (lock === null) {
          err('maintenance_lock_held');
          return 1;
        }
        store = openStore(dbPath);
        const report = rebuildDerived(store, session);
        let drained: ReturnType<typeof drainDerive>;
        let recomputedRequests = 0;
        let retainedRequests = 0;
        // 只排空目标会话：其它会话的积压留给它自己的维护窗口。
        do {
          drained = drainDerive(store, 100, { convKey: session });
          recomputedRequests += drained.recomputed;
          retainedRequests += drained.retained;
          if (drained.remaining > 0 && drained.groups.length === 0) {
            throw new Error('derive_no_progress');
          }
        } while (drained.remaining > 0);
        const version = store.read.query<{ v: number | null }, [string]>(
          'SELECT MAX(derive_version) AS v FROM request WHERE conv_key=?').get(session);
        // 正文与 raw 都没了的分组只报告数量和原因，旧标题与工具关系保持原样。
        out(JSON.stringify({
          ok: true, session, queued: report.queued, unavailable: report.unavailable,
          reasons: report.reasons, derive_version: version?.v ?? 0,
          queue_remaining: drained.remaining,
          recomputed_requests: recomputedRequests, retained_requests: retainedRequests,
        }));
        return 0;
      }
      const before = stringFlag(flags, 'before');
      if (before === null || !/^\d{4}-\d{2}-\d{2}$/.test(before)) {
        err(USAGE.trimEnd());
        return 2;
      }
      lock = acquireMaintenanceLock(dirname(dbPath), `purge:${process.pid}`);
      if (lock === null) {
        err('maintenance_lock_held');
        return 1;
      }
      // 维护期间 collector 必须已停：写连接拿不到才说明没有别的进程在写。
      store = openStore(dbPath);
      const preview = previewMetadataPurge(store, before);
      if (flags.get('apply') !== true) {
        out(JSON.stringify({ ok: true, applied: false, before, ...preview }));
        return 0;
      }
      const approvalId = stringFlag(flags, 'approval-id');
      if (approvalId === null) {
        out(JSON.stringify({ ok: false, error: 'approval_id_required', before, ...preview }));
        return 1;
      }
      const result = purgeMetadata(store, before, approvalId);
      out(JSON.stringify({ ok: true, applied: true, before, approval_id: approvalId, ...result }));
      return 0;
    } catch (error) {
      err(`${command}_failed:${error instanceof Error ? error.message : 'unknown'}`);
      return 1;
    } finally {
      store?.close();
      lock?.release();
    }
  }

  err(USAGE.trimEnd());
  return 2;
}

if (import.meta.main) {
  const code = await runMaintenance(process.argv.slice(2));
  process.exit(code);
}
