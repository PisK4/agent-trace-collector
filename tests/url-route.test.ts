import { expect, test } from 'bun:test';
import { traceIdFromParam } from '../web/url-route.js';

test('trace 参数只接受十进制正整数', () => {
  expect(traceIdFromParam('12')).toBe(12);
  expect(traceIdFromParam('0')).toBeNull();
  expect(traceIdFromParam('-3')).toBeNull();
  expect(traceIdFromParam('1.5')).toBeNull();
  expect(traceIdFromParam('abc')).toBeNull();
  expect(traceIdFromParam('')).toBeNull();
  expect(traceIdFromParam(null)).toBeNull();
  expect(traceIdFromParam('999999999999999999999')).toBeNull();
});
