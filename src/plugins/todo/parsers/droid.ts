/**
 * droid：TodoWrite 的 todos 是带编号的纯文本行，每行自带状态词。
 * 按行还原 {content, status}；没有状态词的行按 pending 保留，不猜进度。
 */
import type { TodoParser } from '../../types';
import { isRecord, textOf } from './shape';

const STATUS = /\b(pending|in_progress|in-progress|completed|done|cancelled|canceled)\b/i;

export const droidParser: TodoParser = {
  agent: 'droid',
  parse(call) {
    if (call.toolName.toLowerCase() !== 'todowrite') return null;
    if (!isRecord(call.input)) return null;
    const raw = textOf(call.input.todos);
    if (raw === null) return null;
    const items: { content: string; status: string }[] = [];
    for (const line of raw.split('\n')) {
      const text = line.trim();
      if (text === '') continue;
      const match = STATUS.exec(text);
      const status = match?.[1]?.toLowerCase() ?? 'pending';
      const content = (match === null ? text : text.slice(0, match.index) + text.slice(match.index + match[0].length))
        .replace(/^\s*\d+[.):-]?\s*/, '').replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, '').trim();
      if (content === '') continue;
      items.push({ content, status });
    }
    return { seq: 0, items };
  },
};
