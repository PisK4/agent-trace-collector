import { expect, test } from 'bun:test';
import type { Store } from '../src/store';
import { markRequestInputTx } from '../src/derive/state';
import { persistBodyTx } from '../src/body';
import {
  applyPurposeDecisionTx, applyPurposeErrorTx, drainRequestPurposesTx,
  readPurposeTaskTx, upgradePurposeTargetTx,
  type PurposeDrainResult, type PurposeTask,
} from '../src/request-purpose';
import { classifyPurpose } from '../src/harness/purpose';
import { PURPOSE_VERSION, type PurposeDecision } from '../src/semantics';
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
      purpose_status: 'recognized', purpose_version: PURPOSE_VERSION, purpose_chain: 'exclude',
      purpose_pending: 0, purpose_target: PURPOSE_VERSION, req_kind: 'auto-mode-classifier',
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
      purpose_status: 'error', purpose_pending: 0, purpose_retry: 3, purpose_target: PURPOSE_VERSION,
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
      purpose_status: 'retained', purpose_version: PURPOSE_VERSION, purpose_chain: 'exclude',
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
      purpose_status: 'recognized', purpose_version: PURPOSE_VERSION,
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
      purpose_status: 'unrecognized', purpose_version: PURPOSE_VERSION,
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
      purpose_target: PURPOSE_VERSION, purpose_pending: 1, purpose_version: 1,
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

const FINGERPRINT = 'You are a security monitor for autonomous AI coding agents.';

test('用途视图读取 Chat System 消息中的分类器指纹', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'chat-system', agent: 'claude', protocol: 'chat',
      messages: [{ role: 'system', content: FINGERPRINT }, { role: 'user', content: 'synthetic input' }],
      stop: ['</block>'],
      reply: { choices: [{ message: { role: 'assistant', content: '<block>no' } }] },
    });
    const task = readTask(f.store, id)!;
    expect(task.view.systemTexts).toEqual([FINGERPRINT]);
    expect(classifyPurpose(task.view)).toMatchObject({
      status: 'recognized', kind: 'auto-mode-classifier', chain: 'exclude',
    });
  } finally { f.close(); }
});

test('Chat 标准 stop 键与 developer 消息同样识别', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'chat-stop', agent: 'claude', protocol: 'chat',
      messages: [{ role: 'developer', content: FINGERPRINT }, { role: 'user', content: 'synthetic input' }],
      reply: { choices: [{ message: { role: 'assistant', content: '<block>no' } }] },
    });
    // 工厂把 stop 写进 stop_sequences；这里覆盖为标准 Chat 的 stop 键形状。
    f.store.write(db => persistBodyTx(db, id, {
      protocol: 'chat',
      request: {
        messages: [
          { role: 'developer', content: FINGERPRINT },
          { role: 'user', content: 'synthetic input' },
        ],
        stop: ['</block>'],
      },
      reply: { choices: [{ message: { role: 'assistant', content: '<block>no' } }] },
      redact_version: 1,
    }));
    const task = readTask(f.store, id)!;
    expect(task.view.systemTexts).toEqual([FINGERPRINT]);
    expect(task.view.stopSequences).toEqual(['</block>']);
    expect(classifyPurpose(task.view)).toMatchObject({
      status: 'recognized', kind: 'auto-mode-classifier', chain: 'exclude',
    });
  } finally { f.close(); }
});

test('Anthropic 顶层 system 对照识别，普通 System 不误判', () => {
  const f = fixture();
  try {
    const anthropic = seedPurposeRequest(f.store, {
      convKey: 'anthropic-top', agent: 'claude',
      system: FINGERPRINT,
      stop: ['</block>'],
      messages: [{ role: 'user', content: 'synthetic input' }],
      reply: { content: [{ type: 'text', text: '<block>no' }] },
    });
    const plain = seedPurposeRequest(f.store, {
      convKey: 'plain-system', agent: 'claude',
      messages: [{ role: 'system', content: '你是写作助手。' }, { role: 'user', content: 'hi' }],
      reply: { content: [{ type: 'text', text: 'hello' }] },
    });
    expect(classifyPurpose(readTask(f.store, anthropic)!.view)).toMatchObject({
      status: 'recognized', kind: 'auto-mode-classifier', chain: 'exclude',
    });
    expect(classifyPurpose(readTask(f.store, plain)!.view)).toMatchObject({
      status: 'unrecognized', kind: 'chat', chain: 'participate',
    });
  } finally { f.close(); }
});

test('System 块损坏进入用途错误路径，不产出无 System 的成功结论', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'corrupt-system', agent: 'claude', protocol: 'chat',
      messages: [{ role: 'system', content: FINGERPRINT }, { role: 'user', content: 'go' }],
      stop: ['</block>'],
      reply: { choices: [{ message: { role: 'assistant', content: '<block>no' } }] },
    });
    f.store.write(db => db.run(
      `UPDATE block SET z=x'00ff00ff' WHERE id IN
         (SELECT block FROM request_block WHERE req_id=? AND role=2)`, [id]));
    const result = drainPurposes(f.store);
    expect(result.failed).toBe(1);
    const row = purposeRow(f.store, id);
    expect(row.purpose_status).toBe('error');
    expect(row.req_kind).toBe('chat');
    expect(row.purpose_chain).toBe('participate');
  } finally { f.close(); }
});

test('普通 tick 不升级已完成历史，保留旧目标版本', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'old-done', agent: 'claude', protocol: 'chat',
      purposeTarget: PURPOSE_VERSION - 1, purposeVersion: PURPOSE_VERSION - 1,
      purposeStatus: 'unrecognized', purposePending: 0,
      messages: [{ role: 'system', content: FINGERPRINT }, { role: 'user', content: 'go' }],
      reply: { choices: [{ message: { role: 'assistant', content: '<block>no' } }] },
    });
    drainPurposes(f.store);
    const row = purposeRow(f.store, id);
    expect(row).toMatchObject({
      purpose_pending: 0, purpose_target: PURPOSE_VERSION - 1,
      purpose_version: PURPOSE_VERSION - 1, purpose_status: 'unrecognized',
    });
  } finally { f.close(); }
});

test('OMP skill 描述压缩调用按块首指纹判旁路，普通 OMP 对话不误判', () => {
  const f = fixture();
  try {
    const HINT = 'Compress into one routing hint of at most 12 words: reading schema docs.';
    // 块 0 是 system-reminder、块 1 才是指纹：判据按块首，不是消息首行。
    const id = seedPurposeRequest(f.store, {
      convKey: 'omp-hint', agent: 'omp', protocol: 'chat',
      messages: [{ role: 'user', content: [
        { type: 'text', text: '<system-reminder>Synthetic session context</system-reminder>' },
        { type: 'text', text: HINT },
      ] }],
      reply: { choices: [{ message: { role: 'assistant', content: 'routing hint text' } }] },
      purposeTarget: 1,
    });
    const task = readTask(f.store, id)!;
    expect(task.view.userBlockHeads[1]).toContain('Compress into one routing hint');
    drainPurposes(f.store);
    const row = purposeRow(f.store, id);
    expect(row).toMatchObject({
      purpose_status: 'recognized', purpose_version: PURPOSE_VERSION,
      purpose_chain: 'exclude', req_kind: 'skill_hint', purpose_rule: 'omp.skill-hint.v1',
    });
    // 普通对话不命中：同 agent、同形状，正文换成用户输入。
    const plain = seedPurposeRequest(f.store, {
      convKey: 'omp-plain', agent: 'omp', protocol: 'chat',
      messages: [{ role: 'user', content: '帮我看看派生结果' }],
      reply: { choices: [{ message: { role: 'assistant', content: 'ok' } }] },
      purposeTarget: 1,
    });
    drainPurposes(f.store);
    expect(purposeRow(f.store, plain)).toMatchObject({
      purpose_status: 'unrecognized', purpose_chain: 'participate', req_kind: 'chat',
    });
  } finally { f.close(); }
});
