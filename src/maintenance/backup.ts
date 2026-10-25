/** 备份与恢复：独占探测、VACUUM INTO 复制、可恢复 bundle 与恢复校验。 */

import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, statfsSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { readLocalSecret, saltId } from '../config';
import { acquireMaintenanceLock } from './lock';
import { verifyDatabase } from './verify';

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
/** 可恢复的 schema 版本：v6 包恢复后首次打开会原地升到当前版本（v7 纯新增）。 */
export const RESTORABLE_SCHEMA_VERSIONS: readonly number[] = [6, 7];

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
