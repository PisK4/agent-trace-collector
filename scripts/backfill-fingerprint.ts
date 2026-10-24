/**
 * 一次性回填：给既有库补上块指纹与折叠摘要，然后重算全部派生。
 *
 * 为什么不用"删库重来"：正文块只在这里，raw_hook 的原文早已按保留期清掉，
 * 删库等于永久丢掉这些请求的正文。而错的只是派生结果，不是正文本身。
 *
 * 用法：先停采集器，再 `bun scripts/backfill-fingerprint.ts`。
 */
import { Database } from 'bun:sqlite';
import { zstdDecompressSync } from 'node:zlib';
import { fingerprintHash, messageFingerprint } from '../src/fingerprint';
import { enqueueDerive } from '../src/derive';
import { drainDeriveEntry } from '../src/derive-unit';
import type { Store } from '../src/store';

const path = process.env.ATC_BACKFILL_DB ?? `${process.env.HOME}/Library/Application Support/agent-trace-collector/trace.db`;

function columnsOf(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name);
}

// openStore 会拒绝版本低于当前的库（它假设新库要么全新要么已升级）。
// 这个脚本的职责恰恰是升级旧库，所以自己开连接。
const db = new Database(path);
db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA auto_vacuum=INCREMENTAL');
const store: Store = {
  path,
  db,
  read: db,
  write<T>(fn: (connection: Database) => T): T {
    return db.transaction(() => fn(db)).immediate();
  },
  // 一次性脚本不做容量观测；字段只为满足 Store 的现行契约。
  writeStats: { count: 0, total_ms: 0, max_ms: 0 },
  close(): void { db.close(); },
};

// 1. 补列。schema.sql 已经带上了这些列，这里只处理还没升级的旧库。
db.transaction(() => {
  const blockCols = columnsOf(db, 'block');
  if (!blockCols.includes('fingerprint')) {
    db.exec("ALTER TABLE block ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''");
  }
  db.exec('CREATE INDEX IF NOT EXISTS i_block_fp ON block(fingerprint)');
  const requestCols = columnsOf(db, 'request');
  if (!requestCols.includes('input_preview')) db.exec('ALTER TABLE request ADD COLUMN input_preview TEXT');
  if (!requestCols.includes('input_preview_kind')) db.exec('ALTER TABLE request ADD COLUMN input_preview_kind TEXT');
  if (!requestCols.includes('reply_preview')) db.exec('ALTER TABLE request ADD COLUMN reply_preview TEXT');
  // v4：请求类别、链角色与 Title Generator 的正式标题。都是可重算的派生列。
  if (!requestCols.includes('req_kind')) {
    db.exec("ALTER TABLE request ADD COLUMN req_kind TEXT NOT NULL DEFAULT 'chat'");
  }
  if (!requestCols.includes('chain_role')) {
    db.exec("ALTER TABLE request ADD COLUMN chain_role TEXT NOT NULL DEFAULT 'main'");
  }
  if (!requestCols.includes('model_title')) db.exec('ALTER TABLE request ADD COLUMN model_title TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS i_req_model_title
    ON request(conv_key, started_ms DESC, req_id DESC) WHERE req_kind = 'title'`);
}).immediate();
// PRAGMA user_version 在事务里不生效，必须在事务外写。
db.exec('PRAGMA user_version=4');

// 2. 给每个块算指纹。只处理还没有指纹的，重复执行不会重算。
const pending = db.query<{ id: number; z: Uint8Array }, []>(
  "SELECT id, z FROM block WHERE fingerprint = ''").all();
process.stderr.write(`blocks_to_fingerprint:${pending.length}\n`);

const update = db.query('UPDATE block SET fingerprint=? WHERE id=?');
let filled = 0;
for (const block of pending) {
  let fingerprint: string;
  try {
    const message = JSON.parse(zstdDecompressSync(block.z).toString('utf8'));
    fingerprint = fingerprintHash(messageFingerprint(message));
  } catch {
    // 解不开的块保留原样：指纹留空，派生会把它当成不可比，不会误判成相同。
    continue;
  }
  update.run(fingerprint, block.id);
  filled += 1;
  if (filled % 500 === 0) process.stderr.write(`blocks_done:${filled}\n`);
}
process.stderr.write(`blocks_filled:${filled}\n`);

// 3. 整库重算派生。链式结果依赖全部祖先，所以每个分组都要从头发一遍。
const groups = db.query<{ conv_key: string; actor: string }, []>(`
  SELECT DISTINCT conv_key, actor FROM request
  WHERE conv_key IS NOT NULL AND actor IS NOT NULL AND actor_state='known'`).all();
process.stderr.write(`groups:${groups.length}\n`);
for (const group of groups) enqueueDerive(store, group.conv_key, group.actor, '');

let processed = 0;
for (;;) {
  const result = drainDeriveEntry(store, 50);
  processed += result.processed;
  if (result.remaining === 0) break;
}
process.stderr.write(`derived:${processed}\n`);

// 4. 回填后的分布，用来核对这次修复到底改变了多少。
const relations = db.query<{ prev_relation: string; n: number }, []>(`
  SELECT COALESCE(prev_relation, '(null)') AS prev_relation, COUNT(*) AS n
  FROM request GROUP BY prev_relation ORDER BY n DESC`).all();
const titles = db.query<{ title_source: string; n: number }, []>(`
  SELECT COALESCE(title_source, '(null)') AS title_source, COUNT(*) AS n
  FROM request GROUP BY title_source ORDER BY n DESC`).all();
const previews = db.query<{ n: number }, []>(
  'SELECT COUNT(*) AS n FROM request WHERE input_preview IS NOT NULL').get();

process.stdout.write(JSON.stringify({ relations, titles, with_input_preview: previews?.n }, null, 2) + '\n');
store.close();
