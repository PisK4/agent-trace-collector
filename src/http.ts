import { readFileSync } from 'node:fs';
import type { Config } from './config';
import { loadLocalSecret } from './config';
import type { Store } from './store';
import {
  QueryInputError,
  getRequest,
  getRoute,
  getStats,
  listRequests,
  listSessions,
} from './queries';

const WEB_ROOT = new URL('../web/', import.meta.url);
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
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

function checkAccess(req: Request, port: number, readToken: string, isNavigation: boolean): Verdict {
  const host = req.headers.get('host');
  if (host === null || !allowedHosts(port).has(host)) return 'host';
  const origin = req.headers.get('origin');
  const site = req.headers.get('sec-fetch-site');
  if (origin === null) {
    const authorization = req.headers.get('authorization');
    if (authorization !== null && authorization.startsWith('Bearer ') &&
        timingSafeEqual(authorization.slice(7), readToken)) {
      return 'ok';
    }
    if (site === 'same-origin') return 'ok';
    // 正常顶层导航与直接打开书签不带 Origin，只信任浏览器的导航元数据。
    if (isNavigation && site === 'none' && req.headers.get('sec-fetch-mode') === 'navigate') return 'ok';
    return 'unauthorized';
  }
  const expected = `http://${host}`;
  if (origin === 'null' || origin !== expected) return 'origin';
  return 'ok';
}

function parseLimit(url: URL, fallback: number): number {
  const raw = url.searchParams.get('limit');
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) throw new QueryInputError('invalid_limit');
  return Number(raw);
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

export function createHandler(
  store: Store,
  config: Config,
  readToken: string,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
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
      if (path === '/api/stats') return json(getStats(store));

      if (path === '/api/sessions') {
        const limit = parseLimit(url, 50);
        return json(listSessions(store, limit, url.searchParams.get('cursor')));
      }

      const requestsMatch = /^\/api\/sessions\/([^/]+)\/requests$/.exec(path);
      if (requestsMatch !== null) {
        const key = decodeURIComponent(requestsMatch[1]!);
        const limit = parseLimit(url, 100);
        return json(listRequests(store, key, limit, url.searchParams.get('cursor')));
      }

      const requestMatch = /^\/api\/requests\/(\d+)$/.exec(path);
      if (requestMatch !== null) {
        const detail = getRequest(store, Number(requestMatch[1]));
        if (detail === null) return json({ error: 'not_found' }, 404);
        return json(detail);
      }

      const routeMatch = /^\/api\/requests\/(\d+)\/route$/.exec(path);
      if (routeMatch !== null) {
        const id = Number(routeMatch[1]);
        if (getRequest(store, id) === null) return json({ error: 'not_found' }, 404);
        return json(getRoute(store, id));
      }

      return json({ error: 'not_found' }, 404);
    } catch (error) {
      if (error instanceof QueryInputError) return json({ error: error.message }, 400);
      return json({ error: 'internal_error' }, 500);
    }
  };
}
