/**
 * Grok 本地会话适配器。
 *
 * 批次 A 准备分支只登记形状，不解析会话；实现由 feat/grok-session 分支替换。
 * discover 恒返回空，避免占位实现扫到真实目录却读不出调用。
 */

import type { SourceCursor, SourceRead } from '../../files';
import type { SessionAdapter, SessionFile } from '../types';

export const grokAdapter: SessionAdapter = {
  agent: 'grok',
  sourceKind: 'grok_session',
  issueKind: 'grok_session',
  evidenceKind: 'grok_session_call',
  bodyProtocol: 'chat',
  sortSource: 'grok_session',
  mutable: false,
  replaysState: false,
  batch: { maxFiles: 64, maxBytes: 2 * 1024 * 1024 },
  roots() { return []; },
  discover() { return []; },
  async read(file: SessionFile, cursor: SourceCursor | null): Promise<SourceRead> {
    return {
      sourceKind: this.sourceKind,
      name: file.name,
      generation: cursor?.generation ?? '',
      rewriteEpoch: cursor?.rewriteEpoch ?? 0,
      committedOff: cursor?.committedOff ?? 0,
      observedOff: cursor?.observedOff ?? 0,
      seenSize: file.size,
      headLen: 0,
      headHash: null,
      fingerprint: null,
      mode: 'appendable',
      state: 'unchanged',
      lines: [],
      issues: [],
      startOff: cursor?.committedOff ?? 0,
      error: null,
    };
  },
  parse() { return { kind: 'ignore' }; },
  emptyState() { return null; },
  apply(state: unknown) { return { state, calls: [], error: null, sessionId: null }; },
};
