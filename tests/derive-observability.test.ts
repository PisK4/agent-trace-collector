import { expect, test } from 'bun:test';
import { createDeriveUnit } from '../src/derive/unit';
import type { DeriveRoundEvent } from '../src/derive/unit';
import { fixture, seedPurposeRequest } from './fixtures';

test('空闲 tick 不记录，实际计算记录关联编号与计算/落库耗时', async () => {
  const f = fixture();
  try {
    const events: DeriveRoundEvent[] = [];
    const unit = () => createDeriveUnit(f.store, { onRound: event => events.push(event) });
    expect(await unit().run({ budgetMs: 400 })).toEqual({ didWork: false, nextDueMs: 2000 });
    expect(events).toHaveLength(0);
    seedPurposeRequest(f.store, { convKey: 'a', messages: [{ role: 'user', content: 'a' }] });
    expect(await unit().run({ budgetMs: 400 })).toEqual({ didWork: true, nextDueMs: 2000 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ result: 'whole' });
    expect(events[0]!.corr).toMatch(/^round-\d+$/);
    expect(typeof events[0]!.compute_ms).toBe('number');
    expect(typeof events[0]!.apply_ms).toBe('number');
  } finally { f.close(); }
});

test('组失败记录 failure 与固定错误码，同一轮编号可对上', async () => {
  const f = fixture();
  try {
    for (const convKey of ['a', 'b']) {
      seedPurposeRequest(f.store, { convKey, messages: [{ role: 'user', content: convKey }] });
    }
    const events: DeriveRoundEvent[] = [];
    f.store.db.exec(`CREATE TRIGGER fail_second_group BEFORE UPDATE OF state ON derive_queue
      WHEN NEW.conv_key='b' AND NEW.state='clean'
      BEGIN SELECT RAISE(ABORT,'synthetic_ack_failure'); END`);
    const unit = createDeriveUnit(f.store, { onRound: event => events.push(event) });
    await expect(unit.run({ budgetMs: 400 })).rejects.toThrow('synthetic_ack_failure');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ result: 'whole' });
    expect(events[1]).toMatchObject({ result: 'failure', code: 'synthetic_ack_failure' });
    expect(events[1]!.corr).toMatch(/^round-\d+$/);
  } finally { f.close(); }
});
