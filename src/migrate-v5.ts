import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { conservationDigest } from './conservation';

export const V5_VERSION = 5;

/**
 * v4 → v5 的精确增量。
 *
 * 新库在 schema.sql 里直接带这些列；普通 openStore 从不跑 ALTER，
 * 只有显式迁移脚本会执行这段。
 */
export const V5_DELTA = `
ALTER TABLE request ADD COLUMN model_provider TEXT;
ALTER TABLE request ADD COLUMN source_facts_json TEXT;
ALTER TABLE request ADD COLUMN projection_meta_json TEXT;
ALTER TABLE request ADD COLUMN input_epoch TEXT NOT NULL DEFAULT '';
ALTER TABLE request ADD COLUMN input_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request ADD COLUMN purpose_revision INTEGER NOT NULL DEFAULT -1;
ALTER TABLE request ADD COLUMN purpose_target INTEGER NOT NULL DEFAULT 1;
ALTER TABLE request ADD COLUMN purpose_version INTEGER;
ALTER TABLE request ADD COLUMN purpose_pending INTEGER NOT NULL DEFAULT 1;
ALTER TABLE request ADD COLUMN purpose_status TEXT NOT NULL DEFAULT 'missing';
ALTER TABLE request ADD COLUMN purpose_rule TEXT;
ALTER TABLE request ADD COLUMN purpose_signals TEXT NOT NULL DEFAULT '[]';
ALTER TABLE request ADD COLUMN purpose_chain TEXT NOT NULL DEFAULT 'participate'
  CHECK(purpose_chain IN ('participate','exclude'));
ALTER TABLE request ADD COLUMN purpose_retry INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request ADD COLUMN summary_algorithm INTEGER;
ALTER TABLE request ADD COLUMN summary_basis TEXT;
ALTER TABLE request ADD COLUMN summary_state TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE tool_call ADD COLUMN algorithm_version INTEGER;
ALTER TABLE tool_call ADD COLUMN basis_json TEXT;
ALTER TABLE tool_call ADD COLUMN retention_state TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE raw_ledger ADD COLUMN err TEXT;
ALTER TABLE raw_ledger ADD COLUMN mapping_version INTEGER;
ALTER TABLE raw_ledger ADD COLUMN privacy_version INTEGER;
ALTER TABLE raw_route ADD COLUMN mapping_version INTEGER;
ALTER TABLE raw_route ADD COLUMN privacy_version INTEGER;
ALTER TABLE derive_queue ADD COLUMN group_epoch TEXT NOT NULL DEFAULT '';
ALTER TABLE derive_queue ADD COLUMN input_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE derive_queue ADD COLUMN published_revision INTEGER NOT NULL DEFAULT -1;
ALTER TABLE derive_queue ADD COLUMN target_algorithm INTEGER NOT NULL DEFAULT 1;
ALTER TABLE derive_queue ADD COLUMN published_algorithm INTEGER;
ALTER TABLE derive_queue ADD COLUMN state TEXT NOT NULL DEFAULT 'dirty';
ALTER TABLE derive_queue ADD COLUMN dirty_since_ms INTEGER;
CREATE INDEX i_req_purpose_pending ON request(purpose_pending,req_id)
  WHERE purpose_pending=1;
CREATE INDEX i_derive_dirty ON derive_queue(state,conv_key,actor) WHERE state='dirty';
`;

export type MigrationPhase = 'remap' | 'project' | 'purpose' | 'groups' | 'verify' | 'complete';

export type MigrationState = {
  format: 1;
  target: 5;
  phase: MigrationPhase;
  cursor: string | null;
  scope: 'all';
  complete: boolean;
  baseline: string;
  report: { scanned: number; remapped: number; projected: number };
};

const PHASES: readonly MigrationPhase[] = ['remap', 'project', 'purpose', 'groups', 'verify', 'complete'];

export function readMigrationState(db: Database): MigrationState {
  const row = db.query<{ value_json: string }, []>(
    "SELECT value_json FROM collector_state WHERE key='migration:v5'").get();
  if (row === null) throw new Error('migration_marker_missing');
  let value: unknown;
  try {
    value = JSON.parse(row.value_json);
  } catch {
    throw new Error('migration_marker_invalid');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('migration_marker_invalid');
  }
  const state = value as MigrationState;
  const report = state.report as unknown;
  if (state.format !== 1 || state.target !== 5 || state.scope !== 'all' ||
    !PHASES.includes(state.phase) ||
    !(state.cursor === null || typeof state.cursor === 'string') ||
    state.complete !== (state.phase === 'complete') ||
    typeof state.baseline !== 'string' || !/^[a-f0-9]{64}$/.test(state.baseline) ||
    report === null || typeof report !== 'object' || Array.isArray(report) ||
    ![state.report.scanned, state.report.remapped, state.report.projected]
      .every(count => Number.isSafeInteger(count) && count >= 0)) {
    throw new Error('migration_marker_invalid');
  }
  return state;
}

/**
 * 落 v5 结构并写未完成标记，整段在一个事务里。
 *
 * 只接受 v4 或无标记的 v5；未知结构直接拒绝。标记与 `PRAGMA user_version`
 * 和 DDL 同事务提交，中途失败不留半套列。
 */
export function initializeV5(db: Database): void {
  const version = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version === 5) {
    readMigrationState(db);
    return;
  }
  if (version !== 4) throw new Error('migration_source_unsupported');
  db.transaction(() => {
    const baseline = conservationDigest(db);
    db.exec(V5_DELTA);
    // 只初始化旧队列的组身份；不扫描正文，也不在这里完成派生。
    for (const row of db.query<{ conv_key: string; actor: string }, []>(
      'SELECT conv_key,actor FROM derive_queue').iterate()) {
      db.run(
        'UPDATE derive_queue SET group_epoch=?,dirty_since_ms=? WHERE conv_key=? AND actor=?',
        [randomUUID(), Date.now(), row.conv_key, row.actor],
      );
    }
    db.run(
      "INSERT INTO collector_state(key,value_json) VALUES ('migration:v5',?)",
      [JSON.stringify({
        format: 1, target: 5, phase: 'remap', cursor: null, scope: 'all', complete: false,
        baseline, report: { scanned: 0, remapped: 0, projected: 0 },
      })],
    );
    db.exec('PRAGMA user_version=5');
  }).immediate();
}

export function completeMigrationMarker(db: Database): void {
  const state = readMigrationState(db);
  db.run(
    "UPDATE collector_state SET value_json=? WHERE key='migration:v5'",
    [JSON.stringify({ ...state, phase: 'complete', complete: true })],
  );
}
