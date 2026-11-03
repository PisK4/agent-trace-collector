import { Database } from 'bun:sqlite';
import type { Statement } from 'bun:sqlite';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SliceRuntime } from './config';

/**
 * 写事务的语句级拆分（进程内累计），只对长事务排查的写路径记（见 `TIMED_WRITES`）。
 * `read_ms`/`write_ms` 是语句自身耗时，`fn_ms` 是事务体内总耗时，
 * `txn_ms` 是事务开合（含等锁与提交）；`fn_ms` 减掉两条语句耗时就是纯计算。
 */
export type SqlSplit = {
  read_ms: number; write_ms: number; fn_ms: number; txn_ms: number;
  reads: number; writes: number;
};

export type WriteStats = {
  count: number; total_ms: number; max_ms: number;
  /** 语句级拆分累计；不计时的写路径没有这个字段。 */
  sql?: SqlSplit;
};

/**
 * 做语句级计时的写路径。派生组事务一次可跑十几秒，要分清那段时间花在
 * SQL 还是计算上；其余写路径都是短事务，不引入代理开销。
 */
const TIMED_WRITES = new Set(['derive']);

function timedCall<T>(kind: 'read' | 'write', split: SqlSplit, run: () => T): T {
  const started = performance.now();
  try {
    return run();
  } finally {
    const elapsed = performance.now() - started;
    if (kind === 'read') {
      split.read_ms += elapsed;
      split.reads += 1;
    } else {
      split.write_ms += elapsed;
      split.writes += 1;
    }
  }
}

/** 语句代理：读方法按读计时，`run` 按写计时；其余方法原样绑定。 */
function timedStatement(statement: Statement, split: SqlSplit): Statement {
  return new Proxy(statement, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') return value;
      if (property === 'get' || property === 'all' || property === 'values') {
        return (...args: unknown[]) =>
          timedCall('read', split, () => (value as (...rest: unknown[]) => unknown).apply(target, args));
      }
      if (property === 'run') {
        return (...args: unknown[]) =>
          timedCall('write', split, () => (value as (...rest: unknown[]) => unknown).apply(target, args));
      }
      return (value as (...rest: unknown[]) => unknown).bind(target);
    },
  }) as Statement;
}

function timedDatabase(db: Database, split: SqlSplit): Database {
  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') return value;
      if (property === 'query' || property === 'prepare') {
        return (...args: unknown[]) =>
          timedStatement((value as (...rest: unknown[]) => Statement).apply(target, args), split);
      }
      if (property === 'run' || property === 'exec') {
        return (...args: unknown[]) =>
          timedCall('write', split, () => (value as (...rest: unknown[]) => unknown).apply(target, args));
      }
      return (value as (...rest: unknown[]) => unknown).bind(target);
    },
  }) as Database;
}

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
const SCHEMA_V8 = readFileSync(new URL('./schema-v8.sql', import.meta.url), 'utf8');
const SCHEMA_V9 = readFileSync(new URL('./schema-v9.sql', import.meta.url), 'utf8');
const SCHEMA_V10 = readFileSync(new URL('./schema-v10.sql', import.meta.url), 'utf8');
const SCHEMA_VERSION = 10;

function tableNames(db: Database): string[] {
  return (db.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as { name: string }[]).map(row => row.name);
}

function pragmaNumber(db: Database, name: string): number {
  const row = db.query(`PRAGMA ${name}`).get() as Record<string, number> | null;
  return row === null ? Number.NaN : Number(Object.values(row)[0]);
}

/**
 * 执行 v9 的加列脚本，列已存在时跳过。
 *
 * SQLite 的 `ALTER TABLE ADD COLUMN` 没有 `IF NOT EXISTS`；重复执行报
 * duplicate column。升级路径因此先查列，半迁移状态与从旧包恢复的库都能重跑，
 * 不会因为一次失败的启动把库锁在打不开的状态。
 */
function execAdditiveV9(db: Database): void {
  const columns = (db.query('PRAGMA table_info(derive_queue)').all() as { name: string }[])
    .map(row => row.name);
  if (!columns.includes('claim_from_sort')) db.exec(SCHEMA_V9);
}

function execAdditiveV10(db: Database): void {
  const columns = (db.query('PRAGMA table_info(request)').all() as { name: string }[])
    .map(row => row.name);
  if (!columns.includes('user_fingerprint') && !columns.includes('turn_ref')) {
    db.exec(SCHEMA_V10);
  } else {
    if (!columns.includes('user_fingerprint')) {
      db.exec('ALTER TABLE request ADD COLUMN user_fingerprint TEXT');
    }
    if (!columns.includes('turn_ref')) {
      db.exec('ALTER TABLE request ADD COLUMN turn_ref TEXT');
    }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS i_request_user_fingerprint
    ON request(user_fingerprint) WHERE user_fingerprint IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS i_request_turn_ref
    ON request(turn_ref) WHERE turn_ref IS NOT NULL`);
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
      db.exec(SCHEMA_V8);
      db.exec(SCHEMA_V9);
      execAdditiveV10(db);
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    }).immediate();
    return;
  }
  if (version === 0) throw new Error('schema_unknown');
  if (version > SCHEMA_VERSION) {
    throw new Error(`schema_version_unsupported: db v${version} > code v${SCHEMA_VERSION}`);
  }
  // v6→v10、v7→v10、v8→v10 与 v9→v10 都是纯新增（OTLP 原始层表、部分反向
  // 索引、队列的 claim_from_sort 列、请求的内容指纹与 turn 身份），原地执行
  // 即可；更低的库没有升级路径：普通启动不做 ALTER，也不搬旧数据，旧库由
  // 运维显式删除后重建。索引在存量数据上的构建耗时随历史线性增长，属于启动
  // 契约的一部分，见 docs/operations.md 的 schema 升级一节。
  if (version === 6) {
    db.transaction(() => {
      db.exec(SCHEMA_V7);
      db.exec(SCHEMA_V8);
      execAdditiveV9(db);
      execAdditiveV10(db);
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    }).immediate();
  } else if (version === 7) {
    db.transaction(() => {
      db.exec(SCHEMA_V8);
      execAdditiveV9(db);
      execAdditiveV10(db);
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    }).immediate();
  } else if (version === 8) {
    db.transaction(() => {
      execAdditiveV9(db);
      execAdditiveV10(db);
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    }).immediate();
  } else if (version === 9) {
    db.transaction(() => {
      execAdditiveV10(db);
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    }).immediate();
  } else if (version < SCHEMA_VERSION) {
    // 版本进错误信息：launchd 反复拉起时 stderr 直接说明差在哪，不用再开库核对
    // （F01 的 13 段崩溃栈只留下一个裸错误码）。
    throw new Error(
      `schema_rebuild_required: db v${version} needs code v${SCHEMA_VERSION};`
      + ' 旧库没有升级路径，按 docs/operations.md 显式删除重建',
    );
  }
  if (pragmaNumber(db, 'auto_vacuum') !== 2) throw new Error('auto_vacuum_requires_migration');
}

export type StoreOptions = {
  /** 每次具名写事务结束后回调（含失败与回滚），阈值判断归调用方。 */
  onWrite?: (name: string, ms: number) => void;
};

export function openStore(path: string, options: StoreOptions = {}): Store {
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
  // 写连接给 5 秒等锁：launchd KeepAlive 重叠拉起时新旧进程的收尾事务短暂
  // 共存，1 秒会把首轮派生整轮丢弃（F02）；进程内各写者共用本连接，不受影响。
  db.exec('PRAGMA busy_timeout=5000');

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
    const split: SqlSplit | null = TIMED_WRITES.has(name)
      ? { read_ms: 0, write_ms: 0, fn_ms: 0, txn_ms: 0, reads: 0, writes: 0 }
      : null;
    try {
      return db.transaction(() => {
        const fnStarted = performance.now();
        const result = fn(split === null ? db : timedDatabase(db, split));
        if (result instanceof Promise) throw new TypeError('async writer');
        if (split !== null) split.fn_ms = performance.now() - fnStarted;
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
      if (split !== null) {
        const sums = named.sql ?? { read_ms: 0, write_ms: 0, fn_ms: 0, txn_ms: 0, reads: 0, writes: 0 };
        sums.read_ms += split.read_ms;
        sums.write_ms += split.write_ms;
        sums.fn_ms += split.fn_ms;
        sums.txn_ms += elapsed - split.fn_ms;
        sums.reads += split.reads;
        sums.writes += split.writes;
        named.sql = sums;
      }
      writeStats.by_name[name] = named;
      options.onWrite?.(name, elapsed);
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
