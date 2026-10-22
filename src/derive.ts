import type { Database } from 'bun:sqlite';
import { zstdDecompressSync } from 'node:zlib';
import type { Store } from './store';
import { modelTimeTitle } from './sources/magpie';
import { GROUP_ALGORITHM, markGroupDirtyTx } from './derive-state';
import { drainRequestPurposesTx } from './request-purpose';
import { readBodyTx } from './body';
import { assistantText } from './protocols';

/** 从回复里取工具调用；两种协议结构都认。 */
function anthropicReplyCalls(reply: unknown): { id: string; name: string; ord: number }[] {
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) return [];
  const content = (reply as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    // chat 形状：choices[0].message.tool_calls
    const choices = (reply as Record<string, unknown>).choices;
    if (!Array.isArray(choices)) return [];
    const out: { id: string; name: string; ord: number }[] = [];
    for (const choice of choices) {
      if (choice === null || typeof choice !== 'object') continue;
      const message = (choice as Record<string, unknown>).message;
      if (message === null || typeof message !== 'object') continue;
      const calls = (message as Record<string, unknown>).tool_calls;
      if (!Array.isArray(calls)) continue;
      for (const [index, call] of calls.entries()) {
        if (call === null || typeof call !== 'object') continue;
        const record = call as Record<string, unknown>;
        const id = record.id;
        const fn = record.function;
        if (typeof id !== 'string' || fn === null || typeof fn !== 'object') continue;
        out.push({ id, name: String((fn as Record<string, unknown>).name ?? ''), ord: index });
      }
    }
    return out;
  }
  const out: { id: string; name: string; ord: number }[] = [];
  for (const [ord, block] of content.entries()) {
    if (block === null || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if (record.type !== 'tool_use' || typeof record.id !== 'string') continue;
    out.push({ id: record.id, name: String(record.name ?? ''), ord });
  }
  return out;
}

/** 从请求里取工具结果；Anthropic 的 tool_result 与 chat 的 role=tool。 */
function anthropicRequestResults(request: unknown): { id: string; ord: number; path: string; value: unknown }[] {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return [];
  const messages = (request as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return [];
  const out: { id: string; ord: number; path: string; value: unknown }[] = [];
  for (const [ord, message] of messages.entries()) {
    if (message === null || typeof message !== 'object') continue;
    const record = message as Record<string, unknown>;
    if (record.role === 'tool' && typeof record.tool_call_id === 'string') {
      out.push({ id: record.tool_call_id, ord, path: `request.messages[${ord}]`, value: record.content ?? null });
      continue;
    }
    const content = record.content;
    if (!Array.isArray(content)) continue;
    for (const [index, block] of content.entries()) {
      if (block === null || typeof block !== 'object') continue;
      const entry = block as Record<string, unknown>;
      if (entry.type !== 'tool_result' || typeof entry.tool_use_id !== 'string') continue;
      out.push({
        id: entry.tool_use_id, ord,
        path: `request.messages[${ord}].content[${index}]`,
        value: entry.content ?? null,
      });
    }
  }
  return out;
}

/**
 * 派生：前驱关系、确定增量、标题与工具往返。
 *
 * 归属未知（actor_state='unknown'）的请求不参与派生：不进队列、不算增量、
 * 不配工具、标题回落到模型时间。身份确认后才入队，避免跨子代理串数据。
 */

export type SequenceRelation = 'first' | 'confirmed' | 'unknown' | 'branch' | 'aux';

export type SequenceResult = {
  relation: SequenceRelation;
  delta: number[] | null;
};

/**
 * 比较两笔请求的消息序列。只有前驱的序列是本笔的完整前缀时才确认增量；
 * 压缩、裁剪或结构指令变化一律未知，不猜。
 *
 * 传入的是语义指纹而不是块哈希：块哈希带 cache_control，缓存断点一移动
 * 同一段历史就换哈希，会把完整的链读成互不相干的请求。
 */
export function compareSequence(
  previous: readonly string[] | null,
  current: readonly string[],
  hasPredecessor: boolean,
): SequenceResult {
  if (!hasPredecessor) return { relation: 'first', delta: current.map((_, index) => index) };
  if (previous === null || previous.length > current.length ||
      previous.some((id, index) => id !== current[index])) {
    return { relation: 'unknown', delta: null };
  }
  return {
    relation: 'confirmed',
    delta: current.slice(previous.length).map((_, offset) => offset + previous.length),
  };
}

/** 两条序列的公共前缀长度。 */
function commonPrefix(left: readonly string[], right: readonly string[]): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

export type PredecessorMatch = {
  /** 完整前缀匹配到的祖先；null 表示本笔另起一支。 */
  parent: number | null;
  relation: SequenceRelation;
  delta: number[] | null;
  /** 找到的最长部分前缀祖先与它的公共长度，用于说明"最接近的一支"。 */
  near: { reqId: number; shared: number } | null;
};

/**
 * 在链上所有已知祖先里找本笔的前驱。
 *
 * 只看立即前驱不够：一个会话里会并行开出子代理、重放历史、从更早的上下文
 * 分叉。本笔的上下文完整包含了某笔祖先时，那才是真正的前驱，哪怕中间还
 * 夹着别的请求。
 *
 * 判据仍然严格：只有"祖先序列是本笔的完整前缀"才算确认。找不到就另起一支，
 * 并记下最接近的那一支，界面据此说明，而不是只丢一句"无法确认"。
 *
 * @param ancestors 已按时间正序处理过的请求，携带各自的指纹序列
 * @param current 本笔的指纹序列
 * @param hasEarlier 本笔之前还有请求（哪怕它的正文不可读）
 */
export function matchPredecessor(
  ancestors: readonly { reqId: number; fingerprints: readonly string[] }[],
  current: readonly string[],
  hasEarlier = ancestors.length > 0,
): PredecessorMatch {
  let best: { reqId: number; shared: number } | null = null;
  let parent: { reqId: number; length: number } | null = null;

  for (const ancestor of ancestors) {
    const shared = commonPrefix(ancestor.fingerprints, current);
    if (shared > 0 && (best === null || shared > best.shared)) {
      best = { reqId: ancestor.reqId, shared };
    }
    // 完整前缀：祖先整条都在本笔里。取最长的那条，即最深的祖先。
    // shared > 0 排除零长度祖先：空序列是任何序列的前缀，认它当父节点等于
    // 用"这一笔没有消息"证明"本笔续自它"，那是没有证据的边。
    if (shared > 0 && shared === ancestor.fingerprints.length && shared <= current.length
      && (parent === null || ancestor.fingerprints.length > parent.length)) {
      parent = { reqId: ancestor.reqId, length: ancestor.fingerprints.length };
    }
  }

  if (parent !== null) {
    const delta = current.slice(parent.length).map((_, offset) => offset + parent.length);
    return {
      parent: parent.reqId,
      relation: 'confirmed',
      delta,
      near: best,
    };
  }
  // 本组第一笔：没有更早的请求可比，整笔都是新增。
  if (!hasEarlier) {
    return { parent: null, relation: 'first', delta: current.map((_, index) => index), near: null };
  }
  return { parent: null, relation: 'branch', delta: null, near: best };
}

const SYSTEM_TAG = /^\s*<(?:system-reminder|command-[a-z-]+)>[\s\S]*?<\/(?:system-reminder|command-[a-z-]+)>\s*/i;
const CWD_WRAPPER = /^\s*(?:工作目录|working directory|cwd)[:：][^\n]*\n?/i;
/**
 * 会话进行中用户插话时 harness 加的前缀。后面紧跟的才是用户真正说的话，
 * 所以只剥这句提示，不整行丢弃。
 */
const MIDTURN_PREFIX = /^\s*The user sent a new message while you were working:\s*/i;
const MIDTURN_NOTICE = /This is how Claude Code surfaces messages[\s\S]*$/i;
const TITLE_UNICODE_LIMIT = 60;

/**
 * harness 注入的包装：不是用户说的话，不能拿来当标题。
 *
 * `<session>` 是 Claude Code 给会话首轮套的外壳，里面才是用户输入，所以只剥
 * 标签、留内容。其余几种是回显或机器输出，整段丢掉：`<transcript>` 是历史重放，
 * `<command-name>` / `<command-args>` / `<local-command-stdout>` 是斜杠命令的
 * 回显与输出，技能注入以 "Base directory for this skill:" 开头，harness 的
 * "The user stepped away..." 也是它自己生成的。
 */
const UNWRAP_WRAPPERS = [
  // 不能锚定行尾：`</session>` 之后常跟着 harness 追加的一句指令。
  /^\s*<session>([\s\S]*?)<\/session>\s*/i,
];
const DROP_WRAPPERS = [
  /^\s*<transcript>[\s\S]*?<\/transcript>\s*/i,
  /^\s*<local-command-stdout>[\s\S]*?<\/local-command-stdout>\s*/i,
  /^\s*<local-command-caveat>[\s\S]*?<\/local-command-caveat>\s*/i,
  /^\s*<command-name>[\s\S]*?<\/command-name>\s*/i,
  /^\s*<command-message>[\s\S]*?<\/command-message>\s*/i,
  /^\s*<command-args>[\s\S]*?<\/command-args>\s*/i,
  // harness 自己塞的整段通知与回顾，不是用户输入。`<title-request>` 不丢：
  // 它是辅助请求，界面要靠它打标签。
  /^\s*<system-notice>[\s\S]*?<\/system-notice>\s*/i,
  /^\s*<recap>[\s\S]*?<\/recap>\s*/i,
  /^\s*Base directory for this skill:[\s\S]*$/i,
  /^\s*The user stepped away and is coming back\.[\s\S]*$/i,
];

/** 反复剥到不再变化：一次请求里可能连着套好几层包装。 */
function stripHarnessWrappers(text: string): string {
  let current = text.replace(SYSTEM_TAG, '').replace(CWD_WRAPPER, '');
  for (let round = 0; round < 6; round++) {
    const before = current;
    for (const pattern of UNWRAP_WRAPPERS) current = current.replace(pattern, '$1');
    for (const pattern of DROP_WRAPPERS) current = current.replace(pattern, '');
    current = current
      .replace(SYSTEM_TAG, '')
      .replace(CWD_WRAPPER, '')
      .replace(MIDTURN_PREFIX, '')
      .replace(MIDTURN_NOTICE, '')
      .trim();
    if (current === before) break;
  }
  return current;
}

/** 取第一个确定新增 USER 文本的首行；没有可用增量时回落到模型时间。 */
export function deriveTitle(
  messages: readonly unknown[],
  delta: readonly number[] | null,
  fallback: string,
): { title: string; source: 'user_delta' | 'model_time' } {
  if (delta === null) return { title: fallback, source: 'model_time' };
  for (const ordinal of delta) {
    const text = userText(messages[ordinal]);
    if (text === null) continue;
    // 先剥包装再取首行：首行往往正好是被包起来的那一行。
    const cleaned = stripHarnessWrappers(text)
      .split('\n')[0]
      ?.replace(/\s+/g, ' ')
      .trim();
    if (cleaned === undefined || cleaned.length === 0) continue;
    return { title: [...cleaned].slice(0, TITLE_UNICODE_LIMIT).join(''), source: 'user_delta' };
  }
  return { title: fallback, source: 'model_time' };
}

function userText(message: unknown): string | null {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return null;
  const record = message as Record<string, unknown>;
  if (record.role !== 'user') return null;
  const content = record.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (block !== null && typeof block === 'object' && !Array.isArray(block)) {
      const value = (block as Record<string, unknown>).text;
      if (typeof value === 'string') parts.push(value);
    }
  }
  return parts.length === 0 ? null : parts.join('\n');
}

/** 只接受已确认归属的分组；调用方先守卫，这里再挡一层。 */
export function enqueueDerive(store: Store, convKey: string, actor: string, fromSort: string): void {
  store.write(db => enqueueDeriveTx(db, convKey, actor, fromSort));
}

/** 事务内版本：调用方已在事务里时用它，避免嵌套事务。 */
export function enqueueDeriveTx(db: Database, convKey: string, actor: string, fromSort: string): void {
  const known = db.query<{ req_id: number }, [string, string]>(`
    SELECT req_id FROM request
    WHERE conv_key=? AND actor=? AND actor_state='known' LIMIT 1`).get(convKey, actor);
  if (known == null) return;
  markGroupDirtyTx(db, convKey, actor, fromSort);
}

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

type ChainRow = {
  req_id: number; actor: string; actor_state: string; started_ms: number;
  sort_source: string | null; sort_key: string | null;
  prev_req_id: number | null; prev_relation: string | null;
  title_source: string | null; title: string | null; model_served: string | null;
  req_kind: string | null; model_title: string | null; purpose_chain: string;
  input_preview: string | null; input_preview_kind: string | null; reply_preview: string | null;
};

function blocksOf(db: Database, reqId: number): number[] | null {
  const body = db.query<{ body_state: string }, [number]>(
    'SELECT body_state FROM request WHERE req_id=?',
  ).get(reqId);
  if (body == null || (body.body_state !== 'available' && body.body_state !== 'partial')) return null;
  return db.query<{ block: number }, [number]>(
    'SELECT block FROM request_block WHERE req_id=? ORDER BY ord',
  ).all(reqId).map(row => row.block);
}

/**
 * 本笔的语义指纹序列。
 *
 * 返回 null 表示"不可比较"，[] 表示"已保存的真实空消息数组"，两者不能混：
 * 空数组是有效证据（这一笔确实没有消息），会占主链根；无骨架、无消息计数或
 * 引用不完整则说明读不出可比内容，调用方据此判成未知。
 */
function fingerprintsOf(db: Database, reqId: number): string[] | null {
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

/** 摘要长度按 Unicode 字符算，避免把中文截成半个字。 */
const PREVIEW_UNICODE_LIMIT = 90;
/** 工具结果只取开头一小段：折叠行只需要提示这一笔在回传什么。 */
const TOOL_RESULT_PREVIEW_LIMIT = 100;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length <= PREVIEW_UNICODE_LIMIT ? flat : `${chars.slice(0, PREVIEW_UNICODE_LIMIT).join('')}…`;
}

/** 折叠行摘要：本轮新增的用户输入，剥掉 harness 包装后取首段。 */
function previewOf(messages: readonly (unknown | null)[]): string | null {
  for (const message of messages) {
    const text = userText(message);
    if (text === null) continue;
    const cleaned = stripHarnessWrappers(text).trim();
    if (cleaned.length > 0) return clip(cleaned);
  }
  return null;
}

/**
 * 关系未知时折叠行的兜底摘要：正文里最后一条用户文本。
 *
 * 这不是"新增"——界面不能把它标成新增，否则会把旧上下文读成本轮输入。
 * 但折叠行空着同样有害：读者无从判断这笔请求在做什么。
 */
function tailUserPreview(db: Database, reqId: number): string | null {
  const rows = db.query<{ z: Uint8Array }, [number]>(`
    SELECT b.z AS z FROM request_block rb JOIN block b ON b.id = rb.block
    WHERE rb.req_id=? AND rb.role=0 ORDER BY rb.ord DESC LIMIT 5`).all(reqId);
  for (const row of rows) {
    let message: unknown;
    try {
      message = JSON.parse(zstdDecompressSync(row.z).toString('utf8'));
    } catch {
      continue;
    }
    const text = userText(message);
    if (text === null) continue;
    const cleaned = stripHarnessWrappers(text).trim();
    if (cleaned.length > 0) return clip(cleaned);
  }
  return null;
}

/** 标题生成请求的输入里只有被 harness 包起来的用户文本；取第一段可读的。 */
function firstUserPreview(db: Database, reqId: number): string | null {
  const rows = db.query<{ z: Uint8Array }, [number]>(`
    SELECT b.z AS z FROM request_block rb JOIN block b ON b.id = rb.block
    WHERE rb.req_id=? AND rb.role=0 ORDER BY rb.ord ASC LIMIT 5`).all(reqId);
  for (const row of rows) {
    let message: unknown;
    try {
      message = JSON.parse(zstdDecompressSync(row.z).toString('utf8'));
    } catch {
      continue;
    }
    const text = userText(message);
    if (text === null) continue;
    const cleaned = stripHarnessWrappers(text).trim();
    if (cleaned.length > 0) return clip(cleaned);
  }
  return null;
}

/** 链阶段为摘要准备的输入：本轮关系、当前可读序列与用途结论。 */
type PresentationInput = {
  row: ChainRow; current: readonly string[] | null;
  replyInfo: ReplyInfo; isAux: boolean; isTitle: boolean; modelTitle: string | null;
  match: PredecessorMatch;
};

/**
 * 写标题与折叠行摘要。必须在工具配对之后调用：增量里的工具结果轮次
 * 只能消费本次确定下来的关联，不能跨组按 call_id 取首行。
 *
 * 正文可读时标题从当前输入重算，不沿用旧派生值；正文不可读时旧标题与旧摘要
 * 原样保留——那是当时按正文算出来的，没有正文重算只会把它们降级成时间兜底。
 */
function writePresentationTx(db: Database, input: PresentationInput,
  associations: readonly ResolvedTool[], group: QueuedGroup): void {
  const { row, current, replyInfo, isAux, isTitle, modelTitle, match } = input;
  const delta = match.delta;
  const fallback = modelTimeTitle(row.model_served, row.started_ms);
  let title = fallback;
  let source: 'user_delta' | 'model_time' | 'model_title' = 'model_time';
  let inputPreview: string | null = null;
  let inputKind: 'delta' | 'tail' | 'tool_result' | 'title' | null = null;
  if (isTitle) {
    // 标题请求不产生用户标题；它的正式标题只来自用途阶段写下的 model_title。
    title = modelTitle ?? (current === null ? row.title ?? fallback : fallback);
    source = modelTitle !== null ? 'model_title'
      : current === null && row.title_source === 'model_title' ? 'model_title' : 'model_time';
    inputPreview = firstUserPreview(db, row.req_id) ?? '生成会话标题';
    inputKind = 'title';
  } else if (current === null) {
    // 正文已回收：旧标题与旧摘要都是当时按正文算出来的，原样保留。
    title = row.title ?? fallback;
    source = row.title_source === 'user_delta' || row.title_source === 'model_time'
      || row.title_source === 'model_title' ? row.title_source : 'model_time';
    inputPreview = row.input_preview;
    inputKind = row.input_preview_kind === 'delta' || row.input_preview_kind === 'tail'
      || row.input_preview_kind === 'tool_result' || row.input_preview_kind === 'title'
      ? row.input_preview_kind : null;
  } else {
    // 排除用途但不是标题请求：不把用户增量变成标题，只用已存的模型标题或时间兜底。
    // 输入摘要仍按同一套关系取值，不为 aux 另写一份规则。
    if (isAux) {
      title = modelTitle ?? fallback;
      source = modelTitle !== null ? 'model_title' : 'model_time';
    }
    if (delta !== null && delta.length > 0) {
      // delta 里存的是本笔的 ord；取出对应消息后按 0..n-1 重新编号给 deriveTitle。
      const messages = delta.map(ordinal => messageAt(db, row.req_id, ordinal));
      if (!isAux) {
        const derived = deriveTitle(messages, delta.map((_, index) => index), fallback);
        title = derived.title;
        source = derived.source;
      }
      // 增量里常常只有工具结果或系统消息，没有用户文本。
      // 有用户文本才标成"新增"；否则照实说这一轮回传了什么工具结果。
      // 不要回退到"末轮输入"——那会把同一句旧用户消息重复到每一笔请求上。
      const fresh = previewOf(messages);
      if (fresh !== null) {
        inputPreview = fresh;
        inputKind = 'delta';
      } else {
        inputPreview = toolResultPreview(db, row.req_id, delta, associations);
        inputKind = inputPreview === null ? null : 'tool_result';
      }
    } else if (delta !== null) {
      // 这一笔没有新增消息：输入就是上一轮的工具结果，摘要照实说。
      inputPreview = '输入是上一轮的工具结果，没有新的用户消息';
      inputKind = 'tool_result';
    } else {
      // 关系未知、另起一支或排除用途：没有"新增"可言，但折叠行仍要有东西可读。
      // 取正文里最后一条用户消息，界面会把它标成"末轮输入"而不是"新增"。
      inputPreview = tailUserPreview(db, row.req_id);
      inputKind = inputPreview === null ? null : 'tail';
    }
  }
  const replyPreview = current === null ? row.reply_preview : replyInfo.preview;
  // 摘要与标题是派生结果，不是来源事实：可比较时记下算法与本次消费的输入身份，
  // 不可比较时保留原算法与 basis 只把状态标成 retained——不能把旧值冒充成本次重算。
  const inputRow = db.query<{ input_epoch: string; input_revision: number }, [number]>(
    'SELECT input_epoch,input_revision FROM request WHERE req_id=?').get(row.req_id);
  const basis = JSON.stringify({
    epoch: inputRow?.input_epoch ?? '', input_revision: inputRow?.input_revision ?? 0,
    group_epoch: group.group_epoch, algorithm: GROUP_ALGORITHM,
  });
  const comparable = current !== null;
  db.run(`UPDATE request SET title=?,title_source=?,input_preview=?,
    input_preview_kind=?,reply_preview=?,derive_version=derive_version+1,
    summary_algorithm=CASE WHEN ?=1 THEN ? ELSE summary_algorithm END,
    summary_basis=CASE WHEN ?=1 THEN ? ELSE summary_basis END,
    summary_state=CASE WHEN ?=1 THEN 'recomputed' ELSE 'retained' END
    WHERE req_id=?`, [
    title, source, inputPreview, inputKind, replyPreview,
    comparable ? 1 : 0, GROUP_ALGORITHM, comparable ? 1 : 0, basis, comparable ? 1 : 0,
    row.req_id,
  ]);
}

/** 工具结果内容压平；数组形状里只取 text 块。 */
function flattenToolContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const block of value) {
      if (typeof block === 'string') {
        parts.push(block);
        continue;
      }
      if (block === null || typeof block !== 'object') continue;
      const text = (block as Record<string, unknown>).text;
      if (typeof text === 'string') parts.push(text);
    }
    return parts.join(' ');
  }
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/**
 * 增量里没有用户文本时的输入摘要：这一笔回传的工具结果。
 *
 * 名字只从本次配对确定下来的关联取，按调用位置与结果 path 精确定位；
 * 不查上一轮表、其它组或不可重算的保留行。顺序按消息出现顺序，同名合并计数。
 */
function toolResultPreview(db: Database, reqId: number, delta: readonly number[],
  associations: readonly ResolvedTool[]): string | null {
  const names: string[] = [];
  let content: string | null = null;
  // 稀疏位留给结果提取跳过：ord 必须保持原位置，不能压缩。
  const messages: unknown[] = [];
  for (const ordinal of delta) messages[ordinal] = messageAt(db, reqId, ordinal);
  for (const result of anthropicRequestResults({ messages })) {
    const matches = associations.filter(link => link.resultReq === reqId
      && link.resultOrd === result.ord && link.resultPath === result.path
      && link.callId === result.id);
    if (matches.length === 1 && matches[0]!.name.length > 0) names.push(matches[0]!.name);
    if (content !== null) continue;
    const flat = flattenToolContent(result.value).replace(/\s+/g, ' ').trim();
    if (flat.length > 0) content = flat;
  }
  if (names.length > 0) {
    const counts = new Map<string, number>();
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    const parts = [...counts].map(([name, count]) => count > 1 ? `${name} ×${count}` : name);
    return clip(`工具结果 · ${parts.join(', ')}`);
  }
  if (content === null) return null;
  const chars = [...content];
  const truncated = chars.length <= TOOL_RESULT_PREVIEW_LIMIT
    ? content
    : `${chars.slice(0, TOOL_RESULT_PREVIEW_LIMIT).join('')}…`;
  return `工具结果 · ${truncated}`;
}

/** 回复没有文本时的兜底：这一笔发起的工具调用名，按出现顺序列出。 */
function replyToolSummary(reply: unknown): string | null {
  const calls = anthropicReplyCalls(reply);
  if (calls.length === 0) return null;
  const names = calls.map(call => call.name.length > 0 ? call.name : 'unknown');
  return `工具调用 · ${names.join(', ')}`;
}

/** 折叠行摘要：回复文本首段；没有文本时退到工具调用名。 */
type ReplyInfo = { preview: string | null };

function replyInfoOf(db: Database, reqId: number): ReplyInfo {
  const body = readBodyTx(db, reqId);
  if (body === null) return { preview: null };
  const text = assistantText(body.reply) ?? replyToolSummary(body.reply);
  return { preview: text === null ? null : clip(text) };
}

function messageAt(db: Database, reqId: number, ordinal: number): unknown | null {
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
 * 主链判定。同一 (conv_key, actor) 里可能同时存在几条互不相接的真实请求链
 * （标题请求已在派生时排除）。会话的第一笔真实请求是主链根，其余根及其
 * 后继标 branch——分支是相对"从第一笔开始的主线"而言，不是按后续请求数
 * 重新选一次主线，否则一次后来的独立重跑会把真正的开头挤成分支。
 *
 * 严格前缀只能说明"这一笔是谁的续写"，不能说明"哪条是主线"；主线要等整组
 * 请求都到齐后再按根的时间顺序选，所以每批派生末尾重算一次。
 *
 * 正文不可读（prev_relation='unknown'）的请求不进森林：它们没有可比对象，
 * 既不能证明在主链上，也不能证明是分支，保持中性的 main，不误标分支。
 */
function assignChainRoles(db: Database, convKey: string, actor: string): void {
  const rows = db.query<{ req_id: number; prev_req_id: number | null; started_ms: number;
    sort_source: string | null; sort_key: string | null }, [string, string]>(`
    SELECT req_id, prev_req_id, started_ms, sort_source, sort_key FROM request
    WHERE conv_key=? AND actor=? AND actor_state='known' AND purpose_chain='participate'
      AND (prev_relation IS NULL OR prev_relation != 'unknown')
    ORDER BY started_ms ASC, req_id ASC`).all(convKey, actor);
  // 按时间与来源位置遍历，第一个根就是逻辑上最早的根；req_id 只兜底同位置。
  const ordered = [...rows].sort(compareTraversalOrder);
  const first = ordered[0];
  if (first === undefined) return;
  const ids = new Set(ordered.map(row => row.req_id));
  const children = new Map<number, number[]>();
  const roots: number[] = [];
  for (const row of ordered) {
    if (row.prev_req_id === null || !ids.has(row.prev_req_id)) {
      roots.push(row.req_id);
      continue;
    }
    const list = children.get(row.prev_req_id);
    if (list === undefined) children.set(row.prev_req_id, [row.req_id]);
    else list.push(row.req_id);
  }
  const trunkRoot = roots[0] ?? first.req_id;
  const trunk = new Set<number>();
  const stack = [trunkRoot];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || trunk.has(id)) continue;
    trunk.add(id);
    for (const child of children.get(id) ?? []) stack.push(child);
  }
  const update = db.prepare('UPDATE request SET chain_role=? WHERE req_id=?');
  for (const row of rows) update.run(trunk.has(row.req_id) ? 'main' : 'branch', row.req_id);
}

/** 离线维护只处理目标会话，不消费其它会话的任务。 */
export type DeriveScope = { convKey: string };

export type DrainResult = {
  processed: number;
  /** 当前 scope 内未完成组；省略 scope 时是全队列。 */
  remaining: number;
  /** 全部阶段已提交的组。 */
  groups: Group[];
  /** 本批具有可比较消息序列的请求，包括真实空数组。 */
  recomputed: number;
  /** 消息序列不可比较、标题与摘要按旧值保留的请求。 */
  retained: number;
  /** 本批完成用途判定的请求数。 */
  purpose_processed: number;
  /** 当前 scope 内仍待判定用途的请求数；未完成时组不能被宣布为最新。 */
  purpose_remaining: number;
};

export type DrainOptions = { limit: number; scope?: DeriveScope; purposeLimit?: number };

/**
 * 处理队列里的一批分组。每个分组按稳定顺序从头重算整条链：
 * 这样乱序到达、迟到正文与归属变化都收敛到同一个结果，与到达顺序无关。
 *
 * 链、主链角色、工具配对、摘要与队列确认在同一个同步事务内按序完成；
 * 任一阶段失败，整批回滚并保留任务。
 *
 * 这是迁移与在线共用的唯一完成入口：链、工具与摘要都没有各自的完成出口，
 * 因为任何一段单独提交都会留下"部分更新"的组。
 */
export function drainDeriveTx(db: Database, options: DrainOptions): DrainResult {
  const { limit, scope } = options;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid_derive_limit');
  if (scope !== undefined && (typeof scope.convKey !== 'string' || scope.convKey.length === 0)) {
    throw new Error('invalid_derive_scope');
  }
  // 先完成请求用途：组阶段只消费已经定下来的用途，不在组里再识别一次。
  //
  // `limit` 按组计数，而组的完成条件是"组内没有 pending"：本次要处理的组里
  // 所有成员都必须先结算，否则一个大组会被切到多轮、迟迟不能发布。
  // `purposeLimit` 是每批大小，不是总量上限；每次都会推进，错误重试到顶后
  // 该行以 error 终态出列，所以循环会结束。
  const purposeLimit = options.purposeLimit ?? 100;
  let purposeProcessed = 0;
  let purposeRemaining = 0;
  for (;;) {
    const batch = drainRequestPurposesTx(db, purposeLimit, scope);
    purposeProcessed += batch.processed;
    purposeRemaining = batch.remaining;
    if (batch.remaining === 0 || batch.processed === 0) break;
  }
  const columns = 'conv_key,actor,group_epoch,input_revision,target_algorithm';
  const groups = scope === undefined
    ? db.query<QueuedGroup, [number]>(`SELECT ${columns} FROM derive_queue
        WHERE state<>'clean' ORDER BY conv_key,actor LIMIT ?`).all(limit)
    : db.query<QueuedGroup, [string, number]>(`SELECT ${columns} FROM derive_queue
        WHERE conv_key=? AND state<>'clean' ORDER BY actor LIMIT ?`).all(scope.convKey, limit);
  const touched: Group[] = [];
  let processed = 0;
  let recomputed = 0;
  let retained = 0;
  for (const group of groups) {
    // 组里还有未判定用途的请求时不能完成：把组算干净等于替它们猜了一个用途。
    const waiting = db.query<{ n: number }, [string, string]>(`
      SELECT COUNT(*) AS n FROM request
      WHERE conv_key=? AND actor=? AND actor_state='known' AND purpose_pending=1`)
      .get(group.conv_key, group.actor)!.n;
    if (waiting > 0) continue;
    const rows = db.query<ChainRow, [string, string]>(`
      SELECT req_id, actor, actor_state, started_ms, sort_source, sort_key, prev_req_id, prev_relation,
             title_source, title, model_served, req_kind, model_title, purpose_chain,
             input_preview, input_preview_kind, reply_preview
      FROM request WHERE conv_key=? AND actor=? AND actor_state='known'`).all(group.conv_key, group.actor);
    const ordered = [...rows].sort(compareTraversalOrder);
    // 同毫秒且没有来源位置证据的请求：可以遍历，但不能用来证明先后。
    const uncertain = uncertainOrderIds(ordered);
    // 本组已处理过的请求，供后面每一笔在链上找前驱。按正序推进，
    // 所以这里只会看到"早于本笔"的祖先。
    const ancestors: { reqId: number; fingerprints: readonly string[] }[] = [];
    // 有正文不可读的祖先时，链是断的：后面那些请求即使对不上已知祖先，
    // 也只能算"没法比"，不能断言成"另起一支"。
    let sawEarlier = false;
    let unreadableEarlier = false;
    // 链阶段只收集；工具与摘要依赖本次配对，必须等全部关系确定后再写。
    const pairRows: PairRow[] = [];
    const presentations: PresentationInput[] = [];
    for (const row of ordered) {
      const current = fingerprintsOf(db, row.req_id);
      const replyInfo = current === null
        ? { preview: row.reply_preview, modelTitle: null }
        : replyInfoOf(db, row.req_id);
      // 用途已在请求阶段定下来：组阶段只消费 purpose_chain 与 req_kind，
      // 不再自己认一遍标题或分类器请求。两处各认一次就会出现"用途说是 chat、
      // 关系却按 title 算"的分裂。
      const isAux = row.purpose_chain === 'exclude';
      const isTitle = row.req_kind === 'title';
      const modelTitle = row.model_title;
      let match: PredecessorMatch;
      if (isAux) {
        match = { parent: null, relation: 'aux', delta: null, near: null };
      } else if (current === null) {
        // 本笔正文不可读：没法比，但也不能把上一笔的结论照抄过来。
        match = { parent: null, relation: 'unknown', delta: null, near: null };
      } else if (uncertain.has(row.req_id)) {
        // 顺序未证实：同毫秒的来源身份只够排序，不够当因果证据。
        match = { parent: null, relation: 'unknown', delta: null, near: null };
      } else {
        const found = matchPredecessor(ancestors, current, sawEarlier);
        match = found.relation === 'branch' && unreadableEarlier
          ? { ...found, relation: 'unknown' }
          : found;
      }
      if (!isAux) {
        // 排除用途是旁路，不能让后面的主请求误以为"前面还有一笔可比的请求"。
        sawEarlier = true;
        if (current === null || uncertain.has(row.req_id)) unreadableEarlier = true;
      }

      const delta = match.delta;
      const deltaJson = delta === null ? null : JSON.stringify(delta);
      // 关系是本阶段唯一的写入；标题、摘要与版本留到工具配对之后。
      // req_kind/model_title 属于请求用途，不在这里覆盖。
      db.run(`UPDATE request SET prev_req_id=?,prev_relation=?,delta_ordinals=?,
        chain_role=? WHERE req_id=?`, [
        match.parent, match.relation, deltaJson,
        isAux ? 'aux' : 'main', row.req_id,
      ]);
      pairRows.push({ ...row,
        prev_relation: match.relation, delta_ordinals: deltaJson });
      presentations.push({ row, current, replyInfo, isAux, isTitle, modelTitle, match });
      if (current === null) retained += 1;
      else recomputed += 1;
      if (!isAux && current !== null && !uncertain.has(row.req_id)) {
        ancestors.push({ reqId: row.req_id, fingerprints: current });
      }
      processed += 1;
    }
    assignChainRoles(db, group.conv_key, group.actor);
    const paired = pairToolCallsTx(db, group, pairRows, uncertain);
    for (const input of presentations) {
      writePresentationTx(db, input, paired.associations, group);
    }
    // 完成只在消费的修订仍是当前修订时才成立：同一事务里后到的输入变化
    // 会抬高 input_revision，CAS 失败即整批回滚，旧完成记录不会覆盖新输入。
    const changed = db.run(
      `UPDATE derive_queue SET state='clean',dirty_since_ms=NULL,
         published_revision=?,published_algorithm=?
       WHERE conv_key=? AND actor=? AND group_epoch=? AND input_revision=? AND target_algorithm=?`,
      [group.input_revision, group.target_algorithm, group.conv_key, group.actor,
        group.group_epoch, group.input_revision, group.target_algorithm],
    ).changes;
    if (changed !== 1) throw new Error('derive_input_changed');
    touched.push({ conv_key: group.conv_key, actor: group.actor });
  }
  // clean 行是持久完成记录，不是积压。
  const remaining = scope === undefined
    ? db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM derive_queue WHERE state<>'clean'`).get()!.n
    : db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM derive_queue
        WHERE conv_key=? AND state<>'clean'`).get(scope.convKey)!.n;
  return {
    processed, remaining, groups: touched, recomputed, retained,
    purpose_processed: purposeProcessed, purpose_remaining: purposeRemaining,
  };
}

/**
 * 在线入口：校验参数后在自己的写事务里跑一次完整排空。
 *
 * 迁移与维护直接调用 `drainDeriveTx`，因为它们要把多个批次放进同一个事务；
 * 在线调度只需要"一批一组事务"，不需要知道事务边界。
 */
export function drainDerive(store: Store, limit = 100, scope?: DeriveScope): DrainResult {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid_derive_limit');
  if (scope !== undefined && (typeof scope.convKey !== 'string' || scope.convKey.length === 0)) {
    throw new Error('invalid_derive_scope');
  }
  return store.write(db => drainDeriveTx(db, { limit, scope }));
}

type Group = { conv_key: string; actor: string };

/** 取组时一并读出的完成身份；ack 用它与当前行比对，防止覆盖后到的输入变化。 */
type QueuedGroup = Group & {
  group_epoch: string; input_revision: number; target_algorithm: number;
};

/** 工具配对消费的行：链阶段刚写下的关系、顺序与用途结论。 */
export type PairRow = LogicalRow & {
  req_kind: string | null; purpose_chain: string;
  prev_relation: string | null; delta_ordinals: string | null;
};

/** 本次确定下来的一个工具往返：调用位置与结果位置都精确到 ord 与 path。 */
export type ResolvedTool = {
  callReq: number; callOrd: number; callId: string; name: string;
  resultReq: number; resultOrd: number; resultPath: string;
};

type PairResult = {
  resolved: number; ambiguous: number; pending: number;
  associations: ResolvedTool[];
};

/**
 * 工具往返的事务内实现。外部不再导出独立入口：完整的完成入口是 `drainDerive`，
 * 它保证配对之后还有摘要与队列确认。
 */
function pairToolCallsTx(db: Database, group: Group, ordered: readonly PairRow[],
  uncertain: ReadonlySet<number>): PairResult {
  const rows = ordered;
  if (rows.length === 0) return { resolved: 0, ambiguous: 0, pending: 0, associations: [] };

  // 先清空本组旧配对，再按当前数据重建；配对是可变状态，重算比增量修补更不容易漂移。
  // 正文已回收的请求不在重算范围内：它们的块已经不在，从空数据重配只会把原有关系抹掉，
  // 所以只删正文仍可读的那部分，其余行保持原样。
  db.run(`
    DELETE FROM tool_call WHERE req_id IN (
      SELECT req_id FROM request WHERE conv_key=? AND actor=? AND actor_state='known'
        AND body_state IN ('available','partial'))`,
  [group.conv_key, group.actor]);

  type Call = { req_id: number; ord: number; call_id: string; name: string; index: number };
  const calls: Call[] = [];
  const results: { req_id: number; index: number; ord: number; path: string; call_id: string; value: unknown; confirmed: boolean }[] = [];

  for (const [index, row] of rows.entries()) {
    // 排除用途是旁路：不进入工具候选，与它不进祖先集合同一个理由。
    if (row.purpose_chain === 'exclude') continue;
    const body = readBodyTx(db, row.req_id);
    if (body === null) continue;
    // 结果是否落在确定增量的 ord 上；unknown/first 的规则不同。
    const delta = row.delta_ordinals === null ? null : JSON.parse(row.delta_ordinals) as number[];
    const ordinalConfirmed = (ord: number): boolean =>
      row.prev_relation === 'first' || row.prev_relation === 'confirmed'
        ? (row.prev_relation === 'first' ? true : delta !== null && delta.includes(ord))
        : false;
    for (const block of anthropicReplyCalls(body.reply)) {
      calls.push({ req_id: row.req_id, ord: block.ord, call_id: block.id, name: block.name, index });
    }
    for (const result of anthropicRequestResults(body.request)) {
      results.push({
        req_id: row.req_id, index, ord: result.ord, path: result.path,
        call_id: result.id, value: result.value, confirmed: ordinalConfirmed(result.ord),
      });
    }
  }

  const byCallId = new Map<string, Call[]>();
  for (const call of calls) {
    const list = byCallId.get(call.call_id) ?? [];
    list.push(call);
    byCallId.set(call.call_id, list);
  }

  let resolved = 0;
  let ambiguous = 0;
  let pending = 0;
  for (const call of calls) {
    const candidates = byCallId.get(call.call_id) ?? [];
    const state = candidates.length > 1 ? 'ambiguous' : 'pending';
    if (state === 'ambiguous') ambiguous += 1;
    else pending += 1;
    db.run(
      `INSERT INTO tool_call(call_id,req_id,ord,tool_name,result_req,result_ord,result_path,state,derive_version,
         algorithm_version,basis_json,retention_state)
       VALUES (?,?,?,?,NULL,NULL,NULL,?,1,?,?,'recomputed')`,
      [call.call_id, call.req_id, call.ord, call.name, state, GROUP_ALGORITHM, toolBasis(group, call.call_id)],
    );
  }

  for (const result of results) {
    const candidates = byCallId.get(result.call_id) ?? [];
    if (candidates.length === 0) continue;
    if (candidates.length > 1) {
      // 多候选保持 ambiguous，结果位置仍然记下，便于人工核对。
      for (const call of candidates) {
        db.run(
          `UPDATE tool_call SET result_req=?, result_ord=?, result_path=?, state='ambiguous'
           WHERE req_id=? AND ord=?`,
          [result.req_id, result.ord, result.path, call.req_id, call.ord],
        );
      }
      continue;
    }
    const call = candidates[0]!;
    // 结果必须晚于调用。同一毫秒且顺序未证实时不配对：身份字典序不是证据。
    const callRow = rows[call.index]!;
    const resultRow = rows[result.index]!;
    if (compareLogicalOrder(callRow, resultRow) >= 0) continue;
    if (callRow.started_ms === resultRow.started_ms
      && (uncertain.has(callRow.req_id) || uncertain.has(resultRow.req_id))) continue;
    // 后续请求会重发整段历史，同一结果会反复出现。已确认的配对是终态，
    // 重发样本只可能把它降级成 pending，因此直接跳过。
    const paired = db.query<{ state: string }, [number, number]>(
      'SELECT state FROM tool_call WHERE req_id=? AND ord=?',
    ).get(call.req_id, call.ord);
    if (paired?.state === 'resolved') continue;
    if (!result.confirmed) {
      // 增量关系未知：只建立候选，不标 resolved。若这一格此前已有候选位置，
      // 保留更早的那个位置——候选只记首次见到的地方。
      if (paired?.state === 'pending') continue;
      db.run(
        `UPDATE tool_call SET result_req=?, result_ord=?, result_path=?, state='pending'
         WHERE req_id=? AND ord=?`,
        [result.req_id, result.ord, result.path, call.req_id, call.ord],
      );
      continue;
    }
    db.run(
      `UPDATE tool_call SET result_req=?, result_ord=?, result_path=?, state='resolved'
       WHERE req_id=? AND ord=?`,
      [result.req_id, result.ord, result.path, call.req_id, call.ord],
    );
    resolved += 1;
  }

  // 本次确定下来的关联：只从本轮新建且最终 resolved 的调用行形成。
  const associations: ResolvedTool[] = [];
  for (const call of calls) {
    const row = db.query<{
      state: string; result_req: number | null; result_ord: number | null; result_path: string | null;
    }, [number, number]>(`SELECT state,result_req,result_ord,result_path
      FROM tool_call WHERE req_id=? AND ord=?`).get(call.req_id, call.ord);
    if (row?.state !== 'resolved' || row.result_req === null
      || row.result_ord === null || row.result_path === null) continue;
    associations.push({
      callReq: call.req_id, callOrd: call.ord, callId: call.call_id, name: call.name,
      resultReq: row.result_req, resultOrd: row.result_ord, resultPath: row.result_path,
    });
  }

  // 保留行原 metadata 不动，只标出它们本轮没有被重算：正文已回收的请求不在
  // 重建范围内，把它们的算法版本提升到本次版本等于声称重算过。
  db.run(
    `UPDATE tool_call SET retention_state='retained' WHERE req_id IN (
      SELECT req_id FROM request WHERE conv_key=? AND actor=? AND actor_state='known'
        AND body_state NOT IN ('available','partial'))`,
    [group.conv_key, group.actor],
  );
  return { resolved, ambiguous, pending, associations };
}

/** 一条工具行的算法依据：组身份与调用身份，足以复现配对输入。 */
function toolBasis(group: Group, callId: string): string {
  return JSON.stringify({ group: [group.conv_key, group.actor], call_id: callId, algorithm: GROUP_ALGORITHM });
}

/** 工具往返的独立入口：维护与回填脚本迁移完成前仍可用，不参与摘要。 */
export type RebuildReport = {
  queued: number;
  unavailable: number;
  /** 按原因分类的不可用请求数；只有正文可读的请求会被真正重算。 */
  reasons: Record<string, number>;
};

/** 这笔请求的证据在 raw 层是否还有原文（hook 或账本文件那一段）。 */
function hasRawEvidence(db: Database, reqId: number): boolean {
  const rows = db.query<{ source_kind: string; ref_key: string }, [number]>(
    'SELECT source_kind, ref_key FROM request_evidence WHERE req_id=?').all(reqId);
  for (const row of rows) {
    if (row.source_kind === 'hook') {
      if (db.query('SELECT 1 FROM raw_hook WHERE hook_id=?').get(row.ref_key) !== null) return true;
      continue;
    }
    if (row.source_kind !== 'ledger') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.ref_key);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed) || parsed[0] !== 'file' || typeof parsed[1] !== 'string' || typeof parsed[2] !== 'number') continue;
    if (db.query('SELECT 1 FROM raw_ledger WHERE source_kind=? AND file_generation=? AND byte_offset=?')
      .get('file', parsed[1], parsed[2]) !== null) return true;
  }
  return false;
}

/**
 * 维护命令：整条链重排一次；正文不可用的请求保持未知。
 *
 * 返回不可用的数量与原因，调用方据此决定要不要继续处理：正文和 raw 都没了的
 * 请求没法重算，旧标题与工具关系也不该被重写成空。
 */
export function rebuildDerived(store: Store, convKey: string): RebuildReport {
  return store.write(db => {
    const actors = db.query<{ actor: string }, [string]>(`
      SELECT DISTINCT actor FROM request
      WHERE conv_key=? AND actor IS NOT NULL AND actor_state='known'`).all(convKey);
    let unavailable = 0;
    const reasons: Record<string, number> = {};
    const bump = (reason: string): void => {
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    };
    for (const { actor } of actors) {
      const missing = db.query<{ req_id: number; body_state: string }, [string, string]>(`
        SELECT req_id, body_state FROM request
        WHERE conv_key=? AND actor=? AND actor_state='known'
          AND body_state NOT IN ('available','partial')`).all(convKey, actor);
      unavailable += missing.length;
      for (const row of missing) {
        if (row.body_state !== 'evicted') {
          bump(`body_${row.body_state}`);
        } else {
          bump(hasRawEvidence(db, row.req_id) ? 'body_evicted_raw_present' : 'body_evicted_raw_expired');
        }
      }
      markGroupDirtyTx(db, convKey, actor, '');
    }
    return { queued: actors.length, unavailable, reasons };
  });
}
