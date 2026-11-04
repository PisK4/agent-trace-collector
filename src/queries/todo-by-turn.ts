/**
 * 按会话、actor 与轮号读 Todo 列表。零 schema 变更：不落轮次表，不写新列。
 *
 * 轮号由 listTurns 即时结算，用它的 start_req/reply_req 与 request.started_ms
 * 界定这一轮的请求区间；工具身份从 tool_call.tool_name 取，不依赖 result_req
 * （大量 TodoWrite 没有配对结果）。参数不在 tool_call 里，在正文块的
 * tool_use.input，因此按请求分组解压一次；正文回收后如实返回 unavailable，不
 * 写成空列表。取数与编排在这里，形状适配交给注入的 Parser，查询不认识各家 Agent。
 */
import type { Store } from '../store';
import { readBodyWithMessagesTx } from '../body';
import { wireCallsOf } from '../protocol-shape';
import { listTurns, mainActorOf } from './turns';
import type { TodoParser } from '../plugins/types';
import type { TodoSnapshot } from '../plugins/todo/dto';
import { PLUGIN_REGISTRY, parsersOf } from '../plugins/registry';

/** 一轮跑完的 Todo 事实。state 区分没有更新、读得到与正文已回收三种结果。 */
export type TodoByTurn = {
  key: string;
  actor: string;
  turn: number;
  state: 'ready' | 'absent' | 'unavailable';
  /** state='ready' 时是该轮末次更新后的列表，其余为 null。 */
  snapshot: TodoSnapshot | null;
};

type ToolRow = { req_id: number; ord: number; tool_name: string };

/** 同轮请求按开始时刻与 req_id 定序，覆盖一轮含多笔 Request 的 agent loop。 */
function turnRequestIds(store: Store, key: string, actor: string,
  startReq: number, replyReq: number): number[] {
  const start = store.read.query<{ started_ms: number }, [number]>(
    'SELECT started_ms FROM request WHERE req_id=?').get(startReq);
  const end = store.read.query<{ started_ms: number }, [number]>(
    'SELECT started_ms FROM request WHERE req_id=?').get(replyReq);
  if (start === null || end === null) return [];
  return store.read.query<{ req_id: number }, [string, string, number, number]>(`
    SELECT req_id FROM request
    WHERE conv_key=? AND actor=? AND actor_state='known'
      AND started_ms>=? AND started_ms<=?
    ORDER BY started_ms ASC, req_id ASC`).all(key, actor, start.started_ms, end.started_ms)
    .map(row => row.req_id);
}

/**
 * 一笔请求只解压一次正文，把 tool_call 的 tool_name 与 tool_use.input 按 ord 对齐
 * 后交给 Parser 按序 apply。正文不可读返回 found=false，调用方据此标 unavailable。
 */
function foldRequest(store: Store, reqId: number, rows: readonly ToolRow[],
  parsers: readonly TodoParser[], previous: TodoSnapshot | null):
  { found: boolean; latest: TodoSnapshot | null } {
  const body = readBodyWithMessagesTx(store.read, reqId);
  if (body === null) return { found: false, latest: previous };
  const calls = wireCallsOf(body.body.protocol, body.body.reply);
  const byOrd = new Map(calls.map(call => [call.ord, call]));
  const agentRow = store.read.query<{ agent: string | null }, [number]>(
    'SELECT agent FROM request WHERE req_id=?').get(reqId);
  const agent = agentRow?.agent ?? '';
  let latest = previous;
  for (const row of rows) {
    const call = byOrd.get(row.ord);
    if (call === undefined) continue;
    for (const parser of parsers) {
      if (parser.agent !== agent) continue;
      const next = parser.parse({ toolName: row.tool_name, input: call.input }, latest);
      if (next !== null) { latest = next; break; }
    }
  }
  return { found: true, latest };
}

/**
 * 生产入口：actor 为空串时由服务端按轮次结算口径取主链 actor，前端不猜
 * 归属；登记关闭时返回空列表而不是报错。
 */
export function getTodoByTurn(store: Store, key: string, actor: string,
  turn: number): TodoByTurn {
  const resolved = actor === '' ? mainActorOf(store.read, key) ?? '' : actor;
  return todoByTurnWithParsers(store, key, resolved, turn, parsersOf(PLUGIN_REGISTRY, 'todo'));
}

/**
 * 注入 Parser 的窄测试 seam：生产登记与合成登记走同一份编排。
 * 一轮内多次更新按请求与 tool_use 次序 apply，末次即该轮显示值；全量快照型
 * Parser 直接覆盖，增量命令型在上一时点上累积。按 actor 独立折叠，子代理的
 * 命令不会插进主流程时间线。
 */
export function todoByTurnWithParsers(store: Store, key: string, actor: string,
  turn: number, parsers: readonly TodoParser[]): TodoByTurn {
  const base = { key, actor, turn };
  const pair = listTurns(store, key).items.find(item => item.turn === turn);
  if (pair === undefined) return { ...base, state: 'absent', snapshot: null };
  const ids = turnRequestIds(store, key, actor, pair.start_req, pair.reply_req);
  if (ids.length === 0) return { ...base, state: 'absent', snapshot: null };
  const rows = store.read.query<ToolRow, number[]>(`
    SELECT tc.req_id, tc.ord, tc.tool_name FROM tool_call tc
    WHERE tc.req_id IN (${ids.map(() => '?').join(',')})
    ORDER BY tc.req_id ASC, tc.ord ASC`).all(...ids);
  let latest: TodoSnapshot | null = null;
  let unavailable = false;
  // 按请求分组：每笔只解压一次正文，避免一轮多次 Todo 更新重复解压。
  const byRequest = new Map<number, ToolRow[]>();
  for (const row of rows) {
    const group = byRequest.get(row.req_id);
    if (group === undefined) byRequest.set(row.req_id, [row]);
    else group.push(row);
  }
  for (const id of ids) {
    const group = byRequest.get(id);
    if (group === undefined) continue;
    const result = foldRequest(store, id, group, parsers, latest);
    if (!result.found) { unavailable = true; continue; }
    latest = result.latest;
  }
  if (latest !== null) return { ...base, state: 'ready', snapshot: latest };
  return { ...base, state: unavailable ? 'unavailable' : 'absent', snapshot: null };
}
