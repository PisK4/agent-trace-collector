/** magpie 版本探测：一次外部 HTTP 加本地文件读取，结果只在实际变化时持久化。 */

import { readFileSync } from 'node:fs';
import { commitUnit, type Store } from '../../store';
import { isRecord } from './mapping';

export type ProbeResult = { version: string | null; verified: boolean; reason: string | null };

function versionVerified(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (major !== 0) return false;
  if (minor > 1) return false;
  return minor === 1 && patch >= 1294;
}

export async function probeMagpie(
  baseUrl: string,
  versionFile: string,
  fetcher: typeof fetch = fetch,
): Promise<ProbeResult> {
  let fileVersion: string | null = null;
  try {
    const text = readFileSync(versionFile, 'utf8').trim();
    fileVersion = text.length > 0 ? text : null;
  } catch {
    fileVersion = null;
  }
  let httpVersion: string | null = null;
  let httpOk = false;
  try {
    const response = await fetcher(`${baseUrl.replace(/\/$/, '')}/v1`);
    if (response.ok) {
      const body = await response.json() as unknown;
      if (isRecord(body) && typeof body.version === 'string' && body.version.length > 0) {
        httpVersion = body.version;
        httpOk = true;
      }
    }
  } catch {
    httpOk = false;
  }
  const version = httpVersion ?? fileVersion;
  if (version === null) return { version: null, verified: false, reason: 'version_unavailable' };
  const verified = versionVerified(version);
  if (!verified) return { version, verified, reason: 'version_out_of_range' };
  return { version, verified, reason: httpOk ? null : 'http_unavailable' };
}

/** 探针只持久化结果变化，at 表示该结果开始被观测到的时间。 */
export function saveProbe(store: Store, result: ProbeResult, now: number): void {
  const key = JSON.stringify(['magpie', 'probe']);
  commitUnit(store, 'probe', read => {
    const previous = read.query<{ value_json: string }, [string]>(
      'SELECT value_json FROM collector_state WHERE key=?').get(key);
    let value: unknown = null;
    try { value = previous === null ? null : JSON.parse(previous.value_json); } catch { /* 重写损坏状态 */ }
    if (isRecord(value) && value.version === result.version
      && value.verified === result.verified && value.reason === result.reason) return null;
    return db => db.run(`INSERT INTO collector_state(key,value_json) VALUES (?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`,
    [key, JSON.stringify({ ...result, at: now })]);
  });
}

/** 已持久化的 magpie 版本；费用同步用它标注观测行的采集方版本。 */
export function probeVersion(store: Store): string | null {
  const row = store.read.query<{ value_json: string }, [string]>(
    'SELECT value_json FROM collector_state WHERE key=?',
  ).get(JSON.stringify(['magpie', 'probe']));
  if (row == null) return null;
  try {
    const parsed = JSON.parse(row.value_json) as unknown;
    return isRecord(parsed) && typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}
