import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, SEED_GROUP } from './fixtures';
import { getTodoByTurn } from '../src/queries/todo-by-turn';
import { loadCommunityPlugins } from '../src/plugins/runtime/manifest';
import { communitySources, createCommunityWorker } from '../src/plugins/runtime/worker';
import { seedTodoTurn } from './helpers/todo-turn';

const MANIFEST = (entry: string, overrides: Record<string, unknown> = {}) => JSON.stringify({
  plugins: [{ id: 'todo', api: 1, agent: 'acme', entry, ...overrides }],
});

/** 合成社区包目录：包文件与清单都落在临时目录，不碰真实数据目录。 */
function tempRoot(packageSource: string, manifest = MANIFEST('acme/index.ts')): string {
  const root = mkdtempSync(join(tmpdir(), 'atc-plugin-'));
  mkdirSync(join(root, 'acme'));
  writeFileSync(join(root, 'acme', 'index.ts'), packageSource);
  writeFileSync(join(root, 'plugins.json'), manifest);
  return root;
}

/** 只交 DTO 的最小包：认领 acme 的 acme_todo 工具。 */
const PARSING_PACKAGE = `
export const parsers = [{
  agent: 'acme',
  parse(call, previous) {
    if (call.toolName !== 'acme_todo') return null;
    return { seq: (previous?.seq ?? 0) + 1, items: call.input.items };
  },
}];
`;

async function readWithCommunity(store: Parameters<typeof seedTodoTurn>[0],
  root: string, worker: ReturnType<typeof createCommunityWorker>) {
  const load = loadCommunityPlugins(root, ['todo']);
  return getTodoByTurn(store, SEED_GROUP.convKey, SEED_GROUP.actor, 1,
    communitySources(load.packages, worker));
}

test('清单缺失按没有社区包处理，坏包给固定分类码', () => {
  expect(loadCommunityPlugins(join(tmpdir(), 'atc-plugin-does-not-exist'), ['todo']))
    .toEqual({ packages: [], rejected: [] });

  const root = mkdtempSync(join(tmpdir(), 'atc-plugin-'));
  try {
    writeFileSync(join(root, 'plugins.json'), '{not json');
    expect(loadCommunityPlugins(root, ['todo']).rejected[0]?.code).toBe('plugin_manifest_invalid');

    writeFileSync(join(root, 'plugins.json'), MANIFEST('acme/index.ts', { api: 2 }));
    expect(loadCommunityPlugins(root, ['todo']).rejected[0]?.code).toBe('plugin_api_mismatch');

    writeFileSync(join(root, 'plugins.json'), MANIFEST('acme/index.ts', { id: 'plan' }));
    expect(loadCommunityPlugins(root, ['todo']).rejected[0]?.code).toBe('plugin_unknown_id');

    writeFileSync(join(root, 'plugins.json'), MANIFEST('../outside.ts'));
    expect(loadCommunityPlugins(root, ['todo']).rejected[0]?.code).toBe('plugin_entry_outside_root');

    writeFileSync(join(root, 'plugins.json'), MANIFEST('acme/missing.ts'));
    expect(loadCommunityPlugins(root, ['todo']).rejected[0]?.code).toBe('plugin_entry_missing');

    mkdirSync(join(root, 'acme'));
    writeFileSync(join(root, 'acme', 'index.ts'), PARSING_PACKAGE);
    writeFileSync(join(root, 'plugins.json'), MANIFEST('acme/index.ts'));
    const valid = loadCommunityPlugins(root, ['todo']);
    expect(valid.rejected).toEqual([]);
    expect(valid.packages).toEqual([
      { id: 'todo', agent: 'acme', entryPath: join(root, 'acme', 'index.ts') },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('社区包按 agent 认领并折叠，内置轨不受影响', async () => {
  const root = tempRoot(PARSING_PACKAGE);
  const worker = createCommunityWorker();
  const f = fixture();
  const z = fixture();
  try {
    seedTodoTurn(f.store, 'acme', [{ name: 'acme_todo', input: { items: [
      { content: 'ship', status: 'pending' },
    ] } }]);
    const result = await readWithCommunity(f.store, root, worker);
    expect(result.state).toBe('ready');
    expect(result.snapshot?.items).toEqual([{ content: 'ship', status: 'pending' }]);

    seedTodoTurn(z.store, 'zcode', [{ name: 'TodoWrite', input: { todos: [
      { content: 'builtin', status: 'pending' }] } }]);
    const builtin = await readWithCommunity(z.store, root, worker);
    expect(builtin.state).toBe('ready');
    expect(builtin.snapshot?.items).toEqual([{ content: 'builtin', status: 'pending' }]);
  } finally {
    worker.close();
    f.close();
    z.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('社区包抛错只让该轮 failed，不冒充没有待办', async () => {
  const root = tempRoot(`export const parsers = [{
    agent: 'acme', parse() { throw new Error('boom'); },
  }];`);
  const worker = createCommunityWorker();
  const f = fixture();
  try {
    seedTodoTurn(f.store, 'acme', [{ name: 'acme_todo', input: { items: [] } }]);
    const result = await readWithCommunity(f.store, root, worker);
    expect(result.state).toBe('failed');
    expect(result.snapshot).toBeNull();
  } finally {
    worker.close();
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('社区包超时被 terminate，该轮 failed', async () => {
  const root = tempRoot(`export const parsers = [{
    agent: 'acme', parse() { while (true) {} },
  }];`);
  const worker = createCommunityWorker({ timeoutMs: 100 });
  const f = fixture();
  try {
    seedTodoTurn(f.store, 'acme', [{ name: 'acme_todo', input: { items: [] } }]);
    const result = await readWithCommunity(f.store, root, worker);
    expect(result.state).toBe('failed');
    expect(result.snapshot).toBeNull();
  } finally {
    worker.close();
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('社区包交回畸形 DTO 同样 failed，不写进页签', async () => {
  const root = tempRoot(`export const parsers = [{
    agent: 'acme', parse() { return { seq: 1, items: [{ content: 'x' }] }; },
  }];`);
  const worker = createCommunityWorker();
  const f = fixture();
  try {
    seedTodoTurn(f.store, 'acme', [{ name: 'acme_todo', input: { items: [] } }]);
    const result = await readWithCommunity(f.store, root, worker);
    expect(result.state).toBe('failed');
    expect(result.snapshot).toBeNull();
  } finally {
    worker.close();
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});