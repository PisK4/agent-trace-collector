/** 会话信息汇总：查询时聚合，不物化。口径见会话信息汇总 note。 */

import { DERIVE_ALGORITHM } from '../derive/slice';
import { GROUP_ALGORITHM, deriveJoinSql, derivedColSql } from '../derive/state';
import type { Store } from '../store';

/** 汇总条目共用的失败定位：回到支撑记录的最小身份。 */
export type SummaryCallRef = { req_id: number; ord: number; tool_name: string | null };

export type SessionSummary = {
  /** 会话里任一 actor 组还没算完；数字是已发布代或同步旧列的事实。 */
  dirty: boolean;
  /** 按次数降序、同名按字典序；`未判定 = count − error_known` 由展示层收。 */
  tools: { name: string; count: number; paired: number; error_known: number; errors: number }[];
  paths: {
    /** 写入尝试（Edit/Write 的 file_path），按原始路径分组。 */
    written: { path: string; count: number }[];
    /** 读取请求（Read 的 file_path），按原始路径分组。 */
    read: { path: string; count: number }[];
  };
  skills: { name: string; count: number }[];
  interrupts: {
    /** 已识别用户中断事件数：按 delta 归属，同一标记跨请求只计一次。 */
    count: number;
    /** 出现中断的请求，可定位。 */
    requests: number[];
    /** 归属已知但从未判定的请求（正文不可读或派生先于本列）；未知归属另见会话标记。 */
    unknown: number;
  };
  totals: {
    in_tok: number | null;
    out_tok: number | null;
    cost: number | null;
    /** 无费用读数（cost_state='absent'）的请求数；unpriced 不在此列。 */
    cost_absent: number;
    /** Σcache_read ÷ Σ(in_tok + cache_read)，只计两个读数都在的请求；无分母为 null。 */
    cache_hit: number | null;
  };
  structure: {
    requests_total: number;
    /** 参与主链（purpose_chain='participate'）；旁路是分类器与标题生成等排除请求。 */
    main: number;
    bypass: number;
    subagent_actors: number;
    subagent_requests: number;
    /** 网关重试（attempt_count > 1）笔数。 */
    retries: number;
    /** max(prompt_tokens / prompt_window) 的整百分点；无可用分母为 null。 */
    context_peak_pct: number | null;
    /** distinct model_requested，按次数降序；多于一个才在界面显示。 */
    models: { name: string; count: number }[];
  };
  coverage: {
    calls_total: number;
    calls_paired: number;
    /** 已配对且失败位可读的调用数；pending/ambiguous/未配对都算未知。 */
    calls_error_known: number;
    /** 参数事实在本算法下真实提取过的调用数；保留行按旧算法号排除。 */
    calls_fact_known: number;
  };
  /** 已判定失败的调用集合，可直接定位到配对页。 */
  failures: SummaryCallRef[];
  failures_truncated: boolean;
};

/** 汇总条目的点击查询：按组取支撑记录，不随首屏返回全部调用。 */
export type SummaryEntriesQuery =
  | { kind: 'tool'; name: string }
  | { kind: 'written'; path: string }
  | { kind: 'read'; path: string }
  | { kind: 'skill'; name: string }
  | { kind: 'interrupts' };

export type SummaryEntry = SummaryCallRef & { state: string };

/** 点击查询的响应：调用类条目带定位；中断类条目是请求与其事件数。 */
export type SummaryEntries =
  | { items: SummaryEntry[]; truncated: boolean }
  | { requests: { req_id: number; count: number }[] };

/**
 * 会话口径的有效工具行：发布代有该请求的工具行用发布代，否则回退同步旧表。
 * 与 `getRequest` 的整组取数同一条规则；同步回退是调用身份的家。
 * `source` 标记来源（1=发布代），覆盖度据此判定参数事实是否在当前算法下算过。
 */
const EFFECTIVE_TOOL_SQL = (extra: string, tail: string): string => `
  SELECT tc.call_id AS call_id, tc.req_id AS req_id, tc.ord AS ord,
         tc.tool_name AS tool_name, tc.arg_path AS arg_path, tc.arg_skill AS arg_skill,
         tc.is_error AS is_error, tc.state AS state,
         tc.algorithm_version AS algo, 0 AS source
  FROM tool_call tc
  JOIN request r ON r.req_id = tc.req_id
  WHERE r.conv_key = ? AND r.actor_state = 'known'
    AND NOT EXISTS (
      SELECT 1 FROM derive_queue q
      JOIN derive_tool_result t ON t.generation = q.published_generation AND t.req_id = tc.req_id
      WHERE q.conv_key = r.conv_key AND q.actor = r.actor)
    ${extra}
  UNION ALL
  SELECT t.call_id, t.req_id, t.ord, t.tool_name, t.arg_path, t.arg_skill,
         t.is_error, t.state, t.algorithm_version, 1 AS source
  FROM derive_tool_result t
  JOIN derive_queue q ON q.published_generation = t.generation
  JOIN request r ON r.req_id = t.req_id
  WHERE q.conv_key = ? AND r.actor_state = 'known'
    ${extra}
  ${tail}`;

type EffectiveToolRow = {
  call_id: string; req_id: number; ord: number; tool_name: string | null;
  arg_path: string | null; arg_skill: string | null;
  is_error: number | null; state: string; algo: number | null; source: number;
};

function groupCounts<T extends string>(pairs: Iterable<[T, number]>): { name: T; count: number }[] {
  return [...pairs]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));
}

/** 行存在即计数；缺口如实进 coverage，不补不猜。 */
export function getSessionSummary(store: Store, key: string): SessionSummary {
  return store.read.transaction(() => {
    const dirty = store.read.query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM derive_queue WHERE conv_key=? AND state<>'clean'").get(key)!.n > 0;
    const rows = store.read.query<EffectiveToolRow, [string, string]>(
      EFFECTIVE_TOOL_SQL('', 'ORDER BY req_id, ord')).all(key, key);

    const toolCounts = new Map<string, { count: number; paired: number; error_known: number; errors: number }>();
    const written = new Map<string, number>();
    const read = new Map<string, number>();
    const skills = new Map<string, number>();
    const failures: SummaryCallRef[] = [];
    let factKnown = 0;
    for (const row of rows) {
      const name = row.tool_name ?? '';
      const tool = toolCounts.get(name) ?? { count: 0, paired: 0, error_known: 0, errors: 0 };
      tool.count += 1;
      if (row.state === 'resolved') {
        tool.paired += 1;
        if (row.is_error !== null) tool.error_known += 1;
        if (row.is_error === 1) {
          tool.errors += 1;
          if (failures.length < 200) failures.push({ req_id: row.req_id, ord: row.ord, tool_name: row.tool_name });
        }
      }
      toolCounts.set(name, tool);
      if (row.arg_path !== null) {
        if (name === 'Edit' || name === 'Write') written.set(row.arg_path, (written.get(row.arg_path) ?? 0) + 1);
        else if (name === 'Read') read.set(row.arg_path, (read.get(row.arg_path) ?? 0) + 1);
      }
      if (row.arg_skill !== null) skills.set(row.arg_skill, (skills.get(row.arg_skill) ?? 0) + 1);
      // 事实是否在本算法下真实提取过：发布代行看代际算法号（实验路径的旧代
      // 也没提取过参数），同步行看组算法号——保留行带着旧算法号，参数从未提取。
      if (row.source === 1
        ? row.algo === DERIVE_ALGORITHM
        : row.algo === GROUP_ALGORITHM) factKnown += 1;
    }

    const interruptsCol = derivedColSql('q', 'd', 'r', 'interrupt_count');
    const interruptRows = store.read.query<{ req_id: number; n: number | null }, [string]>(`
      SELECT r.req_id, ${interruptsCol} AS n
      FROM request r ${deriveJoinSql('q', 'd', 'r')}
      WHERE r.conv_key=? AND r.actor_state='known'
      ORDER BY r.started_ms ASC, r.req_id ASC`).all(key);
    let interruptCount = 0;
    const interruptRequests: number[] = [];
    let interruptUnknown = 0;
    for (const row of interruptRows) {
      if (row.n === null) interruptUnknown += 1;
      else if (row.n > 0) {
        interruptCount += row.n;
        interruptRequests.push(row.req_id);
      }
    }

    const totals = store.read.query<{
      in_tok: number | null; out_tok: number | null; cost: number | null; cost_absent: number;
    }, [string]>(`
      SELECT SUM(in_tok) AS in_tok, SUM(out_tok) AS out_tok,
             SUM(CASE WHEN cost IS NOT NULL THEN cost END) AS cost,
             SUM(CASE WHEN cost_state='absent' THEN 1 ELSE 0 END) AS cost_absent
      FROM request WHERE conv_key=?`).get(key)!;
    const cache = store.read.query<{ num: number | null; den: number | null }, [string]>(`
      SELECT SUM(cache_read) AS num, SUM(in_tok + cache_read) AS den FROM request
      WHERE conv_key=? AND in_tok IS NOT NULL AND cache_read IS NOT NULL`).get(key)!;

    const structure = store.read.query<{
      requests_total: number; main: number; bypass: number; retries: number; peak: number | null;
    }, [string]>(`
      SELECT COUNT(*) AS requests_total,
             SUM(CASE WHEN purpose_chain='participate' THEN 1 ELSE 0 END) AS main,
             SUM(CASE WHEN purpose_chain='exclude' THEN 1 ELSE 0 END) AS bypass,
             SUM(CASE WHEN attempt_count > 1 THEN 1 ELSE 0 END) AS retries,
             MAX(CASE WHEN prompt_tokens IS NOT NULL AND prompt_window IS NOT NULL AND prompt_window > 0
               THEN CAST(prompt_tokens AS REAL) / prompt_window END) AS peak
      FROM request WHERE conv_key=?`).get(key)!;
    const models = store.read.query<{ name: string; count: number }, [string]>(`
      SELECT model_requested AS name, COUNT(*) AS count FROM request
      WHERE conv_key=? AND model_requested IS NOT NULL
      GROUP BY model_requested ORDER BY count DESC, name ASC`).all(key);
    const mainActor = store.read.query<{ actor: string }, [string]>(`
      SELECT actor FROM request
      WHERE conv_key=? AND actor IS NOT NULL AND actor_state='known' AND purpose_chain='participate'
      GROUP BY actor ORDER BY COUNT(*) DESC, MIN(started_ms) ASC, actor ASC LIMIT 1`).get(key)?.actor ?? null;
    const subagents = mainActor === null
      ? { actors: 0, requests: 0 }
      : store.read.query<{ actors: number; requests: number }, [string, string]>(`
        SELECT COUNT(DISTINCT actor) AS actors, COUNT(*) AS requests FROM request
        WHERE conv_key=? AND actor IS NOT NULL AND actor_state='known' AND actor<>?`).get(key, mainActor)!;

    return {
      dirty,
      tools: [...toolCounts.entries()]
        .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
        .map(([name, stat]) => ({ name, ...stat })),
      paths: {
        written: groupCounts(written).map(({ name, count }) => ({ path: name, count })),
        read: groupCounts(read).map(({ name, count }) => ({ path: name, count })),
      },
      skills: groupCounts(skills),
      interrupts: { count: interruptCount, requests: interruptRequests, unknown: interruptUnknown },
      totals: {
        in_tok: totals.in_tok, out_tok: totals.out_tok, cost: totals.cost,
        cost_absent: totals.cost_absent,
        cache_hit: cache.den !== null && cache.den > 0 && cache.num !== null ? cache.num / cache.den : null,
      },
      structure: {
        requests_total: structure.requests_total,
        main: structure.main, bypass: structure.bypass,
        subagent_actors: subagents.actors, subagent_requests: subagents.requests,
        retries: structure.retries,
        context_peak_pct: structure.peak === null ? null : Math.round(structure.peak * 100),
        models,
      },
      coverage: {
        calls_total: rows.length,
        calls_paired: rows.filter(row => row.state === 'resolved').length,
        calls_error_known: rows.filter(row => row.state === 'resolved' && row.is_error !== null).length,
        calls_fact_known: factKnown,
      },
      failures,
      failures_truncated: failures.length >= 200,
    };
  })();
}

/** 点击条目按组查支撑记录；每类一条 SQL，沿用有效工具行的同一套选源。 */
export function getSummaryEntries(store: Store, key: string, query: SummaryEntriesQuery): SummaryEntries {
  const LIMIT = 1000;
  return store.read.transaction(() => {
    if (query.kind === 'interrupts') {
      const interruptsCol = derivedColSql('q', 'd', 'r', 'interrupt_count');
      const rows = store.read.query<{ req_id: number; n: number | null }, [string]>(`
        SELECT r.req_id, ${interruptsCol} AS n
        FROM request r ${deriveJoinSql('q', 'd', 'r')}
        WHERE r.conv_key=? AND r.actor_state='known'
        ORDER BY r.started_ms ASC, r.req_id ASC`).all(key);
      return {
        requests: rows
          .filter(row => row.n !== null && row.n > 0)
          .map(row => ({ req_id: row.req_id, count: row.n! })),
      };
    }
    const extra = query.kind === 'tool'
      ? 'AND COALESCE(tool_name, \'\') = ?'
      : query.kind === 'written'
        ? "AND tool_name IN ('Edit','Write') AND arg_path = ?"
        : query.kind === 'read'
          ? "AND tool_name = 'Read' AND arg_path = ?"
          : 'AND arg_skill = ?';
    const param = query.kind === 'tool' || query.kind === 'skill' ? query.name : query.path;
    // extra 拼进 UNION 的两个分支，参数按占位符顺序各绑一次：conv_key、筛选值、conv_key、筛选值。
    const rows = store.read.query<EffectiveToolRow, [string, string, string, string]>(
      EFFECTIVE_TOOL_SQL(extra, `ORDER BY req_id, ord LIMIT ${LIMIT + 1}`),
    ).all(key, param, key, param);
    return {
      items: rows.slice(0, LIMIT).map(row => ({
        req_id: row.req_id, ord: row.ord, tool_name: row.tool_name, state: row.state,
      })),
      truncated: rows.length > LIMIT,
    };
  })();
}
