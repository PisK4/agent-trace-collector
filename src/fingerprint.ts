import { createHash } from 'node:crypto';

/**
 * 消息的语义指纹：只保留"这条消息说了什么"，丢掉传输层的包装差异。
 *
 * 派生要判断的是"这一笔请求的上下文是不是上一笔的续写"。拿块哈希去比做不到：
 * 同一段历史在后续请求里会因为 cache_control 断点移动、content 从数组换成
 * 字符串、以及 harness 重新包装而换掉字节。比字节只会把一条完整的链读成
 * 一串互不相干的请求，标题也跟着全部退化。
 *
 * 指纹按"内容片段"归一化：
 *   - 角色参与指纹，user 与 assistant 不能混
 *   - 文本、推理、工具调用、工具结果各自带上自己的标识，顺序保留
 *   - 数组形式与字符串形式的内容压成同一种
 *   - cache_control 与 signature 是传输标记，不进指纹
 *   - 认不出的块按规范化 JSON 原样计入（宁可判成不同，也不误判成相同）
 *
 * 判成"相同"会让增量算错，所以这里只剥掉确定与语义无关的字段。
 */

/** 传输标记：位置或签名会变，内容不变。 */
const TRANSPORT_KEYS = new Set(['cache_control', 'signature']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 键排序的 JSON：同一对象换个字段顺序不该产生不同指纹。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).filter(key => !TRANSPORT_KEYS.has(key)).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  const text = JSON.stringify(value);
  return text === undefined ? 'null' : text;
}

/** 内容里的一段。同一段内容不管包在数组还是裸字符串里，都落到同一个标记。 */
function partOf(value: unknown): string | null {
  // 裸字符串与 {"type":"text","text":...} 是同一种内容，压成同一个标记。
  if (typeof value === 'string') return `t:${value}`;
  if (!isRecord(value)) return null;
  const type = value.type;

  if ((type === 'text' || type === 'input_text' || type === 'output_text')
    && typeof value.text === 'string') return `t:${value.text}`;
  if (type === 'thinking' && typeof value.thinking === 'string') return `h:${value.thinking}`;
  if (type === 'redacted_thinking') return `h:${String(value.data ?? '')}`;
  // Responses 的推理项不落 thinking 文本，只有摘要与加密载体；按整项计入。
  if (type === 'reasoning') return `h:${canonical(value)}`;
  if (type === 'tool_use' || type === 'tool_call' || type === 'function') {
    const fn = isRecord(value.function) ? value.function : null;
    const name = value.name ?? fn?.name;
    const input = value.input ?? fn?.arguments;
    return `u:${String(value.id ?? '')}:${String(name ?? '')}:${canonical(input ?? null)}`;
  }
  // Responses 的调用项用 call_id 做身份，参数键是 input（custom）或 arguments（function）。
  if (type === 'function_call' || type === 'custom_tool_call') {
    return `u:${String(value.call_id ?? '')}:${String(value.name ?? '')}:${canonical(value.input ?? value.arguments ?? null)}`;
  }
  if (type === 'tool_result') {
    return `r:${String(value.tool_use_id ?? '')}:${canonical(value.content ?? null)}`;
  }
  // Responses 的结果项：输出可能是字符串，也可能是内容块数组。
  if (type === 'function_call_output' || type === 'custom_tool_call_output') {
    return `r:${String(value.call_id ?? '')}:${canonical(value.output ?? null)}`;
  }
  // 图片、文档等认不出的块：整块计入，cache_control 之外的差异都算不同。
  return `j:${canonical(value)}`;
}

/**
 * @param message 一条已脱敏的协议消息（anthropic、chat 或 responses 形状均可）
 * @returns 稳定指纹；结构不可读时退回规范化 JSON
 */
export function messageFingerprint(message: unknown): string {
  if (!isRecord(message)) return `j:${canonical(message)}`;
  const role = typeof message.role === 'string' ? message.role.toLowerCase() : '';
  // chat 把工具结果写成 role=tool 的普通消息，身份在顶层 tool_call_id 上。
  if (role === 'tool' && typeof message.tool_call_id === 'string') {
    return `tool|r:${message.tool_call_id}:${canonical(message.content ?? null)}`;
  }

  const parts: string[] = [];
  const push = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) push(item); return; }
    const part = partOf(value);
    if (part !== null) parts.push(part);
  };

  push(message.content);
  // chat 协议把工具调用挂在 message.tool_calls 上，不在 content 里。
  push(message.tool_calls);
  // Responses 的顶层项本身就是一段：工具调用、工具结果与推理都不在 content 里。
  // 少了这一条，两笔只在工具往返上有差的请求会得到同一个空指纹。
  if (parts.length === 0) return `${role}|j:${canonical(message)}`;

  return `${role}|${parts.join('\u0001')}`;
}

/** 指纹列用定长摘要：块表按它建索引，长文本不该撑大索引。 */
export function fingerprintHash(fingerprint: string): string {
  return createHash('sha256').update(fingerprint, 'utf8').digest('hex');
}
