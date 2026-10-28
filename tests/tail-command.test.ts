import { expect, test } from 'bun:test';
import { persistBody } from '../src/body';
import { lastUserMessageIsCommand } from '../src/derive/read';
import { tailCommandOrdinal } from '../src/tail-command';
import { fixture, seedRequest } from './fixtures';

const user = { role: 'user', content: [{ type: 'text', text: '合成命令' }] };
const system = { role: 'system', content: '合成系统消息' };
const injected = { role: 'user', content: '<system-reminder>合成注入</system-reminder>' };

test('末尾扫描保持派生判据，并返回同一条可读命令的位置', () => {
  const f = fixture();
  try {
    const cases: { messages: unknown[]; expected: number | null }[] = [
      { messages: [user, system, injected], expected: 0 },
      { messages: [user, { role: 'developer', content: '合成指令' }], expected: 0 },
      { messages: [user, { role: 'user', content: 'The user sent a new message while you were working: 合成插话' }], expected: 1 },
      { messages: [user, { role: 'assistant', content: '合成回复' }], expected: null },
      { messages: [user, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'synthetic', content: '合成结果' }] }], expected: null },
      { messages: [user, { role: 'alien', content: '未知' }], expected: null },
      { messages: [user, ...Array(5).fill(system)], expected: 0 },
      { messages: [user, ...Array(6).fill(system)], expected: null },
    ];
    cases.forEach(({ messages, expected }, index) => {
      const id = index + 1;
      seedRequest(f.store, [{ req_id: id, started_ms: id, sort_source: 'ledger', sort_key: `ledger|${id}` }]);
      persistBody(f.store, id, { protocol: 'anthropic', request: { messages }, reply: null, redact_version: 1 });
      expect(tailCommandOrdinal(f.store.read, id)).toBe(expected);
      expect(lastUserMessageIsCommand(f.store.read, id)).toBe(expected !== null);
    });
  } finally { f.close(); }
});

test('末尾块不可读时派生与阅读都不把旧消息当命令', () => {
  const f = fixture();
  try {
    seedRequest(f.store, [{ req_id: 1, started_ms: 1, sort_source: 'ledger', sort_key: 'ledger|1' }]);
    persistBody(f.store, 1, { protocol: 'anthropic', request: { messages: [user, system] },
      reply: null, redact_version: 1 });
    f.store.write(db => db.run('UPDATE block SET z=? WHERE id=(SELECT block FROM request_block WHERE req_id=1 AND ord=1)',
      [Buffer.from('invalid')]));
    expect(tailCommandOrdinal(f.store.read, 1)).toBeNull();
    expect(lastUserMessageIsCommand(f.store.read, 1)).toBe(false);
  } finally { f.close(); }
});
