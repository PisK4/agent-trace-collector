import { expect, test } from 'bun:test';
import { CATALOG, catalogEntry } from '../src/sources/catalog';
import { droidSessionAdapter } from '../src/sources/session/adapters/droid';
import { SESSION_ADAPTERS } from '../src/sources/session/registry';

test('目录覆盖 Magpie 的 19 个本地 Agent，注册适配器都有实现条目', () => {
  expect(CATALOG).toHaveLength(19);
  expect(new Set(CATALOG.map(entry => entry.agent)).size).toBe(19);
  for (const adapter of SESSION_ADAPTERS) {
    const entry = catalogEntry(adapter.agent);
    expect(entry).not.toBeNull();
    expect(entry!.status).toBe('implemented');
    expect(entry!.sourceKind).toBe(adapter.sourceKind);
  }
  expect(catalogEntry('droid')).toMatchObject({
    status: 'implemented', sourceKind: 'droid_transcript',
  });
  expect(droidSessionAdapter.agent).toBe('droid');
});
