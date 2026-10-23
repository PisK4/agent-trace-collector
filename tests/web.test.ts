import { expect, test } from 'bun:test';
import { auxSummary, isAuxRow, purposeLabel, resolveTraceTarget, restoreScroll } from '../web/app.js';

test('resolveTraceTarget 区分窗口内、canonical、窗口外与不存在', () => {
  const rows = [{ req_id: 1 }, { req_id: 2 }];
  expect(resolveTraceTarget(rows, 2, null)).toEqual({ kind: 'in-page', reqId: 2 });
  // 合并后的旧 id 解析成 canonical：canonical 在窗口里就直接跳过去。
  expect(resolveTraceTarget(rows, 9, { req_id: 1 })).toEqual({ kind: 'canonical', reqId: 1 });
  // canonical 不在窗口里：它存在，只是更早，不判缺失。
  expect(resolveTraceTarget(rows, 9, { req_id: 40 })).toEqual({ kind: 'off-page', reqId: null });
  expect(resolveTraceTarget(rows, 9, null)).toEqual({ kind: 'missing', reqId: null });
});

test('辅助行只由派生用途决定', () => {
  expect(isAuxRow({ purpose_chain: 'exclude', chain_role: 'main' })).toBe(true);
  expect(isAuxRow({ purpose_chain: 'participate', chain_role: 'aux' })).toBe(true);
  expect(isAuxRow({ purpose_chain: 'participate', chain_role: 'main' })).toBe(false);
  // 摘要文本里的字样不参与判断。
  expect(isAuxRow({ purpose_chain: 'participate', chain_role: 'main', reply_preview: '辅助请求' })).toBe(false);
});

test('未知用途保留原始 ID', () => {
  expect(purposeLabel('synthetic_probe')).toBe('synthetic_probe');
  expect(purposeLabel(null)).toBe('未知用途');
  expect(purposeLabel('title')).toBe('标题生成');
});

test('分类器摘要显示判定', () => {
  expect(auxSummary({ req_kind: 'auto-mode-classifier', reply_preview: '<block>no</block>' })).toContain('放行');
  expect(auxSummary({ req_kind: 'auto-mode-classifier', reply_preview: '<block>yes</block>' })).toContain('拦截');
  expect(auxSummary({ req_kind: 'auto-mode-classifier', reply_preview: 'garbage' })).toContain('判定未知');
  expect(auxSummary({ req_kind: 'title', model_title: '空状态排查' })).toContain('空状态排查');
});

test('滚动恢复夹在可滚动范围内', () => {
  const element = { scrollHeight: 200, clientHeight: 100, scrollTop: 0 };
  expect(restoreScroll(element, 150)).toBe(100);
  expect(restoreScroll(element, -5)).toBe(0);
  expect(restoreScroll(element, 80)).toBe(80);
});
