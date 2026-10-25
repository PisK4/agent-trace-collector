import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
import { persistBody } from '../src/body';
import { enqueueDerive, drainDerive } from '../src/derive/sync';
import { listBgJobs } from '../src/queries/bg-jobs';

/**
 * OMP bash 后台作业配对：发起只认 role=3 工具结果、通知认两种完成形态、
 * conv 内最早位置、结算表的重建与保留语义。生产锚点文案直接进合成 fixture。
 */

const SPAWN_TEXT = 'Backgrounded as job bg_1 (sleep 2 && echo done)';

type ChatMessage = Record<string, unknown>;

function seedChatRound(
  store: ReturnType<typeof fixture>['store'],
  id: number,
  convKey: string,
  startedMs: number,
  messages: ChatMessage[],
): void {
  store.write(db => {
    db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
      body_state,derive_version,have,created_at,updated_at,sort_source,sort_key)
      VALUES (?,?,?,'known',?,'2026-10-25','hook','available',0,1,1,1,'ledger',?)`,
    [id, convKey, 'main', startedMs, `1:2:3:0|${String(id * 100).padStart(20, '0')}`]);
  });
  persistBody(store, id, {
    protocol: 'chat',
    request: { messages },
    reply: { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] },
    redact_version: 1,
  });
  // 用途冻结成参与链：本表只测配对，不让用途阶段重判覆盖种子。
  store.write(db => db.run('UPDATE request SET purpose_pending=0 WHERE req_id=?', [id]));
}

const user = (text: string): ChatMessage =>
  ({ role: 'user', content: [{ type: 'text', text }] });
const tool = (id: string, text: string): ChatMessage =>
  ({ role: 'tool', tool_call_id: id, content: text });

function bgRows(store: ReturnType<typeof fixture>['store'], convKey: string) {
  return store.read.query<{ job_id: string; spawn_req: number | null; spawn_ord: number | null;
    notice_req: number | null; notice_ord: number | null; state: string }, [string]>(
    'SELECT job_id,spawn_req,spawn_ord,notice_req,notice_ord,state FROM bg_job WHERE conv_key=?'
    + ' ORDER BY job_id').all(convKey);
}

test('bg_NNN 发起与通知跨两笔配对为 resolved，重发不改变最早位置', () => {
  const f = fixture();
  try {
    const conv = JSON.stringify(['session', 'bg-cross']);
    seedChatRound(f.store, 1, conv, 1000, [user('跑个后台任务')]);
    seedChatRound(f.store, 2, conv, 2000, [
      user('跑个后台任务'),
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: '{}' } }] },
      tool('c1', SPAWN_TEXT),
    ]);
    seedChatRound(f.store, 3, conv, 2500, [
      user('跑个后台任务'),
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: '{}' } }] },
      tool('c1', SPAWN_TEXT),
      user('<system-notice>Background job bg_1 has completed.</system-notice>'),
    ]);
    // req4 重发同一段历史：发起位置必须停在 req2。
    seedChatRound(f.store, 4, conv, 3000, [
      user('跑个后台任务'),
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: '{}' } }] },
      tool('c1', SPAWN_TEXT),
      user('<system-notice>Background job bg_1 has completed.</system-notice>'),
    ]);
    enqueueDerive(f.store, conv, 'main', '');
    drainDerive(f.store);
    expect(bgRows(f.store, conv)).toEqual([
      { job_id: 'bg_1', spawn_req: 2, spawn_ord: 2, notice_req: 3, notice_ord: 3, state: 'resolved' },
    ]);
    const jobs = listBgJobs(f.store, conv);
    expect(jobs[0]).toMatchObject({ job_id: 'bg_1', spawn_ms: 2000, notice_ms: 2500 });
  } finally { f.close(); }
});

test('发起与通知同笔配对为 resolved（同一请求内），复数通知与 Job 行都能配', () => {
  const f = fixture();
  try {
    const sameConv = JSON.stringify(['session', 'bg-same']);
    seedChatRound(f.store, 11, sameConv, 1000, [
      user('跑两个后台任务'),
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: '{}' } }] },
      tool('c1', 'Backgrounded as job bg_2 (echo a)'),
      user('<system-notice>Background job bg_2 has completed.</system-notice>'),
    ]);
    enqueueDerive(f.store, sameConv, 'main', '');
    drainDerive(f.store);
    expect(bgRows(f.store, sameConv)).toEqual([
      { job_id: 'bg_2', spawn_req: 11, spawn_ord: 2, notice_req: 11, notice_ord: 3, state: 'resolved' },
    ]);

    const pluralConv = JSON.stringify(['session', 'bg-plural']);
    seedChatRound(f.store, 21, pluralConv, 1000, [
      user('跑两个后台任务'),
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: '{}' } }] },
      tool('c1', 'Backgrounded as job bg_3 (echo a)\nBackgrounded as job bg_4 (echo b)'),
      user('<system-notice>2 background jobs have completed.\n── Job bg_3 ──\noutput a\n── Job bg_4 ──\noutput b</system-notice>'),
    ]);
    enqueueDerive(f.store, pluralConv, 'main', '');
    drainDerive(f.store);
    expect(bgRows(f.store, pluralConv)).toEqual([
      { job_id: 'bg_3', spawn_req: 21, spawn_ord: 2, notice_req: 21, notice_ord: 3, state: 'resolved' },
      { job_id: 'bg_4', spawn_req: 21, spawn_ord: 2, notice_req: 21, notice_ord: 3, state: 'resolved' },
    ]);
  } finally { f.close(); }
});

test('非作业通知与 role=0 复述不参与配对；通知缺失停在 pending', () => {
  const f = fixture();
  try {
    const conv = JSON.stringify(['session', 'bg-negative']);
    seedChatRound(f.store, 1, conv, 1000, [
      user('整理磁盘'),
      user('<system-notice>磁盘整理完成，共回收 3 GB。</system-notice>'),
      // role=0 里的发起复述（归档正文引用）不算发起痕迹。
      user('日志里写了 Backgrounded as job bg_9 (echo x)，但那是引用。'),
      tool('c0', '普通工具结果，没有后台化'),
    ]);
    seedChatRound(f.store, 2, conv, 2000, [
      user('跑一个不回通知的任务'),
      { role: 'assistant', content: null, tool_calls: [{ id: 'c2', function: { name: 'bash', arguments: '{}' } }] },
      tool('c2', 'Backgrounded as job bg_7 (sleep 999)'),
    ]);
    enqueueDerive(f.store, conv, 'main', '');
    drainDerive(f.store);
    expect(bgRows(f.store, conv)).toEqual([
      { job_id: 'bg_7', spawn_req: 2, spawn_ord: 2, notice_req: null, notice_ord: null, state: 'pending' },
    ]);
  } finally { f.close(); }
});

test('两端正文都回收的行保留，可读端重算不覆盖保留行', () => {
  const f = fixture();
  try {
    const conv = JSON.stringify(['session', 'bg-retain']);
    seedChatRound(f.store, 1, conv, 1000, [
      user('跑个后台任务'),
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: '{}' } }] },
      tool('c1', SPAWN_TEXT),
      user('<system-notice>Background job bg_1 has completed.</system-notice>'),
    ]);
    enqueueDerive(f.store, conv, 'main', '');
    drainDerive(f.store);
    expect(bgRows(f.store, conv)[0]).toMatchObject({ state: 'resolved' });
    // 正文回收后重派生：发起与通知的正文都没了，行原样保留，不冒充重建。
    f.store.write(db => db.run(
      "UPDATE request SET body_state='evicted', skeleton_z=NULL WHERE conv_key=?"));
    enqueueDerive(f.store, conv, 'main', '');
    drainDerive(f.store);
    expect(bgRows(f.store, conv)).toEqual([
      { job_id: 'bg_1', spawn_req: 1, spawn_ord: 2, notice_req: 1, notice_ord: 3, state: 'resolved' },
    ]);
  } finally { f.close(); }
});

test('排除用途的请求不参与配对', () => {
  const f = fixture();
  try {
    const conv = JSON.stringify(['session', 'bg-bypass']);
    seedChatRound(f.store, 1, conv, 1000, [
      user('<system-notice>Background job bg_5 has completed.</system-notice>'),
    ]);
    f.store.write(db => db.run(
      "UPDATE request SET purpose_chain='exclude', purpose_pending=0 WHERE req_id=1"));
    enqueueDerive(f.store, conv, 'main', '');
    drainDerive(f.store);
    expect(bgRows(f.store, conv)).toEqual([]);
  } finally { f.close(); }
});
