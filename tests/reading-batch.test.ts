import { expect, test } from 'bun:test';
import { fixture, seedPurposeRequest } from './fixtures';
import { getReadingBatch, getReadingRangeBatch } from '../src/reading';
import type { BatchBudget } from '../src/reading';
import type { BatchItem } from '../src/read-contract';

const COMMON = { cleanGroup: true, purposePending: 0, summaryState: 'recomputed', summaryAlgorithm: 1 } as const;

/** 手控时钟：预算检查点按测试推进，不靠真实耗时。 */
function budget(overrides: Partial<BatchBudget> = {}): BatchBudget {
  return { maxBytes: 1024 * 1024, maxMs: 20, clock: () => 0, ...overrides };
}

const stateOf = (item: BatchItem<unknown>): string =>
  item.state === 'ok' ? 'ok' : item.state;

test('详情和元信息共用批内阅读身份', () => {
  const f = fixture();
  try {
    const key = 'batch-synthetic';
    const ids = [1, 2].map(n => seedPurposeRequest(f.store, {
      convKey: key, startedMs: n,
      messages: [{ role: 'user', content: `synthetic ${n}` }],
      ...COMMON,
    }));
    const batch = getReadingBatch(f.store, key, ids);
    expect(batch.next_index).toBeNull();
    expect(batch.items.map(item => item.index)).toEqual([0, 1]);
    expect(batch.items.every(item => item.state === 'ok')).toBe(true);
    for (const item of batch.items) {
      if (item.state !== 'ok') throw new Error('expected synthetic success');
      expect(item.value.detail.req_id).toBe(item.value.meta.req_id);
      expect(item.value.detail.reading_token).toBe(item.value.meta.reading_token);
      expect(item.value.detail.conv_key).toBe(key);
    }
  } finally { f.close(); }
});

test('canonical 别名按旧 id 请求返回折叠后的现身内容', () => {
  const f = fixture();
  try {
    const key = 'batch-alias';
    const common = { ...COMMON, convKey: key };
    const keeper = seedPurposeRequest(f.store, { ...common, startedMs: 1, messages: [{ role: 'user', content: 'keep' }] });
    const folded = seedPurposeRequest(f.store, { ...common, startedMs: 2, messages: [{ role: 'user', content: 'fold' }] });
    f.store.write(db => {
      db.run('INSERT INTO request_alias(old_id,new_id) VALUES (?,?)', [folded, keeper]);
      db.run('DELETE FROM request WHERE req_id=?', [folded]);
    });
    const batch = getReadingBatch(f.store, key, [folded]);
    expect(batch.items).toHaveLength(1);
    const item = batch.items[0]!;
    if (item.state !== 'ok') throw new Error('expected alias resolution');
    expect(item.requested_id).toBe(folded);
    expect(item.value.detail.req_id).toBe(keeper);
  } finally { f.close(); }
});

test('跨会话与不存在的 id 单列 not_found，不返回内容', () => {
  const f = fixture();
  try {
    const mine = seedPurposeRequest(f.store, {
      convKey: 'batch-mine', startedMs: 1, messages: [{ role: 'user', content: 'mine' }], ...COMMON,
    });
    const other = seedPurposeRequest(f.store, {
      convKey: 'batch-other', startedMs: 2, messages: [{ role: 'user', content: 'other' }], ...COMMON,
    });
    const batch = getReadingBatch(f.store, 'batch-mine', [mine, other, 999999]);
    expect(batch.items.map(stateOf)).toEqual(['ok', 'not_found', 'not_found']);
    const leaked = batch.items.find(item => item.requested_id === other);
    expect(leaked !== undefined && 'value' in leaked).toBe(false);
  } finally { f.close(); }
});

test('同批项的阅读身份与同会话单项读取一致，冲突项单列 reading_changed', () => {
  const f = fixture();
  try {
    const key = 'batch-conflict';
    const id = seedPurposeRequest(f.store, {
      convKey: key, startedMs: 1, messages: [{ role: 'user', content: 'q' }], ...COMMON,
    });
    const token = getReadingBatch(f.store, key, [id]).items[0]!;
    if (token.state !== 'ok') throw new Error('expected success');
    const current = token.value.detail.reading_token;
    const batch = getReadingRangeBatch(f.store, key, [
      { id, token: current, from: 0, to: 1 },
      { id, token: 'r1-' + 'f'.repeat(64), from: 0, to: 1 },
    ]);
    expect(batch.items.map(stateOf)).toEqual(['ok', 'reading_changed']);
    const ok = batch.items[0]!;
    if (ok.state !== 'ok') throw new Error('expected first success');
    expect(ok.value.reading_token).toBe(current);
    const stale = batch.items[1]!;
    if (stale.state !== 'reading_changed') throw new Error('expected conflict');
    expect(stale.reason).toBe('reading_changed');
  } finally { f.close(); }
});

test('非可读正文按状态说明返回，批项仍是 ok 且内容为空', () => {
  const f = fixture();
  try {
    const key = 'batch-evicted';
    const id = seedPurposeRequest(f.store, {
      convKey: key, startedMs: 1, messages: [{ role: 'user', content: 'gone' }], ...COMMON,
    });
    f.store.write(db => db.run(
      `UPDATE request SET body_state='evicted', body_evict_reason='budget' WHERE req_id=?`, [id]));
    const batch = getReadingBatch(f.store, key, [id]);
    const item = batch.items[0]!;
    expect(item.state).toBe('ok');
    if (item.state !== 'ok') throw new Error('unreachable');
    expect(item.value.meta.state).toBe('evicted');
    expect(item.value.meta.reason).toBe('budget');
    expect(item.value.meta.messages).toEqual([]);
  } finally { f.close(); }
});

test('范围批的每个区间独立成项，同请求多区间都保留', () => {
  const f = fixture();
  try {
    const key = 'batch-ranges';
    const id = seedPurposeRequest(f.store, {
      convKey: key, startedMs: 1,
      messages: Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: `m${i}` })),
      ...COMMON,
    });
    const token = getReadingBatch(f.store, key, [id]).items[0]!;
    if (token.state !== 'ok') throw new Error('expected token');
    const t = token.value.detail.reading_token;
    const batch = getReadingRangeBatch(f.store, key, [
      { id, token: t, from: 0, to: 0 },
      { id, token: t, from: 1, to: 3 },
      { id, token: t, from: 3, to: 5 },
    ]);
    expect(batch.next_index).toBeNull();
    expect(batch.items.map(stateOf)).toEqual(['ok', 'ok', 'ok']);
    expect(batch.items.map(item => item.index)).toEqual([0, 1, 2]);
    if (batch.items[1]!.state !== 'ok') throw new Error('unreachable');
    expect(batch.items[1]!.value.messages.map(m => m.ord)).toEqual([1, 2]);
    // 每个区间带同一阅读身份。
    expect(batch.items.every(item =>
      item.state !== 'ok' || item.value.reading_token === t)).toBe(true);
  } finally { f.close(); }
});

test('超大项返回 oversized 并推进，后续项留在 next_index', () => {
  const f = fixture();
  try {
    const key = 'batch-oversized';
    const ids = [1, 2].map(n => seedPurposeRequest(f.store, {
      convKey: key, startedMs: n,
      messages: [{ role: 'user', content: `synthetic ${n}` }],
      ...COMMON,
    }));
    // 字节上限设得比首项小：首项内容超限被替换为 oversized，不返回正文。
    const batch = getReadingBatch(f.store, key, ids, { maxBytes: 8, maxMs: 20, clock: () => 0 });
    const first = batch.items[0]!;
    expect(first.state).toBe('oversized');
    if (first.state !== 'oversized') throw new Error('unreachable');
    expect(first.reason).toBe('item_too_large');
    expect('value' in first).toBe(false);
    // 超限后停止：第二项留给 next_index 续读。
    expect(batch.next_index).toBe(1);
  } finally { f.close(); }
});

test('软超时在项边界停止，已完成项覆盖 [0, next_index)', () => {
  const f = fixture();
  try {
    const key = 'batch-soft-timeout';
    const ids = [1, 2, 3].map(n => seedPurposeRequest(f.store, {
      convKey: key, startedMs: n,
      messages: [{ role: 'user', content: `synthetic ${n}` }],
      ...COMMON,
    }));
    // 时钟每次调用走 15ms：起点 15，首项完成时 30，elapsed 15 已过 maxMs=10——
    // 第二项起不处理。
    let ticks = 0;
    const batch = getReadingBatch(f.store, key, ids, {
      maxBytes: 1024 * 1024, maxMs: 10, clock: () => { ticks += 1; return ticks * 15; },
    });
    expect(batch.items.map(stateOf)).toEqual(['ok']);
    expect(batch.next_index).toBe(1);
    // 预算充足时同一批全部完成。
    const full = getReadingBatch(f.store, key, ids, budget());
    expect(full.next_index).toBeNull();
    expect(full.items.map(stateOf)).toEqual(['ok', 'ok', 'ok']);
  } finally { f.close(); }
});

test('重复 id 保留每个 index，不合并项', () => {
  const f = fixture();
  try {
    const key = 'batch-dup';
    const id = seedPurposeRequest(f.store, {
      convKey: key, startedMs: 1, messages: [{ role: 'user', content: 'once' }], ...COMMON,
    });
    const batch = getReadingBatch(f.store, key, [id, id]);
    expect(batch.items.map(item => item.index)).toEqual([0, 1]);
    expect(batch.items.map(item => item.requested_id)).toEqual([id, id]);
    expect(batch.items.every(item => item.state === 'ok')).toBe(true);
  } finally { f.close(); }
});

test('区间批跨请求混合，别名 id 解析到 canonical', () => {
  const f = fixture();
  try {
    const key = 'batch-sparse';
    const common = { ...COMMON, convKey: key };
    const a = seedPurposeRequest(f.store, {
      ...common, startedMs: 1,
      messages: Array.from({ length: 4 }, (_, i) => ({ role: 'user', content: `a${i}` })),
    });
    const keeper = seedPurposeRequest(f.store, { ...common, startedMs: 2, messages: [{ role: 'user', content: 'keep' }] });
    const folded = seedPurposeRequest(f.store, { ...common, startedMs: 3, messages: [{ role: 'user', content: 'fold' }] });
    f.store.write(db => {
      db.run('INSERT INTO request_alias(old_id,new_id) VALUES (?,?)', [folded, keeper]);
      db.run('DELETE FROM request WHERE req_id=?', [folded]);
    });
    const tokens = getReadingBatch(f.store, key, [a, keeper]).items;
    const tokenOf = (id: number): string => {
      const item = tokens.find(entry => entry.requested_id === id)!;
      if (item.state !== 'ok') throw new Error('expected token');
      return item.value.detail.reading_token;
    };
    // 稀疏区间（不连续 ord）与别名 id 同批：别名按旧 id 回显、内容来自 canonical。
    const batch = getReadingRangeBatch(f.store, key, [
      { id: a, token: tokenOf(a), from: 1, to: 2 },
      { id: folded, token: tokenOf(keeper), from: 0, to: 0 },
    ]);
    expect(batch.items.map(stateOf)).toEqual(['ok', 'ok']);
    const [first, second] = batch.items;
    if (first?.state !== 'ok' || second?.state !== 'ok') throw new Error('unreachable');
    expect(first.value.messages.map(m => m.ord)).toEqual([1]);
    expect(second.value.req_id).toBe(keeper);
    expect(second.requested_id).toBe(folded);
  } finally { f.close(); }
});
