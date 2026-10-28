import { createHash } from 'node:crypto';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import type { Database } from 'bun:sqlite';
import type { Store } from './store';
import { resolveRequestId } from './store';
import { ADAPTER_VERSION, parseProtocol } from './protocols';
import { skeletonLike, validateSkeleton } from './skeleton';
import { fingerprintHash, messageFingerprint } from './fingerprint';
import { messageOfBlock } from './body-cache';
import type { BodyReadCache } from './body-cache';
import {
  requestItemsOf, roleNameOfItem, withItems, withoutItems,
} from './protocol-shape';
import type { MessageForm, MessagesKey, RequestItems } from './protocol-shape';
import { markRequestInputTx } from './derive/state';

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
  messages_key: MessagesKey;
  messages_form: MessageForm;
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
  // 有 role 用 role；Responses 顶层项没有 role，按 type 推断（调用/推理→assistant，
  // 工具结果→tool）。留在 unknown 会让工具结果混进 user 块，污染用途判定。
  const role = roleNameOfItem(message);
  if (role === null) return ROLE_UNKNOWN;
  const code = ROLE_BY_NAME[role.toLowerCase()];
  return typeof code === 'number' ? code : ROLE_UNKNOWN;
}

/**
 * 骨架只描述拆块方式：消息数组按形状表的键与形态存进块，其余字段原样留在
 * `request_without_messages` 里。键与形态一并记录，恢复时按记录放回，
 * 不按协议名二次推断。
 */
function skeletonOf(body: BodyInput, items: RequestItems): Skeleton {
  if (typeof body.protocol !== 'string' || body.protocol.length === 0) throw new Error('body_protocol_missing');
  if (!Number.isInteger(body.redact_version) || body.redact_version < 1) throw new Error('body_redact_version_invalid');
  return {
    format: 1,
    protocol: body.protocol,
    request_without_messages: items.items === null
      ? body.request : withoutItems(body.request, items.key),
    messages_key: items.key,
    messages_form: items.form,
    reply: body.reply,
    redact_version: body.redact_version,
    has_messages: items.items !== null,
  };
}

/**
 * 在调用方的 writer 事务里保存正文。块的插入、引用的替换、骨架与状态更新
 * 必须一起提交：任何一步失败都回滚，不能留下"看起来可用"的请求。
 */
export function persistBodyTx(db: Database, reqId: number, body: BodyInput): void {
  const exists = db.query('SELECT req_id FROM request WHERE req_id=?').get(reqId);
  if (exists == null) throw new Error('body_request_missing');

  const items = requestItemsOf(body.protocol, body.request);
  const messages = items.items;
  const skeleton = skeletonOf(body, items);
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
  /** 消息数组在原始对象里的键与形态：恢复时按这两项放回去，不看协议名。 */
  messagesKey: MessagesKey;
  messagesForm: MessageForm;
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
  hasMessages: boolean; messagesKey: MessagesKey; messagesForm: MessageForm;
  messageCount: number; redactVersion: number;
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
    messagesKey: skeleton.messagesKey,
    messagesForm: skeleton.messagesForm,
    messageCount: skeleton.messageCount,
    redact_version: skeleton.redactVersion,
  };
}

/**
 * 完整读出已保存正文及实际拆块的消息；结构不一致返回 null，不补空位也不抛错。
 *
 * `cache` 是可选的一次派生作用域读取上下文：消息块按内容哈希复用解压与
 * JSON 解析，跨请求、跨消费者共享。缓存不替代骨架、状态与引用校验，
 * 命中前仍逐项检查当前读取条件。
 */
export function readBodyWithMessagesTx(db: Database, reqId: number,
  cache?: BodyReadCache): { body: StoredBody; messages: unknown[] | null } | null {
  const meta = readBodyMetaTx(db, reqId);
  if (meta === null) return null;
  if (!meta.hasMessages) {
    return {
      body: {
        protocol: meta.protocol,
        request: meta.request,
        reply: meta.reply,
        redact_version: meta.redact_version,
      },
      messages: null,
    };
  }
  // 带消息时骨架必须原本就是对象，否则无法无损合并消息数组。
  if (meta.request === null || typeof meta.request !== 'object' || Array.isArray(meta.request)) {
    return null;
  }
  let messages: unknown[] = [];
  if (meta.messageCount > 0) {
    const refs = db.query<{
      id: number; hash: string; z: Uint8Array; raw_size: number;
    }, [number]>(`
      SELECT b.id AS id, hex(b.hash) AS hash, b.z AS z, b.raw_size AS raw_size
      FROM request_block rb JOIN block b ON b.id = rb.block
      WHERE rb.req_id=? ORDER BY rb.ord`).all(reqId);
    if (refs.length !== meta.messageCount) return null;
    const decoded: unknown[] = [];
    for (const ref of refs) {
      const message = messageOfBlock(ref, cache);
      if (message === undefined) return null;
      decoded.push(message);
    }
    messages = decoded;
  }
  // 键与形态来自骨架自己的记录：Responses 的 input 与裸字符串输入都逐字还原，
  // 不按协议名二次推断（旧骨架缺这两项时按 messages/array 读）。
  const request = withItems(meta.request, meta.messagesKey, meta.messagesForm, messages);
  if (request === null) return null;
  return {
    body: {
      protocol: meta.protocol,
      request,
      reply: meta.reply,
      redact_version: meta.redact_version,
    },
    messages,
  };
}

/** 只需要原协议对象时复用同一次完整读取。 */
export function readBodyTx(db: Database, reqId: number,
  cache?: BodyReadCache): StoredBody | null {
  return readBodyWithMessagesTx(db, reqId, cache)?.body ?? null;
}

/** 按请求还原脱敏协议对象；正文已被回收、从未写入或结构损坏时返回 null。 */
export function restoreBody(store: Store, id: number): BodyInput | null {
  const reqId = resolveRequestId(store, id);
  if (reqId === null) return null;
  const body = readBodyTx(store.read, reqId);
  return body === null ? null : { ...body };
}
