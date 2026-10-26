import { expect, test } from 'bun:test';
import { zstdCompressSync } from 'node:zlib';
import { fixture, seedDeriveRound, seedTextChain } from './fixtures';
import { persistBody, persistBodyTx, readBodyTx } from '../src/body';
import {
  createBodyReadCache, decodeBlockMessage, messageOfBlock, type BlockMessageRow,
} from '../src/body-cache';
import {
  contextEventTx, interruptCountTx, messageAt, presentationPortsOf, replyInfoOf,
} from '../src/derive/read';
import { drainDerive, drainDeriveGroupTx, enqueueDerive } from '../src/derive/sync';

const CHAIN_GROUP = JSON.stringify(['session', 'chain']);
const CHAIN_ACTOR = 'actor-a';

function fakeBlock(id: number, hash: string, message: unknown, rawSize = 32): BlockMessageRow {
  return {
    id,
    hash,
    z: zstdCompressSync(Buffer.from(JSON.stringify(message), 'utf8')),
    raw_size: rawSize,
  };
}

function appendChainRequest(
  f: ReturnType<typeof fixture>, id: number, texts: string[], startedMs: number,
): void {
  f.store.write(db => db.run(`
    INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,day,via,
      body_state,derive_version,have,created_at,updated_at,title,title_source,
      sort_source,sort_key)
    VALUES (?,?,'session',?,'known',?,'2026-10-23','hook','pending',0,1,1,1,
      'seed','model_time','ledger',?)`,
  [id, CHAIN_GROUP, CHAIN_ACTOR, startedMs, `ledger|${String(id).padStart(4, '0')}`]));
  persistBody(f.store, id, {
    protocol: 'anthropic',
    request: {
      messages: texts.map(text => ({ role: 'user', content: [{ type: 'text', text }] })),
    },
    reply: { id: `msg_${id}`, content: [{ type: 'text', text: 'ok' }] },
    redact_version: 1,
  });
}

test('同一块命中返回同一对象，并冻结共享消息', () => {
  const f = fixture();
  try {
    const message = { role: 'user', content: [{ type: 'text', text: 'A' }] };
    const row = fakeBlock(1, 'aa', message);
    const cache = createBodyReadCache();
    const first = cache.message(row);
    expect(first).toEqual(message);
    expect(cache.message(row)).toBe(first);
    // 冻结是共享的前提：消费者原地改写会抛错，不会污染后续读取。
    expect(() => { (first as { role: string }).role = 'assistant'; }).toThrow();
    expect(cache.message(row)).toEqual(message);
    expect(cache.snapshot()).toMatchObject({
      message_hits: 2, message_misses: 1, message_decodes: 1,
      message_unreadable: 0, message_evictions: 0,
      cached_entries: 1,
    });
  } finally { f.close(); }
});

test('内容身份不是代理键：同id不同哈希各自解码', () => {
  const cache = createBodyReadCache();
  const left = fakeBlock(7, 'aa', { role: 'user', content: 'left' });
  const right = fakeBlock(7, 'bb', { role: 'user', content: 'right' });
  expect(cache.message(left)).toEqual({ role: 'user', content: 'left' });
  expect(cache.message(right)).toEqual({ role: 'user', content: 'right' });
  expect(cache.message(left)).toEqual({ role: 'user', content: 'left' });
  expect(cache.snapshot()).toMatchObject({
    message_misses: 2, message_hits: 1, message_decodes: 2, cached_entries: 2,
  });
});

test('低预算按LRU淘汰并如实重读，超大块与空哈希不入缓存', () => {
  const long = 'x'.repeat(1_000);
  const first = fakeBlock(1, 'aa', { role: 'user', content: long }, long.length + 20);
  const second = fakeBlock(2, 'bb', { role: 'assistant', content: long }, long.length + 20);
  const cache = createBodyReadCache({ budgetBytes: 2_000 });
  expect(cache.message(first)).toEqual({ role: 'user', content: long });
  expect(cache.message(second)).toEqual({ role: 'assistant', content: long });
  // 第一条被淘汰，再读是重读，不是命中。
  expect(cache.message(first)).toEqual({ role: 'user', content: long });
  expect(cache.snapshot()).toMatchObject({
    message_misses: 3, message_hits: 0, message_decodes: 3, message_evictions: 2,
    cached_entries: 1,
  });

  const oversize = createBodyReadCache({ maxBlockBytes: 100 });
  expect(oversize.message(first)).toEqual({ role: 'user', content: long });
  expect(oversize.message(first)).toEqual({ role: 'user', content: long });
  expect(oversize.snapshot()).toMatchObject({
    message_oversize: 2, message_decodes: 2, cached_entries: 0,
  });

  const noIdentity = createBodyReadCache();
  const anonymous = { ...first, hash: '' };
  expect(noIdentity.message(anonymous)).toEqual({ role: 'user', content: long });
  expect(noIdentity.message(anonymous)).toEqual({ role: 'user', content: long });
  expect(noIdentity.snapshot()).toMatchObject({
    message_skipped: 2, message_decodes: 2, cached_entries: 0,
  });
});

test('坏块不缓存：每次读取都按失败处理，不留下永久结论', () => {
  const cache = createBodyReadCache();
  const broken = { ...fakeBlock(1, 'aa', { role: 'user', content: 'x' }), z: new Uint8Array([1, 2, 3]) };
  expect(cache.message(broken)).toBeUndefined();
  expect(cache.message(broken)).toBeUndefined();
  // 合法压缩但非法 JSON 同样按失败处理。
  const invalidJson = {
    ...fakeBlock(2, 'bb', { role: 'user', content: 'x' }),
    z: zstdCompressSync(Buffer.from('{not-json', 'utf8')),
  };
  expect(cache.message(invalidJson)).toBeUndefined();
  expect(cache.snapshot()).toMatchObject({
    message_unreadable: 3, message_decodes: 3, cached_entries: 0,
  });
  // 无缓存路径的失败语义一致。
  expect(decodeBlockMessage(broken)).toBeUndefined();
  expect(messageOfBlock(fakeBlock(3, 'cc', { role: 'user', content: 'ok' }))).toEqual({
    role: 'user', content: 'ok',
  });
});

test('缓存命中不绕过状态、引用与块校验', () => {
  const f = fixture();
  try {
    const reqId = f.store.write(db => Number(db.run(`
      INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,body_state,
        derive_version,have,created_at,updated_at)
      VALUES (1,'conv','actor','known',1,'2026-10-23','hook','pending',0,1,1,1)`).lastInsertRowid));
    persistBody(f.store, reqId, {
      protocol: 'anthropic',
      request: { messages: [{ role: 'user', content: 'A' }] },
      reply: { content: [] },
      redact_version: 1,
    });
    const cache = createBodyReadCache();
    expect(readBodyTx(f.store.read, reqId, cache)).not.toBeNull();
    // 先命中一次，再改状态：下一次读取仍按当前状态判定，缓存不能复活正文。
    f.store.write(db => db.run(
      "UPDATE request SET body_state='evicted' WHERE req_id=?", [reqId]));
    expect(readBodyTx(f.store.read, reqId, cache)).toBeNull();

    f.store.write(db => db.run(
      "UPDATE request SET body_state='available' WHERE req_id=?", [reqId]));
    // 状态恢复后引用不完整：命中过的块也不能绕过 ord 与引用数校验。
    f.store.write(db => db.run('DELETE FROM request_block WHERE req_id=1'));
    expect(readBodyTx(f.store.read, reqId, cache)).toBeNull();
  } finally { f.close(); }
});

test('部分命中后遇到坏块，完整正文仍判为不可读', () => {
  const f = fixture();
  try {
    const reqId = f.store.write(db => Number(db.run(`
      INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,body_state,
        derive_version,have,created_at,updated_at)
      VALUES (1,'conv','actor','known',1,'2026-10-23','hook','pending',0,1,1,1)`).lastInsertRowid));
    persistBody(f.store, reqId, {
      protocol: 'anthropic',
      request: { messages: [{ role: 'user', content: 'A' }, { role: 'assistant', content: 'B' }] },
      reply: { content: [] },
      redact_version: 1,
    });
    const cache = createBodyReadCache();
    const second = f.store.read.query<{ id: number }, []>(
      'SELECT block AS id FROM request_block WHERE req_id=1 AND ord=1').get()!;
    // 先破坏第二条块，再读取：第一条能被缓存，第二条每次都按坏块失败。
    f.store.write(db => db.run('UPDATE block SET z=? WHERE id=?', [new Uint8Array([1, 2, 3]), second.id]));
    expect(readBodyTx(f.store.read, reqId, cache)).toBeNull();
    // 第一条块命中、第二条解压失败：不能因为部分命中就返回残缺正文。
    expect(readBodyTx(f.store.read, reqId, cache)).toBeNull();
    expect(cache.snapshot()).toMatchObject({
      message_hits: 1, message_decodes: 3, message_unreadable: 2,
    });
  } finally { f.close(); }
});

test('正文替换后新作用域读取新内容', () => {
  const f = fixture();
  try {
    const reqId = f.store.write(db => Number(db.run(`
      INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,body_state,
        derive_version,have,created_at,updated_at)
      VALUES (1,'conv','actor','known',1,'2026-10-23','hook','pending',0,1,1,1)`).lastInsertRowid));
    const body = (text: string) => ({
      protocol: 'anthropic',
      request: { messages: [{ role: 'user', content: text }] },
      reply: { content: [] },
      redact_version: 1,
    });
    persistBody(f.store, reqId, body('old'));
    const oldCache = createBodyReadCache();
    expect((readBodyTx(f.store.read, reqId, oldCache)?.request as { messages: unknown[] }).messages)
      .toEqual([{ role: 'user', content: 'old' }]);
    persistBody(f.store, reqId, body('new'));
    // 旧作用域不跨轮复用；新组派生建立新缓存时读到当前正文。
    const newCache = createBodyReadCache();
    expect((readBodyTx(f.store.read, reqId, newCache)?.request as { messages: unknown[] }).messages)
      .toEqual([{ role: 'user', content: 'new' }]);
    expect(oldCache.snapshot().message_decodes).toBe(1);
    expect(newCache.snapshot().message_decodes).toBe(1);
  } finally { f.close(); }
});

test('缓存与非缓存对每个读取消费端给出相同结果', () => {
  const f = fixture();
  try {
    seedDeriveRound(f.store, [1, 2]);
    const cache = createBodyReadCache();
    for (const reqId of [1, 2]) {
      expect(replyInfoOf(f.store.read, reqId, cache))
        .toEqual(replyInfoOf(f.store.read, reqId));
      expect(messageAt(f.store.read, reqId, 0, cache))
        .toEqual(messageAt(f.store.read, reqId, 0));
      expect(interruptCountTx(f.store.read, reqId, [0], cache))
        .toBe(interruptCountTx(f.store.read, reqId, [0]));
      expect(contextEventTx(f.store.read, reqId, 'first', [0], cache))
        .toEqual(contextEventTx(f.store.read, reqId, 'first', [0]));
    }
    const cachedPorts = presentationPortsOf(f.store.read, cache);
    const plainPorts = presentationPortsOf(f.store.read);
    for (const reqId of [1, 2]) {
      expect(cachedPorts.firstUserPreview(reqId)).toBe(plainPorts.firstUserPreview(reqId));
      expect(cachedPorts.tailUserPreview(reqId)).toBe(plainPorts.tailUserPreview(reqId));
      expect(cachedPorts.messageAt(reqId, 0)).toEqual(plainPorts.messageAt(reqId, 0));
    }
  } finally { f.close(); }
});

test('长组合成对照：输出一致，解码次数收敛到不同块数', () => {
  const requests = 240;
  const window = 40;
  const group = JSON.stringify(['session', 'cache-perf']);
  const actor = 'actor-cache-perf';
  const run = (budgetBytes?: number) => {
    const f = fixture();
    try {
      const base = Array.from({ length: window - 1 }, (_, index) => ({
        role: 'user', content: [{ type: 'text', text: `base-${index}-${'x'.repeat(200)}` }],
      }));
      f.store.write(db => {
        for (let id = 1; id <= requests; id++) {
          db.run(`INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,
            started_ms,day,via,body_state,derive_version,have,created_at,updated_at,
            sort_source,sort_key,input_epoch,input_revision,purpose_revision,
            purpose_version,purpose_chain,purpose_pending,req_kind)
            VALUES (?,?,'session',?,'known',?,'2026-10-23','hook','pending',0,1,1,1,
              'ledger',?,'e1',0,0,1,'participate',1,'chat')`,
          [id, group, actor, 1_000 + id, `ledger|${String(id).padStart(20, '0')}`]);
          const messages = [...base, {
            role: 'user', content: [{ type: 'text', text: `unique-${id}` }],
          }];
          persistBodyTx(db, id, {
            protocol: 'anthropic',
            request: { messages },
            reply: { content: [{ type: 'text', text: 'ok' }] },
            redact_version: 1,
          });
        }
      });
      // 用途已冻结：对照只测组阶段的正文读取，不让用途阶段混入计时。
      f.store.write(db => db.run('UPDATE request SET purpose_pending=0'));
      enqueueDerive(f.store, group, actor, '');
      const cache = budgetBytes === undefined
        ? undefined : createBodyReadCache({ budgetBytes });
      const started = performance.now();
      const result = f.store.write(db => drainDeriveGroupTx(db, group, actor,
        cache === undefined ? {} : { bodyCache: cache }));
      const elapsed = performance.now() - started;
      const rows = f.store.read.query(`SELECT req_id,prev_relation,delta_ordinals,
        chain_role,title,input_preview,reply_preview,reply_shape,interrupt_count,
        context_event FROM request ORDER BY req_id`).all();
      return { result: result!, elapsed, rows };
    } finally { f.close(); }
  };

  // 预算 1 字节让每个块都退化为不缓存，得到同一代码路径的无缓存对照。
  const baseline = run(1);
  const cached = run();
  expect(cached.rows).toEqual(baseline.rows);
  expect(cached.result.body_read.message_decodes).toBe(requests + window - 1);
  expect(baseline.result.body_read.message_decodes)
    .toBeGreaterThan(cached.result.body_read.message_decodes);
  console.log(`derive_body_cache baseline_ms=${baseline.elapsed.toFixed(1)}`
    + ` cached_ms=${cached.elapsed.toFixed(1)}`
    + ` baseline_decodes=${baseline.result.body_read.message_decodes}`
    + ` cached_decodes=${cached.result.body_read.message_decodes}`);
});

test('三笔共享链在组内按不同块解码，追加后新一轮重新建立作用域', () => {
  const f = fixture();
  try {
    seedTextChain(f.store, [['A'], ['A', 'B'], ['A', 'B', 'C']]);
    enqueueDerive(f.store, CHAIN_GROUP, CHAIN_ACTOR, '');
    const first = drainDerive(f.store);
    expect(first.processed).toBe(3);
    // 6 条引用只解 3 个不同块；回复摘要、工具配对、后台作业与展示阶段共享命中。
    expect(first.body_read.message_decodes).toBe(3);
    expect(first.body_read.message_misses).toBe(3);
    expect(first.body_read.message_hits).toBeGreaterThan(0);

    appendChainRequest(f, 4, ['A', 'B', 'C', 'D'], 1_003);
    enqueueDerive(f.store, CHAIN_GROUP, CHAIN_ACTOR, '');
    const appended = drainDerive(f.store);
    expect(appended.processed).toBe(4);
    // 新作用域不沿用上一轮缓存：4 个不同块各解一次，但 10 条引用没有各自重解。
    expect(appended.body_read.message_decodes).toBe(4);
    expect(appended.body_read.message_hits).toBeGreaterThan(0);

    // clean 且无输入变化时不再派生，也不产生解码。
    const idle = drainDerive(f.store);
    expect(idle.processed).toBe(0);
    expect(idle.body_read.message_decodes).toBe(0);
  } finally { f.close(); }
});
