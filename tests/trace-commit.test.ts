import { expect, test } from 'bun:test';
import { planCommit } from '../web/trace-commit.js';

const item = (key: string, html = `<div>${key}</div>`) => ({ key, html });

test('渲染结果不变时计划为空：同键同 HTML 不建不删不换', () => {
  const shown = new Map([['a', '<div>a</div>'], ['b', '<div>b</div>']]);
  expect(planCommit(shown, [item('a'), item('b')])).toEqual({
    remove: [], create: [], replace: [], order: ['a', 'b'],
  });
});

test('只有可见结果变化的行进入替换清单', () => {
  const shown = new Map([['a', '<div>a</div>'], ['b', '<div>b</div>']]);
  expect(planCommit(shown, [item('a'), item('b', '<div>b2</div>')])).toEqual({
    remove: [], create: [], replace: ['b'], order: ['a', 'b'],
  });
});

test('新增与移除分开表达，已有的同键节点不重建', () => {
  const shown = new Map([['a', '<div>a</div>'], ['gone', '<div>gone</div>']]);
  expect(planCommit(shown, [item('a'), item('new')])).toEqual({
    remove: ['gone'], create: ['new'], replace: [], order: ['a', 'new'],
  });
});

test('prepend 只有创建，不替换或移动已有键', () => {
  const shown = new Map([['g:5', ''], ['end', '']]);
  expect(planCommit(shown, [item('g:1', ''), item('g:5', ''), item('end', '')])).toEqual({
    remove: [], create: ['g:1'], replace: [], order: ['g:1', 'g:5', 'end'],
  });
});

test('顺序按期望键序返回，落位由应用层执行', () => {
  const shown = new Map([['b', '<div>b</div>'], ['a', '<div>a</div>']]);
  const plan = planCommit(shown, [item('b'), item('a')]);
  expect(plan.order).toEqual(['b', 'a']);
  expect(plan.remove).toEqual([]);
  expect(plan.replace).toEqual([]);
});

test('重复键只认第一次出现，不在计划里重复落位', () => {
  const plan = planCommit(new Map(), [item('a'), item('a', '<div>other</div>')]);
  expect(plan.order).toEqual(['a']);
  expect(plan.create).toEqual(['a']);
});
