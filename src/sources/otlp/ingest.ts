/**
 * OTLP traces 批次的接收与落库（证据层 + 映射层，第一批）。
 *
 * 不变量：
 * - 物理身份 (trace_id, span_id)：同一 span 重发不产生新行（request_evidence
 *   的 otlp_span 证据行判重），幂等重放零副作用。
 * - 与 magpie 三路证据不合并、不抢字段：OTLP 行只写白名单映射列，
 *   agent 标签用 magpie 同值域，用量与模型以 span 实得为准。
 * - 脱敏在原始层落盘之前，脱敏实现只有 src/privacy.ts 一个入口。
 * - span 带会话 id 才进派生组（组键与 sessionRef 逐字相同）；没带就只是
 *   独立记录，不猜归属。
 * - 未登记 service.name 的 span 只落原始层，按服务与日聚合记一行
 *   service_not_registered issue（对外 profile 的门铃），不逐 span 刷表。
 * - 暂停档（95%）整批拒绝，不静默丢弃；OTLP 行第一批不写正文，
 *   metadata_only 档对 traces 等价 normal。
 */

import type { Store } from '../../store';
import { redact } from '../../privacy';
import { PRIVACY_TRANSFORM_VERSION } from '../../privacy';
import { localDay, modelTimeTitle } from '../../format';
import { HAVE_OTLP, MATCH_BY_SPAN_IDENTITY, insertEvidenceTx, otlpConv } from '../../evidence';
import { markRequestInputTx } from '../../derive/state';
import type { HookAdmission } from '../../hook';
import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import type { OtlpLogRecord, OtlpLogsPayload, OtlpTracesPayload } from './decode';
import { idHex, nanoToMs } from './decode';
import { OTLP_MAPPING_VERSION, SPAN_RULES, classifySpan, mapSpan } from './mapping';
import { persistBodyTx } from '../../body';

export type AcceptOtlpTracesResult = {
  spans: number;
  spanDuplicates: number;
  requestsCreated: number;
  unknownShape: number;
  /** 未登记服务的 span 计数；按服务聚合的门铃明细在 service_not_registered issue。 */
  unknownServices: number;
  bodiesWired: number;
};

export type OtlpAcceptOptions = {
  /** 缺省视为 normal：测试与离线重放不需要真实磁盘预算。 */
  admission?: () => HookAdmission;
};

/** span 证据的稳定 ref_key：trace/span 的十六进制拼写。 */
export function spanRefKey(traceId: Uint8Array, spanId: Uint8Array): string {
  return `${idHex(traceId)}/${idHex(spanId)}`;
}

export function acceptOtlpTraces(
  store: Store,
  payload: OtlpTracesPayload,
  now: number,
  salt: Uint8Array,
  options: OtlpAcceptOptions = {},
): AcceptOtlpTracesResult {
  const admission = options.admission?.() ?? { mode: 'normal', reason: null };
  // 暂停时拒绝整批：收下却写不进只会多一条误导性的"成功"记录。
  if (admission.mode === 'paused') throw new Error('disk_full');

  const result: AcceptOtlpTracesResult = { spans: 0, spanDuplicates: 0, requestsCreated: 0, unknownShape: 0, unknownServices: 0, bodiesWired: 0 };

  store.write(db => {
    const existingStmt = db.prepare(
      'SELECT req_id FROM request_evidence WHERE source_kind=? AND ref_key=?');
    const rawStmt = db.prepare(
      `INSERT OR IGNORE INTO raw_otlp_span(
         trace_id,span_id,received_at,service,scope_name,name,kind,start_ms,end_ms,status_code,
         attributes_json,mapping_version,privacy_version)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const issueStmt = db.prepare(
      'INSERT OR IGNORE INTO ingest_issue(source_kind,ref_key,reason,observed_at,byte_length) VALUES (?,?,?,?,NULL)');

    for (const scope of payload.resourceSpans) {
      // 登记检查按 scope 做一次：ref_key 聚合到服务与接收日，主键去重防刷表。
      const unregisteredDayKey = SPAN_RULES.some(entry => entry.service === scope.service)
        ? null
        : `service/${scope.service ?? '(unset)'}/${localDay(now)}`;
      for (const span of scope.items) {
        result.spans += 1;
        const refKey = spanRefKey(span.traceId, span.spanId);
        if (existingStmt.get('otlp_span', refKey) !== null) {
          result.spanDuplicates += 1;
          continue;
        }

        // 脱敏先于原始层落盘；字符串内的 JSON 由 walk 的既有分支处理。
        const redactedAttrs = redact(span.attrs, salt);
        rawStmt.run(
          span.traceId, span.spanId, now, scope.service, scope.scopeName,
          span.name, span.kind, nanoToMs(span.startNano),
          span.endNano === null ? null : nanoToMs(span.endNano),
          span.statusCode,
          JSON.stringify(redactedAttrs), OTLP_MAPPING_VERSION, PRIVACY_TRANSFORM_VERSION,
        );

        if (unregisteredDayKey !== null) {
          result.unknownServices += 1;
          issueStmt.run('otlp_span', unregisteredDayKey, 'service_not_registered', now);
          continue;
        }

        const verdict = classifySpan(scope.service, span);
        if (verdict.kind === 'unknown') {
          // 白名单服务、LLM 形状、但选取规则没认：记未知桶，不按形状兜底建行。
          result.unknownShape += 1;
          issueStmt.run('otlp_span', refKey, 'span_shape_unknown', now);
          continue;
        }
        if (verdict.kind === 'skipped') continue;

        const mapping = mapSpan(verdict.rule, span);
        const conv = otlpConv(mapping.session);
        const started = nanoToMs(span.startNano);
        const insert = db.run(
          `INSERT INTO request(
             agent,session,conv_key,conv_source,actor,actor_state,
             started_ms,day,via,stop,model_requested,model_served,
             in_tok,out_tok,cache_read,cache_write,
             body_state,derive_version,have,created_at,updated_at,title,title_source,
             cost_state,attempt_state,sort_source,sort_key
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            mapping.agent, mapping.session, conv?.key ?? null, conv?.source ?? null,
            mapping.session, conv === null ? 'unknown' : 'known',
            started, localDay(started), 'otlp',
            mapping.stop, mapping.modelRequested, mapping.modelServed,
            mapping.inTok, mapping.outTok, mapping.cacheRead, mapping.cacheWrite,
            'summary', 0, HAVE_OTLP, now, now,
            modelTimeTitle(mapping.modelRequested, started), 'model_time',
            'absent', 'known', 'otlp_span', refKey,
          ],
        );
        const reqId = Number(insert.lastInsertRowid);
        insertEvidenceTx(db, reqId, 'otlp_span', refKey, 'merged', MATCH_BY_SPAN_IDENTITY, now);
        // 有会话 id 才进派生组；没带的行不进 derive_queue，也不伪造归属。
        if (conv !== null) markRequestInputTx(db, reqId);
        result.requestsCreated += 1;
        // logs 可能先到：span 行一落，回头接等待中的 body_ref 指针。
        for (const pending of db.query<{ request_body_id: string }, [Uint8Array]>(
          "SELECT request_body_id FROM otlp_body_ref WHERE trace_id=? AND state='pending_span'",
        ).all(span.traceId)) {
          if (attemptBodyWireTx(db, pending.request_body_id, now, salt, admission)) {
            result.bodiesWired += 1;
          }
        }
      }
    }
  }, 'otlp_traces');

  return result;
}

// ——— logs：接收 + body_ref 接线 ——————————————————————————

export type AcceptOtlpLogsResult = {
  records: number;
  duplicates: number;
  bodyEvents: number;
  bodiesWired: number;
};

/** 记录哈希：OTLP 记录没有内生 id，同一记录重发的字节相同，内容哈希即判重键。 */
function recordHash(record: OtlpLogRecord): Buffer {
  const canonical = JSON.stringify({
    t: record.timeNano?.toString() ?? null,
    b: record.body,
    tr: record.traceId === null ? null : idHex(record.traceId),
    sp: record.spanId === null ? null : idHex(record.spanId),
    a: record.attrs,
  });
  return createHash('sha256').update(canonical).digest();
}

type BodyEventKind = 'request' | 'response';

function bodyEventOf(record: OtlpLogRecord): BodyEventKind | null {
  if (record.body === 'claude_code.api_request_body') return 'request';
  if (record.body === 'claude_code.api_response_body') return 'response';
  return null;
}

/** 指针读取边界：只读事件指到的那一个文件，普通文件、非符号链接、≤32 MiB。 */
const BODY_FILE_MAX_BYTES = 32 * 1024 * 1024;

function readBodyFile(path: string): { ok: true; value: Record<string, unknown> } | { ok: false; code: string } {
  let info: Stats;
  try {
    info = lstatSync(path);
  } catch (error) {
    return { ok: false, code: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'stat_failed' };
  }
  if (info.isSymbolicLink() || !info.isFile()) return { ok: false, code: 'not_regular' };
  if (info.size > BODY_FILE_MAX_BYTES) return { ok: false, code: 'too_large' };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, code: 'read_failed' };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, code: 'not_object' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, code: 'invalid_json' };
  }
}

/**
 * 一次 body_ref 的接线尝试（幂等，状态记在 otlp_body_ref）：
 * - span 未到：pending_span（traces 侧创建行后回接）。
 * - span 撞出多个候选：span_ambiguous——attempt 区分不了，不猜。
 * - 双指针未齐：awaiting_response（response 事件随调用结束到达）。
 * - 读文件失败/解析失败：read_failed / parse_failed，行降级原因跟着记，
 *   读不到不算解析失败（提案边界）。
 * - 成功：脱敏后走既有 persistBodyTx，body_state 转 available。
 * 返回本次是否真正完成接线。
 */
function attemptBodyWireTx(
  db: Database,
  requestBodyId: string,
  now: number,
  salt: Uint8Array,
  admission: HookAdmission,
): boolean {
  const row = db.query<
    { trace_id: Uint8Array; req_id: number | null; request_ref: string | null; response_ref: string | null; state: string },
    [string]
  >('SELECT trace_id, req_id, request_ref, response_ref, state FROM otlp_body_ref WHERE request_body_id=?')
    .get(requestBodyId);
  if (row === null || row.state === 'wired') return false;

  const setState = (state: string, detail: string | null): void => {
    db.run('UPDATE otlp_body_ref SET state=?, detail=?, updated_at=? WHERE request_body_id=?',
      [state, detail, now, requestBodyId]);
  };

  let reqId = row.req_id;
  if (reqId === null) {
    const prefix = `${idHex(row.trace_id)}/`;
    const candidates = db.query<{ req_id: number }, [string]>(
      "SELECT req_id FROM request_evidence WHERE source_kind='otlp_span' AND ref_key LIKE ?",
    ).all(prefix + '%');
    if (candidates.length === 0) { setState('pending_span', null); return false; }
    if (candidates.length > 1) { setState('span_ambiguous', `candidates=${candidates.length}`); return false; }
    reqId = candidates[0]!.req_id;
    db.run('UPDATE otlp_body_ref SET req_id=? WHERE request_body_id=?', [reqId, requestBodyId]);
  }
  if (row.request_ref === null || row.response_ref === null) {
    setState('awaiting_response', null);
    return false;
  }
  if (admission.mode === 'metadata_only') {
    // 80% 档停正文：指针留着，接线状态记档，等下一轮证据再试。
    setState('metadata_only', admission.reason);
    return false;
  }

  const requestFile = readBodyFile(row.request_ref);
  if (!requestFile.ok) {
    setState('read_failed', `${row.request_ref}:${requestFile.code}`);
    db.run("UPDATE request SET miss_reason='body_ref_read_failed', updated_at=? WHERE req_id=? AND body_state='summary'", [now, reqId]);
    return false;
  }
  const responseFile = readBodyFile(row.response_ref);
  if (!responseFile.ok) {
    setState('read_failed', `${row.response_ref}:${responseFile.code}`);
    db.run("UPDATE request SET miss_reason='body_ref_read_failed', updated_at=? WHERE req_id=? AND body_state='summary'", [now, reqId]);
    return false;
  }

  // 形态已实测：request 文件是 Messages API 请求体原样，response 是裸 Message 对象。
  persistBodyTx(db, reqId, {
    protocol: 'anthropic',
    request: redact(requestFile.value, salt),
    reply: redact(responseFile.value, salt),
    redact_version: 1,
  });
  db.run('UPDATE request SET miss_reason=NULL WHERE req_id=?', [reqId]);
  setState('wired', null);
  return true;
}

export function acceptOtlpLogs(
  store: Store,
  payload: OtlpLogsPayload,
  now: number,
  salt: Uint8Array,
  options: OtlpAcceptOptions = {},
): AcceptOtlpLogsResult {
  const admission = options.admission?.() ?? { mode: 'normal', reason: null };
  if (admission.mode === 'paused') throw new Error('disk_full');

  const result: AcceptOtlpLogsResult = { records: 0, duplicates: 0, bodyEvents: 0, bodiesWired: 0 };

  store.write(db => {
    const rawStmt = db.prepare(
      `INSERT OR IGNORE INTO raw_otlp_log(
         record_hash,received_at,service,trace_id,span_id,time_ms,body,attributes_json,privacy_version)
       VALUES (?,?,?,?,?,?,?,?,?)`);
    const issueStmt = db.prepare(
      'INSERT OR IGNORE INTO ingest_issue(source_kind,ref_key,reason,observed_at,byte_length) VALUES (?,?,?,?,NULL)');

    for (const scope of payload.resourceLogs) {
      for (const record of scope.items) {
        result.records += 1;
        const hash = recordHash(record);
        const refKey = idHex(new Uint8Array(hash));
        const redactedBody = record.body === null ? null : redact(record.body, salt);
        const inserted = rawStmt.run(
          hash, now, scope.service, record.traceId, record.spanId,
          record.timeNano === null ? null : nanoToMs(record.timeNano),
          typeof redactedBody === 'string' ? redactedBody : null,
          JSON.stringify(redact(record.attrs, salt)), PRIVACY_TRANSFORM_VERSION,
        );
        if (inserted.changes === 0) result.duplicates += 1;

        const eventKind = bodyEventOf(record);
        if (eventKind === null) continue;
        result.bodyEvents += 1;
        const attrs = record.attrs as Record<string, unknown>;
        const requestBodyId = typeof attrs['request_body_id'] === 'string' ? attrs['request_body_id'] as string : null;
        const bodyRef = typeof attrs['body_ref'] === 'string' ? attrs['body_ref'] as string : null;
        const messageId = typeof attrs['message.id'] === 'string' ? attrs['message.id'] as string : null;
        if (requestBodyId === null || bodyRef === null || record.traceId === null) {
          issueStmt.run('otlp_log', refKey, 'body_event_incomplete', now);
          continue;
        }
        db.run(
          `INSERT INTO otlp_body_ref(request_body_id,trace_id,request_ref,response_ref,message_id,state,updated_at)
           VALUES (?,?,?,?,?,'pending_span',?)
           ON CONFLICT(request_body_id) DO UPDATE SET
             request_ref=COALESCE(excluded.request_ref,request_ref),
             response_ref=COALESCE(excluded.response_ref,response_ref),
             message_id=COALESCE(excluded.message_id,message_id),
             updated_at=excluded.updated_at
             WHERE otlp_body_ref.state<>'wired'`,
          [requestBodyId, record.traceId,
            eventKind === 'request' ? bodyRef : null,
            eventKind === 'response' ? bodyRef : null,
            messageId, now],
        );
        if (attemptBodyWireTx(db, requestBodyId, now, salt, admission)) {
          result.bodiesWired += 1;
        }
      }
    }
  }, 'otlp_logs');

  return result;
}
