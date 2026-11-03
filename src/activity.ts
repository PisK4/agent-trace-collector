/**
 * 在途请求的内存态。
 *
 * 活跃判定里「60 秒内有更新」直接来自读模型每行的 `last_ms`，不需要另一次查询；
 * 这里只维护无法从会话表看出来的事实：哪些会话还有 `raw_route.done=0` 的请求。
 *
 * 数据来源是摄入回调，不是轮询：账本/路由批次提交后，把本轮改动过的 req_id 交给
 * `observe`，只按这几个 id 回查一次（页内改动量，不扫会话表）。进程重启时用
 * 60 秒窗口做一次有界恢复；窗口外仍未完成的请求不再宣称「请求中」，等下一次
 * 事实到达再确认——未知不等于已完成。
 */

import type { Store } from './store';

/** 与笔记、前端的 60 秒窗口保持一致。 */
export const LIVE_WINDOW_MS = 60_000;

type ActivityRow = {
  req_id: number; conv_key: string | null; started_ms: number; done: number | null;
};

export type LiveActivity = {
  /** 摄入提交后调用；只回查本批改动的请求，复杂度跟改动量走。 */
  observe(store: Store, reqIds: readonly number[]): void;
  /** 启动时恢复窗口内仍在途的请求；窗口外的一律留空。 */
  bootstrap(store: Store, now?: number): void;
  inflight(convKey: string): boolean;
};

export function createLiveActivity(): LiveActivity {
  const inflightByConv = new Map<string, Set<number>>();
  // 账本先落请求、路由后升级归属时，req_id 会换 conv_key；记住旧归属，避免
  // 在请求级会话里留下永远撤不掉的「请求中」。
  const convByReq = new Map<number, string>();
  const CHUNK = 500;

  function mark(row: ActivityRow): void {
    const key = row.conv_key;
    if (key === null) return;
    const previous = convByReq.get(row.req_id);
    if (previous !== undefined && previous !== key) {
      const old = inflightByConv.get(previous);
      if (old !== undefined) {
        old.delete(row.req_id);
        if (old.size === 0) inflightByConv.delete(previous);
      }
    }
    const ids = inflightByConv.get(key);
    if (row.done === 0) {
      if (ids === undefined) inflightByConv.set(key, new Set([row.req_id]));
      else ids.add(row.req_id);
      convByReq.set(row.req_id, key);
    } else if (row.done === 1) {
      if (ids !== undefined) {
        ids.delete(row.req_id);
        if (ids.size === 0) inflightByConv.delete(key);
      }
      convByReq.delete(row.req_id);
    }
  }

  return {
    observe(store, reqIds) {
      if (reqIds.length === 0) return;
      // 大批次按 500 分块，避免首轮导入撑爆 SQLite 的变量上限。
      for (let start = 0; start < reqIds.length; start += CHUNK) {
        const chunk = reqIds.slice(start, start + CHUNK);
        const rows = store.read.query<ActivityRow, number[]>(`
          SELECT r.req_id, r.conv_key, r.started_ms, rr.done
          FROM request r
          LEFT JOIN raw_route rr ON rr.route_id = r.route_id
          WHERE r.req_id IN (${chunk.map(() => '?').join(',')})`)
          .all(...chunk) as ActivityRow[];
        for (const row of rows) mark(row);
      }
    },
    bootstrap(store, now = Date.now()) {
      // 有界窗口 + 时间索引：只恢复最近 60 秒的在途请求，不扫会话历史。
      const rows = store.read.query<ActivityRow, number>(`
        SELECT r.req_id, r.conv_key, r.started_ms, rr.done
        FROM request r
        JOIN raw_route rr ON rr.route_id = r.route_id
        WHERE r.started_ms >= ? AND rr.done = 0 AND r.conv_key IS NOT NULL
        ORDER BY r.started_ms DESC
        LIMIT 1000`)
        .all(now - LIVE_WINDOW_MS) as ActivityRow[];
      for (const row of rows) mark(row);
    },
    inflight(convKey) {
      return inflightByConv.has(convKey);
    },
  };
}
