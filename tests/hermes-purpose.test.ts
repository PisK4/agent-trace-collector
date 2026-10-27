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
