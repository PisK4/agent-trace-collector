import { expect, test } from 'bun:test';
import { fixture } from './fixtures';
import { redact } from '../src/privacy';

const salt = new Uint8Array(32).fill(7);

test('脱敏工具参数字符串并保留 token 计数和关联 ID', () => {
  const input = {
    usage: { input_tokens: 123, output_tokens: 45 },
    tool_call_id: 'call_demo',
    tools: [{ name: 'lookup', input_schema: { type: 'object', properties: { token: { type: 'string' } } } }],
    arguments: JSON.stringify({ headers: { authorization: 'Bearer synthetic-secret-123' } }),
  };
  const a = redact(input, salt) as typeof input;
  expect(JSON.stringify(a)).not.toContain('synthetic-secret-123');
  expect(a).toEqual(redact(input, salt) as typeof input);
  expect(a.usage).toEqual(input.usage);
  expect(a.tool_call_id).toBe('call_demo');
  expect(a.tools).toEqual(input.tools);
});

test('同类同值凭证得到相同占位符且再次脱敏不变', () => {
  const first = redact({ a: 'sk-synthetic-abcdefgh', b: 'sk-synthetic-abcdefgh' }, salt) as Record<string, string>;
  expect(first.a).toBe(first.b);
  expect(first.a).toMatch(/^\[redacted:api_key:[0-9a-f]{16}\]$/);
  const again = redact(first, salt) as Record<string, string>;
  expect(again.a).toBe(first.a);

  const other = redact({ a: 'sk-synthetic-abcdefgh' }, new Uint8Array(32).fill(9)) as Record<string, string>;
  expect(other.a).not.toBe(first.a);
});

test('请求头白名单保留、凭证头替换、账号字段占位', () => {
  const input = {
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer synthetic-secret',
      'x-api-key': 'synthetic-key',
    },
    providerAccount: 'synthetic-account',
    providerKeyId: 'synthetic-key-id',
  };
  const out = redact(input, salt) as Record<string, unknown>;
  const headers = out.headers as Record<string, string>;
  expect(headers['content-type']).toBe('application/json');
  expect(headers.authorization).toContain('[redacted:');
  expect(headers['x-api-key']).toContain('[redacted:');
  expect(out.providerAccount).toContain('[redacted:credential:');
  expect(out.providerKeyId).toContain('[redacted:credential:');
});

test('已知凭证形态与私钥块被替换且非JSON字符串保留原样', () => {
  const input = {
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c2lnbmF0dXJl',
    aws: 'AKIAABCDEFGHIJKLMNOP',
    key: '-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----',
    plain: '普通中文内容',
  };
  const out = redact(input, salt) as Record<string, string>;
  expect(out.jwt).toContain('[redacted:jwt:');
  expect(out.aws).toContain('[redacted:aws_key:');
  expect(out.key).toContain('[redacted:private_key:');
  expect(out.plain).toBe('普通中文内容');
});

test('account别名共享占位符且已脱敏值不再散列', () => {
  const input = { account: 'synthetic-account', providerAccount: 'synthetic-account' };
  const first = redact(input, salt) as Record<string, string>;
  expect(first.account).toMatch(/^\[redacted:credential:[0-9a-f]{16}\]$/);
  expect(first.account).toBe(first.providerAccount);
  expect(redact(first, salt)).toEqual(first);

  const existing = '[redacted:credential:0123456789abcdef]';
  expect(redact({
    account: existing,
    providerAccount: existing,
    headers: { authorization: existing },
  }, salt)).toEqual({
    account: existing,
    providerAccount: existing,
    headers: { authorization: existing },
  });
});

test('非法自定义规则使配置启动失败', () => {
  expect(() => redact({ a: 'x' }, salt, [{ path: '*', pattern: '(' }])).toThrow('invalid_redact_rule');
});

test('脱敏不改变字段结构与数组顺序', () => {
  const input = {
    system: [{ type: 'text', text: 'system' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'A' }, { type: 'image', source: { url: 'https://synthetic.example/x.png' } }] },
    ],
  };
  expect(redact(input, salt)).toEqual(input);
});

test('fixture 数据集不写入真实凭证', () => {
  const f = fixture();
  try {
    expect(f.dir.startsWith('/var/folders/') || f.dir.startsWith('/tmp/')).toBe(true);
  } finally {
    f.close();
  }
});
