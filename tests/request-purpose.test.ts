import { expect, test } from 'bun:test';
import type { Store } from '../src/store';
import { markRequestInputTx } from '../src/derive-state';
import {
  applyPurposeDecisionTx, applyPurposeErrorTx, drainRequestPurposesTx,
  readPurposeTaskTx, upgradePurposeTargetTx,
  type PurposeDrainResult, type PurposeTask,
} from '../src/request-purpose';
import { classifyPurpose, type PurposeDecision } from '../src/semantics';
import { fixture, seedPurposeRequest } from './fixtures';

function drainPurposes(store: Store, limit = 100): PurposeDrainResult {
  return store.write(db => drainRequestPurposesTx(db, limit));
}

function readTask(store: Store, id: number): PurposeTask | null {
  return readPurposeTaskTx(store.read, id);
}

function applyDecision(
  store: Store, task: PurposeTask, decision: PurposeDecision,
): 'applied' | 'stale' {
  return store.write(db => applyPurposeDecisionTx(db, task, decision));
}

function applyError(store: Store, task: PurposeTask) {
  return store.write(db => applyPurposeErrorTx(db, task));
}

function upgrade(store: Store, convKey: string): number {
  return store.write(db => upgradePurposeTargetTx(db, convKey));
}

type PurposeRow = {
  purpose_status: string; purpose_version: number | null; purpose_rule: string | null;
  purpose_chain: string; purpose_pending: number; purpose_revision: number;
  purpose_target: number; purpose_retry: number; purpose_signals: string;
  req_kind: string; model_title: string | null; input_revision: number;
};

function purposeRow(store: Store, id: number): PurposeRow {
  return store.read.query<PurposeRow, [number]>(`
    SELECT purpose_status, purpose_version, purpose_rule, purpose_chain, purpose_pending,
      purpose_revision, purpose_target, purpose_retry, purpose_signals, req_kind,
      model_title, input_revision
    FROM request WHERE req_id=?`).get(id)!;
}

test('分类器指纹在写入时按 CAS 结算用途并标脏所属组', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'classifier',
      system: 'You are a security monitor for autonomous AI coding agents.',
      stop: ['</block>'],
      messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }],
      reply: { content: [{ type: 'text', text: '<block>no' }] },
      cleanGroup: true,
      purposeTarget: 1,
    });
    const result = drainPurposes(f.store);
    expect(result).toMatchObject({ processed: 1, applied: 1, remaining: 0 });
    const row = purposeRow(f.store, id);
    expect(row).toMatchObject({
      purpose_status: 'recognized', purpose_version: 2, purpose_chain: 'exclude',
      purpose_pending: 0, purpose_target: 2, req_kind: 'auto-mode-classifier',
    });
    expect(JSON.parse(row.purpose_signals)).toContain('classifier.verdict.pass');
    expect(f.store.read.query<{ state: string }, [string, string]>(
      'SELECT state FROM derive_queue WHERE conv_key=? AND actor=?').get('classifier', 'actor'))
      .toEqual({ state: 'dirty' });
  } finally { f.close(); }
});

test('输入修订变化后旧解释写回是 stale', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'stale',
      reply: { content: [{ type: 'text', text: 'plain' }] },
    });
    const task = readTask(f.store, id)!;
    f.store.write(db => db.run(
      'UPDATE request SET input_revision=input_revision+1 WHERE req_id=?', [id]));
    expect(applyDecision(f.store, task, classifyPurpose(task.view))).toBe('stale');
    expect(purposeRow(f.store, id).purpose_pending).toBe(1);
  } finally { f.close(); }
});

test('用途错误最多重试三次，终态消费当前修订', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, { convKey: 'retry' });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const task = readTask(f.store, id)!;
      expect(applyError(f.store, task)).toEqual({
        result: 'applied', terminal: attempt === 3,
      });
    }
    const terminal = purposeRow(f.store, id);
    expect(terminal).toMatchObject({
      purpose_status: 'error', purpose_pending: 0, purpose_retry: 3, purpose_target: 2,
    });
    expect(terminal.purpose_revision).toBe(terminal.input_revision);
    f.store.write(db => markRequestInputTx(db, id));
    expect(purposeRow(f.store, id)).toMatchObject({
      purpose_pending: 1, purpose_retry: 0,
    });
  } finally { f.close(); }
});

test('正文回收后新修订保留旧用途', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'retained',
      reply: { content: [{ type: 'text', text: '<title>旧标题</title>' }] },
    });
    drainPurposes(f.store);
    f.store.write(db => {
      db.run('UPDATE request SET body_state=\'evicted\', skeleton_z=NULL WHERE req_id=?', [id]);
      markRequestInputTx(db, id);
    });
    drainPurposes(f.store);
    expect(purposeRow(f.store, id)).toMatchObject({
      purpose_status: 'retained', purpose_version: 2, purpose_chain: 'exclude',
      req_kind: 'title', model_title: '旧标题',
    });
  } finally { f.close(); }
});

test('末条消息块缺失时不把 partial 当完整用途', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'partial',
      messages: [{ role: 'user', content: 'one' }],
      reply: { content: [{ type: 'text', text: '<title>不应识别</title>' }] },
    });
    f.store.write(db => {
      db.run('DELETE FROM request_block WHERE req_id=?', [id]);
      markRequestInputTx(db, id);
    });
    drainPurposes(f.store);
    expect(purposeRow(f.store, id)).toMatchObject({
      purpose_status: 'missing', req_kind: 'chat', purpose_pending: 0,
    });
  } finally { f.close(); }
});

test('来源 title 别名在正文不可读时仍能识别', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'source', bodyState: 'evicted', sourceKind: 'title',
    });
    expect(drainPurposes(f.store).applied).toBe(1);
    expect(purposeRow(f.store, id)).toMatchObject({
      purpose_status: 'recognized', purpose_version: 2,
      req_kind: 'title', purpose_chain: 'exclude', model_title: null,
    });
  } finally { f.close(); }
});

test('普通对话记为 unrecognized，不支持的协议记为 unsupported', () => {
  const f = fixture();
  try {
    const chat = seedPurposeRequest(f.store, {
      convKey: 'plain', reply: { content: [{ type: 'text', text: 'hello' }] },
    });
    const other = seedPurposeRequest(f.store, {
      convKey: 'unsupported', protocol: 'gemini',
      reply: { content: [{ type: 'text', text: 'hello' }] },
    });
    drainPurposes(f.store);
    expect(purposeRow(f.store, chat)).toMatchObject({
      purpose_status: 'unrecognized', purpose_version: 2,
      req_kind: 'chat', purpose_chain: 'participate',
    });
    expect(purposeRow(f.store, other)).toMatchObject({
      purpose_status: 'unsupported', purpose_version: null,
    });
  } finally { f.close(); }
});

test('目标升级只改显式会话并保留旧解释', () => {
  const f = fixture();
  try {
    const target = seedPurposeRequest(f.store, {
      convKey: 'target', purposeTarget: 1, purposeVersion: 1,
      purposeStatus: 'recognized', purposeRule: 'legacy.title',
      purposeChain: 'exclude', reqKind: 'title', modelTitle: '旧',
      purposePending: 0, cleanGroup: true,
    });
    const other = seedPurposeRequest(f.store, {
      convKey: 'other', purposeTarget: 1, purposeVersion: 1,
      purposeStatus: 'recognized', purposePending: 0, cleanGroup: true,
    });
    expect(upgrade(f.store, 'target')).toBe(1);
    expect(purposeRow(f.store, target)).toMatchObject({
      purpose_target: 2, purpose_pending: 1, purpose_version: 1,
      purpose_status: 'recognized', req_kind: 'title', model_title: '旧',
    });
    expect(purposeRow(f.store, other)).toMatchObject({
      purpose_target: 1, purpose_pending: 0, purpose_version: 1,
    });
    expect(f.store.read.query<{ state: string }, [string]>(
      'SELECT state FROM derive_queue WHERE conv_key=?').get('target'))
      .toEqual({ state: 'dirty' });
  } finally { f.close(); }
});
