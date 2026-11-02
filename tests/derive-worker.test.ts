import { expect, test } from 'bun:test';
import { createDeriveUnit, drainDeriveEntry } from '../src/derive/unit';
import { createDeriveWorker } from '../src/derive/worker';
import { fixture, seedChain } from './fixtures';

const SESSIONS = [{ texts: ['S'] }, { texts: ['S', 'A'] }, { texts: ['S', 'A', 'B'] }];

function derivedRows(f: ReturnType<typeof fixture>): unknown {
  return {
    requests: f.store.read.query(`SELECT req_id,prev_req_id,prev_relation,delta_ordinals,chain_role,
      title,title_source FROM request ORDER BY req_id`).all(),
    tools: f.store.read.query('SELECT req_id,tool_name,arg_path,is_error FROM tool_call ORDER BY req_id,tool_name').all(),
    queue: f.store.read.query('SELECT state,last_error FROM derive_queue').all(),
  };
}

test('Worker 计算与主线程计算在同一合成组上产出同一份派生行', async () => {
  const main = fixture();
  const workerRun = fixture();
  const worker = createDeriveWorker(workerRun.store.path);
  try {
    seedChain(main.store, SESSIONS);
    seedChain(workerRun.store, SESSIONS);
    await drainDeriveEntry(main.store, 10);
    await createDeriveUnit(workerRun.store, { compute: worker.compute }).run({ budgetMs: 400 });
    expect(derivedRows(workerRun)).toEqual(derivedRows(main));
  } finally {
    worker.close();
    workerRun.close();
    main.close();
  }
});

test('计算线程失败时这一组保持 dirty，不半发布', async () => {
  const f = fixture();
  const worker = createDeriveWorker(`${f.dir}/missing.db`);
  try {
    seedChain(f.store, SESSIONS);
    await expect(createDeriveUnit(f.store, { compute: worker.compute }).run({ budgetMs: 400 }))
      .rejects.toThrow();
    expect(f.store.read.query('SELECT state FROM derive_queue').get()).toEqual({ state: 'dirty' });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request WHERE prev_relation IS NOT NULL').get())
      .toEqual({ n: 0 });
  } finally {
    worker.close();
    f.close();
  }
});
