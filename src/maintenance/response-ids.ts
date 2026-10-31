/**
 * response id 规范化的存量修复。
 *
 * 旧规则只剥一层前缀，`chatcmpl-msg_<id>` 与 `msg_<id>` 会得到两个匹配键，
 * 同一响应的 hook 与账本各自建行。规则本身只住在 normalizeResponseId；
 * 这个模块按当前规则重算存量列，再让等待队列按新键重试合并。
 *
 * 只改派生列，不动正文。合并沿用 reconcilePending 的唯一候选路径：
 * 多候选保持 pending，不取首条猜测。
 */

import type { Database } from 'bun:sqlite';
import { reconcilePending } from '../hook';
import { normalizeResponseId } from '../sources/magpie/mapping';
import type { Store } from '../store';

export type ResponseIdPreview = {
  requests: number;
  pending_hooks: number;
  raw_ledger: number;
  merges: number;
  ambiguous: number;
  without_id: number;
};

export type ResponseIdReport = ResponseIdPreview & {
  merged: number;
  remaining: number;
};

type NormGroup = { old: string; next: string; n: number };

type Scan = {
  groups: { request: NormGroup[]; pending_hook: NormGroup[]; raw_ledger: NormGroup[] };
  preview: ResponseIdPreview;
};

const TABLES = ['request', 'pending_hook', 'raw_ledger'] as const;

function changedGroups(db: Database, table: (typeof TABLES)[number]): NormGroup[] {
  const rows = db.query<{ norm: string; n: number }, []>(
    `SELECT response_id_norm AS norm, count(*) AS n FROM ${table}
     WHERE response_id_norm IS NOT NULL GROUP BY response_id_norm`).all();
  const groups: NormGroup[] = [];
  for (const row of rows) {
    const next = normalizeResponseId(row.norm);
    if (next !== null && next !== row.norm) groups.push({ old: row.norm, next, n: row.n });
  }
  return groups;
}

function pendingOutlook(db: Database, changes: Map<string, string>): Pick<ResponseIdPreview, 'merges' | 'ambiguous' | 'without_id'> {
  const rows = db.query<{ norm: string | null }, []>('SELECT response_id_norm AS norm FROM pending_hook').all();
  const candidates = db.query<{ n: number }, [string]>(
    'SELECT count(*) AS n FROM request WHERE response_id_norm=? AND route_id IS NOT NULL');
  let merges = 0;
  let ambiguous = 0;
  let withoutId = 0;
  for (const row of rows) {
    if (row.norm === null) {
      withoutId += 1;
      continue;
    }
    const next = changes.get(row.norm) ?? row.norm;
    const n = candidates.get(next)?.n ?? 0;
    if (n === 1) merges += 1;
    else if (n > 1) ambiguous += 1;
  }
  return { merges, ambiguous, without_id: withoutId };
}

function scan(db: Database): Scan {
  const groups = {
    request: changedGroups(db, 'request'),
    pending_hook: changedGroups(db, 'pending_hook'),
    raw_ledger: changedGroups(db, 'raw_ledger'),
  };
  const changes = new Map<string, string>();
  for (const table of TABLES) {
    for (const group of groups[table]) changes.set(group.old, group.next);
  }
  return {
    groups,
    preview: {
      requests: groups.request.reduce((sum, group) => sum + group.n, 0),
      pending_hooks: groups.pending_hook.reduce((sum, group) => sum + group.n, 0),
      raw_ledger: groups.raw_ledger.reduce((sum, group) => sum + group.n, 0),
      ...pendingOutlook(db, changes),
    },
  };
}

export function previewResponseIdNormalization(store: Store): ResponseIdPreview {
  return scan(store.read).preview;
}

export function normalizeStoredResponseIds(store: Store): ResponseIdReport {
  const { groups, preview } = scan(store.read);
  if (preview.requests + preview.pending_hooks + preview.raw_ledger > 0) {
    store.write(db => {
      for (const table of TABLES) {
        for (const group of groups[table]) {
          db.run(`UPDATE ${table} SET response_id_norm=? WHERE response_id_norm=?`, [group.next, group.old]);
        }
      }
    }, 'normalize_response_ids');
  }
  // reconcilePending 每轮最多处理 10 个唯一候选；处理完为止，歧义候选留队。
  let merged = 0;
  for (;;) {
    const result = reconcilePending(store, Date.now());
    merged += result.merged;
    if (result.merged === 0) break;
  }
  const remaining = (store.read.query('SELECT count(*) AS n FROM pending_hook').get() as { n: number }).n;
  return { ...preview, merged, remaining };
}
