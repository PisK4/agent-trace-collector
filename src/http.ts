import { readFileSync } from 'node:fs';
import type { Config } from './config';
import { loadLocalSecret } from './config';
import { resolveRequestId } from './store';
import type { Store } from './store';
import { QueryInputError } from './queries/cursor';
import { getSummaryEntries, getSessionSummary } from './queries/session-summary';
import type { SummaryEntriesQuery } from './queries/session-summary';
import { getRequest, listRequests } from './queries/requests';
import { getRoute } from './queries/routes';
import { getStats } from './queries/stats';
import { listSessions } from './queries/sessions';
import { listTurns } from './queries/turns';
import { listBgJobs } from './queries/bg-jobs';
import { PAGE_MAX, bodyRangeError, getBodyPage } from './protocols';
import {
  getReadingBody, getReadingDetail, getToolResultReading, getContextItemReading,
  isValidReadingToken, ReadingConflictError,
} from './reading';
import { acceptHook } from './hook';
import type { HookAdmission, HookEnvelope } from './hook';
import { OtlpDecodeError } from './sources/otlp/decode';
import { decodeLogsBody, decodeTracesBody } from './sources/otlp/decode';
import { acceptOtlpLogs, acceptOtlpTraces } from './sources/otlp/ingest';
import { createIngestMetrics, type CapacityMetrics, type IngestMetrics } from './capacity';

const WEB_ROOT = new URL('../web/', import.meta.url);
const MAX_ENVELOPE_BYTES = 64 * 1024 * 1024;
/** 同时只接收一份大 envelope；模块级计数在单进程 collector 内有效。 */
let ingesting = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** 静态白名单是 web/ 目录的唯一发布面；测试用目录内容核对它的覆盖。 */
export const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/session-view.js': { file: 'session-view.js', type: 'text/javascript; charset=utf-8' },
  '/layout.js': { file: 'layout.js', type: 'text/javascript; charset=utf-8' },
  '/body-model.js': { file: 'body-model.js', type: 'text/javascript; charset=utf-8' },
  '/body-view.js': { file: 'body-view.js', type: 'text/javascript; charset=utf-8' },
  '/duration.js': { file: 'duration.js', type: 'text/javascript; charset=utf-8' },
  '/context-map.js': { file: 'context-map.js', type: 'text/javascript; charset=utf-8' },
  '/context-detail.js': { file: 'context-detail.js', type: 'text/javascript; charset=utf-8' },
  '/html.js': { file: 'html.js', type: 'text/javascript; charset=utf-8' },
  '/parts.js': { file: 'parts.js', type: 'text/javascript; charset=utf-8' },
  '/rail-facts.js': { file: 'rail-facts.js', type: 'text/javascript; charset=utf-8' },
  '/reader-store.js': { file: 'reader-store.js', type: 'text/javascript; charset=utf-8' },
  '/row-summary.js': { file: 'row-summary.js', type: 'text/javascript; charset=utf-8' },
  '/selection.js': { file: 'selection.js', type: 'text/javascript; charset=utf-8' },
  '/trace-commit.js': { file: 'trace-commit.js', type: 'text/javascript; charset=utf-8' },
  '/trace-dom.js': { file: 'trace-dom.js', type: 'text/javascript; charset=utf-8' },
  '/trace-preparation.js': { file: 'trace-preparation.js', type: 'text/javascript; charset=utf-8' },
  '/trace-pair.js': { file: 'trace-pair.js', type: 'text/javascript; charset=utf-8' },
  '/tool-summary.js': { file: 'tool-summary.js', type: 'text/javascript; charset=utf-8' },
  '/trace-view.js': { file: 'trace-view.js', type: 'text/javascript; charset=utf-8' },
  '/url-route.js': { file: 'url-route.js', type: 'text/javascript; charset=utf-8' },
  '/turn-band.js': { file: 'turn-band.js', type: 'text/javascript; charset=utf-8' },
};

export function loadReadToken(dataDir: string): string {
  return Buffer.from(loadLocalSecret(dataDir, 'read.token')).toString('base64url');
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extra,
    },
  });
}

function allowedHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}

type Verdict = 'ok' | 'host' | 'origin' | 'unauthorized';

/**
 * Host 与 Origin 的共享边界段：host 不合法返回 'host'；Origin 存在且不是
 * 本机同源（含 'null'）时返回 'origin'。Origin 缺失或同源时返回 null，
 * 由调用方走各自的分支：读路径允许 same-site 与导航放行，hook 仍必须 Bearer。
 */
function checkHostOrigin(req: Request, port: number): 'host' | 'origin' | null {
  const host = req.headers.get('host');
  if (host === null || !allowedHosts(port).has(host)) return 'host';
  const origin = req.headers.get('origin');
  if (origin !== null && (origin === 'null' || origin !== `http://${host}`)) return 'origin';
  return null;
}

function checkAccess(req: Request, port: number, readToken: string, isNavigation: boolean): Verdict {
  const hostOrigin = checkHostOrigin(req, port);
  if (hostOrigin !== null) return hostOrigin;
  const origin = req.headers.get('origin');
  if (origin === null) {
    const authorization = req.headers.get('authorization');
    if (authorization !== null && authorization.startsWith('Bearer ') &&
        timingSafeEqual(authorization.slice(7), readToken)) {
      return 'ok';
    }
    const site = req.headers.get('sec-fetch-site');
    if (site === 'same-origin') return 'ok';
    // 正常顶层导航与直接打开书签不带 Origin，只信任浏览器的导航元数据。
    if (isNavigation && site === 'none' && req.headers.get('sec-fetch-mode') === 'navigate') return 'ok';
    return 'unauthorized';
  }
  return 'ok';
}

function parseLimit(url: URL, fallback: number): number {
  const raw = url.searchParams.get('limit');
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) throw new QueryInputError('invalid_limit');
  return Number(raw);
}

function parseIndex(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) throw new QueryInputError('invalid_body_range');
  return Number(raw);
}

/**
 * 汇总条目点击查询的参数解析。每类一个 kind，name/path 缺失或多余参数都显式 400，
 * 不静默回退——定位查错误输入比查错结果更难发现。
 */
function summaryEntriesQuery(url: URL): SummaryEntriesQuery | null {
  const kind = url.searchParams.get('kind');
  const name = url.searchParams.get('name');
  const path = url.searchParams.get('path');
  if (kind === 'interrupts') {
    return name === null && path === null ? { kind } : null;
  }
  if (kind === 'tool' || kind === 'skill') {
    return name !== null && name.length > 0 && path === null ? { kind, name } : null;
  }
  if (kind === 'written' || kind === 'read') {
    return path !== null && path.length > 0 && name === null ? { kind, path } : null;
  }
  return null;
}

async function serveStatic(path: string): Promise<Response> {
  const entry = STATIC_FILES[path];
  if (entry === undefined) return json({ error: 'not_found' }, 404);
  let body: string;
  try {
    body = readFileSync(new URL(entry.file, WEB_ROOT), 'utf8');
  } catch {
    return json({ error: 'not_found' }, 404);
  }
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': entry.type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      // 页面样式是内联 <style> 与内联 style 属性；脚本仍只允许同源文件。
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    },
  });
}

/**
 * hook 接收端点。
 *
 * 顺序固定：Host → 精确 Origin → 常量时间令牌 → 来源 → 流式计字节 → 解析。
 * 同时在读的 envelope 只允许一份，额外请求直接 429，避免多份大 JSON 撑爆内存。
 */
async function handleHookIngest(
  req: Request,
  store: Store,
  config: Config,
  hook: { token: string; salt: Uint8Array; admission?: () => HookAdmission } | undefined,
  metrics: IngestMetrics,
): Promise<Response> {
  if (hook === undefined) {
    metrics.reject('hook_unavailable');
    return json({ error: 'hook_unavailable' }, 404);
  }
  // 与读路径共用 Host/Origin 边界段；Origin 通过后 hook 仍必须 Bearer，
  // 不继承读路径的 same-site 与导航放行。
  const hostOrigin = checkHostOrigin(req, config.port);
  if (hostOrigin !== null) {
    metrics.reject(hostOrigin);
    return json({ error: hostOrigin }, 403);
  }
  const authorization = req.headers.get('authorization');
  if (authorization === null || !authorization.startsWith('Bearer ') ||
      !timingSafeEqual(authorization.slice(7), hook.token)) {
    metrics.reject('unauthorized');
    return json({ error: 'unauthorized' }, 401);
  }
  if (req.method !== 'POST') {
    metrics.reject('method_not_allowed');
    return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
  }
  if (ingesting) {
    metrics.reject('busy');
    return json({ error: 'busy' }, 429);
  }

  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_ENVELOPE_BYTES) {
    metrics.reject('envelope_too_large');
    return json({ error: 'envelope_too_large' }, 413);
  }

  ingesting = true;
  try {
    const text = await readBounded(req, MAX_ENVELOPE_BYTES);
    if (text === null) {
      metrics.reject('envelope_too_large');
      return json({ error: 'envelope_too_large' }, 413);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      metrics.reject('invalid_json');
      return json({ error: 'invalid_json' }, 400);
    }
    if (!isRecord(parsed)) {
      metrics.reject('invalid_json');
      return json({ error: 'invalid_json' }, 400);
    }
    const envelope = parsed as unknown as HookEnvelope;
    if (typeof envelope.hook_id !== 'string' || envelope.hook_id.length === 0) {
      metrics.reject('missing_hook_id');
      return json({ error: 'missing_hook_id' }, 422);
    }
    if (envelope.origin !== 'local') {
      metrics.reject('origin_not_local');
      return json({ error: 'origin' }, 403);
    }

    try {
      const result = acceptHook(store, envelope, Date.now(), hook.salt, { admission: hook.admission });
      metrics.accept({
        duplicate: result.duplicate,
        requestBytes: envelope.request_bytes,
        replyBytes: envelope.reply_bytes,
      });
      return json(result, 200);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'unknown';
      if (code === 'disk_full') {
        metrics.reject('insufficient_storage');
        return json({ error: 'insufficient_storage' }, 507);
      }
      metrics.reject('writer_failed');
      return json({ error: 'writer_failed', code }, 503);
    }
  } finally {
    ingesting = false;
  }
}

/** 只读上限内的字节；超限立即返回 null，不把剩余内容读进内存。 */
async function readBounded(req: Request, limit: number): Promise<string | null> {
  const bytes = await readBoundedBytes(req, limit);
  return bytes === null ? null : Buffer.from(bytes).toString('utf8');
}

/** readBounded 的二进制形态：protobuf 载荷不能过 UTF-8 往返。 */
async function readBoundedBytes(req: Request, limit: number): Promise<Uint8Array | null> {
  const body = req.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
}

/**
 * OTLP 接收端点（/v1/traces 与 /v1/logs）。
 *
 * 顺序与 hook 对齐：Host/Origin → 常量时间 Bearer → 方法 → content-type
 * 白名单（浏览器防线三件套之一：非 safelisted content-type 会先卡预检）→
 * 共用单飞守卫 → 流式计字节 → 解码 → 入库。
 * 成功回 OTLP 规范的 200 与 `{"partialSuccess":{}}`；一切失败显式 4xx/5xx，不静默丢弃。
 */
async function handleOtlpIngest(
  req: Request,
  store: Store,
  config: Config,
  otlp: { token: string; salt: Uint8Array; admission?: () => HookAdmission } | undefined,
  metrics: IngestMetrics,
  signal: 'traces' | 'logs',
): Promise<Response> {
  if (otlp === undefined) {
    metrics.reject('otlp_unavailable');
    return json({ error: 'otlp_unavailable' }, 404);
  }
  const hostOrigin = checkHostOrigin(req, config.port);
  if (hostOrigin !== null) {
    metrics.reject(hostOrigin);
    return json({ error: hostOrigin }, 403);
  }
  const authorization = req.headers.get('authorization');
  if (authorization === null || !authorization.startsWith('Bearer ') ||
      !timingSafeEqual(authorization.slice(7), otlp.token)) {
    metrics.reject('unauthorized');
    return json({ error: 'unauthorized' }, 401);
  }
  if (req.method !== 'POST') {
    metrics.reject('method_not_allowed');
    return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
  }
  const contentType = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (contentType !== 'application/x-protobuf' && contentType !== 'application/json') {
    // text/plain 这类能发 CORS 简单请求的形态必须显式拒绝，防线不靠碰巧。
    metrics.reject('unsupported_media_type');
    return json({ error: 'unsupported_media_type' }, 415);
  }
  if (ingesting) {
    metrics.reject('busy');
    return json({ error: 'busy' }, 429);
  }
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_ENVELOPE_BYTES) {
    metrics.reject('envelope_too_large');
    return json({ error: 'envelope_too_large' }, 413);
  }

  ingesting = true;
  try {
    const bytes = await readBoundedBytes(req, MAX_ENVELOPE_BYTES);
    if (bytes === null) {
      metrics.reject('envelope_too_large');
      return json({ error: 'envelope_too_large' }, 413);
    }
    const kind = contentType === 'application/json' ? 'json' : 'protobuf';
    const options = { admission: otlp.admission };
    try {
      if (signal === 'traces') {
        const payload = decodeTracesBody(bytes, kind);
        const result = acceptOtlpTraces(store, payload, Date.now(), otlp.salt, options);
        metrics.accept({ duplicate: result.spanDuplicates > 0, requestBytes: bytes.length, replyBytes: 0 });
      } else {
        const payload = decodeLogsBody(bytes, kind);
        const result = acceptOtlpLogs(store, payload, Date.now(), otlp.salt, options);
        metrics.accept({ duplicate: result.duplicates > 0, requestBytes: bytes.length, replyBytes: 0 });
      }
      return json({ partialSuccess: {} });
    } catch (error) {
      if (error instanceof OtlpDecodeError) {
        metrics.reject('invalid_otlp');
        return json({ error: 'invalid_otlp', code: error.code }, 400);
      }
      const code = error instanceof Error ? error.message : 'unknown';
      if (code === 'disk_full') {
        metrics.reject('insufficient_storage');
        return json({ error: 'insufficient_storage' }, 507);
      }
      metrics.reject('writer_failed');
      return json({ error: 'writer_failed', code }, 503);
    }
  } finally {
    ingesting = false;
  }
}

export function createHandler(
  store: Store,
  config: Config,
  readToken: string,
  hook?: { token: string; salt: Uint8Array; admission?: () => HookAdmission },
  metrics?: CapacityMetrics,
  otlp?: { token: string; salt: Uint8Array; admission?: () => HookAdmission },
): (req: Request) => Promise<Response> {
  // hook 计数在未注入观测运行时也保留，只是没有对外入口。
  const ingestMetrics = metrics?.ingest ?? createIngestMetrics();
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === '/hook/ingest') {
      return await handleHookIngest(req, store, config, hook, ingestMetrics);
    }
    if (url.pathname === '/v1/traces') {
      return await handleOtlpIngest(req, store, config, otlp, ingestMetrics, 'traces');
    }
    if (url.pathname === '/v1/logs') {
      return await handleOtlpIngest(req, store, config, otlp, ingestMetrics, 'logs');
    }
    const isNavigation = !url.pathname.startsWith('/api/');
    const verdict = checkAccess(req, config.port, readToken, isNavigation);
    if (verdict !== 'ok') {
      return json({ error: verdict === 'unauthorized' ? 'unauthorized' : verdict }, verdict === 'unauthorized' ? 401 : 403);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, HEAD' });
    }

    const path = url.pathname;
    if (!path.startsWith('/api/')) return await serveStatic(path);

    try {
      if (path === '/api/ingest-metrics') {
        if (metrics === undefined) return json({ error: 'metrics_unavailable' }, 404);
        return json(metrics.snapshot(store, config.dataDir));
      }

      if (path === '/api/stats') return json(getStats(store));

      if (path === '/api/sessions') {
        const limit = parseLimit(url, 50);
        return json(listSessions(store, limit, url.searchParams.get('cursor')));
      }

      const requestsMatch = /^\/api\/sessions\/([^/]+)\/requests$/.exec(path);
      if (requestsMatch !== null) {
        const key = decodeURIComponent(requestsMatch[1]!);
        const limit = parseLimit(url, 100);
        const rawDirection = url.searchParams.get('direction');
        // 缺参数保持 forward；未知方向显式 400，不静默忽略。
        const direction = rawDirection === null ? 'forward' : rawDirection;
        if (direction !== 'forward' && direction !== 'older') {
          return json({ error: 'invalid_direction' }, 400);
        }
        return json(listRequests(store, key, limit, url.searchParams.get('cursor'), direction));
      }

      const turnsMatch = /^\/api\/sessions\/([^/]+)\/turns$/.exec(path);
      if (turnsMatch !== null) {
        const key = decodeURIComponent(turnsMatch[1]!);
        // from 是累计窗口下界（浏览器已加载的最早请求）；缺参数按全会话结算。
        const rawFrom = url.searchParams.get('from');
        let from: number | null = null;
        if (rawFrom !== null) {
          if (!/^\d+$/.test(rawFrom)) return json({ error: 'invalid_from' }, 400);
          from = Number(rawFrom);
        }
        return json(listTurns(store, key, from));
      }

      const bgJobsMatch = /^\/api\/sessions\/([^/]+)\/bg-jobs$/.exec(path);
      if (bgJobsMatch !== null) {
        return json(listBgJobs(store, decodeURIComponent(bgJobsMatch[1]!)));
      }

      const summaryMatch = /^\/api\/sessions\/([^/]+)\/summary$/.exec(path);
      if (summaryMatch !== null) {
        return json(getSessionSummary(store, decodeURIComponent(summaryMatch[1]!)));
      }

      const summaryEntriesMatch = /^\/api\/sessions\/([^/]+)\/summary\/entries$/.exec(path);
      if (summaryEntriesMatch !== null) {
        const key = decodeURIComponent(summaryEntriesMatch[1]!);
        const query = summaryEntriesQuery(url);
        if (query === null) return json({ error: 'invalid_entries_query' }, 400);
        return json(getSummaryEntries(store, key, query));
      }

      const requestMatch = /^\/api\/requests\/(\d+)$/.exec(path);
      if (requestMatch !== null) {
        const detail = getReadingDetail(store, Number(requestMatch[1]));
        if (detail === null) return json({ error: 'not_found' }, 404);
        return json(detail);
      }

      const toolResultMatch = /^\/api\/requests\/(\d+)\/tools\/(\d+)\/result$/.exec(path);
      if (toolResultMatch !== null) {
        // 工具结果必须带阅读版本：没有版本就没有「同一批派生输入」的保证。
        const expected = url.searchParams.get('if_reading');
        if (expected === null || !isValidReadingToken(expected)) {
          return json({ error: 'invalid_reading_token' }, 400);
        }
        const reading = getToolResultReading(store, Number(toolResultMatch[1]), Number(toolResultMatch[2]), expected);
        if (reading === null) return json({ error: 'not_found' }, 404);
        return json(reading);
      }

      const contextItemMatch = /^\/api\/requests\/(\d+)\/context-item$/.exec(path);
      if (contextItemMatch !== null) {
        // 目录与正文同规：必须带阅读版本，读取期间派生输入变化一律 409。
        const expected = url.searchParams.get('if_reading');
        if (expected === null || !isValidReadingToken(expected)) {
          return json({ error: 'invalid_reading_token' }, 400);
        }
        const kind = url.searchParams.get('kind');
        if (kind === null || kind.length === 0) return json({ error: 'invalid_context_item_query' }, 400);
        const reading = getContextItemReading(store, Number(contextItemMatch[1]), {
          kind,
          name: url.searchParams.get('name'),
          tag: url.searchParams.get('tag'),
          cursor: url.searchParams.get('cursor'),
        }, expected);
        if (reading === null) return json({ error: 'not_found' }, 404);
        return json(reading);
      }

      const routeMatch = /^\/api\/requests\/(\d+)\/route$/.exec(path);
      if (routeMatch !== null) {
        const id = Number(routeMatch[1]);
        if (getRequest(store, id) === null) return json({ error: 'not_found' }, 404);
        return json(getRoute(store, id));
      }

      const bodyMatch = /^\/api\/requests\/(\d+)\/body$/.exec(path);
      if (bodyMatch !== null) {
        const canonical = resolveRequestId(store, Number(bodyMatch[1]));
        if (canonical === null) return json({ error: 'not_found' }, 404);
        const from = parseIndex(url, 'from', 0);
        const to = parseIndex(url, 'to', from + PAGE_MAX);
        // 区间规则与 protocols.getBodyPage 的防御共用同一条（bodyRangeError）。
        const rangeError = bodyRangeError(from, to);
        if (rangeError !== null) return json({ error: rangeError }, 400);
        const expected = url.searchParams.get('if_reading');
        if (expected !== null && !isValidReadingToken(expected)) {
          return json({ error: 'invalid_reading_token' }, 400);
        }
        const page = getReadingBody(store, canonical, from, to, expected);
        if (page === null) return json({ error: 'not_found' }, 404);
        return json(page);
      }

      return json({ error: 'not_found' }, 404);
    } catch (error) {
      if (error instanceof QueryInputError) return json({ error: error.message }, 400);
      if (error instanceof ReadingConflictError) return json({ error: 'reading_changed' }, 409);
      return json({ error: 'internal_error' }, 500);
    }
  };
}
