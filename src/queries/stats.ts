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
  /** 存储准入最近一次切换；从未切换过时为 null，等同 normal。 */
  admission: { mode: string; reason: string | null; at_ms: number | null } | null;
  /** 费用扫描因系统时钟回退停住时的计数与阻塞时点；正常时为 null。 */
  cost_health: unknown;
  probe: unknown;
};

function admissionOf(value: unknown): Stats['admission'] {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.mode !== 'string') return null;
  return {
    mode: record.mode,
    reason: typeof record.reason === 'string' ? record.reason : null,
    at_ms: typeof record.at_ms === 'number' ? record.at_ms : null,
  };
}

/**
 * 健康统计的进程内缓存，按写世代失效。
 *
 * 汇总里有 request 全表 COUNT 与 GROUP BY，在 4 GB 库上冷页一次 200–570 ms，
 * 探针与页面并发时每笔都付一遍。所有写都经 `store.write` 计数（维护命令要求
 * 停服），世代不变就没有任何聚合会变，直接复用上一次结果（F06）。
 */
const statsCache = new WeakMap<Store, { generation: number; value: Stats }>();

export function getStats(store: Store): Stats {
  const cached = statsCache.get(store);
  if (cached !== undefined && cached.generation === store.writeStats.count) return cached.value;
  const value = computeStats(store);
  statsCache.set(store, { generation: store.writeStats.count, value });
  return value;
}

function computeStats(store: Store): Stats {
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
  const admission = store.read.query<{ value_json: string }, [string]>(
    'SELECT value_json FROM collector_state WHERE key=?',
  ).get(JSON.stringify(['retention', 'admission']));
  return {
    cursors,
    issues,
    gaps,
    pending_hooks: pending.n,
    requests: requests.n,
    body_states: bodyStates,
    open_gaps: openGaps.n,
    admission: admission == null ? null : admissionOf(parseJsonOrNull(admission.value_json)),
    cost_health: costHealth == null ? null : parseJsonOrNull(costHealth.value_json),
    probe: probe == null ? null : parseJsonOrNull(probe.value_json),
  };
}
