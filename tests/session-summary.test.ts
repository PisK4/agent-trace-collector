import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
import { persistBody } from '../src/body';
import { drainDerive, enqueueDerive } from '../src/derive/sync';
import {
  interruptCountOf, replyCallsOf, requestResultsOf,
} from '../src/derive/decision';
import { isUserInterruptMessage } from '../src/input-interpretation';
import { GROUP_ALGORITHM } from '../src/derive/state';
import { migrateSummaryFacts } from '../scripts/backfill-summary-facts';
import {
  getSummaryEntries, getSessionSummary,
} from '../src/queries/session-summary';
import type { Database } from 'bun:sqlite';

const GROUP = JSON.stringify(['session', 'summary']);
const ACTOR = 'main';
const MARKER = '[Request interrupted by user for tool use]';

/** 一条带工具调用的请求种子：request 消息与 reply 都由调用方给全。 */
function seedToolRound(
  store: ReturnType<typeof fixture>['store'],
  id: number,
  input: {
    startedMs: number;
    messages: unknown[];
    reply: unknown;
    sortIndex?: number;
  },
): void {
  store.write(db => {
    db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
      body_state,derive_version,have,created_at,updated_at,sort_source,sort_key)
      VALUES (?,?,'main','known',?,'2026-10-25','hook','pending',0,1,1,1,'ledger',?)`,
    [id, GROUP, input.startedMs, `1:2:3:0|${String((input.sortIndex ?? id) * 100).padStart(20, '0')}`]);
  });
  persistBody(store, id, {
    protocol: 'anthropic',
    request: { messages: input.messages },
    reply: input.reply,
    redact_version: 1,
  });
  store.write(db => db.run('UPDATE request SET purpose_pending=0 WHERE req_id=?', [id]));
}

function rebuild(store: ReturnType<typeof fixture>['store']): void {
  enqueueDerive(store, GROUP, ACTOR, '');
  drainDerive(store);
}

// ---------------------------------------------------------------------------
// 提取层：参数键、失败位与中断前缀各只有一份实现。
// ---------------------------------------------------------------------------

test('调用提取认 file_path/path 与 skill 键，其余近邻键落 NULL 不猜', () => {
  const reply = { content: [
    { type: 'tool_use', id: 'c1', name: 'Edit', input: { file_path: '/a/b.ts', other: 'x' } },
    { type: 'tool_use', id: 'c2', name: 'Skill', input: { skill: 'ponytail', args: {} } },
    { type: 'tool_use', id: 'c3', name: 'Bash', input: { command: 'ls', pattern: '/nope' } },
    { type: 'tool_use', id: 'c4', name: 'Read', input: { file_path: 42 } },
    { type: 'tool_use', id: 'c5', name: 'Write', input: {} },
    { type: 'tool_use', id: 'c6', name: 'read', input: { path: 'README.md', i: 'Reading' } },
  ] };
  expect(replyCallsOf('anthropic', reply)).toEqual([
    { id: 'c1', name: 'Edit', ord: 0, argPath: '/a/b.ts', argSkill: null },
    { id: 'c2', name: 'Skill', ord: 1, argPath: null, argSkill: 'ponytail' },
    // command/pattern 之类仍不是提取词汇；file_path 优先于 path。
    { id: 'c3', name: 'Bash', ord: 2, argPath: null, argSkill: null },
    { id: 'c4', name: 'Read', ord: 3, argPath: null, argSkill: null },
    { id: 'c5', name: 'Write', ord: 4, argPath: null, argSkill: null },
    // OMP 的 read/write/edit/grep 用 path 声明目标，补进提取词汇。
    { id: 'c6', name: 'read', ord: 5, argPath: 'README.md', argSkill: null },
  ]);
});

test('chat 形状的 arguments 字符串与对象都提取，坏 JSON 不抛错', () => {
  const objectArgs = replyCallsOf('chat', { choices: [{ message: {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'k1', type: 'function', function: {
      name: 'edit_file', arguments: { file_path: '/x.py' } },
    }],
  } }] });
  expect(objectArgs).toEqual([
    { id: 'k1', name: 'edit_file', ord: 0, argPath: '/x.py', argSkill: null },
  ]);
  const stringArgs = replyCallsOf('chat', { choices: [{ message: {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'k2', type: 'function', function: {
      name: 'skill', arguments: '{"skill":"de-AI-writing"}' } },
    ] },
  }] });
  expect(stringArgs[0]?.argSkill).toBe('de-AI-writing');
  const broken = replyCallsOf('chat', { choices: [{ message: {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'k3', type: 'function', function: {
      name: 'x', arguments: '{not json' } },
    ] },
  }] });
  expect(broken).toEqual([{ id: 'k3', name: 'x', ord: 0, argPath: null, argSkill: null }]);
});

test('失败位按协议缺省读：显式 true 才是失败，缺席与 chat 都是非失败', () => {
  const results = requestResultsOf('anthropic', { messages: [
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'e1', is_error: true, content: 'boom' },
      { type: 'tool_result', tool_use_id: 'e2', is_error: false, content: 'fine' },
      { type: 'tool_result', tool_use_id: 'e3', content: 'field absent' },
    ] },
  ] });
  expect(results.map(result => [result.id, result.isError])).toEqual([
    ['e1', 1], ['e2', 0], ['e3', 0],
  ]);
  // chat 用整条 role=tool 消息承载结果，没有失败通道。
  const chat = requestResultsOf('chat', { messages: [
    { role: 'tool', tool_call_id: 'e4', content: 'chat result' },
  ] });
  expect(chat.map(result => [result.id, result.isError])).toEqual([['e4', 0]]);
  // Responses 的结果项也没有独立失败位。
  const responses = requestResultsOf('responses', { input: [
    { type: 'function_call_output', call_id: 'e5', output: 'resp result' },
  ] });
  expect(responses.map(result => [result.id, result.isError, result.path])).toEqual([
    ['e5', 0, 'request.input[0]'],
  ]);
});

test('中断判定只认用户消息第一个文本块的开头前缀', () => {
  const marker = { role: 'user', content: [
    { type: 'text', text: `${MARKER}\n` },
    { type: 'tool_result', tool_use_id: 'x', content: 'r' },
  ] };
  expect(isUserInterruptMessage(marker)).toBe(true);
  // 大小写不敏感、首尾空白不管。
  expect(isUserInterruptMessage({ role: 'user', content: [
    { type: 'text', text: `  [REQUEST Interrupted by User for Tool Use] more` },
  ] })).toBe(true);
  // 摘要引用：短语在消息中段，开头是别的内容。
  expect(isUserInterruptMessage({ role: 'user', content: [
    { type: 'text', text: `This session continues from earlier. ${MARKER} happened before.` },
  ] })).toBe(false);
  // 非首个文本块与 tool_result 内文都不算。
  expect(isUserInterruptMessage({ role: 'user', content: [
    { type: 'text', text: '先说别的' },
    { type: 'text', text: MARKER },
  ] })).toBe(false);
  expect(isUserInterruptMessage({ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'x', content: MARKER },
  ] })).toBe(false);
  // 非用户角色与坏形状一律不算。
  expect(isUserInterruptMessage({ role: 'assistant', content: [
    { type: 'text', text: MARKER },
  ] })).toBe(false);
  expect(isUserInterruptMessage(null)).toBe(false);
  expect(isUserInterruptMessage('str')).toBe(false);
});

test('中断计数按 delta 归属，delta 之外不算', () => {
  const marker = { role: 'user', content: [{ type: 'text', text: MARKER }] };
  const plain = { role: 'user', content: [{ type: 'text', text: '继续' }] };
  const messages = [plain, marker, plain, marker];
  expect(interruptCountOf(messages, [0, 2])).toBe(0);
  expect(interruptCountOf(messages, [1])).toBe(1);
  expect(interruptCountOf(messages, [1, 3])).toBe(2);
  expect(interruptCountOf(messages, null)).toBe(0);
});

// ---------------------------------------------------------------------------
// 派生落库与端点口径：一次工具往返 + 一次中断的完整会话。
// ---------------------------------------------------------------------------

/** 三笔请求的可比链：req1 发起调用，req2 带中断标记与结果，req3 延续上下文。 */
function seedRoundWithInterrupt(store: ReturnType<typeof fixture>['store']): number[] {
  const userHello = { role: 'user', content: [{ type: 'text', text: '帮我看一下' }] };
  const callA = { type: 'tool_use', id: 'call-a', name: 'Edit',
    input: { file_path: '/repo/src/a.ts' } };
  const callB = { type: 'tool_use', id: 'call-b', name: 'Bash',
    input: { command: 'bun test' } };
  const markerMessage = { role: 'user', content: [
    { type: 'text', text: MARKER },
    { type: 'tool_result', tool_use_id: 'call-a', is_error: true, content: 'no match' },
  ] };
  seedToolRound(store, 1, {
    startedMs: 1000,
    messages: [userHello],
    reply: { content: [callA, callB] },
  });
  seedToolRound(store, 2, {
    startedMs: 2000,
    messages: [userHello,
      { role: 'assistant', content: [callA, callB] },
      markerMessage,
      { role: 'user', content: [{ type: 'text', text: '继续' }] },
    ],
    reply: { content: [{ type: 'tool_use', id: 'call-c', name: 'Read',
      input: { file_path: '/repo/src/a.ts' } }] },
  });
  seedToolRound(store, 3, {
    startedMs: 3000,
    messages: [userHello,
      { role: 'assistant', content: [callA, callB] },
      markerMessage,
      { role: 'user', content: [{ type: 'text', text: '继续' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call-c', name: 'Read',
        input: { file_path: '/repo/src/a.ts' } }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call-c', content: 'file body' },
      ] },
    ],
    reply: { content: [{ type: 'text', text: 'done' }] },
  });
  return [1, 2, 3];
}

test('汇总聚合：工具计数、路径分组、失败定位与中断只计一次', () => {
  const f = fixture();
  try {
    seedRoundWithInterrupt(f.store);
    rebuild(f.store);

    // 同一条中断标记随上下文延续进 req3，只在首次出现的 req2 计 1。
    const counts = f.store.read.query<{ req_id: number; interrupt_count: number | null }, []>(
      'SELECT req_id, interrupt_count FROM request ORDER BY req_id').all();
    expect(counts).toEqual([
      { req_id: 1, interrupt_count: 0 },
      { req_id: 2, interrupt_count: 1 },
      { req_id: 3, interrupt_count: 0 },
    ]);

    const summary = getSessionSummary(f.store, GROUP);
    // 工具按行计一行一次，同数按名字典序：Bash / Edit / Read。call-b 没有结果（pending）。
    expect(summary.tools).toEqual([
      { name: 'Bash', count: 1, paired: 0, error_known: 0, errors: 0 },
      { name: 'Edit', count: 1, paired: 1, error_known: 1, errors: 1 },
      { name: 'Read', count: 1, paired: 1, error_known: 1, errors: 0 },
    ]);
    // 路径按原始路径分组：Edit 记写入、Read 记读取，Bash 的 command 不进路径。
    expect(summary.paths).toEqual({
      written: [{ path: '/repo/src/a.ts', count: 1 }],
      read: [{ path: '/repo/src/a.ts', count: 1 }],
    });
    expect(summary.skills).toEqual([]);
    // 失败数 = 已判定结果里 is_error=true；失败集合带 req_id + ord 定位。
    expect(summary.coverage).toEqual({
      calls_total: 3, calls_paired: 2, calls_error_known: 2, calls_fact_known: 3,
    });
    expect(summary.failures).toEqual([{ req_id: 1, ord: 0, tool_name: 'Edit' }]);
    expect(summary.failures_truncated).toBe(false);
    expect(summary.interrupts).toEqual({ count: 1, requests: [2], unknown: 0 });
    expect(summary.dirty).toBe(false);
  } finally { f.close(); }
});

test('点击定位按组查支撑记录', () => {
  const f = fixture();
  try {
    seedRoundWithInterrupt(f.store);
    rebuild(f.store);
    expect(getSummaryEntries(f.store, GROUP, { kind: 'tool', name: 'Edit' }))
      .toEqual({ items: [{ req_id: 1, ord: 0, tool_name: 'Edit', state: 'resolved' }], truncated: false });
    expect(getSummaryEntries(f.store, GROUP, { kind: 'written', path: '/repo/src/a.ts' }))
      .toEqual({ items: [{ req_id: 1, ord: 0, tool_name: 'Edit', state: 'resolved' }], truncated: false });
    expect(getSummaryEntries(f.store, GROUP, { kind: 'read', path: '/repo/src/a.ts' }))
      .toEqual({ items: [{ req_id: 2, ord: 0, tool_name: 'Read', state: 'resolved' }], truncated: false });
    expect(getSummaryEntries(f.store, GROUP, { kind: 'interrupts' }))
      .toEqual({ requests: [{ req_id: 2, count: 1 }] });
  } finally { f.close(); }
});

test('OMP 小写工具的 path 参数进写入/读取分组，点击定位同认小写', () => {
  const f = fixture();
  try {
    const userHello = { role: 'user', content: [{ type: 'text', text: '写一下' }] };
    const writeCall = { type: 'tool_use', id: 'w1', name: 'write',
      input: { path: 'docs/x.md', content: '正文' } };
    const readCall = { type: 'tool_use', id: 'r1', name: 'read', input: { path: 'docs/x.md' } };
    seedToolRound(f.store, 1, {
      startedMs: 1000, messages: [userHello],
      reply: { content: [writeCall] },
    });
    seedToolRound(f.store, 2, {
      startedMs: 2000,
      messages: [userHello,
        { role: 'assistant', content: [writeCall] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'ok' }] }],
      reply: { content: [readCall] },
    });
    seedToolRound(f.store, 3, {
      startedMs: 3000,
      messages: [userHello,
        { role: 'assistant', content: [writeCall] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'ok' }] },
        { role: 'assistant', content: [readCall] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: '文件正文' }] }],
      reply: { content: [] },
    });
    rebuild(f.store);
    const summary = getSessionSummary(f.store, GROUP);
    expect(summary.paths).toEqual({
      written: [{ path: 'docs/x.md', count: 1 }],
      read: [{ path: 'docs/x.md', count: 1 }],
    });
    expect(getSummaryEntries(f.store, GROUP, { kind: 'written', path: 'docs/x.md' }))
      .toEqual({ items: [{ req_id: 1, ord: 0, tool_name: 'write', state: 'resolved' }], truncated: false });
    expect(getSummaryEntries(f.store, GROUP, { kind: 'read', path: 'docs/x.md' }))
      .toEqual({ items: [{ req_id: 2, ord: 0, tool_name: 'read', state: 'resolved' }], truncated: false });
  } finally { f.close(); }
});

test('ambiguous 不计失败；pending 不冒充零失败，coverage 如实', () => {
  const f = fixture();
  try {
    // 同 call_id 两笔调用：两行都 ambiguous，结果位置记下但不判失败。
    const call = { type: 'tool_use', id: 'dup', name: 'Bash', input: {} };
    seedToolRound(f.store, 1, { startedMs: 1000, messages: [], reply: { content: [call] } });
    seedToolRound(f.store, 2, { startedMs: 2000, messages: [], reply: { content: [call] } });
    f.store.write(db => db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,
      started_ms,day,via,body_state,derive_version,have,created_at,updated_at,sort_source,sort_key)
      VALUES (3,?,'main','known',3000,'2026-10-25','hook','available',0,1,1,1,'ledger','3')`, [GROUP]));
    persistBody(f.store, 3, { protocol: 'anthropic',
      request: { messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'dup', content: 'r' }] },
      ] },
      reply: { content: [] }, redact_version: 1 });
    rebuild(f.store);
    const summary = getSessionSummary(f.store, GROUP);
    expect(summary.tools).toEqual([
      { name: 'Bash', count: 2, paired: 0, error_known: 0, errors: 0 },
    ]);
    expect(summary.coverage).toEqual({
      calls_total: 2, calls_paired: 0, calls_error_known: 0, calls_fact_known: 2,
    });
    expect(summary.failures).toEqual([]);
  } finally { f.close(); }
});

test('保留行计数与明细列保留，coverage 反映缺口；中断未知不冒充 0', () => {
  const f = fixture();
  try {
    seedRoundWithInterrupt(f.store);
    rebuild(f.store);
    // 把 req2 的正文回收：下一轮重算只重建可读部分，req2 的行按保留处理。
    f.store.write(db => db.run(
      "UPDATE request SET body_state='evicted', skeleton_z=NULL WHERE req_id=2"));
    rebuild(f.store);
    const rows = f.store.read.query<{ req_id: number; arg_path: string | null;
      is_error: number | null; retention_state: string }, []>(
      'SELECT req_id,arg_path,is_error,retention_state FROM tool_call WHERE req_id=2').all();
    // req2 的保留行是它自己发起的 Read 调用：明细列与失败位（结果非失败）随行保留。
    expect(rows).toEqual([
      { req_id: 2, arg_path: '/repo/src/a.ts', is_error: 0, retention_state: 'retained' },
    ]);
    const summary = getSessionSummary(f.store, GROUP);
    // 中断计数不因回收清零：req2 的 1 次随行保留。req2 的证据消失后 req3 的
    // 前驱退到 req1，标记落在它的确定增量里，按 delta 归属再计 1——这是
    // 「回收后按可证证据重算」的诚实结果，不冒充 0 也不假装唯一。
    expect(summary.interrupts).toEqual({ count: 2, requests: [2, 3], unknown: 0 });
    expect(summary.coverage.calls_total).toBe(3);
    // req2 的行带着旧算法号被标保留：它的参数事实仍算已知（提取过才写进去），
    // 但本轮没有重算——fact_known 按算法号判，重算过的两笔加保留的一笔。
    expect(summary.coverage.calls_fact_known).toBe(3);
  } finally { f.close(); }
});

test('正文回收后从未算过的行：计数保留、事实缺口如实', () => {
  const f = fixture();
  try {
    seedRoundWithInterrupt(f.store);
    rebuild(f.store);
    // 造一笔从未在当前算法下算过的请求：回收正文 + 手工种旧行与 NULL 中断。
    f.store.write(db => {
      db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
        body_state,derive_version,have,created_at,updated_at,sort_source,sort_key)
        VALUES (9,?,'main','known',9000,'2026-10-25','hook','evicted',0,1,1,1,'ledger','9')`, [GROUP]);
      db.run(`INSERT INTO tool_call(call_id,req_id,ord,tool_name,state,derive_version)
        VALUES ('old-call',9,0,'Write','pending',1)`);
    });
    rebuild(f.store);
    const summary = getSessionSummary(f.store, GROUP);
    expect(summary.coverage.calls_total).toBe(4);
    expect(summary.coverage.calls_fact_known).toBe(3);
    // 从未判定的中断计进 unknown，不冒充 0。
    expect(summary.interrupts.unknown).toBe(1);
    // 保留行旧算法号不计 fact_known，但行本身照常计数。
    expect(summary.tools.some(tool => tool.name === 'Write' && tool.count === 1)).toBe(true);
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// totals 与 structure 的口径。
// ---------------------------------------------------------------------------

function seedUsageRow(store: ReturnType<typeof fixture>['store'], id: number, input: {
  startedMs: number; inTok?: number | null; outTok?: number | null;
  cacheRead?: number | null; cost?: number | null; costState?: string;
  promptTokens?: number | null; promptWindow?: number | null;
  model?: string | null; attempt?: number | null; purposeChain?: string;
}): void {
  store.write(db => {
    db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
      body_state,derive_version,have,created_at,updated_at,sort_source,sort_key,
      in_tok,out_tok,cache_read,cost,cost_state,attempt_count,purpose_chain)
      VALUES (?,?,'main','known',?,'2026-10-25','hook','pending',0,1,1,1,'ledger',?,
      ?,?,?,?,?,?,?)`,
    [id, GROUP, input.startedMs, `u|${String(id).padStart(20, '0')}`,
      input.inTok ?? null, input.outTok ?? null, input.cacheRead ?? null,
      input.cost ?? null, input.costState ?? 'absent', input.attempt ?? null,
      input.purposeChain ?? 'participate']);
    db.run('UPDATE request SET prompt_tokens=?, prompt_window=?, model_requested=? WHERE req_id=?',
      [input.promptTokens ?? null, input.promptWindow ?? null, input.model ?? null, id]);
  });
}

test('token、费用与缓存命中的会话口径：缺值进覆盖度，分母为空不给数', () => {
  const f = fixture();
  try {
    seedUsageRow(f.store, 1, { startedMs: 1, inTok: 100, outTok: 10, cacheRead: 900,
      cost: 0.5, costState: 'priced', promptTokens: 1000, promptWindow: 10000,
      model: 'm-a' });
    // cache_read 有、in_tok 缺：不进缓存分母（num/den 都只算两个读数都在的行）。
    seedUsageRow(f.store, 2, { startedMs: 2, cacheRead: 500, costState: 'unpriced',
      promptTokens: 2000, promptWindow: 10000, model: 'm-b' });
    // 全缺读数：SUM 落 NULL，不给 0。
    seedUsageRow(f.store, 3, { startedMs: 3 });
    const summary = getSessionSummary(f.store, GROUP);
    // 只有 cost_state='absent' 计进费用覆盖；unpriced 是另一态，不在其中。
    expect(summary.totals).toEqual({
      in_tok: 100, out_tok: 10, cost: 0.5, cost_absent: 1, cache_hit: 0.9,
    });
    // 峰值取 max(prompt_tokens / prompt_window)：10% 与 20% 取 20。
    expect(summary.structure.context_peak_pct).toBe(20);
    expect(summary.structure.models).toEqual([
      { name: 'm-a', count: 1 }, { name: 'm-b', count: 1 },
    ]);
    expect(summary.structure.requests_total).toBe(3);
    expect(summary.structure.main).toBe(3);
    expect(summary.structure.bypass).toBe(0);
  } finally { f.close(); }
});

test('缓存只有分母为零或全缺时 cache_hit 为 null', () => {
  const f = fixture();
  try {
    seedUsageRow(f.store, 1, { startedMs: 1, inTok: 0, cacheRead: 0 });
    expect(getSessionSummary(f.store, GROUP).totals.cache_hit).toBeNull();
    seedUsageRow(f.store, 2, { startedMs: 2, inTok: 10, cacheRead: 90 });
    expect(getSessionSummary(f.store, GROUP).totals.cache_hit).toBeCloseTo(0.9);
  } finally { f.close(); }
});

test('结构行：旁路计排除用途，重试与子代理按行与 actor 计', () => {
  const f = fixture();
  try {
    seedUsageRow(f.store, 1, { startedMs: 1, attempt: 1 });
    seedUsageRow(f.store, 2, { startedMs: 2, attempt: 3 });
    seedUsageRow(f.store, 3, { startedMs: 3, purposeChain: 'exclude' });
    // 子代理：同会话另一个 actor 组。
    f.store.write(db => db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,
      started_ms,day,via,body_state,derive_version,have,created_at,updated_at,
      sort_source,sort_key,purpose_chain)
      VALUES (4,?,'sub','known',4000,'2026-10-25','hook','pending',0,1,1,1,'ledger','4',
      'participate')`, [GROUP]));
    const summary = getSessionSummary(f.store, GROUP);
    expect(summary.structure).toMatchObject({
      requests_total: 4, main: 3, bypass: 1, retries: 1,
      subagent_actors: 1, subagent_requests: 1,
    });
  } finally { f.close(); }
});

test('组没算完时汇总带 dirty 标志，数字来自已发布事实', () => {
  const f = fixture();
  try {
    seedRoundWithInterrupt(f.store);
    rebuild(f.store);
    // 新增一笔但不派生：组变 dirty，已发布事实照常返回。
    seedToolRound(f.store, 4, { startedMs: 4000, messages: [], reply: { content: [] } });
    const summary = getSessionSummary(f.store, GROUP);
    expect(summary.dirty).toBe(true);
    expect(summary.tools.length).toBe(3);
  } finally { f.close(); }
});

test('排除用途的中断贡献按规则计 0，不算覆盖缺口', () => {
  const f = fixture();
  try {
    seedRoundWithInterrupt(f.store);
    // 分类器行：同会话排除用途，正文可读，输入里引用了中断短语（摘要引用不算）。
    f.store.write(db => db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,day,via,
      body_state,derive_version,have,created_at,updated_at,sort_source,sort_key,purpose_chain,req_kind)
      VALUES (7,?,'main','known',7000,'2026-10-25','hook','available',0,1,1,1,'ledger','7',
      'exclude','auto-mode-classifier')`, [GROUP]));
    persistBody(f.store, 7, { protocol: 'anthropic',
      request: { messages: [
        { role: 'user', content: [{ type: 'text', text: `综述：${MARKER} 之前发生过` }] },
      ] },
      reply: { content: [{ type: 'text', text: 'chat' }] }, redact_version: 1 });
    f.store.write(db => db.run('UPDATE request SET purpose_pending=0 WHERE req_id=7'));
    rebuild(f.store);
    // 排除是判定：写 0 不留 NULL，改判行也不带过期计数。
    expect(f.store.read.query<{ interrupt_count: number | null }, [number]>(
      'SELECT interrupt_count FROM request WHERE req_id=7').get(7)).toEqual({ interrupt_count: 0 });
    const summary = getSessionSummary(f.store, GROUP);
    // 排除行不进中断覆盖缺口；只有关系未知或正文不可读的参与行才算未知。
    expect(summary.interrupts).toEqual({ count: 1, requests: [2], unknown: 0 });
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// 迁移：幂等补列 + 视图重建，既有行不动、新列全 NULL。
// ---------------------------------------------------------------------------

test('migrateSummaryFacts 给缺列的库补列并重建视图，重复执行幂等', () => {
  const f = fixture();
  try {
    const db = f.store.db;
    seedRoundWithInterrupt(f.store);
    rebuild(f.store);
    // 模拟升级前的旧库：视图先删（列还被它们引用），再把十个新列全部去掉。
    db.exec('DROP VIEW IF EXISTS effective_request');
    db.exec('DROP VIEW IF EXISTS published_derive_request');
    db.exec('ALTER TABLE request DROP COLUMN interrupt_count');
    db.exec('ALTER TABLE tool_call DROP COLUMN arg_path');
    db.exec('ALTER TABLE tool_call DROP COLUMN arg_skill');
    db.exec('ALTER TABLE tool_call DROP COLUMN is_error');
    db.exec('ALTER TABLE derive_request_result DROP COLUMN interrupt_count');
    db.exec('ALTER TABLE derive_tool_result DROP COLUMN arg_path');
    db.exec('ALTER TABLE derive_tool_result DROP COLUMN arg_skill');
    db.exec('ALTER TABLE derive_tool_result DROP COLUMN is_error');
    db.exec('ALTER TABLE derive_call_work DROP COLUMN arg_path');
    db.exec('ALTER TABLE derive_call_work DROP COLUMN arg_skill');
    db.exec('ALTER TABLE derive_result_work DROP COLUMN is_error');
    const before = db.query<{ req_id: number; tool_name: string | null; state: string }, []>(
      'SELECT req_id, tool_name, state FROM tool_call ORDER BY req_id, ord').all();
    expect(before.length).toBe(3);

    migrateSummaryFacts(db);
    const columns = (table: string): string[] =>
      (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name);
    expect(columns('request')).toContain('interrupt_count');
    expect(columns('tool_call')).toEqual(expect.arrayContaining(['arg_path', 'arg_skill', 'is_error']));
    expect(columns('derive_request_result')).toContain('interrupt_count');
    expect(columns('derive_tool_result')).toEqual(expect.arrayContaining(['arg_path', 'arg_skill', 'is_error']));
    // 既有行不动：工具行的身份与配对状态原样；新列从 NULL 起步。
    expect(db.query<{ req_id: number; tool_name: string | null; state: string;
      arg_path: string | null; is_error: number | null }, []>(
      'SELECT req_id, tool_name, state, arg_path, is_error FROM tool_call ORDER BY req_id, ord').all(),
    ).toEqual(before.map(row => ({ ...row, arg_path: null, is_error: null })));
    // 视图重建后可查。
    expect(db.query('SELECT COUNT(*) AS n FROM effective_request').get()).not.toBeNull();

    migrateSummaryFacts(db);
    expect(db.query<{ arg_path: string | null }, []>(
      'SELECT arg_path FROM tool_call ORDER BY req_id').all()).toEqual([
      { arg_path: null }, { arg_path: null }, { arg_path: null },
    ]);
  } finally { f.close(); }
});
