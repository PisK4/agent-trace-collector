/**
 * Droid 转录批次入口：写入走共用 `session/ingest.ts`，这里只做两件 droid
 * 私有的事——批次结束后的 settings 刷新，以及把共用结果映射回原结果形状。
 */

import type { Store } from '../../store';
import { ingestSessionBatch } from '../session/ingest';
import { droidSessionAdapter } from '../session/adapters/droid';
import { refreshDroidSettingsTx } from './settings';

export type DroidIngestResult = {
  files: number;
  calls: number;
  merged: number;
  duplicates: number;
  invalid: number;
  blocked: number;
  settingsChanged: number;
  bytes: number;
};

export async function ingestDroidBatch(
  store: Store,
  root: string,
  salt: Uint8Array,
  now: number,
): Promise<DroidIngestResult> {
  const total = await ingestSessionBatch(store, droidSessionAdapter, [root], salt, now);
  // 转录不再增长时文件不会被选中；settings 是覆盖写，按已记录的路径单独刷新。
  const refreshed = store.write(db => {
    let changed = 0;
    const rows = db.query<{ session: string; source_path: string }, []>(
      "SELECT session,source_path FROM session_usage WHERE agent='droid'",
    ).all();
    for (const row of rows) changed += refreshDroidSettingsTx(db, row.session, row.source_path, now);
    return changed;
  }, 'droid');
  return {
    files: total.files,
    calls: total.calls,
    merged: total.merged,
    duplicates: total.duplicates,
    invalid: total.invalid,
    blocked: total.blocked,
    settingsChanged: total.sideEffects + refreshed,
    bytes: total.bytes,
  };
}
