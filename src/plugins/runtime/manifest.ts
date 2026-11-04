/**
 * 社区轨的清单加载：只读本机目录，不联网、不签名、不自动更新。
 *
 * 首版只装本地包。`<root>/plugins.json` 每项声明 id、agent、api 与 entry；
 * agent 由清单给出而不是导入包再读——主线程不执行外部代码，认领关系在启动时
 * 就定下来。api 不符、id 未登记、entry 越出根目录或文件缺失都拒收并给出固定
 * 分类码，不抛异常：一个坏包不能挡住采集器启动，内置轨也不受影响。
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PLUGIN_API } from '../types';

/** 一份通过校验的社区包。entryPath 是绝对路径，交给 Worker 动态 import。 */
export type CommunityPackage = { id: string; agent: string; entryPath: string };

export type CommunityRejectionCode = 'plugin_manifest_invalid' | 'plugin_api_mismatch'
  | 'plugin_unknown_id' | 'plugin_entry_missing' | 'plugin_entry_outside_root';

export type CommunityLoad = {
  packages: CommunityPackage[];
  /** entry 是清单里的相对写法或 `plugins.json`；只用于诊断，不含包内文本。 */
  rejected: { entry: string; code: CommunityRejectionCode }[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reject(entry: string, code: CommunityRejectionCode): CommunityLoad {
  return { packages: [], rejected: [{ entry, code }] };
}

/** 清单缺失按「没有社区包」处理；只有清单存在但读不懂才报分类码。 */
export function loadCommunityPlugins(root: string, knownIds: readonly string[]): CommunityLoad {
  let raw: string;
  try {
    raw = readFileSync(join(root, 'plugins.json'), 'utf8');
  } catch {
    return { packages: [], rejected: [] };
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return reject('plugins.json', 'plugin_manifest_invalid');
  }
  const entries = isRecord(document) ? document.plugins : undefined;
  if (!Array.isArray(entries)) return reject('plugins.json', 'plugin_manifest_invalid');

  const base = resolve(root);
  const packages: CommunityPackage[] = [];
  const rejected: CommunityLoad['rejected'] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.agent !== 'string'
      || entry.agent === '' || typeof entry.entry !== 'string' || entry.entry === '') {
      rejected.push({ entry: 'plugins.json', code: 'plugin_manifest_invalid' });
      continue;
    }
    // api 只认清单里的声明：被拒的包连 import 都不发生，外部代码零执行。
    if (entry.api !== PLUGIN_API) {
      rejected.push({ entry: entry.entry, code: 'plugin_api_mismatch' });
      continue;
    }
    if (!knownIds.includes(entry.id)) {
      rejected.push({ entry: entry.entry, code: 'plugin_unknown_id' });
      continue;
    }
    const entryPath = resolve(base, entry.entry);
    const rel = relative(base, entryPath);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      rejected.push({ entry: entry.entry, code: 'plugin_entry_outside_root' });
      continue;
    }
    if (!existsSync(entryPath)) {
      rejected.push({ entry: entry.entry, code: 'plugin_entry_missing' });
      continue;
    }
    packages.push({ id: entry.id, agent: entry.agent, entryPath });
  }
  return { packages, rejected };
}