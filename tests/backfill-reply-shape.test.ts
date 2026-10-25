import { expect, test } from 'bun:test';
import { backfillReplyShapes } from '../scripts/backfill-reply-shape';
import { persistBody } from '../src/body';
import { evictOldestBodyBatch } from '../src/retention';
import { DERIVE_ALGORITHM } from '../src/derive/slice';
import { fixture, seedRequest, SEED_GROUP } from './fixtures';

const FINAL_REPLY = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
const TOOLS_REPLY = { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'read' }] };

const requestShapes = (f: ReturnType<typeof fixture>) =>
  f.store.read.query<{ req_id: number; reply_shape: string | null }, []>(
    'SELECT req_id, reply_shape FROM request ORDER BY req_id').all();

test('形状回填：可读行按内核重算，无正文行标 unknown，重跑幂等', () => {
  const f = fixture();
  try {
    seedRequest(f.store, [
      { req_id: 1, started_ms: 100, sort_source: null, sort_key: null },
      { req_id: 2, started_ms: 200, sort_source: null, sort_key: null },
      { req_id: 3, started_ms: 300, sort_source: null, sort_key: null },
    ]);
    persistBody(f.store, 1, {
      protocol: 'anthropic', request: { messages: [] }, reply: FINAL_REPLY, redact_version: 1,
    });
    persistBody(f.store, 2, {
      protocol: 'anthropic', request: { messages: [] }, reply: TOOLS_REPLY, redact_version: 1,
    });
    const first = backfillReplyShapes(f.store.db);
    expect(first.computed).toBe(2);
    expect(first.unknown).toBe(1);
    expect(requestShapes(f)).toEqual([
      { req_id: 1, reply_shape: 'final' },
      { req_id: 2, reply_shape: 'tools' },
      { req_id: 3, reply_shape: 'unknown' },
    ]);
    // 重跑写同一批值：计数一致，结果不变。
    expect(backfillReplyShapes(f.store.db)).toEqual(first);
    expect(requestShapes(f)).toEqual([
      { req_id: 1, reply_shape: 'final' },
      { req_id: 2, reply_shape: 'tools' },
      { req_id: 3, reply_shape: 'unknown' },
    ]);
  } finally { f.close(); }
});

test('形状回填：回收后的行标 unknown；发布代暂存行一并补算', () => {
  const f = fixture();
  try {
    seedRequest(f.store, [
      { req_id: 1, started_ms: 100, sort_source: null, sort_key: null },
      { req_id: 2, started_ms: 200, sort_source: null, sort_key: null },
    ]);
    persistBody(f.store, 1, {
      protocol: 'anthropic', request: { messages: [] }, reply: FINAL_REPLY, redact_version: 1,
    });
    persistBody(f.store, 2, {
      protocol: 'anthropic', request: { messages: [] }, reply: TOOLS_REPLY, redact_version: 1,
    });
    // 回收最老的一笔：正文没了，形状无法重算。
    expect(evictOldestBodyBatch(f.store, 1000, 1).requests).toBe(1);
    // 发布代：队列行带发布指针，暂存行缺形状列值（升级前的旧代）。
    f.store.write(db => {
      db.run(`INSERT INTO derive_queue(conv_key,actor,from_sort,group_epoch,input_revision,
        published_revision,target_algorithm,published_algorithm,state,published_generation)
        VALUES (?,?,'','g1',7,7,?,?,'clean','gen-backfill')
        ON CONFLICT(conv_key,actor) DO UPDATE SET state='clean', published_generation='gen-backfill',
          published_revision=input_revision, published_algorithm=target_algorithm`,
      [SEED_GROUP.convKey, SEED_GROUP.actor, DERIVE_ALGORITHM, DERIVE_ALGORITHM]);
      db.run(`INSERT INTO derive_request_result(
        generation,req_id,input_epoch,input_revision,started_ms,traversal_ord,
        purpose_revision,purpose_chain,algorithm,retention_state)
        VALUES ('gen-backfill',1,'e1',7,100,0,0,'participate',?,'recomputed'),
               ('gen-backfill',2,'e1',7,200,1,0,'participate',?,'recomputed')`,
      [DERIVE_ALGORITHM, DERIVE_ALGORITHM]);
    });
    const report = backfillReplyShapes(f.store.db);
    // req 1 已回收：request 行与暂存行都标 unknown；req 2 可读，重算 tools。
    expect(report.computed).toBe(1);
    expect(report.unknown).toBe(1);
    expect(report.published_computed).toBe(1);
    expect(report.published_unknown).toBe(1);
    const staged = f.store.read.query<{ req_id: number; reply_shape: string | null }, []>(
      `SELECT req_id, reply_shape FROM derive_request_result
       WHERE generation='gen-backfill' ORDER BY req_id`).all();
    expect(staged).toEqual([
      { req_id: 1, reply_shape: 'unknown' },
      { req_id: 2, reply_shape: 'tools' },
    ]);
  } finally { f.close(); }
});
