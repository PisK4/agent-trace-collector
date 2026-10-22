import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixtures';
import { openStore } from '../src/store';
import { initializeV5, readMigrationState } from '../src/migrate-v5';

function legacyFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'atc-v5-test-'));
  const path = join(dir, 'trace.db');
  const db = new Database(path);
  db.exec('PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL;');
  db.exec(readFileSync(new URL('./fixtures/schema-v4.sql', import.meta.url), 'utf8'));
  db.exec('PRAGMA user_version=4');
  let closed = false;
  const closeDb = () => { if (!closed) { db.close(); closed = true; } };
  return {
    dir, path, db, closeDb,
    close() { closeDb(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('v5结构和未完成标记原子提交并拒绝普通打开', () => {
  const f = legacyFixture();
  try {
    initializeV5(f.db);
    expect(f.db.query('PRAGMA user_version').get()).toEqual({ user_version: 5 });
    expect(() => openStore(f.path)).toThrow('migration_incomplete');
  } finally { f.close(); }
});

test('v5初始化marker失败回滚全部DDL', () => {
  const f = legacyFixture();
  try {
    f.db.exec(`CREATE TRIGGER fail_v5_marker BEFORE INSERT ON collector_state
      WHEN NEW.key='migration:v5' BEGIN SELECT RAISE(ABORT,'injected_marker'); END`);
    expect(() => initializeV5(f.db)).toThrow('injected_marker');
    expect(f.db.query('PRAGMA user_version').get()).toEqual({ user_version: 4 });
    expect((f.db.query('PRAGMA table_info(request)').all() as { name: string }[])
      .some(row => row.name === 'input_epoch')).toBe(false);
    f.db.exec('DROP TRIGGER fail_v5_marker');
    initializeV5(f.db);
    expect(f.db.query('PRAGMA user_version').get()).toEqual({ user_version: 5 });
  } finally { f.close(); }
});

test('新空库v5标记完整', () => {
  const f = fixture();
  try {
    expect(f.store.read.query('PRAGMA user_version').get()).toEqual({ user_version: 5 });
    const state = readMigrationState(f.store.read);
    expect(state).toMatchObject({ target: 5, phase: 'complete', complete: true });
  } finally {
    f.close();
  }
});
