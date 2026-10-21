import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type Store = {
  db: Database;
  read: Database;
  write<T>(fn: (db: Database) => T): T;
  close(): void;
};

const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const SCHEMA_VERSION = 3;

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
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    }).immediate();
    return;
  }
  if (version === 0) throw new Error('schema_unknown');
  if (version > SCHEMA_VERSION) throw new Error('schema_version_unsupported');
  // v3 改了块指纹与摘要列，没有原地升级路径：旧库里的派生结果本身就不可信，
  // 就地改写只会把错误固化下来。要求删库重建，由来源重放补齐。
  if (version < SCHEMA_VERSION) throw new Error('schema_rebuild_required');
  const requestSql = db.query(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='request'",
  ).get() as { sql: string } | null;
  if (requestSql === null || !/AUTOINCREMENT/i.test(requestSql.sql)) {
    throw new Error('legacy_request_primary_key');
  }
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

  migrate(db);
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
  const write = <T>(fn: (db: Database) => T): T => db.transaction(() => {
    const result = fn(db);
    if (result instanceof Promise) throw new TypeError('async writer');
    return result;
  }).immediate();

  return {
    db,
    read,
    write,
    close() {
      if (closed) return;
      closed = true;
      read.close();
      db.close();
    },
  };
}
