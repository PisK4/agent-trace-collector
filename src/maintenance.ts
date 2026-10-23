import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readSync, readdirSync, renameSync, rmdirSync, rmSync, statfsSync, statSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { openStore } from './store';
import type { Store } from './store';
import { rebuildDerived } from './derive';
import { drainDeriveEntry } from './derive-slice';
import { upgradePurposeTargetTx } from './request-purpose';
import { GROUP_ALGORITHM, markGroupDirtyTx, queuePendingSql } from './derive-state';
import { readLocalSecret, saltId } from './config';

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
    const pending = db.query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM derive_queue WHERE ${queuePendingSql()}`).get();
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
 * 在"已确认没有别的连接"的前提下打开源库，交给调用方一次。
 *
 * 探测与调用方的工作走同一个连接：先探测、关掉、再重新打开会留出一个
 * "确认之后又被人打开"的窗口，那样备份出来的东西与探测结果无关。
 *
 * `locking_mode=EXCLUSIVE` 必须在第一次读之前设：已经被共享模式打开过的连接
 * 不会再申请排他。下面第一次读就是探测点。
 */
export function withStoppedDatabase<T>(source: string, fn: (db: Database) => T): T {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(source);
  } catch {
    throw new Error('source_unreadable');
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('source_unreadable');
  // 必须显式给读写模式：只给 `create:false` 时 Bun 不肯打开任何库（SQLITE_MISUSE）。
  // 文件不存在也不许建，所以 create 仍然关掉。
  let db: Database;
  try {
    db = new Database(source, { readwrite: true, create: false });
  } catch {
    throw new Error('source_unreadable');
  }
  try {
    db.query('PRAGMA locking_mode=EXCLUSIVE').get();
    let journal: Record<string, unknown> | null = null;
    try {
      journal = db.query('PRAGMA journal_mode').get() as Record<string, unknown> | null;
      db.query('SELECT COUNT(*) FROM sqlite_schema').get();
    } catch (error) {
      if (isBusy(error)) throw new Error('source_must_be_stopped');
      // 探测只做两件事：别的连接开着是 busy，剩下的只可能是文件不是库。
      throw new Error('source_unreadable');
    }
    if (journal !== null && String(Object.values(journal)[0]) !== 'wal') throw new Error('source_not_wal');
    return fn(db);
  } finally {
    db.close();
  }
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
 *
 * 这是只含数据库的备份：它不含脱敏盐与令牌，不能当作可恢复的采集快照；
 * 要能恢复，用 `backupBundle`。
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
  try {
    version = withStoppedDatabase(source, db => {
      const versionRow = db.query('PRAGMA user_version').get() as Record<string, unknown> | null;
      const found = versionRow === null ? 0 : Number(Object.values(versionRow)[0]);
      db.query('VACUUM INTO ?').run(destination);
      return found;
    });
  } catch (error) {
    if (error instanceof Error && (error.message === 'source_not_wal' || error.message === 'source_must_be_stopped')) {
      throw error;
    }
    throw new Error('source_unreadable');
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

/**
 * 可恢复 bundle 接受的库结构版本。
 *
 * 备份与恢复都只查这一处：加一个版本就是在这里加一个数字，不另写第二份版本规则。
 */
/** 可搬运的 schema 版本。只有当前版本：低版本没有升级路径，搬回来也打不开。 */
export const RESTORABLE_SCHEMA_VERSIONS: readonly number[] = [6];

const BUNDLE_FILES = ['trace.db', 'redaction.salt', 'manifest.json'] as const;

/** 目录必须私有：0700、不是符号链接、属于当前用户。 */
function requirePrivateDirectory(path: string): void {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch {
    throw new Error('directory_permissions');
  }
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error('directory_permissions');
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error('directory_permissions');
  }
}

/**
 * 把 staging 目录发布到目标位置，绝不覆盖已存在的目录。
 *
 * 先 `mkdir` 原子地占住目标名（已存在就失败），再把本进程刚建的空目录换掉。
 * `rename` 落在同名空目录上是允许的，但两步之间目标可能被别人换过，
 * 所以换之前比对 inode 与设备号；失败时只移除自己创建且仍为空的保留目录。
 */
function publishPrivateDirectory(staging: string, destination: string): void {
  requirePrivateDirectory(dirname(destination));
  try {
    mkdirSync(destination, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('destination_exists');
    throw error;
  }
  const reserved = lstatSync(destination);
  try {
    const current = lstatSync(destination);
    if (current.ino !== reserved.ino || current.dev !== reserved.dev) {
      throw new Error('destination_changed');
    }
    renameSync(staging, destination);
  } catch (error) {
    try {
      const current = lstatSync(destination);
      if (current.ino === reserved.ino && current.dev === reserved.dev) rmdirSync(destination);
    } catch {
      // 保留目录已不在或判断不了：原错误才是要报告的。
    }
    throw error;
  }
}

/** 按 64 KiB 流式求数据库文件的 SHA-256；恢复时要拿它与清单比对。 */
function hashDatabase(path: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  const fd = openSync(path, 'r');
  try {
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      hash.update(buffer.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/** 完整性只认一条 `ok`；打不开或不是库都算不过，而不是把原始 SQLite 错误漏出去。 */
function integrityOk(path: string): boolean {
  try {
    const report = verifyDatabase(path);
    return report.integrity.length === 1 && report.integrity[0] === 'ok';
  } catch {
    return false;
  }
}

function bindingIdOf(valueJson: string): string {
  let saved: unknown;
  try {
    saved = JSON.parse(valueJson);
  } catch {
    throw new Error('redaction_salt_binding_invalid');
  }
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)
    || (saved as { format?: unknown }).format !== 1
    || typeof (saved as { id?: unknown }).id !== 'string') {
    throw new Error('redaction_salt_binding_invalid');
  }
  return (saved as { id: string }).id;
}

/**
 * 可恢复备份：数据库 + 脱敏盐 + 清单，三者一起原子发布。
 *
 * 只含数据库的 `backupDatabase` 恢复不了占位符——盐不在里面。这里把盐一起带走，
 * 并用清单把"这份库配这份盐"固定下来：恢复前校验清单、哈希、盐标识与完整性。
 *
 * 读盐与校验绑定都发生在独占连接仍然打开的时候：先确认库已停、再放掉这个约束
 * 去读盐，中间就留出了盐文件被替换的窗口。
 */
export function backupBundle(sourceDir: string, destinationDir: string): void {
  if (existsSync(destinationDir)) throw new Error('destination_exists');
  const lock = acquireMaintenanceLock(sourceDir, `bundle:${process.pid}`);
  if (lock === null) throw new Error('maintenance_lock_held');
  let staging: string | null = null;
  try {
    requirePrivateDirectory(sourceDir);
    requirePrivateDirectory(dirname(destinationDir));
    let sourceBytes: number;
    try {
      sourceBytes = statSync(join(sourceDir, 'trace.db')).size;
    } catch {
      throw new Error('source_unreadable');
    }
    const needed = Math.ceil(sourceBytes * BACKUP_SPACE_FACTOR) + 4096;
    if (defaultFreeBytes(dirname(destinationDir)) < needed) throw new Error('insufficient_space');
    staging = mkdtempSync(join(dirname(destinationDir), '.atc-bundle-'));
    chmodSync(staging, 0o700);
    const target = staging;
    withStoppedDatabase(join(sourceDir, 'trace.db'), db => {
      let salt: Uint8Array;
      try {
        salt = readLocalSecret(join(sourceDir, 'redaction.salt'));
      } catch {
        throw new Error('redaction_salt_missing');
      }
      const raw = db.query<{ value_json: string }, []>(
        "SELECT value_json FROM collector_state WHERE key='privacy:salt'").get();
      // 库里的绑定与盘上的盐必须是一对，否则这个包恢复出来解释不了任何占位符。
      if (raw === null || bindingIdOf(raw.value_json) !== saltId(salt)) {
        throw new Error('redaction_salt_mismatch');
      }
      const schemaRow = db.query('PRAGMA user_version').get() as { user_version: number } | null;
      const schema = schemaRow?.user_version ?? 0;
      if (!RESTORABLE_SCHEMA_VERSIONS.includes(schema)) throw new Error('backup_schema_unsupported');
      const path = join(target, 'trace.db');
      db.query('VACUUM INTO ?').run(path);
      chmodSync(path, 0o600);
      writeFileSync(join(target, 'redaction.salt'), salt, { flag: 'wx', mode: 0o600 });
      writeFileSync(join(target, 'manifest.json'), JSON.stringify({
        format: 1, schema, salt_id: saltId(salt), database_sha256: hashDatabase(path),
      }), { flag: 'wx', mode: 0o600 });
    });
    if (!integrityOk(join(target, 'trace.db'))) {
      throw new Error('backup_integrity_failed');
    }
    publishPrivateDirectory(target, destinationDir);
    staging = null;
  } catch (error) {
    if (staging !== null) rmSync(staging, { recursive: true, force: true });
    throw error;
  } finally {
    lock.release();
  }
}

/**
 * 从 bundle 恢复到新目录。目标已存在就拒绝，任何一步校验不过都不留下半套目录。
 *
 * 校验顺序：目录内容与权限 → 清单格式与版本 → 盐标识 → 数据库哈希 → 复制到 staging
 * → 再校验哈希与完整性 → 包内库自身的版本与盐绑定 → 发布。
 * 清单是自述，包内数据库是事实；两者对不上就不发布。
 *
 * 认证令牌不随包走：恢复后的库要在新目录里按显式重配流程生成 `read.token` 与 `hook.token`。
 */
export function restoreBundle(bundleDir: string, destinationDir: string): void {
  if (existsSync(destinationDir)) throw new Error('destination_exists');
  requirePrivateDirectory(bundleDir);
  requirePrivateDirectory(dirname(destinationDir));
  // 只认这三个文件：多出来的东西说明这个目录不是本工具写的包，不猜。
  if (JSON.stringify(readdirSync(bundleDir).sort()) !== JSON.stringify([...BUNDLE_FILES].sort())) {
    throw new Error('restore_bundle_invalid');
  }
  for (const name of BUNDLE_FILES) {
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(join(bundleDir, name));
    } catch {
      throw new Error('restore_bundle_invalid');
    }
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw new Error('restore_bundle_permissions');
    }
  }
  let manifest: { format: number; schema: number; salt_id: string; database_sha256: string };
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('restore_bundle_invalid');
    }
    manifest = parsed as typeof manifest;
  } catch {
    throw new Error('restore_bundle_invalid');
  }
  let salt: Uint8Array;
  try {
    salt = readLocalSecret(join(bundleDir, 'redaction.salt'));
  } catch {
    throw new Error('restore_bundle_permissions');
  }
  if (manifest.format !== 1
    || !RESTORABLE_SCHEMA_VERSIONS.includes(manifest.schema)
    || manifest.salt_id !== saltId(salt)
    || manifest.database_sha256 !== hashDatabase(join(bundleDir, 'trace.db'))) {
    throw new Error('restore_bundle_invalid');
  }
  const bytes = statSync(join(bundleDir, 'trace.db')).size;
  const needed = Math.ceil(bytes * BACKUP_SPACE_FACTOR) + 4096;
  if (defaultFreeBytes(dirname(destinationDir)) < needed) throw new Error('insufficient_space');
  const staging = mkdtempSync(join(dirname(destinationDir), '.atc-restore-'));
  chmodSync(staging, 0o700);
  try {
    for (const name of BUNDLE_FILES) {
      copyFileSync(join(bundleDir, name), join(staging, name), constants.COPYFILE_EXCL);
      chmodSync(join(staging, name), 0o600);
    }
    if (hashDatabase(join(staging, 'trace.db')) !== manifest.database_sha256
      || !integrityOk(join(staging, 'trace.db'))) {
      throw new Error('restore_bundle_invalid');
    }
    const snapshot = new Database(join(staging, 'trace.db'), { readonly: true });
    try {
      const row = snapshot.query<{ value_json: string }, []>(
        "SELECT value_json FROM collector_state WHERE key='privacy:salt'").get();
      if (row === null) throw new Error('restore_bundle_invalid');
      if (bindingIdOf(row.value_json) !== saltId(salt)) throw new Error('redaction_salt_mismatch');
      const bundledRow = snapshot.query('PRAGMA user_version').get() as { user_version: number } | null;
      const bundled = bundledRow?.user_version ?? 0;
      // 清单不能只靠自述：包内数据库自身的版本必须与清单一致。
      if (bundled !== manifest.schema) throw new Error('restore_bundle_invalid');
    } finally {
      snapshot.close();
    }
    publishPrivateDirectory(staging, destinationDir);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
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
  maintain bundle --dir <dataDir> --out <new-dir>
  maintain restore --bundle <bundleDir> --out <new-dir>
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

  // bundle 与 restore 的路径参数是数据目录，不是库文件；单独解析，避免把 --db 的语义混进来。
  if (command === 'bundle' || command === 'restore') {
    const source = stringFlag(flags, command === 'bundle' ? 'dir' : 'bundle');
    const destination = stringFlag(flags, 'out');
    if (source === null || destination === null) {
      err(USAGE.trimEnd());
      return 2;
    }
    try {
      if (command === 'bundle') {
        backupBundle(source, destination);
        out(JSON.stringify({ ok: true, bundle: destination }));
      } else {
        restoreBundle(source, destination);
        out(JSON.stringify({ ok: true, restored: destination }));
      }
      return 0;
    } catch (error) {
      err(`${command}_failed:${error instanceof Error ? error.message : 'unknown'}`);
      return 1;
    }
  }

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
      // 只含数据库：没有盐，恢复不了占位符连续性。别让调用方把这个结果当成可恢复快照。
      out(JSON.stringify({ ok: true, ...result, ingestion_restorable: false }));
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
        // 显式重建是唯一升级历史用途目标的入口：把目标会话里旧目标的行重新
        // 排进用途阶段，再按当前规则重算；普通 tick 不碰已结算的 clean 行。
        const purposeUpgraded = store.write(db => upgradePurposeTargetTx(db, session));
        const report = rebuildDerived(store, session);
        let drained: ReturnType<typeof drainDeriveEntry>;
        let recomputedRequests = 0;
        let retainedRequests = 0;
        let purposeProcessed = 0;
        // 只排空目标会话：其它会话的积压留给它自己的维护窗口。
        // 两个阶段都要排空：组没算完是积压，请求用途没判完也是——组的输入依赖用途。
        do {
          drained = drainDeriveEntry(store, 100, { convKey: session });
          recomputedRequests += drained.recomputed;
          retainedRequests += drained.retained;
          purposeProcessed += drained.purpose_processed;
          if ((drained.remaining > 0 || drained.purpose_remaining > 0)
            && drained.groups.length === 0 && drained.purpose_processed === 0) {
            throw new Error('derive_no_progress');
          }
        } while (drained.remaining > 0 || drained.purpose_remaining > 0);
        const version = store.read.query<{ v: number | null }, [string]>(
          'SELECT MAX(derive_version) AS v FROM request WHERE conv_key=?').get(session);
        // 目标版本、实际算法分布与保留行分开报告：`derive_version` 已经不再逐次累加，
        // 拿它的 MAX 当"当前算法"会把保留行误报成最新。
        const algorithms = store.read.query<{ algorithm: number | null; n: number }, [string]>(`
          SELECT summary_algorithm AS algorithm, COUNT(*) AS n FROM request
          WHERE conv_key=? AND summary_state='recomputed'
          GROUP BY summary_algorithm ORDER BY summary_algorithm`).all(session);
        const actualAlgorithms: Record<string, number> = {};
        for (const row of algorithms) actualAlgorithms[String(row.algorithm ?? 'legacy')] = row.n;
        const legacy = store.read.query<{ n: number }, [string]>(`
          SELECT COUNT(*) AS n FROM request WHERE conv_key=? AND summary_state='legacy'`).get(session)?.n ?? 0;
        const pending = store.read.query<{ n: number }, [string]>(`
          SELECT COUNT(*) AS n FROM derive_queue WHERE conv_key=? AND ${queuePendingSql()}`).get(session)?.n ?? 0;
        // 正文与 raw 都没了的分组只报告数量和原因，旧标题与工具关系保持原样。
        out(JSON.stringify({
          ok: true, session, queued: report.queued, unavailable: report.unavailable,
          reasons: report.reasons, derive_version: version?.v ?? 0,
          queue_remaining: drained.remaining, purpose_remaining: drained.purpose_remaining,
          purpose_processed: purposeProcessed, purpose_upgraded: purposeUpgraded,
          recomputed_requests: recomputedRequests, retained_requests: retainedRequests,
          target_algorithm: GROUP_ALGORITHM, actual_algorithms: actualAlgorithms,
          legacy_requests: legacy, pending_groups: pending,
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
