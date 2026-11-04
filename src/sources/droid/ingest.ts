/**
 * Droid 转录摄入：原始层、逐轮 request 行、正文、会话累计用量与游标。
 *
 * 不变量：
 * - 一行 assistant 消息一条 request；fork 复制段只进消息窗口，不建行。
 * - 解析状态从本代际的 raw_droid_event 按偏移重放，批次之间不靠内存状态。
 * - 坏行记 issue 且游标停在坏行起点：跳过一条消息会让后续每轮请求体缺一条。
 * - 正文与原文字段先脱敏再落库；正文 protocol='droid-session'，消息数组与
 *   Anthropic 同形，标题、前驱与工具配对复用现有派生内核。
 * - 会话累计用量只写主会话的 settings，子代理不另计。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { Store } from '../../store';
import { PRIVACY_TRANSFORM_VERSION, redact } from '../../privacy';
import { HAVE_SESSION, MATCH_BY_SESSION_CALL, insertEvidenceTx } from '../../evidence';
import { localDay, modelTimeTitle } from '../../format';
import { persistBodyTx } from '../../body';
import { emptySourceFacts, readSourceFacts, serializeFacts } from '../facts';
import { readBatch } from '../files';
import type { SourceRead } from '../files';
import { observeSourceOffset, readFileCursor, recordIssue, upsertSourceCursorTx } from '../../reconcile';
import { discoverDroidTranscripts, selectDroidTranscripts } from './discover';
import type { DroidTranscript } from './discover';
import { applyDroidLine, emptyDroidState, parseDroidLine, parseDroidSettings } from './parse';
import type { DroidCall, DroidParserState } from './parse';

export type DroidIngestResult = {
  files: number;
  calls: number;
  duplicates: number;
  invalid: number;
  blocked: number;
  settingsChanged: number;
  bytes: number;
};

export function emptyDroidIngestResult(): DroidIngestResult {
  return { files: 0, calls: 0, duplicates: 0, invalid: 0, blocked: 0, settingsChanged: 0, bytes: 0 };
}

const SOURCE_KIND = 'droid_transcript';
const ISSUE_KIND = 'droid_session';

function evidenceRef(sessionId: string, messageId: string): string {
  return `${sessionId}/${messageId}`;
}

/** 脱敏后的整行原文：对象按脱敏后的 JSON 存，无法解析的行按字符串替换敏感片段。 */
function sanitizedPayload(text: string, parsed: ReturnType<typeof parseDroidLine>, salt: Uint8Array): {
  payloadJson: string; parsed: ReturnType<typeof parseDroidLine>;
} {
  if (parsed.kind === 'invalid') {
    return { payloadJson: JSON.stringify(redact(text, salt)), parsed };
  }
  const payloadJson = JSON.stringify(redact(JSON.parse(text), salt));
  return { payloadJson, parsed: parseDroidLine(payloadJson) };
}

/** 会话文件来源的长期事实：用量口径、思考档位与工作目录。 */
function sourceFactsJson(existing: string | null, call: DroidCall): string {
  const facts = readSourceFacts(existing) ?? emptySourceFacts();
  const previous = facts.session;
  facts.session = {
    usageScope: 'session',
    reasoningEffort: call.reasoningEffort ?? previous?.reasoningEffort ?? null,
    cwd: call.cwd ?? previous?.cwd ?? null,
  };
  return serializeFacts(facts);
}

function insertDroidRequestTx(
  db: Database,
  call: DroidCall,
  generation: string,
  offset: number,
  now: number,
): number {
  const sessionId = call.sessionId;
  const title = modelTimeTitle(call.modelRequested, call.startedMs);
  const inserted = db.run(
    `INSERT INTO request(
       response_id_norm,agent,session,conv_key,conv_source,actor,actor_state,subagent,parent_agent,
       started_ms,day,via,status,stop,model_requested,model_served,provider,
       in_tok,out_tok,cache_read,cache_write,reasoning,
       body_state,derive_version,have,created_at,updated_at,title,title_source,cost_state,
       attempt_state,sort_source,sort_key,source_facts_json
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      call.responseIdNorm, 'droid', sessionId, JSON.stringify(['session', sessionId]), 'droid-session',
      sessionId, 'known', call.isSubagent ? sessionId : null, call.parentSessionId,
      call.startedMs, localDay(call.startedMs), 'session', null, null, call.modelRequested, null, null,
      null, null, null, null, null,
      'pending', 0, HAVE_SESSION, now, now, title, 'model_time', 'absent',
      'not_applicable', 'droid_session', `${generation}|${String(offset).padStart(20, '0')}`,
      sourceFactsJson(null, call),
    ],
  );
  return Number(inserted.lastInsertRowid);
}

/** 一行调用落库：证据、正文与派生入队。返回是否新建了行。 */
function ingestCallTx(
  db: Database,
  call: DroidCall,
  generation: string,
  offset: number,
  salt: Uint8Array,
  now: number,
): boolean {
  const refKey = evidenceRef(call.sessionId, call.messageId);
  const owned = db.query<{ req_id: number }, [string, string]>(
    'SELECT req_id FROM request_evidence WHERE source_kind=? AND ref_key=?',
  ).get('session_call', refKey);
  if (owned !== null && owned !== undefined) return false;

  const reqId = insertDroidRequestTx(db, call, generation, offset, now);
  insertEvidenceTx(db, reqId, 'session_call', refKey, 'merged', MATCH_BY_SESSION_CALL, now);
  persistBodyTx(db, reqId, {
    protocol: 'droid-session',
    request: { messages: call.requestMessages },
    // 转录只记 assistant 的 content；加 role 让 Anthropic 形状的读取端能直接解析。
    reply: { role: 'assistant', content: call.replyContent },
    redact_version: PRIVACY_TRANSFORM_VERSION,
  });
  return true;
}

/** 主会话的 settings：整份读、按内容哈希判变化，不占游标。 */
function ingestSettingsTx(
  db: Database,
  transcript: DroidTranscript,
  state: DroidParserState,
  now: number,
): number {
  const session = state.session;
  if (session === null || session.callingSessionId !== null) return 0;
  const path = join(transcript.dir, `${session.id}.settings.json`);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      recordIssue(db, ISSUE_KIND, `${session.id}/settings`, 'droid_settings_unreadable', now, null);
    }
    return 0;
  }
  const hash = createHash('sha256').update(text).digest('hex');
  const existing = db.query<{ source_hash: string }, [string, string]>(
    'SELECT source_hash FROM session_usage WHERE agent=? AND session=?',
  ).get('droid', session.id);
  if (existing !== null && existing !== undefined && existing.source_hash === hash) return 0;

  const parsed = parseDroidSettings(text);
  if (!parsed.ok) {
    recordIssue(db, ISSUE_KIND, `${session.id}/settings`, parsed.reason, now, Buffer.byteLength(text));
    return 0;
  }
  const value = parsed.value;
  if (value.model === null && value.inputTokens === null && value.outputTokens === null
    && value.cacheCreationTokens === null && value.cacheReadTokens === null
    && value.thinkingTokens === null && value.factoryCredits === null) return 0;
  db.run(
    `INSERT INTO session_usage(
       agent,session,model,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,
       thinking_tokens,factory_credits,source_path,source_hash,observed_at)
     VALUES ('droid',?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(agent,session) DO UPDATE SET
       model=excluded.model,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,
       cache_creation_tokens=excluded.cache_creation_tokens,cache_read_tokens=excluded.cache_read_tokens,
       thinking_tokens=excluded.thinking_tokens,factory_credits=excluded.factory_credits,
       source_path=excluded.source_path,source_hash=excluded.source_hash,observed_at=excluded.observed_at
     WHERE session_usage.source_hash<>excluded.source_hash`,
    [
      session.id, value.model, value.inputTokens, value.outputTokens, value.cacheCreationTokens,
      value.cacheReadTokens, value.thinkingTokens, value.factoryCredits, path, hash, now,
    ],
  );
  return 1;
}

/**
 * 一个转录文件的一批摄入。读取在事务外，原始层、证据、正文、settings 与游标
 * 在同一事务内提交；坏行让游标停在行起点，下一轮重读同一行。
 */
export async function ingestDroidTranscript(
  store: Store,
  transcript: DroidTranscript,
  salt: Uint8Array,
  now: number,
): Promise<DroidIngestResult> {
  const result = emptyDroidIngestResult();
  const cursor = readFileCursor(store, SOURCE_KIND, transcript.name);
  let read: SourceRead;
  try {
    read = await readBatch(transcript.path, cursor, { kind: SOURCE_KIND, name: transcript.name });
  } catch {
    // 文件在发现与读取之间消失：已摄入行保留，不删、不猜。
    store.write(db => recordIssue(db, ISSUE_KIND, transcript.name, 'droid_file_unreadable', now, null), 'droid');
    return { ...result, files: 1 };
  }
  result.bytes = read.observedOff - read.startOff;
  const unchanged = read.lines.length === 0 && read.issues.length === 0
    && read.generation === (cursor?.generation ?? '')
    && read.committedOff === (cursor?.committedOff ?? 0);
  if (unchanged) {
    // 只观察不提交：半行不推进游标，下一轮继续等完整行。
    if (read.observedOff > (cursor?.observedOff ?? 0)) {
      observeSourceOffset(store, SOURCE_KIND, transcript.name, read.observedOff);
    }
    return { ...result, files: 1 };
  }

  store.write(db => {
    const firstIssueOffset = read.issues[0]?.offset ?? Number.POSITIVE_INFINITY;
    for (const issue of read.issues) {
      result.invalid += 1;
      recordIssue(db, ISSUE_KIND, `${transcript.name}:${issue.offset}`, 'droid_line_too_large', now,
        issue.end - issue.offset);
    }

    // 重放本代际已提交的行，恢复 session、消息窗口与 fork 位置。
    let state = emptyDroidState();
    const replay = db.query<{ payload_json: string }, [string]>(
      'SELECT payload_json FROM raw_droid_event WHERE file_generation=? ORDER BY byte_offset',
    ).all(read.generation);
    for (const row of replay) {
      const parsed = parseDroidLine(row.payload_json);
      if (parsed.kind === 'invalid') continue;
      state = applyDroidLine(state, parsed).state;
    }

    let committed = read.startOff;
    let blocked = false;
    for (const line of read.lines) {
      if (line.offset >= firstIssueOffset) break;
      const parsed = parseDroidLine(line.text);
      const sanitized = sanitizedPayload(line.text, parsed, salt);
      const step = applyDroidLine(state, sanitized.parsed);
      db.run(
        `INSERT OR IGNORE INTO raw_droid_event(
           file_generation,byte_offset,session_id,line_type,event_at_ms,payload_json,privacy_version)
         VALUES (?,?,?,?,?,?,?)`,
        [
          read.generation, line.offset, step.state.session?.id ?? state.session?.id ?? null,
          parsed.lineType, parsed.atMs, sanitized.payloadJson, PRIVACY_TRANSFORM_VERSION,
        ],
      );

      if (step.error !== null) {
        result.invalid += 1;
        result.blocked += 1;
        recordIssue(db, ISSUE_KIND, `${transcript.name}:${line.offset}`, step.error, now,
          line.end - line.offset);
        // 游标停在坏行起点：跳过这条消息会让后续每轮请求体都缺一条。
        committed = line.offset;
        blocked = true;
        break;
      }
      state = step.state;
      if (step.call !== null) {
        if (ingestCallTx(db, step.call, read.generation, line.offset, salt, now)) result.calls += 1;
        else result.duplicates += 1;
      }
      committed = line.end;
    }

    if (!blocked) {
      result.settingsChanged += ingestSettingsTx(db, transcript, state, now);
    }
    upsertSourceCursorTx(db, { ...read, committedOff: committed }, now);
  }, 'droid');
  result.files = 1;
  return result;
}

/** 发现、取件并摄入一批转录；单轮上限由 discover 的 64 文件 / 8 MiB 控制。 */
export async function ingestDroidBatch(
  store: Store,
  root: string,
  salt: Uint8Array,
  now: number,
): Promise<DroidIngestResult> {
  const files = discoverDroidTranscripts(root);
  const selected = selectDroidTranscripts(files, name => {
    const cursor = readFileCursor(store, SOURCE_KIND, name);
    return cursor === null ? null : { generation: cursor.generation, committedOff: cursor.committedOff };
  });
  const total = emptyDroidIngestResult();
  for (const transcript of selected) {
    const result = await ingestDroidTranscript(store, transcript, salt, now);
    total.files += result.files;
    total.calls += result.calls;
    total.duplicates += result.duplicates;
    total.invalid += result.invalid;
    total.blocked += result.blocked;
    total.settingsChanged += result.settingsChanged;
    total.bytes += result.bytes;
  }
  return total;
}