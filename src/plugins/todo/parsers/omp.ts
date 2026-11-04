/**
 * omp：chat 协议的 todo 工具，arguments 是 JSON 字符串 {op, list, i}。
 * init 带整份数组建表，start/done/drop 按索引 i 改状态或删条目。索引越界
 * 或形状不认识就弃权，不把一条畸形命令 apply 成错误列表。
 */
import type { TodoParser } from '../../types';
import type { TodoSnapshot } from '../dto';
import { isRecord, itemsOf } from './shape';

function decode(input: unknown): Record<string, unknown> | null {
  if (typeof input === 'string') {
    try { const parsed: unknown = JSON.parse(input); return isRecord(parsed) ? parsed : null; }
    catch { return null; }
  }
  return isRecord(input) ? input : null;
}

export const ompParser: TodoParser = {
  agent: 'omp',
  parse(call, previous: TodoSnapshot | null) {
    if (call.toolName.toLowerCase() !== 'todo') return null;
    const arg = decode(call.input);
    if (arg === null) return null;
    const items = (previous?.items ?? []).map(item => ({ ...item }));
    const op = arg.op;
    if (op === 'init') {
      const list = itemsOf(arg.list);
      if (list === null) return null;
      return { seq: (previous?.seq ?? -1) + 1, items: list };
    }
    const index = arg.i;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= items.length) return null;
    if (op === 'start') items[index]!.status = 'in_progress';
    else if (op === 'done') items[index]!.status = 'completed';
    else if (op === 'drop') items.splice(index, 1);
    else return null;
    return { seq: (previous?.seq ?? -1) + 1, items };
  },
};
