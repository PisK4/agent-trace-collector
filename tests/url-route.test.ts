import { expect, test } from "bun:test";
import { demoFromParam, expandFromParam, summaryKindFromParam, traceIdFromParam } from '../web/url-route.js';

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

test('demo 参数只认 1', () => {
  expect(demoFromParam('1')).toBe(true);
  expect(demoFromParam('0')).toBe(false);
  expect(demoFromParam('true')).toBe(false);
  expect(demoFromParam(null)).toBe(false);
});

test('expand 参数只认 summary', () => {
  expect(expandFromParam('summary')).toBe('summary');
  expect(expandFromParam('tools')).toBeNull();
  expect(expandFromParam(null)).toBeNull();
});

test('summary 参数只收五个已知组', () => {
  expect(summaryKindFromParam('tool')).toBe('tool');
  expect(summaryKindFromParam('read')).toBe('read');
  expect(summaryKindFromParam('written')).toBe('written');
  expect(summaryKindFromParam('skill')).toBe('skill');
  expect(summaryKindFromParam('interrupts')).toBe('interrupts');
  expect(summaryKindFromParam('files')).toBeNull();
  expect(summaryKindFromParam(null)).toBeNull();
});
