import type { Database } from 'bun:sqlite';
import { messageOfBlock } from './body-cache';
import type { BlockMessageRow, BodyReadCache } from './body-cache';
import { interpretMessage } from './input-interpretation';

/** 末尾最多检查六条；跳过系统和注入消息，遇坏块停止以免把旧消息当末尾。 */
export function tailCommandOrdinal(db: Database, reqId: number, cache?: BodyReadCache): number | null {
  const meta = db.query<{ agent: string | null }, [number]>(
    'SELECT agent FROM request WHERE req_id=?').get(reqId);
  const rows = db.query<{ ord: number } & BlockMessageRow, [number, number]>(`
    SELECT rb.ord AS ord, b.id AS id, hex(b.hash) AS hash, b.z AS z, b.raw_size AS raw_size
    FROM request_block rb JOIN block b ON b.id = rb.block
    WHERE rb.req_id=? ORDER BY rb.ord DESC LIMIT ?`).all(reqId, 6);
  for (const row of rows) {
    const message = messageOfBlock(row, cache);
    if (message === undefined) return null;
    const view = interpretMessage(message, meta?.agent ?? null, row.ord);
    if (view.role === 'system') continue;
    if (view.role !== 'user' || view.input === null) return null;
    if (view.input.state === 'injected') continue;
    return view.input.state === 'text' ? row.ord : null;
  }
  return null;
}
