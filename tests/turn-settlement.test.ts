import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
import { SEED_GROUP, seedRequest } from './fixtures';
import { persistBody } from '../src/body';
import { drainDerive, enqueueDerive } from '../src/derive';
import { evictOldestBodyBatch } from '../src/retention';
import { listTurns } from '../src/queries';

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
    // 回收起点照常进带。req 2 的前驱随回收断链诚实降级（relation unknown、kind 降
    // tail），不再是命令行——断链让后一轮消失，这是正文回收的代价，不是形状位缺陷。
    expect(listTurns(f.store, SEED_GROUP.convKey).items).toEqual([
      { turn: 1, start_req: 1, ordinals: [], reply_req: 1 },
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
