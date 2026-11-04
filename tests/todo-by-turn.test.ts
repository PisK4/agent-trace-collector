import { expect, test } from 'bun:test';
import { fixture, SEED_GROUP, seedRequest } from './fixtures';
import { persistBody } from '../src/body';
import { drainDerive, enqueueDerive } from '../src/derive/sync';
import { todoByTurnWithParsers } from '../src/queries/todo-by-turn';
import { zcodeParser } from '../src/plugins/todo/parsers/zcode';
import { droidParser } from '../src/plugins/todo/parsers/droid';
import { piParser } from '../src/plugins/todo/parsers/pi';
import { ompParser } from '../src/plugins/todo/parsers/omp';
import type { TodoParser } from '../src/plugins/types';

const PARSERS: readonly TodoParser[] = [zcodeParser, droidParser, piParser, ompParser];
const U = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
const R = (id: string) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] });
const FINAL = { stop_reason: 'end_turn', content: [{ type: 'text', text: '答复' }] };

/** 手工插 tool_call 行：todoByTurn 只按 tool_name 与 ord 定位，不依赖配对结果。 */
function insertCall(f: ReturnType<typeof fixture>, reqId: number, ord: number,
  name: string, agent: string): void {
  f.store.write(db => db.run(`
    INSERT OR REPLACE INTO tool_call(call_id,req_id,ord,tool_name,arg_path,arg_skill,
      result_req,result_ord,result_path,is_error,state,derive_version,algorithm_version)
    VALUES (?,?,?,?,NULL,NULL,NULL,0,NULL,0,'pending',0,0)`,
  [`todo-${reqId}-${ord}`, reqId, ord, name]));
  f.store.write(db => db.run('UPDATE request SET agent=? WHERE req_id=?', [agent, reqId]));
}

/**
 * 一轮两笔：第 1 笔命令 + Todo 工具调用（reply_shape=tools），第 2 笔工具结果 +
 * 最终回复（reply_shape=final）。轮次由真实派生结算，Todo 落在轮内第 1 笔。
 */
function seedTurn(f: ReturnType<typeof fixture>, agent: string,
  calls: readonly { name: string; input: unknown }[], protocol = 'anthropic'): void {
  const toolUse = protocol === 'anthropic'
    ? calls.map((call, ord) => ({ type: 'tool_use', id: `c${ord}`, name: call.name, input: call.input }))
    : [];
  const chatCalls = protocol === 'chat'
    ? calls.map((call, ord) => ({ id: `c${ord}`, function: {
      name: call.name, arguments: JSON.stringify(call.input) } }))
    : [];
  const firstMessage = U('命令');
  const secondMessage = R('c0');
  seedRequest(f.store, [
    { req_id: 1, started_ms: 1000, sort_source: 'ledger', sort_key: 'ledger|0000' },
    { req_id: 2, started_ms: 2000, sort_source: 'ledger', sort_key: 'ledger|0001' },
  ], SEED_GROUP);
  persistBody(f.store, 1, {
    protocol, request: { messages: [firstMessage] },
    reply: protocol === 'anthropic'
      ? { stop_reason: 'tool_use', content: toolUse }
      : { choices: [{ message: { tool_calls: chatCalls } }] },
    redact_version: 1,
  });
  persistBody(f.store, 2, {
    protocol: 'anthropic', request: { messages: [firstMessage, secondMessage] },
    reply: FINAL, redact_version: 1,
  });
  f.store.write(db => db.run('UPDATE request SET purpose_pending=0 WHERE req_id IN (1,2)'));
  calls.forEach((call, ord) => insertCall(f, 1, ord, call.name, agent));
  enqueueDerive(f.store, SEED_GROUP.convKey, SEED_GROUP.actor, '');
  drainDerive(f.store);
}

function readTurn(f: ReturnType<typeof fixture>) {
  return todoByTurnWithParsers(f.store, SEED_GROUP.convKey, SEED_GROUP.actor, 1, PARSERS);
}

test('zcode 全量快照命中，状态词原样保留', () => {
  const f = fixture();
  try {
    seedTurn(f, 'zcode', [{ name: 'TodoWrite', input: { todos: [
      { content: 'ship', status: 'pending', priority: 'high' },
      { content: 'test', status: 'completed' },
    ] } }]);
    const result = readTurn(f);
    expect(result.state).toBe('ready');
    expect(result.snapshot?.items).toEqual([
      { content: 'ship', status: 'pending' }, { content: 'test', status: 'completed' },
    ]);
  } finally { f.close(); }
});

test('droid 编号文本行还原成列表', () => {
  const f = fixture();
  try {
    seedTurn(f, 'droid', [{ name: 'TodoWrite', input: { todos:
      '1. 第一项 in_progress\n2. 第二项 pending\n3. 第三项 completed' } }]);
    const result = readTurn(f);
    expect(result.state).toBe('ready');
    expect(result.snapshot?.items.map(item => item.status)).toEqual([
      'in_progress', 'pending', 'completed',
    ]);
  } finally { f.close(); }
});

test('pi 增量命令：create 后 update 按 subject 改状态', () => {
  const f = fixture();
  try {
    seedTurn(f, 'pi', [
      { name: 'todo', input: { action: 'create', subject: 'ship' } },
      { name: 'todo', input: { action: 'update', subject: 'ship' } },
    ]);
    expect(readTurn(f).snapshot?.items).toEqual([{ content: 'ship', status: 'in_progress' }]);
  } finally { f.close(); }
});

test('omp chat 字符串参数：init/done 按索引改状态', () => {
  const f = fixture();
  try {
    seedTurn(f, 'omp', [
      { name: 'todo', input: { op: 'init', list: [
        { content: 'ship', status: 'pending' }, { content: 'test', status: 'pending' },
      ] } },
      { name: 'todo', input: { op: 'done', i: 0 } },
    ], 'chat');
    expect(readTurn(f).snapshot?.items).toEqual([
      { content: 'ship', status: 'completed' }, { content: 'test', status: 'pending' },
    ]);
  } finally { f.close(); }
});

test('形状相似但不命中：别家工具名判 absent', () => {
  const f = fixture();
  try {
    seedTurn(f, 'zcode', [{ name: 'Read', input: { todos: [{ content: 'x', status: 'pending' }] } }]);
    expect(readTurn(f).state).toBe('absent');
  } finally { f.close(); }
});

test('正文已回收如实返回 unavailable，不写成空列表', () => {
  const f = fixture();
  try {
    seedTurn(f, 'zcode', [{ name: 'TodoWrite', input: { todos: [
      { content: 'ship', status: 'pending' }] } }]);
    f.store.write(db => db.run(`UPDATE request SET body_state='evicted', skeleton_z=NULL WHERE req_id=1`));
    f.store.write(db => db.run('DELETE FROM request_block WHERE req_id=1'));
    const result = readTurn(f);
    expect(result.state).toBe('unavailable');
    expect(result.snapshot).toBeNull();
  } finally { f.close(); }
});
