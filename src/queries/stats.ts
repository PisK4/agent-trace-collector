/** 健康统计：采集游标、缺口、待处理 hook 与正文集计的只读汇总。 */

import type { Store } from '../store';
import { parseJsonOrNull } from './projection';

export type Stats = {
  cursors: {
    source_kind: string; source_name: string; file_generation: string;
    committed_off: number; observed_off: number; last_ok_ms: number;
  }[];
  issues: { source_kind: string; reason: string; count: number }[];
  gaps: { source_kind: string; source_name: string; state: string; from_off: number; to_off: number }[];
  pending_hooks: number;
  requests: number;
  body_states: { state: string; count: number }[];
  open_gaps: number;
  /** 费用扫描因系统时钟回退停住时的计数与阻塞时点；正常时为 null。 */
  cost_health: unknown;
  probe: unknown;
};

export function getStats(store: Store): Stats {
  const cursors = store.read.query(`
    SELECT source_kind, source_name, file_generation, committed_off, observed_off, last_ok_ms
    FROM source_cursor ORDER BY source_kind, source_name`).all() as Stats['cursors'];
  const issues = store.read.query(`
    SELECT source_kind, reason, COUNT(*) AS count FROM ingest_issue
    GROUP BY source_kind, reason ORDER BY source_kind, reason`).all() as Stats['issues'];
  const gaps = store.read.query(`
    SELECT source_kind, source_name, state, from_off, to_off FROM source_gap
    ORDER BY source_kind, source_name, from_off`).all() as Stats['gaps'];
  const pending = store.read.query('SELECT COUNT(*) AS n FROM pending_hook').get() as { n: number };
  const requests = store.read.query('SELECT COUNT(*) AS n FROM request').get() as { n: number };
  const bodyStates = store.read.query(`
    SELECT body_state AS state, COUNT(*) AS count FROM request GROUP BY body_state ORDER BY body_state`)
    .all() as Stats['body_states'];
  const openGaps = store.read.query(
    "SELECT COUNT(*) AS n FROM source_gap WHERE state IN ('open','resumable')").get() as { n: number };
  const probe = store.read.query<{ value_json: string }, [string]>(
    'SELECT value_json FROM collector_state WHERE key=?',
  ).get(JSON.stringify(['magpie', 'probe']));
  const costHealth = store.read.query<{ value_json: string }, [string]>(
    'SELECT value_json FROM collector_state WHERE key=?',
  ).get(JSON.stringify(['cost', 'clock_conflict']));
  return {
    cursors,
    issues,
    gaps,
    pending_hooks: pending.n,
    requests: requests.n,
    body_states: bodyStates,
    open_gaps: openGaps.n,
    cost_health: costHealth == null ? null : parseJsonOrNull(costHealth.value_json),
    probe: probe == null ? null : parseJsonOrNull(probe.value_json),
  };
}
