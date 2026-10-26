/**
 * 骨架的存储形状与验证：无协议依赖，不 import 仓库内其他模块。
 * body.ts（恢复、用途判定、meta）与 protocols.ts（分页读取）共同消费，
 * 形状知识只住在这里。骨架格式变化时升 format 并同步这份契约。
 */

export type SkeletonFields = {
  format?: unknown;
  protocol?: unknown;
  request_without_messages?: unknown;
  /** 消息数组原来的键；缺省 `messages`（旧骨架只写过这个键）。 */
  messages_key?: unknown;
  /** 消息数组原来的形态；缺省 `array`。Responses 的裸字符串输入记 `string`。 */
  messages_form?: unknown;
  reply?: unknown;
  has_messages?: unknown;
  redact_version?: unknown;
};

export type SkeletonRecord = {
  protocol: string;
  request: unknown;
  reply: unknown;
  hasMessages: boolean;
  messagesKey: 'messages' | 'input';
  messagesForm: 'array' | 'string';
  messageCount: number;
  redactVersion: number;
};

/** 宽松读取：只要求解析结果是对象。读模型容错展示用，损坏时展示为未知协议。 */
export function skeletonLike(parsed: unknown): SkeletonFields | null {
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as SkeletonFields
    : null;
}

/**
 * 严格验证骨架写入契约：任何一项不符合都返回 null。正文要么完整可读，
 * 要么不可读，不能把结构损坏的对象交给恢复、派生或用途判定去猜。
 */
export function validateSkeleton(skeleton: SkeletonFields, msgCount: number | null): SkeletonRecord | null {
  if (skeleton.format !== 1) return null;
  if (typeof skeleton.protocol !== 'string' || skeleton.protocol.length === 0) return null;
  if (typeof skeleton.has_messages !== 'boolean') return null;
  if (typeof skeleton.redact_version !== 'number'
    || !Number.isInteger(skeleton.redact_version) || skeleton.redact_version < 1) return null;
  // 两个键是向后兼容的扩展：旧骨架没有它们，按旧写入布局的缺省值读。
  const messagesKey = skeleton.messages_key === undefined ? 'messages' : skeleton.messages_key;
  if (messagesKey !== 'messages' && messagesKey !== 'input') return null;
  const messagesForm = skeleton.messages_form === undefined ? 'array' : skeleton.messages_form;
  if (messagesForm !== 'array' && messagesForm !== 'string') return null;

  let messageCount = 0;
  if (skeleton.has_messages) {
    if (typeof msgCount !== 'number'
      || !Number.isInteger(msgCount) || msgCount < 0) return null;
    messageCount = msgCount;
    // 裸字符串输入只合成一条消息；条数不符说明骨架与块引用对不上。
    if (messagesForm === 'string' && messageCount !== 1) return null;
  } else if (msgCount !== null && msgCount !== 0) {
    return null;
  }
  return {
    protocol: skeleton.protocol,
    request: skeleton.request_without_messages ?? null,
    reply: skeleton.reply ?? null,
    hasMessages: skeleton.has_messages,
    messagesKey,
    messagesForm,
    messageCount,
    redactVersion: skeleton.redact_version,
  };
}
