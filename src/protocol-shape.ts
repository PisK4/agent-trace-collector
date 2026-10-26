/**
 * 协议形状表：消息数组键、裸输入形态、角色推断与工具项位置。
 *
 * 纯函数，不 import store/sqlite：存储拆块、无损恢复、解析状态、派生抽取与
 * 工具结果定位读同一份事实。浏览器侧不打包本模块，改从 `BodyPage.protocol`
 * 取同一个协议名，再按协议拼 `request.messages[...]` 或 `request.input[...]`。
 */

export type MessagesKey = 'messages' | 'input';
/** 消息数组在原始对象里的形态：数组，或 Responses 的裸字符串输入。 */
export type MessageForm = 'array' | 'string';

const MESSAGES_KEY: Record<string, MessagesKey> = {
  anthropic: 'messages',
  chat: 'messages',
  responses: 'input',
};

/** 已知协议各有一行；名单外协议沿用 `messages`，只在未适配状态使用。 */
export function messagesKeyOf(protocol: string): MessagesKey {
  return MESSAGES_KEY[protocol] ?? 'messages';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export type RequestItems = {
  key: MessagesKey;
  form: MessageForm;
  /**
   * 可拆块的消息数组；null 表示该键不在、或存在但不是可拆的形状，
   * 整段留在骨架里，恢复时原样交还。
   */
  items: unknown[] | null;
};

/** 裸字符串输入拆成一条标准 Responses 用户消息；与原文逐字可逆。 */
export function bareInputMessage(text: string): unknown {
  return { role: 'user', type: 'message', content: [{ type: 'input_text', text }] };
}

function bareInputText(message: unknown): string | null {
  if (!isRecord(message) || !Array.isArray(message.content)) return null;
  const block = message.content[0];
  return isRecord(block) && block.type === 'input_text' && typeof block.text === 'string'
    ? block.text : null;
}

/**
 * 读出可拆块的消息数组。`input` 为裸字符串时合成一条 user 消息并记下形态；
 * 非数组、非字符串一律不拆——形状不认识时保留原对象，不在存储层猜。
 */
export function requestItemsOf(protocol: string, request: unknown): RequestItems {
  const key = messagesKeyOf(protocol);
  if (!isRecord(request)) return { key, form: 'array', items: null };
  const value = request[key];
  if (Array.isArray(value)) return { key, form: 'array', items: value };
  if (key === 'input' && typeof value === 'string') {
    return { key, form: 'string', items: [bareInputMessage(value)] };
  }
  return { key, form: 'array', items: null };
}

/** 去掉消息数组键，其余字段原样保留；骨架只存这一份。 */
export function withoutItems(request: unknown, key: MessagesKey): unknown {
  if (!isRecord(request)) return request;
  const copy: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(request)) {
    if (name !== key) copy[name] = value;
  }
  return copy;
}

/**
 * 把消息数组放回原键。裸字符串形态要求恰好一条可还原的合成消息，
 * 任何不一致返回 null——恢复要么逐字还原，要么明确不可读。
 */
export function withItems(
  request: unknown,
  key: MessagesKey,
  form: MessageForm,
  messages: readonly unknown[],
): unknown | null {
  if (!isRecord(request)) return null;
  const copy: Record<string, unknown> = { ...request };
  if (form === 'string') {
    if (messages.length !== 1) return null;
    const text = bareInputText(messages[0]);
    if (text === null) return null;
    copy[key] = text;
    return copy;
  }
  copy[key] = messages;
  return copy;
}

/**
 * 角色名：显式 `role` 优先；Responses 顶层项没有 role，按 `type` 推断。
 * 调用与推理记 assistant，工具结果记 tool；认不出的类型保持 null。
 */
export function roleNameOfItem(item: unknown): string | null {
  if (!isRecord(item)) return null;
  if (typeof item.role === 'string') return item.role;
  const type = item.type;
  if (type === 'function_call' || type === 'custom_tool_call' || type === 'reasoning') return 'assistant';
  if (type === 'function_call_output' || type === 'custom_tool_call_output') return 'tool';
  return null;
}

/** 文本块类型：Anthropic/Chat 的 `text` 与 Responses 的 `input_text`/`output_text`。 */
export function isTextBlockType(type: unknown): boolean {
  return type === 'text' || type === 'input_text' || type === 'output_text';
}

/**
 * 本笔请求是否只带增量输入：Responses 用 `previous_response_id` 引用前序响应，
 * 这时的 `input` 只是新增部分，不包含完整会话历史。链比对必须跳过它——拿增量
 * 当整段历史去找共同前缀，会把无关请求连成父子。
 */
export function isIncrementalRequest(protocol: string, request: unknown): boolean {
  if (protocol !== 'responses' || !isRecord(request)) return false;
  return textOf(request.previous_response_id) !== null;
}

// ---------------------------------------------------------------------------
// 工具调用与结果：协议形状的唯一提取点。只发布能精确定位的位置。
// ---------------------------------------------------------------------------

export type WireCall = { id: string; name: string; ord: number; path: string; input: unknown };
export type WireResult = {
  id: string; ord: number; path: string; value: unknown;
  /** true/false 为协议明确值，null 表示协议没有失败通道。 */
  isError: boolean | null;
};

function anthropicCalls(reply: unknown): WireCall[] {
  if (!isRecord(reply) || !Array.isArray(reply.content)) return [];
  const calls: WireCall[] = [];
  for (const [ord, block] of reply.content.entries()) {
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

function chatCalls(reply: unknown): WireCall[] {
  if (!isRecord(reply) || !Array.isArray(reply.choices)) return [];
  // 多 choice 的调用序号在 choice 内各自从 0 计数：发布出去会撞 (req_id, ord)
  // 主键，工具结果读取又只按 ord 找 choice0。只发布单 choice 的确定位置。
  if (reply.choices.length !== 1) return [];
  const choice = reply.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return [];
  const toolCalls = choice.message.tool_calls;
  if (!Array.isArray(toolCalls)) return [];
  const calls: WireCall[] = [];
  for (const [index, call] of toolCalls.entries()) {
    if (!isRecord(call)) continue;
    const id = textOf(call.id);
    if (id === null) continue;
    const fn = isRecord(call.function) ? call.function : {};
    calls.push({
      id,
      name: textOf(fn.name) ?? '',
      ord: index,
      path: `reply.choices[0].message.tool_calls[${index}]`,
      input: fn.arguments ?? null,
    });
  }
  return calls;
}

function responsesCalls(reply: unknown): WireCall[] {
  if (!isRecord(reply) || !Array.isArray(reply.output)) return [];
  const calls: WireCall[] = [];
  for (const [ord, item] of reply.output.entries()) {
    if (!isRecord(item)) continue;
    if (item.type !== 'function_call' && item.type !== 'custom_tool_call') continue;
    const id = textOf(item.call_id);
    if (id === null) continue;
    calls.push({
      id,
      name: textOf(item.name) ?? '',
      ord,
      path: `reply.output[${ord}]`,
      input: item.input ?? item.arguments ?? null,
    });
  }
  return calls;
}

/** 回复侧工具调用。名单外协议不猜，返回空表。 */
export function wireCallsOf(protocol: string, reply: unknown): WireCall[] {
  if (protocol === 'anthropic') return anthropicCalls(reply);
  if (protocol === 'chat') return chatCalls(reply);
  if (protocol === 'responses') return responsesCalls(reply);
  return [];
}

function anthropicResults(items: readonly unknown[]): WireResult[] {
  const results: WireResult[] = [];
  for (const [ord, message] of items.entries()) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const [index, block] of message.content.entries()) {
      if (!isRecord(block) || block.type !== 'tool_result') continue;
      const id = textOf(block.tool_use_id);
      if (id === null) continue;
      results.push({
        id,
        ord,
        path: `request.messages[${ord}].content[${index}]`,
        value: block.content ?? null,
        isError: block.is_error === true,
      });
    }
  }
  return results;
}

function chatResults(items: readonly unknown[]): WireResult[] {
  const results: WireResult[] = [];
  for (const [ord, message] of items.entries()) {
    if (!isRecord(message) || message.role !== 'tool') continue;
    const id = textOf(message.tool_call_id);
    if (id === null) continue;
    // chat 协议没有失败通道：结果送达即非失败，与缺席按缺省读的口径一致。
    results.push({ id, ord, path: `request.messages[${ord}]`, value: message.content ?? null, isError: null });
  }
  return results;
}

function responsesResults(items: readonly unknown[]): WireResult[] {
  const results: WireResult[] = [];
  for (const [ord, item] of items.entries()) {
    if (!isRecord(item)) continue;
    if (item.type !== 'function_call_output' && item.type !== 'custom_tool_call_output') continue;
    const id = textOf(item.call_id);
    if (id === null) continue;
    results.push({
      id,
      ord,
      path: `request.input[${ord}]`,
      value: item.output ?? null,
      // Responses 的结果项没有独立失败位；上游错误写在 output 里，不在这里猜。
      isError: null,
    });
  }
  return results;
}

/**
 * 已读出消息数组时的工具结果提取。派生按增量稀疏取消息，手上只有数组、
 * 没有完整请求对象，所以形状表要能脱离 `request` 单独工作。
 */
export function wireResultsIn(protocol: string, items: readonly unknown[]): WireResult[] {
  if (protocol === 'anthropic') return anthropicResults(items);
  if (protocol === 'chat') return chatResults(items);
  if (protocol === 'responses') return responsesResults(items);
  return [];
}

/** 请求侧工具结果。名单外协议不猜，返回空表。 */
export function wireResultsOf(protocol: string, request: unknown): WireResult[] {
  const { items } = requestItemsOf(protocol, request);
  return items === null ? [] : wireResultsIn(protocol, items);
}

/** 消息条数：键不在或形状不可拆时 null，裸字符串输入记一条。 */
export function messageCountOf(protocol: string, request: unknown): number | null {
  if (!isRecord(request)) return null;
  const { key, items } = requestItemsOf(protocol, request);
  if (!(key in request)) return null;
  return items === null ? null : items.length;
}
