import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
import { loadConfig } from '../src/config';
import { createHandler } from '../src/http';
import { SYNTH, logsProtobuf, tracesJson, tracesProtobuf } from './otlp-fixtures';

const OTLP_TOKEN = 'synthetic-otlp-token';
const SALT = new Uint8Array(32);

function makeHandler(store: ReturnType<typeof fixture>['store'],
  otlp: { token: string; salt: Uint8Array; admission?: () => { mode: 'normal' | 'metadata_only' | 'paused'; reason: string | null } } | undefined =
    { token: OTLP_TOKEN, salt: SALT }) {
  return createHandler(store, loadConfig({}), 'synthetic-read-token', undefined, undefined, otlp);
}

function otlpRequest(path: string, body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:8320${path}`, {
    method: 'POST',
    body,
    // 构造出的 Request 不自动带 host，这里与真实请求对齐显式设置。
    headers: { host: '127.0.0.1:8320', 'content-type': 'application/x-protobuf', ...headers },
  });
}

/** 二进制载荷的 BodyInit 包装：TS 的泛型 TypedArray 与 BodyInit 类型不相交。 */
function bytesBody(bytes: Uint8Array): BodyInit {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) as unknown as BodyInit;
}

const OMP_CHAT_SPAN = {
  traceId: SYNTH.traceA,
  spanId: SYNTH.spanLLM,
  name: 'chat synth-model-lite',
  startNano: SYNTH.msToNano(1_792_945_426_098),
  attrs: {
    'gen_ai.operation.name': 'chat',
    'gen_ai.request.model': 'synth-model-lite',
    'gen_ai.conversation.id': SYNTH.session,
    'gen_ai.usage.input_tokens': { int: 100 },
    'gen_ai.usage.output_tokens': { int: 2 },
  },
};

test('protobuf traces 200 并落 via=otlp 请求行；响应是规范的 partialSuccess', async () => {
  const f = fixture();
  try {
    const handler = makeHandler(f.store);
    const response = await handler(otlpRequest('/v1/traces',
      bytesBody(tracesProtobuf([{ resource: { service: 'oh-my-pi' }, spans: [OMP_CHAT_SPAN] }])),
      { authorization: `Bearer ${OTLP_TOKEN}` }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ partialSuccess: {} });
    const row = f.store.read.query<{ via: string; have: number; body_state: string; agent: string }, []>(
      'SELECT via, have, body_state, agent FROM request').get()!;
    expect(row.via).toBe('otlp');
    expect(row.have).toBe(8);
    expect(row.body_state).toBe('summary');
    expect(row.agent).toBe('omp');
  } finally {
    f.close();
  }
});

test('JSON traces 同样受理；重发第二次仍 200 且不产生新行', async () => {
  const f = fixture();
  try {
    const handler = makeHandler(f.store);
    const body = JSON.stringify(tracesJson([{ resource: { service: 'claude-code' }, spans: [{
      traceId: SYNTH.traceB,
      spanId: SYNTH.spanLLM,
      name: 'claude_code.llm_request',
      startNano: SYNTH.msToNano(2000),
      attrs: { input_tokens: { int: 5 }, 'gen_ai.conversation.id': SYNTH.session },
    }] }]));
    const send = () => handler(otlpRequest('/v1/traces', body,
      { authorization: `Bearer ${OTLP_TOKEN}`, 'content-type': 'application/json' }));
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect((f.store.read.query('SELECT COUNT(*) AS n FROM request').get() as { n: number }).n).toBe(1);
    expect((f.store.read.query('SELECT agent FROM request').get() as { agent: string }).agent).toBe('claude');
  } finally {
    f.close();
  }
});

test('认证与来源矩阵：缺令牌 401、错令牌 401、伪 Host 403、GET 405、text/plain 415', async () => {
  const f = fixture();
  try {
    const handler = makeHandler(f.store);
    const payload = bytesBody(tracesProtobuf([{ resource: { service: 'oh-my-pi' }, spans: [OMP_CHAT_SPAN] }]));
    expect((await handler(otlpRequest('/v1/traces', payload))).status).toBe(401);
    expect((await handler(otlpRequest('/v1/traces', payload,
      { authorization: 'Bearer wrong' }))).status).toBe(401);
    expect((await handler(otlpRequest('/v1/traces', payload, {
      authorization: `Bearer ${OTLP_TOKEN}`, host: 'evil.example',
    }))).status).toBe(403);
    expect((await handler(new Request('http://127.0.0.1:8320/v1/traces', {
      method: 'GET', headers: { host: '127.0.0.1:8320', authorization: `Bearer ${OTLP_TOKEN}` },
    }))).status).toBe(405);
    // 能发 CORS 简单请求的 content-type 一律拒绝，不留给预检碰巧。
    expect((await handler(otlpRequest('/v1/traces', 'text', {
      authorization: `Bearer ${OTLP_TOKEN}`, 'content-type': 'text/plain',
    }))).status).toBe(415);
    expect((f.store.read.query('SELECT COUNT(*) AS n FROM request').get() as { n: number }).n).toBe(0);
  } finally {
    f.close();
  }
});

test('非法载荷 400 带原因码；未装配 OTLP 时 404', async () => {
  const f = fixture();
  try {
    const handler = makeHandler(f.store);
    const response = await handler(otlpRequest('/v1/traces', new Uint8Array([0x0b]),
      { authorization: `Bearer ${OTLP_TOKEN}` }));
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string; code: string };
    expect(body.error).toBe('invalid_otlp');
    expect(body.code).toBe('otlp_wire_type');

    const absent = createHandler(f.store, loadConfig({}), 'synthetic-read-token');
    expect((await absent(otlpRequest('/v1/traces', new Uint8Array([0x0a, 0x00]),
      { authorization: `Bearer ${OTLP_TOKEN}` }))).status).toBe(404);
  } finally {
    f.close();
  }
});

test('声明超限整批 413，不读正文', async () => {
  const f = fixture();
  try {
    const handler = makeHandler(f.store);
    const request = new Request('http://127.0.0.1:8320/v1/traces', {
      method: 'POST',
      body: bytesBody(tracesProtobuf([{ resource: { service: 'oh-my-pi' }, spans: [OMP_CHAT_SPAN] }])),
      headers: {
        host: '127.0.0.1:8320',
        'content-type': 'application/x-protobuf',
        authorization: `Bearer ${OTLP_TOKEN}`,
        'content-length': String(64 * 1024 * 1024 + 1),
      },
    });
    expect((await handler(request)).status).toBe(413);
  } finally {
    f.close();
  }
});

test('暂停档回 507 且不落任何行；logs 端点同规则', async () => {
  const f = fixture();
  try {
    const handler = makeHandler(f.store, {
      token: OTLP_TOKEN, salt: SALT,
      admission: () => ({ mode: 'paused', reason: 'disk_95' }),
    });
    const headers = { authorization: `Bearer ${OTLP_TOKEN}` };
    expect((await handler(otlpRequest('/v1/traces',
      bytesBody(tracesProtobuf([{ resource: { service: 'oh-my-pi' }, spans: [OMP_CHAT_SPAN] }])), headers))).status).toBe(507);
    expect((await handler(otlpRequest('/v1/logs',
      bytesBody(logsProtobuf([{ resource: { service: 'oh-my-pi' }, records: [{ body: 'omp.log' }] }])), headers))).status).toBe(507);
    expect((f.store.read.query('SELECT COUNT(*) AS n FROM request').get() as { n: number }).n).toBe(0);
    expect((f.store.read.query('SELECT COUNT(*) AS n FROM raw_otlp_log').get() as { n: number }).n).toBe(0);
  } finally {
    f.close();
  }
});

test('logs 端点受理 protobuf 与 JSON，OMP 汇总记录落原始层', async () => {
  const f = fixture();
  try {
    const handler = makeHandler(f.store);
    const headers = { authorization: `Bearer ${OTLP_TOKEN}` };
    const response = await handler(otlpRequest('/v1/logs',
      bytesBody(logsProtobuf([{ resource: { service: 'oh-my-pi' }, records: [
        { timeNano: SYNTH.msToNano(7), body: 'omp.log', severityText: 'WARN' },
      ] }])), headers));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ partialSuccess: {} });
    const json = await handler(otlpRequest('/v1/logs', JSON.stringify({
      resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: 'omp.log' } }] }] }],
    }), { ...headers, 'content-type': 'application/json' }));
    expect(json.status).toBe(200);
    expect((f.store.read.query('SELECT COUNT(*) AS n FROM raw_otlp_log').get() as { n: number }).n).toBe(2);
  } finally {
    f.close();
  }
});
