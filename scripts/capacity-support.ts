/**
 * 容量实验的合成来源与隔离配置。所有正文、会话与模型名都是占位值；
 * 生成器固定种子，报告可复现，且不读取任何真实数据路径。
 */
import { join } from 'node:path';
import type { HookEnvelope } from '../src/hook';
import type { Config } from '../src/config';

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export type EnvelopeInput = {
  hookId: string; session: string; routeId: number;
  requestBytes: number; replyBytes: number;
  bodyOmitted: boolean; omitReason: string | null;
  model: string; startedMs: number;
};

function sizedText(target: number, fill: string): string {
  const base = `${fill}:`;
  if (target <= base.length) return base.slice(0, target);
  return base + fill.repeat(Math.ceil((target - base.length) / fill.length));
}

/** 共享历史保持逐字节相同，只有最后一条用户消息随 hookId 变化。 */
export function makeMessages(input: EnvelopeInput): unknown[] {
  const shared = [
    { role: 'system', content: [{ type: 'text', text: 'synthetic system' }] },
    { role: 'user', content: [{ type: 'text', text: 'synthetic shared history' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'synthetic answer' }] },
  ];
  const unique = {
    role: 'user',
    content: [{ type: 'text', text: sizedText(Math.max(1, input.requestBytes), `unique-${input.hookId}`) }],
  };
  return [...shared, unique];
}

export function makeReply(input: EnvelopeInput): unknown {
  return {
    id: `msg_${input.hookId}`,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: sizedText(Math.max(1, input.replyBytes), `reply-${input.hookId}`) }],
  };
}

export function makeHookEnvelope(input: EnvelopeInput): HookEnvelope {
  const request = { model: input.model, messages: makeMessages(input), max_tokens: 128 };
  const reply = makeReply(input);
  const requestBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
  const replyBytes = Buffer.byteLength(JSON.stringify(reply), 'utf8');
  return {
    hook_id: input.hookId,
    observed_start_ms: input.startedMs,
    observed_finish_ms: input.startedMs + 10,
    protocol: 'anthropic',
    path: '/v1/messages',
    agent: 'claude',
    session: input.session,
    cwd: null,
    model: input.model,
    stream: true,
    origin: 'local',
    success: true,
    request,
    reply,
    request_bytes: requestBytes,
    reply_bytes: replyBytes,
    body_omitted: input.bodyOmitted,
    omit_reason: input.omitReason,
    magpie_version: '0.1.1296',
  };
}

export function makeLedgerLine(input: {
  routeId: number; session: string; responseId: string; startedMs: number;
}): string {
  return JSON.stringify({
    t: new Date(input.startedMs).toISOString(),
    route_id: input.routeId,
    response_id: input.responseId,
    session: input.session,
    subagent: input.session,
    agent: 'claude',
    provider: 'anthropic',
    model: 'synthetic-model',
    requested: 'synthetic-model',
    served: 'synthetic-model',
    status: 200,
    in: 100,
    out: 10,
    cache_read: 0,
    cache_write: 0,
    ms: 10,
    via: 'through',
    magpie_version: '0.1.1296',
  }) + '\n';
}

export function makeRouteLine(input: {
  routeId: number; session: string; startedMs: number;
}): string {
  return JSON.stringify({
    id: input.routeId,
    time: new Date(input.startedMs).toISOString(),
    agent: 'claude',
    session: input.session,
    model: 'synthetic-model',
    provider: 'anthropic',
    served: 'synthetic-model',
    status: 200,
    done: true,
    ms: 10,
    prompt: { tokens: 100, counted: true, window: 200_000, turns: 1, parts: [] },
  }) + '\n';
}

/** 只由临时根构造；生产配置的默认路径不会出现在这里。 */
export function buildCapacityConfig(input: {
  root: string; upstreamPort: number; bodyBudget: number; diskLimit: number;
  intervals?: Config['intervals'];
}): Config {
  return {
    dataDir: join(input.root, 'data'),
    port: 0,
    ledgerPath: join(input.root, 'sources', 'usage.jsonl'),
    routingDir: join(input.root, 'sources', 'routing'),
    magpieUrl: `http://127.0.0.1:${input.upstreamPort}`,
    bodyBudget: input.bodyBudget,
    diskLimit: input.diskLimit,
    gatewayTimeoutMs: 2000,
    intervals: input.intervals,
  };
}

/** 假上游只回答版本探针与空用量页；不做转发，也不访问网络。 */
export function createFakeUpstream(): {
  port: number;
  stop(): void;
  requests: { path: string; status: number }[];
} {
  const requests: { path: string; status: number }[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push({ path: url.pathname + url.search, status: 200 });
      if (url.pathname === '/v1') {
        return Response.json({ version: '0.1.1296' });
      }
      if (url.pathname === '/v1/magpie/usage/requests') {
        return Response.json({
          offset: Number(url.searchParams.get('offset') ?? '0'),
          rows: [],
          pricing_version: 'synthetic',
        });
      }
      return new Response('not_found', { status: 404 });
    },
  });
  return {
    port: server.port ?? 0,
    stop() { void server.stop(true); },
    requests,
  };
}

/** 等子进程打印监听端口；超时或提前退出都显式失败，不静默继续。 */
export function waitForCollector(child: ReturnType<typeof Bun.spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('collector_start_timeout')), 15_000);
    const stdout = child.stdout;
    if (stdout === null || stdout === undefined || typeof stdout === 'number') {
      clearTimeout(timer);
      reject(new Error('collector_stdout_missing'));
      return;
    }
    const reader = stdout.getReader();
    const pump = async (): Promise<void> => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value);
        const match = /collector_listening:(\d+)/.exec(buffer);
        if (match !== null) {
          clearTimeout(timer);
          resolve(Number(match[1]));
          return;
        }
      }
      clearTimeout(timer);
      reject(new Error('collector_exited_before_listen'));
    };
    void pump();
  });
}
