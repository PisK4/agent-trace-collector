/**
 * Droid 的会话累计用量：整份读 `.settings.json`、按内容哈希判变化。
 *
 * 这是 droid 独有的旁路数据，不参与逐笔 request；主会话的转录摄入与
 * 批次结束后的刷新都调用这里。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Database } from 'bun:sqlite';
import { recordIssue } from '../../reconcile';
import { parseDroidSettings } from './parse';

export const DROID_ISSUE_KIND = 'droid_session';

/** 文件不存在时保留旧行；其余读取错误记 issue。 */
export function refreshDroidSettingsTx(
  db: Database,
  sessionId: string,
  path: string,
  now: number,
): number {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      recordIssue(db, DROID_ISSUE_KIND, `${sessionId}/settings`, 'droid_settings_unreadable', now, null);
    }
    return 0;
  }
  const hash = createHash('sha256').update(text).digest('hex');
  const existing = db.query<{ source_hash: string }, [string, string]>(
    'SELECT source_hash FROM session_usage WHERE agent=? AND session=?',
  ).get('droid', sessionId);
  if (existing !== null && existing !== undefined && existing.source_hash === hash) return 0;

  const parsed = parseDroidSettings(text);
  if (!parsed.ok) {
    recordIssue(db, DROID_ISSUE_KIND, `${sessionId}/settings`, parsed.reason, now, Buffer.byteLength(text));
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
      sessionId, value.model, value.inputTokens, value.outputTokens, value.cacheCreationTokens,
      value.cacheReadTokens, value.thinkingTokens, value.factoryCredits, path, hash, now,
    ],
  );
  return 1;
}
