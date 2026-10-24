import { expect, test } from 'bun:test';
import { hookConv, insertEvidenceTx, ledgerConv, routeConv, sessionRef } from '../src/evidence';
import { fixture, seedRequest } from './fixtures';

test('会话键回退前缀逐字固定：三种来源各自的组键形状', () => {
  expect(hookConv('s1', 'h1')).toEqual({ key: JSON.stringify(['session', 's1']), source: 'session' });
  expect(hookConv(null, 'h1')).toEqual({ key: JSON.stringify(['hook', 'h1']), source: 'hook' });
  expect(ledgerConv('s1', 'r1')).toEqual({ key: JSON.stringify(['session', 's1']), source: 'session' });
  expect(ledgerConv(null, 'r1')).toEqual({ key: JSON.stringify(['request', 'r1']), source: 'request' });
  expect(routeConv('s1', 'c1')).toEqual({ key: JSON.stringify(['session', 's1']), source: 'session' });
  expect(routeConv(null, 'c1')).toEqual({ key: JSON.stringify(['conv', 'c1']), source: 'conv' });
  expect(routeConv(null, null)).toBeNull();
  expect(sessionRef('s1')).toEqual({ key: JSON.stringify(['session', 's1']), source: 'session' });
});

test('证据登记幂等：重复登记不产生第二行', () => {
  const f = fixture();
  try {
    seedRequest(f.store, [{ req_id: 1, started_ms: 1, sort_source: null, sort_key: null }]);
    f.store.write(db => {
      insertEvidenceTx(db, 1, 'hook', 'hook-x', 'pending', 'response_id_norm.v1', 1);
      insertEvidenceTx(db, 1, 'hook', 'hook-x', 'merged', 'response_id_norm.v1', 2);
    });
    const rows = f.store.read.query('SELECT req_id, merge_state, match_rule FROM request_evidence').all();
    expect(rows).toEqual([{ req_id: 1, merge_state: 'pending', match_rule: 'response_id_norm.v1' }]);
  } finally {
    f.close();
  }
});
