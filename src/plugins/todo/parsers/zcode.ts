/** zcode：TodoWrite 交整份数组快照，覆盖上一时点。 */
import type { TodoParser } from '../../types';
import { isRecord, itemsOf } from './shape';

export const zcodeParser: TodoParser = {
  agent: 'zcode',
  parse(call) {
    if (call.toolName.toLowerCase() !== 'todowrite') return null;
    if (!isRecord(call.input)) return null;
    const items = itemsOf(call.input.todos);
    if (items === null) return null;
    return { seq: 0, items };
  },
};
