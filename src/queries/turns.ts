/** 轮次结算：读模型即时结算，不落轮次表。判据见轮次两端阅读提案 note。 */

import type { Database } from 'bun:sqlite';
import { deriveJoinSql, derivedColSql, groupCurrentSql } from '../derive/state';
import { interpretMessage } from '../input-interpretation';
import { readBodyTx } from '../body';
import type { Store } from '../store';
import { isRecord } from './projection';

/**
 * 已结算轮的目录身份：一条用户命令与它的最终回复。turn 是会话内已结算轮的
 * 全序序号（从会话头数起、只数已结算轮），加载更早历史不重号。
 */
export type TurnPairRow = {
  turn: number;
  /** 起点请求：命令组所在笔。 */
  start_req: number;
  /** 起点请求内用户主动文本的消息序号列表（命令组，按序）。 */
  ordinals: number[];
  /** 终点请求：最终回复所在笔。 */
  reply_req: number;
};

/** 轮次列表响应：按累计窗口结算，不做跨页增量合并。 */
export type TurnsPage = { items: TurnPairRow[] };

/** 结算消费的行：选源后的派生列与判轮需要的请求列。 */
type TurnRow = {
  req_id: number; started_ms: number; agent: string | null;
  prev_req_id: number | null; prev_relation: string | null;
  chain_role: string | null; input_preview_kind: string | null;
  reply_shape: string | null; delta_ordinals: string | null;
  purpose_chain: string; req_kind: string | null;
};

const TURN_COLUMNS = `r.req_id, r.started_ms, r.agent,
  ${derivedColSql('g', 'd', 'r', 'prev_req_id')} AS prev_req_id,
  ${derivedColSql('g', 'd', 'r', 'prev_relation')} AS prev_relation,
  ${derivedColSql('g', 'd', 'r', 'chain_role')} AS chain_role,
  ${derivedColSql('g', 'd', 'r', 'input_preview_kind')} AS input_preview_kind,
  ${derivedColSql('g', 'd', 'r', 'reply_shape')} AS reply_shape,
  ${derivedColSql('g', 'd', 'r', 'delta_ordinals')} AS delta_ordinals,
  r.purpose_chain, r.req_kind`;

/**
 * 主链 actor：参与请求最多的那个组。子代理与主会话共用 conv_key 但按 actor
 * 各自成组，主流程的参与请求数远多于任何子代理；同数时取最早开头的组。
 */
function mainActorOf(read: Database, convKey: string): string | null {
  const row = read.query<{ actor: string }, [string]>(`
    SELECT actor FROM request
    WHERE conv_key=? AND actor IS NOT NULL AND actor_state='known'
      AND purpose_chain='participate'
    GROUP BY actor ORDER BY COUNT(*) DESC, MIN(started_ms) ASC, actor ASC LIMIT 1`).get(convKey);
  return row?.actor ?? null;
}

/**
 * 命令组定位：起点请求内重新解读 delta_ordinals，筛出用户主动文本的消息序号。
 * 解释与派生期的 kind 位同源（interpretMessage 一份判定）；正文不可读或增量
 * 已随回收清空时返回空表，命令面板按回收态呈现。
 */
function commandOrdinals(read: Database, row: TurnRow): number[] {
  if (row.delta_ordinals === null) return [];
  let delta: unknown;
  try { delta = JSON.parse(row.delta_ordinals); } catch { return []; }
  if (!Array.isArray(delta) || !delta.every(Number.isSafeInteger)) return [];
  const body = readBodyTx(read, row.req_id);
  if (body === null || !isRecord(body.request)) return [];
  const messages = body.request.messages;
  if (!Array.isArray(messages)) return [];
  const ords: number[] = [];
  for (const ordinal of delta) {
    const message = messages[ordinal];
    if (message === undefined) continue;
    const view = interpretMessage(message, row.agent, ordinal);
    if (view.input !== null && view.input.state === 'text') ords.push(ordinal);
  }
  return ords;
}

/**
 * 结算一个会话的轮次：命令（起点）到最终回复（终点），跨多笔请求的 agent loop。
 *
 * 起点资格先看链角色（已证明主链，或自身关系未知的行——回收起点照常进带），
 * 命令判据唯一落在派生时写下的 kind 位（`input_preview_kind='delta'`），正文
 * 回收后该位保留、起点照常进带。终点沿确定的 parent 前驱边搜索后代：路径上
 * 不经过其他用户命令请求（kind 位同源判定），可达且路径纯净的 `final` 恰好
 * 一个才结算，分叉出多个保守不结算。只消费派生状态为 current 的组，结算在
 * 同一个只读快照内完成。`from` 是累计窗口下界：起点在下界之前的轮不返回，
 * 轮号仍是会话内已结算轮的全序序号，加载更早历史不重号。
 */
export function listTurns(store: Store, key: string, from: number | null = null): TurnsPage {
  return store.read.transaction(() => {
    const actor = mainActorOf(store.read, key);
    if (actor === null) return { items: [] };
    const rows = store.read.query<TurnRow, [string, string]>(`
      SELECT ${TURN_COLUMNS} FROM request r ${deriveJoinSql('g', 'd', 'r')}
      WHERE r.conv_key=? AND r.actor=? AND r.actor_state='known'
        AND r.purpose_chain='participate' AND ${groupCurrentSql('g')}
      ORDER BY r.started_ms ASC, r.req_id ASC`).all(key, actor);
    const byId = new Map(rows.map(row => [row.req_id, row]));
    // 确定 parent 边：终点搜索只走 confirmed 前驱边，不按时间推断父子。
    const children = new Map<number, number[]>();
    for (const row of rows) {
      if (row.prev_relation !== 'confirmed' || row.prev_req_id === null) continue;
      if (!byId.has(row.prev_req_id)) continue;
      const list = children.get(row.prev_req_id);
      if (list === undefined) children.set(row.prev_req_id, [row.req_id]);
      else list.push(row.req_id);
    }
    const isCommand = (row: TurnRow): boolean => row.input_preview_kind === 'delta';
    // 起点资格：已证明主链上的行，或链角色落 unknown 的行。unknown 覆盖两种
    // 情况：正文回收的起点（自身关系 unknown），以及不确定闭包里的后继
    // （confirmed）。后者的 delta 相对可读前驱成立，是用户命令的直接证据，
    // 不因归属不能证明就排除。branch 仍然不进带：它能被证明与主链不相接。
    const isStart = (row: TurnRow): boolean => row.chain_role === 'main'
      || row.chain_role === 'unknown';
    const settled: { row: TurnRow; endpoint: number }[] = [];
    for (const row of rows) {
      // 排除范围：分支链、不确定闭包后继、辅助与标题请求都不参与；起点必须是命令行。
      if (!isStart(row) || row.req_kind === 'title' || !isCommand(row)) continue;
      // 起点自身收尾：纯对话轮两端同笔，不看后代。
      if (row.reply_shape === 'final') {
        settled.push({ row, endpoint: row.req_id });
        continue;
      }
      const finals: number[] = [];
      const stack = [...children.get(row.req_id) ?? []];
      const seen = new Set<number>(stack);
      while (stack.length > 0) {
        const id = stack.pop()!;
        const node = byId.get(id);
        if (node === undefined) continue;
        // 命令请求：路径污染，不能当终点也不穿过——被打断的轮不借后面的回复复活。
        if (isCommand(node)) continue;
        if (node.reply_shape === 'final') finals.push(id);
        for (const child of children.get(id) ?? []) {
          if (!seen.has(child)) { seen.add(child); stack.push(child); }
        }
      }
      if (finals.length === 1) settled.push({ row, endpoint: finals[0]! });
    }
    const items = settled
      .sort((a, b) => a.row.started_ms - b.row.started_ms || a.row.req_id - b.row.req_id)
      .map((entry, index) => ({
        turn: index + 1,
        start_req: entry.row.req_id,
        ordinals: commandOrdinals(store.read, entry.row),
        reply_req: entry.endpoint,
      }))
      .filter(item => from === null || item.start_req >= from);
    return { items };
  })();
}
