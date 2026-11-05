import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { fixture } from './fixtures';
import { previewSourceReset, resetSource } from '../src/maintenance/purge';
import { verifyDatabase } from '../src/maintenance/verify';

/** 合成场景：本地独占一行、与网关混合一行、其它来源一行。 */
function seed(store: ReturnType<typeof fixture>['store']): void {
  store.write(db => {
    db.run(`INSERT INTO request(req_id,started_ms,day,via,conv_key,conv_source,actor,actor_state,
              body_state,derive_version,have,created_at,updated_at)
            VALUES (1,1,'2026-11-01','session','k1','hermes-session','a','known','pending',0,16,1,1),
                   (2,2,'2026-11-02','session','k2','hermes-session','a','known','available',0,18,1,1),
                   (3,3,'2026-11-03','session','k3','claude-session','a','known','pending',0,16,1,1)`);
    db.run(`INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,added_at)
            VALUES (1,'hermes_session_call','h1','merged',1),
                   (2,'hermes_session_call','h2','merged',1),
                   (2,'ledger','l2','merged',1),
                   (3,'claude_session_call','c3','merged',1)`);
    db.run(`INSERT INTO cost_observation(ref_key,observed_at,projection_hash,payload_json)
            VALUES ('h1',1,'h','{}'),('h2',1,'h','{}'),('l2',1,'h','{}'),('c3',1,'h','{}')`);
    db.run(`INSERT INTO source_cursor(source_kind,source_name,file_generation,committed_off,last_ok_ms)
            VALUES ('hermes_session','h-state','g1',10,1),('claude_session','c-state','g2',20,1)`);
    db.run(`INSERT INTO raw_session_event(source_kind,file_generation,byte_offset,line_type,
              payload_json,privacy_version)
            VALUES ('hermes_session','g1',1,'message','{}',1),
                   ('claude_session','g2',2,'message','{}',1)`);
  });
}

test('重置预览只读：报出本地独占、混合、游标与原始行', () => {
  const f = fixture();
  try {
    seed(f.store);
    expect(previewSourceReset(f.store, 'hermes_session')).toEqual({
      source_kind: 'hermes_session', evidence_kind: 'hermes_session_call',
      evidence: 2, local_only_requests: 1, mixed_requests: 1, cursors: 1, raw_rows: 1,
      first_day: '2026-11-01', last_day: '2026-11-02',
    });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request').get()).toEqual({ n: 3 });
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM request_evidence').get()).toEqual({ n: 4 });
  } finally {
    f.close();
  }
});

test('重置一个来源：独占行删除、混合行保留并清会话位，不写墓碑', () => {
  const f = fixture();
  try {
    seed(f.store);
    const result = resetSource(f.store, 'hermes_session', 'approval-synthetic-reset');
    expect(result.deleted).toBe(1);

    // 混合行与其它来源的行都还在；混合行的网关证据与 have 位保留，会话位清掉。
    expect(f.store.read.query(
      'SELECT req_id, have, body_state FROM request ORDER BY req_id').all(),
    ).toEqual([
      { req_id: 2, have: 2, body_state: 'available' },
      { req_id: 3, have: 16, body_state: 'pending' },
    ]);
    expect(f.store.read.query(
      'SELECT req_id, source_kind, ref_key FROM request_evidence ORDER BY source_kind').all(),
    ).toEqual([
      { req_id: 3, source_kind: 'claude_session_call', ref_key: 'c3' },
      { req_id: 2, source_kind: 'ledger', ref_key: 'l2' },
    ]);
    // 这个来源的费用观测、游标与原始行清空；其它来源不动。
    expect(f.store.read.query('SELECT ref_key FROM cost_observation ORDER BY ref_key').all())
      .toEqual([{ ref_key: 'c3' }, { ref_key: 'l2' }]);
    expect(f.store.read.query(
      'SELECT source_kind, source_name FROM source_cursor ORDER BY source_kind').all())
      .toEqual([{ source_kind: 'claude_session', source_name: 'c-state' }]);
    expect(f.store.read.query(
      'SELECT source_kind FROM raw_session_event ORDER BY source_kind').all())
      .toEqual([{ source_kind: 'claude_session' }]);
    // 重置的目的就是让同一批调用重新落库，不留给重放拦截用的墓碑。
    expect(f.store.read.query('SELECT COUNT(*) AS n FROM purged_evidence').get()).toEqual({ n: 0 });
    expect(f.store.read.query(
      'SELECT action, reason, approval_id FROM retention_event').get()).toEqual({
      action: 'reset_source', reason: 'source_reset:hermes_session',
      approval_id: 'approval-synthetic-reset',
    });
    expect(f.store.read.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(verifyDatabase(join(f.dir, 'trace.db')).dangling_blocks).toBe(0);
  } finally {
    f.close();
  }
});

test('重置未知来源直接拒绝，不猜', () => {
  const f = fixture();
  try {
    expect(() => previewSourceReset(f.store, 'no_such_source')).toThrow('source_kind_unknown');
    expect(() => resetSource(f.store, 'no_such_source', 'approval-synthetic-reset'))
      .toThrow('source_kind_unknown');
  } finally {
    f.close();
  }
});
