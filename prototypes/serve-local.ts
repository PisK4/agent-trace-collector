import { loadConfig } from '../src/config';
import { loadReadToken } from '../src/http';
import { WEB_HEADERS, serveWeb } from './static-web';

// 本机真实数据的 Demo：只把生产页面和只读 API 转出来，不启动采集或派生，
// 也不自带第二套界面或查询实现。API 形状完全由 collector 决定。
const port = 8768;
const config = loadConfig();
const token = loadReadToken(config.dataDir);
const collector = `http://127.0.0.1:${config.port}`;

const headers = WEB_HEADERS;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { ...headers, 'content-type': 'application/json' } });

Bun.serve({
  hostname: '127.0.0.1', port,
  async fetch(req) {
    const url = new URL(req.url);
    const host = req.headers.get('host');
    if (!['127.0.0.1:'+port, 'localhost:'+port].includes(host ?? '')) return json({ error: 'host' }, 403);
    const origin = req.headers.get('origin');
    if (origin !== null && origin !== 'http://'+host) return json({ error: 'origin' }, 403);
    if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: 'method' }, 405);
    if (url.pathname.startsWith('/api/')) {
      try {
        const upstream = await fetch(collector + url.pathname + url.search, {
          headers: { authorization: 'Bearer ' + token },
          signal: AbortSignal.timeout(15000),
        });
        return new Response(upstream.body, {
          status: upstream.status,
          headers: { ...headers, 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
        });
      } catch {
        return json({ error: 'collector_unavailable' }, 503);
      }
    }
    const staticResponse = await serveWeb(url.pathname);
    return staticResponse ?? json({ error: 'not_found' }, 404);
  },
});
console.log('本机真实数据 Demo：http://127.0.0.1:'+port+'/');
console.log('collector：'+collector);
