import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
import { emptyBodyReadStats } from '../src/body-cache';
import type { DrainResult } from '../src/derive/sync';
import type { Store } from '../src/store';
import { drainToEmpty, migrateOmpSemantics } from '../scripts/backfill-omp-semantics';

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

/** 合成派生轮次：drainToEmpty 的守卫只读这四个字段。 */
function backfillRound(overrides: {
  processed?: number; remaining?: number; groups?: { conv_key: string; actor: string }[];
  purpose_processed?: number;
}): DrainResult {
  return {
    processed: 0, remaining: 0, groups: [], recomputed: 0, retained: 0,
    purpose_processed: 0, purpose_remaining: 0, discarded: 0,
    body_read: emptyBodyReadStats(), batch_ms: 0, ...overrides,
  };
}

test('drainToEmpty 有剩余组但一轮零进展时抛 derive_no_progress，不再空转', async () => {
  let rounds = 0;
  // 派生引擎在组消失、compute 返回 null 或用途滞留时会给出这种「有剩余、无完成」的轮次。
  await expect(drainToEmpty({} as Store, 50, async () => {
    rounds += 1;
    return backfillRound({ remaining: 3 });
  })).rejects.toThrow('derive_no_progress');
  expect(rounds).toBe(1);
});

test('drainToEmpty 有进展的轮次继续排空，用途判定也算进展', async () => {
  const rounds = [
    backfillRound({ processed: 2, remaining: 1, groups: [{ conv_key: 'a', actor: 'b' }] }),
    backfillRound({ purpose_processed: 1, remaining: 1, groups: [] }),
    backfillRound({ processed: 1, remaining: 0, groups: [{ conv_key: 'a', actor: 'b' }] }),
  ];
  const processed = await drainToEmpty({} as Store, 50, async () => rounds.shift()!);
  expect(processed).toBe(3);
});
