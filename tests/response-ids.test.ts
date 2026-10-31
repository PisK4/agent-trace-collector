import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { fixture } from './fixtures';
import { persistBody } from '../src/body';
import { MATCH_BY_RESPONSE_ID } from '../src/evidence';
import { runMaintenance } from '../src/maintenance/cli';

/**
 * 旧规则留下的拆分现场：账本行已是裸 hash，hook 行与等待队列还带着 msg_ 前缀。
 * 正文放在 hook 行上，合并后应迁到账本行，重复行删除。
 */
function seedLegacySplit(f: ReturnType<typeof fixture>): void {
  const now = 1_700_000_000_000;
  const convKey = JSON.stringify(['session', 'synthetic-session']);
  f.store.write(db => {
    db.run(
      `INSERT INTO request(req_id,route_id,response_id_norm,agent,session,conv_key,conv_source,actor,actor_state,
         started_ms,day,via,status,body_state,derive_version,have,created_at,updated_at,title,title_source)
       VALUES (1,101,'synthetic_route','alpha','synthetic-session',?,'session','synthetic-session','known',
         ?,'2026-10-31','through',200,'pending',0,6,?,?,'ledger title','model_time')`,
      [convKey, now, now, now]);
    db.run(
      `INSERT INTO request(req_id,response_id_norm,agent,session,conv_key,conv_source,actor,actor_state,
         started_ms,day,via,status,body_state,derive_version,have,created_at,updated_at,title,title_source)
       VALUES (2,'msg_synthetic_route','alpha','synthetic-session',?,'session','synthetic-session','known',
         ?,'2026-10-31','hook',NULL,'pending',0,1,?,?,'hook title','model_time')`,
      [convKey, now, now, now]);
    db.run(
      `INSERT INTO request_evidence(req_id,source_kind,ref_key,merge_state,match_rule,added_at)
       VALUES (2,'hook','hook-legacy','pending',?,?)`,
      [MATCH_BY_RESPONSE_ID, now]);
    db.run(
      `INSERT INTO pending_hook(hook_id,response_id,response_id_norm,first_seen)
       VALUES ('hook-legacy','chatcmpl-msg_synthetic_route','msg_synthetic_route',?)`,
      [now]);
    db.run(
      `INSERT INTO raw_ledger(source_kind,file_generation,byte_offset,t_text,t_ms,source,response_id,response_id_norm,payload_json)
       VALUES ('file','synthetic-generation',1,'2026-10-31T00:00:00Z',?,'synthetic-source',
         'msg_synthetic_route','msg_synthetic_route','{}')`,
      [now]);
  });
  persistBody(f.store, 2, {
    protocol: 'anthropic',
    request: { messages: [{ role: 'user', content: 'synthetic' }] },
    reply: { content: [] },
    redact_version: 1,
  });
}

test('规范化存量剥净旧前缀并让等待队列合并', async () => {
  const f = fixture();
  try {
    seedLegacySplit(f);
    const previewLines: string[] = [];
    expect(await runMaintenance(['normalize-response-ids', '--db', join(f.dir, 'trace.db')], {
      out: line => previewLines.push(line), err: () => {},
    })).toBe(0);
    expect(JSON.parse(previewLines[0]!)).toEqual({
      ok: true, applied: false,
      requests: 1, pending_hooks: 1, raw_ledger: 1,
      merges: 1, ambiguous: 0, without_id: 0,
    });

    const applyLines: string[] = [];
    expect(await runMaintenance([
      'normalize-response-ids', '--db', join(f.dir, 'trace.db'),
      '--apply', '--approval-id', 'synthetic-approval',
    ], { out: line => applyLines.push(line), err: () => {} })).toBe(0);
    expect(JSON.parse(applyLines[0]!)).toMatchObject({
      ok: true, applied: true, merged: 1, remaining: 0,
    });

    expect(f.store.read.query(
      'SELECT req_id,body_state,have FROM request ORDER BY req_id').all())
      .toEqual([{ req_id: 1, body_state: 'available', have: 7 }]);
    expect(f.store.read.query('SELECT count(*) AS n FROM pending_hook').get()).toEqual({ n: 0 });
    expect(f.store.read.query(
      "SELECT merge_state FROM request_evidence WHERE source_kind='hook' AND ref_key='hook-legacy'").get())
      .toEqual({ merge_state: 'merged' });
    expect(f.store.read.query(
      'SELECT response_id_norm FROM raw_ledger WHERE byte_offset=1').get())
      .toEqual({ response_id_norm: 'synthetic_route' });

    const secondLines: string[] = [];
    expect(await runMaintenance(['normalize-response-ids', '--db', join(f.dir, 'trace.db')], {
      out: line => secondLines.push(line), err: () => {},
    })).toBe(0);
    expect(JSON.parse(secondLines[0]!)).toMatchObject({
      requests: 0, pending_hooks: 0, raw_ledger: 0, merges: 0, ambiguous: 0, without_id: 0,
    });
  } finally {
    f.close();
  }
});
