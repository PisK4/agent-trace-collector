import { createHmac } from 'node:crypto';

export type RedactRule = { path: string; pattern: string };

const PLACEHOLDER = /^\[redacted:[a-z_]+:[0-9a-f]{16}\]$/;
const SENSITIVE_KEYS = new Set([
  'authorization', 'x-api-key', 'api-key', 'api_key', 'apikey', 'cookie', 'set-cookie',
  'password', 'passwd', 'client_secret', 'secret_key', 'access_token', 'refresh_token',
  'id_token', 'aws_secret_access_key', 'private_key',
  // 账号与 provider 账号指向同一订阅身份，两者必须得到同一个占位符；
  // 否则同一个账号在两个入口下看起来像两个不同的人。
  'account', 'provideraccount', 'providerkeyid',
]);
const HEADER_WHITELIST = new Set([
  'content-type', 'content-length', 'accept', 'accept-encoding', 'accept-language',
  'user-agent', 'host', 'connection', 'cache-control', 'anthropic-version',
  'anthropic-beta', 'openai-organization', 'openai-project', 'openai-beta', 'x-request-id',
]);

/**
 * 稳定占位符：同一 salt 下同一 (kind, 值) 永远得到同一个摘要。
 *
 * 已是占位符的值原样返回。敏感键分支、请求头分支与字符串分支都走这里，
 * 所以重复脱敏不会把一个占位符再散列成另一个。
 */
function placeholder(kind: string, value: string, salt: Uint8Array): string {
  if (PLACEHOLDER.test(value)) return value;
  const digest = createHmac('sha256', salt).update(kind).update('\0').update(value).digest('hex');
  return `[redacted:${kind}:${digest.slice(0, 16)}]`;
}

function credentialValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function pathMatches(rulePath: string, path: string): boolean {
  return rulePath === '*' || rulePath === path || path.startsWith(`${rulePath}.`);
}

function replaceMatches(text: string, pattern: RegExp, kind: string, salt: Uint8Array): string {
  return text.replace(pattern, match => placeholder(kind, match, salt));
}

function redactString(text: string, path: string, salt: Uint8Array, rules: { path: string; regex: RegExp }[]): string {
  let value = text;
  value = replaceMatches(value, /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, 'private_key', salt);
  value = replaceMatches(value, /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'bearer', salt);
  value = replaceMatches(value, /\bsk-[A-Za-z0-9_-]{8,}\b/g, 'api_key', salt);
  value = replaceMatches(value, /\bAKIA[0-9A-Z]{16}\b/g, 'aws_key', salt);
  value = replaceMatches(value, /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, 'jwt', salt);
  for (const rule of rules) {
    if (pathMatches(rule.path, path)) value = replaceMatches(value, rule.regex, 'custom', salt);
  }
  return value;
}

function redactHeaders(headers: Record<string, unknown>, salt: Uint8Array, rules: { path: string; regex: RegExp }[], path: string): unknown {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HEADER_WHITELIST.has(key.toLowerCase())) out[key] = walk(value, `${path}.${key}`, salt, rules);
    else out[key] = placeholder('header', credentialValue(value), salt);
  }
  return out;
}

function walk(value: unknown, path: string, salt: Uint8Array, rules: { path: string; regex: RegExp }[]): unknown {
  if (typeof value === 'string') {
    if (PLACEHOLDER.test(value)) return value;
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return JSON.stringify(walk(JSON.parse(trimmed), path, salt, rules));
      } catch {
        // Not a JSON document; fall through to pattern replacement.
      }
    }
    return redactString(value, path, salt, rules);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => walk(item, `${path}[${index}]`, salt, rules));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = path === '' ? key : `${path}.${key}`;
      if (typeof child === 'string' && /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(child)) {
        out[key] = placeholder('private_key', child, salt);
      } else if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        out[key] = placeholder('credential', credentialValue(child), salt);
      } else if (['headers', 'header'].includes(key.toLowerCase()) && child !== null && typeof child === 'object' && !Array.isArray(child)) {
        out[key] = redactHeaders(child as Record<string, unknown>, salt, rules, childPath);
      } else {
        out[key] = walk(child, childPath, salt, rules);
      }
    }
    return out;
  }
  return value;
}

export function redact(value: unknown, salt: Uint8Array, rules: RedactRule[] = []): unknown {
  const compiled = rules.map(rule => {
    try {
      return { path: rule.path, regex: new RegExp(rule.pattern, 'g') };
    } catch {
      throw new Error('invalid_redact_rule');
    }
  });
  return walk(value, '', salt, compiled);
}
