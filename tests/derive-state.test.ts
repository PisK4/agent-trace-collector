import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
import {
  claimGroupTx, deriveRetryBackoffMs, markGroupDirtyTx, markRequestGroupsTx,
  markRequestInputTx, normalizeTargetAlgorithmTx, purposePendingSql,
  recordDeriveFailureTx,
} from '../src/derive/state';

test('用途门控片段：已知归属且待判定，别名可选', () => {
  expect(purposePendingSql()).toBe("actor_state='known' AND purpose_pending=1");
  expect(purposePendingSql('r')).toBe("r.actor_state='known' AND r.purpose_pending=1");
});

test('认领归一目标算法只改未完成行', () => {
  const f = fixture();
  try {
    f.store.write(db => markGroupDirtyTx(db, 'k', 'a', ''));
    f.store.write(db => db.run('UPDATE derive_queue SET target_algorithm=1'));
    f.store.write(db => normalizeTargetAlgorithmTx(db, 'k', 'a', 9));
    expect(f.store.read.query('SELECT target_algorithm FROM derive_queue').get())
      .toEqual({ target_algorithm: 9 });
    // clean 行有已发布产物：再归一也不能改写它的算法出处。
    f.store.write(db => db.run(
      "UPDATE derive_queue SET state='clean',published_algorithm=1,target_algorithm=1"));
    f.store.write(db => normalizeTargetAlgorithmTx(db, 'k', 'a', 9));
    expect(f.store.read.query('SELECT target_algorithm FROM derive_queue').get())
      .toEqual({ target_algorithm: 1 });
  } finally { f.close(); }
});

test('组完成后再次触发不复用旧修订', () => {
  const f = fixture();
  try {
    f.store.write(db => markGroupDirtyTx(db, 'k', 'a', ''));
    const first = f.store.read.query<{
      group_epoch: string; input_revision: number; published_revision: number;
      state: string; dirty_since_ms: number | null;
    }, []>('SELECT group_epoch,input_revision,published_revision,state,dirty_since_ms FROM derive_queue').get()!;
    expect(first.input_revision).toBe(1);
    expect(first.published_revision).toBe(-1);
    expect(first.state).toBe('dirty');
    f.store.write(db => db.run(
      `UPDATE derive_queue SET state='clean',dirty_since_ms=NULL,
       published_revision=input_revision,published_algorithm=target_algorithm`));
    f.store.write(db => markGroupDirtyTx(db, 'k', 'a', ''));
    const next = f.store.read.query<{
      group_epoch: string; input_revision: number; published_revision: number;
      state: string; dirty_since_ms: number | null;
    }, []>('SELECT group_epoch,input_revision,published_revision,state,dirty_since_ms FROM derive_queue').get()!;
    // 同一组：epoch 不变、修订增长、完成记录不再匹配。
    expect(next.group_epoch).toBe(first.group_epoch);
    expect(next.input_revision).toBeGreaterThan(first.input_revision);
    expect(next.state).toBe('dirty');
    expect(next.published_revision).toBe(first.input_revision);
    expect(next.dirty_since_ms).not.toBeNull();
  } finally { f.close(); }
});

test('重复dirty保留最早等待时间且clean后重新计时', () => {
  const f = fixture();
  try {
    f.store.write(db => markGroupDirtyTx(db, 'k', 'a', ''));
    f.store.write(db => db.run('UPDATE derive_queue SET dirty_since_ms=1000'));
    f.store.write(db => markGroupDirtyTx(db, 'k', 'a', ''));
    expect(f.store.read.query('SELECT dirty_since_ms,input_revision FROM derive_queue').get())
      .toEqual({ dirty_since_ms: 1000, input_revision: 2 });
    f.store.write(db => db.run(`UPDATE derive_queue SET state='clean',dirty_since_ms=NULL`));
    f.store.write(db => markGroupDirtyTx(db, 'k', 'a', ''));
    expect(f.store.read.query<{ dirty_since_ms: number }, []>('SELECT dirty_since_ms FROM derive_queue').get()!
      .dirty_since_ms).toBeGreaterThan(1000);
  } finally { f.close(); }
});

test('组删除后重建拿到新epoch', () => {
  const f = fixture();
  try {
    f.store.write(db => markGroupDirtyTx(db, 'k', 'a', ''));
    const first = f.store.read.query<{ group_epoch: string }, []>(
      'SELECT group_epoch FROM derive_queue').get()!;
    f.store.write(db => db.run('DELETE FROM derive_queue'));
    f.store.write(db => markGroupDirtyTx(db, 'k', 'a', ''));
    const second = f.store.read.query<{ group_epoch: string }, []>(
      'SELECT group_epoch FROM derive_queue').get()!;
    expect(second.group_epoch).not.toBe(first.group_epoch);
  } finally { f.close(); }
});

function seedRequest(store: ReturnType<typeof fixture>['store'], reqId: number, actor: string | null, actorState: string): void {
  store.write(db => db.run(
    `INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,body_state,
       derive_version,have,created_at,updated_at)
     VALUES (?,? ,?,?,1000,'2026-10-22','through','pending',0,1,1,1)`,
    [reqId, JSON.stringify(['session', 'synthetic-session']), actor, actorState],
  ));
}

test('请求输入变化同时增加修订与待处理并标记组', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1, 'synthetic-actor', 'known');
    f.store.write(db => markRequestInputTx(db, 1));
    const first = f.store.read.query<{
      input_epoch: string; input_revision: number; purpose_pending: number;
    }, []>('SELECT input_epoch,input_revision,purpose_pending FROM request').get()!;
    expect(first.input_epoch).not.toBe('');
    expect(first.input_revision).toBe(1);
    expect(first.purpose_pending).toBe(1);
    // 只改费用：不是输入变化，修订不动。
    f.store.write(db => db.run('UPDATE request SET cost=0.5,cost_state=\'priced\''));
    expect(f.store.read.query('SELECT input_revision FROM request').get())
      .toEqual({ input_revision: 1 });
    f.store.write(db => markRequestInputTx(db, 1));
    expect(f.store.read.query('SELECT input_epoch,input_revision FROM request').get())
      .toEqual({ input_epoch: first.input_epoch, input_revision: 2 });
    expect(f.store.read.query('SELECT input_revision,state FROM derive_queue').get())
      .toEqual({ input_revision: 2, state: 'dirty' });
  } finally { f.close(); }
});

test('未知归属的请求不产生派生任务', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1, null, 'unknown');
    f.store.write(db => markRequestInputTx(db, 1));
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM derive_queue').get()).toEqual({ n: 0 });
    expect(f.store.read.query('SELECT input_revision FROM request').get()).toEqual({ input_revision: 1 });
    // 归属确认后同一入口才排组。
    f.store.write(db => db.run("UPDATE request SET actor='synthetic-actor',actor_state='known'"));
    f.store.write(db => markRequestGroupsTx(db, 1));
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM derive_queue').get()).toEqual({ n: 1 });
  } finally { f.close(); }
});

test('认领计数并清空上次失败，失败原因写回未完成组', () => {
  const f = fixture();
  try {
    f.store.write(db => markGroupDirtyTx(db, 'k', 'a', ''));
    f.store.write(db => claimGroupTx(db, 'k', 'a'));
    expect(f.store.read.query(
      'SELECT attempts,last_error,claim_from_sort FROM derive_queue').get())
      .toEqual({ attempts: 1, last_error: null, claim_from_sort: '~' });
    f.store.write(db => recordDeriveFailureTx(db, 'k', 'a', 'synthetic_ack_failure', 99));
    expect(f.store.read.query(
      'SELECT attempts,last_error,last_completed_ms FROM derive_queue').get())
      .toEqual({ attempts: 1, last_error: 'synthetic_ack_failure', last_completed_ms: 99 });
    // 重试认领：计数累加，上一次失败原因清空，等本轮结果说话。
    f.store.write(db => claimGroupTx(db, 'k', 'a'));
    expect(f.store.read.query('SELECT attempts,last_error FROM derive_queue').get())
      .toEqual({ attempts: 2, last_error: null });
    // 整组成功后失败记录不再写回：last_error 只描述未完成组。
    f.store.write(db => db.run("UPDATE derive_queue SET state='clean'"));
    f.store.write(db => recordDeriveFailureTx(db, 'k', 'a', 'late_failure', 100));
    expect(f.store.read.query('SELECT last_error FROM derive_queue').get())
      .toEqual({ last_error: null });
  } finally { f.close(); }
});

test('整轮失败退避按连续失败翻倍并封顶', () => {
  expect([1, 2, 3, 4, 5, 6, 7].map(deriveRetryBackoffMs))
    .toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
});
