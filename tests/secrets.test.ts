import { expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './fixtures';
import { loadBoundSaltTx } from '../src/config';

test('已有请求缺盐拒绝且不新建文件', () => {
  const f = fixture();
  try {
    f.store.write(db => db.run(`INSERT INTO request(req_id,started_ms,day,via,
      body_state,derive_version,have,created_at,updated_at)
      VALUES (1,1,'2026-10-22','hook','pending',0,1,1,1)`));
    // 库里有数据却没有盐：不能悄悄生成一个新盐，那会让已写入的占位符无法再解释。
    expect(() => f.store.write(db => loadBoundSaltTx(db, f.dir))).toThrow('redaction_salt_missing');
    expect(existsSync(join(f.dir, 'redaction.salt'))).toBe(false);
  } finally { f.close(); }
});

test('首次空库生成绑定后拒绝错盐', () => {
  const f = fixture();
  try {
    const first = f.store.write(db => loadBoundSaltTx(db, f.dir));
    expect(first.length).toBe(32);
    // 同一份盐重复读：绑定已存在且与文件一致，不重新生成。
    expect(f.store.write(db => loadBoundSaltTx(db, f.dir))).toEqual(first);
    // 文件被换成另一份盐：绑定与文件不再对应，必须拒绝而不是静默采用新盐。
    writeFileSync(join(f.dir, 'redaction.salt'), new Uint8Array(32).fill(7), { mode: 0o600 });
    expect(() => f.store.write(db => loadBoundSaltTx(db, f.dir))).toThrow('redaction_salt_mismatch');
  } finally { f.close(); }
});

test('有盐无绑定拒绝，不提供确认绕过', () => {
  const f = fixture();
  try {
    f.store.write(db => db.run(`INSERT INTO request(req_id,started_ms,day,via,
      body_state,derive_version,have,created_at,updated_at)
      VALUES (1,1,'2026-10-22','hook','pending',0,1,1,1)`));
    writeFileSync(join(f.dir, 'redaction.salt'), new Uint8Array(32).fill(5), { mode: 0o600 });
    // 有盐文件、有数据、没有绑定：无法证明这份盐就是当时用的那份。
    expect(() => f.store.write(db => loadBoundSaltTx(db, f.dir))).toThrow('redaction_salt_unbound');
    // 失败不写绑定：没有"确认旧盐"的入口，旧库删除后重建。
    expect(f.store.read.query<{ value_json: string }, []>(
      "SELECT value_json FROM collector_state WHERE key='privacy:salt'").get()).toBeNull();
  } finally { f.close(); }
});

test('绑定JSON损坏拒绝而不是按缺失重建', () => {
  const f = fixture();
  try {
    f.store.write(db => loadBoundSaltTx(db, f.dir));
    f.store.write(db => db.run(
      "UPDATE collector_state SET value_json='not json' WHERE key='privacy:salt'"));
    expect(() => f.store.write(db => loadBoundSaltTx(db, f.dir))).toThrow('redaction_salt_binding_invalid');
  } finally { f.close(); }
});
