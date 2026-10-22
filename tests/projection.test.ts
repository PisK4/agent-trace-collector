import { expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { fixture } from './fixtures';
import {
  SOURCE_PROJECTION_VERSION,
  collectOwnerEvidenceTx,
  projectRequestTx,
} from '../src/sources/projection';
import type { RequestProjection } from '../src/sources/projection';

type TestStore = ReturnType<typeof fixture>['store'];
// 合成代际用真实形状 dev:ino:birthtimeNs:epoch，和 A 的 /^(\d+:\d+:\d+:\d+)\|(\d{20})$/ 一致
const GENERATION = '1:2:3:0';

function seedRequest(store: TestStore, reqId = 1): void {
  // 5 个问号依次绑定 req_id、conv_key、actor、started_ms、day；其余列写字面量或用默认值
  store.write(db => db.run(
    `INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,body_state,
       derive_version,have,created_at,updated_at,req_kind)
     VALUES (?,?,?,'known',?,?, 'through','pending',0,0,1,1,'chat')`,
    [reqId, JSON.stringify(['session', 'synthetic-session']), 'synthetic-actor', 1000, '2026-10-22'],
  ));
}

function addLedgerAt(
  store: TestStore, reqId: number, generation: string, offset: number, row: Record<string, unknown>,
): void {
  const text = typeof row.t === 'string' ? row.t : '2026-10-22T00:00:00Z';
  store.write(db => {
    db.run(
      `INSERT INTO raw_ledger(source_kind,file_generation,byte_offset,t_text,t_ms,source,payload_json)
       VALUES ('file',?,?,?,?,'through',?)`,
      [generation, offset, text, Date.parse(text), JSON.stringify(row)],
    );
    // 4 个问号依次是 req_id、source_kind、ref_key、merge_state
    db.run(
      `INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,added_at) VALUES (?,?,?,?,1)`,
      [reqId, 'ledger', JSON.stringify(['file', generation, offset]), 'merged'],
    );
  });
}

function addLedger(store: TestStore, reqId: number, offset: number, row: Record<string, unknown>): void {
  addLedgerAt(store, reqId, GENERATION, offset, row);
}

function addRoute(store: TestStore, reqId: number, routeId: number, row: Record<string, unknown>): void {
  store.write(db => {
    db.run(
      `INSERT INTO raw_route(route_id,time_ms,day,payload_json) VALUES (?,?,?,?)`,
      [routeId, Date.parse(String(row.time)), '2026-10-22', JSON.stringify(row)],
    );
    db.run(
      `INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,added_at) VALUES (?,?,?,?,1)`,
      [reqId, 'route', String(routeId), 'merged'],
    );
  });
}

function addHook(store: TestStore, reqId: number, hookId: string, model: string, success: boolean): void {
  store.write(db => {
    db.run(
      `INSERT INTO raw_hook(hook_id,received_at,protocol,origin,model,success,parse_state)
       VALUES (?,1,'anthropic','local',?,?,'ok')`,
      [hookId, model, success ? 1 : 0],
    );
    db.run(
      `INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,added_at) VALUES (?,?,?,?,1)`,
      [reqId, 'hook', hookId, 'merged'],
    );
  });
}

function project(store: TestStore, reqId: number): RequestProjection {
  return store.write(db => projectRequestTx(db, reqId, { now: 10, mappingVersion: SOURCE_PROJECTION_VERSION }));
}

function facts(store: TestStore, reqId: number) {
  return store.read.query<{
    status: number | null; model_requested: string | null; model_served: string | null;
    in_tok: number | null; attempt_in: number | null; attempt_billed: number | null;
    prompt_tokens: number | null; prompt_counted: number | null; attempt_state: string;
  }, [number]>(`SELECT status,model_requested,model_served,in_tok,attempt_in,attempt_billed,
      prompt_tokens,prompt_counted,attempt_state FROM request WHERE req_id=?`).get(reqId)!;
}

test('完整账本选择最终尝试并分开req与served', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    addLedger(f.store, 1, 0, {
      t: '2026-10-22T00:00:00Z', handed_on: true, status: 429, model: 'provider-a',
      req: 'req-a', in: 10, out: 1, cost: 0.5, err: 'rate limited', err_type: 'rate_limit',
    });
    addLedger(f.store, 1, 100, {
      t: '2026-10-22T00:00:01Z', status: 200, model: 'provider-b',
      req: 'req-b', served: 'served-b', provider: 'p', in: 20, out: 5, cost: 0,
    });
    const p = project(f.store, 1);
    expect(p.attempts).toMatchObject({
      state: 'complete', billed: 2, inTok: 30, outTok: 6, outcome: 'succeeded',
      startMs: Date.parse('2026-10-22T00:00:00Z'),
    });
    expect(p.selected).toMatchObject({
      outcome: 'succeeded',
      fields: { requested: 'req-b', model: 'provider-b', served: 'served-b', ownCost: 0, status: 200 },
    });
    expect(facts(f.store, 1)).toMatchObject({
      status: 200, model_requested: 'req-b', model_served: 'served-b',
      in_tok: 20, attempt_in: 30, attempt_billed: 2, attempt_state: 'known',
    });
  } finally { f.close(); }
});

test('最后一行handed_on为1时保持pending_final且不回头取更早行', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    addLedger(f.store, 1, 0, { t: '2026-10-22T00:00:00Z', status: 200, req: 'req-a', in: 10 });
    addLedger(f.store, 1, 100, { t: '2026-10-22T00:00:01Z', handed_on: true, status: 429, req: 'req-b', in: 20 });
    const p = project(f.store, 1);
    expect(p.selected).toBeNull();
    expect(p.attempts.outcome).toBe('pending_final');
    expect(facts(f.store, 1)).toMatchObject({ status: null, model_requested: null, attempt_state: 'pending_final' });
  } finally { f.close(); }
});

test('最终行失败时selected保留该行并写失败状态', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    addLedger(f.store, 1, 0, { t: '2026-10-22T00:00:00Z', handed_on: true, status: 429, req: 'req-a', in: 10 });
    addLedger(f.store, 1, 100, { t: '2026-10-22T00:00:01Z', status: 500, model: 'provider-b', in: 20 });
    const p = project(f.store, 1);
    expect(p.selected).toMatchObject({ outcome: 'failed', fields: { status: 500 } });
    expect(facts(f.store, 1)).toMatchObject({ status: 500, attempt_state: 'known' });
  } finally { f.close(); }
});

test('同毫秒同代际按offset证明先后', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    addLedger(f.store, 1, 0, { t: '2026-10-22T00:00:00Z', status: 200, req: 'req-a', in: 10 });
    addLedger(f.store, 1, 100, { t: '2026-10-22T00:00:00Z', status: 500, req: 'req-b', in: 20 });
    const p = project(f.store, 1);
    expect(p.selected).toMatchObject({ outcome: 'failed', fields: { status: 500, requested: 'req-b' } });
    expect(p.attempts.outcome).toBe('failed');
    expect(p.identity.orderState).toBe('provable');
    expect(facts(f.store, 1)).toMatchObject({ status: 500, model_requested: 'req-b', attempt_in: 30 });
  } finally { f.close(); }
});

test('同毫秒跨代际不证明顺序时不发布final且保留合计', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    f.store.write(db => db.run(
      `UPDATE request SET status=200,model_requested='old-req',attempt_in=99,attempt_billed=7 WHERE req_id=1`));
    addLedgerAt(f.store, 1, '1:2:3:0', 0, { t: '2026-10-22T00:00:00Z', status: 200, req: 'req-a', in: 10 });
    addLedgerAt(f.store, 1, '1:2:3:1', 0, { t: '2026-10-22T00:00:00Z', status: 500, req: 'req-b', in: 20 });
    const p = project(f.store, 1);
    expect(p.selected).toBeNull();
    expect(p.families.selected).toMatchObject({ state: 'conflict', current: false });
    expect(p.reasons).toContain('attempt_order_unprovable');
    expect(p.attempts.outcome).toBe('pending_final');
    // 合计与顺序无关，可以发布；行级最终事实、排序键与响应身份不发布
    expect(facts(f.store, 1)).toMatchObject({
      status: null, model_requested: null, attempt_in: 30, attempt_billed: 2, attempt_state: 'pending_final',
    });
    expect(p.identity.sortKey).toBeNull();
    expect(p.identity.orderState).toBe('unprovable');
    expect(p.identity.responseIdNorm).toBeNull();
  } finally { f.close(); }
});

test('缺req时请求模型为NULL而provider与served各自保留', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    addLedger(f.store, 1, 0, { t: '2026-10-22T00:00:00Z', status: 200, model: 'provider-only', served: 'served-only', in: 5 });
    const p = project(f.store, 1);
    expect(p.selected).toMatchObject({ fields: { requested: null, model: 'provider-only', served: 'served-only' } });
    expect(facts(f.store, 1)).toMatchObject({ model_requested: null, model_served: 'served-only' });
  } finally { f.close(); }
});

test('部分raw过期保留旧尝试合计且不缩小不MAX', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    f.store.write(db => db.run(
      `UPDATE request SET attempt_in=30,attempt_billed=2,status=200,model_requested='old-req',
       model_served='old-served',in_tok=20 WHERE req_id=1`));
    addLedger(f.store, 1, 0, { t: '2026-10-22T00:00:00Z', status: 200, req: 'req-a', in: 10 });
    addLedger(f.store, 1, 100, { t: '2026-10-22T00:00:01Z', status: 200, req: 'req-b', in: 20 });
    f.store.write(db => {
      db.run(`DELETE FROM raw_ledger WHERE file_generation='1:2:3:0' AND byte_offset=100`);
      db.run(
        `UPDATE request_evidence SET payload_state='expired' WHERE source_kind='ledger' AND ref_key=?`,
        [JSON.stringify(['file', '1:2:3:0', 100])],
      );
    });
    const p = project(f.store, 1);
    expect(p.attempts.state).toBe('partial');
    expect(p.families.attempts.reasons).toContain('ledger_partial');
    // 证据不完整：保留旧键，只有完整但顺序不可证时才清空
    expect(p.identity.orderState).toBe('unknown');
    expect(facts(f.store, 1)).toMatchObject({
      status: 200, model_requested: 'old-req', model_served: 'old-served',
      in_tok: 20, attempt_in: 30, attempt_billed: 2,
    });
  } finally { f.close(); }
});

test('重复尝试嫌疑保留旧值而不翻倍也不MAX', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    f.store.write(db => db.run(`UPDATE request SET attempt_in=30,attempt_billed=2 WHERE req_id=1`));
    const duplicate = { t: '2026-10-22T00:00:00Z', status: 200, req: 'req-a', in: 30, out: 5 };
    addLedger(f.store, 1, 0, duplicate);
    addLedger(f.store, 1, 100, duplicate);
    const p = project(f.store, 1);
    expect(p.attempts.state).toBe('duplicate');
    expect(p.reasons).toContain('attempt_duplicate_suspect');
    expect(facts(f.store, 1)).toMatchObject({ attempt_in: 30, attempt_billed: 2 });
  } finally { f.close(); }
});

test('后到非法counted保留旧列但报告非current', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    addRoute(f.store, 1, 7, {
      id: 7, time: '2026-10-22T00:00:00Z', kind: 'compact',
      prompt: { tokens: 100, counted: true, window: 200000, turns: 2, parts: [{ kind: 'system', tokens: 10 }] },
    });
    let p = project(f.store, 1);
    expect(p.prompt).toMatchObject({ state: 'complete', tokens: 100, counted: 1, window: 200000, turns: 2 });
    expect(p.families.prompt).toMatchObject({ state: 'complete', current: true });
    expect(facts(f.store, 1)).toMatchObject({ prompt_tokens: 100, prompt_counted: 1 });

    f.store.write(db => db.run(
      `UPDATE request SET prompt_tokens=50,prompt_counted=1,parts_json='[{"kind":"old","tokens":1}]' WHERE req_id=1`));
    f.store.write(db => db.run(
      `UPDATE raw_route SET payload_json=? WHERE route_id=7`,
      [JSON.stringify({ id: 7, time: '2026-10-22T00:00:00Z', kind: 'compact', prompt: { tokens: 100, counted: 'yes' } })],
    ));
    p = project(f.store, 1);
    // 旧列是历史保留，不是本次投影的新事实
    expect(p.prompt.state).toBe('invalid');
    expect(p.families.prompt).toMatchObject({ state: 'invalid', current: false });
    expect(p.reasons).toContain('prompt_retained');
    expect(facts(f.store, 1)).toMatchObject({ prompt_tokens: 50, prompt_counted: 1 });
  } finally { f.close(); }
});

test('当前完整合法route缺Prompt时旧族不再报告complete', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    addRoute(f.store, 1, 7, { id: 7, time: '2026-10-22T00:00:00Z', prompt: { tokens: 100, counted: true } });
    let p = project(f.store, 1);
    expect(p.families.prompt).toMatchObject({ state: 'complete', current: true });
    expect(facts(f.store, 1)).toMatchObject({ prompt_tokens: 100, prompt_counted: 1 });

    addRoute(f.store, 1, 8, { id: 8, time: '2026-10-22T00:00:05Z', kind: 'compact' });
    p = project(f.store, 1);
    expect(p.families.prompt.state).not.toBe('complete');
    expect(p.families.prompt).toMatchObject({ state: 'absent', current: false });
    expect(p.reasons).toContain('prompt_retained');
    expect(facts(f.store, 1)).toMatchObject({ prompt_tokens: 100, prompt_counted: 1 });
  } finally { f.close(); }
});

test('同毫秒的两条route不证明哪条是当前Prompt', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    addRoute(f.store, 1, 7, { id: 7, time: '2026-10-22T00:00:00Z', prompt: { tokens: 100, counted: true } });
    let p = project(f.store, 1);
    expect(p.families.prompt).toMatchObject({ state: 'complete', current: true });
    expect(facts(f.store, 1)).toMatchObject({ prompt_tokens: 100, prompt_counted: 1 });

    addRoute(f.store, 1, 8, { id: 8, time: '2026-10-22T00:00:00Z', prompt: { tokens: 200, counted: true } });
    p = project(f.store, 1);
    expect(p.prompt.state).toBe('conflict');
    expect(p.families.prompt).toMatchObject({ state: 'conflict', current: false });
    expect(p.reasons).toContain('prompt_order_unprovable');
    // 旧值保留，但不是当前事实
    expect(facts(f.store, 1)).toMatchObject({ prompt_tokens: 100, prompt_counted: 1 });
  } finally { f.close(); }
});

test('kind冲突与溢出只给报告且不改req_kind', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    addLedger(f.store, 1, 0, { t: '2026-10-22T00:00:00Z', status: 200, req: 'req-a', in: 1, kind: 'compact' });
    addRoute(f.store, 1, 7, { id: 7, time: '2026-10-22T00:00:00Z', kind: 'review' });
    const p = project(f.store, 1);
    expect(p.kind).toMatchObject({ state: 'conflict', merged: null, ledger: ['compact'], route: ['review'] });
    expect(f.store.read.query(`SELECT req_kind FROM request WHERE req_id=1`).get()).toEqual({ req_kind: 'chat' });
  } finally { f.close(); }
});

test('hook报告独立于账本且多模型冲突', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    addHook(f.store, 1, 'hook-a', 'hook-model-a', true);
    let p = project(f.store, 1);
    expect(p.hook).toMatchObject({ state: 'present', models: ['hook-model-a'], successes: [true] });
    expect(p.selected).toBeNull();
    expect(facts(f.store, 1)).toMatchObject({ model_requested: null, model_served: null, status: null });

    addHook(f.store, 1, 'hook-b', 'hook-model-b', false);
    p = project(f.store, 1);
    expect(p.hook.state).toBe('conflict');
    expect(p.hook.models).toEqual(['hook-model-a', 'hook-model-b']);
  } finally { f.close(); }
});

test('在线投影重复调用得到相同事实且owner证据完整收集', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    addLedger(f.store, 1, 0, { t: '2026-10-22T00:00:00Z', status: 200, req: 'req-a', served: 'served-a', in: 10, out: 2 });
    addRoute(f.store, 1, 7, { id: 7, time: '2026-10-22T00:00:00Z', prompt: { tokens: 100, counted: false } });
    project(f.store, 1);
    const before = facts(f.store, 1);
    f.store.write(db => db.run(`UPDATE request SET status=NULL,model_requested='wrong',prompt_counted=NULL WHERE req_id=1`));
    const again = project(f.store, 1);
    expect(facts(f.store, 1)).toEqual(before);
    expect(again.prompt.counted).toBe(0);
    expect(collectOwnerEvidenceTx(f.store.read, 1).evidence.length).toBe(2);
  } finally { f.close(); }
});

test('清空请求事实后同一入口重建出相同结果', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    addLedger(f.store, 1, 0, {
      t: '2026-10-22T00:00:00Z', handed_on: true, status: 429, model: 'provider-a',
      req: 'req-a', in: 10, cost: 0.25, err: 'rate limited', err_type: 'rate_limit',
    });
    addLedger(f.store, 1, 100, {
      t: '2026-10-22T00:00:01Z', status: 200, model: 'provider-b',
      req: 'req-b', served: 'served-b', provider: 'p', in: 20, out: 5, cost: 0,
    });
    addRoute(f.store, 1, 7, {
      id: 7, time: '2026-10-22T00:00:00Z', kind: 'compact',
      prompt: { tokens: 100, counted: true, window: 200000, turns: 2, parts: [{ kind: 'system', tokens: 10 }] },
    });
    project(f.store, 1);
    const first = {
      facts: facts(f.store, 1),
      request: f.store.read.query('SELECT req_id,cost FROM request ORDER BY req_id').all(),
      owners: f.store.read.query('SELECT req_id,source_kind,ref_key FROM request_evidence ORDER BY req_id,source_kind,ref_key').all(),
      raw: f.store.read.query('SELECT source_kind,file_generation,byte_offset FROM raw_ledger ORDER BY byte_offset').all(),
    };
    f.store.write(db => db.run(
      `UPDATE request SET status=NULL,model_requested=NULL,model_served=NULL,in_tok=NULL,
       attempt_in=NULL,attempt_billed=NULL,prompt_tokens=NULL,prompt_counted=NULL,parts_json=NULL WHERE req_id=1`));
    const again = project(f.store, 1);
    expect(facts(f.store, 1)).toEqual(first.facts);
    expect(again.selected?.fields.errType).toBeNull();
    expect(again.kind).toMatchObject({ state: 'single', values: ['compact'] });
    expect({
      request: f.store.read.query('SELECT req_id,cost FROM request ORDER BY req_id').all(),
      owners: f.store.read.query('SELECT req_id,source_kind,ref_key FROM request_evidence ORDER BY req_id,source_kind,ref_key').all(),
      raw: f.store.read.query('SELECT source_kind,file_generation,byte_offset FROM raw_ledger ORDER BY byte_offset').all(),
    }).toEqual({ request: first.request, owners: first.owners, raw: first.raw });
  } finally {
    f.close();
  }
});
