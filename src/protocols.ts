import { zstdDecompressSync } from 'node:zlib';
import type { Store } from './store';
import type { BodyState } from './store';
import { interpretMessage, messageText, type MessageView, type UserInputView } from './input-interpretation';
import { capabilityView, type CapabilityCoverage, type CapabilityView } from './capabilities';

/**
 * 协议适配层：把已保存的脱敏对象解释成阅读用的辅助视图。
 * 解析是"尽力而为"的：不认识的 shape 标 unsupported 或 invalid，
 * 但原对象始终保留在库里，读取端仍可按原文展示。
 */

export type ParseState = 'ok' | 'unsupported' | 'invalid';
export type ReplyState = 'ok' | 'absent' | 'unsupported' | 'invalid';

export type ToolCallView = { id: string; name: string; ord: number; path: string; input: unknown };
export type ToolResultView = { id: string; ord: number; path: string; value: unknown };

export type ParsedBody = {
  parse_state: ParseState;
  reply_state: ReplyState;
  message_count: number | null;
  calls: ToolCallView[];
  results: ToolResultView[];
  response_id: string | null;
};

export type MessageInterpretation = {
  ord: number;
  role: MessageView['role'];
  role_state: MessageView['role_state'];
  input: UserInputView | null;
  is_input: boolean;
};

export type BodyCoverage = {
  from: number;
  to: number;
  total: number | null;
  complete: boolean;
  loaded_complete: boolean;
  reason: 'available' | 'body_partial' | 'body_unavailable';
};

export type BodyPage = {
  state: BodyState;
  parse_state: string | null;
  reply_state: string | null;
  from: number;
  to: number;
  total: number | null;
  messages: { ord: number; value: unknown }[];
  request_fields: unknown;
  reply: unknown;
  reason: string | null;
  interpretations: MessageInterpretation[];
  coverage: BodyCoverage;
  capabilities: CapabilityView;
};

/** 适配器版本写进 request 的长期列；语义变化时升版。 */
export const ADAPTER_VERSION = 1;
export const SUPPORTED_PROTOCOLS = ['anthropic', 'chat'] as const;
const PAGE_MAX = 40;

type Message = { role: string; content: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function contentBlocks(message: unknown): unknown[] {
  if (!isRecord(message)) return [];
  const content = message.content;
  return Array.isArray(content) ? content : [];
}

function responseIdOf(protocol: string, reply: unknown): string | null {
  if (!isRecord(reply)) return null;
  const value = protocol === 'gemini' ? reply.responseId : reply.id;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function textOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.length > 0 ? value : null;
}

/** 读取 content 里的 block 数组；字符串 content 视为单块，便于统一遍历。 */
function blocksOf(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  if (content === null || content === undefined) return [];
  return [content];
}

function anthropicCalls(reply: unknown): ToolCallView[] {
  if (!isRecord(reply)) return [];
  const calls: ToolCallView[] = [];
  for (const [ord, block] of contentBlocks(reply).entries()) {
    if (!isRecord(block) || block.type !== 'tool_use') continue;
    const id = textOf(block.id);
    if (id === null) continue;
    calls.push({
      id,
      name: textOf(block.name) ?? '',
      ord,
      path: `reply.content[${ord}]`,
      input: block.input ?? null,
    });
  }
  return calls;
}

function anthropicResults(request: unknown): ToolResultView[] {
  if (!isRecord(request) || !Array.isArray(request.messages)) return [];
  const results: ToolResultView[] = [];
  for (let ord = 0; ord < request.messages.length; ord++) {
    const message: unknown = request.messages[ord];
    for (const [index, block] of contentBlocks(message).entries()) {
      if (!isRecord(block) || block.type !== 'tool_result') continue;
      const id = textOf(block.tool_use_id);
      if (id === null) continue;
      results.push({
        id,
        ord,
        path: `request.messages[${ord}].content[${index}]`,
        value: block.content ?? null,
      });
    }
  }
  return results;
}

function chatCalls(reply: unknown): ToolCallView[] {
  if (!isRecord(reply) || !Array.isArray(reply.choices)) return [];
  const calls: ToolCallView[] = [];
  for (const [choiceIndex, choice] of reply.choices.entries()) {
    if (!isRecord(choice) || !isRecord(choice.message)) continue;
    const toolCalls = choice.message.tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const [index, call] of toolCalls.entries()) {
      if (!isRecord(call)) continue;
      const id = textOf(call.id);
      if (id === null) continue;
      const fn = isRecord(call.function) ? call.function : {};
      calls.push({
        id,
        name: textOf(fn.name) ?? '',
        ord: index,
        path: `reply.choices[${choiceIndex}].message.tool_calls[${index}]`,
        input: fn.arguments ?? null,
      });
    }
  }
  return calls;
}

function chatResults(request: unknown): ToolResultView[] {
  if (!isRecord(request) || !Array.isArray(request.messages)) return [];
  const results: ToolResultView[] = [];
  for (const [ord, message] of request.messages.entries()) {
    if (!isRecord(message) || message.role !== 'tool') continue;
    const id = textOf(message.tool_call_id);
    if (id === null) continue;
    results.push({ id, ord, path: `request.messages[${ord}]`, value: message.content ?? null });
  }
  return results;
}

function anthropicMessageCount(request: unknown): number | null {
  if (!isRecord(request)) return null;
  const messages = request.messages;
  if (messages === undefined) return null;
  return Array.isArray(messages) ? messages.length : null;
}

function chatMessageCount(request: unknown): number | null {
  if (!isRecord(request)) return null;
  const messages = request.messages;
  if (messages === undefined) return null;
  return Array.isArray(messages) ? messages.length : null;
}

/**
 * 请求与回复分别定状态：回复为空是常见情况（流被中断、上游只返回状态码），
 * 不能因此把请求也判成失败。
 */
export function parseProtocol(protocol: string, request: unknown, reply: unknown): ParsedBody {
  if (!SUPPORTED_PROTOCOLS.includes(protocol as typeof SUPPORTED_PROTOCOLS[number])) {
    return {
      parse_state: 'unsupported',
      reply_state: reply === null || reply === undefined ? 'absent' : 'unsupported',
      message_count: null,
      calls: [],
      results: [],
      response_id: responseIdOf(protocol, reply),
    };
  }
  const requestOk = request === null || request === undefined ? false : isRecord(request);
  const replyAbsent = reply === null || reply === undefined;
  const replyOk = !replyAbsent && isRecord(reply);
  const replyState: ReplyState = replyAbsent ? 'absent' : replyOk ? 'ok' : 'invalid';
  return {
    parse_state: requestOk ? 'ok' : 'invalid',
    reply_state: replyState,
    message_count: protocol === 'anthropic' ? anthropicMessageCount(request) : chatMessageCount(request),
    calls: replyOk ? (protocol === 'anthropic' ? anthropicCalls(reply) : chatCalls(reply)) : [],
    results: requestOk ? (protocol === 'anthropic' ? anthropicResults(request) : chatResults(request)) : [],
    response_id: responseIdOf(protocol, reply),
  };
}

/** 只解压目标区间需要的块；同一页内共享块也只解一次。 */
function decompressBlock(store: Store, id: number, cache: Map<number, unknown>): unknown {
  const cached = cache.get(id);
  if (cached !== undefined) return cached;
  const row = store.read.query<{ z: Uint8Array }, [number]>('SELECT z FROM block WHERE id=?').get(id);
  if (row == null) throw new Error('body_block_missing');
  const value: unknown = JSON.parse(zstdDecompressSync(row.z).toString('utf8'));
  cache.set(id, value);
  return value;
}

function parseRange(from: number, to: number): void {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
    throw new Error('invalid_body_range');
  }
  if (to - from > PAGE_MAX) throw new Error('invalid_body_range');
}

/**
 * 分页读取正文。区间左闭右开；首片带请求字段与回复，后续片只带消息。
 * 已回收或未收到的正文返回带 state 的说明，不用空数组冒充完整正文。
 */
export function getBodyPage(store: Store, id: number, from: number, to: number): BodyPage | null {
  parseRange(from, to);
  const stateRow = store.read.query<{
    body_state: string; parse_state: string | null; reply_state: string | null;
    msg_count: number | null; miss_reason: string | null; body_evict_reason: string | null;
    skeleton_z: Uint8Array | null; agent: string | null;
  }, [number]>(`
    SELECT body_state, parse_state, reply_state, msg_count, miss_reason, body_evict_reason, skeleton_z, agent
    FROM request WHERE req_id=?`).get(id);
  if (stateRow == null) return null;

  const state = stateRow.body_state as BodyState;
  const readable = state === 'available' || state === 'partial';
  const missingCapabilities: CapabilityView = {
    tools: { state: 'missing', items: [], reason: 'body_unavailable' },
    skills: { state: 'missing', items: [], reason: 'body_unavailable' },
    coverage: { complete: false, reason: 'body_unavailable', from, to, total: null },
    agent: stateRow.agent,
  };
  const page: BodyPage = {
    state,
    parse_state: stateRow.parse_state,
    reply_state: stateRow.reply_state,
    from,
    to,
    // 只有能读的正文才谈得上"还有多少条"：回收与未到都没有可翻的区间，
    // 留着 msg_count 会让页面显示出永远取不到的下一页。
    total: readable ? stateRow.msg_count : null,
    messages: [],
    request_fields: null,
    reply: null,
    reason: state === 'evicted' ? stateRow.body_evict_reason : stateRow.miss_reason,
    interpretations: [],
    coverage: {
      from,
      to,
      total: readable ? stateRow.msg_count : null,
      complete: state === 'available',
      loaded_complete: readable && stateRow.msg_count !== null && to >= stateRow.msg_count,
      reason: readable ? (state === 'available' ? 'available' : 'body_partial') : 'body_unavailable',
    },
    capabilities: missingCapabilities,
  };
  if (!readable) return page;
  if (stateRow.skeleton_z == null) return page;

  const skeleton = JSON.parse(zstdDecompressSync(stateRow.skeleton_z).toString('utf8')) as {
    protocol?: unknown; request_without_messages?: unknown; reply?: unknown; has_messages?: boolean;
  };
  const fields = isRecord(skeleton.request_without_messages) ? skeleton.request_without_messages : null;
  const protocol = typeof skeleton.protocol === 'string' && skeleton.protocol.length > 0
    ? skeleton.protocol : 'unknown';
  const systemTexts: string[] = [];
  const system = fields === null ? undefined : fields.system;
  if (typeof system === 'string' && system.length > 0) systemTexts.push(system);
  if (Array.isArray(system)) {
    for (const block of system) {
      if (isRecord(block) && typeof block.text === 'string' && block.text.length > 0) systemTexts.push(block.text);
    }
  }
  // 只解压 system 块：能力提取不需要整份消息，回收后也不该扫描全部正文。
  const systemRows = store.read.query<{ z: Uint8Array }, [number]>(`
    SELECT b.z AS z FROM request_block rb JOIN block b ON b.id = rb.block
    WHERE rb.req_id=? AND rb.role=2 ORDER BY rb.ord`).all(id);
  for (const row of systemRows) {
    let message: unknown;
    try {
      message = JSON.parse(zstdDecompressSync(row.z).toString('utf8'));
    } catch {
      continue;
    }
    const text = messageText(message);
    if (text !== null) systemTexts.push(text);
  }
  const coverage: CapabilityCoverage = {
    complete: state === 'available',
    reason: state === 'available' ? 'available' : 'body_partial',
    from,
    to,
    total: stateRow.msg_count,
  };
  page.capabilities = capabilityView({
    protocol,
    request: fields,
    systemTexts,
    coverage,
    systemPresent: fields !== null && ('system' in fields || systemRows.length > 0),
    agent: stateRow.agent,
  });

  const cache = new Map<number, unknown>();
  if (from === 0) {
    page.request_fields = skeleton.request_without_messages ?? null;
    page.reply = skeleton.reply ?? null;
  }
  if (from === to) return page;

  const rows = store.read.query<{ ord: number; block: number }, [number, number, number]>(`
    SELECT ord, block FROM request_block WHERE req_id=? AND ord >= ? AND ord < ? ORDER BY ord`)
    .all(id, from, to);
  page.messages = rows.map(row => ({ ord: row.ord, value: decompressBlock(store, row.block, cache) }));
  page.interpretations = page.messages.map(message => {
    const view = interpretMessage(message.value, stateRow.agent, message.ord);
    // unrecognized 仍是用户消息：保留原文并标未识别，不能因为清洗失败就吞掉。
    // injected 与 empty 不是用户可见输入，页面据此不铺气泡。
    return {
      ...view,
      is_input: view.input !== null && (view.input.state === 'text' || view.input.state === 'unrecognized'),
    };
  });
  return page;
}

export { PAGE_MAX };

/**
 * 回复里的第一段非空文本；两种协议结构都认，不拼工具调用。
 *
 * 摘要是给折叠行看的，只取首段就够；需要完整判定（例如分类器只认最后一个
 * `<block>`）的调用方应遍历全部文本，不要用这个函数。
 */
export function assistantText(reply: unknown): string | null {
  if (!isRecord(reply)) return null;
  const fromBlocks = (blocks: unknown): string | null => {
    if (!Array.isArray(blocks)) return null;
    for (const block of blocks) {
      if (!isRecord(block)) continue;
      const value = block.text;
      if (typeof value === 'string' && value.trim().length > 0) return value;
    }
    return null;
  };
  const direct = fromBlocks(reply.content);
  if (direct !== null) return direct;
  const choices = reply.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  const message = isRecord(first) ? first.message : null;
  if (!isRecord(message)) return null;
  const content = message.content;
  if (typeof content === 'string') return content.trim().length > 0 ? content : null;
  return fromBlocks(content);
}
