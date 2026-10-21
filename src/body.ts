import { createHash } from 'node:crypto';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import type { Database } from 'bun:sqlite';
import type { Store } from './store';
import { resolveRequestId } from './queries';
import { ADAPTER_VERSION, parseProtocol } from './protocols';

/**
 * 可还原的脱敏正文。调用方负责先脱敏再调用 persist，本模块只认已脱敏对象。
 * 块按完整消息字节哈希去重，不剥 cache_control：同一段内容在不同请求里
 * 只有在字节完全相同时才共用一块，还原时才不需要另存差异。
 */

export type BodyInput = {
  protocol: string;
  request: unknown;
  reply: unknown;
  redact_version: number;
};

export const REDACT_VERSION = 1;

/** request_block.role：0 user / 1 assistant / 2 system / 3 tool / 4 unknown。 */
const ROLE_UNKNOWN = 4;
const ROLE_BY_NAME: Record<string, number> = { user: 0, assistant: 1, system: 2, tool: 3, developer: 2 };

type Skeleton = {
  format: 1;
  protocol: string;
  request_without_messages: unknown;
  reply: unknown;
  redact_version: number;
  has_messages: boolean;
};

const compress = (bytes: Uint8Array): Uint8Array => zstdCompressSync(bytes, {
  params: { [constants.ZSTD_c_compressionLevel]: 3 },
});

const serialize = (value: unknown): Buffer => {
  const text = JSON.stringify(value);
  if (typeof text !== 'string') throw new TypeError('body_not_serializable');
  return Buffer.from(text, 'utf8');
};

export function roleCode(message: unknown): number {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return ROLE_UNKNOWN;
  const role = (message as Record<string, unknown>).role;
  if (typeof role !== 'string') return ROLE_UNKNOWN;
  const code = ROLE_BY_NAME[role.toLowerCase()];
  return typeof code === 'number' ? code : ROLE_UNKNOWN;
}

/** messages 只有真的是数组才拆块；存在但不是数组时留在骨架里，避免还原丢字段。 */
function messagesOf(request: unknown): unknown[] | null {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return null;
  const messages = (request as Record<string, unknown>).messages;
  return Array.isArray(messages) ? messages : null;
}

function withoutMessages(request: unknown): unknown {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return request;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request as Record<string, unknown>)) {
    if (key !== 'messages') copy[key] = value;
  }
  return copy;
}

function skeletonOf(body: BodyInput, messages: unknown[] | null): Skeleton {
  if (typeof body.protocol !== 'string' || body.protocol.length === 0) throw new Error('body_protocol_missing');
  if (!Number.isInteger(body.redact_version) || body.redact_version < 1) throw new Error('body_redact_version_invalid');
  return {
    format: 1,
    protocol: body.protocol,
    request_without_messages: messages === null ? body.request : withoutMessages(body.request),
    reply: body.reply,
    redact_version: body.redact_version,
    has_messages: messages !== null,
  };
}

/**
 * 在调用方的 writer 事务里保存正文。块的插入、引用的替换、骨架与状态更新
 * 必须一起提交：任何一步失败都回滚，不能留下"看起来可用"的请求。
 */
export function persistBodyTx(db: Database, reqId: number, body: BodyInput): void {
  const exists = db.query('SELECT req_id FROM request WHERE req_id=?').get(reqId);
  if (exists == null) throw new Error('body_request_missing');

  const messages = messagesOf(body.request);
  const skeleton = skeletonOf(body, messages);
  const skeletonZ = compress(serialize(skeleton));
  // 解析状态跟着正文一起写：读取端只查 request 的一行就能同时拿到两者。
  const parsed = parseProtocol(body.protocol, body.request, body.reply);

  db.run('DELETE FROM request_block WHERE req_id=?', [reqId]);

  const findBlock = db.query<{ id: number }, [Uint8Array]>('SELECT id FROM block WHERE hash=?');
  const insertBlock = db.query<{ id: number }, [Uint8Array, Uint8Array, number]>(
    'INSERT INTO block(hash,z,raw_size) VALUES (?,?,?) RETURNING id',
  );
  const insertRef = db.query('INSERT INTO request_block(req_id,ord,role,block) VALUES (?,?,?,?)');

  let blockBytes = skeletonZ.length;
  const seen = new Map<number, number>();
  for (let ord = 0; ord < (messages?.length ?? 0); ord++) {
    const raw = serialize(messages![ord]);
    const hash = createHash('sha256').update(raw).digest();
    const existing = findBlock.get(hash);
    let blockId: number;
    if (existing != null) {
      blockId = existing.id;
    } else {
      const inserted = insertBlock.get(hash, compress(raw), raw.length);
      if (inserted == null) throw new Error('body_block_insert_failed');
      blockId = inserted.id;
    }
    // 共享块只在本请求里计一次，body_bytes 表示这笔请求真正新增的存储量级。
    if (!seen.has(blockId)) {
      seen.set(blockId, raw.length);
      const size = db.query<{ size: number }, [number]>('SELECT length(z) AS size FROM block WHERE id=?').get(blockId);
      blockBytes += size?.size ?? 0;
    }
    insertRef.run(reqId, ord, roleCode(messages![ord]), blockId);
  }

  db.run(
    `UPDATE request SET skeleton_z=?, body_state='available', body_prev_state=NULL,
       body_evicted_at=NULL, body_evict_reason=NULL, body_bytes=?, msg_count=?,
       redact_version=?, parse_state=?, reply_state=?, adapter_version=?, updated_at=? WHERE req_id=?`,
    [
      skeletonZ, blockBytes, messages === null ? null : messages.length, body.redact_version,
      parsed.parse_state, parsed.reply_state, ADAPTER_VERSION, Date.now(), reqId,
    ],
  );
}

export function persistBody(store: Store, reqId: number, body: BodyInput): void {
  store.write(db => persistBodyTx(db, reqId, body));
}

/** 按请求还原脱敏协议对象；正文已被回收或从未写入时返回 null。 */
export function restoreBody(store: Store, id: number): BodyInput | null {
  const reqId = resolveRequestId(store, id);
  if (reqId === null) return null;
  const row = store.read.query<{ skeleton_z: Uint8Array | null; body_state: string }, [number]>(
    'SELECT skeleton_z, body_state FROM request WHERE req_id=?',
  ).get(reqId);
  if (row == null || row.skeleton_z == null) return null;
  if (row.body_state !== 'available' && row.body_state !== 'partial') return null;

  const skeleton = JSON.parse(zstdDecompressSync(row.skeleton_z).toString('utf8')) as Skeleton;
  if (skeleton.format !== 1) throw new Error('body_skeleton_unsupported');

  let request = skeleton.request_without_messages;
  if (skeleton.has_messages) {
    const refs = store.read.query<{ ord: number; z: Uint8Array }, [number]>(`
      SELECT rb.ord AS ord, b.z AS z FROM request_block rb
      JOIN block b ON b.id = rb.block
      WHERE rb.req_id=? ORDER BY rb.ord`).all(reqId);
    const messages: unknown[] = [];
    for (const ref of refs) messages[ref.ord] = JSON.parse(zstdDecompressSync(ref.z).toString('utf8'));
    // 引用按 ord 连续写入；若中间缺行，说明库被外部改动过，宁可报错也不补空位。
    if (messages.length !== refs.length || messages.some(value => value === undefined)) {
      throw new Error('body_blocks_incomplete');
    }
    if (request === null || typeof request !== 'object' || Array.isArray(request)) request = {};
    request = { ...(request as Record<string, unknown>), messages };
  }
  return {
    protocol: skeleton.protocol,
    request,
    reply: skeleton.reply,
    redact_version: skeleton.redact_version,
  };
}
