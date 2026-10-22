import { expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './fixtures';
import { loadBoundSalt } from '../src/config';

test('已有请求缺盐拒绝且不新建文件', () => {
  const f = fixture();
  try {
    f.store.write(db => db.run(`INSERT INTO request(req_id,started_ms,day,via,
      body_state,derive_version,have,created_at,updated_at)
      VALUES (1,1,'2026-10-22','hook','pending',0,1,1,1)`));
    // 库里有数据却没有盐：不能悄悄生成一个新盐，那会让已写入的占位符无法再解释。
    expect(() => loadBoundSalt(f.store, f.dir)).toThrow('redaction_salt_missing');
    expect(existsSync(join(f.dir, 'redaction.salt'))).toBe(false);
  } finally { f.close(); }
});

test('首次空库生成绑定后拒绝错盐', () => {
  const f = fixture();
  try {
    const first = loadBoundSalt(f.store, f.dir);
    expect(first.length).toBe(32);
    // 同一份盐重复读：绑定已存在且与文件一致，不重新生成。
    expect(loadBoundSalt(f.store, f.dir)).toEqual(first);
    // 文件被换成另一份盐：绑定与文件不再对应，必须拒绝而不是静默采用新盐。
    writeFileSync(join(f.dir, 'redaction.salt'), new Uint8Array(32).fill(7), { mode: 0o600 });
    expect(() => loadBoundSalt(f.store, f.dir)).toThrow('redaction_salt_mismatch');
  } finally { f.close(); }
});

test('旧库有盐无绑定默认拒绝，显式确认才绑定', () => {
  const f = fixture();
  try {
    f.store.write(db => db.run(`INSERT INTO request(req_id,started_ms,day,via,
      body_state,derive_version,have,created_at,updated_at)
      VALUES (1,1,'2026-10-22','hook','pending',0,1,1,1)`));
    const salt = new Uint8Array(32).fill(5);
    writeFileSync(join(f.dir, 'redaction.salt'), salt, { mode: 0o600 });
    // 有盐文件、有数据、没有绑定：默认拒绝，因为无法证明这份盐就是当时用的那份。
    expect(() => loadBoundSalt(f.store, f.dir)).toThrow('redaction_salt_unbound');
    expect(loadBoundSalt(f.store, f.dir, { confirmLegacy: true })).toEqual(salt);
    // 显式确认记进绑定，之后按普通路径校验；它是对"历史身份无法证明"的接受，不是证明。
    expect(f.store.read.query<{ value_json: string }, []>(
      "SELECT value_json FROM collector_state WHERE key='privacy:salt'").get())
      .toMatchObject({ value_json: expect.stringContaining('"confirmedLegacy":true') });
    expect(loadBoundSalt(f.store, f.dir)).toEqual(salt);
  } finally { f.close(); }
});

test('绑定JSON损坏拒绝而不是按缺失重建', () => {
  const f = fixture();
  try {
    loadBoundSalt(f.store, f.dir);
    f.store.write(db => db.run(
      "UPDATE collector_state SET value_json='not json' WHERE key='privacy:salt'"));
    expect(() => loadBoundSalt(f.store, f.dir)).toThrow('redaction_salt_binding_invalid');
  } finally { f.close(); }
});
