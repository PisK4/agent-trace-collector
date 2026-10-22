import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { conservationDigest } from './conservation';
import { readMigrationState } from './migrate-v5';
import type { MigrationState } from './migrate-v5';

export type Store = {
  db: Database;
  read: Database;
  write<T>(fn: (db: Database) => T): T;
  close(): void;
};

const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const SCHEMA_VERSION = 5;

function tableNames(db: Database): string[] {
  return (db.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as { name: string }[]).map(row => row.name);
}

function pragmaNumber(db: Database, name: string): number {
  const row = db.query(`PRAGMA ${name}`).get() as Record<string, number> | null;
  return row === null ? Number.NaN : Number(Object.values(row)[0]);
}

export type OpenOptions = { allowIncompleteMigration?: boolean };

function migrate(db: Database, options: OpenOptions): void {
  const version = pragmaNumber(db, 'user_version');
  const tables = tableNames(db);
  if (version === 0 && tables.length === 0) {
    db.exec('PRAGMA auto_vacuum=INCREMENTAL');
    db.exec('PRAGMA journal_mode=WAL');
    db.transaction(() => {
      db.exec(SCHEMA);
      // 新库直接是完整的 v5：标记与建表同事务，不存在"结构有、标记无"的中间态。
      const state: MigrationState = {
        format: 1, target: 5, phase: 'complete', cursor: null, scope: 'all', complete: true,
        baseline: conservationDigest(db),
        report: { scanned: 0, remapped: 0, projected: 0 },
      };
      db.run("INSERT INTO collector_state(key,value_json) VALUES ('migration:v5',?)",
        [JSON.stringify(state)]);
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    }).immediate();
    return;
  }
  if (version === 0) throw new Error('schema_unknown');
  if (version > SCHEMA_VERSION) throw new Error('schema_version_unsupported');
  // 低版本没有原地升级路径：普通启动不做 ALTER，也不假装列已经补上。
  // v4→v5 只能由显式迁移脚本执行，未完成时拒绝启动。
  if (version < SCHEMA_VERSION) throw new Error('schema_rebuild_required');
  // v5 之后结构存在不等于迁移完成：普通启动只认 complete=true，
  // 未完成的库必须由显式迁移续跑，否则在线写入会往半迁移数据上追加事实。
  const state = readMigrationState(db);
  if (!state.complete && options.allowIncompleteMigration !== true) {
    throw new Error('migration_incomplete');
  }
  const requestSql = db.query(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='request'",
  ).get() as { sql: string } | null;
  if (requestSql === null || !/AUTOINCREMENT/i.test(requestSql.sql)) {
    throw new Error('legacy_request_primary_key');
  }
  if (pragmaNumber(db, 'auto_vacuum') !== 2) throw new Error('auto_vacuum_requires_migration');
}

export function openStore(path: string, options: OpenOptions = {}): Store {
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
    migrate(db, options);
  } catch (error) {
    // 迁移或标记校验失败时关闭写连接，否则调用方重试会撞上一个已打开的库。
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
