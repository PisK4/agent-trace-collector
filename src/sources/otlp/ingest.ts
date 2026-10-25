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
import type { OtlpTracesPayload } from './decode';
import { idHex, nanoToMs } from './decode';
import { OTLP_MAPPING_VERSION, classifySpan, mapSpan } from './mapping';

export type AcceptOtlpTracesResult = {
  spans: number;
  spanDuplicates: number;
  requestsCreated: number;
  unknownShape: number;
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

  const result: AcceptOtlpTracesResult = { spans: 0, spanDuplicates: 0, requestsCreated: 0, unknownShape: 0 };

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
      }
    }
  }, 'otlp_traces');

  return result;
}
