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

type TableName = 'request' | 'pending_hook' | 'raw_ledger';

export type ResponseIdConflict = {
  table: TableName;
  key: string;
  values: string[];
};

export type ResponseIdPreview = {
  requests: number;
  pending_hooks: number;
  raw_ledger: number;
  merges: number;
  ambiguous: number;
  without_id: number;
  /** 同表两个不同旧键落到同一目标键。预览列出，应用整批拒绝。 */
  conflicts: ResponseIdConflict[];
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

const TABLES: readonly TableName[] = ['request', 'pending_hook', 'raw_ledger'];

function changedGroups(db: Database, table: TableName): NormGroup[] {
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

type RequestKeyRow = { req_id: number; route_id: number | null; via: string; norm: string };

/**
 * 预演整批操作后 `request` 里是否还会出现同键多行。
 *
 * 只看 `request`：`pending_hook` 是等待队列、`raw_ledger` 是原始层，共用响应键
 * 是正常形态；会让 `byResponseId` 变 ambiguous 的重复键只发生在 `request`。
 *
 * 同键本身不一定是缺陷：hook 行与路由行本来就会被规范化到同一个键，再由
 * reconcilePending 的唯一候选路径合并删除。这里只放行这条既有路径：
 * 唯一 route 候选 + 有等待项指向的源行。其余形态全判冲突，不猜两行同源。
 */
function requestConflicts(db: Database): ResponseIdConflict[] {
  const rows = db.query<RequestKeyRow, []>(
    `SELECT req_id, route_id, via, response_id_norm AS norm FROM request
     WHERE response_id_norm IS NOT NULL`).all();
  const byKey = new Map<string, RequestKeyRow[]>();
  for (const row of rows) {
    const key = normalizeResponseId(row.norm);
    if (key === null) continue;
    const group = byKey.get(key);
    if (group === undefined) byKey.set(key, [row]);
    else group.push(row);
  }
  const pendingByKey = new Map<string, string[]>();
  for (const row of db.query<{ hook_id: string; norm: string }, []>(
    `SELECT hook_id, response_id_norm AS norm FROM pending_hook
     WHERE response_id_norm IS NOT NULL`).all()) {
    const key = normalizeResponseId(row.norm);
    if (key === null) continue;
    const group = pendingByKey.get(key);
    if (group === undefined) pendingByKey.set(key, [row.hook_id]);
    else group.push(row.hook_id);
  }
  const sourceOf = db.query<{ req_id: number }, [string]>(`
    SELECT r.req_id FROM request_evidence e JOIN request r ON r.req_id=e.req_id
    WHERE e.source_kind='hook' AND e.ref_key=?`);

  const conflicts: ResponseIdConflict[] = [];
  for (const [key, group] of byKey) {
    const values = [...new Set(group.map(row => row.norm))];
    if (values.length < 2) continue;
    const route = group.filter(row => row.route_id !== null);
    const deleted = new Set<number>();
    if (route.length === 1) {
      const target = route[0]!.req_id;
      for (const hookId of pendingByKey.get(key) ?? []) {
        const source = sourceOf.get(hookId);
        if (source !== null && source.req_id !== target) deleted.add(source.req_id);
      }
    }
    const survivors = group.filter(row => row.via !== 'rejected' && !deleted.has(row.req_id));
    if (survivors.length > 1) {
      conflicts.push({ table: 'request', key, values: values.sort() });
    }
  }
  return conflicts;
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
      conflicts: requestConflicts(db),
    },
  };
}

export function previewResponseIdNormalization(store: Store): ResponseIdPreview {
  return scan(store.read).preview;
}

export function normalizeStoredResponseIds(store: Store): ResponseIdReport {
  const { groups, preview } = scan(store.read);
  // 冲突先于任何写入：UPDATE 会把两个旧键并成一个，但这里无法证明两行同源。
  if (preview.conflicts.length > 0) throw new Error('response_id_conflict');
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
