import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBoundSaltTx, saltId } from '../src/config';
import { backupBundle, restoreBundle } from '../src/maintenance/backup';
import { CODE_SCHEMA_VERSION } from '../src/maintenance/verify';
import { openStore } from '../src/store';

/**
 * 历史 v6 建表链（commit f574f9c 的 schema.sql + schema-v6.sql），不是当前库改版本号。
 * 用它验证「旧包恢复后能被当前代码迁移并服务」，而不是只核对清单自述。
 */
const BASE_V6 = readFileSync(join(import.meta.dir, 'fixtures/schema-v6/base.sql'), 'utf8');
const V6 = readFileSync(join(import.meta.dir, 'fixtures/schema-v6/v6.sql'), 'utf8');

function buildV6Bundle(dropTable?: string): { root: string; bundle: string; salt: Uint8Array } {
  const root = mkdtempSync(join(tmpdir(), 'atc-restore-v6-'));
  chmodSync(root, 0o700);
  const source = join(root, 'source');
  mkdirSync(source, { mode: 0o700 });
  const salt = new Uint8Array(32).fill(7);
  writeFileSync(join(source, 'redaction.salt'), salt, { mode: 0o600 });
  const db = new Database(join(source, 'trace.db'), { create: true });
  try {
    db.exec('PRAGMA auto_vacuum=INCREMENTAL');
    db.exec(BASE_V6);
    db.exec(V6);
    if (dropTable !== undefined) db.exec(`DROP TABLE ${dropTable}`);
    db.run("INSERT INTO collector_state(key,value_json) VALUES('privacy:salt',?)",
      [JSON.stringify({ format: 1, id: saltId(salt) })]);
    db.run(`INSERT INTO request(req_id,response_id_norm,agent,actor,actor_state,started_ms,day,
      via,body_state,derive_version,have,created_at,updated_at)
      VALUES (42,'synthetic_response','alpha','actor','known',1700000000000,'2026-10-31',
      'through','pending',0,1,1,1)`);
    db.run('PRAGMA user_version=6');
    db.run('PRAGMA journal_mode=WAL');
  } finally {
    db.close();
  }
  chmodSync(join(source, 'trace.db'), 0o600);
  const bundle = join(root, 'bundle');
  backupBundle(source, bundle);
  return { root, bundle, salt };
}

test('历史v6包恢复后在staging完成迁移、关键表可读且盐与权限保持', () => {
  const { root, bundle, salt } = buildV6Bundle();
  const restored = join(root, 'restored');
  try {
    const bundled = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
    expect(bundled.schema).toBe(6);
    restoreBundle(bundle, restored);

    const manifest = JSON.parse(readFileSync(join(restored, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      format: 1, schema: CODE_SCHEMA_VERSION, salt_id: saltId(salt),
      database_sha256: createHash('sha256')
        .update(readFileSync(join(restored, 'trace.db'))).digest('hex'),
    });
    expect(readFileSync(join(restored, 'redaction.salt'))).toEqual(Buffer.from(salt));
    // 迁移在 staging 里把库切到 WAL，发布目录可能带空的 -wal/-shm；权限同样是 0600。
    for (const name of ['manifest.json', 'redaction.salt', 'trace.db']) {
      expect(existsSync(join(restored, name))).toBe(true);
    }
    expect(statSync(restored).mode & 0o777).toBe(0o700);
    for (const name of readdirSync(restored)) {
      expect(statSync(join(restored, name)).mode & 0o777).toBe(0o600);
    }

    const db = new Database(join(restored, 'trace.db'), { readonly: true });
    try {
      expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: CODE_SCHEMA_VERSION });
      expect(db.query('SELECT req_id,response_id_norm AS norm FROM request').all())
        .toEqual([{ req_id: 42, norm: 'synthetic_response' }]);
      for (const table of ['request_evidence', 'pending_hook', 'derive_queue']) {
        expect(() => db.query(`SELECT COUNT(*) FROM ${table}`).get()).not.toThrow();
      }
    } finally {
      db.close();
    }

    // 迁移后的库仍按原盐解释占位符；打开它不会要求重新生成。
    const store = openStore(join(restored, 'trace.db'));
    try {
      expect(store.write(db => loadBoundSaltTx(db, restored))).toEqual(salt);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('旧结构无法被当前迁移打开时明确拒绝，不发布目标也不留staging', () => {
  // v8 要在 tool_call 上建索引；缺表会让迁移事务失败。
  const { root, bundle } = buildV6Bundle('tool_call');
  const restored = join(root, 'restored');
  try {
    expect(() => restoreBundle(bundle, restored)).toThrow('restore_migration_failed');
    expect(existsSync(restored)).toBe(false);
    expect(readdirSync(root).filter(name => name.startsWith('.atc-restore-'))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
