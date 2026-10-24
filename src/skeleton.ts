/**
 * 骨架的存储形状与验证：无协议依赖，不 import 仓库内其他模块。
 * body.ts（恢复、用途判定、meta）与 protocols.ts（分页读取）共同消费，
 * 形状知识只住在这里。骨架格式变化时升 format 并同步这份契约。
 */

export type SkeletonFields = {
  format?: unknown;
  protocol?: unknown;
  request_without_messages?: unknown;
  reply?: unknown;
  has_messages?: unknown;
  redact_version?: unknown;
};

export type SkeletonRecord = {
  protocol: string;
  request: unknown;
  reply: unknown;
  hasMessages: boolean;
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

  let messageCount = 0;
  if (skeleton.has_messages) {
    if (typeof msgCount !== 'number'
      || !Number.isInteger(msgCount) || msgCount < 0) return null;
    messageCount = msgCount;
  } else if (msgCount !== null && msgCount !== 0) {
    return null;
  }
  return {
    protocol: skeleton.protocol,
    request: skeleton.request_without_messages ?? null,
    reply: skeleton.reply ?? null,
    hasMessages: skeleton.has_messages,
    messageCount,
    redactVersion: skeleton.redact_version,
  };
}
