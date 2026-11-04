import { expect, test } from 'bun:test';
import { fixture, SEED_GROUP } from './fixtures';
import { todoByTurnWithParsers } from '../src/queries/todo-by-turn';
import { zcodeParser } from '../src/plugins/todo/parsers/zcode';
import { droidParser } from '../src/plugins/todo/parsers/droid';
import { piParser } from '../src/plugins/todo/parsers/pi';
import { ompParser } from '../src/plugins/todo/parsers/omp';
import type { TodoParser } from '../src/plugins/types';
import { seedTodoTurn } from './helpers/todo-turn';

const PARSERS: readonly TodoParser[] = [zcodeParser, droidParser, piParser, ompParser];

function readTurn(f: ReturnType<typeof fixture>) {
  return todoByTurnWithParsers(f.store, SEED_GROUP.convKey, SEED_GROUP.actor, 1, PARSERS);
}

test('zcode 全量快照命中，状态词原样保留', async () => {
  const f = fixture();
  try {
    seedTodoTurn(f.store, 'zcode', [{ name: 'TodoWrite', input: { todos: [
      { content: 'ship', status: 'pending', priority: 'high' },
      { content: 'test', status: 'completed' },
    ] } }]);
    const result = await readTurn(f);
    expect(result.state).toBe('ready');
    expect(result.snapshot?.items).toEqual([
      { content: 'ship', status: 'pending' }, { content: 'test', status: 'completed' },
    ]);
  } finally { f.close(); }
});

test('droid 编号文本行还原成列表', async () => {
  const f = fixture();
  try {
    seedTodoTurn(f.store, 'droid', [{ name: 'TodoWrite', input: { todos:
      '1. 第一项 in_progress\n2. 第二项 pending\n3. 第三项 completed' } }]);
    const result = await readTurn(f);
    expect(result.state).toBe('ready');
    expect(result.snapshot?.items.map(item => item.status)).toEqual([
      'in_progress', 'pending', 'completed',
    ]);
  } finally { f.close(); }
});

test('pi 增量命令：create 后 update 按 subject 改状态', async () => {
  const f = fixture();
  try {
    seedTodoTurn(f.store, 'pi', [
      { name: 'todo', input: { action: 'create', subject: 'ship' } },
      { name: 'todo', input: { action: 'update', subject: 'ship' } },
    ]);
    expect((await readTurn(f)).snapshot?.items).toEqual([{ content: 'ship', status: 'in_progress' }]);
  } finally { f.close(); }
});

test('omp chat 字符串参数：init/done 按索引改状态', async () => {
  const f = fixture();
  try {
    seedTodoTurn(f.store, 'omp', [
      { name: 'todo', input: { op: 'init', list: [
        { content: 'ship', status: 'pending' }, { content: 'test', status: 'pending' },
      ] } },
      { name: 'todo', input: { op: 'done', i: 0 } },
    ], 'chat');
    expect((await readTurn(f)).snapshot?.items).toEqual([
      { content: 'ship', status: 'completed' }, { content: 'test', status: 'pending' },
    ]);
  } finally { f.close(); }
});

test('形状相似但不命中：别家工具名判 absent', async () => {
  const f = fixture();
  try {
    seedTodoTurn(f.store, 'zcode', [{ name: 'Read', input: { todos: [{ content: 'x', status: 'pending' }] } }]);
    expect((await readTurn(f)).state).toBe('absent');
  } finally { f.close(); }
});

test('正文已回收如实返回 unavailable，不写成空列表', async () => {
  const f = fixture();
  try {
    seedTodoTurn(f.store, 'zcode', [{ name: 'TodoWrite', input: { todos: [
      { content: 'ship', status: 'pending' }] } }]);
    f.store.write(db => db.run(`UPDATE request SET body_state='evicted', skeleton_z=NULL WHERE req_id=1`));
    f.store.write(db => db.run('DELETE FROM request_block WHERE req_id=1'));
    const result = await readTurn(f);
    expect(result.state).toBe('unavailable');
    expect(result.snapshot).toBeNull();
  } finally { f.close(); }
});