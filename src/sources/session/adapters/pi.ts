/** Pi 本地会话：默认、自定义 agent 目录与 sessionDir 下的 JSONL。 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createJsonlSessionAdapter, expandHome } from './pi-jsonl';

/** 只读全局 settings.json 的 sessionDir；项目级设置没有可枚举的 cwd，不扫。 */
function sessionDirFromSettings(agentDir: string, home: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(join(agentDir, 'settings.json'), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const sessionDir = (parsed as Record<string, unknown>).sessionDir;
  if (typeof sessionDir !== 'string' || sessionDir.trim() === '') return null;
  return resolve(expandHome(sessionDir.trim(), home));
}

function piRoots(env: NodeJS.ProcessEnv, home: string): string[] {
  const roots: string[] = [];
  const sessionDir = env.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (sessionDir) roots.push(expandHome(sessionDir, home));

  const defaultAgent = join(home, '.pi', 'agent');
  const configuredAgent = env.PI_CODING_AGENT_DIR?.trim();
  const agentDir = configuredAgent ? expandHome(configuredAgent, home) : defaultAgent;
  roots.push(join(agentDir, 'sessions'));
  const configuredSession = sessionDirFromSettings(agentDir, home);
  if (configuredSession !== null) roots.push(configuredSession);

  // 切到自定义 agent 目录后，旧默认目录里的会话仍应被发现。
  if (agentDir !== defaultAgent) {
    roots.push(join(defaultAgent, 'sessions'));
    const defaultSession = sessionDirFromSettings(defaultAgent, home);
    if (defaultSession !== null) roots.push(defaultSession);
  }

  const legacy = env.PI_HOME?.trim();
  if (legacy) roots.push(join(expandHome(legacy, home), 'agent', 'sessions'));
  return roots;
}

export const piAdapter = createJsonlSessionAdapter({
  key: 'pi',
  sourceKind: 'pi_session',
  homeEnv: 'PI_HOME',
  homeDir: '.pi',
  rootDirs: piRoots,
});
