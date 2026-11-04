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
 * 健康统计的进程内缓存，按写世代失效，TTL 兜住进程外写入。
 *
 * 汇总里有 request 全表 COUNT 与 GROUP BY，在 4 GB 库上冷页一次 200–570 ms，
 * 探针与页面并发时每笔都付一遍。所有进程内写都经 `store.write` 计数，世代不变
 * 就没有任何进程内聚合会变，直接复用上一次结果（F06）；外部进程（回填脚本、
 * 手工 SQL）的写不改计数，TTL 保证它们最迟 5 秒反映到统计里，同时把监控轮询
 * 放大的全量重算压到最多每 5 秒一次。
 */
const STATS_TTL_MS = 5_000;
const statsCache = new WeakMap<Store, { generation: number; at_ms: number; value: Stats }>();

export function getStats(store: Store): Stats {
  const cached = statsCache.get(store);
  if (cached !== undefined && cached.generation === store.writeStats.count
    && Date.now() - cached.at_ms < STATS_TTL_MS) {
    return cached.value;
  }
  const value = computeStats(store);
  statsCache.set(store, { generation: store.writeStats.count, at_ms: Date.now(), value });
  return value;
}

function computeStats(store: Store): Stats {
  // 十条查询吃同一个读快照：外部写落在查询之间时，不包事务会把新旧值混在一
  // 份结果里，还按旧世代缓存住。
  return store.read.transaction(() => {
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
  })();
}
