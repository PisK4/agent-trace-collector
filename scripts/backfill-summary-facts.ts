/**
 * 一次性回填：给既有库补上会话汇总的十个事实列，然后全组重派生。
 *
 * 列分两组：调用参数与失败位（tool_call 与 derive_tool_result 各三列，经
 * derive_call_work / derive_result_work 暂存），中断计数（request 与
 * derive_request_result 各一列）。全部是可空加列，值由派生管线重算——
 * 参数与失败位在工具阶段顺手提取，中断计数在解释确定增量时按开头前缀判定，
 * 所以这里只补列、标脏、排空，不算值。升级窗口期算不出值的行保持 NULL，
 * 汇总端点按覆盖度如实呈现，不冒充 0。
 *
 * 用法：先停采集器，再 `bun scripts/backfill-summary-facts.ts`。
 */
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { GROUP_ALGORITHM } from '../src/derive/state';
import { enqueueDerive } from '../src/derive/sync';
import { drainDeriveEntry } from '../src/derive/unit';
import type { Store } from '../src/store';

const path = process.env.ATC_BACKFILL_DB
  ?? `${process.env.HOME}/Library/Application Support/agent-trace-collector/trace.db`;

function columnsOf(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name);
}

/** 幂等补列。视图 DDL 的唯一家在 schema-v6.sql，这里按名字抽取执行，不复制第二份定义。 */
export function migrateSummaryFacts(db: Database): void {
  db.transaction(() => {
    const add = (table: string, column: string, ddl: string): void => {
      if (columnsOf(db, table).includes(column)) return;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    };
    add('request', 'interrupt_count', 'interrupt_count INTEGER');
    add('tool_call', 'arg_path', 'arg_path TEXT');
    add('tool_call', 'arg_skill', 'arg_skill TEXT');
    add('tool_call', 'is_error', 'is_error INTEGER');
    add('derive_request_result', 'interrupt_count', 'interrupt_count INTEGER');
    add('derive_tool_result', 'arg_path', 'arg_path TEXT');
    add('derive_tool_result', 'arg_skill', 'arg_skill TEXT');
    add('derive_tool_result', 'is_error', 'is_error INTEGER');
    add('derive_call_work', 'arg_path', 'arg_path TEXT');
    add('derive_call_work', 'arg_skill', 'arg_skill TEXT');
    add('derive_result_work', 'is_error', 'is_error INTEGER NOT NULL DEFAULT 0');
    const schemaV6 = readFileSync(new URL('../src/schema-v6.sql', import.meta.url), 'utf8');
    const views = schemaV6.match(
      /CREATE VIEW IF NOT EXISTS (?:published_derive_request|effective_request) AS[\s\S]*?;/g,
    ) ?? [];
    if (views.length !== 2) throw new Error('backfill_view_ddl_not_found');
    db.exec('DROP VIEW IF EXISTS published_derive_request');
    db.exec('DROP VIEW IF EXISTS effective_request');
    for (const view of views) db.exec(view);
  }).immediate();
}

// openStore 会拒绝版本低于当前的库；这个脚本的职责是给既有 v6 库补列，
// 所以自己开连接。schema.sql 已带全部新列，这里只处理还没升级的旧库。
// 主体收在 import.meta.main 里：tests 只导入 migrateSummaryFacts，
// 导入不得有副作用，更不允许摸到生产库。
export function runBackfill(): void {
  const db = new Database(path);
  db.exec('PRAGMA journal_mode=WAL');
  migrateSummaryFacts(db);

  // 全组标脏重算：算法号已 bump，重算时两条派生路径按当前提取器写满新列；
  // 正文已回收的请求不参与重算，行保留、事实留空，由覆盖度反映。
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
  const calls = db.query<{ tool_name: string | null; n: number }, []>(`
    SELECT tool_name, COUNT(*) AS n FROM tool_call
    WHERE arg_path IS NOT NULL OR arg_skill IS NOT NULL OR is_error IS NOT NULL
    GROUP BY tool_name ORDER BY n DESC`).all();
  const interrupts = db.query<{ n: number }, []>(
    'SELECT COALESCE(SUM(interrupt_count), 0) AS n FROM request').get();
  const computed = db.query<{ calls: number; facts: number }, []>(`
    SELECT COUNT(*) AS calls,
           SUM(CASE WHEN algorithm_version = ${GROUP_ALGORITHM} THEN 1 ELSE 0 END) AS facts
    FROM tool_call WHERE retention_state = 'recomputed'`).get();
  process.stdout.write(JSON.stringify({
    calls_with_facts: calls,
    interrupt_events: interrupts?.n,
    recomputed_calls: computed,
  }, null, 2) + '\n');
  store.close();
}

if (import.meta.main) runBackfill();
