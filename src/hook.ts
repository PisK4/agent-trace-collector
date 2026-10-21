import type { Database } from 'bun:sqlite';
import type { Store } from './store';
import { persistBodyTx } from './body';
import type { BodyInput } from './body';
import { redact } from './privacy';
import { localDay, modelTimeTitle, normalizeResponseId } from './sources/magpie';

/**
 * hook 回调的接收与证据关联。
 *
 * 不变量：
 * - 相同 hook_id 重放不产生任何副作用（靠 request_evidence 的 hook 证据行判重）。
 * - 正文、证据、pending 记录在同一事务里提交；返回成功之前一切已落盘。
 * - 关联只认可核验的 response ID，不按时间近邻猜；一个规范化 ID 命中多条时标 ambiguous。
 * - 归属未知的请求 actor 保持 NULL，不写共享哨兵，也不进 derive_queue。
 */

export type HookReportCode = 'ready' | 'empty' | 'unbound' | 'unauthorized' | 'unavailable' | 'invalid' | 'skipped';

export type HookEnvelope = {
  hook_id: string;
  observed_start_ms: number;
  observed_finish_ms: number;
  protocol: string;
  path: string;
  agent: string | null;
  session: string | null;
  cwd: string | null;
  model: string | null;
  stream: boolean;
  origin: string;
  success: boolean;
  request: unknown;
  reply: unknown;
  request_bytes: number;
  reply_bytes: number;
  body_omitted: boolean;
  omit_reason: string | null;
  magpie_version?: string;
};

export type AcceptHookResult = { req_id: number; duplicate: boolean };

const MiB = 1024 * 1024;
const MAX_BODY_BYTES = 32 * MiB;
const MAX_ENVELOPE_BYTES = 64 * MiB;

/**
 * 超限原因码；调用方据此降级为 metadata envelope，不能截断 JSON。
 *
 * 单体上限 32 MiB；整体上限 64 MiB 按 request+reply+元数据开销算，
 * 所以两个对象都贴着 32 MiB 时总和加元数据必然越过 64 MiB，
 * 用 >= 判定才不会漏掉这一类。
 */
export function bodyOmission(bytes: { request_bytes: number; reply_bytes: number }): string | null {
  if (bytes.request_bytes > MAX_BODY_BYTES || bytes.reply_bytes > MAX_BODY_BYTES) return 'collector_object_limit';
  if (bytes.request_bytes + bytes.reply_bytes >= MAX_ENVELOPE_BYTES) return 'collector_envelope_limit';
  return null;
}

export function utf8Bytes(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

function convKey(session: string | null, hookId: string): { key: string; source: string } {
  return session !== null
    ? { key: JSON.stringify(['session', session]), source: 'session' }
    : { key: JSON.stringify(['hook', hookId]), source: 'hook' };
}

function bytesOf(value: unknown): Uint8Array {
  return new Uint8Array(Buffer.from(JSON.stringify(value) ?? '', 'utf8'));
}

/**
 * 按规范化 response ID 找候选。只认 route_id 非空的存活请求；
 * 多个候选时不挑一个，标 ambiguous 留给后续证据收敛。
 */
function findCandidates(db: Database, responseIdNorm: string | null): number[] {
  if (responseIdNorm === null) return [];
  const rows = db.query<{ req_id: number }, [string]>(`
    SELECT req_id FROM request
    WHERE response_id_norm=? AND route_id IS NOT NULL
    ORDER BY req_id`).all(responseIdNorm);
  return rows.map(row => row.req_id);
}

type HookRequestRow = {
  req_id: number; actor: string | null; actor_state: string; conv_key: string | null;
  title: string | null; title_source: string | null;
};

function hookRequest(db: Database, hookId: string): HookRequestRow | null {
  return db.query<HookRequestRow, [string]>(`
    SELECT r.req_id, r.actor, r.actor_state, r.conv_key, r.title, r.title_source
    FROM request_evidence e JOIN request r ON r.req_id = e.req_id
    WHERE e.source_kind='hook' AND e.ref_key=?`).get(hookId);
}

function insertHookRequest(
  db: Database,
  envelope: HookEnvelope,
  now: number,
  responseIdNorm: string | null,
): number {
  const conv = convKey(envelope.session, envelope.hook_id);
  // hook 阶段只知道会话，不知道 actor；actor_state 留 unknown，等账本或路由确认。
  const actor = envelope.session;
  const started = Number.isFinite(envelope.observed_start_ms) ? envelope.observed_start_ms : now;
  const title = modelTimeTitle(envelope.model, started);
  const result = db.run(
    `INSERT INTO request(
       response_id_norm,agent,session,conv_key,conv_source,actor,actor_state,
       started_ms,day,via,status,model_requested,model_served,
       body_state,derive_version,have,created_at,updated_at,title,title_source,
       cost_state,attempt_state,sort_source,sort_key,magpie_version,parse_state,reply_state
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      responseIdNorm, envelope.agent, envelope.session, conv.key, conv.source,
      actor, 'unknown',
      started, localDay(started), 'hook', envelope.success ? 200 : null,
      envelope.model, envelope.model,
      envelope.body_omitted ? 'partial' : 'pending', 0, 1, now, now, title, 'model_time',
      'absent', 'known', 'hook', envelope.hook_id, envelope.magpie_version ?? null, null, null,
    ],
  );
  return Number(result.lastInsertRowid);
}

/** 相同 hook_id 已有证据：只确认存在，不改任何字段。 */
function duplicateResult(db: Database, hookId: string): AcceptHookResult | null {
  const existing = hookRequest(db, hookId);
  return existing === null ? null : { req_id: existing.req_id, duplicate: true };
}

function replyIdOf(reply: unknown): string | null {
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) return null;
  const value = (reply as Record<string, unknown>).id;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function savePending(db: Database, envelope: HookEnvelope, responseIdNorm: string | null, candidates: number[], now: number): void {
  if (candidates.length === 1) return;
  db.run(
    `INSERT INTO pending_hook(hook_id,response_id,response_id_norm,first_seen,last_tried,candidates)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(hook_id) DO UPDATE SET
       response_id=excluded.response_id, response_id_norm=excluded.response_id_norm,
       last_tried=excluded.last_tried, candidates=excluded.candidates`,
    [
      envelope.hook_id, replyIdOf(envelope.reply),
      responseIdNorm, now, now,
      candidates.length === 0 ? null : JSON.stringify(candidates),
    ],
  );
}

/**
 * 接收一个 hook envelope。调用方必须已经完成认证、来源校验与容量检查；
 * 本函数只管落库与关联。
 */
export function acceptHook(
  store: Store,
  envelope: HookEnvelope,
  now: number,
  salt: Uint8Array,
): AcceptHookResult {
  return store.write(db => {
    if (typeof envelope.hook_id !== 'string' || envelope.hook_id.length === 0) {
      throw new Error('hook_id_missing');
    }
    if (envelope.origin !== 'local') throw new Error('hook_origin_rejected');
    const duplicate = duplicateResult(db, envelope.hook_id);
    if (duplicate !== null) return duplicate;

    const responseIdNorm = normalizeResponseId(replyIdOf(envelope.reply));

    // 有正文时先存文档层；body_omitted 的请求只保留 metadata 与降级原因。
    const bodyBytes = {
      request_bytes: utf8Bytes(envelope.request),
      reply_bytes: utf8Bytes(envelope.reply),
    };
    const omission = envelope.body_omitted ? (envelope.omit_reason ?? 'collector_object_limit') : bodyOmission(bodyBytes);

    const redactedRequest = envelope.request === null ? null : redact(envelope.request, salt);
    const redactedReply = envelope.reply === null ? null : redact(envelope.reply, salt);

    // 先决定关联对象，再写请求：已有关联时复用那一条，避免多造一行。
    const joined = responseIdNorm === null ? { candidates: [] as number[], target: null as number | null }
      : (() => {
        const candidates = findCandidates(db, responseIdNorm);
        return { candidates, target: candidates.length === 1 ? candidates[0]! : null };
      })();

    let reqId: number;
    if (joined.target !== null) {
      reqId = joined.target;
    } else {
      reqId = insertHookRequest(db, envelope, now, responseIdNorm);
    }

    const body: BodyInput = {
      protocol: envelope.protocol,
      request: redactedRequest,
      reply: redactedReply,
      redact_version: 1,
    };
    const current = db.query<{ body_state: string }, [number]>(
      'SELECT body_state FROM request WHERE req_id=?',
    ).get(reqId);
    const hasBody = current?.body_state === 'available' || current?.body_state === 'partial';
    if (omission === null) {
      persistBodyTx(db, reqId, body);
    } else if (!hasBody) {
      // 只有本来就没正文时才降级；已有正文的请求不因一次超限回调被抹掉。
      db.run(
        `UPDATE request SET body_state='partial', miss_reason=?, updated_at=? WHERE req_id=?`,
        [omission, now, reqId],
      );
    }

    db.run(
      'INSERT OR IGNORE INTO request_evidence(req_id,source_kind,ref_key,merge_state,match_rule,added_at) VALUES (?,?,?,?,?,?)',
      [reqId, 'hook', envelope.hook_id, joined.target === null ? 'pending' : 'merged', 'response_id_norm.v1', now],
    );
    db.run(
      `INSERT INTO raw_hook(hook_id,received_at,protocol,path,agent,session,cwd,origin,model,stream,success,duration_ms,
         request_z,response_z,request_bytes,response_bytes,parse_state,reply_state,miss_reason,magpie_version)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        envelope.hook_id, now, envelope.protocol, envelope.path, envelope.agent, envelope.session, envelope.cwd,
        envelope.origin, envelope.model, envelope.stream ? 1 : 0, envelope.success ? 1 : 0,
        Math.max(0, envelope.observed_finish_ms - envelope.observed_start_ms),
        // 正文副本只在块提交的同一事务里保留；正文已入库时这里不存第二份。
        null, null,
        omission === null ? bodyBytes.request_bytes : 0,
        omission === null ? bodyBytes.reply_bytes : 0,
        envelope.body_omitted ? 'partial' : 'ok',
        envelope.reply === null ? 'absent' : 'ok',
        omission, envelope.magpie_version ?? null,
      ],
    );

    savePending(db, envelope, responseIdNorm, joined.candidates, now);
    db.run('UPDATE request SET have=have|1, updated_at=? WHERE req_id=?', [now, reqId]);
    return { req_id: reqId, duplicate: false };
  });
}

/**
 * 把一笔 hook 请求并进保留对象（通常是账本请求）。
 *
 * 顺序不能反：先把所有指向待删请求的别名改到最终 ID，再新增本次映射；
 * 否则中间的别名会短暂指向一个不存在的请求，外键立刻报错。
 */
function mergeHookInto(db: Database, hookId: string, targetId: number, now: number): void {
  const source = hookRequest(db, hookId);
  if (source === null || source.req_id === targetId) {
    if (source !== null) {
      db.run('DELETE FROM pending_hook WHERE hook_id=?', [hookId]);
      db.run("UPDATE request_evidence SET merge_state='merged' WHERE source_kind='hook' AND ref_key=?", [hookId]);
    }
    return;
  }
  const sourceId = source.req_id;

  // 1) 先把别的别名从 sourceId 改指向 targetId。
  db.run('UPDATE request_alias SET new_id=? WHERE new_id=?', [targetId, sourceId]);
  // 2) 再登记本次 sourceId → targetId。
  db.run('INSERT OR REPLACE INTO request_alias(old_id,new_id) VALUES (?,?)', [sourceId, targetId]);

  // 3) 迁移证据、正文引用、工具链接与前驱引用。
  db.run('UPDATE request_evidence SET req_id=? WHERE req_id=?', [targetId, sourceId]);
  db.run('UPDATE request_evidence SET merge_state=? WHERE source_kind=? AND ref_key=?', ['merged', 'hook', hookId]);
  // 正文引用迁移：目标已有同 ord 时以目标为准，否则搬过来。
  db.run(
    `UPDATE request_block SET req_id=? WHERE req_id=? AND ord NOT IN (SELECT ord FROM request_block WHERE req_id=?)`,
    [targetId, sourceId, targetId],
  );
  db.run('DELETE FROM request_block WHERE req_id=?', [sourceId]);
  db.run('UPDATE tool_call SET req_id=? WHERE req_id=?', [targetId, sourceId]);
  db.run('UPDATE tool_call SET result_req=? WHERE result_req=?', [targetId, sourceId]);
  db.run('UPDATE request SET prev_req_id=? WHERE prev_req_id=?', [targetId, sourceId]);

  // 4) 目标缺正文而源有正文时搬过去，不覆盖已有正文。
  const targetBody = db.query<{ body_state: string }, [number]>('SELECT body_state FROM request WHERE req_id=?').get(targetId);
  const sourceBody = db.query<{ skeleton_z: Uint8Array | null; body_state: string; parse_state: string | null; reply_state: string | null; msg_count: number | null }, [number]>(
    'SELECT skeleton_z, body_state, parse_state, reply_state, msg_count FROM request WHERE req_id=?',
  ).get(sourceId);
  if (targetBody?.body_state !== 'available' && sourceBody?.skeleton_z != null) {
    db.run(
      `UPDATE request SET skeleton_z=?, body_state=?, parse_state=COALESCE(parse_state,?), reply_state=COALESCE(reply_state,?),
         msg_count=COALESCE(msg_count,?) WHERE req_id=?`,
      [sourceBody.skeleton_z, sourceBody.body_state, sourceBody.parse_state, sourceBody.reply_state, sourceBody.msg_count, targetId],
    );
    db.run('UPDATE request SET skeleton_z=NULL WHERE req_id=?', [sourceId]);
  }

  // 5) 归属：hook 阶段 actor 未知，账本已确认时保留账本的。
  db.run(
    `UPDATE request SET
       response_id_norm=COALESCE(response_id_norm,(SELECT response_id_norm FROM request WHERE req_id=?)),
       conv_key=COALESCE(conv_key,(SELECT conv_key FROM request WHERE req_id=?)),
       conv_source=COALESCE(conv_source,(SELECT conv_source FROM request WHERE req_id=?)),
       have=have|1, updated_at=?
     WHERE req_id=?`,
    [sourceId, sourceId, sourceId, now, targetId],
  );

  // 6) 清掉临时请求与 pending 行。
  db.run('DELETE FROM pending_hook WHERE hook_id=?', [hookId]);
  db.run('DELETE FROM request WHERE req_id=?', [sourceId]);
}

/**
 * 重新尝试把 pending hook 并到已到达的账本请求。
 * 只处理候选唯一的情况；仍无候选或多候选保持 pending。
 */
export function reconcilePending(store: Store, now: number): { merged: number; pending: number; ambiguous: number } {
  return store.write(db => {
    const rows = db.query<{ hook_id: string; response_id_norm: string | null }, []>(
      'SELECT hook_id, response_id_norm FROM pending_hook ORDER BY first_seen').all();
    let merged = 0;
    let pending = 0;
    let ambiguous = 0;
    for (const row of rows) {
      const candidates = findCandidates(db, row.response_id_norm);
      if (candidates.length === 0) {
        pending += 1;
        continue;
      }
      if (candidates.length > 1) {
        db.run('UPDATE pending_hook SET last_tried=?, candidates=? WHERE hook_id=?', [
          now, JSON.stringify(candidates), row.hook_id,
        ]);
        ambiguous += 1;
        continue;
      }
      mergeHookInto(db, row.hook_id, candidates[0]!, now);
      merged += 1;
    }
    return { merged, pending, ambiguous };
  });
}
