import { expect, test } from 'bun:test';
import { fixture, seedPurposeRequest, seedTextChain } from './fixtures';
import { drainDerive, drainDeriveTx, enqueueDerive } from '../src/derive/sync';
import { PURPOSE_VERSION } from '../src/semantics';
import { persistBody } from '../src/body';
import type { Store } from '../src/store';

// 用途协调：用途结算、组发布次序与未知归属请求。
function queueState(store: Store, convKey: string): string | null {
  return store.read.query<{ state: string }, [string]>(
    'SELECT state FROM derive_queue WHERE conv_key=?').get(convKey)?.state ?? null;
}

test('未知归属的请求不入队', () => {
  const f = fixture();
  try {
    f.store.write(db => db.run(
      `INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,title_source)
       VALUES (1,'k',NULL,'unknown',1,'2026-10-20','hook','pending',0,1,1,1,'t','model_time')`,
    ));
    enqueueDerive(f.store, 'k', 'unknown-sentinel', '');
    expect(f.store.read.query("SELECT count(*) AS n FROM derive_queue WHERE state<>'clean'").get())
      .toEqual({ n: 0 });
  } finally {
    f.close();
  }
});

test('未知归属的请求也能完成用途且不建哨兵组', () => {
  const f = fixture();
  try {
    // hook 先到：只知道会话，不知道 actor。它不进组，但它的用途是有效事实。
    f.store.write(db => db.run(
      `INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
         body_state,derive_version,have,created_at,updated_at)
       VALUES (1,'k',NULL,'unknown',1000,'2026-10-20','hook','pending',0,1,1,1)`,
    ));
    persistBody(f.store, 1, {
      protocol: 'anthropic',
      request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic prompt' }] }] },
      reply: { id: 'msg_title', content: [{ type: 'text', text: '<title>合成标题</title>' }] },
      redact_version: 1,
    });
    const result = drainDerive(f.store);
    expect(result.purpose_processed).toBe(1);
    expect(result.purpose_remaining).toBe(0);
    expect(f.store.read.query(`SELECT req_kind,purpose_pending,purpose_version,
      purpose_status,purpose_rule,purpose_chain,model_title FROM request WHERE req_id=1`).get())
      .toEqual({
        req_kind: 'title', purpose_pending: 0, purpose_version: PURPOSE_VERSION,
        purpose_status: 'recognized', purpose_rule: 'title.reply.v1', purpose_chain: 'exclude',
        model_title: '合成标题',
      });
    // 未知归属不产生组：没有哨兵，也没有替它编一个 actor。
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM derive_queue').get()).toEqual({ n: 0 });
    expect(f.store.read.query('SELECT actor FROM request WHERE req_id=1').get())
      .toEqual({ actor: null });
  } finally { f.close(); }
});

test('正文回收后保留原用途版本并消费当前修订', () => {
  const f = fixture();
  try {
    seedTextChain(f.store, [['synthetic']]);
    drainDerive(f.store);
    const before = f.store.read.query<{ input_revision: number }, []>(
      'SELECT input_revision FROM request WHERE req_id=1').get()!;
    // 正文回收后再来一次输入变化：读不出可比内容，但结论曾经算过，保留原值而不是降级成 missing。
    f.store.write(db => db.run(
      `UPDATE request SET body_state='evicted',skeleton_z=NULL,msg_count=NULL,
         input_revision=input_revision+1,purpose_pending=1,purpose_retry=0 WHERE req_id=1`));
    const result = drainDerive(f.store);
    expect(result.purpose_processed).toBe(1);
    const row = f.store.read.query<{
      purpose_status: string; purpose_version: number; purpose_revision: number;
      input_revision: number; req_kind: string;
    }, []>(`SELECT purpose_status,purpose_version,purpose_revision,input_revision,req_kind
      FROM request WHERE req_id=1`).get()!;
    expect(row.input_revision).toBe(before.input_revision + 1);
    expect(row).toEqual({
      purpose_status: 'retained', purpose_version: PURPOSE_VERSION,
      // 消费的是当前修订，不是"上次判定的那一版"：留着旧修订等于没判。
      purpose_revision: row.input_revision, input_revision: row.input_revision,
      req_kind: 'chat',
    });
  } finally { f.close(); }
});

test('从未判定过又读不出正文的请求标missing', () => {
  const f = fixture();
  try {
    f.store.write(db => db.run(
      `INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
         body_state,derive_version,have,created_at,updated_at)
       VALUES (1,'k','actor-a','known',1000,'2026-10-20','hook','pending',0,1,1,1)`,
    ));
    drainDerive(f.store);
    expect(f.store.read.query(`SELECT purpose_status,purpose_version,purpose_rule,
      purpose_pending FROM request WHERE req_id=1`).get()).toEqual({
      purpose_status: 'missing', purpose_version: null, purpose_rule: null, purpose_pending: 0,
    });
  } finally { f.close(); }
});

test('用途分批推进到排空后再发布组', () => {
  const f = fixture();
  try {
    seedTextChain(f.store, [['synthetic a'], ['synthetic a', 'synthetic b']]);
    enqueueDerive(f.store, JSON.stringify(['session', 'chain']), 'actor-a', '');
    // 模拟"组已 dirty、成员仍 pending"：purposeLimit 只限制每批大小。
    f.store.write(db => db.run('UPDATE request SET purpose_pending=1'));
    const result = drainDeriveTx(f.store.db, { limit: 10, purposeLimit: 1 });
    // 两笔各占一批，同一事务内推进到没有 pending 后组才能算。
    expect(result.purpose_processed).toBe(2);
    expect(result.purpose_remaining).toBe(0);
    expect(result.remaining).toBe(0);
    expect(result.groups.length).toBe(1);
  } finally { f.close(); }
});

test('派生先结算用途再发布组', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'purpose-group',
      system: 'You are a security monitor for autonomous AI coding agents.',
      stop: ['</block>'],
      messages: [{ role: 'user', content: 'x' }, { role: 'user', content: 'y' }],
      reply: { content: [{ type: 'text', text: '<block>no' }] },
    });
    enqueueDerive(f.store, 'purpose-group', 'actor', '');
    const result = drainDerive(f.store, 100);
    // 本 Task 只断言用途先结算、组再发布；链角色与工具配对由 Task 4 消费后断言。
    expect(result).toMatchObject({
      purpose_processed: 1, purpose_remaining: 0, processed: 1,
    });
    expect(f.store.read.query<{
      purpose_status: string; purpose_pending: number; req_kind: string;
    }, [number]>(`
      SELECT purpose_status, purpose_pending, req_kind FROM request WHERE req_id=?`)
      .get(id)).toEqual({
      purpose_status: 'recognized', purpose_pending: 0, req_kind: 'auto-mode-classifier',
    });
    expect(queueState(f.store, 'purpose-group')).toBe('clean');
  } finally { f.close(); }
});

test('用途分批结算不延迟同组发布', () => {
  const f = fixture();
  try {
    seedPurposeRequest(f.store, { convKey: 'defer', reply: { content: [{ type: 'text', text: 'one' }] } });
    seedPurposeRequest(f.store, { convKey: 'defer', reply: { content: [{ type: 'text', text: 'two' }] } });
    enqueueDerive(f.store, 'defer', 'actor', '');
    // limit 按组计数：即使每批只判一笔用途，同一调用也要把组内成员判完再发布。
    const result = drainDerive(f.store, 1);
    expect(result.purpose_processed).toBe(2);
    expect(result.purpose_remaining).toBe(0);
    expect(result.processed).toBe(2);
    expect(queueState(f.store, 'defer')).toBe('clean');
  } finally { f.close(); }
});

test('未知 actor 仍完成用途且不产生哨兵组', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'solo', actor: null, actorState: 'unknown',
      reply: { content: [{ type: 'text', text: 'plain' }] },
    });
    drainDerive(f.store, 100);
    expect(f.store.read.query<{ purpose_pending: number }, [number]>(
      'SELECT purpose_pending FROM request WHERE req_id=?').get(id))
      .toEqual({ purpose_pending: 0 });
    expect(f.store.read.query<{ n: number }, [string]>(
      'SELECT COUNT(*) AS n FROM derive_queue WHERE conv_key=?').get('solo'))
      .toEqual({ n: 0 });
  } finally { f.close(); }
});

test('范围派生只处理目标会话的待定用途', () => {
  const f = fixture();
  try {
    seedPurposeRequest(f.store, { convKey: 'scope-a' });
    const other = seedPurposeRequest(f.store, { convKey: 'scope-b' });
    const result = drainDerive(f.store, 100, { convKey: 'scope-a' });
    expect(result.purpose_processed).toBe(1);
    expect(result.purpose_remaining).toBe(0);
    expect(f.store.read.query<{ purpose_pending: number }, [number]>(
      'SELECT purpose_pending FROM request WHERE req_id=?').get(other))
      .toEqual({ purpose_pending: 1 });
  } finally { f.close(); }
});

test('排除用途不进入主链也不写工具配对', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'excluded-tools', purposePending: 0, purposeVersion: 2,
      purposeStatus: 'recognized', reqKind: 'auto-mode-classifier',
      purposeChain: 'exclude', purposeRule: 'claude.auto-mode-classifier.v1',
      reply: { content: [
        { type: 'tool_use', id: 'tool-excluded', name: 'Bash', input: { command: 'ls' } },
      ] },
    });
    enqueueDerive(f.store, 'excluded-tools', 'actor', '');
    drainDerive(f.store, 100);
    expect(f.store.read.query<{ n: number }, [number]>(
      'SELECT COUNT(*) AS n FROM tool_call WHERE req_id=?').get(id)).toEqual({ n: 0 });
    expect(f.store.read.query<{ chain_role: string }, [number]>(
      'SELECT chain_role FROM request WHERE req_id=?').get(id))
      .toEqual({ chain_role: 'aux' });
  } finally { f.close(); }
});

test('来源类别保持原始 req_kind 并参与链', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'neutral', purposePending: 0, purposeVersion: 2,
      purposeStatus: 'recognized', reqKind: 'source:compaction',
      purposeChain: 'participate', purposeRule: 'source.kind.v1',
    });
    enqueueDerive(f.store, 'neutral', 'actor', '');
    drainDerive(f.store, 100);
    expect(f.store.read.query<{ req_kind: string; chain_role: string }, [number]>(
      'SELECT req_kind, chain_role FROM request WHERE req_id=?').get(id))
      .toEqual({ req_kind: 'source:compaction', chain_role: 'main' });
  } finally { f.close(); }
});
