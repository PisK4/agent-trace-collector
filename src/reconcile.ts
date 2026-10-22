import { constants, zstdCompressSync } from 'node:zlib';
import type { Database } from 'bun:sqlite';
import type { Store } from './store';
import type { FileBatch } from './sources/files';
import { redact } from './privacy';
import {
  isRecord,
  localDay,
  mapLedgerRow,
  mapRouteRow,
  modelTimeTitle,
  optionalNumber,
} from './sources/magpie';
import type { LedgerFields, RouteFields } from './sources/magpie';
import { insertPreparedLedgerTx, upsertPreparedRouteTx } from './sources/raw';
import type { LedgerPhysicalRef } from './sources/raw';
import { SOURCE_PROJECTION_VERSION, projectRequestTx } from './sources/projection';
import type { RequestProjection } from './sources/projection';
import { enqueueDeriveTx } from './derive';
import { isPurgedEvidence } from './maintenance';
import { closeSourceGapsTx, markStaleGapsTx, recordPausedBatchTx } from './retention';

export type IngestLedgerResult = {
  accepted: number; invalid: number; duplicate: number; purged_skip: number;
};

function evidenceRef(generation: string, offset: number): string {
  return JSON.stringify(['file', generation, offset]);
}

function recordIssue(
  db: Database,
  sourceKind: string,
  refKey: string,
  reason: string,
  now: number,
  byteLength: number | null,
): void {
  db.run(
    `INSERT INTO ingest_issue(source_kind,ref_key,reason,observed_at,byte_length) VALUES (?,?,?,?,?)
     ON CONFLICT(source_kind,ref_key,reason) DO UPDATE SET observed_at=excluded.observed_at, byte_length=excluded.byte_length`,
    [sourceKind, refKey, reason, now, byteLength],
  );
}

function upsertCursor(db: Database, sourceKind: string, sourceName: string, batch: FileBatch, now: number): void {
  db.run(
    `INSERT INTO source_cursor(source_kind,source_name,file_generation,committed_off,seen_size,head_len,head_hash,last_ok_ms,rewrite_epoch,observed_off)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(source_kind,source_name) DO UPDATE SET
       file_generation=excluded.file_generation,
       committed_off=CASE WHEN source_cursor.file_generation=excluded.file_generation AND source_cursor.rewrite_epoch=excluded.rewrite_epoch
         THEN MAX(source_cursor.committed_off,excluded.committed_off) ELSE excluded.committed_off END,
       seen_size=excluded.seen_size,
       head_len=excluded.head_len,
       head_hash=excluded.head_hash,
       last_ok_ms=excluded.last_ok_ms,
       rewrite_epoch=excluded.rewrite_epoch,
       observed_off=CASE WHEN source_cursor.file_generation=excluded.file_generation AND source_cursor.rewrite_epoch=excluded.rewrite_epoch
         THEN MAX(source_cursor.observed_off,excluded.observed_off) ELSE excluded.observed_off END`,
    [
      sourceKind,
      sourceName,
      batch.generation,
      batch.committedOff,
      batch.seenSize,
      batch.headLen,
      batch.headHash,
      now,
      batch.rewriteEpoch,
      batch.observedOff,
    ],
  );
}

/**
 * 暂停期间的一批读取结果。
 *
 * 只更新 observed_off 与缺口：committed_off 保持不动，下一轮仍从原位置重读，
 * 所以暂停期间的证据不会因为游标前移而永久漏掉；换代时由 resumeSourceGaps 判成不可补。
 */
export function resumePausedLedger(
  store: Store,
  sourceName: string,
  batch: FileBatch,
  now: number,
): { recorded: boolean; from_off: number; to_off: number; pendingLines: number } {
  return store.write(db => {
    const cursor = db.query<{ file_generation: string; committed_off: number }, [string, string]>(
      'SELECT file_generation, committed_off FROM source_cursor WHERE source_kind=? AND source_name=?',
    ).get('ledger', sourceName);
    const from = cursor !== null && cursor.file_generation === batch.generation
      ? cursor.committed_off
      : batch.committedOff;
    const gap = recordPausedBatchTx(db, {
      source_kind: 'ledger', source_name: sourceName, generation: batch.generation,
      from_off: from, to_off: batch.observedOff,
    }, now);
    if (from < batch.observedOff) {
      db.run(
        `UPDATE source_cursor SET observed_off=MAX(observed_off,?), seen_size=?
         WHERE source_kind=? AND source_name=? AND file_generation=?`,
        [batch.observedOff, batch.seenSize, 'ledger', sourceName, batch.generation],
      );
    }
    return { ...gap, pendingLines: batch.lines.length };
  });
}

type CurrentRequest = {
  req_id: number;
  conv_key: string | null;
  conv_source: string | null;
  session: string | null;
  agent: string | null;
  actor: string | null;
  actor_state: string;
  title: string | null;
  title_source: string | null;
  attempt_count: number | null;
  sort_source: string | null;
};

function currentRequest(db: Database, reqId: number): CurrentRequest {
  return db.query<CurrentRequest, [number]>(
    'SELECT req_id,conv_key,conv_source,session,agent,actor,actor_state,title,title_source,attempt_count,sort_source FROM request WHERE req_id=?',
  ).get(reqId)!;
}

function sessionConv(session: string | null, refKey: string): { key: string; source: string } {
  return session !== null
    ? { key: JSON.stringify(['session', session]), source: 'session' }
    : { key: JSON.stringify(['request', refKey]), source: 'request' };
}

function insertRequest(
  db: Database,
  fields: LedgerFields,
  refKey: string,
  now: number,
): number {
  const via = fields.source === 'rejected' ? 'rejected' : (fields.via ?? 'through');
  const conv = sessionConv(fields.session, refKey);
  const actor = fields.subagent ?? fields.session ?? null;
  const title = modelTimeTitle(fields.model ?? fields.served, fields.tMs);
  // 行级事实列由紧随其后的投影写入：这里传 NULL 而不是先拿这一行冒充最终尝试。
  // 排序键同理，只有投影证明顺序可证时才写。
  const result = db.run(
    `INSERT INTO request(
       route_id,response_id_norm,agent,session,conv_key,conv_source,actor,actor_state,subagent,parent_agent,
       started_ms,day,via,status,stop,model_requested,model_served,provider,
       in_tok,out_tok,cache_read,cache_write,reasoning,ms,ttft_ms,flow_ms,first_text_ms,
       body_state,derive_version,have,created_at,updated_at,title,title_source,cost_state,cost_reason,
       attempt_state,sort_source,sort_key,magpie_version,parse_state,reply_state
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      fields.routeId, fields.responseIdNorm, fields.agent, fields.session, conv.key, conv.source,
      actor, actor === null ? 'unknown' : 'known', fields.subagent, fields.parentAgent,
      fields.tMs, localDay(fields.tMs), via, null, null, null, null, null,
      null, null, null, null, null, null, null, null, null,
      'pending', 0, 2, now, now, title, 'model_time', 'absent', via === 'rejected' ? 'not_applicable' : null,
      'known', null, null, fields.magpieVersion, null, null,
    ],
  );
  return Number(result.lastInsertRowid);
}

function projectLedgerRequestTx(db: Database, reqId: number, now: number): RequestProjection {
  return projectRequestTx(db, reqId, { now, mappingVersion: SOURCE_PROJECTION_VERSION });
}

/**
 * 账本证据给出的身份、排序键与标题。
 *
 * 投影只写行级事实；归属与排序键涉及合并既有行与派生队列，仍在这里写。
 * 证据完整但顺序不可证时清空排序键，否则读模型会把任意一行的物理位置当成组内次序；
 * 证据不完整时保留旧键，由长期读模型标成非 current。
 */
function applyLedgerOwnershipTx(
  db: Database,
  reqId: number,
  fields: LedgerFields,
  projection: RequestProjection,
  now: number,
): void {
  const current = currentRequest(db, reqId);
  const identity = projection.identity;
  const session = identity.state === 'complete' ? identity.session : null;
  const subagent = identity.state === 'complete' ? identity.subagent : null;
  const actor = subagent ?? session ?? null;
  const conv = session !== null && (current.conv_source === 'request' || current.conv_source === null)
    ? { key: JSON.stringify(['session', session]), source: 'session' }
    : null;
  const started = identity.startedMs ?? fields.tMs;
  const clearSort = identity.orderState === 'unprovable';
  const setSort = identity.orderState === 'provable' && identity.sortKey !== null;
  const titleModel = projection.selected?.fields.model ?? projection.selected?.fields.served
    ?? fields.model ?? fields.served;
  const title = current.title === null || current.title_source === 'model_time'
    ? modelTimeTitle(titleModel, started)
    : current.title;
  db.run(
    `UPDATE request SET
       session=COALESCE(session,?), agent=COALESCE(agent,?), subagent=COALESCE(subagent,?), parent_agent=COALESCE(parent_agent,?),
       conv_key=COALESCE(?,conv_key), conv_source=COALESCE(?,conv_source),
       actor=CASE WHEN actor_state='known' THEN actor ELSE ? END,
       actor_state=CASE WHEN actor_state='known' THEN actor_state ELSE ? END,
       sort_source=CASE WHEN ?=1 THEN NULL WHEN ?=1 THEN 'ledger' ELSE sort_source END,
       sort_key=CASE WHEN ?=1 THEN NULL WHEN ?=1 THEN ? ELSE sort_key END,
       title=?, title_source=?, updated_at=?, have=have|2
     WHERE req_id=?`,
    [
      session, identity.agent, subagent, identity.parentAgent,
      conv?.key ?? null, conv?.source ?? null,
      actor, actor === null ? 'unknown' : 'known',
      clearSort ? 1 : 0, setSort ? 1 : 0, clearSort ? 1 : 0, setSort ? 1 : 0, identity.sortKey,
      title, current.title_source ?? 'model_time', now, reqId,
    ],
  );
  // 身份确认后，这一组要重算前驱、增量与标题；未知归属不入队。
  // 用本笔实际的 conv_key/actor 而不是局部变量：合并时 conv 可能来自既有行。
  const settled = db.query<{ conv_key: string | null; actor: string | null; actor_state: string }, [number]>(
    'SELECT conv_key, actor, actor_state FROM request WHERE req_id=?',
  ).get(reqId);
  if (settled?.conv_key != null && settled.actor !== null && settled.actor_state === 'known') {
    enqueueDeriveTx(db, settled.conv_key, settled.actor, '');
  }
}

function applyRouteToRequest(db: Database, reqId: number, route: RouteFields, now: number): void {
  const current = currentRequest(db, reqId);
  const conv = route.session !== null
    ? { key: JSON.stringify(['session', route.session]), source: 'session' }
    : route.conv !== null
      ? { key: JSON.stringify(['conv', route.conv]), source: 'conv' }
      : null;
  const convUpdate = conv !== null && (
    current.conv_source === 'request' ||
    current.conv_source === null ||
    (current.conv_source === 'conv' && route.session !== null)
  );
  const actor = route.subagentId ?? route.session ?? route.conv ?? null;
  const title = current.title === null
    ? modelTimeTitle(route.model ?? route.served, route.timeMs)
    : current.title;
  const parts = route.promptParts === null ? null : JSON.stringify(route.promptParts);
  db.run(
    `UPDATE request SET
       session=COALESCE(session,?), agent=COALESCE(agent,?),
       conv_key=?, conv_source=?,
       actor=CASE WHEN actor_state='known' THEN actor ELSE ? END,
       actor_state=CASE WHEN actor_state='known' THEN actor_state ELSE ? END,
       prompt_tokens=COALESCE(?,prompt_tokens), prompt_counted=COALESCE(?,prompt_counted),
       prompt_window=COALESCE(?,prompt_window), prompt_turns=COALESCE(?,prompt_turns),
       parts_json=COALESCE(?,parts_json), attempt_count=COALESCE(?,attempt_count),
       sort_source=COALESCE(sort_source,'route'), sort_key=COALESCE(sort_key,?),
       title=?, have=have|4, updated_at=?
     WHERE req_id=?`,
    [
      route.session, route.agent,
      convUpdate ? conv!.key : current.conv_key, convUpdate ? conv!.source : current.conv_source,
      actor, actor === null ? 'unknown' : 'known',
      route.promptTokens, route.promptCounted, route.promptWindow, route.promptTurns,
      parts, route.tries === null ? null : route.tries.length,
      String(route.routeId).padStart(20, '0'),
      title, now, reqId,
    ],
  );
  db.run(
    'INSERT OR IGNORE INTO request_evidence(req_id,source_kind,ref_key,merge_state,match_rule,added_at) VALUES (?,?,?,?,?,?)',
    [reqId, 'route', String(route.routeId), 'merged', null, now],
  );
}

function linkRouteIfPresent(db: Database, reqId: number, routeId: number, now: number): void {
  const raw = db.query<{ payload_json: string }, [number]>(
    'SELECT payload_json FROM raw_route WHERE route_id=?',
  ).get(routeId);
  if (raw == null) return;
  try {
    const parsed = JSON.parse(raw.payload_json) as unknown;
    if (!isRecord(parsed)) return;
    const route = mapRouteRow(parsed);
    if (route !== null) applyRouteToRequest(db, reqId, route, now);
  } catch {
    // A malformed raw route stays available for later repair; ledger fields are already applied.
  }
}

function mergeLedgerRow(
  db: Database,
  fields: LedgerFields,
  refKey: string,
  now: number,
): void {
  const via = fields.source === 'rejected' ? 'rejected' : (fields.via ?? 'through');
  const rejected = via === 'rejected';
  let reqId: number | null = null;
  if (!rejected && fields.routeId !== null) {
    const existing = db.query<{ req_id: number }, [number]>(
      "SELECT req_id FROM request WHERE route_id=? AND via!='rejected' ORDER BY req_id LIMIT 1",
    ).get(fields.routeId);
    if (existing != null) reqId = existing.req_id;
  }
  if (reqId === null) {
    reqId = insertRequest(db, fields, refKey, now);
  }
  db.run(
    'INSERT OR IGNORE INTO request_evidence(req_id,source_kind,ref_key,merge_state,match_rule,added_at) VALUES (?,?,?,?,?,?)',
    [reqId, 'ledger', refKey, 'merged', null, now],
  );
  if (!rejected && fields.routeId !== null) linkRouteIfPresent(db, reqId, fields.routeId, now);
  // 行级事实只由投影写；投影幂等，route 挂载前后各调一次不改变结果。
  const projection = projectLedgerRequestTx(db, reqId, now);
  applyLedgerOwnershipTx(db, reqId, fields, projection, now);
}

export function ingestLedger(
  store: Store,
  sourceName: string,
  batch: FileBatch,
  now: number,
  salt: Uint8Array,
): IngestLedgerResult {
  return store.write(db => {
    let accepted = 0;
    let invalid = 0;
    let duplicate = 0;
    let purged_skip = 0;
    for (const issue of batch.issues) {
      recordIssue(db, 'ledger', evidenceRef(batch.generation, issue.offset), issue.reason, now, issue.end - issue.offset);
      invalid += 1;
    }
    for (const line of batch.lines) {
      const refKey = evidenceRef(batch.generation, line.offset);
      const owned = db.query<{ req_id: number }, [string, string]>(
        'SELECT req_id FROM request_evidence WHERE source_kind=? AND ref_key=?',
      ).get('ledger', refKey);
      if (owned != null) {
        duplicate += 1;
        continue;
      }
      // 主动淘汰过的证据只留墓碑：来源再回放也不复活，计 purged_skip 而不是新证据。
      if (isPurgedEvidence(db, 'ledger', refKey)) {
        purged_skip += 1;
        continue;
      }
      if (line.text.trim() === '') {
        recordIssue(db, 'ledger', refKey, 'ledger_empty_line', now, line.end - line.offset);
        invalid += 1;
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line.text);
      } catch {
        recordIssue(db, 'ledger', refKey, 'ledger_invalid_json', now, line.end - line.offset);
        invalid += 1;
        continue;
      }
      if (!isRecord(parsed)) {
        recordIssue(db, 'ledger', refKey, 'ledger_invalid_object', now, line.end - line.offset);
        invalid += 1;
        continue;
      }
      // 脱敏先于映射：raw 列、payload 与投影都只来自同一个已脱敏对象，
      // 否则列与 payload 会各说一套，而 payload 的未脱敏副本会绕开脱敏边界。
      const redacted = redact(parsed, salt);
      if (!isRecord(redacted)) {
        recordIssue(db, 'ledger', refKey, 'ledger_invalid_redaction', now, line.end - line.offset);
        invalid += 1;
        continue;
      }
      const fields = mapLedgerRow(redacted);
      if (fields === null) {
        recordIssue(db, 'ledger', refKey, 'ledger_invalid_time', now, line.end - line.offset);
        invalid += 1;
        continue;
      }
      const payloadJson = JSON.stringify(redacted);
      const ref: LedgerPhysicalRef = { generation: batch.generation, offset: line.offset };
      if (!insertPreparedLedgerTx(db, ref, fields, payloadJson)) {
        duplicate += 1;
        continue;
      }
      mergeLedgerRow(db, fields, refKey, now);
      accepted += 1;
    }
    upsertCursor(db, 'ledger', sourceName, batch, now);
    // 本轮真正提交的区间若覆盖了此前的暂停缺口，就在这里关闭它；
    // 换代时旧代际的缺口一并判死，避免之后被当作可补区间重读。
    markStaleGapsTx(db, 'ledger', sourceName, now);
    closeSourceGapsTx(db, 'ledger', sourceName, batch.generation, 0, batch.committedOff, now);
    return { accepted, invalid, duplicate, purged_skip };
  });
}

const RAW_ROUTE_UPSERT = `INSERT INTO raw_route(
  route_id,time_ms,day,agent,session,conv,folder,subagent_id,kind,for_json,model,provider,served,effort,
  status,error,done,ms,ttft,first_text,flow,tokens,out_tok,reasoning,payload_json,magpie_version
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(route_id) DO UPDATE SET
  time_ms=excluded.time_ms,day=excluded.day,agent=excluded.agent,session=excluded.session,conv=excluded.conv,
  folder=excluded.folder,subagent_id=excluded.subagent_id,kind=excluded.kind,for_json=excluded.for_json,
  model=excluded.model,provider=excluded.provider,served=excluded.served,effort=excluded.effort,
  status=excluded.status,error=excluded.error,done=excluded.done,ms=excluded.ms,ttft=excluded.ttft,
  first_text=excluded.first_text,flow=excluded.flow,tokens=excluded.tokens,out_tok=excluded.out_tok,
  reasoning=excluded.reasoning,payload_json=excluded.payload_json,magpie_version=excluded.magpie_version`;

function saveRouteSummary(db: Database, route: RouteFields, now: number, redactedError: string | null): void {
  const summary = {
    route_id: route.routeId,
    time_ms: route.timeMs,
    day: route.day,
    model: route.model,
    served: route.served,
    provider: route.provider,
    status: route.status,
    ms: route.ms,
    ttft: route.ttft,
    flow: route.flow,
    first_text: route.firstText,
    order: route.order,
    tries: route.tries,
    affinity: route.affinity,
    error: redactedError,
    saved_at: now,
  };
  const z = zstdCompressSync(Buffer.from(JSON.stringify(summary)), {
    params: { [constants.ZSTD_c_compressionLevel]: 3 },
  });
  db.run(
    `INSERT INTO route_summary(route_id,time_ms,model,served,provider,status,ms,ttft,flow,first_text,order_json,tries_json,affinity_json,z)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(route_id) DO UPDATE SET
       time_ms=excluded.time_ms,model=excluded.model,served=excluded.served,provider=excluded.provider,
       status=excluded.status,ms=excluded.ms,ttft=excluded.ttft,flow=excluded.flow,first_text=excluded.first_text,
       order_json=excluded.order_json,tries_json=excluded.tries_json,affinity_json=excluded.affinity_json,z=excluded.z`,
    [
      route.routeId, route.timeMs, route.model, route.served, route.provider, route.status,
      route.ms, route.ttft, route.flow, route.firstText,
      route.order === null ? null : JSON.stringify(route.order),
      route.tries === null ? null : JSON.stringify(route.tries),
      route.affinity === null ? null : JSON.stringify(route.affinity),
      z,
    ],
  );
}

export function ingestRoute(store: Store, records: unknown[], now: number, salt: Uint8Array): void {
  store.write(db => {
    const seen = new Set<number>();
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      if (!isRecord(record)) {
        recordIssue(db, 'route', JSON.stringify(['route-invalid', index]), 'route_invalid_object', now, null);
        continue;
      }
      const route = mapRouteRow(record);
      if (route === null) {
        const id = optionalNumber(record, 'id') ?? optionalNumber(record, 'route_id');
        recordIssue(db, 'route', JSON.stringify(['route-invalid', id ?? index]), 'route_invalid_identity', now, null);
        continue;
      }
      if (seen.has(route.routeId)) continue;
      seen.add(route.routeId);
      const redacted = redact(record, salt);
      const redactedError = isRecord(redacted) && typeof redacted.error === 'string' ? redacted.error : route.error;
      db.run(RAW_ROUTE_UPSERT, [
        route.routeId, route.timeMs, route.day, route.agent, route.session, route.conv, route.folder,
        route.subagentId, route.kind, route.forJson, route.model, route.provider, route.served, route.effort,
        route.status, redactedError, route.done, route.ms, route.ttft, route.firstText, route.flow,
        route.tokens, route.outTok, route.reasoning, JSON.stringify(redacted), route.magpieVersion,
      ]);
      saveRouteSummary(db, route, now, redactedError);
      const existing = db.query<{ req_id: number }, [number]>(
        "SELECT req_id FROM request WHERE route_id=? AND via!='rejected' ORDER BY req_id LIMIT 1",
      ).get(route.routeId);
      if (existing != null) applyRouteToRequest(db, existing.req_id, route, now);
    }
  });
}
