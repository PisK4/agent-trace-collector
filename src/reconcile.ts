import { constants, zstdCompressSync } from 'node:zlib';
import type { Database } from 'bun:sqlite';
import type { Store } from './store';
import type { FileBatch, SourceCursor, SourceIssue, SourceRead } from './sources/files';
import { redact } from './privacy';
import {
  isRecord,
  mapLedgerRow,
  mapRouteRow,
  optionalNumber,
} from './sources/magpie';
import { localDay, modelTimeTitle } from './format';
import type { LedgerFields, RouteFields } from './sources/magpie';
import { insertPreparedLedgerTx, isPurgedEvidence, upsertPreparedRouteTx } from './sources/raw';
import type { LedgerPhysicalRef } from './sources/raw';
import { SOURCE_PROJECTION_VERSION, projectRequestTx, projectionSignature, readProjectionTx } from './sources/projection';
import { markOwnershipChangeTx, markRequestInputTx, requestGroupTx } from './derive-state';
import type { RequestProjection } from './sources/projection';
import { closeSourceGapsTx, markStaleGapsTx, recordPausedBatchTx } from './retention';
import { HAVE_LEDGER, HAVE_ROUTE, insertEvidenceTx, ledgerConv, routeConv, sessionRef } from './evidence';

/** 一次来源摄入的计数。账本与路由共用同一组字段，便于调用方统一记录。 */
export type SourceIngestResult = {
  accepted: number; invalid: number; duplicate: number; purged_skip: number;
};

function evidenceRef(generation: string, offset: number): string {
  return JSON.stringify(['file', generation, offset]);
}

type CursorRow = {
  source_kind: SourceCursor['sourceKind']; source_name: string; file_generation: string;
  committed_off: number; observed_off: number; seen_size: number | null;
  head_len: number | null; head_hash: string | null; fingerprint: string | null;
  rewrite_epoch: number;
};

const CURSOR_COLUMNS = `source_kind, source_name, file_generation, committed_off, observed_off,
  seen_size, head_len, head_hash, fingerprint, rewrite_epoch`;

function cursorFromRow(row: CursorRow): SourceCursor {
  return {
    sourceKind: row.source_kind,
    name: row.source_name,
    generation: row.file_generation,
    rewriteEpoch: row.rewrite_epoch,
    committedOff: row.committed_off,
    observedOff: row.observed_off,
    seenSize: row.seen_size ?? 0,
    headLen: row.head_len ?? 0,
    headHash: row.head_hash,
    fingerprint: row.fingerprint,
  };
}

/** 读一个来源的游标；没有就返回 null。调用方据此决定从哪里续读。 */
export function readFileCursor(store: Store, sourceKind: string, sourceName: string): SourceCursor | null {
  const row = store.read.query<CursorRow, [string, string]>(
    `SELECT ${CURSOR_COLUMNS} FROM source_cursor WHERE source_kind=? AND source_name=?`,
  ).get(sourceKind, sourceName);
  return row == null ? null : cursorFromRow(row);
}

/** 只推进 observed_off：提交位置不动，下一轮仍从 committed_off 重读，证据不会漏。 */
export function observeSourceOffset(store: Store, sourceKind: string, sourceName: string,
  observedOff: number): void {
  store.write(db => db.run(
    'UPDATE source_cursor SET observed_off=MAX(observed_off,?) WHERE source_kind=? AND source_name=?',
    [observedOff, sourceKind, sourceName],
  ));
}

/** 路由来源的游标：`.jsonl` 用身份与偏移，`.gz` 用整份指纹，形状同为 SourceCursor。 */
export function readRouteCursors(store: Store): Map<string, SourceCursor> {
  return new Map(
    store.read.query<CursorRow, []>(
      `SELECT ${CURSOR_COLUMNS} FROM source_cursor WHERE source_kind IN ('route_file','route_gz')`,
    ).all().map(row => [row.source_name, cursorFromRow(row)]),
  );
}

/**
 * 坏行引用键的形态差异。
 *
 * 可追加文件按批次起点编号，同一文件的不同批次不互相覆盖；封口 gz 按整份
 * 指纹编号，重读同一份内容命中同一行 issue。除了引用基址与游标字段，两种
 * 形态的摄入路径相同。
 */
type SourceAdapter = {
  routeRecordIssueRef(read: SourceRead, value: number): string;
  routeParseIssueRef(read: SourceRead, slot: number): string;
  routeLineIssueRef(read: SourceRead, issue: SourceIssue): string;
};

function appendableRefBase(read: SourceRead): string {
  return `${read.generation}:${read.startOff}`;
}

function sealedRefBase(read: SourceRead): string {
  return read.fingerprint ?? read.generation;
}

const APPENDABLE_ADAPTER: SourceAdapter = {
  routeRecordIssueRef: (read, value) =>
    JSON.stringify(['route-invalid', appendableRefBase(read), value]),
  routeParseIssueRef: (read, slot) =>
    JSON.stringify([read.name, appendableRefBase(read), slot]),
  routeLineIssueRef: (read, issue) =>
    JSON.stringify([read.name, appendableRefBase(read), issue.offset]),
};

const SEALED_ADAPTER: SourceAdapter = {
  routeRecordIssueRef: (read, value) =>
    JSON.stringify(['route-invalid', sealedRefBase(read), value]),
  routeParseIssueRef: (read, slot) =>
    JSON.stringify([read.name, sealedRefBase(read), slot]),
  routeLineIssueRef: (read, issue) =>
    JSON.stringify([read.name, sealedRefBase(read), issue.offset]),
};

/**
 * 一个已解码来源的完整摄入：坏行记账、证据写入、游标推进在同一个事务里。
 *
 * 失败直接抛出，由 SQLite 整笔回滚。坏行也随事务回滚，但这无损：游标没有
 * 前进，下一轮仍读同一批内容，坏行会被重新记一次；证据写入按物理身份或
 * route_id 幂等，重放不会重复。
 *
 * 只有 decoded 能进这里；unchanged 与 error 由读取器表达，调用方不得推进游标。
 */
export function ingestSource(
  store: Store,
  read: SourceRead,
  salt: Uint8Array,
  now: number,
): SourceIngestResult {
  if (read.state !== 'decoded') throw new Error(`source_not_decoded:${read.state}`);
  const adapter = read.mode === 'appendable' ? APPENDABLE_ADAPTER : SEALED_ADAPTER;
  return store.write(db => {
    const result = read.sourceKind === 'ledger'
      ? ingestLedgerRowsTx(db, read, salt, now)
      : ingestRouteFileTx(db, read, salt, now, adapter);
    upsertSourceCursorTx(db, read, now);
    if (read.sourceKind === 'ledger') {
      // 本轮提交的区间若覆盖了此前的暂停缺口，就在这里关闭它；
      // 换代时旧代际的缺口一并判死，避免之后被当作可补区间重读。
      markStaleGapsTx(db, 'ledger', read.name, now);
      closeSourceGapsTx(db, 'ledger', read.name, read.generation, 0, read.committedOff, now);
    }
    return result;
  }, read.sourceKind === 'ledger' ? 'ledger' : 'route');
}

/** 一个路由文件批次的记录级摄入；调用方负责把它放进已有事务。 */
function ingestRouteFileTx(
  db: Database,
  read: SourceRead,
  salt: Uint8Array,
  now: number,
  adapter: SourceAdapter,
): SourceIngestResult {
  let invalid = 0;
  for (const issue of read.issues) {
    recordIssue(db, 'route', adapter.routeLineIssueRef(read, issue),
      'route_line_too_large', now, issue.end - issue.offset);
    invalid += 1;
  }
  const records: unknown[] = [];
  for (let index = 0; index < read.lines.length; index++) {
    const line = read.lines[index]!;
    if (line.text.trim() === '') continue;
    try {
      records.push(JSON.parse(line.text));
    } catch {
      recordIssue(db, 'route', adapter.routeParseIssueRef(read, index),
        'route_invalid_json', now, Buffer.byteLength(line.text));
      invalid += 1;
    }
  }
  const result = ingestRouteRecordsTx(db, records, now, salt,
    value => adapter.routeRecordIssueRef(read, value));
  return {
    accepted: result.accepted,
    invalid: invalid + result.invalid,
    duplicate: result.duplicate,
    purged_skip: 0,
  };
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

/**
 * 写回一个来源的游标。账本与两种路由文件共用这一处。
 *
 * committed_off 与 observed_off 只在文件代际与 rewrite_epoch 都没变时取 MAX，
 * 防止并发或迟到的读把游标拉回去；代际或重写计数变了说明已经是另一份内容，
 * 旧偏移不限制新游标。封口 gz 的代际就是整份指纹，换代即重读。
 */
function upsertSourceCursorTx(db: Database, cursor: SourceCursor, now: number): void {
  db.run(
    `INSERT INTO source_cursor(source_kind,source_name,file_generation,committed_off,seen_size,head_len,head_hash,fingerprint,last_ok_ms,rewrite_epoch,observed_off)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(source_kind,source_name) DO UPDATE SET
       file_generation=excluded.file_generation,
       committed_off=CASE WHEN source_cursor.file_generation=excluded.file_generation AND source_cursor.rewrite_epoch=excluded.rewrite_epoch
         THEN MAX(source_cursor.committed_off,excluded.committed_off) ELSE excluded.committed_off END,
       seen_size=excluded.seen_size,
       head_len=excluded.head_len,
       head_hash=excluded.head_hash,
       fingerprint=excluded.fingerprint,
       last_ok_ms=excluded.last_ok_ms,
       rewrite_epoch=excluded.rewrite_epoch,
       observed_off=CASE WHEN source_cursor.file_generation=excluded.file_generation AND source_cursor.rewrite_epoch=excluded.rewrite_epoch
         THEN MAX(source_cursor.observed_off,excluded.observed_off) ELSE excluded.observed_off END`,
    [
      cursor.sourceKind, cursor.name, cursor.generation, cursor.committedOff,
      cursor.seenSize, cursor.headLen, cursor.headHash, cursor.fingerprint,
      now, cursor.rewriteEpoch, cursor.observedOff,
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

function insertRequest(
  db: Database,
  fields: LedgerFields,
  refKey: string,
  now: number,
): number {
  const via = fields.source === 'rejected' ? 'rejected' : (fields.via ?? 'through');
  const conv = ledgerConv(fields.session, refKey);
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

/**
 * 写投影，并且只在派生输入真的变了时推进请求修订。
 *
 * 基线必须由调用方在本批证据写入**之前**取：投影是幂等的，写完再读只会读到
 * 已包含新证据的结果，永远看不出差异。新建的请求没有基线，一律算输入变化。
 */
function projectLedgerRequestTx(
  db: Database,
  reqId: number,
  now: number,
  before: string | null,
): RequestProjection {
  const projection = projectRequestTx(db, reqId, { now, mappingVersion: SOURCE_PROJECTION_VERSION });
  if (before === null || projectionSignature(projection) !== before) markRequestInputTx(db, reqId);
  return projection;
}

/** 本批写入前的投影签名；请求还不存在时返回 null。 */
function projectionBaselineTx(db: Database, reqId: number): string | null {
  const exists = db.query('SELECT 1 AS hit FROM request WHERE req_id=?').get(reqId);
  if (exists === null) return null;
  return projectionSignature(readProjectionTx(db, reqId, SOURCE_PROJECTION_VERSION));
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
  const beforeGroup = requestGroupTx(db, reqId);
  const identity = projection.identity;
  const session = identity.state === 'complete' ? identity.session : null;
  const subagent = identity.state === 'complete' ? identity.subagent : null;
  const actor = subagent ?? session ?? null;
  const conv = session !== null && (current.conv_source === 'request' || current.conv_source === null)
    ? sessionRef(session)
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
       title=?, title_source=?, updated_at=?, have=have|${HAVE_LEDGER}
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
  // 归属发生迁移时旧组也少了一个成员，两边都得重算。
  markOwnershipChangeTx(db, reqId, beforeGroup);
}

function attachRouteEvidenceTx(db: Database, reqId: number, routeId: number, now: number): void {
  insertEvidenceTx(db, reqId, 'route', String(routeId), 'merged', null, now);
}

/**
 * 路由证据给出的会话归属、actor 与标题。
 *
 * Prompt 列不在这里写：它由投影按"最新一条 route"决定，与到达顺序无关。
 */
function applyRouteOwnershipTx(db: Database, reqId: number, route: RouteFields, now: number): void {
  const current = currentRequest(db, reqId);
  const conv = routeConv(route.session, route.conv);
  const convUpdate = conv !== null && (
    current.conv_source === 'request' ||
    current.conv_source === null ||
    (current.conv_source === 'conv' && route.session !== null)
  );
  const actor = route.subagentId ?? route.session ?? route.conv ?? null;
  const title = current.title === null ? modelTimeTitle(route.model ?? route.served, route.timeMs) : current.title;
  db.run(
    `UPDATE request SET
       session=COALESCE(session,?), agent=COALESCE(agent,?),
       conv_key=?, conv_source=?,
       actor=CASE WHEN actor_state='known' THEN actor ELSE ? END,
       actor_state=CASE WHEN actor_state='known' THEN actor_state ELSE ? END,
       sort_source=COALESCE(sort_source,'route'), sort_key=COALESCE(sort_key,?),
       title=?, have=have|${HAVE_ROUTE}, updated_at=?
     WHERE req_id=?`,
    [
      route.session, route.agent,
      convUpdate ? conv!.key : current.conv_key, convUpdate ? conv!.source : current.conv_source,
      actor, actor === null ? 'unknown' : 'known',
      String(route.routeId).padStart(20, '0'), title, now, reqId,
    ],
  );
}

function applyRouteToRequest(
  db: Database,
  reqId: number,
  route: RouteFields,
  now: number,
  baseline: string | null = projectionBaselineTx(db, reqId),
): void {
  const beforeGroup = requestGroupTx(db, reqId);
  attachRouteEvidenceTx(db, reqId, route.routeId, now);
  applyRouteOwnershipTx(db, reqId, route, now);
  // 归属可能由 request/conv 升到 session：旧组要重算，新组要收进这一笔。
  markOwnershipChangeTx(db, reqId, beforeGroup);
  projectLedgerRequestTx(db, reqId, now, baseline);
}

function linkRouteIfPresent(
  db: Database,
  reqId: number,
  routeId: number,
  now: number,
  baseline: string | null,
): void {
  const raw = db.query<{ payload_json: string }, [number]>(
    'SELECT payload_json FROM raw_route WHERE route_id=?',
  ).get(routeId);
  if (raw == null) return;
  try {
    const parsed = JSON.parse(raw.payload_json) as unknown;
    if (!isRecord(parsed)) return;
    const route = mapRouteRow(parsed);
    if (route !== null) applyRouteToRequest(db, reqId, route, now, baseline);
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
  // 基线必须在本次证据写入之前取：写完再读只会读到已含新证据的结果。
  const baseline = projectionBaselineTx(db, reqId);
  insertEvidenceTx(db, reqId, 'ledger', refKey, 'merged', null, now);
  if (!rejected && fields.routeId !== null) linkRouteIfPresent(db, reqId, fields.routeId, now, baseline);
  // 行级事实只由投影写；投影幂等，route 挂载前后各调一次不改变结果。
  const projection = projectLedgerRequestTx(db, reqId, now, baseline);
  applyLedgerOwnershipTx(db, reqId, fields, projection, now);
}

/** 账本记录级摄入；调用方负责把它放进已有事务。 */
function ingestLedgerRowsTx(
  db: Database,
  read: SourceRead,
  salt: Uint8Array,
  now: number,
): SourceIngestResult {
  let accepted = 0;
  let invalid = 0;
  let duplicate = 0;
  let purged_skip = 0;
  for (const issue of read.issues) {
    recordIssue(db, 'ledger', evidenceRef(read.generation, issue.offset), issue.reason, now, issue.end - issue.offset);
    invalid += 1;
  }
  for (const line of read.lines) {
    const refKey = evidenceRef(read.generation, line.offset);
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
    const ref: LedgerPhysicalRef = { generation: read.generation, offset: line.offset };
    if (!insertPreparedLedgerTx(db, ref, fields, payloadJson)) {
      duplicate += 1;
      continue;
    }
    mergeLedgerRow(db, fields, refKey, now);
    accepted += 1;
  }
  return { accepted, invalid, duplicate, purged_skip };
}

function saveRouteSummary(db: Database, route: RouteFields, now: number): void {
  // format 2 只补充展示字段；身份与读数仍以列为准。prompt 家族在来源侧
  // 缺失或非法时 tokens 为 null，这里保持 null，不补一份不完整的形状。
  const prompt = route.promptTokens === null ? null : {
    tokens: route.promptTokens,
    counted: route.promptCounted === 1,
    window: route.promptWindow,
    held: null,
    parts: Array.isArray(route.promptParts) ? route.promptParts : [],
  };
  const summary = {
    format: 2,
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
    kind: route.kind,
    folder: route.folder,
    effort: route.effort,
    prompt,
    order: route.order,
    tries: route.tries,
    affinity: route.affinity,
    error: route.error,
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

/** 路由记录级摄入；调用方负责把它放进已有事务。 */
function ingestRouteRecordsTx(
  db: Database,
  records: unknown[],
  now: number,
  salt: Uint8Array,
  issueKey: (value: number) => string,
): SourceIngestResult {
  let accepted = 0;
  let invalid = 0;
  let duplicate = 0;
  const seen = new Set<number>();
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!isRecord(record)) {
      recordIssue(db, 'route', issueKey(index), 'route_invalid_object', now, null);
      invalid += 1;
      continue;
    }
    // 与账本同一条规则：raw 列、payload 与长期摘要都来自同一个已脱敏对象。
    const redacted = redact(record, salt);
    if (!isRecord(redacted)) {
      recordIssue(db, 'route', issueKey(index), 'route_invalid_redaction', now, null);
      invalid += 1;
      continue;
    }
    const route = mapRouteRow(redacted);
    if (route === null) {
      const id = optionalNumber(redacted, 'id') ?? optionalNumber(redacted, 'route_id');
      recordIssue(db, 'route', issueKey(id ?? index), 'route_invalid_identity', now, null);
      invalid += 1;
      continue;
    }
    if (seen.has(route.routeId)) {
      duplicate += 1;
      continue;
    }
    seen.add(route.routeId);
    const existing = db.query<{ req_id: number }, [number]>(
      "SELECT req_id FROM request WHERE route_id=? AND via!='rejected' ORDER BY req_id LIMIT 1",
    ).get(route.routeId);
    // 基线要在写入 raw 行之前取：投影读的是 raw payload，写完之后再读就永远相同。
    const baseline = existing === null ? null : projectionBaselineTx(db, existing.req_id);
    upsertPreparedRouteTx(db, route, JSON.stringify(redacted));
    saveRouteSummary(db, route, now);
    if (existing != null) applyRouteToRequest(db, existing.req_id, route, now, baseline);
    accepted += 1;
  }
  return { accepted, invalid, duplicate, purged_skip: 0 };
}
