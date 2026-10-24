import { createHash } from 'node:crypto';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import type { Database } from 'bun:sqlite';
import type { Store } from './store';
import { resolveRequestId } from './store';
import { ADAPTER_VERSION, parseProtocol } from './protocols';
import { skeletonLike, validateSkeleton } from './skeleton';
import { fingerprintHash, messageFingerprint } from './fingerprint';
import { markRequestInputTx } from './derive-state';

/**
 * 可还原的脱敏正文。调用方负责先脱敏再调用 persist，本模块只认已脱敏对象。
 *
 * 块按完整消息字节哈希去重：同一段内容在不同请求里只有在字节完全相同时
 * 才共用一块，还原时才不需要另存差异。哈希只服务于去重与还原。
 *
 * 派生比对另走 fingerprint：Anthropic 的 cache_control 断点会随上下文增长
 * 移动位置，同一段历史消息因此换哈希。拿 hash 判断"这一笔是不是上一笔的
 * 续写"会把整条链读断，所以比对必须忽略这类传输标记。
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
  const insertBlock = db.query<{ id: number }, [Uint8Array, string, Uint8Array, number]>(
    'INSERT INTO block(hash,fingerprint,z,raw_size) VALUES (?,?,?,?) RETURNING id',
  );
  const insertRef = db.query('INSERT INTO request_block(req_id,ord,role,block) VALUES (?,?,?,?)');

  let blockBytes = skeletonZ.length;
  const seen = new Map<number, number>();
  for (let ord = 0; ord < (messages?.length ?? 0); ord++) {
    const raw = serialize(messages![ord]);
    const hash = createHash('sha256').update(raw).digest();
    const fingerprint = fingerprintHash(messageFingerprint(messages![ord]));
    const existing = findBlock.get(hash);
    let blockId: number;
    if (existing != null) {
      blockId = existing.id;
    } else {
      const inserted = insertBlock.get(hash, fingerprint, compress(raw), raw.length);
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
  // 正文是派生输入的一部分：骨架、块引用与解析状态变了，旧结论不能复用。
  // 归属未知时这里只推进修订，入组由归属确认后的入口负责。
  markRequestInputTx(db, reqId);
}

export function persistBody(store: Store, reqId: number, body: BodyInput): void {
  store.write(db => persistBodyTx(db, reqId, body));
}

/**
 * 已保存正文的骨架视图：协议、不可拆的请求字段与回复，加上消息条数。
 *
 * 消息条数取自 request 行——骨架只描述拆块方式，条数由同一事务里的行维护。
 * 读取端拿它核对引用数与连续 ord，不一致就视为不可读。
 */
export type BodyMeta = {
  protocol: string;
  request: unknown;
  reply: unknown;
  hasMessages: boolean;
  messageCount: number;
  redact_version: number;
};

export type StoredBody = {
  protocol: string;
  request: unknown;
  reply: unknown;
  redact_version: number;
};

/**
 * 严格读取骨架。任何一项不符合写入契约都返回 null：正文要么完整可读，
 * 要么不可读，不能把结构损坏的对象交给派生或用途判定去猜。
 */
function readSkeletonTx(db: Database, reqId: number): {
  protocol: string; request: unknown; reply: unknown;
  hasMessages: boolean; messageCount: number; redactVersion: number;
} | null {
  const row = db.query<{
    skeleton_z: Uint8Array | null; body_state: string; msg_count: number | null;
  }, [number]>(
    'SELECT skeleton_z, body_state, msg_count FROM request WHERE req_id=?',
  ).get(reqId);
  if (row == null || row.skeleton_z == null) return null;
  if (row.body_state !== 'available' && row.body_state !== 'partial') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(zstdDecompressSync(row.skeleton_z).toString('utf8'));
  } catch {
    return null;
  }
  const skeleton = skeletonLike(parsed);
  if (skeleton === null) return null;
  return validateSkeleton(skeleton, row.msg_count);
}

/** 引用必须恰好覆盖 0..n-1，且每个引用指向存在的块；只看索引，不解压。 */
function bodyRefsValid(db: Database, reqId: number, messageCount: number): boolean {
  const refs = db.query<{ ord: number; block: number | null }, [number]>(`
    SELECT rb.ord AS ord, b.id AS block FROM request_block rb
    LEFT JOIN block b ON b.id = rb.block
    WHERE rb.req_id=? ORDER BY rb.ord`).all(reqId);
  if (refs.length !== messageCount) return false;
  for (let index = 0; index < refs.length; index += 1) {
    if (refs[index]!.ord !== index || refs[index]!.block === null) return false;
  }
  return true;
}

/**
 * 只解骨架与引用索引，不解压任何消息块。用途判定只需要 system、stop、
 * 回复与条数，不需要正文全文，因此这条路径的成本不随消息大小增长。
 */
export function readBodyMetaTx(db: Database, reqId: number): BodyMeta | null {
  const skeleton = readSkeletonTx(db, reqId);
  if (skeleton === null) return null;
  if (!bodyRefsValid(db, reqId, skeleton.messageCount)) return null;
  return {
    protocol: skeleton.protocol,
    request: skeleton.request,
    reply: skeleton.reply,
    hasMessages: skeleton.hasMessages,
    messageCount: skeleton.messageCount,
    redact_version: skeleton.redactVersion,
  };
}

/** 完整读出已保存正文；结构不一致返回 null，不补空位也不抛错。 */
export function readBodyTx(db: Database, reqId: number): StoredBody | null {
  const meta = readBodyMetaTx(db, reqId);
  if (meta === null) return null;
  if (!meta.hasMessages) {
    return {
      protocol: meta.protocol,
      request: meta.request,
      reply: meta.reply,
      redact_version: meta.redact_version,
    };
  }
  // 带消息时骨架必须原本就是对象，否则无法无损合并 messages。
  if (meta.request === null || typeof meta.request !== 'object' || Array.isArray(meta.request)) {
    return null;
  }
  let messages: unknown[] = [];
  if (meta.messageCount > 0) {
    const refs = db.query<{ z: Uint8Array }, [number]>(`
      SELECT b.z AS z FROM request_block rb JOIN block b ON b.id = rb.block
      WHERE rb.req_id=? ORDER BY rb.ord`).all(reqId);
    if (refs.length !== meta.messageCount) return null;
    try {
      messages = refs.map(ref => JSON.parse(zstdDecompressSync(ref.z).toString('utf8')));
    } catch {
      return null;
    }
  }
  return {
    protocol: meta.protocol,
    request: { ...(meta.request as Record<string, unknown>), messages },
    reply: meta.reply,
    redact_version: meta.redact_version,
  };
}

/** 按请求还原脱敏协议对象；正文已被回收、从未写入或结构损坏时返回 null。 */
export function restoreBody(store: Store, id: number): BodyInput | null {
  const reqId = resolveRequestId(store, id);
  if (reqId === null) return null;
  const body = readBodyTx(store.read, reqId);
  return body === null ? null : { ...body };
}
