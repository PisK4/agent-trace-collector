/**
 * 显式重解析：把旧写入布局的正文按当前适配器重写，逐笔独立事务。
 *
 * 触发权只在显式命令手里：读取连接是只读的，读时懒重建会把页面滚动变成写路径。
 * 候选按 `adapter_version` 筛选，NULL 是历史版本，不能当已处理跳过；协议从骨架
 * 的长期字段取，不依赖可能已过期的 `raw_hook`。
 */

import type { Database } from 'bun:sqlite';
import { zstdDecompressSync } from 'node:zlib';
import { persistBodyTx, readBodyTx } from '../body';
import { ADAPTER_VERSION } from '../protocols';
import { skeletonLike, validateSkeleton } from '../skeleton';
import type { Store } from '../store';

export type ReparseRow = { req_id: number; reason: string };

export type ReparseReport = {
  protocol: string;
  adapter_version: number;
  /** 版本落后且有骨架的请求行总数（含其它协议与无法归属的行）。 */
  scanned: number;
  /** 骨架协议等于目标协议的候选行数。 */
  matched: number;
  rewritten: number;
  /** 拒绝重写的行与原因；这些行原样保留。 */
  rejected: ReparseRow[];
  /** 单行事务失败的行；失败不影响其它行。 */
  failed: ReparseRow[];
  /** 骨架本身读不出协议的行：无法归属到任何协议，原样保留。 */
  unattributed_skeleton: number;
  /** 目标协议里仍有版本落后的行数（被拒绝的行会留在这里）。 */
  remaining: number;
};

type CandidateRow = {
  req_id: number; body_state: string; skeleton_z: Uint8Array; msg_count: number | null;
};

const BELOW_VERSION = '(adapter_version IS NULL OR adapter_version < ?)';

/** 松散读取骨架里的协议名；损坏或类型不对返回 null。 */
function protocolOf(skeletonZ: Uint8Array): string | null {
  try {
    const parsed = skeletonLike(JSON.parse(zstdDecompressSync(skeletonZ).toString('utf8')));
    return parsed !== null && typeof parsed.protocol === 'string' && parsed.protocol.length > 0
      ? parsed.protocol : null;
  } catch {
    return null;
  }
}

/** 版本落后、有骨架的行；正文状态留给单行事务判定，partial 要报告而不是静默跳过。 */
function candidates(store: Store): CandidateRow[] {
  return store.read.query<CandidateRow, [number]>(`
    SELECT req_id, body_state, skeleton_z, msg_count FROM request
    WHERE skeleton_z IS NOT NULL AND body_state IN ('available','partial')
      AND ${BELOW_VERSION} ORDER BY req_id`).all(ADAPTER_VERSION);
}

/**
 * 重写一行。事务内重新读行与骨架：候选扫描之后可能有别的写入，
 * 这里的结果必须基于当前状态。
 *
 * 拒绝的条件都是"重写会丢信息"：partial 正文不完整、骨架不符合写入契约、
 * 块引用不完整读不出原文。这些行原样保留，状态与原因不动。
 */
function reparseRow(store: Store, reqId: number, protocol: string):
  { ok: true } | { ok: false; reason: string } {
  return store.write((db: Database) => {
    const row = db.query<{
      body_state: string; skeleton_z: Uint8Array | null; msg_count: number | null;
      adapter_version: number | null;
    }, [number]>(`
      SELECT body_state, skeleton_z, msg_count, adapter_version FROM request WHERE req_id=?`,
    ).get(reqId);
    if (row === null || row.skeleton_z == null) return { ok: false as const, reason: 'body_missing' };
    if (row.adapter_version !== null && row.adapter_version >= ADAPTER_VERSION) {
      return { ok: false as const, reason: 'already_current' };
    }
    if (row.body_state !== 'available') {
      return { ok: false as const, reason: `body_${row.body_state}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(zstdDecompressSync(row.skeleton_z).toString('utf8'));
    } catch {
      return { ok: false as const, reason: 'skeleton_invalid' };
    }
    const skeleton = skeletonLike(parsed);
    const record = skeleton === null ? null : validateSkeleton(skeleton, row.msg_count);
    if (record === null) return { ok: false as const, reason: 'skeleton_invalid' };
    // 候选按骨架协议筛过；这里只防扫描之后的变更。
    if (record.protocol !== protocol) return { ok: false as const, reason: 'protocol_mismatch' };
    // 两种布局都先完整恢复成原对象，再交给写入路径按当前形状拆块。
    const body = readBodyTx(db, reqId);
    if (body === null) return { ok: false as const, reason: 'body_unreadable' };
    persistBodyTx(db, reqId, body);
    return { ok: true as const };
  });
}

/** 目标协议里仍版本落后的行数：被拒绝的行与运行期间新增的行都留在这里。 */
function remainingOf(store: Store, protocol: string): number {
  return candidates(store)
    .filter(row => protocolOf(row.skeleton_z) === protocol).length;
}

/**
 * 重解析指定协议的历史正文。逐笔独立事务：单行失败只记在这一行上，
 * 其它行照常重写；重复执行不重复处理已经升版的行。
 */
export function reparseProtocol(store: Store, protocol: string): ReparseReport {
  const rows = candidates(store);
  const rejected: ReparseRow[] = [];
  const failed: ReparseRow[] = [];
  let matched = 0;
  let unattributed = 0;
  let rewritten = 0;
  for (const row of rows) {
    const skeletonProtocol = protocolOf(row.skeleton_z);
    if (skeletonProtocol === null) {
      unattributed += 1;
      continue;
    }
    if (skeletonProtocol !== protocol) continue;
    matched += 1;
    try {
      const result = reparseRow(store, row.req_id, protocol);
      if (result.ok) {
        rewritten += 1;
      } else {
        rejected.push({ req_id: row.req_id, reason: result.reason });
      }
    } catch (error) {
      failed.push({
        req_id: row.req_id,
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
  }
  return {
    protocol,
    adapter_version: ADAPTER_VERSION,
    scanned: rows.length,
    matched,
    rewritten,
    rejected,
    failed,
    unattributed_skeleton: unattributed,
    remaining: remainingOf(store, protocol),
  };
}
