import { zstdDecompressSync } from 'node:zlib';
import type { Store } from './store';
import type { BodyState } from './store';
import { interpretMessage, messageText, type MessageView, type UserInputView } from './input-interpretation';
import { CAPABLE_PROTOCOLS, capabilityView, type CapabilityCoverage, type CapabilityView } from './capabilities';
import { skeletonLike, validateSkeleton } from './skeleton';
import { messageCountOf, wireCallsOf, wireResultsOf } from './protocol-shape';

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
  /** 骨架里记录的协议名；正文不可读或骨架不识别时为 unknown。 */
  protocol: string;
  /** 骨架确认的原始消息键与形态；无法确认时为 null。 */
  message_location: { key: 'messages' | 'input'; form: 'array' | 'string' } | null;
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
export const ADAPTER_VERSION = 2;
/** 支持消息解析的协议名单：能力提取的同一份名单（capabilities.protocolSupported）。 */
export const SUPPORTED_PROTOCOLS = CAPABLE_PROTOCOLS;
const PAGE_MAX = 40;

/**
 * 纯区间规则：返回错误原因或 null。HTTP 层用它映射 400，
 * getBodyPage 的 parseRange 用它做直接防御，两层共用同一条规则。
 */
export function bodyRangeError(from: number, to: number): string | null {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
    return 'invalid_body_range';
  }
  if (to - from > PAGE_MAX) return 'invalid_body_range';
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function responseIdOf(protocol: string, reply: unknown): string | null {
  if (!isRecord(reply)) return null;
  const value = protocol === 'gemini' ? reply.responseId : reply.id;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 调用与结果按协议查表，形状知识只在 `protocol-shape` 一份。
 * 本模块只把共享形状投影成阅读视图：参数值、路径与序号原样透传。
 */
function callsOf(protocol: string, reply: unknown): ToolCallView[] {
  return wireCallsOf(protocol, reply).map(call => ({
    id: call.id, name: call.name, ord: call.ord, path: call.path, input: call.input,
  }));
}

function resultsOf(protocol: string, request: unknown): ToolResultView[] {
  return wireResultsOf(protocol, request).map(result => ({
    id: result.id, ord: result.ord, path: result.path, value: result.value,
  }));
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
    message_count: messageCountOf(protocol, request),
    calls: replyOk ? callsOf(protocol, reply) : [],
    results: requestOk ? resultsOf(protocol, request) : [],
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
  if (bodyRangeError(from, to) !== null) throw new Error('invalid_body_range');
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
    // 骨架不可读或损坏时协议与消息位置均未知。
    protocol: 'unknown',
    message_location: null,
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

  // 宽松读取：损坏骨架展示为未知协议与空字段，分页不因结构损坏而拒绝整页。
  const skeleton = skeletonLike(JSON.parse(zstdDecompressSync(stateRow.skeleton_z).toString('utf8')));
  if (skeleton === null) return page;
  const stored = validateSkeleton(skeleton, stateRow.msg_count);
  if (stored !== null && stored.hasMessages) {
    page.message_location = { key: stored.messagesKey, form: stored.messagesForm };
  }
  const fields = isRecord(skeleton.request_without_messages) ? skeleton.request_without_messages : null;
  const protocol = typeof skeleton.protocol === 'string' && skeleton.protocol.length > 0
    ? skeleton.protocol : 'unknown';
  page.protocol = protocol;
  const systemTexts: string[] = [];
  const system = fields === null ? undefined : fields.system;
  if (typeof system === 'string' && system.length > 0) systemTexts.push(system);
  if (Array.isArray(system)) {
    for (const block of system) {
      if (isRecord(block) && typeof block.text === 'string' && block.text.length > 0) systemTexts.push(block.text);
    }
  }
  // Responses 的系统提示在顶层 instructions，不在消息里：与 system 同源并入，
  // 否则能力视图读不到技能、轨迹也没有顶层 System。
  const instructions = fields === null ? undefined : fields.instructions;
  if (typeof instructions === 'string' && instructions.length > 0) systemTexts.push(instructions);
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
    // instructions 与消息级 System 同属系统提示来源：只查 system 会把 Responses
    // 判成「没有 system 字段」，技能视图因此永远停在 empty。
    systemPresent: fields !== null
      && ('system' in fields || 'instructions' in fields || systemRows.length > 0),
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
 * 回复里的第一段非空文本；三种协议结构都认，不拼工具调用。
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
  // Responses：正文在 output 的 message 项 content 里；工具调用与推理项不出摘要。
  if (Array.isArray(reply.output)) {
    for (const item of reply.output) {
      if (!isRecord(item) || item.type !== 'message') continue;
      const text = fromBlocks(item.content);
      if (text !== null) return text;
    }
  }
  const choices = reply.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  const message = isRecord(first) ? first.message : null;
  if (!isRecord(message)) return null;
  const content = message.content;
  if (typeof content === 'string') return content.trim().length > 0 ? content : null;
  return fromBlocks(content);
}
