import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixtures';
import { ompAdapter } from '../src/sources/session/adapters/omp';
import { piAdapter } from '../src/sources/session/adapters/pi';
import { discoverSessionFiles } from '../src/sources/session/ingest';

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'atc-session-roots-'));
}

function rootOf(home: string, ...parts: string[]): string {
  const root = join(home, ...parts);
  mkdirSync(root, { recursive: true });
  return root;
}

test('OMP 多根：默认、profiles、XDG、自定义 agent 与 sessionDir 都覆盖', () => {
  const home = makeHome();
  try {
    const defaultAgent = rootOf(home, '.omp', 'agent', 'sessions');
    const defaultProfile = rootOf(home, '.omp', 'profiles', 'alpha', 'agent', 'sessions');
    const customConfig = rootOf(home, 'custom-config', 'agent', 'sessions');
    const customProfile = rootOf(home, 'custom-config', 'profiles', 'beta', 'agent', 'sessions');
    const xdgRoot = rootOf(home, 'xdg', 'omp', 'sessions');
    const xdgProfile = rootOf(home, 'xdg', 'omp', 'profiles', 'gamma', 'sessions');
    const customAgent = rootOf(home, 'custom-agent', 'sessions');
    const customSession = rootOf(home, 'custom-sessions');
    const legacy = rootOf(home, 'legacy', 'agent', 'sessions');

    const roots = ompAdapter.roots({
      PI_CONFIG_DIR: join(home, 'custom-config'),
      PI_CODING_AGENT_DIR: join(home, 'custom-agent'),
      PI_CODING_AGENT_SESSION_DIR: join(home, 'custom-sessions'),
      XDG_DATA_HOME: join(home, 'xdg'),
      OMP_HOME: join(home, 'legacy'),
    }, home);

    for (const root of [
      defaultAgent, defaultProfile, customConfig, customProfile,
      xdgRoot, xdgProfile, customAgent, customSession, legacy,
    ]) {
      expect(roots).toContain(root);
    }
    expect(new Set(roots).size).toBe(roots.length);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Pi 多根：默认、自定义 agent、settings.sessionDir 与环境变量都覆盖', () => {
  const home = makeHome();
  try {
    const defaultAgent = rootOf(home, '.pi', 'agent', 'sessions');
    const defaultCustom = rootOf(home, 'pi-default-custom');
    writeFileSync(join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ sessionDir: join(home, 'pi-default-custom') }));

    const customAgentDir = join(home, 'pi-agent');
    const customAgent = rootOf(home, 'pi-agent', 'sessions');
    const customSetting = rootOf(home, 'pi-custom');
    writeFileSync(join(customAgentDir, 'settings.json'),
      JSON.stringify({ sessionDir: join(home, 'pi-custom') }));

    const envSession = rootOf(home, 'pi-env');
    const legacy = rootOf(home, 'pi-legacy', 'agent', 'sessions');

    const roots = piAdapter.roots({
      PI_CODING_AGENT_DIR: customAgentDir,
      PI_CODING_AGENT_SESSION_DIR: join(home, 'pi-env'),
      PI_HOME: join(home, 'pi-legacy'),
    }, home);

    for (const root of [defaultAgent, defaultCustom, customAgent, customSetting, envSession, legacy]) {
      expect(roots).toContain(root);
    }
    expect(new Set(roots).size).toBe(roots.length);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('重叠根只发现一次文件', async () => {
  const home = makeHome();
  const f = fixture();
  try {
    const root = rootOf(home, 'sessions');
    const nested = rootOf(home, 'sessions', 'nested');
    writeFileSync(join(nested, 'session.jsonl'), '{"type":"session","id":"synthetic"}\n');

    const files = await discoverSessionFiles(f.store, piAdapter, [root, nested], Date.now());
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe(join(nested, 'session.jsonl'));
  } finally {
    f.close();
    rmSync(home, { recursive: true, force: true });
  }
});
