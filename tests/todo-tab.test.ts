import { expect, test } from 'bun:test';
import { todoTabHtml } from '../web/todo-tab.js';

const failed = {
  key: 'session', actor: 'acme', turn: 1, state: 'failed' as const, snapshot: null,
};

test('请求态没有轮号时提示先选轮次，不显示读取中', () => {
  const html = todoTabHtml({ status: 'idle', data: null }, false);
  expect(html).toContain('选择轮次后查看待办');
  expect(html).not.toContain('读取中');
});

test('轮次态读取中与失败状态保持原样', () => {
  expect(todoTabHtml({ status: 'loading', data: null }, true)).toContain('读取中');
  expect(todoTabHtml({ status: 'ready', data: failed }, true)).toContain('读取失败');
});
