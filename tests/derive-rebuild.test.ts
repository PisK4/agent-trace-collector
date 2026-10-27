import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { fixture, seedTextChain, seedDeriveRound, deriveSnapshot, rebuildDeriveGroup, DERIVE_GROUP, DERIVE_ACTOR } from './fixtures';
import { openStore } from '../src/store';
import { runMaintenance } from '../src/maintenance/cli';
import { drainDerive, enqueueDerive } from '../src/derive/sync';
import { persistBody } from '../src/body';

// 维护重建：入口对齐、事务回滚与批量推进。
test('维护重建对unknown环节切断的链产出unknown角色且报告如实', async () => {
  const f = fixture();
  try {
    // 缺陷形状：第 2 笔正文缺失，第 3、4 笔的 confirmed 链经它续接。
    const convKey = JSON.stringify(['session', 'chain']);
    seedTextChain(f.store, [['S'], ['S', 'A'], ['X'], ['X', 'Y']]);
    f.store.write(db => db.run("UPDATE request SET body_state='missing' WHERE req_id=2"));
    const lines: string[] = [];
    expect(await runMaintenance(['rebuild', '--db', join(f.dir, 'trace.db'),
      '--session', convKey], { out: line => lines.push(line), err: () => {} })).toBe(0);
    // 报告如实：4 笔里 1 笔正文缺失按 retained 保留，其余重算。
    expect(JSON.parse(lines[0]!)).toMatchObject({ queue_remaining: 0,
      recomputed_requests: 3, retained_requests: 1 });
    const roles = f.store.read.query<{ req_id: number; chain_role: string }, []>(
      'SELECT req_id, chain_role FROM request ORDER BY req_id').all();
    // confirmed 后继的父链存在 unknown 环节：标 unknown，不冒充分支。
    expect(roles.map(row => row.chain_role))
      .toEqual(['main', 'unknown', 'unknown', 'unknown']);
  } finally { f.close(); }
});

test('合成旧排序经维护入口对齐且事实守恒', async () => {  const direct = fixture(); const historical = fixture();
  try {
    for (const f of [direct, historical]) {
      seedDeriveRound(f.store, [1, 2], [1000, 2000]);
      f.store.write(db => {
        db.run(`UPDATE request SET cost=0.25,sort_key=CASE req_id
          WHEN 1 THEN '9:8:7:0|00000000000000000000'
          ELSE '1:2:3:0|00000000000000000100' END`);
        db.run(`INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,added_at)
          VALUES (1,'hook','synthetic-owner-1','merged',1),
                 (2,'hook','synthetic-owner-2','merged',1)`);
      });
    }
    rebuildDeriveGroup(direct.store);
    historical.store.write(db => db.run(`UPDATE request SET
      prev_req_id=NULL,prev_relation='first',delta_ordinals='[0]',
      chain_role='main',title='synthetic old result',title_source='model_time'`));
    const facts = () => ({
      requests: historical.store.read.query(`SELECT req_id,cost,conv_key,actor
        FROM request ORDER BY req_id`).all(),
      owners: historical.store.read.query(`SELECT req_id,source_kind,ref_key,merge_state
        FROM request_evidence ORDER BY req_id,source_kind,ref_key`).all(),
      refs: historical.store.read.query(`SELECT req_id,ord,block
        FROM request_block ORDER BY req_id,ord`).all(),
    });
    const before = facts();
    const lines: string[] = [];
    expect(await runMaintenance(['rebuild', '--db', join(historical.dir, 'trace.db'),
      '--session', DERIVE_GROUP], { out: line => lines.push(line), err: () => {} })).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ queue_remaining: 0,
      recomputed_requests: 2, retained_requests: 0 });
    expect(deriveSnapshot(historical.store, [1, 2])).toEqual(deriveSnapshot(direct.store, [1, 2]));
    expect(facts()).toEqual(before);
  } finally { direct.close(); historical.close(); }
});

const injectedStages = [
  ['tool', `BEFORE INSERT ON tool_call`],
  ['preview', `BEFORE UPDATE OF input_preview ON request`],
  ['ack', `BEFORE UPDATE OF state ON derive_queue WHEN NEW.state='clean'`],
] as const;

for (const [stage, event] of injectedStages) {
  test(`同步派生${stage}失败保留队列且重开可恢复`, () => {
    const f = fixture();
    let reopened: ReturnType<typeof openStore> | undefined;
    try {
      seedDeriveRound(f.store, [1, 2]);
      enqueueDerive(f.store, DERIVE_GROUP, DERIVE_ACTOR, '');
      const before = deriveSnapshot(f.store, [1, 2]);
      f.store.write(db => db.exec(`CREATE TRIGGER injected_derive ${event}
        BEGIN SELECT RAISE(ABORT,'injected_derive'); END`));
      expect(() => drainDerive(f.store)).toThrow('injected_derive');
      expect(deriveSnapshot(f.store, [1, 2])).toEqual(before);
      // ack 失败：组仍是 dirty，没有写成 clean。
      expect(f.store.read.query("SELECT COUNT(*) AS n FROM derive_queue WHERE state<>'clean'").get())
        .toEqual({ n: 1 });
      f.store.write(db => db.exec('DROP TRIGGER injected_derive'));
      f.store.close();
      reopened = openStore(join(f.dir, 'trace.db'));
      expect(drainDerive(reopened).remaining).toBe(0);
      expect(deriveSnapshot(reopened, [1, 2]).tools[0]?.state).toBe('resolved');
      expect(deriveSnapshot(reopened, [1, 2]).requests[1]?.input_preview)
        .toBe('工具结果 · read_file');
    } finally { reopened?.close(); f.close(); }
  });
}

test('第二组确认失败时整批回滚且旧结果保留', () => {
  const f = fixture();
  try {
    seedDeriveRound(f.store, [1, 2]);
    rebuildDeriveGroup(f.store);
    const settled = deriveSnapshot(f.store, [1, 2]);
    // 第二个组用不同身份与工具 ID，复用同一形状。
    f.store.write(db => {
      for (const [i, id] of [11, 12].entries()) {
        db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,
          day,via,body_state,derive_version,have,created_at,updated_at,sort_source,sort_key)
          VALUES (?,?,'actor-second','known',?,'2026-10-22','hook','pending',0,1,1,1,
          'ledger',?)`, [id, 'zz-second', 2000 + i,
          `1:2:3:0|${String(i * 100).padStart(20, '0')}`]);
      }
    });
    const user = { role: 'user', content: [{ type: 'text', text: 'second input' }] };
    const call = { type: 'tool_use', id: 'second_call', name: 'second_tool', input: {} };
    persistBody(f.store, 11, { protocol: 'anthropic', request: { messages: [user] },
      reply: { content: [call] }, redact_version: 1 });
    persistBody(f.store, 12, { protocol: 'anthropic', request: { messages: [user,
      { role: 'assistant', content: [call] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'second_call',
        content: 'second output' }] }] }, reply: { content: [] }, redact_version: 1 });
    enqueueDerive(f.store, DERIVE_GROUP, DERIVE_ACTOR, '');
    enqueueDerive(f.store, 'zz-second', 'actor-second', '');
    f.store.write(db => db.exec(`CREATE TRIGGER fail_second_ack
      BEFORE UPDATE OF state ON derive_queue WHEN NEW.state='clean' AND NEW.conv_key='zz-second'
      BEGIN SELECT RAISE(ABORT,'injected_second'); END`));
    expect(() => drainDerive(f.store)).toThrow('injected_second');
    // 本批全部组在同一个事务里，第二组失败连第一组一起回滚。
    expect(f.store.read.query("SELECT COUNT(*) AS n FROM derive_queue WHERE state<>'clean'").get())
      .toEqual({ n: 2 });
    expect(deriveSnapshot(f.store, [1, 2])).toEqual(settled);
    f.store.write(db => db.exec('DROP TRIGGER fail_second_ack'));
    expect(drainDerive(f.store).remaining).toBe(0);
    expect(deriveSnapshot(f.store, [1, 2])).toEqual(settled);
    expect(f.store.read.query(`SELECT state FROM tool_call WHERE call_id='second_call'`).get())
      .toEqual({ state: 'resolved' });
  } finally { f.close(); }
});

test('limit按组计数且首组整批处理', () => {
  const f = fixture();
  try {
    // 首组 250 笔，另组 1 笔；组名按字节序保证首组先被选中。
    const chain = Array.from({ length: 250 }, (_, index) =>
      Array.from({ length: index + 1 }, (_, position) => `m${position}`));
    seedTextChain(f.store, chain);
    f.store.write(db => {
      db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
        body_state,derive_version,have,created_at,updated_at)
        VALUES (500,'zz-second','actor-b','known',9999,'2026-10-22','hook','pending',0,1,1,1)`);
    });
    enqueueDerive(f.store, JSON.stringify(['session', 'chain']), 'actor-a', '');
    enqueueDerive(f.store, 'zz-second', 'actor-b', '');
    const first = drainDerive(f.store, 1);
    expect(first.processed).toBe(250);
    expect(first.remaining).toBe(1);
    const second = drainDerive(f.store, 1);
    expect(second.processed).toBe(1);
    expect(second.remaining).toBe(0);
  } finally { f.close(); }
});

test('非法limit与空scope被拒绝', () => {
  const f = fixture();
  try {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expect(() => drainDerive(f.store, limit)).toThrow('invalid_derive_limit');
    }
    expect(() => drainDerive(f.store, 10, { convKey: '' })).toThrow('invalid_derive_scope');
  } finally { f.close(); }
});

test('空组任务也被确认且不计重算或保留', () => {
  const f = fixture();
  try {
    f.store.write(db => db.run(
      "INSERT INTO derive_queue(conv_key,actor,from_sort) VALUES ('empty-group','actor-empty','')"));
    const result = drainDerive(f.store);
    expect(result.groups).toEqual([{ conv_key: 'empty-group', actor: 'actor-empty' }]);
    expect(result.processed).toBe(0);
    expect(result.remaining).toBe(0);
    expect(result.recomputed).toBe(0);
    expect(result.retained).toBe(0);
  } finally { f.close(); }
});

