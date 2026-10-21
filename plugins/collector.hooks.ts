/**
 * magpie 薄 hook 插件。
 *
 * 只做三件事：请求期生成稳定 hook_id、完成期上报完整对象、按固定码记录投递结果。
 * 不改正文、不做关联、不做脱敏——这些都留给 collector。
 *
 * 入口文件必须是 `.hooks.ts`（magpie 按文件名识别），导出 onRequest / onResponse。
 * 投递预算：总 1500 ms，单次 fetch 600 ms，最多 2 次；第二次只针对网络错误、
 * 408、429、5xx，且要共享总截止与 ctx.signal。4xx 不重试。
 */

export type HookReportCode = 'ready' | 'empty' | 'unbound' | 'unauthorized' | 'unavailable' | 'invalid' | 'skipped';

export type HookContext = {
  origin: string;
  protocol: string;
  path: string;
  agent?: string;
  session?: string;
  cwd?: string;
  model?: string;
  stream?: boolean;
  request?: unknown;
  success?: boolean;
  state: Record<string, unknown>;
  options: { endpoint: string; token: string; gatewayTimeoutMs?: number };
  signal: AbortSignal;
  report(code: HookReportCode, count?: number): void;
};

const TOTAL_BUDGET_MS = 1500;
const ATTEMPT_TIMEOUT_MS = 600;
const RETRY_DELAY_MS = 50;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
export const MAX_OBJECT_BYTES = 32 * 1024 * 1024;
export const MAX_ENVELOPE_BYTES = 64 * 1024 * 1024;

type Envelope = {
  hook_id: string;
  observed_start_ms: number;
  observed_finish_ms: number;
  protocol: string;
  path: string;
  agent: string | null;
  session: string | null;
  cwd: string | null;
  model: string | null;
  stream: boolean;
  origin: string;
  success: boolean;
  request: unknown;
  reply: unknown;
  request_bytes: number;
  reply_bytes: number;
  body_omitted: boolean;
  omit_reason: string | null;
};

function byteLength(value: unknown): number {
  if (value === null || value === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** 请求期只登记身份与观察时间，不动正文。 */
export function onRequest(_body: unknown, ctx: HookContext): void {
  ctx.state.hook_id = crypto.randomUUID();
  ctx.state.observed_start_ms = Date.now();
}

function buildEnvelope(request: unknown, reply: unknown, ctx: HookContext): Envelope {
  const requestBytes = byteLength(request);
  const replyBytes = byteLength(reply);
  // 超限时发 metadata envelope：不截断 JSON，只置空正文并写明原因。
  const reason = requestBytes > MAX_OBJECT_BYTES || replyBytes > MAX_OBJECT_BYTES
    ? 'collector_object_limit'
    : requestBytes + replyBytes > MAX_ENVELOPE_BYTES ? 'collector_envelope_limit' : null;
  return {
    hook_id: String(ctx.state.hook_id ?? ''),
    observed_start_ms: Number(ctx.state.observed_start_ms ?? Date.now()),
    observed_finish_ms: Date.now(),
    protocol: ctx.protocol,
    path: ctx.path,
    agent: ctx.agent ?? null,
    session: ctx.session ?? null,
    cwd: ctx.cwd ?? null,
    model: ctx.model ?? null,
    stream: ctx.stream === true,
    origin: ctx.origin,
    success: ctx.success !== false,
    request: reason === null ? request : null,
    reply: reason === null ? reply : null,
    request_bytes: requestBytes,
    reply_bytes: replyBytes,
    body_omitted: reason !== null,
    omit_reason: reason,
  };
}

async function postOnce(endpoint: string, token: string, payload: string, timeoutMs: number, signal: AbortSignal): Promise<Response | 'network_error'> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: payload,
      signal: controller.signal,
    });
  } catch {
    return 'network_error';
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 完成期投递。投递结果只用于本地固定码诊断，不写正文、令牌或 URL 参数。
 * 注意：magpie 宿主在请求阶段结束后会取消 report 依赖的 signal，
 * 所以这里不依赖 ctx.report 报告投递结果。
 */
export async function onResponse(reply: unknown, ctx: HookContext): Promise<void> {
  const envelope = buildEnvelope(ctx.request ?? null, reply, ctx);
  const payload = JSON.stringify(envelope);
  const deadline = Date.now() + TOTAL_BUDGET_MS;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      ctx.state.collector_code = 'collector_deadline';
      return;
    }
    const result = await postOnce(
      ctx.options.endpoint, ctx.options.token, payload,
      Math.min(ATTEMPT_TIMEOUT_MS, remaining), ctx.signal,
    );
    if (result === 'network_error') {
      ctx.state.collector_code = 'collector_network_error';
      if (attempt === 1) {
        const pause = Math.min(RETRY_DELAY_MS, Math.max(0, deadline - Date.now()));
        if (pause > 0) await new Promise(resolve => setTimeout(resolve, pause));
      }
      continue;
    }
    if (result.ok) return;
    ctx.state.collector_code = 'collector_http_rejected';
    ctx.state.collector_status = result.status;
    // 4xx 不重试；5xx、408、429 才值得再试一次。
    if (!RETRYABLE_STATUS.has(result.status)) return;
    if (attempt === 1) {
      const pause = Math.min(RETRY_DELAY_MS, Math.max(0, deadline - Date.now()));
      if (pause > 0) await new Promise(resolve => setTimeout(resolve, pause));
    }
  }
}
