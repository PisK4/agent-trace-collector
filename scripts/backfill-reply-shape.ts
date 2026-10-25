/**
 * 一次性回填：给既有库补上回复形状位（final / tools / unknown）。
 *
 * 形状是行内派生，只依赖本笔正文里的 reply，不经全量重派生：可读的行直接按
 * 派生内核（replyShapeOf）重算，与两条派生路径共用同一份判据。正文不可读的行
 * 按提案口径标 unknown——回收前就算过的形状无法从空正文恢复，这些行在升级
 * 窗口期不参与轮次终点判定。发布代的暂存行一并补算，避免「标题取发布代、
 * 形状取同步列」的混拼；retention_state 不动，不把补算冒充成重算。
 *
 * 用法：先停采集器，再 `bun scripts/backfill-reply-shape.ts`。
 */
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { readBodyTx } from '../src/body';
import { replyShapeOf } from '../src/derive-decision';

const path = process.env.ATC_BACKFILL_DB
  ?? `${process.env.HOME}/Library/Application Support/agent-trace-collector/trace.db`;

function columnsOf(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name);
}

/**
 * 补列并重建视图，幂等。视图 DDL 的唯一家在 schema-v6.sql，这里按名字抽取执行，
 * 不在脚本里复制第二份定义。
 */
export function migrateReplyShape(db: Database): void {
  db.transaction(() => {
    if (!columnsOf(db, 'request').includes('reply_shape')) {
      db.exec('ALTER TABLE request ADD COLUMN reply_shape TEXT');
    }
    const hasResultTable = db.query(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='derive_request_result'",
    ).get() !== null;
    if (hasResultTable && !columnsOf(db, 'derive_request_result').includes('reply_shape')) {
      db.exec('ALTER TABLE derive_request_result ADD COLUMN reply_shape TEXT');
    }
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

export type ReplyShapeBackfillReport = {
  /** request 行补算总数。 */
  computed: number;
  /** 正文不可读、按口径标 unknown 的 request 行数。 */
  unknown: number;
  /** 发布代暂存行补算总数。 */
  published_computed: number;
  /** 发布代暂存行标 unknown 的行数。 */
  published_unknown: number;
};

/** 形状补算的唯一规则：正文可读按内核重算，不可读标 unknown。 */
function shapeFor(db: Database, reqId: number): string {
  const body = readBodyTx(db, reqId);
  return body === null ? 'unknown' : replyShapeOf(body.reply);
}

/** 逐行补算 request 与发布代暂存行，幂等：重跑只是把同一批值再写一遍。 */
export function backfillReplyShapes(db: Database): ReplyShapeBackfillReport {
  migrateReplyShape(db);
  const report: ReplyShapeBackfillReport = {
    computed: 0, unknown: 0, published_computed: 0, published_unknown: 0,
  };
  const updateRequest = db.prepare('UPDATE request SET reply_shape=? WHERE req_id=?');
  const updateStaged = db.prepare(
    'UPDATE derive_request_result SET reply_shape=? WHERE generation=? AND req_id=?');
  const requestIds = db.query<{ req_id: number }, []>(
    'SELECT req_id FROM request ORDER BY req_id').all();
  db.transaction(() => {
    for (const { req_id } of requestIds) {
      const shape = shapeFor(db, req_id);
      updateRequest.run(shape, req_id);
      if (shape === 'unknown') report.unknown += 1;
      else report.computed += 1;
    }
  }).immediate();
  // 发布代的暂存行：只补算已发布代，building/discard 的代有自己的生命周期。
  const staged = db.query<{ generation: string; req_id: number }, []>(`
    SELECT d.generation AS generation, d.req_id AS req_id
    FROM derive_request_result d
    JOIN derive_queue q ON q.published_generation = d.generation
    ORDER BY d.generation, d.req_id`).all();
  db.transaction(() => {
    for (const { generation, req_id } of staged) {
      const shape = shapeFor(db, req_id);
      updateStaged.run(shape, generation, req_id);
      if (shape === 'unknown') report.published_unknown += 1;
      else report.published_computed += 1;
    }
  }).immediate();
  return report;
}

if (import.meta.main) {
  const db = new Database(path);
  db.exec('PRAGMA journal_mode=WAL');
  try {
    const report = backfillReplyShapes(db);
    console.log(`request 行：${report.computed} 笔重算，${report.unknown} 笔标 unknown；`
      + `发布代暂存行：${report.published_computed} 笔重算，${report.published_unknown} 笔标 unknown。`);
  } finally {
    db.close();
  }
}
