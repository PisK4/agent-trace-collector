import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 仅为本机原型提供只读窗口和同源 API，不启动采集或派生。
const port = 8768;
const dataDir = join(homedir(), 'Library', 'Application Support', 'agent-trace-collector');
const db = new Database(join(dataDir, 'trace.db'), { readonly: true });
db.exec('PRAGMA query_only=ON');
const token = readFileSync(join(dataDir, 'read.token')).toString('base64url');
const files: Record<string, [URL, string]> = {
  '/': [new URL('./trace-reader-prototype.html', import.meta.url), 'text/html; charset=utf-8'],
  '/trace-reader-prototype.html': [new URL('./trace-reader-prototype.html', import.meta.url), 'text/html; charset=utf-8'],
  '/local-data.js': [new URL('./local-data.js', import.meta.url), 'text/javascript; charset=utf-8'],
  '/web/body-view.js': [new URL('../web/body-view.js', import.meta.url), 'text/javascript; charset=utf-8'],
};
const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { ...headers, 'content-type': 'application/json' } });
Bun.serve({
  hostname: '127.0.0.1', port,
  async fetch(req) {
    const url = new URL(req.url);
    const host = req.headers.get('host');
    if (!['127.0.0.1:'+port, 'localhost:'+port].includes(host ?? '')) return json({ error: 'host' }, 403);
    const origin = req.headers.get('origin');
    if (origin !== null && origin !== 'http://'+host) return json({ error: 'origin' }, 403);
    if (req.method !== 'GET') return json({ error: 'method' }, 405);
    if (url.pathname.startsWith('/api/')) {
      if (origin === null && req.headers.get('sec-fetch-site') !== 'same-origin') return json({ error: 'same_origin_required' }, 403);
      if (url.pathname === '/api/local-session') {
        const prefix = url.searchParams.get('prefix') || '';
        if (!/^[a-zA-Z0-9-]{4,80}$/.test(prefix)) return json({ error: 'session_prefix' }, 400);
        const matches = db.query('SELECT conv_key,COUNT(*) AS total FROM request WHERE conv_key LIKE ? GROUP BY conv_key LIMIT 2').all('%'+prefix+'%') as {conv_key:string;total:number}[];
        if (matches.length !== 1) return json({ error: matches.length ? 'session_ambiguous' : 'session_not_found' }, 400);
        const match = matches[0]!;
        const latest = db.query('SELECT title,agent FROM request WHERE conv_key=? ORDER BY started_ms DESC,req_id DESC LIMIT 1').get(match.conv_key) as {title:string;agent:string|null};
        return json({key:match.conv_key,session:match.conv_key,title:latest.title,agent:latest.agent || '未知',requests:[],total:match.total});
      }
      if (url.pathname === '/api/local-window') {
        const session = url.searchParams.get('session');
        if (!session) return json({ error: 'session_required' }, 400);
        let before: number[] | null = null;
        try { before = JSON.parse(url.searchParams.get('before') ?? 'null'); } catch { return json({ error: 'cursor' }, 400); }
        if (before !== null && (!Array.isArray(before) || before.length !== 2 || !before.every(Number.isSafeInteger))) return json({ error: 'cursor' }, 400);
        const rows = before === null
          ? db.query('SELECT req_id, started_ms FROM request WHERE conv_key=? ORDER BY started_ms DESC, req_id DESC LIMIT 31').all(session)
          : db.query('SELECT req_id, started_ms FROM request WHERE conv_key=? AND (started_ms,req_id)<(?,?) ORDER BY started_ms DESC, req_id DESC LIMIT 31').all(session, before[0]!, before[1]!);
        const selected = (rows as {req_id:number;started_ms:number}[]).slice(0,30).reverse();
        return json({ items: selected, more: rows.length > 30 });
      }
      if (!/^\/api\/sessions(?:\/[^/]+\/requests)?$|^\/api\/requests\/\d+(?:\/body|\/route)?$/.test(url.pathname)) return json({ error: 'not_found' }, 404);
      try {
        const upstream = await fetch('http://127.0.0.1:8320'+url.pathname+url.search, { headers: { authorization: 'Bearer '+token }, signal: AbortSignal.timeout(15000) });
        return new Response(upstream.body, { status: upstream.status, headers: { ...headers, 'content-type': 'application/json' } });
      } catch { return json({ error: 'collector_unavailable' }, 503); }
    }
    const file = files[url.pathname];
    if (!file) return json({ error: 'not_found' }, 404);
    return new Response(Bun.file(file[0]), { headers: { ...headers, 'content-type': file[1] } });
  },
});
console.log('本机真实数据原型：http://127.0.0.1:'+port+'/?data=local');
