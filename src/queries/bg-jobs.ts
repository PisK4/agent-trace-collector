/** 背景作业配对：bg_job 结算行的会话口径读取。 */

import type { Store } from '../store';

export type BgJobRow = {
  job_id: string;
  spawn_req: number | null;
  spawn_ord: number | null;
  notice_req: number | null;
  notice_ord: number | null;
  state: string;
  /** 两笔请求的 started_ms；时延与「同一请求内」由展示层据此判定。 */
  spawn_ms: number | null;
  notice_ms: number | null;
};

type BgJobDbRow = {
  job_id: string; spawn_req: number | null; spawn_ord: number | null;
  notice_req: number | null; notice_ord: number | null; state: string;
  spawn_ms: number | null; notice_ms: number | null;
};

/**
 * 一个会话的 bg_job 行，按作业在会话里首次出现的时刻排序。
 * 行来自派生结算表；组没算完时它是上一次完成的事实，与工具配对同口径。
 */
export function listBgJobs(store: Store, key: string): BgJobRow[] {
  const rows = store.read.query<BgJobDbRow, [string]>(`
    SELECT b.job_id, b.spawn_req, b.spawn_ord, b.notice_req, b.notice_ord, b.state,
      rs.started_ms AS spawn_ms, rn.started_ms AS notice_ms
    FROM bg_job b
    LEFT JOIN request rs ON rs.req_id = b.spawn_req
    LEFT JOIN request rn ON rn.req_id = b.notice_req
    WHERE b.conv_key=?`).all(key);
  return rows
    .sort((a, b) => (Math.min(a.spawn_ms ?? Number.MAX_SAFE_INTEGER,
      a.notice_ms ?? Number.MAX_SAFE_INTEGER)
      - Math.min(b.spawn_ms ?? Number.MAX_SAFE_INTEGER,
        b.notice_ms ?? Number.MAX_SAFE_INTEGER))
      || a.job_id.localeCompare(b.job_id))
    .map(row => ({
      job_id: row.job_id,
      spawn_req: row.spawn_req, spawn_ord: row.spawn_ord,
      notice_req: row.notice_req, notice_ord: row.notice_ord,
      state: row.state,
      spawn_ms: row.spawn_ms, notice_ms: row.notice_ms,
    }));
}
