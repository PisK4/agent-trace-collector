import { expect, test } from 'bun:test';
import {
  isLiveSession, liveTimeCell, nextLiveExpiry, partitionLiveSessions, sessionsGroupLabel,
} from '../web/session-view.js';

const NOW = 1_700_000_100_000;
const row = (conv_key: string, last_ms: number, extra = {}) => ({
  conv_key, title: conv_key, last_ms, request_count: 1, agents: [], flags: [], ...extra,
});

test('活跃区与全部会话按服务端快照分区，且同一行只出现一次', () => {
  const rows = [
    row('a', NOW - 30_000, { live: true, inflight: false, live_until: NOW - 30_000 + 60_000 }),
    row('b', NOW - 90_000, { live: false, inflight: false, live_until: null }),
    row('c', NOW - 120_000, { live: true, inflight: true, live_until: null }),
  ];
  const { live, rest } = partitionLiveSessions(rows, NOW);
  expect(live.map(r => r.conv_key)).toEqual(['a', 'c']);
  expect(rest.map(r => r.conv_key)).toEqual(['b']);
  expect([...live, ...rest].map(r => r.conv_key)).toEqual(['a', 'c', 'b']);
});

test('渲染层只认服务端给出的 live_until，不自己重算 60 秒', () => {
  // 行上标了 live，但快照已过期：渲染层必须按 live_until 判出区。
  expect(isLiveSession(row('x', NOW - 20_000, { live: true, live_until: NOW - 1 }), NOW)).toBe(false);
  // 60 秒内的外部时间不再被前端解释成活跃。
  expect(isLiveSession(row('y', NOW - 1_000), NOW)).toBe(false);
});

test('活跃行右下只有「请求中」或最后更新时间，没有第三种字段', () => {
  const inflight = liveTimeCell(row('a', NOW - 1_000, { inflight: true }), () => '12:00');
  expect(inflight).toEqual({ text: '请求中', cls: 'is-live' });
  expect(liveTimeCell(row('b', NOW - 90_000), () => '12:00')).toEqual({ text: '12:00', cls: 'num' });
  expect(Object.keys(inflight)).toEqual(['text', 'cls']);
});

test('到期只排最近活跃行，在途行不设到期', () => {
  const rows = [
    row('a', NOW, { inflight: true }),
    row('b', NOW, { inflight: false, live_until: NOW + 20_000 }),
    row('c', NOW, { inflight: false, live_until: NOW + 50_000 }),
    row('d', NOW - 90_000, { live_until: null }),
  ];
  expect(nextLiveExpiry(rows, NOW)).toBe(NOW + 20_000);
  expect(nextLiveExpiry(rows.slice(0, 1), NOW)).toBeNull();
});

test('分组标题复用 group-label 结构并带计数', () => {
  expect(sessionsGroupLabel('活跃', 2)).toBe(
    '<div class="group-label"><span>活跃</span><span class="grp-n">2</span></div>',
  );
  expect(sessionsGroupLabel('全部会话', 0)).toContain('grp-n');
});
