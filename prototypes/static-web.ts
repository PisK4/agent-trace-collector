// Demo 的静态层：把 web/ 目录按请求路径直接读出来，不维护模块清单。
// 生产新增或改名模块时，两个 Demo 入口不需要同步；路径只允许根目录下的文件名，
// 不接受子目录与 ..，避免把仓库其它文件带出去。
const WEB_ROOT = new URL('../web/', import.meta.url);
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

export const WEB_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  // 页面样式是内联 <style> 与内联 style 属性；脚本仍只允许同源文件。
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

const ENTRY = new Set(['/', '/production', '/trace-reader-prototype.html']);

export async function serveWeb(pathname: string): Promise<Response | null> {
  if (pathname.startsWith('/api/')) return null;
  const name = ENTRY.has(pathname) ? 'index.html' : pathname.slice(1);
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  const file = Bun.file(new URL(name, WEB_ROOT));
  if (!(await file.exists())) return null;
  const dot = name.lastIndexOf('.');
  const type = dot === -1 ? 'application/octet-stream' : TYPES[name.slice(dot)] ?? 'application/octet-stream';
  return new Response(file, { headers: { ...WEB_HEADERS, 'content-type': type } });
}
