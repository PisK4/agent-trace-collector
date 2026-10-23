import { expect, test } from 'bun:test';
import { fixture, seedPurposeRequest } from './fixtures';
import { markRequestInputTx, markGroupDirtyTx } from '../src/derive-state';
import {
  getReadingBody, getReadingDetail, getToolResultReading, ReadingConflictError,
} from '../src/reading';

test('请求输入修订变化拒绝旧阅读版本', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey:'conv-reading', messages:[{role:'user', content:'synthetic question'}],
      cleanGroup:true, purposePending:0, summaryState:'recomputed', summaryAlgorithm:1,
    });
    const detail = getReadingDetail(f.store, id)!;
    expect(detail.reading_token).toMatch(/^r1-[0-9a-f]{64}$/);
    expect(getReadingBody(f.store, id, 0, 0, detail.reading_token)?.req_id).toBe(id);
    f.store.write(db => markRequestInputTx(db, id));
    expect(() => getReadingBody(f.store, id, 0, 1, detail.reading_token))
      .toThrow(ReadingConflictError);
  } finally { f.close(); }
});

test('只改费用不换阅读版本，组代际与正文变化要换', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey:'conv-reading-2', messages:[{role:'user', content:'synthetic question'}],
      cleanGroup:true, purposePending:0, summaryState:'recomputed', summaryAlgorithm:1,
    });
    const token = getReadingDetail(f.store, id)!.reading_token;
    // 费用不是轨迹输入：更新费用不推进阅读身份。
    f.store.write(db => db.run('UPDATE request SET cost=1.25, cost_state=\'priced\' WHERE req_id=?', [id]));
    expect(getReadingDetail(f.store, id)!.reading_token).toBe(token);
    // 组 dirty：本请求行没变，但派生位置变了。
    f.store.write(db => markGroupDirtyTx(db, 'conv-reading-2', 'actor', ''));
    const dirtyToken = getReadingDetail(f.store, id)!.reading_token;
    expect(dirtyToken).not.toBe(token);
    // 新发布代换指针：读口径变了。
    f.store.write(db => {
      db.run(`INSERT INTO derive_generation(generation,conv_key,actor,group_epoch,
        input_revision,algorithm,state,stage,created_at,published_at,request_count)
        VALUES ('gen-reading-next-0001','conv-reading-2','actor','seed-epoch',0,1,
        'published','done',1,1,1)`);
      db.run(`INSERT INTO derive_request_result(generation,req_id,input_epoch,input_revision,
        started_ms,prev_relation,delta_ordinals,chain_role,title,title_source,input_preview,
        purpose_revision,purpose_version,purpose_chain,algorithm,retention_state,basis_json)
        SELECT 'gen-reading-next-0001',req_id,input_epoch,input_revision,started_ms,'first','[1]',
        'main','t','user_delta','p',purpose_revision,purpose_version,purpose_chain,1,'recomputed','{}'
        FROM request WHERE req_id=?`, [id]);
      db.run(`UPDATE derive_queue SET published_generation='gen-reading-next-0001', state='clean',
        published_revision=input_revision WHERE conv_key='conv-reading-2' AND actor='actor'`);
    });
    expect(getReadingDetail(f.store, id)!.reading_token).not.toBe(dirtyToken);
    // 正文回收：body_state 参与身份。
    f.store.write(db => db.run(
      `UPDATE request SET body_state='evicted', body_evict_reason='budget' WHERE req_id=?`, [id]));
    expect(getReadingDetail(f.store, id)!.reading_token).not.toBe(dirtyToken);
  } finally { f.close(); }
});

test('请求折叠后旧身份的读取被拒绝', () => {
  const f = fixture();
  try {
    const common = {cleanGroup:true, purposePending:0, summaryState:'recomputed', summaryAlgorithm:1};
    const keeper = seedPurposeRequest(f.store, {
      ...common, convKey:'conv-reading-3', startedMs:1,
      messages:[{role:'user', content:'keep'}]});
    const folded = seedPurposeRequest(f.store, {
      ...common, convKey:'conv-reading-3', startedMs:2,
      messages:[{role:'user', content:'fold'}]});
    const stale = getReadingDetail(f.store, folded)!.reading_token;
    f.store.write(db => {
      db.run('INSERT INTO request_alias(old_id,new_id) VALUES (?,?)', [folded, keeper]);
      db.run('DELETE FROM request WHERE req_id=?', [folded]);
    });
    expect(getReadingDetail(f.store, folded)!.req_id).toBe(keeper);
    expect(() => getReadingBody(f.store, folded, 0, 0, stale)).toThrow(ReadingConflictError);
  } finally { f.close(); }
});

test('元信息读取带回复与能力，区间读取按真实序号', () => {
  const f = fixture();
  try {
    const messages = Array.from({length: 45}, (_, i) => ({role:'user', content:`m${i}`}));
    const id = seedPurposeRequest(f.store, {
      convKey:'conv-reading-4', messages, tools: [], cleanGroup:true, purposePending:0,
      summaryState:'recomputed', summaryAlgorithm:1,
    });
    const meta = getReadingBody(f.store, id, 0, 0, null)!;
    expect(meta.messages).toEqual([]);
    expect((meta.reply as { content: unknown[] }).content.length).toBeGreaterThan(0);
    expect(meta.capabilities.tools.state).toBe('empty');
    const slice = getReadingBody(f.store, id, 44, 45, null)!;
    expect(slice.messages.map(m => m.ord)).toEqual([44]);
    expect((slice.messages[0]!.value as { content: string }).content).toBe('m44');
  } finally { f.close(); }
});

/** 同消息两个工具结果的种子：owner 的第二个调用指向目标消息的第二个内容块。 */
function seedTwoToolResults(f: ReturnType<typeof fixture>) {
  const common = {convKey:'tool-reading', actor:'actor-tool', purposePending:0,
    cleanGroup:true, summaryState:'recomputed', summaryAlgorithm:1} as const;
  const owner = seedPurposeRequest(f.store, {
    ...common, startedMs:100, messages:[{role:'user', content:'read two files'}],
    reply:{content:[
      {type:'tool_use', id:'call_a', name:'read', input:{path:'a'}},
      {type:'tool_use', id:'call_b', name:'read', input:{path:'b'}},
    ]},
  });
  const target = seedPurposeRequest(f.store, {
    ...common, startedMs:200, messages:[{role:'user', content:[
      {type:'tool_result', tool_use_id:'call_a', content:'first result'},
      {type:'tool_result', tool_use_id:'call_b', content:'second result', is_error:true},
    ]}],
  });
  f.store.write(db => {
    db.run(`UPDATE request SET purpose_revision=input_revision WHERE req_id IN (?,?)`, [owner, target]);
    db.run(`INSERT INTO tool_call(req_id,ord,call_id,tool_name,result_req,
      result_ord,result_path,state) VALUES (?,1,'call_b','read',?,0,
      'request.messages[0].content[1]','resolved')`, [owner, target]);
  });
  return {owner, target};
}

test('同消息两个工具结果按完整位置精确读取', () => {
  const f = fixture();
  try {
    const {owner} = seedTwoToolResults(f);
    const detail = getReadingDetail(f.store, owner)!;
    const result = getToolResultReading(f.store, owner, 1, detail.reading_token)!;
    expect(result.state).toBe('available');
    expect(result.content).toBe('second result');
    expect(result.is_error).toBe(true);
    expect(result.target?.path).toBe('request.messages[0].content[1]');
    expect(result.target?.req_id).toBe(result.target?.req_id);
  } finally { f.close(); }
});

test('工具结果的状态、位置校验与身份失效', () => {
  const f = fixture();
  try {
    const {owner, target} = seedTwoToolResults(f);
    const token = getReadingDetail(f.store, owner)!.reading_token;
    // 不存在的调用序号：unpaired 且给固定原因。
    expect(getToolResultReading(f.store, owner, 5, token)).toMatchObject({
      state:'unpaired', reason:'call_not_found', content:null,
    });
    // 旧 token 被拒绝。
    f.store.write(db => markRequestInputTx(db, owner));
    expect(() => getToolResultReading(f.store, owner, 1, token)).toThrow(ReadingConflictError);
    // 重新结算组，让后续断言跑在 current 关系上。
    f.store.write(db => {
      db.run('UPDATE request SET purpose_pending=0 WHERE req_id=?', [owner]);
      db.run(`UPDATE derive_queue SET state='clean', published_revision=input_revision,
        published_algorithm=target_algorithm WHERE conv_key='tool-reading' AND actor='actor-tool'`);
    });
    const fresh = getReadingDetail(f.store, owner)!.reading_token;
    // 路径消息号与 result_ord 不一致：invalid_location。
    f.store.write(db => db.run(
      `UPDATE tool_call SET result_path='request.messages[3].content[1]' WHERE req_id=? AND ord=1`, [owner]));
    expect(getToolResultReading(f.store, owner, 1, fresh)).toMatchObject({
      state:'invalid_location', reason:'location_mismatch',
    });
    // call_id 与结果块 tool_use_id 不匹配：invalid_location。
    f.store.write(db => db.run(
      `UPDATE tool_call SET result_path='request.messages[0].content[1]' WHERE req_id=? AND ord=1`, [owner]));
    f.store.write(db => db.run(
      `UPDATE tool_call SET call_id='call_wrong' WHERE req_id=? AND ord=1`, [owner]));
    expect(getToolResultReading(f.store, owner, 1, fresh)).toMatchObject({
      state:'invalid_location', reason:'call_id_mismatch',
    });
    // 目标正文回收：unavailable 且给固定原因。
    f.store.write(db => db.run(
      `UPDATE tool_call SET call_id='call_b' WHERE req_id=? AND ord=1`, [owner]));
    f.store.write(db => db.run(
      `UPDATE request SET body_state='evicted', body_evict_reason='budget' WHERE req_id=?`, [target]));
    expect(getToolResultReading(f.store, owner, 1, fresh)).toMatchObject({
      state:'unavailable', reason:'body_evicted',
    });
  } finally { f.close(); }
});

test('Chat 工具结果按 role=tool 消息与 tool_call_id 校验', () => {
  const f = fixture();
  try {
    const common = {convKey:'chat-tool-reading', actor:'actor-chat', purposePending:0,
      cleanGroup:true, summaryState:'recomputed', summaryAlgorithm:1} as const;
    const owner = seedPurposeRequest(f.store, {
      ...common, protocol:'chat', startedMs:100, messages:[{role:'user', content:'run'}],
      reply:{choices:[{finish_reason:'tool_calls', message:{role:'assistant', content:null,
        tool_calls:[{id:'chat_b', type:'function', function:{name:'bash', arguments:'{}'}}]}}]},
    });
    const target = seedPurposeRequest(f.store, {
      ...common, protocol:'chat', startedMs:200,
      messages:[{role:'tool', tool_call_id:'chat_b', content:'chat output'}],
    });
    f.store.write(db => {
      db.run(`UPDATE request SET purpose_revision=input_revision WHERE req_id IN (?,?)`, [owner, target]);
      db.run(`INSERT INTO tool_call(req_id,ord,call_id,tool_name,result_req,
        result_ord,result_path,state) VALUES (?,0,'chat_b','bash',?,0,
        'request.messages[0]','resolved')`, [owner, target]);
    });
    const token = getReadingDetail(f.store, owner)!.reading_token;
    expect(getToolResultReading(f.store, owner, 0, token)).toMatchObject({
      state:'available', content:'chat output', is_error:null,
    });
    // tool_call_id 不匹配：invalid_location，不回退第一块。
    f.store.write(db => db.run(
      `UPDATE tool_call SET call_id='chat_x' WHERE req_id=? AND ord=0`, [owner]));
    expect(getToolResultReading(f.store, owner, 0, token)).toMatchObject({
      state:'invalid_location', reason:'call_id_mismatch',
    });
  } finally { f.close(); }
});

test('未确认关系返回对应状态且不读正文', () => {
  const f = fixture();
  try {
    const owner = seedPurposeRequest(f.store, {
      convKey:'pending-reading', actor:'actor-p', purposePending:0, cleanGroup:true,
      summaryState:'recomputed', summaryAlgorithm:1,
      messages:[{role:'user', content:'q'}],
      reply:{content:[{type:'tool_use', id:'pend_1', name:'grep', input:{pattern:'x'}}]},
    });
    f.store.write(db => db.run(
      `INSERT INTO tool_call(req_id,ord,call_id,tool_name,result_req,result_ord,result_path,state)
       VALUES (?,0,'pend_1','grep',NULL,NULL,NULL,'pending')`, [owner]));
    const token = getReadingDetail(f.store, owner)!.reading_token;
    expect(getToolResultReading(f.store, owner, 0, token)).toMatchObject({
      state:'pending', content:null, target:null,
    });
  } finally { f.close(); }
});

test('HTTP 阅读端点区分 409、400 与 404', async () => {
  const f = fixture();
  try {
    const { loadConfig } = await import('../src/config');
    const { createHandler } = await import('../src/http');
    const handler = createHandler(f.store, loadConfig({}), 'synthetic-read-token');
    const {owner} = seedTwoToolResults(f);
    const token = getReadingDetail(f.store, owner)!.reading_token;
    const make = (path: string) => new Request(`http://127.0.0.1:8320${path}`,
      { headers: { host: '127.0.0.1:8320', 'sec-fetch-site': 'same-origin' } });
    // 详情带 token；正文带可选 if_reading。
    const detail = await handler(make(`/api/requests/${owner}`));
    expect(detail.status).toBe(200);
    expect((await detail.json()).reading_token).toBe(token);
    const body = await handler(make(`/api/requests/${owner}/body?from=0&to=0&if_reading=${token}`));
    expect(body.status).toBe(200);
    // 畸形 token 400；过期 token 409。
    expect((await handler(make(`/api/requests/${owner}/body?from=0&to=0&if_reading=r1-xyz`))).status).toBe(400);
    f.store.write(db => db.run('UPDATE request SET input_revision=input_revision+1 WHERE req_id=?', [owner]));
    expect((await handler(make(`/api/requests/${owner}/body?from=0&to=0&if_reading=${token}`))).status).toBe(409);
    expect((await handler(make(`/api/requests/${owner}/tools/1/result?if_reading=${token}`))).status).toBe(409);
    // 工具端点必须带 token。
    expect((await handler(make(`/api/requests/${owner}/tools/1/result`))).status).toBe(400);
    expect((await handler(make(`/api/requests/${owner}/tools/1/result?if_reading=bad`))).status).toBe(400);
    // 不存在的请求 404；存在的调用可读。
    expect((await handler(make('/api/requests/9999/tools/0/result?if_reading=' + token))).status).toBe(404);
    const fresh = getReadingDetail(f.store, owner)!.reading_token;
    const result = await handler(make(`/api/requests/${owner}/tools/1/result?if_reading=${fresh}`));
    expect(result.status).toBe(200);
    expect((await result.json()).state).toBe('available');
  } finally { f.close(); }
});
