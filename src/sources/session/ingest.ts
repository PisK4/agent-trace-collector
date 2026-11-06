/**
 * 会话来源的共用摄入：原始层、逐调用 request 行、正文、证据与游标。
 *
 * 与 droid 路径同一组不变量：
 * - 一行/一条物化记录最多一笔调用；证据 ref_key 幂等。
 * - 追加文件的解析状态从本代际 raw_session_event 按偏移重放，批次间不靠内存。
 * - 坏行记 issue 且游标停在坏行起点。
 * - 正文先脱敏再落库；已有 hook 正文不被会话正文覆盖。
 * - 认领既有行只补空字段与缺失用量，不覆盖别处已经写下的事实。
 */

import type { Database } from 'bun:sqlite';
import type { Store } from '../../store';
import { PRIVACY_TRANSFORM_VERSION, redact } from '../../privacy';
import {
  HAVE_BODY, HAVE_SESSION, MATCH_ABSENT, MATCH_AMBIGUOUS, insertEvidenceTx,
} from '../../evidence';
import { localDay, modelTimeTitle } from '../../format';
import { persistBodyTx } from '../../body';
import type { BodyPrefix } from '../../body';
import { findRequestOwnerTx } from '../../owner';
import { markRequestInputTx } from '../../derive/state';
import { emptySourceFacts, readSourceFacts, serializeFacts } from '../facts';
import type { SourceRead } from '../files';
import { observeSourceOffset, readFileCursor, recordIssue, upsertSourceCursorTx } from '../../reconcile';
import type { SessionAdapter, SessionCall, SessionFile, SessionParseResult } from './types';

export type SessionIngestResult = {
  files: number;
  calls: number;
  merged: number;
  duplicates: number;
  refreshed: number;
  invalid: number;
  blocked: number;
  sideEffects: number;
  bytes: number;
  /** 封口文件本次分块后还剩多少解压字节；0 表示这个文件已读完。 */
  remaining: number;
};

export function emptySessionIngestResult(): SessionIngestResult {
  return {
    files: 0, calls: 0, merged: 0, duplicates: 0, refreshed: 0,
    invalid: 0, blocked: 0, sideEffects: 0, bytes: 0, remaining: 0,
  };
}

function evidenceRef(call: SessionCall): string {
  return `${call.sessionId}/${call.callId}`;
}

/** 会话文件来源的长期事实：用量口径、思考档位与工作目录。 */
function sourceFactsJson(existing: string | null, call: SessionCall): string {
  const facts = readSourceFacts(existing) ?? emptySourceFacts();
  const previous = facts.session;
  facts.session = {
    usageScope: 'session',
    reasoningEffort: call.reasoningEffort ?? previous?.reasoningEffort ?? null,
    cwd: call.cwd ?? previous?.cwd ?? null,
  };
  return serializeFacts(facts);
}

/** 协议形状决定正文的键与回复包装；调用方不再各写一份。 */
function bodyOf(adapter: SessionAdapter, call: SessionCall): {
  protocol: string; request: unknown; reply: unknown;
} {
  const reply = adapter.bodyProtocol === 'responses'
    ? { output: call.replyContent }
    : adapter.bodyProtocol === 'chat'
      ? { choices: [{ message: { role: 'assistant', content: call.replyContent } }] }
      : { role: 'assistant', content: call.replyContent };
  const request = adapter.bodyProtocol === 'responses'
    ? { input: call.requestMessages }
    : { messages: call.requestMessages };
  return { protocol: adapter.bodyProtocol, request, reply };
}

function persistSessionBodyTx(
  db: Database,
  reqId: number,
  adapter: SessionAdapter,
  call: SessionCall,
  prefix?: BodyPrefix,
): void {
  persistBodyTx(db, reqId, {
    ...bodyOf(adapter, call),
    redact_version: PRIVACY_TRANSFORM_VERSION,
  }, prefix);
}

function insertSessionRequestTx(
  db: Database,
  adapter: SessionAdapter,
  call: SessionCall,
  generation: string,
  offset: number,
  now: number,
): number {
  const title = modelTimeTitle(call.model, call.startedMs);
  const convSource = `${adapter.agent}-session`;
  // 可读完成时间的来源把时长一并落库：本地行重放与事后复核都靠它还原结束时刻。
  const duration = call.endedMs === undefined || call.endedMs === null
    ? null
    : Math.max(0, Math.round(call.endedMs - call.startedMs));
  const inserted = db.run(
    `INSERT INTO request(
       response_id_norm,agent,session,conv_key,conv_source,actor,actor_state,subagent,parent_agent,
       turn_ref,started_ms,day,via,status,stop,model_requested,model_served,provider,
       in_tok,out_tok,cache_read,cache_write,reasoning,ms,
       body_state,derive_version,have,created_at,updated_at,title,title_source,cost_state,
       attempt_state,sort_source,sort_key,source_facts_json
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      call.responseIdNorm, adapter.agent, call.sessionId, call.convKey, convSource,
      call.subagentId ?? call.sessionId, 'known', call.subagentId, call.parentSessionId,
      call.turnRef, call.startedMs, localDay(call.startedMs), 'session', null, null,
      call.model, null, null,
      call.usage?.input ?? null, call.usage?.output ?? null,
      call.usage?.cacheRead ?? null, call.usage?.cacheWrite ?? null, call.reasoning, duration,
      'pending', 0, HAVE_SESSION, now, now, title, 'model_time', 'absent',
      adapter.attemptState ?? 'known', adapter.sortSource,
      `${generation}|${String(offset).padStart(20, '0')}`,
      sourceFactsJson(null, call),
    ],
  );
  return Number(inserted.lastInsertRowid);
}

type OwnerRow = {
  have: number; actor: string | null; actor_state: string;
  skeleton_z: Uint8Array | null; body_state: string; source_facts_json: string | null;
};

/**
 * 认领既有行：只补空字段。用量按段补空：网关先到、会话后到的方向也要能补上。
 */
function mergeIntoOwnerTx(
  db: Database,
  adapter: SessionAdapter,
  ownerId: number,
  call: SessionCall,
  refKey: string,
  rule: string,
  generation: string,
  offset: number,
  now: number,
): void {
  const current = db.query<OwnerRow, [number]>(
    'SELECT have,actor,actor_state,skeleton_z,body_state,source_facts_json FROM request WHERE req_id=?',
  ).get(ownerId);
  if (current === null) return;
  const title = modelTimeTitle(call.model, call.startedMs);
  const convSource = `${adapter.agent}-session`;
  db.run(
    `UPDATE request SET
       session=COALESCE(session,?), conv_key=COALESCE(conv_key,?), conv_source=COALESCE(conv_source,?),
       actor=COALESCE(actor,?),
       actor_state=CASE WHEN actor_state='known' THEN 'known' WHEN actor IS NULL THEN 'known' ELSE actor_state END,
       subagent=COALESCE(subagent,?), parent_agent=COALESCE(parent_agent,?),
       response_id_norm=COALESCE(response_id_norm,?), turn_ref=COALESCE(turn_ref,?),
       model_requested=COALESCE(model_requested,?),
       in_tok=COALESCE(in_tok,?), out_tok=COALESCE(out_tok,?),
       cache_read=COALESCE(cache_read,?), cache_write=COALESCE(cache_write,?), reasoning=COALESCE(reasoning,?),
       title=COALESCE(title,?), sort_source=COALESCE(sort_source,?), sort_key=COALESCE(sort_key,?),
       source_facts_json=?, have=have|${HAVE_SESSION}, updated_at=?
     WHERE req_id=?`,
    [
      call.sessionId, call.convKey, convSource,
      call.subagentId ?? call.sessionId, call.subagentId, call.parentSessionId,
      call.responseIdNorm, call.turnRef, call.model,
      call.usage?.input ?? null, call.usage?.output ?? null,
      call.usage?.cacheRead ?? null, call.usage?.cacheWrite ?? null, call.reasoning,
      title, adapter.sortSource, `${generation}|${String(offset).padStart(20, '0')}`,
      sourceFactsJson(current.source_facts_json, call), now, ownerId,
    ],
  );
  insertEvidenceTx(db, ownerId, adapter.evidenceKind, refKey, 'merged', rule, now);
  if (current.skeleton_z === null && current.body_state !== 'evicted') {
    persistSessionBodyTx(db, ownerId, adapter, call);
    db.run('UPDATE request SET miss_reason=NULL WHERE req_id=?', [ownerId]);
  }
  markRequestInputTx(db, ownerId);
}

/**
 * 可原地更新的来源（SQLite 物化行）在同一 ref 上拿到新 payload 时的刷新。
 *
 * 只补空字段；正文只在没有 hook 正文且未被回收时重写。已有网关事实不覆盖。
 */
function refreshSessionCallTx(
  db: Database,
  adapter: SessionAdapter,
  ownerId: number,
  call: SessionCall,
  generation: string,
  offset: number,
  now: number,
): void {
  const current = db.query<OwnerRow, [number]>(
    'SELECT have,actor,actor_state,skeleton_z,body_state,source_facts_json FROM request WHERE req_id=?',
  ).get(ownerId);
  if (current === null) return;
  db.run(
    `UPDATE request SET
       session=COALESCE(session,?), conv_key=COALESCE(conv_key,?), conv_source=COALESCE(conv_source,?),
       actor=COALESCE(actor,?),
       actor_state=CASE WHEN actor_state='known' THEN 'known' WHEN actor IS NULL THEN 'known' ELSE actor_state END,
       subagent=COALESCE(subagent,?), parent_agent=COALESCE(parent_agent,?),
       response_id_norm=COALESCE(response_id_norm,?), turn_ref=COALESCE(turn_ref,?),
       model_requested=COALESCE(model_requested,?),
       in_tok=COALESCE(in_tok,?), out_tok=COALESCE(out_tok,?),
       cache_read=COALESCE(cache_read,?), cache_write=COALESCE(cache_write,?), reasoning=COALESCE(reasoning,?),
       sort_source=COALESCE(sort_source,?), sort_key=COALESCE(sort_key,?),
       source_facts_json=?, updated_at=?
     WHERE req_id=?`,
    [
      call.sessionId, call.convKey, `${adapter.agent}-session`,
      call.subagentId ?? call.sessionId, call.subagentId, call.parentSessionId,
      call.responseIdNorm, call.turnRef, call.model,
      call.usage?.input ?? null, call.usage?.output ?? null,
      call.usage?.cacheRead ?? null, call.usage?.cacheWrite ?? null, call.reasoning,
      adapter.sortSource, `${generation}|${String(offset).padStart(20, '0')}`,
      sourceFactsJson(current.source_facts_json, call), now, ownerId,
    ],
  );
  if ((current.have & HAVE_BODY) === 0 && current.body_state !== 'evicted') {
    persistSessionBodyTx(db, ownerId, adapter, call);
    db.run('UPDATE request SET miss_reason=NULL WHERE req_id=?', [ownerId]);
  }
  markRequestInputTx(db, ownerId);
}

function ingestCallTx(
  db: Database,
  adapter: SessionAdapter,
  call: SessionCall,
  generation: string,
  offset: number,
  now: number,
  prefix?: BodyPrefix,
): number | 'merged' {
  const owner = findRequestOwnerTx(db, {
    responseIdNorm: call.responseIdNorm,
    turnRef: call.turnRef,
    convKey: call.convKey,
    agent: adapter.agent,
    startedMs: call.startedMs,
    endMs: call.endedMs ?? null,
    model: call.model,
    usage: call.usage,
    excludeSourceKind: adapter.evidenceKind,
  });
  const refKey = evidenceRef(call);
  if (owner.reqId !== null) {
    mergeIntoOwnerTx(db, adapter, owner.reqId, call, refKey, owner.rule ?? MATCH_AMBIGUOUS,
      generation, offset, now);
    return 'merged';
  }
  const reqId = insertSessionRequestTx(db, adapter, call, generation, offset, now);
  insertEvidenceTx(db, reqId, adapter.evidenceKind, refKey, 'merged',
    owner.outcome === 'ambiguous' ? MATCH_AMBIGUOUS : MATCH_ABSENT, now);
  persistSessionBodyTx(db, reqId, adapter, call, prefix);
  return reqId;
}

/** 脱敏后的整行原文：对象按脱敏后的 JSON 存，无法解析的行按字符串替换敏感片段。 */
function sanitizedPayload(
  text: string,
  parsed: SessionParseResult,
  salt: Uint8Array,
  parse: (value: string) => SessionParseResult,
): { payloadJson: string; parsed: SessionParseResult } {
  if (parsed.kind === 'ignore') return { payloadJson: '', parsed };
  if (parsed.kind === 'invalid') {
    return { payloadJson: JSON.stringify(redact(text, salt)), parsed };
  }
  const payloadJson = JSON.stringify(redact(JSON.parse(text), salt));
  return { payloadJson, parsed: parse(payloadJson) };
}

/** 一个会话流的一批摄入。读取在事务外，原始层、证据、正文与游标在同一事务内提交。 */
export async function ingestSessionFile(
  store: Store,
  adapter: SessionAdapter,
  file: SessionFile,
  salt: Uint8Array,
  now: number,
): Promise<SessionIngestResult> {
  const result = emptySessionIngestResult();
  const cursor = readFileCursor(store, adapter.sourceKind, file.name);
  let read: SourceRead;
  try {
    read = await adapter.read(file, cursor);
  } catch {
    // 文件/库在发现与读取之间消失：已摄入行保留，不删、不猜。
    store.write(db => recordIssue(db, adapter.issueKind, file.name,
      adapter.unreadableReason ?? 'session_source_unreadable', now, null),
      adapter.agent);
    return { ...result, files: 1, remaining: 0 };
  }
  if (read.state === 'error') {
    store.write(db => recordIssue(db, adapter.issueKind, file.name,
      read.error ?? 'session_source_unreadable', now, null), adapter.agent);
    return { ...result, files: 1, remaining: 0 };
  }
  // 封口文件只提交一个分块，observedOff 是整份长度；预算按本块计入。
  result.bytes = read.mode === 'sealed'
    ? read.committedOff - read.startOff
    : read.observedOff - read.startOff;
  result.remaining = read.mode === 'sealed'
    ? Math.max(0, read.observedOff - read.committedOff)
    : 0;
  const unchanged = read.lines.length === 0 && read.issues.length === 0
    && read.generation === (cursor?.generation ?? '')
    && read.committedOff === (cursor?.committedOff ?? 0);
  if (unchanged) {
    if (read.observedOff > (cursor?.observedOff ?? 0)) {
      observeSourceOffset(store, adapter.sourceKind, file.name, read.observedOff);
    }
    return { ...result, files: 1, remaining: 0 };
  }

  let finalCommitted = read.startOff;
  store.write(db => {
    const firstIssueOffset = read.issues[0]?.offset ?? Number.POSITIVE_INFINITY;
    for (const issue of read.issues) {
      result.invalid += 1;
      recordIssue(db, adapter.issueKind, `${file.name}:${issue.offset}`, 'session_line_too_large', now,
        issue.end - issue.offset);
    }

    let state = adapter.emptyState(file);
    if (adapter.replaysState && adapter.storesRaw !== false) {
      const replay = db.query<{ payload_json: string; source_kind: string; byte_offset: number }, [string]>(`
        SELECT payload_json, source_kind, byte_offset FROM raw_session_event
        WHERE file_generation=? ORDER BY byte_offset`).all(read.generation);
      for (const row of replay) {
        if (row.source_kind !== adapter.sourceKind) continue;
        const parsed = adapter.parse(row.payload_json);
        if (parsed.kind !== 'event') continue;
        state = adapter.apply(state, { ...parsed, offset: row.byte_offset, replay: true }).state;
      }
    }

    // 同一批内每个会话最近一次落库的正文快照：相邻调用的消息数组共享前缀，
    // 下一笔直接复制块引用，避免 O(调用数 × 历史消息数) 的重复序列化与插入。
    const bodyPrefixes = new Map<string, BodyPrefix>();
    const acceptCall = (call: SessionCall, lineOffset: number, rawChanged: boolean): void => {
      const refKey = evidenceRef(call);
      const owned = db.query<{ req_id: number }, [string, string]>(
        'SELECT req_id FROM request_evidence WHERE source_kind=? AND ref_key=?',
      ).get(adapter.evidenceKind, refKey);
      if (owned !== null && owned !== undefined) {
        result.duplicates += 1;
        if (adapter.mutable && (rawChanged || adapter.refreshOnDuplicate === true)) {
          refreshSessionCallTx(db, adapter, owned.req_id, call, read.generation, lineOffset, now);
          result.refreshed += 1;
          // 正文被原地重写后，旧快照的前缀块不再与这条会话对应。
          bodyPrefixes.delete(call.convKey);
        }
        return;
      }
      const persisted = ingestCallTx(
        db, adapter, call, read.generation, lineOffset, now, bodyPrefixes.get(call.convKey),
      );
      if (persisted === 'merged') {
        result.merged += 1;
      } else {
        result.calls += 1;
        if (call.requestMessages !== undefined) {
          bodyPrefixes.set(call.convKey, { reqId: persisted, messages: call.requestMessages });
        }
      }
    };

    const perLineCommit = adapter.lineCommit !== false;
    // 容器读取的游标由读取层整批给出；没有行可处理时也要越过已提交的 frame。
    let committed = perLineCommit ? read.startOff : read.committedOff;
    let blocked = false;
    for (const line of read.lines) {
      if (line.offset >= firstIssueOffset) break;
      const parsed = adapter.parse(line.text);
      if (parsed.kind === 'ignore') {
        committed = perLineCommit ? line.end : read.committedOff;
        continue;
      }
      // 不落原始层的来源跳过脱敏后的再序列化：物化行可重读，整段上下文
      // 再存一份既费空间也费 CPU；正文仍由 persistBodyTx 脱敏后入库。
      const sanitized = adapter.storesRaw === false
        ? { payloadJson: '', parsed }
        : sanitizedPayload(line.text, parsed, salt, value => adapter.parse(value));
      if (sanitized.parsed.kind === 'ignore') {
        committed = perLineCommit ? line.end : read.committedOff;
        continue;
      }
      const parsedEvent = sanitized.parsed.kind === 'event'
        ? { ...sanitized.parsed, offset: line.offset, replay: false }
        : sanitized.parsed;
      const step = parsedEvent.kind === 'event'
        ? adapter.apply(state, parsedEvent)
        : { state, calls: [], error: parsedEvent.reason, sessionId: null };

      // 同一物理位置的新 payload 只在可更新来源上替换；追加文件保持首份原文。
      // 不落原始层的来源连查询都省掉。
      let rawChanged = false;
      if (adapter.storesRaw !== false) {
        if (adapter.mutable) {
          const previous = db.query<{ payload_json: string }, [string, string, number]>(
            'SELECT payload_json FROM raw_session_event WHERE source_kind=? AND file_generation=? AND byte_offset=?',
          ).get(adapter.sourceKind, read.generation, line.offset);
          rawChanged = previous !== null && previous.payload_json !== sanitized.payloadJson;
          db.run(
            `INSERT INTO raw_session_event(source_kind,file_generation,byte_offset,session_id,line_type,
               event_at_ms,payload_json,privacy_version) VALUES (?,?,?,?,?,?,?,?)
             ON CONFLICT(file_generation,byte_offset) DO UPDATE SET
               session_id=excluded.session_id, line_type=excluded.line_type,
               event_at_ms=excluded.event_at_ms, payload_json=excluded.payload_json,
               privacy_version=excluded.privacy_version`,
            [
              adapter.sourceKind, read.generation, line.offset,
              step.sessionId, sanitized.parsed.kind === 'event' ? sanitized.parsed.lineType : 'invalid',
              sanitized.parsed.kind === 'event' ? sanitized.parsed.atMs : null,
              sanitized.payloadJson, PRIVACY_TRANSFORM_VERSION,
            ],
          );
        } else {
          db.run(
            `INSERT OR IGNORE INTO raw_session_event(source_kind,file_generation,byte_offset,session_id,
               line_type,event_at_ms,payload_json,privacy_version) VALUES (?,?,?,?,?,?,?,?)`,
            [
              adapter.sourceKind, read.generation, line.offset,
              step.sessionId, sanitized.parsed.kind === 'event' ? sanitized.parsed.lineType : 'invalid',
              sanitized.parsed.kind === 'event' ? sanitized.parsed.atMs : null,
              sanitized.payloadJson, PRIVACY_TRANSFORM_VERSION,
            ],
          );
        }
      }

      if (step.error !== null) {
        result.invalid += 1;
        result.blocked += 1;
        recordIssue(db, adapter.issueKind, `${file.name}:${line.offset}`, step.error, now,
          line.end - line.offset);
        // 游标停在坏行起点：跳过一条消息会让后续每轮请求体都缺一条。
        // 容器内行没有真实偏移，退回容器起点整段重读。
        committed = perLineCommit ? line.offset : (line.restartOff ?? read.startOff);
        blocked = true;
        break;
      }
      state = step.state;
      for (const call of step.calls) {
        acceptCall(call, call.sortOffset ?? line.offset, rawChanged);
      }
      committed = perLineCommit ? line.end : read.committedOff;
    }
    finalCommitted = committed;

    // 延迟发调用的适配器在批末补发仍挂起的调用；下一批重放后会以同一 ref
    // 再次补发，重复证据按 refreshOnDuplicate 刷新正文。
    const flushed = adapter.flush?.(state);
    if (flushed !== undefined) {
      for (const call of flushed.calls) {
        acceptCall(call, call.sortOffset ?? committed, false);
      }
    }

    if (!blocked && adapter.afterFile !== undefined) {
      result.sideEffects += adapter.afterFile(db, state, file, now);
    }

    upsertSourceCursorTx(db, { ...read, committedOff: committed }, now);
  }, adapter.agent);
  // 预算按实际推进量记：坏行重读没有推进时，不能继续在同一个文件上耗本轮预算。
  result.bytes = Math.max(0, finalCommitted - read.startOff);
  result.files = 1;
  return result;
}

/** 发现一家适配器当前可取的文件；根读不出只冻结这一家。 */
export async function discoverSessionFiles(
  store: Store,
  adapter: SessionAdapter,
  roots: readonly string[],
  now: number,
): Promise<SessionFile[]> {
  const cursorFor = (name: string) => {
    const cursor = readFileCursor(store, adapter.sourceKind, name);
    return cursor === null ? null
      : {
        generation: cursor.generation, committedOff: cursor.committedOff,
        observedOff: cursor.observedOff, seenSize: cursor.seenSize,
      };
  };
  const files: SessionFile[] = [];
  // source_name 是游标身份：文件是绝对路径，Zcode 是 `<db>#<session>`；
  // 同一根下的多个 Zcode 会话共用 path，不能用 path 去重。
  const seen = new Set<string>();
  for (const root of roots) {
    try {
      for (const file of await adapter.discover(root, cursorFor)) {
        if (seen.has(file.name)) continue;
        seen.add(file.name);
        files.push(file);
      }
    } catch {
      // 根存在但本轮读不出：冻结这一家，不影响其余适配器。
      store.write(db => recordIssue(db, adapter.issueKind, root, 'session_root_unreadable', now, null),
        adapter.agent);
    }
  }
  return adapter.select === undefined ? files : await adapter.select(files);
}

/** 摄入已发现的一批文件；调用方决定取件范围与单轮预算。 */
export async function ingestSessionFiles(
  store: Store,
  adapter: SessionAdapter,
  files: readonly SessionFile[],
  salt: Uint8Array,
  now: number,
  batch: { maxFiles: number; maxBytes: number } = adapter.batch,
): Promise<SessionIngestResult> {
  const selected = [...files]
    .filter(file => file.remaining > 0)
    // 默认新文件优先：历史回填期间，正在写入的会话先出现。droid 保持按
    // 剩余字节从大到小，先把积压的大转录推完。
    .sort(adapter.batch.order === 'remaining'
      ? (left, right) => right.remaining - left.remaining || left.name.localeCompare(right.name)
      : (left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
  const total = emptySessionIngestResult();
  let bytes = 0;
  let fileCount = 0;
  for (const file of selected) {
    if (fileCount >= batch.maxFiles || bytes >= batch.maxBytes) break;
    let counted = false;
    let remaining = file.remaining;
    // 封口文件一块一个写事务；本批内连续读到预算用完，避免一个大文件占满许多轮。
    while (remaining > 0) {
      // 封口读取与写事务都含同步段；块与块之间让出事件循环，避免一轮把定时器压到秒级。
      await new Promise<void>(resolve => setImmediate(resolve));
      const result = await ingestSessionFile(store, adapter, file, salt, now);
      if (!counted) {
        // 一个物理文件只记一次，分块不放大 files 计数。
        fileCount += result.files;
        total.files += result.files;
        counted = true;
      }
      total.calls += result.calls;
      total.merged += result.merged;
      total.duplicates += result.duplicates;
      total.refreshed += result.refreshed;
      total.invalid += result.invalid;
      total.blocked += result.blocked;
      total.sideEffects += result.sideEffects;
      total.bytes += result.bytes;
      // 预算按实际读到的字节记，不按 remaining 估：大文件首轮只读一个分批，
      // 按整份估会把后续小文件全挤掉。
      bytes += result.bytes;
      remaining = result.remaining;
      // 没有推进（坏行阻挡、文件消失）就换下一个文件，避免原地空转。
      if (result.bytes <= 0 || bytes >= batch.maxBytes || fileCount >= batch.maxFiles) break;
    }
  }
  return total;
}

/** 发现、取件并摄入一批；单轮上限归适配器。 */
export async function ingestSessionBatch(
  store: Store,
  adapter: SessionAdapter,
  roots: readonly string[],
  salt: Uint8Array,
  now: number,
): Promise<SessionIngestResult> {
  const files = await discoverSessionFiles(store, adapter, roots, now);
  return ingestSessionFiles(store, adapter, files, salt, now);
}
