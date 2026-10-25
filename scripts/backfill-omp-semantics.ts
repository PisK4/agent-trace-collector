/**
 * 一次性回填：OMP harness 语义上线后的存量库补列补表与全组重派生。
 *
 * 配套 2026-10-25-omp-harness-integration 提案交付，随提交逐步扩展：
 * - 调用参数提取补 `path` 键（OMP 的 read/write/edit/grep/glob），算法号
 *   GROUP_ALGORITHM/DERIVE_ALGORITHM 随之 bump——这里把全部组标脏重算。
 * - 压缩事件位：`request` 与 `derive_request_result` 各补 `context_event` 列，
 *   两个读模型视图从 schema-v6.sql 重取 DDL。
 * - 背景作业配对：补 `bg_job` 结算表（纯派生、可整体重建）。
 *
 * 全部改动幂等：列存在就跳过，表存在就跳过，重派生总是安全重跑。
 * 用法：先停采集器，再 `bun scripts/backfill-omp-semantics.ts`。
 */
import { readFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { enqueueDerive } from '../src/derive/sync';
import { drainDeriveEntry } from '../src/derive/unit';
import type { Store } from '../src/store';

const path = process.env.ATC_BACKFILL_DB
  ?? `${process.env.HOME}/Library/Application Support/agent-trace-collector/trace.db`;

function columnsOf(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name);
}

function tablesOf(db: Database): string[] {
  return (db.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  ).all() as { name: string }[]).map(row => row.name);
}

/** 从 schema-v6.sql 按名字抽取视图 DDL 执行；定义只住在 schema 一处。 */
function refreshViews(db: Database, names: readonly string[]): void {
  const schemaV6 = readFileSync(new URL('../src/schema-v6.sql', import.meta.url), 'utf8');
  const pattern = new RegExp(
    `CREATE VIEW IF NOT EXISTS (${names.join('|')}) AS[\\s\\S]*?;`, 'g');
  const views = schemaV6.match(pattern) ?? [];
  if (views.length !== names.length) throw new Error('backfill_view_ddl_not_found');
  for (const name of names) db.exec(`DROP VIEW IF EXISTS ${name}`);
  for (const view of views) db.exec(view);
}

/**
 * 幂等补列补表。schema.sql 已带全部新列新表，这里只处理还没升级的存量库；
 * 视图 DDL 按名字从 schema-v6.sql 抽取执行，不复制第二份定义。
 */
export function migrateOmpSemantics(db: Database): void {
  db.transaction(() => {
    const add = (table: string, column: string, ddl: string): void => {
      if (columnsOf(db, table).includes(column)) return;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    };
    add('request', 'context_event', 'context_event TEXT');
    add('derive_request_result', 'context_event', 'context_event TEXT');
    if (!tablesOf(db).includes('bg_job')) {
      db.exec(`CREATE TABLE bg_job (
        job_id       TEXT NOT NULL,
        conv_key     TEXT NOT NULL,
        spawn_req    INTEGER,
        spawn_ord    INTEGER,
        notice_req   INTEGER,
        notice_ord   INTEGER,
        state        TEXT NOT NULL,
        PRIMARY KEY (conv_key, job_id)
      ) WITHOUT ROWID`);
    }
    refreshViews(db, ['published_derive_request', 'effective_request']);
  }).immediate();
}

// openStore 会拒绝版本低于当前的库；这个脚本的职责是给既有 v6 库补列，
// 所以自己开连接。schema.sql 已带全部新列，这里只处理还没升级的旧库。
// 主体收在 import.meta.main 里：tests 只导入 migrateOmpSemantics，
// 导入不得有副作用，更不允许摸到生产库。
export function runBackfill(): void {
  const db = new Database(path);
  db.exec('PRAGMA journal_mode=WAL');
  migrateOmpSemantics(db);

  // 全组标脏重算：参数提取与派生位的判定随算法号变化，重算时按当前提取器
  // 写满新列；正文已回收的请求不参与重算，行保留、事实留空，由覆盖度反映。
  const groups = db.query<{ conv_key: string; actor: string }, []>(`
    SELECT DISTINCT conv_key, actor FROM request
    WHERE conv_key IS NOT NULL AND actor IS NOT NULL AND actor_state='known'`).all();
  process.stderr.write(`groups:${groups.length}\n`);

  const store: Store = {
    path,
    db,
    read: db,
    write<T>(fn: (connection: Database) => T): T {
      return db.transaction(() => fn(db)).immediate();
    },
    // 一次性脚本不做容量观测；字段只为满足 Store 的现行契约。
    writeStats: { count: 0, total_ms: 0, max_ms: 0, by_name: {} },
    close(): void { db.close(); },
  };

  for (const group of groups) enqueueDerive(store, group.conv_key, group.actor, '');

  let processed = 0;
  for (;;) {
    const result = drainDeriveEntry(store, 50);
    processed += result.processed;
    if (result.remaining === 0) break;
  }
  process.stderr.write(`derived:${processed}\n`);

  // 分布速览：为验收核对提供一屏数字。
  const paths = db.query<{ tool_name: string | null; n: number }, []>(`
    SELECT tool_name, COUNT(*) AS n FROM tool_call WHERE arg_path IS NOT NULL
    GROUP BY tool_name ORDER BY n DESC LIMIT 10`).all();
  process.stdout.write(JSON.stringify({ arg_path_by_tool: paths }, null, 2) + '\n');
  store.close();
}

if (import.meta.main) runBackfill();
