import { expect, test } from 'bun:test';
import {
  createLivePartition, liveCommitAt, LIVE_COMMIT_MS, LIVE_SETTLE_MS,
} from '../web/session-view.js';

// NOW 正好落在整 30 秒提交点上，断言里可以直观看对齐结果。
const NOW = 1_700_000_100_000;
const row = (conv_key: string, last_ms: number, extra = {}) => ({
  conv_key, title: conv_key, last_ms, request_count: 1, agents: [], flags: [], ...extra,
});
const liveKeys = (p: { live: { conv_key: string }[] }) => p.live.map(r => r.conv_key);

test('沉降提交点是过期 + 保留期再对齐，不沿用 live_until', () => {
  const until = NOW + 20_000;
  expect(liveCommitAt(row('a', until - 60_000, { live_until: until }))).toBe(NOW + 90_000);
  // live_until 缺失时按同一口径从 last_ms 推算，不另造时间感。
  expect(liveCommitAt(row('b', NOW))).toBe(NOW + 120_000);
  expect(liveCommitAt(row('c', NOW - 10_000))).toBe(NOW + 120_000);
  expect(LIVE_SETTLE_MS + LIVE_COMMIT_MS).toBe(90_000);
});

test('刚过期不在那一刻下沉：等提交点再移出活跃区', () => {
  const p = createLivePartition();
  const until = NOW + 20_000;
  const r = row('a', until - 60_000, { live_until: until });
  const first = p.partition([r], NOW);
  expect(liveKeys(first)).toEqual(['a']);
  // 定时器基点必须是提交点，否则会在 live_until 处空转一次。
  expect(first.nextCommitAt).toBe(NOW + 90_000);
  // 已过期 10 秒：仍在保留期。
  const held = p.partition([r], NOW + 30_000);
  expect(liveKeys(held)).toEqual(['a']);
  expect(held.nextCommitAt).toBe(NOW + 90_000);
  // 到提交点才沉下去。
  const committed = p.partition([r], NOW + 90_000);
  expect(liveKeys(committed)).toEqual([]);
  expect(committed.rest.map(x => x.conv_key)).toEqual(['a']);
  expect(committed.nextCommitAt).toBeNull();
});

test('在途行豁免：首次出现就进活跃区，撤下也不等窗口', () => {
  const p = createLivePartition();
  const inflight = row('a', NOW - 300_000, { inflight: true });
  expect(liveKeys(p.partition([inflight], NOW))).toEqual(['a']);
  // 在途结束、也没有最近活动：立刻回全部会话，不享受保留期。
  const done = row('a', NOW - 300_000, { inflight: false, live_until: null });
  const after = p.partition([done], NOW + 1);
  expect(liveKeys(after)).toEqual([]);
  expect(after.rest.map(x => x.conv_key)).toEqual(['a']);
});

test('保留期内重新活跃不移动，提交点顺延', () => {
  const p = createLivePartition();
  const quiet = row('a', NOW - 40_000, { live_until: NOW + 20_000 });
  expect(liveKeys(p.partition([quiet], NOW))).toEqual(['a']);
  expect(liveKeys(p.partition([quiet], NOW + 30_000))).toEqual(['a']);
  // 新快照：同一行又更新了，仍在活跃区里，没有任何一次跨区移动。
  const fresh = row('a', NOW + 30_000, { live_until: NOW + 90_000 });
  const regrown = p.partition([fresh], NOW + 35_000);
  expect(liveKeys(regrown)).toEqual(['a']);
  expect(regrown.nextCommitAt).toBe(NOW + 150_000);
});

test('首次加载的旧会话不冒充活跃，即使已过提交点也不保留', () => {
  const p = createLivePartition();
  const stale = row('a', NOW - 70_000, { live_until: null });
  const result = p.partition([stale], NOW);
  expect(liveKeys(result)).toEqual([]);
  expect(result.nextCommitAt).toBeNull();
});

test('同一段内过期的会话共享一个提交点，只移动一次', () => {
  const p = createLivePartition();
  const a = row('a', NOW - 50_000, { live_until: NOW + 10_000 });
  const b = row('b', NOW - 47_000, { live_until: NOW + 13_000 });
  expect(liveCommitAt(a)).toBe(liveCommitAt(b));
  const first = p.partition([a, b], NOW);
  expect(liveKeys(first)).toEqual(['a', 'b']);
  expect(first.nextCommitAt).toBe(NOW + 90_000);
  const committed = p.partition([a, b], NOW + 90_000);
  expect(liveKeys(committed)).toEqual([]);
});
