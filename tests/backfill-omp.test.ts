import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
import { migrateOmpSemantics } from '../scripts/backfill-omp-semantics';

test('migrateOmpSemantics 给缺列缺表的库补齐并重建视图，重复执行幂等', () => {
  const f = fixture();
  try {
    const db = f.store.db;
    // 模拟升级前的旧库：视图先删（列还被它们引用），再摘掉新列与新表。
    db.exec('DROP VIEW IF EXISTS effective_request');
    db.exec('DROP VIEW IF EXISTS published_derive_request');
    db.exec('ALTER TABLE request DROP COLUMN context_event');
    db.exec('ALTER TABLE derive_request_result DROP COLUMN context_event');
    db.exec('DROP TABLE IF EXISTS bg_job');

    migrateOmpSemantics(db);
    const columns = (table: string): string[] =>
      (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name);
    expect(columns('request')).toContain('context_event');
    expect(columns('derive_request_result')).toContain('context_event');
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='bg_job'").get())
      .not.toBeNull();
    // 视图按 schema-v6.sql 的 DDL 重建后可查，且带 context_event 列。
    const viewColumns = (view: string): string[] =>
      (db.query(`SELECT * FROM ${view} LIMIT 0`).all() as Record<string, unknown>[]).length === 0
        ? (db.query(`PRAGMA table_info(${view})`).all() as { name: string }[]).map(row => row.name)
        : [];
    expect(viewColumns('effective_request')).toContain('context_event');
    expect(viewColumns('published_derive_request')).toContain('context_event');

    migrateOmpSemantics(db);
    expect(columns('request').filter(name => name === 'context_event').length).toBe(1);
  } finally { f.close(); }
});
