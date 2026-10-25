import type { Database } from 'bun:sqlite';
import { zstdDecompressSync } from 'node:zlib';
import { readBodyTx } from '../body';
import { assistantText } from '../protocols';
import { interpretMessage, isOmpArchiveMessage, ompDroppedCharsOf } from '../input-interpretation';
import { clip, interruptCountOf, replyShapeOf, replyToolSummary, toolResultPreviewOf } from './decision';
import type { PresentationPorts, ResolvedTool, ReplyShape } from './decision';

/**
 * 两条派生路径共用的读取层：逻辑顺序、指纹序列、用户文本预览与消息定位。
 *
 * 「怎么判」住在 `derive-decision.ts`，「怎么读」住在这里；同步路径
 * （derive.ts）与切片路径（derive-slice.ts）都从这里取值。
 */

/**
 * 逻辑顺序：时间优先，同毫秒按来源位置定序。
 *
 * 不用 `req_id`：它是摄入时分配的，与逻辑先后无关。同毫秒时只有同一账本代际
 * 的不同偏移能证明先后；其余来源身份只够确定一个稳定遍历顺序，不能证明谁先谁后，
 * 所以关系判定还要过 `uncertainOrderIds`。
 */
export type LogicalRow = {
  req_id: number; started_ms: number;
  sort_source: string | null; sort_key: string | null;
};

/** 离线维护只处理目标会话，不消费其它会话的任务。 */
export type DeriveScope = { convKey: string };

type LedgerPosition = { generation: string; offset: bigint };

/** 账本行的物理位置：`代际|20位偏移`。解析不出时返回 null。 */
function ledgerPosition(row: LogicalRow): LedgerPosition | null {
  if (row.sort_source !== 'ledger' || row.sort_key === null) return null;
  const match = /^(\d+:\d+:\d+:\d+)\|(\d{20})$/.exec(row.sort_key);
  return match === null ? null : { generation: match[1]!, offset: BigInt(match[2]!) };
}

/** 时间与来源位置的比较；不含 req_id，所以本身不能单独证明同毫秒先后。 */
export function compareLogicalOrder(a: LogicalRow, b: LogicalRow): number {
  if (a.started_ms !== b.started_ms) return a.started_ms < b.started_ms ? -1 : 1;
  return Buffer.compare(
    Buffer.from(JSON.stringify([a.sort_source, a.sort_key])),
    Buffer.from(JSON.stringify([b.sort_source, b.sort_key])),
  );
}

/** 遍历顺序：逻辑顺序相同时用 req_id 兜底，保证每次重算的处理次序一致。 */
export function compareTraversalOrder(a: LogicalRow, b: LogicalRow): number {
  return compareLogicalOrder(a, b) || a.req_id - b.req_id;
}

/**
 * 同毫秒里顺序未被证据证明的请求。
 *
 * 整桶出现非账本来源、缺失/非法位置或跨代际时，整桶保守标为未证实；
 * 同代际重复偏移只标重复的那几条。这些请求仍可遍历，但不作为确定祖先或主链根，
 * 同毫秒的工具关系也不能 resolved。
 */
export function uncertainOrderIds(rows: readonly LogicalRow[]): Set<number> {
  const buckets = new Map<number, LogicalRow[]>();
  for (const row of rows) {
    const list = buckets.get(row.started_ms) ?? [];
    list.push(row);
    buckets.set(row.started_ms, list);
  }
  const out = new Set<number>();
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    const positions = bucket.map(ledgerPosition);
    const generation = positions[0]?.generation;
    if (positions.some(position => position === null || position.generation !== generation)) {
      for (const row of bucket) out.add(row.req_id);
      continue;
    }
    const offsets = new Map<bigint, LogicalRow[]>();
    for (const [index, row] of bucket.entries()) {
      const offset = positions[index]!.offset;
      const list = offsets.get(offset) ?? [];
      list.push(row);
      offsets.set(offset, list);
    }
    for (const list of offsets.values()) {
      if (list.length < 2) continue;
      for (const row of list) out.add(row.req_id);
    }
  }
  return out;
}

/**
 * 本笔的语义指纹序列。
 *
 * 返回 null 表示"不可比较"，[] 表示"已保存的真实空消息数组"，两者不能混：
 * 空数组是有效证据（这一笔确实没有消息），会占主链根；无骨架、无消息计数或
 * 引用不完整则说明读不出可比内容，调用方据此判成未知。
 */
export function fingerprintsOf(db: Database, reqId: number): string[] | null {
  const row = db.query<{
    body_state: string; skeleton_z: Uint8Array | null; msg_count: number | null;
  }, [number]>(`SELECT body_state,skeleton_z,msg_count
    FROM request WHERE req_id=?`).get(reqId);
  if (row === null || !['available', 'partial'].includes(row.body_state) ||
      row.skeleton_z === null || row.msg_count === null ||
      !Number.isSafeInteger(row.msg_count) || row.msg_count < 0) return null;
  const refs = db.query<{ ord: number; fingerprint: string }, [number]>(`
    SELECT rb.ord,b.fingerprint FROM request_block rb JOIN block b ON b.id=rb.block
    WHERE rb.req_id=? ORDER BY rb.ord`).all(reqId);
  if (refs.length !== row.msg_count || refs.some((ref, i) =>
      ref.ord !== i || ref.fingerprint.length === 0)) return null;
  return refs.map(ref => ref.fingerprint);
}

/** 首段或末段用户文本：两个方向的唯一差别是扫描次序，取值判据只有一份。 */
function userPreview(db: Database, reqId: number, end: 'first' | 'tail'): string | null {
  const agent = db.query<{ agent: string | null }, [number]>(
    'SELECT agent FROM request WHERE req_id=?',
  ).get(reqId)?.agent ?? null;
  const rows = db.query<{ ord: number; z: Uint8Array }, [number]>(`
    SELECT rb.ord AS ord, b.z AS z FROM request_block rb JOIN block b ON b.id = rb.block
    WHERE rb.req_id=? AND rb.role=0 ORDER BY rb.ord ${end === 'first' ? 'ASC' : 'DESC'} LIMIT 5`).all(reqId);
  for (const row of rows) {
    let message: unknown;
    try {
      message = JSON.parse(zstdDecompressSync(row.z).toString('utf8'));
    } catch {
      continue;
    }
    const input = interpretMessage(message, agent, row.ord).input;
    if (input !== null && input.state === 'text' && input.text.trim().length > 0) {
      return clip(input.text.trim());
    }
  }
  return null;
}

/**
 * 关系未知时折叠行的兜底摘要：正文里最后一条用户文本。
 *
 * 这不是"新增"——界面不能把它标成新增，否则会把旧上下文读成本轮输入。
 * 但折叠行空着同样有害：读者无从判断这笔请求在做什么。
 */
export function tailUserPreview(db: Database, reqId: number): string | null {
  return userPreview(db, reqId, 'tail');
}

/** 标题生成请求的输入里只有被 harness 包起来的用户文本；取第一段可读的。 */
export function firstUserPreview(db: Database, reqId: number): string | null {
  return userPreview(db, reqId, 'first');
}

/**
 * 折叠行摘要与回复形状：都从本笔可读的 reply 一次读出。
 * `shape` 为 null 只表示正文不可读、没有本次重算值，调用方保留旧列。
 */
export type ReplyInfo = { preview: string | null; shape: ReplyShape | null };

export function replyInfoOf(db: Database, reqId: number): ReplyInfo {
  const body = readBodyTx(db, reqId);
  if (body === null) return { preview: null, shape: null };
  const text = assistantText(body.reply) ?? replyToolSummary(body.reply);
  return { preview: text === null ? null : clip(text), shape: replyShapeOf(body.reply) };
}

/** 按消息位置取一行正文消息；缺失或解压失败返回 null。导出给切片摘要阶段复用。 */
export function messageAt(db: Database, reqId: number, ordinal: number): unknown | null {
  const row = db.query<{ z: Uint8Array }, [number, number]>(`
    SELECT b.z AS z FROM request_block rb JOIN block b ON b.id = rb.block
    WHERE rb.req_id=? AND rb.ord=?`).get(reqId, ordinal);
  if (row == null) return null;
  try {
    return JSON.parse(zstdDecompressSync(row.z).toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * 本笔确定增量里的中断计数：判定在共享内核（interruptCountOf 一份），
 * 这里只把 delta 指向的消息逐条读出来。调用方在 delta 为 null 时保留旧值，
 * 不走这条读取路径。
 */
export function interruptCountTx(db: Database, reqId: number,
  delta: readonly number[]): number {
  const messages: unknown[] = [];
  for (const ordinal of delta) messages[ordinal] = messageAt(db, reqId, ordinal);
  return interruptCountOf(messages, delta);
}

/** branch 场合的归档扫描上限：归档消息实测在 user 块 ord 1，上限只防极端正文。 */
const ARCHIVE_SCAN_MESSAGES = 20;

/** 上下文事件位的判定结果；event 为 null 表示这次判不出来，调用方保留旧值。 */
export type ContextEventFacts = {
  event: 'omp_compaction' | 'none' | null;
  droppedChars: number | null;
};

/**
 * 上下文事件位的事务内判定，两条派生路径共用。
 *
 * 判据是「本笔的确定增量里新增了归档消息」：归档消息在会话每笔请求都重发，
 * 按「输入里存在」判会让整场会话每一行都挂压缩标记，降噪变成加噪。
 * branch 关系的消息前缀整体换掉、没有增量可比，按输入含归档归因
 * （bounded 扫描 user 消息）；其余关系没有"新增"可言，返回 null。
 */
export function contextEventTx(db: Database, reqId: number, relation: string | null,
  delta: readonly number[] | null): ContextEventFacts {
  if (relation === 'aux') return { event: 'none', droppedChars: null };
  if (relation === 'branch') {
    const rows = db.query<{ z: Uint8Array }, [number, number]>(`
      SELECT b.z AS z FROM request_block rb JOIN block b ON b.id = rb.block
      WHERE rb.req_id=? AND rb.role=0 ORDER BY rb.ord LIMIT ?`)
      .all(reqId, ARCHIVE_SCAN_MESSAGES);
    for (const row of rows) {
      let message: unknown;
      try {
        message = JSON.parse(zstdDecompressSync(row.z).toString('utf8'));
      } catch {
        continue;
      }
      if (isOmpArchiveMessage(message)) {
        return { event: 'omp_compaction', droppedChars: ompDroppedCharsOf(message) };
      }
    }
    return { event: 'none', droppedChars: null };
  }
  if ((relation === 'first' || relation === 'confirmed') && delta !== null) {
    for (const ordinal of delta) {
      const message = messageAt(db, reqId, ordinal);
      if (isOmpArchiveMessage(message)) {
        return { event: 'omp_compaction', droppedChars: ompDroppedCharsOf(message) };
      }
    }
    return { event: 'none', droppedChars: null };
  }
  return { event: null, droppedChars: null };
}

/** db 版工具结果摘要：按 delta 的原始 ord 稀疏取消息，判定交给共享实现。 */
function toolResultPreview(db: Database, reqId: number, delta: readonly number[],
  associations: readonly ResolvedTool[]): string | null {
  // 稀疏位留给结果提取跳过：ord 必须保持原位置，不能压缩。
  const messages: unknown[] = [];
  for (const ordinal of delta) messages[ordinal] = messageAt(db, reqId, ordinal);
  return toolResultPreviewOf(messages, reqId, associations);
}

/**
 * 展示判定的 db 适配：两条路径的正文读取只有这一份实现，
 * 切片路径与同步路径传同一个构造结果给 `presentationDecision`。
 */
export function presentationPortsOf(db: Database): PresentationPorts {
  return {
    firstUserPreview: reqId => firstUserPreview(db, reqId),
    messageAt: (reqId, ordinal) => messageAt(db, reqId, ordinal),
    toolResultPreview: (reqId, delta, associations) =>
      toolResultPreview(db, reqId, delta, associations),
    tailUserPreview: reqId => tailUserPreview(db, reqId),
  };
}
