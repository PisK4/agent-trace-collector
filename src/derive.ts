import type { Database } from 'bun:sqlite';
import { zstdDecompressSync } from 'node:zlib';
import type { Store } from './store';

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
    if (shared === ancestor.fingerprints.length && shared <= current.length
      && (parent === null || ancestor.fingerprints.length > parent.length)) {
      parent = { reqId: ancestor.reqId, length: ancestor.fingerprints.length };
    }
  }

  if (parent !== null) {
    const delta = current.slice(parent.length).map((_, offset) => offset + parent.length);
    return {
      parent: parent.reqId,
      relation: parent.length === 0 ? 'first' : 'confirmed',
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
  db.run(
    `INSERT INTO derive_queue(conv_key,actor,from_sort) VALUES (?,?,?)
     ON CONFLICT(conv_key,actor) DO UPDATE SET from_sort=MIN(derive_queue.from_sort,excluded.from_sort)`,
    [convKey, actor, fromSort],
  );
}

/** 稳定排序键：优先账本物理位置，其次是时间与请求号。 */
function sortKeyOf(row: {
  sort_source: string | null; sort_key: string | null; started_ms: number; req_id: number;
}): string {
  if (row.sort_source !== null && row.sort_key !== null) return row.sort_key;
  return `time|${String(row.started_ms).padStart(16, '0')}|${String(row.req_id).padStart(20, '0')}`;
}

type ChainRow = {
  req_id: number; actor: string; actor_state: string; started_ms: number;
  sort_source: string | null; sort_key: string | null;
  prev_req_id: number | null; prev_relation: string | null;
  title_source: string | null; title: string | null; model_served: string | null;
  req_kind: string | null; model_title: string | null;
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
 * 本笔的语义指纹序列。正文不可读时返回 null，调用方据此判成未知，
 * 不拿空序列去冒充"这一笔没有消息"。
 */
function fingerprintsOf(db: Database, reqId: number): string[] | null {
  const body = db.query<{ body_state: string }, [number]>(
    'SELECT body_state FROM request WHERE req_id=?',
  ).get(reqId);
  if (body == null || (body.body_state !== 'available' && body.body_state !== 'partial')) return null;
  return db.query<{ fingerprint: string }, [number]>(`
    SELECT b.fingerprint AS fingerprint FROM request_block rb JOIN block b ON b.id = rb.block
    WHERE rb.req_id=? ORDER BY rb.ord`).all(reqId).map(row => row.fingerprint);
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

/** 从一条消息里取工具结果：Anthropic 的 tool_result 块与 chat 的 role=tool。 */
function toolResultsOf(message: unknown): { callId: string; value: unknown }[] {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return [];
  const record = message as Record<string, unknown>;
  if (record.role === 'tool') {
    if (typeof record.tool_call_id !== 'string') return [];
    return [{ callId: record.tool_call_id, value: record.content ?? null }];
  }
  if (!Array.isArray(record.content)) return [];
  const out: { callId: string; value: unknown }[] = [];
  for (const block of record.content) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue;
    const entry = block as Record<string, unknown>;
    if (entry.type !== 'tool_result' || typeof entry.tool_use_id !== 'string') continue;
    out.push({ callId: entry.tool_use_id, value: entry.content ?? null });
  }
  return out;
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
 * 名字从 tool_call 表按 call_id 查；derive 早于本轮的 pairToolCalls，查不到
 * 是预期情况，此时退回结果内容本身。顺序按消息出现顺序，同名合并计数。
 */
function toolResultPreview(db: Database, reqId: number, delta: readonly number[]): string | null {
  const names: string[] = [];
  let content: string | null = null;
  for (const ordinal of delta) {
    for (const result of toolResultsOf(messageAt(db, reqId, ordinal))) {
      const row = db.query<{ tool_name: string | null }, [string]>(
        'SELECT tool_name FROM tool_call WHERE call_id=? LIMIT 1').get(result.callId);
      if (row?.tool_name != null && row.tool_name.length > 0) names.push(row.tool_name);
      if (content !== null) continue;
      const flat = flattenToolContent(result.value).replace(/\s+/g, ' ').trim();
      if (flat.length > 0) content = flat;
    }
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

/**
 * 标题请求的回复是 `<title>` 标签或 `{"title":"…"}` JSON；折叠行里展示内容，
 * 不展示标签属性或 JSON 外壳。其余回复原样返回。
 */
const TITLE_TAG_REPLY = /^<title\b[^>]*>([\s\S]*?)<\/title>\s*$/i;

function titleOfReply(text: string): string | null {
  const trimmed = text.trim();
  const tagged = TITLE_TAG_REPLY.exec(trimmed)?.[1]?.replace(/\s+/g, ' ').trim();
  if (tagged !== undefined && tagged.length > 0) return tagged;
  if (!trimmed.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 1 || typeof record.title !== 'string') return null;
    const title = record.title.replace(/\s+/g, ' ').trim();
    return title.length > 0 ? title : null;
  } catch {
    return null;
  }
}

/** 折叠行摘要：回复文本首段；标题回复只留标题，并单独返回给会话标题用。 */
type ReplyInfo = { preview: string | null; modelTitle: string | null };

function replyInfoOf(db: Database, reqId: number): ReplyInfo {
  const row = db.query<{ skeleton_z: Uint8Array | null }, [number]>(
    'SELECT skeleton_z FROM request WHERE req_id=?').get(reqId);
  if (row == null || row.skeleton_z == null) return { preview: null, modelTitle: null };
  let skeleton: unknown;
  try {
    skeleton = JSON.parse(zstdDecompressSync(row.skeleton_z).toString('utf8'));
  } catch {
    return { preview: null, modelTitle: null };
  }
  if (skeleton === null || typeof skeleton !== 'object') return { preview: null, modelTitle: null };
  const reply = (skeleton as Record<string, unknown>).reply;
  const text = assistantText(reply) ?? replyToolSummary(reply);
  if (text === null) return { preview: null, modelTitle: null };
  const title = titleOfReply(text);
  if (title !== null) return { preview: clip(`标题 · ${title}`), modelTitle: title };
  return { preview: clip(text), modelTitle: null };
}

/** 两种协议里的回复文本；只取第一段非空文本，不拼工具调用。 */
function assistantText(reply: unknown): string | null {
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) return null;
  const record = reply as Record<string, unknown>;
  const fromBlocks = (blocks: unknown): string | null => {
    if (!Array.isArray(blocks)) return null;
    for (const block of blocks) {
      if (block === null || typeof block !== 'object') continue;
      const value = (block as Record<string, unknown>).text;
      if (typeof value === 'string' && value.trim().length > 0) return value;
    }
    return null;
  };
  const direct = fromBlocks(record.content);
  if (direct !== null) return direct;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (first === null || typeof first !== 'object') return null;
  const message = (first as Record<string, unknown>).message;
  if (message === null || typeof message !== 'object') return null;
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') return content.trim().length > 0 ? content : null;
  return fromBlocks(content);
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
  const rows = db.query<{ req_id: number; prev_req_id: number | null; started_ms: number }, [string, string]>(`
    SELECT req_id, prev_req_id, started_ms FROM request
    WHERE conv_key=? AND actor=? AND actor_state='known' AND req_kind='chat'
      AND (prev_relation IS NULL OR prev_relation != 'unknown')
    ORDER BY started_ms ASC, req_id ASC`).all(convKey, actor);
  const first = rows[0];
  if (first === undefined) return;
  const ids = new Set(rows.map(row => row.req_id));
  const started = new Map(rows.map(row => [row.req_id, row.started_ms]));
  const children = new Map<number, number[]>();
  const roots: number[] = [];
  for (const row of rows) {
    const parent = row.prev_req_id !== null && ids.has(row.prev_req_id) ? row.prev_req_id : null;
    if (parent === null) {
      roots.push(row.req_id);
      continue;
    }
    const list = children.get(parent);
    if (list === undefined) children.set(parent, [row.req_id]);
    else list.push(row.req_id);
  }
  let trunkRoot = roots[0] ?? first.req_id;
  for (const root of roots) {
    if ((started.get(root) ?? 0) < (started.get(trunkRoot) ?? 0)) trunkRoot = root;
  }
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

/**
 * 处理队列里的一批分组。每个分组按稳定顺序从头重算整条链：
 * 这样乱序到达、迟到正文与归属变化都收敛到同一个结果，与到达顺序无关。
 * 返回本批处理过的分组，供调用方只重配这些分组的工具往返。
 */
export function drainDerive(store: Store, limit = 100): {
  processed: number; remaining: number; groups: { conv_key: string; actor: string }[];
} {
  return store.write(db => {
    const groups = db.query<{ conv_key: string; actor: string }, [number]>(
      'SELECT conv_key, actor FROM derive_queue ORDER BY conv_key, actor LIMIT ?').all(limit);
    const touched: { conv_key: string; actor: string }[] = [];
    let processed = 0;
    for (const group of groups) {
      const rows = db.query<ChainRow, [string, string]>(`
        SELECT req_id, actor, actor_state, started_ms, sort_source, sort_key, prev_req_id, prev_relation,
               title_source, title, model_served, req_kind, model_title,
               input_preview, input_preview_kind, reply_preview
        FROM request WHERE conv_key=? AND actor=? AND actor_state='known'`).all(group.conv_key, group.actor);
      const ordered = [...rows].sort((left, right) =>
        sortKeyOf(left).localeCompare(sortKeyOf(right)));
      // 本组已处理过的请求，供后面每一笔在链上找前驱。按正序推进，
      // 所以这里只会看到"早于本笔"的祖先。
      const ancestors: { reqId: number; fingerprints: readonly string[] }[] = [];
      // 有正文不可读的祖先时，链是断的：后面那些请求即使对不上已知祖先，
      // 也只能算"没法比"，不能断言成"另起一支"。
      let sawEarlier = false;
      let unreadableEarlier = false;
      for (const row of ordered) {
        const current = fingerprintsOf(db, row.req_id);
        const replyInfo = current === null
          ? { preview: row.reply_preview, modelTitle: null }
          : replyInfoOf(db, row.req_id);
        // 回复是 <title> 或 {"title":…} 的请求就是 harness 的 Title Generator。
        // 它是旁路：不参与主链，也不能拿它的输入当用户标题。
        const isTitleRequest = replyInfo.modelTitle !== null || row.req_kind === 'title';
        const modelTitle = replyInfo.modelTitle ?? row.model_title;
        let match: PredecessorMatch;
        if (isTitleRequest) {
          match = { parent: null, relation: 'aux', delta: null, near: null };
        } else if (current === null) {
          // 本笔正文不可读：没法比，但也不能把上一笔的结论照抄过来。
          match = { parent: null, relation: 'unknown', delta: null, near: null };
        } else {
          const found = matchPredecessor(ancestors, current, sawEarlier);
          match = found.relation === 'branch' && unreadableEarlier
            ? { ...found, relation: 'unknown' }
            : found;
        }
        if (!isTitleRequest) {
          // 标题请求是旁路，不能让后面的主请求误以为"前面还有一笔可比的请求"。
          sawEarlier = true;
          if (current === null) unreadableEarlier = true;
        }

        const relation: SequenceRelation = match.relation;
        const delta = match.delta;

        const fallback = row.title ?? `${row.model_served ?? '模型'} · ${clock(row.started_ms)}`;
        let title = fallback;
        let source: 'user_delta' | 'model_time' | 'model_title' = 'model_time';
        let inputPreview: string | null = null;
        let inputKind: 'delta' | 'tail' | 'tool_result' | 'title' | null = null;
        if (isTitleRequest) {
          // 标题请求不产生用户标题；它自己的标题来自回复里的正式标题。
          title = modelTitle ?? fallback;
          source = modelTitle !== null ? 'model_title' : 'model_time';
          inputPreview = firstUserPreview(db, row.req_id) ?? '生成会话标题';
          inputKind = 'title';
        } else if (current === null) {
          // 正文已回收：旧标题与旧摘要都是当时按正文算出来的，没有正文重算
          // 只会把它们降级成时间兜底，所以原样保留。
          title = row.title ?? fallback;
          source = (row.title_source === 'user_delta' || row.title_source === 'model_time'
            || row.title_source === 'model_title') ? row.title_source : 'model_time';
          inputPreview = row.input_preview;
          inputKind = row.input_preview_kind === 'delta' || row.input_preview_kind === 'tail'
            || row.input_preview_kind === 'tool_result' || row.input_preview_kind === 'title'
            ? row.input_preview_kind : null;
        } else if (delta !== null && delta.length > 0) {
          // delta 里存的是本笔的 ord；取出对应消息后按 0..n-1 重新编号给 deriveTitle。
          const messages = delta.map(ordinal => messageAt(db, row.req_id, ordinal));
          const derived = deriveTitle(messages, delta.map((_, index) => index), fallback);
          title = derived.title;
          source = derived.source;
          // 增量里常常只有工具结果或系统消息，没有用户文本。
          // 有用户文本才标成"新增"；否则照实说这一轮回传了什么工具结果。
          // 不要回退到"末轮输入"——那会把同一句旧用户消息重复到每一笔请求上。
          const fresh = previewOf(messages);
          if (fresh !== null) {
            inputPreview = fresh;
            inputKind = 'delta';
          } else {
            inputPreview = toolResultPreview(db, row.req_id, delta);
            inputKind = inputPreview !== null ? 'tool_result' : null;
          }
        } else if (delta !== null) {
          // 这一笔没有新增消息：输入就是上一轮的工具结果，摘要照实说。
          inputPreview = '输入是上一轮的工具结果，没有新的用户消息';
          inputKind = 'tool_result';
        } else {
          // 关系未知或另起一支：没有"新增"可言，但折叠行仍要有东西可读。
          // 取正文里最后一条用户消息，界面会把它标成"末轮输入"而不是"新增"。
          inputPreview = tailUserPreview(db, row.req_id);
          inputKind = inputPreview !== null ? 'tail' : null;
        }
        const replyPreview = current === null ? row.reply_preview : replyInfo.preview;
        db.run(
          `UPDATE request SET prev_req_id=?, prev_relation=?, delta_ordinals=?, title=?, title_source=?,
             req_kind=?, chain_role=?, model_title=?,
             input_preview=?, input_preview_kind=?, reply_preview=?, derive_version=derive_version+1 WHERE req_id=?`,
          [
            match.parent, relation,
            delta === null ? null : JSON.stringify(delta),
            title, source,
            isTitleRequest ? 'title' : 'chat',
            isTitleRequest ? 'aux' : 'main',
            isTitleRequest ? modelTitle : null,
            inputPreview, inputKind, replyPreview, row.req_id,
          ],
        );
        if (!isTitleRequest && current !== null) ancestors.push({ reqId: row.req_id, fingerprints: current });
        processed += 1;
      }
      assignChainRoles(db, group.conv_key, group.actor);
      db.run('DELETE FROM derive_queue WHERE conv_key=? AND actor=?', [group.conv_key, group.actor]);
      touched.push(group);
    }
    const remaining = (db.query('SELECT COUNT(*) AS n FROM derive_queue').get() as { n: number }).n;
    return { processed, remaining, groups: touched };
  });
}

function clock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

type TxBody = { request: unknown; reply: unknown } | null;

/**
 * 事务内读取正文。必须用事务自己的连接：只读连接是另一个快照，
 * 看不到本事务刚写入的块。
 */
function bodyInTx(db: Database, reqId: number): TxBody {
  const row = db.query<{ skeleton_z: Uint8Array | null; body_state: string }, [number]>(
    'SELECT skeleton_z, body_state FROM request WHERE req_id=?',
  ).get(reqId);
  if (row == null || row.skeleton_z == null) return null;
  if (row.body_state !== 'available' && row.body_state !== 'partial') return null;
  const skeleton = JSON.parse(zstdDecompressSync(row.skeleton_z).toString('utf8')) as {
    request_without_messages?: unknown; reply?: unknown; has_messages?: boolean;
  };
  let request = skeleton.request_without_messages ?? null;
  if (skeleton.has_messages === true) {
    const refs = db.query<{ z: Uint8Array }, [number]>(
      'SELECT b.z AS z FROM request_block rb JOIN block b ON b.id = rb.block WHERE rb.req_id=? ORDER BY rb.ord',
    ).all(reqId);
    const messages = refs.map(ref => JSON.parse(zstdDecompressSync(ref.z).toString('utf8')));
    request = { ...((request ?? {}) as Record<string, unknown>), messages };
  }
  return { request, reply: skeleton.reply ?? null };
}

/**
 * 工具往返：调用来自回复，结果出现在后续同 conv/actor 的请求里。
 *
 * 只配已有确定增量覆盖的结果（confirmed/first）；unknown 请求里的结果最多
 * 建候选，不标 resolved。同一 call_id 命中多个发起请求时标 ambiguous，
 * 不挑最近的一个，也不跨 actor 配对。
 */
export function pairToolCalls(store: Store, convKey: string, actor: string): { resolved: number; ambiguous: number; pending: number } {
  return store.write(db => {
    const rows = db.query<{
      req_id: number; prev_relation: string | null; delta_ordinals: string | null;
    }, [string, string]>(`
      SELECT req_id, prev_relation, delta_ordinals FROM request
      WHERE conv_key=? AND actor=? AND actor_state='known'
      ORDER BY started_ms, req_id`).all(convKey, actor);
    if (rows.length === 0) return { resolved: 0, ambiguous: 0, pending: 0 };

    // 先清空本组旧配对，再按当前数据重建；配对是可变状态，重算比增量修补更不容易漂移。
    // 正文已回收的请求不在重算范围内：它们的块已经不在，从空数据重配只会把原有关系抹掉，
    // 所以只删正文仍可读的那部分，其余行保持原样。
    db.run(`
      DELETE FROM tool_call WHERE req_id IN (
        SELECT req_id FROM request WHERE conv_key=? AND actor=? AND actor_state='known'
          AND body_state IN ('available','partial'))`,
    [convKey, actor]);

    type Call = { req_id: number; ord: number; call_id: string; name: string; index: number };
    const calls: Call[] = [];
    const results: { req_id: number; index: number; ord: number; path: string; call_id: string; value: unknown; confirmed: boolean }[] = [];

    for (const [index, row] of rows.entries()) {
      const body = bodyInTx(db, row.req_id);
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
        `INSERT INTO tool_call(call_id,req_id,ord,tool_name,result_req,result_ord,result_path,state,derive_version)
         VALUES (?,?,?,?,NULL,NULL,NULL,?,1)`,
        [call.call_id, call.req_id, call.ord, call.name, state],
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
      // 结果必须晚于调用；同一请求内的结果顺序不可靠，不配对。
      if (call.index >= result.index) continue;
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

    db.run(
      `UPDATE tool_call SET derive_version=derive_version+1 WHERE req_id IN (
        SELECT req_id FROM request WHERE conv_key=? AND actor=? AND actor_state='known')`,
      [convKey, actor],
    );
    return { resolved, ambiguous, pending };
  });
}

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
      db.run(
        `INSERT INTO derive_queue(conv_key,actor,from_sort) VALUES (?,?,?)
         ON CONFLICT(conv_key,actor) DO UPDATE SET from_sort=''`,
        [convKey, actor, ''],
      );
    }
    return { queued: actors.length, unavailable, reasons };
  });
}
