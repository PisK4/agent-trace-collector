import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
import { loadConfig } from '../src/config';
import { createHandler } from '../src/http';
import { persistBody } from '../src/body';
import { parseProtocol } from '../src/protocols';
import type { BodyInput } from '../src/body';

function seed(store: ReturnType<typeof fixture>['store'], id: number, body: BodyInput, state = 'available'): void {
  store.write(db => db.run(
    `INSERT INTO request(req_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, 1000 + id, '2026-10-20', 'hook', 'pending', 0, 1, 1, 1],
  ));
  persistBody(store, id, body);
  if (state !== 'available') {
    store.write(db => db.run('UPDATE request SET body_state=? WHERE req_id=?', [state, id]));
  }
}

function handlerFor(f: ReturnType<typeof fixture>) {
  const handler = createHandler(f.store, loadConfig({}), 'synthetic-read-token');
  return (path: string) => handler(new Request(`http://127.0.0.1:8320${path}`, {
    headers: { host: '127.0.0.1:8320', origin: 'http://127.0.0.1:8320' },
  }));
}

function messagesBody(count: number): BodyInput {
  return {
    protocol: 'anthropic',
    request: {
      system: [{ type: 'text', text: 'sys' }],
      messages: Array.from({ length: count }, (_, i) => ({ role: 'user', content: [{ type: 'text', text: `m${i}` }] })),
    },
    reply: { id: 'msg_page', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: { i: 0 } }] },
    redact_version: 1,
  };
}

test('正文页返回服务端消息解释且原文不变', async () => {
  const f = fixture();
  try {
    seed(f.store, 1, {
      protocol: 'anthropic',
      request: {
        messages: [
          { role: 'user', content: [{ type: 'text', text: '<system-reminder>x</system-reminder>\n真实输入' }] },
          { role: 'user', content: [{ type: 'text', text: '第二条' }] },
        ],
      },
      reply: { id: 'msg_1', content: [] },
      redact_version: 1,
    });
    const page = await (await handlerFor(f)('/api/requests/1/body')).json() as Record<string, unknown>;
    const interpretations = page.interpretations as { ord: number; input: { text: string } | null }[];
    expect(interpretations.map(item => item.input?.text)).toEqual(['真实输入', '第二条']);
    const messages = page.messages as { value: { content: { text: string }[] } }[];
    expect(messages[0]?.value.content[0]?.text).toContain('<system-reminder>');
    expect((page.coverage as { complete: boolean }).complete).toBe(true);
  } finally {
    f.close();
  }
});

test('畸形包装保留原文并标未识别', async () => {
  const f = fixture();
  try {
    seed(f.store, 1, {
      protocol: 'anthropic',
      request: { messages: [{ role: 'user', content: '<session>没有闭合' }] },
      reply: { id: 'msg_1', content: [] },
      redact_version: 1,
    });
    const page = await (await handlerFor(f)('/api/requests/1/body')).json() as Record<string, unknown>;
    const interpretation = (page.interpretations as {
      input: { state: string; text: string } | null; is_input: boolean;
    }[])[0];
    expect(interpretation?.input?.state).toBe('unrecognized');
    expect(interpretation?.input?.text).toBe('<session>没有闭合');
    expect(interpretation?.is_input).toBe(true);
  } finally {
    f.close();
  }
});

test('回收正文返回空解释与不可用覆盖，不伪造空对话', async () => {
  const f = fixture();
  try {
    seed(f.store, 1, messagesBody(2));
    f.store.write(db => db.run(
      "UPDATE request SET body_state='evicted', body_evict_reason='budget', skeleton_z=NULL WHERE req_id=1",
    ));
    const page = await (await handlerFor(f)('/api/requests/1/body')).json() as Record<string, unknown>;
    expect(page.state).toBe('evicted');
    expect(page.interpretations).toEqual([]);
    expect((page.coverage as { complete: boolean; reason: string }).complete).toBe(false);
    expect((page.coverage as { reason: string }).reason).toBe('body_unavailable');
  } finally {
    f.close();
  }
});

test('正文首片带请求字段与回复，后续片只带消息', async () => {
  const f = fixture();
  try {
    seed(f.store, 1, messagesBody(90));
    const request = handlerFor(f);

    const first = await (await request('/api/requests/1/body?from=0&to=40')).json() as Record<string, unknown>;
    expect(first.state).toBe('available');
    expect(first.total).toBe(90);
    expect((first.messages as unknown[]).length).toBe(40);
    expect(first.request_fields).toEqual({ system: [{ type: 'text', text: 'sys' }] });
    expect((first.reply as { id: string }).id).toBe('msg_page');

    const second = await (await request('/api/requests/1/body?from=40&to=80')).json() as Record<string, unknown>;
    expect((second.messages as { ord: number }[]).length).toBe(40);
    expect((second.messages as { ord: number }[])[0]?.ord).toBe(40);
    expect(second.request_fields).toBeNull();
    expect(second.reply).toBeNull();

    const last = await (await request('/api/requests/1/body?from=80&to=90')).json() as Record<string, unknown>;
    expect((last.messages as unknown[]).length).toBe(10);

    // 越界页返回空消息但保留 total，不装作没有正文。
    const beyond = await (await request('/api/requests/1/body?from=200&to=240')).json() as Record<string, unknown>;
    expect((beyond.messages as unknown[]).length).toBe(0);
    expect(beyond.total).toBe(90);
  } finally {
    f.close();
  }
});

test('非法区间与超大页返回400，缺实体404', async () => {
  const f = fixture();
  try {
    seed(f.store, 1, messagesBody(3));
    const request = handlerFor(f);
    expect((await request('/api/requests/1/body?from=5&to=2')).status).toBe(400);
    expect((await request('/api/requests/1/body?from=0&to=41')).status).toBe(400);
    expect((await request('/api/requests/1/body?from=-1&to=10')).status).toBe(400);
    expect((await request('/api/requests/1/body?from=abc&to=10')).status).toBe(400);
    expect((await request('/api/requests/999/body')).status).toBe(404);
  } finally {
    f.close();
  }
});

test('回收与未到正文返回带原因的200而不是空数组', async () => {
  const f = fixture();
  try {
    seed(f.store, 1, messagesBody(2));
    f.store.write(db => db.run("UPDATE request SET body_state='evicted', body_evict_reason='budget', skeleton_z=NULL WHERE req_id=1"));
    seed(f.store, 2, messagesBody(1), 'pending');
    f.store.write(db => db.run("UPDATE request SET miss_reason='hook_missing' WHERE req_id=2"));
    const request = handlerFor(f);

    const evicted = await (await request('/api/requests/1/body')).json() as Record<string, unknown>;
    expect(evicted.state).toBe('evicted');
    expect(evicted.reason).toBe('budget');
    expect(evicted.messages).toEqual([]);

    const pending = await (await request('/api/requests/2/body')).json() as Record<string, unknown>;
    expect(pending.state).toBe('pending');
    expect(pending.reason).toBe('hook_missing');
    expect(pending.total).toBeNull();
  } finally {
    f.close();
  }
});

test('unsupported 协议原对象仍可整份读出', async () => {
  const f = fixture();
  try {
    seed(f.store, 1, {
      protocol: 'responses',
      request: { input: 'hello', messages: undefined },
      reply: { id: 'resp_1', output: [] },
      redact_version: 1,
    });
    const page = await (await handlerFor(f)('/api/requests/1/body')).json() as Record<string, unknown>;
    expect(page.state).toBe('available');
    expect(page.parse_state).toBe('unsupported');
    expect(page.request_fields).toEqual({ input: 'hello' });
    expect(page.reply).toEqual({ id: 'resp_1', output: [] });
  } finally {
    f.close();
  }
});

test('别名旧ID能读到canonical请求的正文', async () => {
  const f = fixture();
  try {
    seed(f.store, 1, messagesBody(2));
    f.store.write(db => db.run('INSERT INTO request_alias(old_id,new_id) VALUES (?,?)', [7, 1]));
    const page = await (await handlerFor(f)('/api/requests/7/body')).json() as Record<string, unknown>;
    expect(page.state).toBe('available');
    expect(page.total).toBe(2);
  } finally {
    f.close();
  }
});

test('写入正文时同步记录解析状态', () => {
  const f = fixture();
  try {
    seed(f.store, 1, messagesBody(1));
    const row = f.store.read.query<{ parse_state: string; reply_state: string }, [number]>(
      'SELECT parse_state, reply_state FROM request WHERE req_id=?',
    ).get(1);
    expect(row).toEqual({ parse_state: 'ok', reply_state: 'ok' });

    const absent = parseProtocol('anthropic', { messages: [] }, null);
    expect(absent.reply_state).toBe('absent');
  } finally {
    f.close();
  }
});

test('40条分页只解压对应块', () => {
  const f = fixture();
  try {
    seed(f.store, 1, messagesBody(90));
    // 每块独立一行；分页取 40 条只需要读 40 块，不碰其余 50 块。
    expect(f.store.read.query('SELECT count(*) AS n FROM request_block').get()).toEqual({ n: 90 });
    const firstPageBlocks = f.store.read.query<{ block: number }, [number, number, number]>(
      'SELECT block FROM request_block WHERE req_id=? AND ord >= ? AND ord < ? ORDER BY ord',
    ).all(1, 0, 40);
    expect(firstPageBlocks.length).toBe(40);
    expect(new Set(firstPageBlocks.map(row => row.block)).size).toBe(40);
  } finally {
    f.close();
  }
});

test('回收后不再给出可翻页的计数与回复', async () => {
  const f = fixture();
  try {
    seed(f.store, 1, messagesBody(9));
    f.store.write(db => db.run(
      "UPDATE request SET body_state='evicted', body_evict_reason='budget', skeleton_z=NULL WHERE req_id=1",
    ));
    const page = await (await handlerFor(f)('/api/requests/1/body?from=0&to=40')).json() as Record<string, unknown>;
    expect(page.state).toBe('evicted');
    expect(page.reason).toBe('budget');
    // 消息内容已被回收：既没有消息，也不能声称还有 9 条可翻。
    expect(page.messages).toEqual([]);
    expect(page.total).toBeNull();
    // 回复对象也随正文一起回收，不能读成"上游没有提供回复"。
    expect(page.reply).toBeNull();
    expect(page.request_fields).toBeNull();
  } finally {
    f.close();
  }
});
