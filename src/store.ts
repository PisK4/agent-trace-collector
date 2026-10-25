import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SliceRuntime } from './config';

export type WriteStats = { count: number; total_ms: number; max_ms: number };

/**
 * 正文当前能否读取。`body_state` 与 `have` 分开：`have` 表示收到过哪几路证据，
 * 回收不能把收到过改写成没收到；这个值表示正文现在还在不在。
 */
export type BodyState = 'pending' | 'available' | 'partial' | 'evicted' | 'unsupported' | 'summary';

/**
 * 请求身份的别名解析：旧 id 沿 `request_alias` 走到没有别名为止，再确认存在。
 *
 * 合并请求时旧 id 在这里登记；读侧（HTTP 路由、正文恢复）只认规范 id，
 * 旧链接经过这一步落到同一行。环与自引用按 null 处理，不抛错也不死循环。
 */
export function resolveRequestId(store: Store, id: number): number | null {
  const seen = new Set<number>();
  let current = id;
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const alias = store.read.query<{ new_id: number }, [number]>(
      'SELECT new_id FROM request_alias WHERE old_id=?',
    ).get(current);
    if (alias != null) {
      current = alias.new_id;
      continue;
    }
    const exists = store.read.query<{ req_id: number }, [number]>(
      'SELECT req_id FROM request WHERE req_id=?',
    ).get(current);
    return exists != null ? current : null;
  }
}

export type Store = {
  /** 库文件路径。切片路径要按它量 WAL 增长，不再从配置里拼一次。 */
  path: string;
  db: Database;
  read: Database;
  write<T>(fn: (db: Database) => T, name?: string): T;
  /** 进程内写事务累计计时与归属；失败与回滚同样计数。 */
  writeStats: WriteStats & { by_name: Record<string, WriteStats> };
  /**
   * 派生按哪条路径跑：设了就是切片，没设就是同步。
   *
   * 模式的落点只有这一个字段，预算也在里面：分成"模式标志 + 预算 + 路径"三个
   * 字段存，运行期迟早会出现三者互相不一致的组合。
   */
  deriveRuntime?: SliceRuntime;
  close(): void;
};

/** 同步准备只读意图；null 不开事务，返回的写函数立即在唯一 writer 内提交。 */
export function commitUnit<T>(store: Store, name: string,
  prepare: (read: Database) => ((db: Database) => T) | null): T | null {
  const intent = prepare(store.read);
  return intent === null ? null : store.write(intent, name);
}

const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const SCHEMA_V6 = readFileSync(new URL('./schema-v6.sql', import.meta.url), 'utf8');
const SCHEMA_V7 = readFileSync(new URL('./schema-v7.sql', import.meta.url), 'utf8');
const SCHEMA_VERSION = 7;

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
      db.exec(SCHEMA_V7);
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    }).immediate();
    return;
  }
  if (version === 0) throw new Error('schema_unknown');
  if (version > SCHEMA_VERSION) throw new Error('schema_version_unsupported');
  // v6→v7 是纯新增（OTLP 原始层表），原地执行即可；更低的库没有升级路径：
  // 普通启动不做 ALTER，也不搬旧数据，旧库由运维显式删除后重建。
  if (version === 6) {
    db.transaction(() => {
      db.exec(SCHEMA_V7);
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    }).immediate();
  } else if (version < SCHEMA_VERSION) {
    throw new Error('schema_rebuild_required');
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
  const writeStats: Store['writeStats'] = { count: 0, total_ms: 0, max_ms: 0, by_name: {} };
  const write = <T>(fn: (db: Database) => T, name = 'other'): T => {
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
      const named = writeStats.by_name[name] ?? { count: 0, total_ms: 0, max_ms: 0 };
      named.count += 1;
      named.total_ms += elapsed;
      named.max_ms = Math.max(named.max_ms, elapsed);
      writeStats.by_name[name] = named;
    }
  };

  return {
    path,
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
