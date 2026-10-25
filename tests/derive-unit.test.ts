import { expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { createDeriveUnit, drainDeriveEntry } from '../src/derive/unit';
import { openStore } from '../src/store';
import { fixture, seedPurposeRequest } from './fixtures';

function seedGroups(f: ReturnType<typeof fixture>): void {
  for (const convKey of ['a', 'b', 'c']) {
    seedPurposeRequest(f.store, { convKey, messages: [{ role: 'user', content: convKey }] });
  }
}

test('空闲工作单元与维护入口都不开写事务', () => {
  const f = fixture();
  try {
    const before = f.store.writeStats.count;
    expect(createDeriveUnit(f.store).run({ budgetMs: 400 })).toEqual({ didWork: false, nextDueMs: 2000 });
    expect(drainDeriveEntry(f.store)).toMatchObject({ processed: 0, remaining: 0, purpose_remaining: 0 });
    expect(f.store.writeStats.count).toBe(before);
  } finally { f.close(); }
});

test('组间耗尽预算后保留已提交组，下轮继续积压', () => {
  const f = fixture();
  let elapsed = 0;
  const clock = spyOn(performance, 'now').mockImplementation(() => elapsed);
  try {
    seedGroups(f);
    const write = f.store.write;
    // 虚拟时钟在组提交后耗尽预算，避免测试依赖运行机器的速度。
    f.store.write = fn => {
      const result = write(fn);
      const clean = f.store.read.query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM derive_queue WHERE state='clean'").get()!.n;
      if (clean > 0) elapsed = 5;
      return result;
    };
    const unit = createDeriveUnit(f.store);
    expect(unit.run({ budgetMs: 5 })).toEqual({ didWork: true, nextDueMs: 0 });
    expect(f.store.read.query("SELECT conv_key FROM derive_queue WHERE state='clean'").all())
      .toEqual([{ conv_key: 'a' }]);
    f.store.write = write;
    expect(unit.run({ budgetMs: 400 })).toEqual({ didWork: true, nextDueMs: 2000 });
    expect(f.store.read.query("SELECT COUNT(*) AS n FROM derive_queue WHERE state='dirty'").get())
      .toEqual({ n: 0 });
  } finally { clock.mockRestore(); f.close(); }
});

test('第二组失败只回滚该组，重开库保留已完成组并继续', () => {
  const f = fixture();
  let reopened: ReturnType<typeof openStore> | undefined;
  try {
    seedGroups(f);
    f.store.db.exec(`CREATE TRIGGER fail_second_group BEFORE UPDATE OF state ON derive_queue
      WHEN NEW.conv_key='b' AND NEW.state='clean'
      BEGIN SELECT RAISE(ABORT,'synthetic_ack_failure'); END`);
    expect(() => createDeriveUnit(f.store).run({ budgetMs: 400 })).toThrow('synthetic_ack_failure');
    f.store.close();
    reopened = openStore(join(f.dir, 'trace.db'));
    expect(reopened.read.query('SELECT conv_key,state FROM derive_queue ORDER BY conv_key').all())
      .toEqual([{ conv_key: 'a', state: 'clean' }, { conv_key: 'b', state: 'dirty' },
        { conv_key: 'c', state: 'dirty' }]);
    expect(reopened.read.query("SELECT prev_relation FROM request WHERE conv_key='b'").get())
      .toEqual({ prev_relation: null });
    reopened.db.exec('DROP TRIGGER fail_second_group');
    expect(createDeriveUnit(reopened).run({ budgetMs: 400 })).toEqual({ didWork: true, nextDueMs: 2000 });
  } finally { reopened?.close(); f.close(); }
});

test('在线每轮最多完成十个组，维护排空仍按显式limit', () => {
  const f = fixture();
  try {
    for (let index = 0; index < 12; index++) {
      seedPurposeRequest(f.store, { convKey: `group-${index}` });
    }
    expect(createDeriveUnit(f.store).run({ budgetMs: 400 })).toEqual({ didWork: true, nextDueMs: 0 });
    expect(f.store.read.query("SELECT COUNT(*) AS n FROM derive_queue WHERE state='clean'").get())
      .toEqual({ n: 10 });
    expect(drainDeriveEntry(f.store, 1)).toMatchObject({ processed: 1, remaining: 1 });
  } finally { f.close(); }
});

test('预算非法时在写入前拒绝', () => {
  const f = fixture();
  try {
    const before = f.store.writeStats.count;
    for (const budgetMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createDeriveUnit(f.store).run({ budgetMs })).toThrow('invalid_derive_budget');
    }
    expect(f.store.writeStats.count).toBe(before);
  } finally { f.close(); }
});
