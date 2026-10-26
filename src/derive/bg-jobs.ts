import type { Database } from 'bun:sqlite';
import { messageOfBlock } from '../body-cache';
import type { BlockMessageRow, BodyReadCache } from '../body-cache';
import { flattenToolContent } from './decision';

/**
 * OMP bash 后台作业的发起→通知配对，纯派生结算表 `bg_job` 的唯一写入方。
 *
 * 发起痕迹只认 role=3 的工具结果（`Backgrounded as job bg_NNN …`）；归档正文里
 * 的复述与后续请求的重发都是同一文本的再出现，按「conv 内最早出现的位置」取，
 * 时延与位置才不落到重发请求上。通知只认 user 消息里的两种完成形态：
 * 单数 `Background job bg_NNN has completed.` 与复数
 * `N background jobs have completed.` 之下的 `── Job bg_NNN ──` 行——只认单数
 * 会让只以复数出现的作业永远停在 pending。`<system-notice>` 也承载其它通知，
 * 两种形态都不命中的不参与配对。
 *
 * 结算对照工具配对的重建式语义：每组完成后按当前可读正文整体重算本 actor 的
 * 行，正文已回收的行原样保留（retained），重算撞上保留行时保留行胜——它记的
 * 是更早的真实位置。
 */

const SPAWN_MARK = /Backgrounded as job (bg_\d+)\b/g;
const NOTICE_SINGLE = /Background job (bg_\d+) has completed\./g;
const NOTICE_PLURAL = /background jobs have completed\./;
const NOTICE_JOB_LINE = /──\s*Job (bg_\d+)\s*──/g;

/** 请求块行：ord 是消息序号，与 request_block 的 ord 同一空间。 */
type BlockRow = { ord: number } & BlockMessageRow;

function decode(row: BlockRow, cache?: BodyReadCache): unknown | undefined {
  return messageOfBlock(row, cache);
}

function blockRows(db: Database, reqId: number, role: number): BlockRow[] {
  return db.query<BlockRow, [number, number]>(`
    SELECT rb.ord AS ord, b.id AS id, hex(b.hash) AS hash, b.z AS z, b.raw_size AS raw_size
    FROM request_block rb JOIN block b ON b.id = rb.block
    WHERE rb.req_id=? AND rb.role=? ORDER BY rb.ord`).all(reqId, role);
}

/** 一笔请求里的发起痕迹：每个 job 只记最早的（本笔内按消息序号先到先得）。 */
function scanSpawns(db: Database, reqId: number,
  into: Map<string, { req: number; ord: number }>, cache?: BodyReadCache): void {
  for (const row of blockRows(db, reqId, 3)) {
    const message = decode(row, cache);
    if (message === undefined || typeof message !== 'object') continue;
    const text = flattenToolContent((message as Record<string, unknown>).content ?? null);
    for (const match of text.matchAll(SPAWN_MARK)) {
      const job = match[1]!;
      if (!into.has(job)) into.set(job, { req: reqId, ord: row.ord });
    }
  }
}

/** 一笔请求里的完成通知：单数直接认，复数公告下的 Job 行整组认。 */
function scanNotices(db: Database, reqId: number,
  into: Map<string, { req: number; ord: number }>, cache?: BodyReadCache): void {
  for (const row of blockRows(db, reqId, 0)) {
    const message = decode(row, cache);
    if (message === undefined || typeof message !== 'object') continue;
    const record = message as Record<string, unknown>;
    if (record.role !== 'user') continue;
    const blocks = Array.isArray(record.content) ? record.content : [];
    const texts: string[] = [];
    for (const block of blocks) {
      if (block !== null && typeof block === 'object'
        && (block as Record<string, unknown>).type === 'text'
        && typeof (block as Record<string, unknown>).text === 'string') {
        texts.push((block as Record<string, unknown>).text as string);
      }
    }
    const text = texts.join('\n');
    const ord = row.ord;
    const push = (job: string): void => {
      if (!into.has(job)) into.set(job, { req: reqId, ord });
    };
    for (const match of text.matchAll(NOTICE_SINGLE)) push(match[1]!);
    if (NOTICE_PLURAL.test(text)) {
      for (const match of text.matchAll(NOTICE_JOB_LINE)) push(match[1]!);
    }
  }
}

/** 配对的行形状：遍历序已排好的组内请求，带用途结论。 */
export type BgPairRow = { req_id: number; purpose_chain: string };

/**
 * 一组完成后的 bg_job 重建。只重建本 actor 的行：conv 内多 actor 时互不覆盖，
 * 两端正文都已回收的保留行原样留在表里。
 */
export function pairBackgroundJobsTx(db: Database,
  group: { conv_key: string; actor: string }, rows: readonly BgPairRow[],
  cache?: BodyReadCache): void {
  const spawns = new Map<string, { req: number; ord: number }>();
  const notices = new Map<string, { req: number; ord: number }>();
  for (const row of rows) {
    // 排除用途是旁路：发起与通知都不从它取，与工具候选同一条判据。
    if (row.purpose_chain === 'exclude') continue;
    scanSpawns(db, row.req_id, spawns, cache);
    scanNotices(db, row.req_id, notices, cache);
  }
  // 重算范围只盖两端落在可读正文上的行；正文已回收的端点拿不回证据，行保留。
  db.run(`DELETE FROM bg_job WHERE conv_key=? AND (
    spawn_req IN (SELECT req_id FROM request WHERE conv_key=? AND actor=?
      AND body_state IN ('available','partial'))
    OR notice_req IN (SELECT req_id FROM request WHERE conv_key=? AND actor=?
      AND body_state IN ('available','partial'))
    OR (spawn_req IS NULL AND notice_req IS NULL))`,
  [group.conv_key, group.conv_key, group.actor, group.conv_key, group.actor]);
  const jobs = new Set<string>([...spawns.keys(), ...notices.keys()]);
  for (const job of jobs) {
    const spawn = spawns.get(job) ?? null;
    const notice = notices.get(job) ?? null;
    if (spawn === null && notice === null) continue;
    db.run(`INSERT INTO bg_job(job_id,conv_key,spawn_req,spawn_ord,notice_req,notice_ord,state)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(conv_key, job_id) DO NOTHING`,
    [job, group.conv_key, spawn?.req ?? null, spawn?.ord ?? null,
      notice?.req ?? null, notice?.ord ?? null,
      spawn !== null && notice !== null ? 'resolved' : 'pending']);
  }
}
