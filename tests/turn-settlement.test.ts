import { expect, test } from 'bun:test';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { fixture } from './fixtures';
import { SEED_GROUP, seedRequest } from './fixtures';
import { persistBody } from '../src/body';
import { drainDerive, enqueueDerive, rebuildDerived } from '../src/derive/sync';
import { GROUP_ALGORITHM } from '../src/derive/state';
import { evictOldestBodyBatch } from '../src/retention';
import { listTurns } from '../src/queries/turns';

/**
 * 轮次结算的场景种子：每笔请求一条消息序列（前缀 = 之前所有笔的累计）与回复。
 * 派生走同步路径，用途就地冻结，链、kind 位与形状位都按真实内核算出来。
 */
type TurnSpec = { delta: unknown[]; reply: unknown };

function seedTurns(
  f: ReturnType<typeof fixture>,
  specs: readonly TurnSpec[],
  group: { convKey: string; actor: string } = SEED_GROUP,
  firstId = 1,
): number[] {
  let history: unknown[] = [];
  const ids: number[] = [];
  specs.forEach((spec, index) => {
    const reqId = firstId + index;
    seedRequest(f.store, [{
      req_id: reqId,
      started_ms: 1000 + index,
      sort_source: 'ledger',
      sort_key: `ledger|${String(index).padStart(4, '0')}`,
    }], group);
    const messages = [...history, ...spec.delta];
    persistBody(f.store, reqId, {
      protocol: 'anthropic',
      request: { messages },
      reply: spec.reply,
      redact_version: 1,
    });
    f.store.write(db => db.run('UPDATE request SET purpose_pending=0 WHERE req_id=?', [reqId]));
    history = messages;
    ids.push(reqId);
  });
  return ids;
}

const U = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
const R = (id: string) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] });
const FINAL = { stop_reason: 'end_turn', content: [{ type: 'text', text: '答复' }] };
const TOOLS = (id: string) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id, name: 'read', input: {} }],
});
const MIDTURN = (text: string) => ({
  role: 'user',
  content: [{ type: 'text', text: `The user sent a new message while you were working: ${text}` }],
});

function derive(f: ReturnType<typeof fixture>): void {
  enqueueDerive(f.store, SEED_GROUP.convKey, SEED_GROUP.actor, '');
  drainDerive(f.store);
}

test('轮次结算：纯对话轮两端同笔，工具循环轮跨笔', () => {
  const f = fixture();
  try {
    seedTurns(f, [
      { delta: [U('第一条命令')], reply: FINAL },
      { delta: [U('第二条命令')], reply: TOOLS('t1') },
      { delta: [R('t1')], reply: FINAL },
    ]);
    derive(f);
    expect(listTurns(f.store, SEED_GROUP.convKey).items).toEqual([
      { turn: 1, start_req: 1, ordinals: [0], reply_req: 1 },
      { turn: 2, start_req: 2, ordinals: [1], reply_req: 3 },
    ]);
  } finally { f.close(); }
});

test('轮次结算：Responses 数组与字符串输入都能定位命令', () => {
  const user = { type: 'message', role: 'user', content: [{ type: 'input_text', text: '合成命令' }] };
  const reply = { status: 'completed', output: [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '合成回复' }] },
  ] };
  for (const input of [[user], '合成命令']) {
    const f = fixture();
    try {
      seedRequest(f.store, [{ req_id: 1, started_ms: 1000, sort_source: 'ledger', sort_key: 'ledger|0000' }]);
      persistBody(f.store, 1, { protocol: 'responses', request: { input }, reply, redact_version: 1 });
      f.store.write(db => db.run('UPDATE request SET purpose_pending=0 WHERE req_id=1'));
      derive(f);
      expect(listTurns(f.store, SEED_GROUP.convKey).items).toEqual([
        { turn: 1, start_req: 1, ordinals: [0], reply_req: 1 },
      ]);
    } finally { f.close(); }
  }
});

test('轮次结算：旧 Responses 骨架按实际拆块键定位可信增量', () => {
  const positions: number[][] = [];
  for (const input of [undefined, [
    { role: 'assistant', content: '无关输入' }, U('不能当作消息块的命令'),
  ]]) {
    const f = fixture();
    try {
      const request = { messages: [U('实际命令'), { role: 'assistant', content: '消息块中的回复' }],
        ...(input === undefined ? {} : { input }) };
      seedRequest(f.store, [{ req_id: 1, started_ms: 1000, sort_source: 'ledger', sort_key: 'ledger|0000' }]);
      persistBody(f.store, 1, { protocol: 'anthropic', request,
        reply: { status: 'completed', output: [] }, redact_version: 1 });
      const saved = f.store.read.query<{ skeleton_z: Uint8Array }, []>(
        'SELECT skeleton_z FROM request WHERE req_id=1').get()!;
      const skeleton = JSON.parse(zstdDecompressSync(saved.skeleton_z).toString('utf8'));
      delete skeleton.messages_key;
      delete skeleton.messages_form;
      skeleton.protocol = 'responses';
      f.store.write(db => {
        db.run('UPDATE request SET skeleton_z=?,purpose_pending=0 WHERE req_id=1', [
          zstdCompressSync(Buffer.from(JSON.stringify(skeleton))),
        ]);
      });
      derive(f);
      positions.push(listTurns(f.store, SEED_GROUP.convKey).items[0]?.ordinals ?? []);
    } finally { f.close(); }
  }
  expect(positions).toEqual([[0], [0]]);
});

test('轮次结算：Responses 增量输入定位末尾命令但不伪造可信增量', () => {
  const user = { type: 'message', role: 'user', content: [{ type: 'input_text', text: '合成命令' }] };
  for (const input of [[user], '合成命令']) {
    const f = fixture();
    try {
      seedRequest(f.store, [{ req_id: 1, started_ms: 1000, sort_source: 'ledger', sort_key: 'ledger|0000' }]);
      persistBody(f.store, 1, { protocol: 'responses', request: { input, previous_response_id: 'synthetic-id' },
        reply: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '合成回复' }] }] }, redact_version: 1 });
      f.store.write(db => db.run('UPDATE request SET purpose_pending=0 WHERE req_id=1'));
      derive(f);
      const derived = f.store.read.query<{ prev_relation: string; delta_ordinals: string | null; input_preview_kind: string }, []>(
        'SELECT prev_relation, delta_ordinals, input_preview_kind FROM request WHERE req_id=1').get();
      expect(derived).toMatchObject({ prev_relation: 'unknown', delta_ordinals: null, input_preview_kind: 'tail_command' });
      expect(listTurns(f.store, SEED_GROUP.convKey).items).toEqual([{ turn: 1, start_req: 1, ordinals: [0], reply_req: 1 }]);
    } finally { f.close(); }
  }
});

test('轮次结算：不可读引用不生成末尾命令位置', () => {
  const f = fixture();
  try {
    seedRequest(f.store, [{ req_id: 1, started_ms: 1000, sort_source: 'ledger', sort_key: 'ledger|0000' }]);
    persistBody(f.store, 1, { protocol: 'responses', request: { input: '合成命令', previous_response_id: 'synthetic' },
      reply: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '合成回复' }] }] }, redact_version: 1 });
    f.store.write(db => db.run('UPDATE request SET purpose_pending=0 WHERE req_id=1'));
    derive(f);
    f.store.write(db => db.run('DELETE FROM request_block WHERE req_id=1 AND ord=0'));
    expect(listTurns(f.store, SEED_GROUP.convKey).items).toEqual([{ turn: 1, start_req: 1, ordinals: [], reply_req: 1 }]);
  } finally { f.close(); }
});

test('轮次结算：末尾块损坏时不把更早消息当成当前命令', () => {
  const f = fixture();
  try {
    seedRequest(f.store, [{ req_id: 1, started_ms: 1000, sort_source: 'ledger', sort_key: 'ledger|0000' }]);
    persistBody(f.store, 1, { protocol: 'responses', request: { input: [U('旧消息'), U('末尾命令')], previous_response_id: 'synthetic' },
      reply: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '合成回复' }] }] }, redact_version: 1 });
    f.store.write(db => db.run('UPDATE request SET purpose_pending=0 WHERE req_id=1'));
    derive(f);
    expect(listTurns(f.store, SEED_GROUP.convKey).items[0]?.ordinals).toEqual([1]);
    f.store.write(db => db.run('UPDATE block SET z=? WHERE id=(SELECT block FROM request_block WHERE req_id=1 AND ord=1)', [Buffer.from('invalid')]));
    expect(listTurns(f.store, SEED_GROUP.convKey).items[0]?.ordinals).toEqual([]);
  } finally { f.close(); }
});

test('轮次结算：显式重建修正坏尾块的历史误判', () => {
  const f = fixture();
  try {
    seedRequest(f.store, [{ req_id: 1, started_ms: 1000, sort_source: 'ledger', sort_key: 'ledger|0000' }]);
    persistBody(f.store, 1, { protocol: 'responses', request: { input: [
      U('合成旧命令'), { type: 'function_call_output', call_id: 'synthetic', output: '合成结果' },
    ], previous_response_id: 'synthetic' },
    reply: { status: 'completed', output: [] }, redact_version: 1 });
    f.store.write(db => db.run('UPDATE request SET purpose_pending=0 WHERE req_id=1'));
    derive(f);
    f.store.write(db => {
      db.run('UPDATE block SET z=? WHERE id=(SELECT block FROM request_block WHERE req_id=1 AND ord=1)',
        [Buffer.from('invalid')]);
      db.run("UPDATE request SET input_preview_kind='tail_command', summary_algorithm=5 WHERE req_id=1");
      db.run('UPDATE derive_queue SET target_algorithm=5,published_algorithm=5 WHERE conv_key=? AND actor=?',
        [SEED_GROUP.convKey, SEED_GROUP.actor]);
    });
    expect(listTurns(f.store, SEED_GROUP.convKey).items).toEqual([{ turn: 1, start_req: 1, ordinals: [], reply_req: 1 }]);
    expect(rebuildDerived(f.store, SEED_GROUP.convKey).queued).toBe(1);
    drainDerive(f.store);
    expect(f.store.read.query<{ input_preview_kind: string; summary_algorithm: number }, []>(
      'SELECT input_preview_kind,summary_algorithm FROM request WHERE req_id=1').get())
      .toEqual({ input_preview_kind: 'tail', summary_algorithm: GROUP_ALGORITHM });
    expect(listTurns(f.store, SEED_GROUP.convKey).items).toEqual([]);
  } finally { f.close(); }
});

test('轮次结算：Responses 工具循环从起点请求定位命令', () => {
  const f = fixture();
  try {
    const user = { type: 'message', role: 'user', content: [{ type: 'input_text', text: '合成命令' }] };
    const call = { type: 'function_call', call_id: 'synthetic_call', name: 'read', arguments: '{}' };
    const result = { type: 'function_call_output', call_id: 'synthetic_call', output: '合成结果' };
    seedRequest(f.store, [
      { req_id: 1, started_ms: 1000, sort_source: 'ledger', sort_key: 'ledger|0000' },
      { req_id: 2, started_ms: 2000, sort_source: 'ledger', sort_key: 'ledger|0001' },
    ]);
    persistBody(f.store, 1, { protocol: 'responses', request: { input: [user] },
      reply: { status: 'completed', output: [call] }, redact_version: 1 });
    persistBody(f.store, 2, { protocol: 'responses', request: { input: [user, call, result] },
      reply: { status: 'completed', output: [] }, redact_version: 1 });
    f.store.write(db => db.run('UPDATE request SET purpose_pending=0 WHERE req_id IN (1, 2)'));
    derive(f);
    expect(listTurns(f.store, SEED_GROUP.convKey).items).toEqual([
      { turn: 1, start_req: 1, ordinals: [0], reply_req: 2 },
    ]);
  } finally { f.close(); }
});

test('轮次结算：打断的轮不借新回复复活，新命令自己成轮', () => {
  const f = fixture();
  try {
    seedTurns(f, [
      { delta: [U('旧命令')], reply: TOOLS('t1') },
      { delta: [U('新命令')], reply: FINAL },
    ]);
    derive(f);
    expect(listTurns(f.store, SEED_GROUP.convKey).items).toEqual([
      { turn: 1, start_req: 2, ordinals: [1], reply_req: 2 },
    ]);
  } finally { f.close(); }
});

test('轮次结算：queue 追加的旧任务总结在洁净路径上，midturn 命令照常成起点', () => {
  const f = fixture();
  try {
    seedTurns(f, [
      { delta: [U('跑完整测试')], reply: TOOLS('t1') },
      { delta: [R('t1')], reply: FINAL },
      { delta: [MIDTURN('把输出也存一份')], reply: TOOLS('t2') },
      { delta: [R('t2')], reply: FINAL },
    ]);
    derive(f);
    expect(listTurns(f.store, SEED_GROUP.convKey).items).toEqual([
      { turn: 1, start_req: 1, ordinals: [0], reply_req: 2 },
      { turn: 2, start_req: 3, ordinals: [2], reply_req: 4 },
    ]);
  } finally { f.close(); }
});

test('轮次结算：终点带命令时旧轮不结算，回复归新轮两端同笔', () => {
  const f = fixture();
  try {
    seedTurns(f, [
      { delta: [U('看看现状')], reply: TOOLS('t1') },
      { delta: [R('t1'), U('直接改掉')], reply: FINAL },
    ]);
    derive(f);
    expect(listTurns(f.store, SEED_GROUP.convKey).items).toEqual([
      { turn: 1, start_req: 2, ordinals: [2], reply_req: 2 },
    ]);
  } finally { f.close(); }
});

test('轮次结算：后代分叉出多个可达 final，保守不结算', () => {
  const f = fixture();
  try {
    seedTurns(f, [
      { delta: [U('分叉前的命令')], reply: TOOLS('t1') },
      { delta: [R('t1')], reply: FINAL },
      // 与 req2 不同的结果内容：req3 的前缀只到 req1，两个 final 挂在同一命令下。
      { delta: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '另一条结果' }] }], reply: FINAL },
    ]);
    derive(f);
    expect(listTurns(f.store, SEED_GROUP.convKey).items).toEqual([]);
  } finally { f.close(); }
});

test('轮次结算：同笔多条用户输入归一个命令组，ordinals 按序', () => {
  const f = fixture();
  try {
    seedTurns(f, [
      { delta: [U('第一句'), U('第二句')], reply: FINAL },
    ]);
    derive(f);
    expect(listTurns(f.store, SEED_GROUP.convKey).items).toEqual([
      { turn: 1, start_req: 1, ordinals: [0, 1], reply_req: 1 },
    ]);
  } finally { f.close(); }
});

test('轮次结算：截断回复不是终点，轮等到真正收尾那一笔', () => {
  const f = fixture();
  try {
    seedTurns(f, [
      { delta: [U('列一下改动')], reply: { stop_reason: 'max_tokens', content: [{ type: 'text', text: '一、' }] } },
      { delta: [R('none')], reply: FINAL },
    ]);
    derive(f);
    expect(listTurns(f.store, SEED_GROUP.convKey).items).toEqual([
      { turn: 1, start_req: 1, ordinals: [0], reply_req: 2 },
    ]);
  } finally { f.close(); }
});

test('轮次结算：分支链与排除用途不参与，辅助请求不产生轮', () => {
  const f = fixture();
  try {
    // req 2 不含 req 1 的前缀：另起一支（branch）。req 3 是排除用途的辅助行。
    // 分支行绕开累计式种子：它的消息序列不续接主链。
    seedTurns(f, [
      { delta: [U('主链命令')], reply: FINAL },
    ]);
    seedRequest(f.store, [
      { req_id: 2, started_ms: 2000, sort_source: 'ledger', sort_key: 'ledger|0001' },
      { req_id: 3, started_ms: 3000, sort_source: 'ledger', sort_key: 'ledger|0002' },
    ]);
    persistBody(f.store, 2, {
      protocol: 'anthropic', request: { messages: [U('分支命令')] }, reply: FINAL, redact_version: 1,
    });
    persistBody(f.store, 3, {
      protocol: 'anthropic', request: { messages: [U('辅助输入')] }, reply: FINAL, redact_version: 1,
    });
    f.store.write(db => db.run("UPDATE request SET purpose_pending=0, purpose_chain='exclude' WHERE req_id=3"));
    derive(f);
    const roles = f.store.read.query<{ req_id: number; chain_role: string }, []>(
      'SELECT req_id, chain_role FROM request ORDER BY req_id').all();
    expect(roles[1]?.chain_role).toBe('branch');
    // 分支命令与辅助行都不产生轮：只剩主链的纯对话轮。
    expect(listTurns(f.store, SEED_GROUP.convKey).items).toEqual([
      { turn: 1, start_req: 1, ordinals: [0], reply_req: 1 },
    ]);
  } finally { f.close(); }
});

test('轮次结算：正文回收的起点照常进带，ordinals 清空、终点按保留的形状位', () => {
  const f = fixture();
  try {
    seedTurns(f, [
      { delta: [U('会被回收的命令')], reply: FINAL },
      { delta: [U('后面的命令')], reply: FINAL },
    ]);
    derive(f);
    expect(evictOldestBodyBatch(f.store, 5000, 1).requests).toBe(1);
    derive(f);
    // req 1 回收：起点 kind 位保留、形状位保留 final、delta_ordinals 已随回收清空，
    // 回收起点照常进带。req 2 的前驱随回收断链，delta 算不出来，但末条消息是用户
    // 主动文本，记成 tail_command 并照常成起点。
    expect(listTurns(f.store, SEED_GROUP.convKey).items).toEqual([
      { turn: 1, start_req: 1, ordinals: [], reply_req: 1 },
      { turn: 2, start_req: 2, ordinals: [1], reply_req: 2 },
    ]);
  } finally { f.close(); }
});

test('轮次结算：非 current 组不产生确定轮次', () => {
  const f = fixture();
  try {
    seedTurns(f, [{ delta: [U('命令')], reply: FINAL }]);
    derive(f);
    expect(listTurns(f.store, SEED_GROUP.convKey).items).toHaveLength(1);
    // 组变 dirty：kind 位与形状位都不再是当前结论。
    f.store.write(db => db.run(`UPDATE derive_queue SET state='dirty', dirty_since_ms=1
      WHERE conv_key=? AND actor=?`, [SEED_GROUP.convKey, SEED_GROUP.actor]));
    expect(listTurns(f.store, SEED_GROUP.convKey).items).toEqual([]);
  } finally { f.close(); }
});

test('轮次结算：累计窗口下界过滤返回，轮号保持会话全序不重号', () => {
  const f = fixture();
  try {
    seedTurns(f, [
      { delta: [U('第一轮')], reply: FINAL },
      { delta: [U('第二轮')], reply: FINAL },
      { delta: [U('第三轮')], reply: FINAL },
    ]);
    derive(f);
    expect(listTurns(f.store, SEED_GROUP.convKey, 2).items).toEqual([
      { turn: 2, start_req: 2, ordinals: [1], reply_req: 2 },
      { turn: 3, start_req: 3, ordinals: [2], reply_req: 3 },
    ]);
  } finally { f.close(); }
});

test('轮次结算：子代理组不参与，主链 actor 按参与请求数选出', () => {
  const f = fixture();
  try {
    const sub = { convKey: SEED_GROUP.convKey, actor: 'subagent-1' };
    seedTurns(f, [
      { delta: [U('主链第一轮')], reply: FINAL },
      { delta: [U('主链第二轮')], reply: FINAL },
    ]);
    seedTurns(f, [{ delta: [U('子代理命令')], reply: FINAL }], sub, 101);
    derive(f);
    const items = listTurns(f.store, SEED_GROUP.convKey).items;
    expect(items).toHaveLength(2);
    expect(items.every(item => item.start_req <= 2)).toBe(true);
  } finally { f.close(); }
});

test('轮次结算：未知会话返回空表，不报错', () => {
  const f = fixture();
  try {
    expect(listTurns(f.store, '["session","missing"]').items).toEqual([]);
  } finally { f.close(); }
});

test('轮次结算：不确定闭包里相对可读前驱的新增命令照常成起点', () => {
  const f = fixture();
  try {
    seedTurns(f, [
      { delta: [U('命令一')], reply: FINAL },
      { delta: [U('命令二')], reply: FINAL },
      { delta: [U('命令三')], reply: FINAL },
      { delta: [U('命令四')], reply: FINAL },
    ]);
    derive(f);
    // 回收 req1：req2 关系 unknown 且 delta 不可算，靠末条消息是用户主动文本记成
    // tail_command；req3/req4 的前驱可读，delta 成立但被不确定闭包标成 unknown。
    expect(evictOldestBodyBatch(f.store, 5000, 1).requests).toBe(1);
    derive(f);
    expect(listTurns(f.store, SEED_GROUP.convKey).items.map(item => item.start_req)).toEqual([1, 2, 3, 4]);
  } finally { f.close(); }
});

test('轮次结算：末尾是工具回传的 tail 不算命令', () => {
  const f = fixture();
  try {
    seedTurns(f, [
      { delta: [U('命令一')], reply: FINAL },
      { delta: [R('t1')], reply: FINAL },
    ]);
    derive(f);
    expect(evictOldestBodyBatch(f.store, 5000, 1).requests).toBe(1);
    derive(f);
    // req2 的末条消息是 tool_result：末轮输入不是用户主动文本，不进带。
    expect(listTurns(f.store, SEED_GROUP.convKey).items.map(item => item.start_req)).toEqual([1]);
  } finally { f.close(); }
});
