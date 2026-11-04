/**
 * Droid 转录适配器：把已有的纯解析器接到共用会话摄入。
 *
 * 只负责发现、读取、解析与归约；原始层、证据、正文、认领与游标归
 * `session/ingest.ts`。fork 复制段只进窗口不建行，子代理保留自己的会话 id。
 */

import { dirname, join } from 'node:path';
import type { SourceCursor, SourceRead } from '../../files';
import { readBatch } from '../../files';
import { discoverDroidTranscripts, droidSessionsRoot } from '../../droid/discover';
import {
  applyDroidLine, emptyDroidState, parseDroidLine,
} from '../../droid/parse';
import type { DroidCall, DroidParsedLine, DroidParserState } from '../../droid/parse';
import { DROID_ISSUE_KIND, refreshDroidSettingsTx } from '../../droid/settings';
import type {
  SessionAdapter, SessionApplyResult, SessionCall, SessionFile, SessionParseResult,
} from '../types';
import { sessionConvKey } from '../types';

function sessionCallOf(call: DroidCall, offset: number): SessionCall {
  return {
    sessionId: call.sessionId,
    subagentId: call.isSubagent ? call.sessionId : null,
    convKey: sessionConvKey(call.sessionId),
    callId: call.messageId,
    sortOffset: offset,
    parentSessionId: call.parentSessionId,
    startedMs: call.startedMs,
    model: call.modelRequested,
    responseIdNorm: call.responseIdNorm,
    turnRef: null,
    usage: null,
    // droid 没有逐笔 reasoning token；reasoningEffort 只进 source_facts。
    reasoning: null,
    reasoningEffort: call.reasoningEffort,
    requestMessages: call.requestMessages,
    replyContent: call.replyContent,
    cwd: call.cwd,
  };
}

export const droidSessionAdapter: SessionAdapter = {
  agent: 'droid',
  sourceKind: 'droid_transcript',
  issueKind: DROID_ISSUE_KIND,
  unreadableReason: 'droid_file_unreadable',
  evidenceKind: 'session_call',
  bodyProtocol: 'droid-session',
  sortSource: 'droid_session',
  mutable: false,
  replaysState: true,
  attemptState: 'not_applicable',
  batch: { maxFiles: 64, maxBytes: 8 * 1024 * 1024, order: 'remaining' },

  roots(env, home) {
    return [droidSessionsRoot(env, home)];
  },

  discover(root, cursorFor) {
    return discoverDroidTranscripts(root).map((transcript): SessionFile => {
      const cursor = cursorFor(transcript.name);
      return {
        name: transcript.name,
        path: transcript.path,
        size: transcript.size,
        mtimeMs: transcript.mtimeMs ?? 0,
        remaining: cursor === null
          ? transcript.size
          : Math.max(0, transcript.size - cursor.committedOff),
      };
    });
  },

  read(file: SessionFile, cursor: SourceCursor | null): Promise<SourceRead> {
    return readBatch(file.path, cursor, { kind: 'droid_transcript', name: file.name });
  },

  parse(text: string): SessionParseResult {
    const parsed = parseDroidLine(text);
    if (parsed.kind === 'invalid') return { kind: 'invalid', reason: parsed.reason };
    return {
      kind: 'event', lineType: parsed.lineType, atMs: parsed.atMs,
      sessionId: null, offset: 0, value: parsed,
    };
  },

  emptyState() {
    return emptyDroidState();
  },

  apply(state, event): SessionApplyResult {
    const step = applyDroidLine(state as DroidParserState, event.value as DroidParsedLine);
    return {
      state: step.state,
      calls: step.call === null ? [] : [sessionCallOf(step.call, event.offset)],
      error: step.error,
      sessionId: step.state.session?.id ?? null,
    };
  },

  afterFile(db, state, file, now) {
    const parsed = state as DroidParserState;
    const session = parsed.session;
    if (session === null || session.callingSessionId !== null) return 0;
    return refreshDroidSettingsTx(db, session.id,
      join(dirname(file.path), `${session.id}.settings.json`), now);
  },
};
