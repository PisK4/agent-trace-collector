import { expect, test } from 'bun:test';
import { compact, secs, tierOf, TIER_LIMITS, toolCategory } from '../web/duration.js';

test('紧凑时长按量级换单位，不为凑整印出 60.0s', () => {
  expect(compact(0)).toBe('0ms');
  expect(compact(180)).toBe('180ms');
  expect(compact(999)).toBe('999ms');
  expect(compact(1000)).toBe('1.0s');
  expect(compact(4200)).toBe('4.2s');
  expect(compact(59_949)).toBe('59.9s');
  expect(compact(59_950)).toBe('1m 00s');
  expect(compact(873_000)).toBe('14m 33s');
  expect(compact(3_600_000)).toBe('60m 00s');
});

test('两位小数秒是右栏密度，缺值写 —', () => {
  expect(secs(2310)).toBe('2.31 s');
  expect(secs(0)).toBe('0.00 s');
  expect(secs(null)).toBe('—');
});

test('档位阈值闭区间：等于第一档仍是 good，超过第二档才 bad', () => {
  expect(tierOf(1000, TIER_LIMITS.file!)).toBe('good');
  expect(tierOf(1001, TIER_LIMITS.file!)).toBe('warn');
  expect(tierOf(10_000, TIER_LIMITS.file!)).toBe('warn');
  expect(tierOf(10_001, TIER_LIMITS.file!)).toBe('bad');
});

test('工具按名字取类别，未登记归命令，等待型没有阈值', () => {
  expect(toolCategory('Read')).toBe('file');
  expect(toolCategory('bash')).toBe('command');
  expect(toolCategory('WebFetch')).toBe('web');
  expect(toolCategory('SendMessage')).toBe('agent');
  expect(toolCategory('AskUserQuestion')).toBe('wait');
  expect(TIER_LIMITS[toolCategory('AskUserQuestion')]).toBeUndefined();
  // 未登记的工具走通用命令档，不因为没有专门阈值就不上色。
  expect(toolCategory('未登记的工具')).toBe('command');
  expect(toolCategory(null)).toBe('command');
});
