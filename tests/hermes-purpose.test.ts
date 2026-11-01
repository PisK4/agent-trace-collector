import { expect, test } from 'bun:test';
import { persistBody } from '../src/body';
import { drainDerive, enqueueDerive } from '../src/derive/sync';
import { listSessions } from '../src/queries/sessions';
import { PURPOSE_VERSION } from '../src/semantics';
import { fixture } from './fixtures';

/**
 * Hermes 旁路请求的组内效果：命令审查器与标题生成器都不占主链，
 * 主请求的链关系、工具配对与标题不受干扰。
 */

const REVIEWER_SYSTEM = 'You are a security reviewer for an AI coding agent. '
  + 'You assess whether shell commands are safe to execute.';
const TITLER_SYSTEM = 'You name chat sessions. Respond with {"title": ...}.';
const HERMES_MAIN = 'You are Hermes Agent, built by Nous Research.';

type GroupRow = {
  req_id: number; prev_req_id: number | null; prev_relation: string;
  delta_ordinals: string | null; chain_role: string; req_kind: string;
  model_title: string | null; title_source: string | null;
  purpose_status: string; purpose_rule: string | null; purpose_chain: string;
  purpose_version: number | null;
};

/**
 * 构造一条 Hermes 会话：主请求 A、审查器 R、续写 B。
 *
 * R 的输入包装成真实形状：system 是请求侧指纹，user 是一条待审命令，
 * 它不续接任何历史。B 完整包含 A 的消息序列，所以前驱是 A 而不是 R。
 */
function seedHermesGroup(store: ReturnType<typeof fixture>['store']): {
  key: string; a: number; r: number; b: number;
} {
  const key = JSON.stringify(['session', 'hermes-group']);
  const ids: number[] = [];
  store.write(db => {
    for (const [index, started] of [1000, 2000, 3000].entries()) {
      const result = db.run(
        `INSERT INTO request(conv_key,conv_source,actor,actor_state,agent,started_ms,day,via,
           body_state,derive_version,have,created_at,updated_at,title,title_source,sort_source,sort_key)
         VALUES (?,?,'actor-h','known','hermes',?,'2026-10-27','hook','pending',0,1,1,1,
           'seed','model_time','ledger',?)`,
        [key, 'session', started, `ledger|${String(index).padStart(4, '0')}`],
      );
      ids.push(Number(result.lastInsertRowid));
    }
  });
  const [a, r, b] = ids as [number, number, number];
  const message = (role: string, text: string) => ({ role, content: [{ type: 'text', text }] });
  const history = [
    message('system', HERMES_MAIN),
    message('user', 'synthetic task'),
  ];
  persistBody(store, a, {
    protocol: 'anthropic',
    request: { messages: history },
    reply: { id: 'msg_a', content: [{ type: 'text', text: 'synthetic answer' }] },
    redact_version: 1,
  });
  persistBody(store, r, {
    protocol: 'anthropic',
    request: { system: REVIEWER_SYSTEM, messages: [message('user', 'rm -rf synthetic-dir')] },
    reply: { id: 'msg_r', content: [{ type: 'text', text: 'ESCALATE' }] },
    redact_version: 1,
  });
  persistBody(store, b, {
    protocol: 'anthropic',
    request: {
      messages: [
        ...history,
        message('assistant', 'synthetic answer'),
        message('user', 'synthetic follow-up'),
      ],
    },
    reply: { id: 'msg_b', content: [{ type: 'text', text: 'synthetic continued' }] },
    redact_version: 1,
  });
  return { key, a, r, b };
}

test('命令审查器与标题生成器不占主链，续写仍接主请求', () => {
  const f = fixture();
  try {
    const { key, a, r, b } = seedHermesGroup(f.store);
    // 标题孤儿：缺回复、只带请求侧指纹，会话键落空桶。
    const titler = Number(f.store.write(db => db.run(
      `INSERT INTO request(conv_key,conv_source,actor,actor_state,agent,started_ms,day,via,
         body_state,derive_version,have,created_at,updated_at,title,title_source,sort_source,sort_key)
       VALUES (?,?,NULL,'unknown','hermes',?,'2026-10-27','hook','pending',0,1,1,1,
         'seed','model_time','hook',?)`,
      [JSON.stringify(['hook', 'synthetic-hook-id']), 'hook', 1500, 'hook|synthetic-hook-id'],
    ).lastInsertRowid));
    persistBody(f.store, titler, {
      protocol: 'anthropic',
      request: { system: TITLER_SYSTEM, messages: [{ role: 'user', content: 'synthetic' }] },
      reply: null,
      redact_version: 1,
    });
    enqueueDerive(f.store, key, 'actor-h', '');
    drainDerive(f.store);

    const rows = f.store.read.query<GroupRow, []>(`
      SELECT req_id, prev_req_id, prev_relation, delta_ordinals, chain_role, req_kind,
        model_title, title_source, purpose_status, purpose_rule, purpose_chain, purpose_version
      FROM request ORDER BY req_id`).all();
    const byId = new Map(rows.map(row => [row.req_id, row]));

    // 主请求 A 是主链首笔，审查器 R 是旁路，B 仍续接 A。
    expect(byId.get(a)).toMatchObject({
      prev_req_id: null, prev_relation: 'first', chain_role: 'main', req_kind: 'chat',
      purpose_status: 'unrecognized', purpose_chain: 'participate',
      purpose_version: PURPOSE_VERSION,
    });
    expect(byId.get(r)).toMatchObject({
      prev_req_id: null, prev_relation: 'aux', delta_ordinals: null, chain_role: 'aux',
      req_kind: 'command-review', model_title: null,
      purpose_status: 'recognized', purpose_rule: 'hermes.command-review.v1',
      purpose_chain: 'exclude', purpose_version: PURPOSE_VERSION,
    });
    // 审查器自身是旁路行，标题落模型时间兜底。
    expect(byId.get(r)?.title_source).toBe('model_time');
    expect(byId.get(b)).toMatchObject({
      prev_req_id: a, prev_relation: 'confirmed', chain_role: 'main', req_kind: 'chat',
    });

    // 未知 actor 的标题孤儿：用途结算，但不进组。
    expect(byId.get(titler)).toMatchObject({
      chain_role: 'main', req_kind: 'title', model_title: null,
      purpose_status: 'recognized', purpose_rule: 'hermes.session-title.v1',
      purpose_chain: 'exclude', purpose_version: PURPOSE_VERSION,
    });
    // 会话标题仍取主请求的用户首句，不因旁路请求改写。
    const session = listSessions(f.store, 10, null).items.find(item => item.conv_key === key);
    expect(session?.title).toBe('synthetic task');
  } finally {
    f.close();
  }
});

test('已确认的正式标题不因后续缺回复被撤销', () => {
  const f = fixture();
  try {
    const key = JSON.stringify(['session', 'hermes-title']);
    const main = Number(f.store.write(db => db.run(
      `INSERT INTO request(conv_key,conv_source,actor,actor_state,agent,started_ms,day,via,
         body_state,derive_version,have,created_at,updated_at,title,title_source,sort_source,sort_key)
       VALUES (?,?,'actor-h','known','hermes',1000,'2026-10-27','hook','pending',0,1,1,1,
         'seed','model_time','ledger','ledger|0000')`,
      [key, 'session'],
    ).lastInsertRowid));
    const titler = Number(f.store.write(db => db.run(
      `INSERT INTO request(conv_key,conv_source,actor,actor_state,agent,started_ms,day,via,
         body_state,derive_version,have,created_at,updated_at,title,title_source,sort_source,sort_key)
       VALUES (?,?,'actor-h','known','hermes',2000,'2026-10-27','hook','pending',0,1,1,1,
         'seed','model_time','ledger','ledger|0001')`,
      [key, 'session'],
    ).lastInsertRowid));
    persistBody(f.store, main, {
      protocol: 'anthropic',
      request: { system: HERMES_MAIN, messages: [{ role: 'user', content: 'synthetic task' }] },
      reply: { id: 'msg_m', content: [{ type: 'text', text: 'ok' }] },
      redact_version: 1,
    });
    persistBody(f.store, titler, {
      protocol: 'anthropic',
      request: { system: TITLER_SYSTEM, messages: [{ role: 'user', content: 'synthetic' }] },
      reply: { id: 'msg_t', content: [{ type: 'text', text: '{"title":"合成会话标题"}' }] },
      redact_version: 1,
    });
    enqueueDerive(f.store, key, 'actor-h', '');
    drainDerive(f.store);
    expect(f.store.read.query<{ model_title: string | null }, [number]>(
      'SELECT model_title FROM request WHERE req_id=?').get(titler)?.model_title)
      .toBe('合成会话标题');
    expect(listSessions(f.store, 10, null).items.find(item => item.conv_key === key)?.title)
      .toBe('合成会话标题');

    // 缺回复的新一次标题请求：不撤销已确认的标题，仍排除链。
    const second = Number(f.store.write(db => db.run(
      `INSERT INTO request(conv_key,conv_source,actor,actor_state,agent,started_ms,day,via,
         body_state,derive_version,have,created_at,updated_at,title,title_source,sort_source,sort_key)
       VALUES (?,?,'actor-h','known','hermes',3000,'2026-10-27','hook','pending',0,1,1,1,
         'seed','model_time','ledger','ledger|0002')`,
      [key, 'session'],
    ).lastInsertRowid));
    persistBody(f.store, second, {
      protocol: 'anthropic',
      request: { system: TITLER_SYSTEM, messages: [{ role: 'user', content: 'synthetic' }] },
      reply: null,
      redact_version: 1,
    });
    enqueueDerive(f.store, key, 'actor-h', '');
    drainDerive(f.store);
    const row = f.store.read.query<{ purpose_chain: string; req_kind: string }, [number]>(
      'SELECT purpose_chain, req_kind FROM request WHERE req_id=?').get(second);
    expect(row).toEqual({ purpose_chain: 'exclude', req_kind: 'title' });
    expect(listSessions(f.store, 10, null).items.find(item => item.conv_key === key)?.title)
      .toBe('合成会话标题');
  } finally {
    f.close();
  }
});

// ---------------------------------------------------------------------------
// 视觉辅助调用：hermes.vision-analysis.v1
// ---------------------------------------------------------------------------

const VISION_TEMPLATE = 'Fully describe and explain everything about this image, '
  + 'then answer the following question:';

/** 插入一条 Hermes 请求行；via、conv_source 与归属形状跟真实摄入一致。 */
function insertHermesRequest(
  store: ReturnType<typeof fixture>['store'],
  convKey: string,
  convSource: string,
  actor: string | null,
  startedMs: number,
): number {
  return Number(store.write(db => db.run(
    `INSERT INTO request(conv_key,conv_source,actor,actor_state,agent,started_ms,day,via,
       body_state,derive_version,have,created_at,updated_at,title,title_source,sort_source,sort_key)
     VALUES (?,?,?,?,'hermes',?,'2026-10-27','through','pending',0,1,1,1,'seed','model_time','ledger',?)`,
    [convKey, convSource, actor, actor === null ? 'unknown' : 'known', startedMs,
      `ledger|${String(startedMs).padStart(8, '0')}`],
  ).lastInsertRowid));
}

/** chat 协议的视觉辅助请求：模板写在唯一 user 文本块开头，图片内容块跟在后面。 */
function visionBody(question: string, over: {
  withImage?: boolean; prefix?: string; tools?: unknown[]; extraMessage?: boolean; reply?: unknown;
} = {}): { request: unknown; reply: unknown } {
  const text = `${over.prefix ?? ''}${VISION_TEMPLATE}\n\n${question}`;
  const userMessage = {
    role: 'user',
    content: [
      { type: 'text', text },
      ...(over.withImage === false ? []
        : [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]),
    ],
  };
  return {
    request: {
      messages: over.extraMessage === true
        ? [userMessage, { role: 'assistant', content: [{ type: 'text', text: 'earlier' }] }]
        : [userMessage],
      ...(over.tools === undefined ? {} : { tools: over.tools }),
    },
    reply: over.reply === undefined
      ? { id: 'msg_v', content: [{ type: 'text', text: 'ok' }] } : over.reply,
  };
}

test('视觉辅助调用排除链：同组为 aux，独立单笔组标旁路，未知归属行不进组', () => {
  const f = fixture();
  try {
    const groupKey = JSON.stringify(['session', 'hermes-group']);
    const soloKey = JSON.stringify(['conv', 'magpie-solo']);
    const hookKey = JSON.stringify(['hook', 'synthetic-hook-vision']);
    const { a, b } = seedHermesGroup(f.store);
    const inGroup = insertHermesRequest(f.store, groupKey, 'session', 'actor-h', 3500);
    const solo = insertHermesRequest(f.store, soloKey, 'conv', 'actor-h', 3600);
    const hookRow = insertHermesRequest(f.store, hookKey, 'hook', null, 3700);
    persistBody(f.store, inGroup, { protocol: 'chat', ...visionBody('合成问题'), redact_version: 1 });
    persistBody(f.store, solo, { protocol: 'chat', ...visionBody('另一帧'), redact_version: 1 });
    // 识图失败没有回复：请求可读仍要排除链。
    persistBody(f.store, hookRow, {
      protocol: 'chat', ...visionBody('失败帧', { reply: null }), redact_version: 1,
    });
    enqueueDerive(f.store, groupKey, 'actor-h', '');
    enqueueDerive(f.store, soloKey, 'actor-h', '');
    drainDerive(f.store);

    const row = (id: number) => f.store.read.query<{
      purpose_status: string; purpose_rule: string | null; purpose_chain: string;
      req_kind: string; model_title: string | null; prev_relation: string;
      delta_ordinals: string | null; chain_role: string; title_source: string | null;
    }, [number]>(`SELECT purpose_status, purpose_rule, purpose_chain, req_kind, model_title,
      prev_relation, delta_ordinals, chain_role, title_source FROM request WHERE req_id=?`).get(id);
    expect(row(inGroup)).toMatchObject({
      purpose_status: 'recognized', purpose_rule: 'hermes.vision-analysis.v1',
      purpose_chain: 'exclude', req_kind: 'vision-analysis', model_title: null,
      prev_relation: 'aux', delta_ordinals: null, chain_role: 'aux', title_source: 'model_time',
    });
    // B 仍续接 A：视觉调用排除在祖先集合之外，不干扰主链。
    expect(f.store.read.query<{ prev_req_id: number; prev_relation: string }, [number]>(
      'SELECT prev_req_id, prev_relation FROM request WHERE req_id=?').get(b))
      .toEqual({ prev_req_id: a, prev_relation: 'confirmed' });
    expect(row(solo)).toMatchObject({
      purpose_status: 'recognized', purpose_chain: 'exclude', req_kind: 'vision-analysis',
    });
    expect(row(hookRow)).toMatchObject({
      purpose_status: 'recognized', purpose_chain: 'exclude', req_kind: 'vision-analysis',
    });
    // 未知归属行只结算用途，不建组队列。
    expect(f.store.read.query<{ n: number }, [string]>(
      'SELECT COUNT(*) AS n FROM derive_queue WHERE conv_key=?').get(hookKey)?.n).toBe(0);

    // 全员 exclude 的独立单笔组是旁路；混入参与链的组不折叠。
    const sessions = listSessions(f.store, 10, null).items;
    const soloSession = sessions.find(item => item.conv_key === soloKey);
    expect(soloSession?.flags).toContain('bypass');
    expect(soloSession?.title).toBe('');
    const groupSession = sessions.find(item => item.conv_key === groupKey);
    expect(groupSession?.flags).not.toContain('bypass');
    expect(groupSession?.title).toBe('synthetic task');
  } finally {
    f.close();
  }
});

test('形状或标签不满足时不识别视觉用途', () => {
  const f = fixture();
  try {
    const cases = [
      { name: 'no-image', agent: 'hermes', body: visionBody('没有图', { withImage: false }) },
      { name: 'template-mid-text', agent: 'hermes', body: visionBody('引用模板', { prefix: '请先看这张图。\n' }) },
      { name: 'tools-declared', agent: 'hermes', body: visionBody('带工具', { tools: [{ type: 'function', function: { name: 'x', parameters: {} } }] }) },
      { name: 'two-messages', agent: 'hermes', body: visionBody('多条消息', { extraMessage: true }) },
      { name: 'other-agent', agent: 'claude', body: visionBody('别的标签') },
    ] as const;
    const ids = cases.map((item, index) => {
      const key = JSON.stringify(['conv', `vision-negative-${index}`]);
      const id = insertHermesRequest(f.store, key, 'conv', `actor-${index}`, 1000 + index);
      f.store.write(db => db.run('UPDATE request SET agent=? WHERE req_id=?', [item.agent, id]));
      persistBody(f.store, id, { protocol: 'chat', ...item.body, redact_version: 1 });
      enqueueDerive(f.store, key, `actor-${index}`, '');
      return id;
    });
    drainDerive(f.store);
    for (const id of ids) {
      expect(f.store.read.query<{
        purpose_status: string; purpose_chain: string; req_kind: string;
      }, [number]>('SELECT purpose_status, purpose_chain, req_kind FROM request WHERE req_id=?').get(id))
        .toEqual({ purpose_status: 'unrecognized', purpose_chain: 'participate', req_kind: 'chat' });
    }
  } finally {
    f.close();
  }
});

// ---------------------------------------------------------------------------
// 技能加载包装：共享输入解释按完整结构剥出用户指令
// ---------------------------------------------------------------------------

const SKILL_HEADER = '[IMPORTANT: The user has invoked the "video-shotcraft" skill, '
  + 'indicating they want you to follow its instructions. The full skill content is loaded below.]';
const INSTRUCTION_ANCHOR = 'The user has provided the following instruction alongside the skill invocation: ';

test('技能包装的用户指令成为会话标题，cron 调度文本回退模型时间', () => {
  const f = fixture();
  try {
    const mainKey = JSON.stringify(['session', 'hermes-skill']);
    const cronKey = JSON.stringify(['conv', 'magpie-cron']);
    const main = insertHermesRequest(f.store, mainKey, 'session', 'actor-h', 1000);
    const cron = insertHermesRequest(f.store, cronKey, 'conv', 'actor-h', 2000);
    persistBody(f.store, main, {
      protocol: 'chat',
      request: {
        messages: [{
          role: 'user',
          content: [{
            type: 'text',
            text: [SKILL_HEADER, '', '---', '', '# 技能正文', '步骤一。', '',
              `${INSTRUCTION_ANCHOR}评估这个 Skill 的适配度`].join('\n'),
          }],
        }],
      },
      reply: { id: 'msg_s', content: [{ type: 'text', text: 'ok' }] },
      redact_version: 1,
    });
    persistBody(f.store, cron, {
      protocol: 'chat',
      request: {
        messages: [{
          role: 'user',
          content: [{
            type: 'text',
            text: [
              SKILL_HEADER.replace('video-shotcraft', 'pis-personal-radar'), '', '---', '',
              '# 技能正文', '',
              `${INSTRUCTION_ANCHOR}[IMPORTANT: You are running as a scheduled cron job. Deliver analysis for this run.]`,
              '', '## Script Output', '```json', '{}', '```', '', '运行个人技术雷达',
            ].join('\n'),
          }],
        }],
      },
      reply: { id: 'msg_c', content: [{ type: 'text', text: 'ok' }] },
      redact_version: 1,
    });
    enqueueDerive(f.store, mainKey, 'actor-h', '');
    enqueueDerive(f.store, cronKey, 'actor-h', '');
    drainDerive(f.store);

    // 用户指令进标题；技能正文与包装头不再出现。
    expect(listSessions(f.store, 10, null).items.find(item => item.conv_key === mainKey)?.title)
      .toBe('评估这个 Skill 的适配度');
    const cronRow = f.store.read.query<{ title: string; title_source: string | null }, [number]>(
      'SELECT title, title_source FROM request WHERE req_id=?').get(cron);
    expect(cronRow?.title_source).toBe('model_time');
    expect(cronRow?.title).not.toContain('IMPORTANT');
  } finally {
    f.close();
  }
});
