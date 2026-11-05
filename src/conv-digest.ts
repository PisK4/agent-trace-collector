/**
 * magpie 会话摘要口径的唯一实现。
 *
 * magpie `gateway.go` 的 `conversationID` 取请求体里首条 role="user" 元素的
 * 原始 JSON 字节，算 SHA-256 前 12 字节 hex、加 `magpie-` 前缀。hook 接收与
 * 本地 Hermes 会话适配器共用这一份，避免两处序列化口径漂移。
 */

import { createHash } from 'node:crypto';
import type { ConvRef } from './evidence';

/**
 * 从请求对象里找首条 role="user" 元素（messages 优先、gemini contents 次之、
 * input 兜底），取其 JSON 字节做摘要。算不出时返回 null——fail-safe，调用方
 * 必须退回自己的默认组键，不能猜时间近邻。
 */
export function convDigestOf(request: unknown): ConvRef | null {
  if (request === null || request === undefined || typeof request !== 'object') return null;
  const obj = request as Record<string, unknown>;
  const geminiContents = Array.isArray(obj.messages) === false && Array.isArray(obj.contents);
  const items = Array.isArray(obj.messages) ? obj.messages
    : Array.isArray(obj.contents) ? obj.contents
      : Array.isArray(obj.input) ? obj.input
        : null;
  if (items === null || items.length === 0) return null;
  // 选首条 role="user" 元素，或 gemini contents 的空 role 元素；都没挑第一条。
  let first = items[0];
  for (const it of items) {
    const el = it as Record<string, unknown> | null;
    if (el === null || typeof el !== 'object') continue;
    const role = el.role;
    if (role === 'user' || (geminiContents && role === '')) { first = it; break; }
  }
  let bytes: Uint8Array;
  try {
    bytes = Buffer.from(JSON.stringify(first), 'utf8');
  } catch { return null; }
  if (bytes.length === 0) return null;
  const hex = createHash('sha256').update(bytes).digest('hex').slice(0, 24);
  const digest = 'magpie-' + hex;
  return { key: JSON.stringify(['conv', digest]), source: 'conv-digest' };
}
