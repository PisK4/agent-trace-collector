import { expect, test } from 'bun:test';
import { fixture, seedPurposeRequest, seedDeriveRound, deriveSnapshot, rebuildDeriveGroup, DERIVE_GROUP, DERIVE_ACTOR } from './fixtures';
import { deriveTitle } from '../src/derive/decision';
import { messageFingerprint } from '../src/fingerprint';
import { drainDerive, enqueueDerive } from '../src/derive/sync';
import { modelTimeTitle } from '../src/format';
import { interpretMessage } from '../src/input-interpretation';
import { persistBody, readBodyTx } from '../src/body';
import { evictOldestBodyBatch } from '../src/retention';

// 展示与标题：标题来源、清洗规则与回复形状位。
test('同一请求的多条新增用户消息逐条保留，标题取首条', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>x</system-reminder>\n第一条' }] },
    { role: 'user', content: [{ type: 'text', text: '第二条' }] },
  ];
  expect(deriveTitle(messages, [0, 1], 'fallback')).toEqual({ title: '第一条', source: 'user_delta' });
  expect(interpretMessage(messages[1], null, 1).input?.text).toBe('第二条');
});

test('未知 agent 不改变既有标题清洗', () => {
  expect(deriveTitle(
    [{ role: 'user', content: '<session>旧规则仍生效</session>' }],
    [0],
    'fallback',
    null,
  )).toEqual({ title: '旧规则仍生效', source: 'user_delta' });
});

test('展示解释不改写消息对象与指纹', () => {
  const message = { role: 'user', content: '<session>原文</session>' };
  const before = messageFingerprint(message);
  expect(interpretMessage(message, 'claude', 0).input?.text).toBe('原文');
  expect(messageFingerprint(message)).toBe(before);
  expect(message).toEqual({ role: 'user', content: '<session>原文</session>' });
});

test('标题取首个新增用户文本并去掉 harness 包装', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>noise</system-reminder>\n修复登录错误' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'not a title' }] },
  ];
  const derived = deriveTitle(messages, [0, 1], 'model · 10:00');
  expect(derived).toEqual({ title: '修复登录错误', source: 'user_delta' });
});

test('会话外壳、技能注入与 harness 提示都不当标题', () => {
  const fallback = 'model · 10:00';
  const cases = [
    ['<session>\n评估压缩机制文档\n/de-AI-writing\n</session>', '评估压缩机制文档'],
    ['Base directory for this skill: /Users/pis/.claude/skills/x\n\n# 技能正文', fallback],
    ['The user stepped away and is coming back. Recap in under 40 words.', fallback],
    ['<command-name>/auto-mode-setup</command-name>\n<command-args></command-args>\n\n改', '改'],
    ['<transcript>\n{"user":"历史"}\n</transcript>', fallback],
  ];
  for (const [text, expected] of cases) {
    const derived = deriveTitle([{ role: 'user', content: [{ type: 'text', text }] }], [0], fallback);
    expect(derived.title).toBe(expected);
  }
});

test('没有用户增量时回落到模型时间', () => {
  expect(deriveTitle([{ role: 'assistant', content: 'only assistant' }], [0], 'fallback')).toEqual({
    title: 'fallback', source: 'model_time',
  });
  expect(deriveTitle([{ role: 'user', content: 'x' }], null, 'fallback')).toEqual({
    title: 'fallback', source: 'model_time',
  });
});

test('标题按 Unicode 字符截到 60 字', () => {
  const long = '中'.repeat(80);
  const derived = deriveTitle([{ role: 'user', content: long }], [0], 'fallback');
  expect([...derived.title].length).toBe(60);
});

test('标题取首行且压空白', () => {
  const derived = deriveTitle([{ role: 'user', content: 'first   line\nsecond' }], [0], 'fallback');
  expect(derived.title).toBe('first line');
});

test('可读工具轮次标题不依赖旧值且缺正文标题保留', () => {
  const f = fixture();
  try {
    seedDeriveRound(f.store, [1, 2]);
    f.store.write(db => {
      db.run(`UPDATE request SET title='stale derived title',title_source='user_delta'
        WHERE req_id=2`);
      db.run(`INSERT INTO request(req_id,conv_key,actor,actor_state,started_ms,
        day,via,body_state,derive_version,have,created_at,updated_at,title,title_source)
        VALUES (3,?,?,'known',3000,'2026-10-22','hook','evicted',0,1,1,1,
        'retained title','user_delta')`, [DERIVE_GROUP, DERIVE_ACTOR]);
    });
    rebuildDeriveGroup(f.store);
    const first = deriveSnapshot(f.store, [1, 2]);
    expect(first.requests[1]).toMatchObject({
      title: modelTimeTitle(null, 1000), title_source: 'model_time',
    });
    expect(first.requests[1]?.title?.startsWith('unknown · ')).toBe(true);
    rebuildDeriveGroup(f.store);
    expect(deriveSnapshot(f.store, [1, 2])).toEqual(first);
    f.store.write(db => db.run(`UPDATE request SET title=NULL,title_source=NULL
      WHERE req_id IN (1,2)`));
    rebuildDeriveGroup(f.store);
    expect(deriveSnapshot(f.store, [1, 2])).toEqual(first);
    expect(f.store.read.query(`SELECT title,title_source FROM request WHERE req_id=3`).get())
      .toEqual({ title: 'retained title', title_source: 'user_delta' });
  } finally { f.close(); }
});

test('工具结果轮次不重复末轮用户输入，纯工具调用回复有摘要', () => {
  const f = fixture();
  try {
    const key = JSON.stringify(['session', 'tool-preview']);
    f.store.write(db => {
      db.run(
        `INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,title_source,sort_source,sort_key)
         VALUES (1,?,'session','actor-a','known',1000,'2026-10-20','hook','pending',0,1,1,1,'t','model_time','ledger','ledger|0001'),
                (2,?,'session','actor-a','known',2000,'2026-10-20','hook','pending',0,1,1,1,'t','model_time','ledger','ledger|0002')`,
        [key, key],
      );
    });
    const question = { role: 'user', content: [{ type: 'text', text: '最初的问题' }] };
    const callMsg = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_b1', name: 'bash', input: {} },
        { type: 'tool_use', id: 'toolu_b2', name: 'bash', input: {} },
      ],
    };
    const resultMsg = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_b1', content: 'one' },
        { type: 'tool_result', tool_use_id: 'toolu_b2', content: 'two' },
      ],
    };
    // 第一笔：用户提问，回复是纯工具调用。
    persistBody(f.store, 1, {
      protocol: 'anthropic',
      request: { messages: [question] },
      reply: { id: 'msg_1', content: callMsg.content },
      redact_version: 1,
    });
    // 第二笔：增量只有回传的工具结果，没有新的用户文本。
    persistBody(f.store, 2, {
      protocol: 'anthropic',
      request: { messages: [question, callMsg, resultMsg] },
      reply: { id: 'msg_2', content: [{ type: 'text', text: 'done' }] },
      redact_version: 1,
    });
    enqueueDerive(f.store, key, 'actor-a', '');
    drainDerive(f.store);
    const rows = f.store.read.query<{
      req_id: number; input_preview: string | null; input_preview_kind: string | null; reply_preview: string | null;
    }, []>(
      'SELECT req_id, input_preview, input_preview_kind, reply_preview FROM request ORDER BY req_id').all();

    expect(rows[0]?.reply_preview?.startsWith('工具调用 ·')).toBe(true);
    expect(rows[1]?.input_preview_kind).toBe('tool_result');
    expect(rows[1]?.input_preview?.startsWith('工具结果 ·')).toBe(true);
    // 关键回归：第二笔不能显示第一轮那句用户输入。
    expect(rows[1]?.input_preview).not.toBe('最初的问题');
  } finally {
    f.close();
  }
});

test('标题回复不再在预览里解析，标题由用途列提供', () => {
  const f = fixture();
  try {
    const key = JSON.stringify(['session', 'title-reply']);
    f.store.write(db => {
      db.run(
        `INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,title,title_source,sort_source,sort_key)
         VALUES (1,?,'session','actor-a','known',1000,'2026-10-20','hook','pending',0,1,1,1,'t','model_time','ledger','ledger|0001'),
                (2,?,'session','actor-a','known',2000,'2026-10-20','hook','pending',0,1,1,1,'t','model_time','ledger','ledger|0002')`,
        [key, key],
      );
    });
    const question = { role: 'user', content: [{ type: 'text', text: '问一句' }] };
    persistBody(f.store, 1, {
      protocol: 'anthropic',
      request: { messages: [question] },
      reply: { id: 'msg_1', content: [{ type: 'text', text: '<title nf="nf-md-git" emoji="🗂️">压缩机制选型</title>' }] },
      redact_version: 1,
    });
    persistBody(f.store, 2, {
      protocol: 'anthropic',
      request: { messages: [question] },
      reply: { id: 'msg_2', content: [{ type: 'text', text: '{"title":"Compaction 工程选型"}' }] },
      redact_version: 1,
    });
    enqueueDerive(f.store, key, 'actor-a', '');
    drainDerive(f.store);
    const rows = f.store.read.query<{ reply_preview: string | null; model_title: string | null }, []>(
      'SELECT reply_preview, model_title FROM request ORDER BY req_id').all();
    // 预览只展示回复原文；正式标题由用途阶段写入 model_title。
    expect(rows[0]?.reply_preview).toBe('<title nf="nf-md-git" emoji="🗂️">压缩机制选型</title>');
    expect(rows[1]?.reply_preview).toBe('{"title":"Compaction 工程选型"}');
    expect(rows[0]?.model_title).toBe('压缩机制选型');
    expect(rows[1]?.model_title).toBe('Compaction 工程选型');
  } finally {
    f.close();
  }
});

test('harness 的 caveat 与插话提示不进入标题', () => {
  const caveat = '<local-command-caveat>CAVEAT: The command below was run directly.</local-command-caveat>';
  expect(deriveTitle(
    [{ role: 'user', content: `${caveat}\n<command-name>/model</command-name>` }],
    [0], 'fallback',
  )).toEqual({ title: 'fallback', source: 'model_time' });
  const inserted = 'The user sent a new message while you were working: 另外我看现在 agent 判定不准\n\n'
    + 'This is how Claude Code surfaces messages the user sends mid-turn.';
  expect(deriveTitle([{ role: 'user', content: inserted }], [0], 'fallback'))
    .toEqual({ title: '另外我看现在 agent 判定不准', source: 'user_delta' });
});

test('非标题的排除用途不从用户增量取标题', () => {
  const f = fixture();
  try {
    seedPurposeRequest(f.store, {
      convKey: 'aux-delta', purposePending: 0, purposeVersion: 2,
      purposeStatus: 'recognized', reqKind: 'chat', purposeChain: 'participate',
      messages: [{ role: 'user', content: [{ type: 'text', text: '第一轮' }] }],
    });
    const aux = seedPurposeRequest(f.store, {
      convKey: 'aux-delta', purposePending: 0, purposeVersion: 2, startedMs: 2,
      purposeStatus: 'recognized', reqKind: 'auto-mode-classifier', purposeChain: 'exclude',
      purposeRule: 'claude.auto-mode-classifier.v1', modelTitle: '分类器标题',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '第一轮' }] },
        { role: 'user', content: [{ type: 'text', text: '这段文本不应成为标题' }] },
      ],
    });
    enqueueDerive(f.store, 'aux-delta', 'actor', '');
    drainDerive(f.store, 100);
    // aux 与主链没有可比关系，输入摘要按末轮输入展示；标题只来自用途列。
    expect(f.store.read.query<{ title: string; title_source: string;
      input_preview_kind: string | null }, [number]>(
      'SELECT title,title_source,input_preview_kind FROM request WHERE req_id=?').get(aux))
      .toEqual({ title: '分类器标题', title_source: 'model_title',
        input_preview_kind: 'tail' });
  } finally { f.close(); }
});

test('标题由用途列驱动而不是回复形状', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'title-source', purposePending: 0, purposeVersion: 2,
      purposeStatus: 'recognized', reqKind: 'title', purposeChain: 'exclude',
      modelTitle: '存储标题',
      reply: { content: [{ type: 'text', text: '<title>回复标题</title>' }] },
    });
    enqueueDerive(f.store, 'title-source', 'actor', '');
    drainDerive(f.store, 100);
    const row = f.store.read.query<{
      model_title: string | null; title: string; reply_preview: string | null;
    }, [number]>(
      'SELECT model_title, title, reply_preview FROM request WHERE req_id=?').get(id)!;
    expect(row.model_title).toBe('存储标题');
    expect(row.title).toBe('存储标题');
    expect(row.reply_preview?.startsWith('标题 · ')).toBe(false);
  } finally { f.close(); }
});

test('派生不再从回复形状识别标题', () => {
  const f = fixture();
  try {
    const id = seedPurposeRequest(f.store, {
      convKey: 'no-redetect', purposePending: 0, purposeVersion: 2,
      purposeStatus: 'unrecognized', reqKind: 'chat', purposeChain: 'participate',
      reply: { content: [{ type: 'text', text: '<title>不应成为标题</title>' }] },
    });
    enqueueDerive(f.store, 'no-redetect', 'actor', '');
    drainDerive(f.store, 100);
    expect(f.store.read.query<{
      req_kind: string; chain_role: string; model_title: string | null;
    }, [number]>(
      'SELECT req_kind, chain_role, model_title FROM request WHERE req_id=?').get(id))
      .toEqual({ req_kind: 'chat', chain_role: 'main', model_title: null });
  } finally { f.close(); }
});

test('多 choice 回复不发布工具行，组照常完成且原回复可读', () => {
  const f = fixture();
  try {
    seedDeriveRound(f.store, [1, 2]);
    const user = { role: 'user', content: 'synthetic input' };
    const callOf = (id: string) => ({ id, type: 'function', function: { name: 'read_file', arguments: '{}' } });
    const multi = {
      choices: [
        { finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [callOf('choice_left')] } },
        { finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [callOf('choice_right')] } },
      ],
    };
    persistBody(f.store, 1, { protocol: 'chat', request: { messages: [user] }, reply: multi, redact_version: 1 });
    persistBody(f.store, 2, { protocol: 'chat', request: { messages: [user, { role: 'tool', tool_call_id: 'choice_left', content: 'left output' }] }, reply: { choices: [{ message: { role: 'assistant', content: 'done' } }] }, redact_version: 1 });
    rebuildDeriveGroup(f.store);
    // 两个抽取入口都不发布确定位置：没有 tool_call 行，组仍 clean 完成。
    expect(f.store.read.query(`SELECT COUNT(*) AS n FROM tool_call WHERE req_id=1`).get())
      .toEqual({ n: 0 });
    expect(f.store.read.query<{ state: string }, [string, string]>(
      'SELECT state FROM derive_queue WHERE conv_key=? AND actor=?').get(DERIVE_GROUP, DERIVE_ACTOR))
      .toEqual({ state: 'clean' });
    // 原 reply 仍可整份读出，多 choice 保留原始对象。
    const body = readBodyTx(f.store.read, 1);
    expect((body?.reply as { choices: unknown[] }).choices).toHaveLength(2);
  } finally { f.close(); }
});

test('派生写回复形状位：可读按 reply 重算，正文回收后保留旧值', () => {
  const f = fixture();
  try {
    const key = JSON.stringify(['session', 'reply-shape']);
    f.store.write(db => {
      db.run(
        `INSERT INTO request(req_id,conv_key,conv_source,actor,actor_state,started_ms,day,via,body_state,derive_version,have,created_at,updated_at,sort_source,sort_key)
         VALUES (1,?,'session','a','known',1000,'2026-10-22','hook','pending',0,1,1,1,'ledger','ledger|0001'),
                (2,?,'session','a','known',2000,'2026-10-22','hook','pending',0,1,1,1,'ledger','ledger|0002')`,
        [key, key],
      );
    });
    persistBody(f.store, 1, {
      protocol: 'anthropic',
      request: { messages: [{ role: 'user', content: [{ type: 'text', text: '问' }] }] },
      reply: { id: 'm1', stop_reason: 'end_turn', content: [{ type: 'text', text: '答' }] },
      redact_version: 1,
    });
    persistBody(f.store, 2, {
      protocol: 'anthropic',
      request: { messages: [{ role: 'user', content: [{ type: 'text', text: '问' }] }] },
      reply: { id: 'm2', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
      redact_version: 1,
    });
    enqueueDerive(f.store, key, 'a', '');
    drainDerive(f.store);
    const shapes = () => f.store.read.query<{ req_id: number; reply_shape: string | null }, []>(
      'SELECT req_id, reply_shape FROM request ORDER BY req_id').all();
    expect(shapes()).toEqual([{ req_id: 1, reply_shape: 'final' }, { req_id: 2, reply_shape: 'tools' }]);
    // 正文回收后重派生：形状位保留派生时的值，不清除也不改判。
    expect(evictOldestBodyBatch(f.store, 3000, 1).requests).toBe(1);
    enqueueDerive(f.store, key, 'a', '');
    drainDerive(f.store);
    expect(shapes()).toEqual([{ req_id: 1, reply_shape: 'final' }, { req_id: 2, reply_shape: 'tools' }]);
    expect(f.store.read.query<{ reply_shape: string | null }, [number]>(
      'SELECT reply_shape FROM request WHERE req_id=1').get(1)?.reply_shape).toBe('final');
  } finally {
    f.close();
  }
});
