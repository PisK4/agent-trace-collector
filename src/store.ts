import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type WriteStats = { count: number; total_ms: number; max_ms: number };

export type Store = {
  db: Database;
  read: Database;
  write<T>(fn: (db: Database) => T): T;
  /** 进程内所有写事务的累计计时；失败与回滚同样计数。 */
  writeStats: WriteStats;
  close(): void;
};

const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const SCHEMA_V6 = readFileSync(new URL('./schema-v6.sql', import.meta.url), 'utf8');
const SCHEMA_VERSION = 6;

function tableNames(db: Database): string[] {
  return (db.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as { name: string }[]).map(row => row.name);
}

function pragmaNumber(db: Database, name: string): number {
  const row = db.query(`PRAGMA ${name}`).get() as Record<string, number> | null;
  return row === null ? Number.NaN : Number(Object.values(row)[0]);
}

function migrate(db: Database): void {
  const version = pragmaNumber(db, 'user_version');
  const tables = tableNames(db);
  if (version === 0 && tables.length === 0) {
    db.exec('PRAGMA auto_vacuum=INCREMENTAL');
    db.exec('PRAGMA journal_mode=WAL');
    db.transaction(() => {
      db.exec(SCHEMA);
      db.exec(SCHEMA_V6);
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    }).immediate();
    return;
  }
  if (version === 0) throw new Error('schema_unknown');
  if (version > SCHEMA_VERSION) throw new Error('schema_version_unsupported');
  // 低版本没有升级路径：普通启动不做 ALTER，也不搬旧数据。旧库由运维显式删除后重建，
  // 这条拒绝是唯一的处理方式，不提供半迁移状态。
  if (version < SCHEMA_VERSION) throw new Error('schema_rebuild_required');
  if (pragmaNumber(db, 'auto_vacuum') !== 2) throw new Error('auto_vacuum_requires_migration');
}

export function openStore(path: string): Store {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Ownership or filesystem limits can reject chmod; open still validates the database below.
  }

  const db = new Database(path, { create: true });
  try {
    chmodSync(path, 0o600);
  } catch {
    // See the directory note above.
  }

  try {
    migrate(db);
  } catch (error) {
    // 版本校验失败时关闭写连接，否则调用方重试会撞上一个已打开的库。
    db.close();
    throw error;
  }
  db.exec('PRAGMA journal_mode=WAL');
  // 切到 WAL 不等于文件已就位：第一次写事务之前不会创建 -wal/-shm，
  // 而只读连接打不开这两个文件缺失的库（SQLITE_CANTOPEN）。
  // 开一个空写事务把它们落下来，否则“打开一个没有新写入的旧库”时只读连接会直接失败。
  db.exec('BEGIN IMMEDIATE');
  db.exec('ROLLBACK');
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('PRAGMA busy_timeout=1000');

  if (pragmaNumber(db, 'auto_vacuum') !== 2) throw new Error('auto_vacuum_not_incremental');
  if (String(Object.values(db.query('PRAGMA journal_mode').get() as Record<string, unknown>)[0]) !== 'wal') {
    throw new Error('wal_not_enabled');
  }
  if (pragmaNumber(db, 'synchronous') !== 1) throw new Error('synchronous_not_normal');
  if (pragmaNumber(db, 'foreign_keys') !== 1) throw new Error('foreign_keys_not_enabled');

  const read = new Database(path, { readonly: true });
  read.exec('PRAGMA query_only=ON');
  read.exec('PRAGMA busy_timeout=1000');

  let closed = false;
  const writeStats: WriteStats = { count: 0, total_ms: 0, max_ms: 0 };
  const write = <T>(fn: (db: Database) => T): T => {
    const started = performance.now();
    try {
      return db.transaction(() => {
        const result = fn(db);
        if (result instanceof Promise) throw new TypeError('async writer');
        return result;
      }).immediate();
    } finally {
      // 失败事务也计入：回滚与锁等待同样占用写通道。
      const elapsed = performance.now() - started;
      writeStats.count += 1;
      writeStats.total_ms += elapsed;
      writeStats.max_ms = Math.max(writeStats.max_ms, elapsed);
    }
  };

  return {
    db,
    read,
    write,
    writeStats,
    close() {
      if (closed) return;
      closed = true;
      read.close();
      db.close();
    },
  };
}
