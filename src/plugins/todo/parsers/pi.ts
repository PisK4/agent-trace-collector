/**
 * pi：todo 工具按 create / update 逐条改状态，没有整份列表。
 * create 追加一条，update 按 subject 匹配已有条目改状态；匹配不到不改表，
 * 避免把一条找不到归属的命令当成新条目插进主流程时间线。
 */
import type { TodoParser } from '../../types';
import type { TodoSnapshot } from '../dto';
import { isRecord, textOf } from './shape';

export const piParser: TodoParser = {
  agent: 'pi',
  parse(call, previous: TodoSnapshot | null) {
    if (call.toolName.toLowerCase() !== 'todo') return null;
    if (!isRecord(call.input)) return null;
    const action = textOf(call.input.action);
    const subject = textOf(call.input.subject);
    if (subject === null || (action !== 'create' && action !== 'update')) return null;
    const items = (previous?.items ?? []).map(item => ({ ...item }));
    if (action === 'create') {
      items.push({ content: subject, status: 'pending' });
    } else {
      const found = items.find(item => item.content === subject);
      if (found === undefined) return null;
      found.status = 'in_progress';
    }
    return { seq: (previous?.seq ?? -1) + 1, items };
  },
};
