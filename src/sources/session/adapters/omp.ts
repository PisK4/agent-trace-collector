/** OMP 本地会话：默认、profiles、XDG 与自定义 sessionDir 下的 JSONL。 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createJsonlSessionAdapter, expandHome } from './pi-jsonl';

/** `configRoot/profiles/<name>/<subdir>`；没有 profiles 目录时为空。 */
function profileRoots(configRoot: string, subdir: string): string[] {
  let entries;
  try {
    entries = readdirSync(join(configRoot, 'profiles'), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => join(configRoot, 'profiles', entry.name, subdir));
}

function ompRoots(env: NodeJS.ProcessEnv, home: string): string[] {
  const roots: string[] = [];
  const sessionDir = env.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (sessionDir) roots.push(expandHome(sessionDir, home));
  const agentDir = env.PI_CODING_AGENT_DIR?.trim();
  if (agentDir) roots.push(join(expandHome(agentDir, home), 'sessions'));

  const configRoot = expandHome(env.PI_CONFIG_DIR?.trim() || join(home, '.omp'), home);
  roots.push(join(configRoot, 'agent', 'sessions'), ...profileRoots(configRoot, 'agent/sessions'));
  // 切到自定义 PI_CONFIG_DIR 后，旧默认根里的会话仍应被发现。
  const defaultRoot = join(home, '.omp');
  if (defaultRoot !== configRoot) {
    roots.push(join(defaultRoot, 'agent', 'sessions'), ...profileRoots(defaultRoot, 'agent/sessions'));
  }

  const legacy = env.OMP_HOME?.trim();
  if (legacy) roots.push(join(expandHome(legacy, home), 'agent', 'sessions'));

  // OMP 在 XDG_DATA_HOME/omp 存在时把数据根切过去；profiles 也跟着切。
  const xdgData = env.XDG_DATA_HOME?.trim();
  if (xdgData) {
    const dataRoot = join(expandHome(xdgData, home), 'omp');
    roots.push(join(dataRoot, 'sessions'), ...profileRoots(dataRoot, 'sessions'));
  }
  return roots;
}

export const ompAdapter = createJsonlSessionAdapter({
  key: 'omp',
  sourceKind: 'omp_session',
  homeEnv: 'OMP_HOME',
  homeDir: '.omp',
  rootDirs: ompRoots,
});
