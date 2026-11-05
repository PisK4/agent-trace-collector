import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { runMaintenance } from '../src/maintenance/cli';
import { lockPath } from '../src/maintenance/lock';
import { existsSync } from 'node:fs';
import { persistBody } from '../src/body';
import { fixture } from './fixtures';

for (const command of ['body-consistency', 'body-bytes-backfill']) {
  test(`${command} 默认只读预览，应用要求审批、计数与停服，重复应用幂等`, async () => {
    const f = fixture();
    const path = join(f.dir, 'trace.db');
    const call = async (args: string[] = []) => {
      const output: string[] = [], errors: string[] = [];
      const code = await runMaintenance([command, '--db', path, ...args], {
        out: line => output.push(line), err: line => errors.push(line),
      });
      return { code, output, errors };
    };
    try {
      f.store.write(db => db.run(`INSERT INTO request(req_id,started_ms,day,via,have,body_state,
        miss_reason,derive_version,created_at,updated_at)
        VALUES(1,1,'2026-10-31','through',1,'pending','disk_body_paused',0,1,1)`));
      if (command === 'body-bytes-backfill') {
        persistBody(f.store, 1, { protocol: 'anthropic', request: { messages: [] },
          reply: { content: [] }, redact_version: 1 });
        f.store.write(db => db.run('UPDATE request SET body_bytes=NULL WHERE req_id=1'));
      }
      const before = f.store.writeStats.count;
      const preview = await call();
      expect(preview.code).toBe(0);
      expect(JSON.parse(preview.output[0]!)).toMatchObject({ ok: true, applied: false, candidates: 1 });
      expect(f.store.writeStats.count).toBe(before);
      expect((await call(['--apply'])).code).toBe(1);
      expect((await call(['--apply', '--approval-id', 'synthetic', '--expected-candidates', '-1'])).code).toBe(1);
      const online = await call(['--apply', '--approval-id', 'synthetic', '--expected-candidates', '1']);
      expect(online.code).toBe(1);
      expect(online.errors.join()).toContain('source_must_be_stopped');
      expect(existsSync(lockPath(f.dir))).toBe(false);
      f.store.close();
      const applied = await call(['--apply', '--approval-id', 'synthetic', '--expected-candidates', '1']);
      expect(applied.code).toBe(0);
      expect(JSON.parse(applied.output[0]!)).toMatchObject({ ok: true, applied: true, changed: 1, remaining: 0 });
      const repeated = await call(['--apply', '--approval-id', 'synthetic', '--expected-candidates', '0']);
      expect(repeated.code).toBe(0);
      expect(JSON.parse(repeated.output[0]!)).toMatchObject({ changed: 0, remaining: 0 });
      const db = new Database(path, { readonly: true });
      try {
        const row = db.query<{ body_state: string; body_bytes: number | null }, []>(
          'SELECT body_state,body_bytes FROM request WHERE req_id=1').get()!;
        if (command === 'body-consistency') expect(row.body_state).toBe('partial');
        else expect(row.body_bytes).toBeGreaterThan(0);
      } finally { db.close(); }
    } finally { f.close(); }
  });
}
