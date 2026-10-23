import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
import {
  beginGeneration, discardGeneration, publishGeneration, readEffectiveGroup, recoverSlice,
} from '../src/derive-slice';

function seedGroup(f: ReturnType<typeof fixture>): void {
  f.store.write(db => {
    db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
      body_state,derive_version,have,created_at,updated_at,title,title_source,
      input_epoch,input_revision,purpose_revision,purpose_version,req_kind,model_title)
      VALUES (1,'c','a','known',100,'2026-10-22','hook','available',0,1,1,1,
        'old title','model_time','e1',7,11,3,'chat','model title')`);
    db.run(`INSERT INTO derive_queue(conv_key,actor,from_sort,group_epoch,input_revision,
      published_revision,target_algorithm,published_algorithm,state,dirty_since_ms)
      VALUES ('c','a','','g1',7,7,5,5,'dirty',50)`);
  });
}

function seedResult(f: ReturnType<typeof fixture>, generation: string, title: string | null): void {
  f.store.write(db => db.run(`INSERT INTO derive_request_result(
    generation,req_id,input_epoch,input_revision,sort_source,sort_key,started_ms,
    title,title_source,traversal_ord,purpose_revision,purpose_version,algorithm,
    retention_state,basis_json)
    VALUES (?,1,'e1',7,NULL,NULL,100,?,'model_time',0,11,3,5,'recomputed','{}')`,
    [generation, title]));
}

function readyGeneration(f: ReturnType<typeof fixture>, generation: string): void {
  f.store.write(db => db.run(`UPDATE derive_generation SET state='ready',stage='done',
    request_count=1 WHERE generation=?`, [generation]));
}

test('发布指针原子切换并保留旧代结果', () => {
  const f = fixture();
  try {
    seedGroup(f);
    const first = beginGeneration(f.store, 'c', 'a', 1000)!;
    expect(first).toStartWith('gen-');
    seedResult(f, first, 'first title');
    readyGeneration(f, first);
    expect(publishGeneration(f.store.db, first, 1100)).toBe(true);
    let queue = f.store.read.query('SELECT * FROM derive_queue').get() as Record<string, unknown>;
    expect(queue).toMatchObject({ state: 'clean', published_generation: first,
      published_revision: 7, published_algorithm: 5, legacy_snapshot: 0 });
    expect(queue.compute_generation).toBeNull();

    f.store.write(db => db.run(`UPDATE derive_queue SET state='dirty',
      input_revision=8,dirty_since_ms=1200 WHERE conv_key='c' AND actor='a'`));
    const second = beginGeneration(f.store, 'c', 'a', 1300)!;
    seedResult(f, second, 'second title');
    readyGeneration(f, second);
    expect(publishGeneration(f.store.db, second, 1400)).toBe(true);
    queue = f.store.read.query('SELECT * FROM derive_queue').get() as Record<string, unknown>;
    expect(queue.published_generation).toBe(second);
    expect(f.store.read.query('SELECT state FROM derive_generation WHERE generation=?')
      .get(first)).toEqual({ state: 'retired' });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM derive_request_result WHERE generation=?')
      .get(first)).toEqual({ n: 1 });
  } finally { f.close(); }
});

test('修订变化使旧代失去发布资格并丢弃结果', () => {
  const f = fixture();
  try {
    seedGroup(f);
    const generation = beginGeneration(f.store, 'c', 'a', 1000)!;
    seedResult(f, generation, 'stale title');
    readyGeneration(f, generation);
    f.store.write(db => db.run(`UPDATE derive_queue SET input_revision=8 WHERE conv_key='c' AND actor='a'`));
    expect(publishGeneration(f.store.db, generation, 1100)).toBe(false);
    expect(f.store.read.query('SELECT state FROM derive_generation WHERE generation=?')
      .get(generation)).toEqual({ state: 'discarded' });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM derive_request_result WHERE generation=?')
      .get(generation)).toEqual({ n: 0 });
    expect((f.store.read.query('SELECT * FROM derive_queue').get() as Record<string, unknown>)
      .published_generation).toBeNull();
  } finally { f.close(); }
});

test('重开丢弃未发布代际，不碰上一代已发布结果', () => {
  const f = fixture();
  try {
    seedGroup(f);
    const published = beginGeneration(f.store, 'c', 'a', 1000)!;
    seedResult(f, published, 'published title');
    readyGeneration(f, published);
    publishGeneration(f.store.db, published, 1100);
    f.store.write(db => db.run(`UPDATE derive_queue SET state='dirty',input_revision=8,
      dirty_since_ms=1200 WHERE conv_key='c' AND actor='a'`));
    const building = beginGeneration(f.store, 'c', 'a', 1300)!;
    seedResult(f, building, 'unpublished');
    expect(recoverSlice(f.store.db, 1400)).toBe(1);
    const queue = f.store.read.query('SELECT * FROM derive_queue').get() as Record<string, unknown>;
    expect(queue.state).toBe('dirty');
    expect(queue.compute_generation).toBeNull();
    expect(queue.published_generation).toBe(published);
    expect(f.store.read.query('SELECT state FROM derive_generation WHERE generation=?')
      .get(building)).toEqual({ state: 'discarded' });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM derive_request_result WHERE generation=?')
      .get(published)).toEqual({ n: 1 });
  } finally { f.close(); }
});

test('同快照读取按组状态屏蔽且不回退旧请求列', () => {
  const f = fixture();
  try {
    seedGroup(f);
    const generation = beginGeneration(f.store, 'c', 'a', 1000)!;
    seedResult(f, generation, null);
    readyGeneration(f, generation);
    publishGeneration(f.store.db, generation, 1100);
    f.store.write(db => db.run(`UPDATE derive_queue SET state='dirty',input_revision=8,
      dirty_since_ms=1200 WHERE conv_key='c' AND actor='a'`));
    const masked = readEffectiveGroup(f.store.read, 'c', 'a');
    expect(masked.state).toBe('masked');
    expect(masked.rows).toEqual([]);

    f.store.write(db => db.run(`UPDATE derive_queue SET state='clean',input_revision=7,
      published_revision=7 WHERE conv_key='c' AND actor='a'`));
    const current = readEffectiveGroup(f.store.read, 'c', 'a');
    expect(current.state).toBe('current');
    expect(current.rows[0]).toMatchObject({
      generation, req_kind: 'chat', model_title: 'model title', title: null,
    });
    // request.title 仍是 'old title'；结果 title 为 NULL 时必须保持 NULL。
    expect(current.rows[0]!.title).toBeNull();
  } finally { f.close(); }
});

test('丢弃已发布代际时不动结果，也不清发布指针', () => {
  const f = fixture();
  try {
    seedGroup(f);
    const generation = beginGeneration(f.store, 'c', 'a', 1000)!;
    seedResult(f, generation, 'kept title');
    readyGeneration(f, generation);
    publishGeneration(f.store.db, generation, 1100);
    discardGeneration(f.store.db, generation, 'slice_request_budget', 1200);
    expect(f.store.read.query('SELECT state FROM derive_generation WHERE generation=?')
      .get(generation)).toEqual({ state: 'published' });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM derive_request_result WHERE generation=?')
      .get(generation)).toEqual({ n: 1 });
    const queue = f.store.read.query('SELECT * FROM derive_queue').get() as Record<string, unknown>;
    expect(queue.published_generation).toBe(generation);
    expect(queue.state).toBe('clean');
  } finally { f.close(); }
});