/**
 * 合成一轮 Todo 数据的种子：内置 Parser 测试与社区轨测试共用。
 *
 * 一轮两笔：第 1 笔命令 + Todo 工具调用（reply_shape=tools），第 2 笔工具结果 +
 * 最终回复（reply_shape=final）。轮次由真实派生结算，Todo 落在轮内第 1 笔。
 */
import { persistBody } from '../../src/body';
import { drainDerive, enqueueDerive } from '../../src/derive/sync';
import type { Store } from '../../src/store';
import { SEED_GROUP, seedRequest } from '../fixtures';

const U = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
const R = (id: string) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] });
const FINAL = { stop_reason: 'end_turn', content: [{ type: 'text', text: '答复' }] };

/** 手工插 tool_call 行：todoByTurn 只按 tool_name 与 ord 定位，不依赖配对结果。 */
function insertCall(store: Store, reqId: number, ord: number,
  name: string, agent: string): void {
  store.write(db => db.run(`
    INSERT OR REPLACE INTO tool_call(call_id,req_id,ord,tool_name,arg_path,arg_skill,
      result_req,result_ord,result_path,is_error,state,derive_version,algorithm_version)
    VALUES (?,?,?,?,NULL,NULL,NULL,0,NULL,0,'pending',0,0)`,
  [`todo-${reqId}-${ord}`, reqId, ord, name]));
  store.write(db => db.run('UPDATE request SET agent=? WHERE req_id=?', [agent, reqId]));
}

export function seedTodoTurn(store: Store, agent: string,
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
  seedRequest(store, [
    { req_id: 1, started_ms: 1000, sort_source: 'ledger', sort_key: 'ledger|0000' },
    { req_id: 2, started_ms: 2000, sort_source: 'ledger', sort_key: 'ledger|0001' },
  ], SEED_GROUP);
  persistBody(store, 1, {
    protocol, request: { messages: [firstMessage] },
    reply: protocol === 'anthropic'
      ? { stop_reason: 'tool_use', content: toolUse }
      : { choices: [{ message: { tool_calls: chatCalls } }] },
    redact_version: 1,
  });
  persistBody(store, 2, {
    protocol: 'anthropic', request: { messages: [firstMessage, secondMessage] },
    reply: FINAL, redact_version: 1,
  });
  store.write(db => db.run('UPDATE request SET purpose_pending=0 WHERE req_id IN (1,2)'));
  calls.forEach((call, ord) => insertCall(store, 1, ord, call.name, agent));
  enqueueDerive(store, SEED_GROUP.convKey, SEED_GROUP.actor, '');
  drainDerive(store);
}