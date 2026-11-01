import { expect, test } from 'bun:test';
import { createReaderStore } from '../web/reader-store.js';
import { resolveSelectedSource } from '../web/rail-facts.js';
import { projectSteps, renderTraceRows } from '../web/trace-view.js';
import { createFixtureReadTransport, readError } from './helpers/read-transport';

const TOKEN = 'r1-' + 'a'.repeat(64);
const TOKEN2 = 'r1-' + 'b'.repeat(64);

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function bodyPage(from: number, to: number, total: number | null, extra: Record<string, unknown> = {}) {
  const messages = [];
  for (let ord = from; ord < Math.min(to, total ?? to); ord += 1) {
    messages.push({ ord, value: { role: 'user', content: `m${ord}` } });
  }
  return {
    state: 'available', protocol: 'anthropic', message_location: { key: 'messages', form: 'array' }, parse_state: 'parsed', reply_state: 'parsed',
    from, to, total, messages,
    request_fields: from === 0 ? { model: 'synth' } : null,
    reply: from === 0 ? { content: [{ type: 'text', text: 'reply' }] } : null,
    reason: null,
    interpretations: messages.map(m => ({ ord: m.ord, role: 'user', role_state: 'known', input: null, is_input: false })),
    coverage: { from, to, total, complete: true, loaded_complete: false, reason: 'available' },
    capabilities: { tools: { state: 'empty', items: [], reason: null }, skills: { state: 'present', items: [], reason: null }, coverage: { complete: true, reason: 'available', from, to, total }, agent: null },
    ...extra,
  } as unknown as import('../src/reading').ReadingBody;
}

function toolReading(id: number, ord: number, extra: Record<string, unknown> = {}) {
  return {
    owner_req: id, call_ord: ord, reading_token: TOKEN, state: 'available',
    target: null, content: 'ok', is_error: null, reason: null, raw: null,
    ...extra,
  } as unknown as import('../src/reading').ToolResultReading;
}

function detail(id: number, extra: Record<string, unknown> = {}) {
  return {
    req_id: id, conv_key: 'k', actor: 'a', agent: null, actor_state: 'known', started_ms: id,
    title: `t${id}`, title_source: null, status: 200, model_requested: null, model_served: 'm',
    in_tok: 1, out_tok: 1, cache_read: null, cache_write: null, cost: null, cost_state: 'absent', have: 7,
    ms: 1, ttft_ms: 1, flow_ms: 1, body_state: 'available', miss_reason: null,
    input_preview: null, input_preview_kind: null, reply_preview: null,
    req_kind: 'chat', chain_role: 'main', model_title: null,
    purpose_status: 'selected', purpose_version: 1, purpose_rule: null, purpose_chain: 'participate',
    derived_state: 'current', reading_token: TOKEN,
    prev_req_id: null, prev_relation: 'first', delta_ordinals: null,
    parse_state: 'parsed', reply_state: 'parsed',
    first_text_ms: null, reasoning: null, prompt_tokens: null, prompt_counted: null,
    prompt_window: null, prompt_turns: null, parts: null,
    attempt_count: null, attempt_billed: null, attempt_in: null, attempt_out: null,
    attempt_cache_read: null, attempt_cache_write: null, attempt_reasoning: null,
    attempt_cost: null, attempt_cost_state: 'absent',
    summary_state: 'recomputed', summary_algorithm: 1, summary_basis: null,
    derive_version: 1, archive: null, route_state: 'absent', model_provider: null,
    source_facts: {}, projection_meta: {}, prompt: {},
    derivation: { state: 'clean', chain_state: 'current', summary_state: 'current', reason: null },
    tool_calls: [], historical: null,
    ...extra,
  } as unknown as import('../src/reading').ReadingDetail;
}

test('loadLater 翻倍越过服务端 200 上限后 clamp，窗口继续增长', async () => {
  const fx = createFixtureReadTransport();
  fx.respond('requests', input => {
    if (input.cursor === null) {
      return { items: Array.from({ length: input.limit }, (_, i) => ({ req_id: i, started_ms: i })), next_cursor: 'c1' };
    }
    return { items: [{ req_id: 500, started_ms: 500 }], next_cursor: null };
  });
  const store = createReaderStore(fx.transport);
  // 初始窗口 240 行（仅用于把窗口撑过翻倍阈值；生产 windowLimit ≤ 100）。
  await store.selectSession('k', 240);
  await store.loadLater();
  const later = fx.calls.find(call =>
    call.operation === 'requests' && (call.input as { cursor: string | null }).cursor !== null);
  expect((later?.input as { limit: number }).limit).toBe(200);
  const rows = store.getWindow().requests;
  expect(rows).toHaveLength(241);
  // append 在尾部：已有行序号不动，新页接在后面。
  expect(rows[0]?.req_id).toBe(0);
  expect(rows[240]?.req_id).toBe(500);
  expect(store.getWindow().newerCursor).toBeNull();
});

test('窗口锚点：默认头锚点取最早一页，latest 取最新一页', async () => {
  const fx = createFixtureReadTransport();
  fx.respond('requests', input => {
    if (input.cursor === null && input.direction === 'forward') {
      return { items: [{ req_id: 1, started_ms: 1 }], next_cursor: 'f1' };
    }
    if (input.cursor === null && input.direction === 'older') {
      return { items: [{ req_id: 9, started_ms: 9 }], next_cursor: null };
    }
    throw readError('not_found');
  });
  const store = createReaderStore(fx.transport);
  // 默认头锚点：direction=forward 无游标，游标是后续记录的入口。
  await store.selectSession('k', 30);
  expect(store.getWindow().requests.map(r => r.req_id)).toEqual([1]);
  expect(store.getWindow().newerCursor).toBe('f1');
  expect(fx.calls.some(call =>
    call.operation === 'requests' && (call.input as { direction: string }).direction === 'forward')).toBe(true);
  // latest 锚点：direction=older 无游标，取最新一页，游标即耗尽。
  await store.selectSession('k', 30, 'latest');
  expect(store.getWindow().requests.map(r => r.req_id)).toEqual([9]);
  expect(store.getWindow().newerCursor).toBeNull();
  expect(fx.calls.some(call =>
    call.operation === 'requests' && (call.input as { direction: string }).direction === 'older')).toBe(true);
});

test('窗口选择、元信息读取与读取去重的调用序列', async () => {
  const fx = createFixtureReadTransport();
  fx.respond('requests', () => ({ items: [1, 2, 3].map(id => ({ req_id: id, started_ms: id })), next_cursor: 'c1' }));
  fx.respond('detail', input => detail(input.id));
  fx.respond('body', input => bodyPage(input.from, input.to, 45));
  const store = createReaderStore(fx.transport);
  await store.selectSession('k', 30);
  const window = store.getWindow();
  expect(window.requests.map(r => r.req_id)).toEqual([1, 2, 3]);
  expect(window.newerCursor).toBe('c1');
  // 详情 + 元信息各一次。
  const read = await store.readRequest(1);
  expect(read.detail?.req_id).toBe(1);
  expect(read.meta?.reply).not.toBeNull();
  expect(fx.count('detail', i => i.id === 1)).toBe(1);
  expect(fx.count('body', i => i.from === 0 && i.to === 0)).toBe(1);
  // 相同 (id,token,from,to) 并发只发一次；token 随输入下发，精确区分区间与版本。
  await Promise.all([store.readRange(1, 44, 45), store.readRange(1, 44, 45)]);
  expect(fx.count('body', i => i.from === 44 && i.to === 45)).toBe(1);
  const rangeCall = fx.calls.find(call =>
    call.operation === 'body' && (call.input as { from: number }).from === 44);
  expect((rangeCall?.input as { token: string }).token).toBe(TOKEN);
  // 结构首读尾片 [5,45)，再向前读 [0,5)；定点读 44 不推进已读窗口。
  const tail = await store.loadStructure(1);
  expect(tail.structure.back).toBe(5);
  expect(tail.structure.next).toBe(45);
  const after = await store.loadStructure(1);
  expect(after.structure.back).toBe(0);
  expect(after.structure.ords).toEqual(Array.from({ length: 45 }, (_, i) => i));
  expect(after.structure.next).toBe(45);
  expect(fx.count('body', i => i.from === 5 && i.to === 45)).toBe(1);
  expect(fx.count('body', i => i.from === 0 && i.to === 5)).toBe(1);
});

test('读取失败与空页时旧窗口、游标与已读内容保留', async () => {
  let laterFails = true;
  const fx = createFixtureReadTransport();
  fx.respond('requests', input => {
    if (input.cursor === null) return { items: [{ req_id: 1, started_ms: 1 }], next_cursor: 'c1' };
    if (laterFails) throw readError('unavailable');
    return { items: [{ req_id: 2, started_ms: 2 }], next_cursor: null };
  });
  fx.respond('detail', () => detail(1));
  fx.respond('body', input => bodyPage(input.from, input.to, 5));
  const store = createReaderStore(fx.transport);
  await store.selectSession('k', 30);
  await store.readRequest(1);
  await store.loadLater();
  const failed = store.getWindow();
  expect(failed.requests.map(r => r.req_id)).toEqual([1]);
  expect(failed.newerCursor).toBe('c1');
  expect(failed.error).toBe('unavailable');
  // 恢复后重试成功，append 接在尾部。
  laterFails = false;
  await store.loadLater();
  expect(store.getWindow().requests.map(r => r.req_id)).toEqual([1, 2]);
  expect(store.getWindow().error).toBeNull();
});

test('409 整笔作废后普通读取走网络重建，并重取回复元信息', async () => {
  let bodyConflicts = false;
  let detailToken = TOKEN;
  const fx = createFixtureReadTransport();
  fx.respond('requests', () => ({ items: [{ req_id: 1, started_ms: 1 }], next_cursor: null }));
  fx.respond('detail', () => detail(1, { reading_token: detailToken }));
  fx.respond('body', input => {
    if (input.from === 1 && input.to === 2) {
      if (bodyConflicts) throw readError('reading_changed');
      return bodyPage(1, 2, 3);
    }
    return bodyPage(0, 0, 3);
  });
  const store = createReaderStore(fx.transport);
  await store.selectSession('k', 30);
  await store.readRequest(1);
  bodyConflicts = true;
  await expect(store.readRange(1, 1, 2)).rejects.toThrow('reading_changed');
  // 整笔已作废：普通读取（不带 validate）也要重新走详情，并重取 0/0 元信息。
  bodyConflicts = false;
  detailToken = TOKEN2;
  const rebuilt = await store.readRequest(1);
  expect(rebuilt.token).toBe(TOKEN2);
  expect(fx.count('detail', i => i.id === 1)).toBe(2);
  expect(fx.count('body', i => i.from === 0 && i.to === 0)).toBe(2);
});

test('token变化重新读取回复元信息', async () => {
  let token = TOKEN;
  const fx = createFixtureReadTransport();
  fx.respond('detail', () => detail(1, { reading_token: token }));
  fx.respond('body', () => bodyPage(0, 0, 0, {
    request_fields: { system: token === TOKEN ? 'old-system' : 'new-system' },
    reply: { content: [{ type: 'text', text: token === TOKEN ? 'old' : 'new' }] },
  }));
  const store = createReaderStore(fx.transport);
  await store.readRequest(1);
  token = TOKEN2;
  const next = await store.readRequest(1, true);
  expect(next.meta?.request_fields).toEqual({ system: 'new-system' });
  expect(next.meta?.reply).toEqual({ content: [{ type: 'text', text: 'new' }] });
  expect(fx.count('body', i => i.from === 0 && i.to === 0)).toBe(2);
});

test('旧请求的迟到409不能清除已重建的新缓存', async () => {
  let token = TOKEN;
  let rangeCalls = 0;
  let release409: (() => void) | null = null;
  const gated409 = new Promise<void>(resolve => { release409 = resolve; });
  const fx = createFixtureReadTransport();
  fx.respond('requests', () => ({ items: [{ req_id: 1, started_ms: 1 }], next_cursor: null }));
  fx.respond('detail', () => detail(1, { reading_token: token }));
  fx.respond('body', input => {
    if (input.from === 1 && input.to === 2) {
      rangeCalls += 1;
      return rangeCalls === 1 ? gated409.then(() => { throw readError('reading_changed'); }) : bodyPage(1, 2, 3);
    }
    return bodyPage(0, 0, 3, { request_fields: { system: token === TOKEN ? 'old' : 'new' } });
  });
  const store = createReaderStore(fx.transport);
  await store.selectSession('k', 30);
  await store.readRequest(1);
  const stale = store.readRange(1, 1, 2);
  await delay(5);
  // 旧请求还挂着时版本重建：新缓存来自 validate 读取。
  token = TOKEN2;
  await store.readRequest(1, true);
  release409!();
  await expect(stale).rejects.toThrow('reading_changed');
  // 旧 409 已迟到：新缓存原样保留，普通读取不再走网络。
  const kept = await store.readRequest(1);
  expect(kept.meta?.request_fields).toEqual({ system: 'new' });
  expect(fx.count('detail', i => i.id === 1)).toBe(2);
});

test('invalidate 后迟到的详情响应不作为可用快照返回', async () => {
  let detailCalls = 0;
  let release: (() => void) | null = null;
  const gated = new Promise<void>(resolve => { release = resolve; });
  const fx = createFixtureReadTransport();
  fx.respond('detail', () => {
    detailCalls += 1;
    return detailCalls === 1 ? gated.then(() => detail(1)) : detail(1);
  });
  fx.respond('body', () => bodyPage(0, 0, 1));
  const store = createReaderStore(fx.transport);
  const pending = store.readRequest(1);
  await delay(5);
  store.invalidate(1);
  release!();
  await expect(pending).rejects.toThrow('reading_changed');
  // 之后普通读取重新走网络并成功。
  const next = await store.readRequest(1);
  expect(next.detail?.req_id).toBe(1);
  expect(fx.count('detail', i => i.id === 1)).toBe(2);
});

test('validate 等待在跑的详情读取完成后再拉一次', async () => {
  let detailCalls = 0;
  let release: (() => void) | null = null;
  const gated = new Promise<void>(resolve => { release = resolve; });
  let token = TOKEN;
  const fx = createFixtureReadTransport();
  fx.respond('detail', () => {
    detailCalls += 1;
    if (detailCalls === 1) return gated.then(() => detail(1));
    return detail(1, { reading_token: token });
  });
  fx.respond('body', () => bodyPage(0, 0, 1));
  const store = createReaderStore(fx.transport);
  const first = store.readRequest(1);
  await delay(5);
  const second = store.readRequest(1, true);
  await delay(5);
  release!();
  // 第二次详情请求在旧读取结束后立刻发出：换版本要在释放前生效。
  token = TOKEN2;
  // 旧 plain 读取的元信息响应晚于版本切换：回写校验拒绝，不把旧片写进新版本。
  await expect(first).rejects.toThrow('reading_changed');
  const validated = await second;
  expect(validated.token).toBe(TOKEN2);
  expect(fx.count('detail', i => i.id === 1)).toBe(2);
});

test('迟到详情不更新新窗口，旧 token 的迟到结果不写入', async () => {
  let releaseDetail!: (value: unknown) => void;
  const gatedDetail = new Promise<unknown>(resolve => { releaseDetail = resolve; });
  const fx = createFixtureReadTransport();
  fx.respond('requests', input => ({
    items: [input.key === 'old' ? { req_id: 1, started_ms: 1 } : { req_id: 7, started_ms: 7 }],
    next_cursor: null,
  }));
  fx.respond('detail', input => (input.id === 1 ? gatedDetail : detail(7)));
  fx.respond('body', () => bodyPage(0, 0, 1));
  const store = createReaderStore(fx.transport);
  const pending = store.selectSession('old', 30);
  await delay(10);
  await store.selectSession('new', 30);
  releaseDetail(detail(1));
  await pending;
  // 旧会话迟到响应不能改写新窗口。
  expect(store.getWindow().requests.map(r => r.req_id)).toEqual([7]);
  expect(store.getWindow().sessionKey).toBe('new');
});

test('工具结果按 owner 与调用序号分别缓存，失败保留到重试成功', async () => {
  let ord1Fails = true;
  const fx = createFixtureReadTransport();
  fx.respond('requests', () => ({ items: [{ req_id: 1, started_ms: 1 }], next_cursor: null }));
  fx.respond('detail', () => detail(1, { tool_calls: [
    { call_id: 'a', ord: 0, tool_name: 'read', result_req: 2, result_ord: 1, result_path: 'request.messages[1].content[0]', state: 'resolved' },
    { call_id: 'b', ord: 1, tool_name: 'read', result_req: 2, result_ord: 1, result_path: 'request.messages[1].content[1]', state: 'resolved' },
  ] }));
  fx.respond('body', () => bodyPage(0, 0, 1));
  fx.respond('toolResult', input => {
    if (input.ord === 1 && ord1Fails) throw readError('unavailable');
    return toolReading(1, input.ord, {
      target: { req_id: 2, ord: 1, path: `p${input.ord}` },
      content: input.ord === 0 ? 'first' : 'second',
      is_error: input.ord === 1 ? true : null,
      reading_token: TOKEN,
    });
  });
  const store = createReaderStore(fx.transport);
  await store.selectSession('k', 30);
  await store.readRequest(1);
  // resolved 不等于已读：未发起读取前没有结果网络请求。
  expect(fx.count('toolResult')).toBe(0);
  const first = await store.readToolResult(1, 0);
  expect(first.content).toBe('first');
  // 再次读取同一调用命中缓存。
  await store.readToolResult(1, 0);
  expect(fx.count('toolResult', i => i.ord === 0)).toBe(1);
  // 失败保留，重试成功后替换。
  await expect(store.readToolResult(1, 1)).rejects.toThrow();
  expect(fx.count('toolResult', i => i.ord === 1)).toBe(1);
  ord1Fails = false;
  const retried = await store.readToolResult(1, 1);
  expect(retried.content).toBe('second');
  expect(retried.is_error).toBe(true);
  expect(fx.count('toolResult', i => i.ord === 1)).toBe(2);
});

test('工具结果 409 后整笔作废，重建读取换新 token 重取', async () => {
  let toolConflicts = false;
  let token = TOKEN;
  const fx = createFixtureReadTransport();
  fx.respond('requests', () => ({ items: [{ req_id: 1, started_ms: 1 }], next_cursor: null }));
  fx.respond('detail', () => detail(1, { reading_token: token }));
  fx.respond('body', () => bodyPage(0, 0, 1));
  fx.respond('toolResult', input => {
    if (toolConflicts) throw readError('reading_changed');
    return toolReading(1, input.ord, { target: { req_id: 2, ord: 1, path: 'p' }, content: 'ok', reading_token: token });
  });
  const store = createReaderStore(fx.transport);
  await store.selectSession('k', 30);
  await store.readRequest(1);
  toolConflicts = true;
  await expect(store.readToolResult(1, 0)).rejects.toThrow('reading_changed');
  // 409 已整笔作废：普通读取重建详情并换新 token，再读工具结果走网络。
  toolConflicts = false;
  token = TOKEN2;
  await store.readRequest(1);
  const again = await store.readToolResult(1, 0);
  expect(again.content).toBe('ok');
  expect(fx.count('toolResult', i => i.ord === 0)).toBe(2);
  const secondCall = fx.calls.filter(call => call.operation === 'toolResult')[1];
  expect((secondCall.input as { token: string }).token).toBe(TOKEN2);
});

test('迟到的工具结果不写入已换版本的请求', async () => {
  let toolCalls = 0;
  let release: ((value: unknown) => void) | null = null;
  const gated = new Promise<unknown>(resolve => { release = resolve; });
  let token = TOKEN;
  const fx = createFixtureReadTransport();
  fx.respond('requests', () => ({ items: [{ req_id: 1, started_ms: 1 }], next_cursor: null }));
  fx.respond('detail', () => detail(1, { reading_token: token }));
  fx.respond('body', () => bodyPage(0, 0, 1));
  fx.respond('toolResult', () => {
    toolCalls += 1;
    return toolCalls === 1
      ? gated
      : toolReading(1, 0, { content: 'fresh', reading_token: token });
  });
  const store = createReaderStore(fx.transport);
  await store.selectSession('k', 30);
  await store.readRequest(1);
  const stale = store.readToolResult(1, 0);
  await delay(5);
  // 请求换版本后再次读取：新 cache 键，立即发第二个请求。
  token = TOKEN2;
  await store.readRequest(1, true);
  const fresh = store.readToolResult(1, 0);
  await delay(5);
  release!({ owner_req: 1, call_ord: 0, state: 'available', target: null, content: 'stale', is_error: null, reason: null, reading_token: TOKEN });
  await expect(stale).rejects.toThrow('reading_changed');
  const ok = await fresh;
  expect(ok.content).toBe('fresh');
  expect(toolCalls).toBe(2);
});

test('81 条可信增量分两片后可显式续读剩余', async () => {
  const fx = createFixtureReadTransport();
  fx.respond('requests', () => ({ items: [{ req_id: 1, started_ms: 1 }], next_cursor: null }));
  fx.respond('detail', () => detail(1, { delta_ordinals: Array.from({ length: 81 }, (_, i) => i) }));
  fx.respond('body', input => bodyPage(input.from, input.to, 81));
  const store = createReaderStore(fx.transport);
  await store.selectSession('k', 30);
  await store.readRequest(1);
  // 首轮两片：0–39、40–79；done 仍为 false，剩余 1 条。
  const first = await store.loadDelta(1, 2);
  expect(first.delta.next).toBe(80);
  expect(first.delta.done).toBe(false);
  // 显式续读第 81 条后完成。
  const second = await store.loadDelta(1, 2);
  expect(second.delta.next).toBe(81);
  expect(second.delta.done).toBe(true);
  expect(fx.count('body', i => i.from === 80 && i.to === 81)).toBe(1);
  expect(fx.count('body', i => i.from === 0 && i.to === 40)).toBe(1);
});

test('增量片缺口：空页成功响应不推进消费位置，重试重新走网络', async () => {
  let emptyPieces = true;
  const fx = createFixtureReadTransport();
  fx.respond('requests', () => ({ items: [{ req_id: 1, started_ms: 1 }], next_cursor: null }));
  fx.respond('detail', () => detail(1, { delta_ordinals: [0, 1] }));
  fx.respond('body', input => {
    if (emptyPieces) return { ...bodyPage(input.from, input.to, 2), messages: [] };
    return bodyPage(input.from, input.to, 2);
  });
  const store = createReaderStore(fx.transport);
  await store.selectSession('k', 30);
  await store.readRequest(1);
  // 成功页但消息为空：固定原因、done 保持 false、next 不动。
  const failed = await store.loadDelta(1, 2);
  expect(failed.delta.error).toBe('delta_gap');
  expect(failed.delta.done).toBe(false);
  expect(failed.delta.next).toBe(0);
  const failedCount = fx.count('body', i => i.from === 0 && i.to === 2);
  // 重试成功：缺口页不留在缓存，两条均可见并完成。
  emptyPieces = false;
  const ok = await store.loadDelta(1, 2);
  expect(ok.delta.done).toBe(true);
  expect(ok.delta.next).toBe(2);
  expect(fx.count('body', i => i.from === 0 && i.to === 2)).toBe(failedCount + 1);
});

test('delta 分片消费与未确认关系不读消息', async () => {
  const fx = createFixtureReadTransport();
  fx.respond('requests', input => ({
    items: [{ req_id: input.key === 'k' ? 1 : input.key === 'k2' ? 2 : 3, started_ms: 1 }],
    next_cursor: null,
  }));
  fx.respond('detail', input => {
    if (input.id === 1) return detail(1, { delta_ordinals: [0, 1, 2, 80, 81] });
    if (input.id === 2) return detail(2, { delta_ordinals: [] });
    return detail(3, { delta_ordinals: null, prev_relation: 'unknown' });
  });
  fx.respond('body', input => {
    if (input.from === 0 && input.to === 0) {
      return bodyPage(0, 0, input.id === 1 ? 82 : 3);
    }
    if (input.from === 0 && input.to === 3) return bodyPage(0, 3, 82);
    if (input.from === 80 && input.to === 82) return bodyPage(80, 82, 82);
    throw readError('not_found');
  });
  const store = createReaderStore(fx.transport);
  await store.selectSession('k', 30);
  await store.readRequest(1);
  const read = await store.loadDelta(1, 2);
  expect(read.delta.next).toBe(5);
  expect(read.delta.done).toBe(true);
  expect(fx.count('body', i => i.from === 0 && i.to === 3)).toBe(1);
  expect(fx.count('body', i => i.from === 80 && i.to === 82)).toBe(1);
  // delta = []：立即完成，不读消息。
  await store.selectSession('k2', 30);
  await store.readRequest(2);
  const read2 = await store.loadDelta(2);
  expect(read2.delta.done).toBe(true);
  expect(read2.delta.unconfirmed).toBeFalsy();
  expect(fx.count('body', i => i.id === 2)).toBe(1);
  // delta = null：未确认，不读消息。
  await store.selectSession('k3', 30);
  await store.readRequest(3);
  const read3 = await store.loadDelta(3);
  expect(read3.delta.unconfirmed).toBe(true);
  expect(read3.delta.done).toBe(true);
  expect(fx.count('body', i => i.id === 3 && !(i.from === 0 && i.to === 0))).toBe(0);
});

test('并发增量消费合并为一条任务：不各自推进消费位置', async () => {
  let release: (() => void) | null = null;
  const gated = new Promise<void>(resolve => { release = resolve; });
  const fx = createFixtureReadTransport();
  fx.respond('requests', () => ({ items: [{ req_id: 1, started_ms: 1 }], next_cursor: null }));
  fx.respond('detail', () => detail(1, { delta_ordinals: [0, 1, 2, 3] }));
  fx.respond('body', input => {
    if (input.from === 0 && input.to === 0) return bodyPage(0, 0, 4);
    if (input.from === 0 && input.to === 4) return gated.then(() => bodyPage(0, 4, 4));
    throw readError('not_found');
  });
  const store = createReaderStore(fx.transport);
  await store.selectSession('k', 30);
  await store.readRequest(1);
  // 第一片在飞时第二个消费者进来：共享同一任务，不再发第二条增量请求。
  const first = store.loadDelta(1, 2);
  const second = store.loadDelta(1, 2);
  await delay(5);
  expect(fx.count('body', i => i.from === 0 && i.to === 4)).toBe(1);
  release!();
  const [a, b] = await Promise.all([first, second]);
  expect(a.delta.next).toBe(4);
  expect(a.delta.done).toBe(true);
  expect(b.delta.next).toBe(4);
  expect(fx.count('body', i => i.from === 0 && i.to === 4)).toBe(1);
  // 任务结束后释放：下一次调用仍从已推进的位置消费，可直接完成。
  const third = await store.loadDelta(1, 2);
  expect(third.delta.done).toBe(true);
  expect(fx.count('body', i => i.from === 0 && i.to === 4)).toBe(1);
});

test('切换会话后同 id 的增量不等待旧任务', async () => {
  let release: (() => void) | null = null;
  const gated = new Promise<void>(resolve => { release = resolve; });
  let started: () => void = () => {};
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  let session = 'old';
  const fx = createFixtureReadTransport();
  fx.respond('requests', () => ({ items: [{ req_id: 1, started_ms: 1 }], next_cursor: null }));
  fx.respond('detail', () => detail(1, { conv_key: session, delta_ordinals: [0], reading_token: session === 'old' ? TOKEN : TOKEN2 }));
  fx.respond('body', input => {
    if (input.from === 0 && input.to === 0) return bodyPage(0, 0, 1);
    if (input.from === 0 && input.to === 1) {
      if (session === 'old') { started(); return gated.then(() => bodyPage(0, 1, 1)); }
      return bodyPage(0, 1, 1, { messages: [{ ord: 0, value: { role: 'user', content: 'fresh' } }] });
    }
    throw readError('not_found');
  });
  const store = createReaderStore(fx.transport);
  await store.selectSession(session, 30);
  await store.readRequest(1);
  const old = store.loadDelta(1);
  const oldResult = old.catch(error => error);
  await firstStarted;
  session = 'new';
  await store.selectSession(session, 30);
  await store.readRequest(1);
  const fresh = store.loadDelta(1);
  const outcome = await Promise.race([fresh, delay(100).then(() => null)]);
  release!();
  expect(await oldResult).toBeInstanceOf(Error);
  expect(outcome?.entries[0]?.preview).toBe('fresh');
  expect(outcome?.delta.done).toBe(true);
});

test('验证换版本后增量不等待旧版本任务', async () => {
  let token = TOKEN;
  let release: (() => void) | null = null;
  const gated = new Promise<void>(resolve => { release = resolve; });
  let started: () => void = () => {};
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  const fx = createFixtureReadTransport();
  fx.respond('detail', () => detail(1, { delta_ordinals: [0], reading_token: token }));
  fx.respond('body', input => {
    if (input.from === 0 && input.to === 0) return bodyPage(0, 0, 1);
    if (input.from === 0 && input.to === 1) {
      if (input.token === TOKEN) { started(); return gated.then(() => bodyPage(0, 1, 1)); }
      return bodyPage(0, 1, 1, { messages: [{ ord: 0, value: { role: 'user', content: 'new version' } }] });
    }
    throw readError('not_found');
  });
  const store = createReaderStore(fx.transport);
  await store.readRequest(1);
  const oldResult = store.loadDelta(1).catch(error => error);
  await firstStarted;
  token = TOKEN2;
  await store.readRequest(1, true);
  const fresh = store.loadDelta(1);
  const outcome = await Promise.race([fresh, delay(100).then(() => null)]);
  release!();
  expect(await oldResult).toBeInstanceOf(Error);
  expect(outcome?.entries[0]?.preview).toBe('new version');
  expect(outcome?.delta.done).toBe(true);
});

test('孤立回调的请求正文可在轨迹中读取且不冒充新增', async () => {
  const request = detail(1, {
    conv_key: '["hook","synthetic"]', actor: null, actor_state: 'unknown', via: 'hook',
    status: null, have: 1, derived_state: 'dirty', prev_relation: null, delta_ordinals: null,
    reply_state: 'absent', source_facts: { hook: { successes: ['failure'] } },
    derivation: { state: 'dirty', chain_state: 'unavailable', summary_state: 'retained', reason: 'derive_dirty' },
  });
  const fx = createFixtureReadTransport();
  fx.respond('requests', () => ({ items: [request], next_cursor: null }));
  fx.respond('detail', () => request);
  fx.respond('body', input => {
    if (input.from === 0 && input.to === 0) return bodyPage(0, 0, 1, { protocol: 'chat', reply: null, reply_state: 'absent' });
    if (input.from === 0 && input.to === 1) return bodyPage(0, 1, 1, {
      protocol: 'chat', reply: null, reply_state: 'absent',
      messages: [{ ord: 0, value: { role: 'user', content: 'synthetic question' } }],
      interpretations: [{ ord: 0, role: 'user', role_state: 'known', input: { state: 'text', text: 'synthetic question', original: 'synthetic question' }, is_input: true }],
    });
    throw readError('not_found');
  });
  const store = createReaderStore(fx.transport);
  await store.selectSession(request.conv_key, 30);
  await store.readRequest(1);
  const read = await store.loadDelta(1, 2);
  expect(read.delta.unconfirmed).toBe(true);
  expect(read.entries.map(entry => entry.preview)).toEqual(['synthetic question']);
  const steps = projectSteps(request as never, read);
  // 归属、回复与账本三路缺口收在同一条组级状态行里。
  expect(steps.find(step => step.kind === 'flag')?.text).toBe('无回复 · 无账本 · 归属未确认');
  const user = steps.find(step => step.kind === 'user');
  expect(user?.text).toBe('synthetic question');
  expect(resolveSelectedSource(user ?? null)).toEqual({ side: 'request', target: 'message', path: 'request.messages[0]', messageOrd: 0 });
  expect(resolveSelectedSource(steps.find(step => step.kind === 'flag') ?? null)).toEqual({ side: 'evidence' });
  expect(steps.some(step => step.status === 'missing_reply')).toBe(true);
  expect(steps.some(step => step.text === '无回复')).toBe(false);
  expect(steps.some(step => step.text === 'HTTP 状态未知')).toBe(false);
  expect(steps.some(step => step.text.includes('回调报告失败'))).toBe(false);
  await store.loadDelta(1, 2);
  expect(fx.count('body', i => i.from === 0 && i.to === 1)).toBe(1);
});

test('孤立请求元信息读取失败后可重试正文', async () => {
  let failMeta = true;
  const request = detail(5, {
    actor: null, actor_state: 'unknown', derived_state: 'dirty', prev_relation: null, delta_ordinals: null,
    derivation: { state: 'dirty', chain_state: 'unavailable', summary_state: 'retained', reason: 'derive_dirty' },
  });
  const fx = createFixtureReadTransport();
  fx.respond('requests', () => ({ items: [request], next_cursor: null }));
  fx.respond('detail', () => request);
  fx.respond('body', input => {
    if (input.from === 0 && input.to === 0) {
      if (failMeta) throw readError('unavailable');
      return bodyPage(0, 0, 1);
    }
    if (input.from === 0 && input.to === 1) return bodyPage(0, 1, 1);
    throw readError('not_found');
  });
  const store = createReaderStore(fx.transport);
  await store.selectSession(request.conv_key, 30);
  await expect(store.readRequest(5)).rejects.toThrow('unavailable');
  const waiting = await store.loadDelta(5);
  expect(waiting.delta.done).toBe(false);
  const steps = projectSteps(request as never, waiting);
  expect(steps.find(step => step.key === '5:body-metadata')?.text).toContain('点击重试');
  expect(steps.some(step => step.text === '未收到回复')).toBe(false);
  failMeta = false;
  await store.readRequest(5);
  const retry = await store.loadDelta(5);
  expect(retry.entries.map(entry => entry.preview)).toEqual(['m0']);
  expect(fx.count('body', i => i.from === 0 && i.to === 0)).toBe(2);
});

test('孤立请求原文分页失败可重试，工具结果不伪造配对', async () => {
  let failTail = true;
  const request = detail(2, {
    actor: null, actor_state: 'unknown', via: 'hook', status: null, have: 1,
    derived_state: 'dirty', prev_relation: null, delta_ordinals: null,
    derivation: { state: 'dirty', chain_state: 'unavailable', summary_state: 'retained', reason: 'derive_dirty' },
    tool_results: [{ owner_req: 9, ord: 0, result_ord: 0, result_path: 'request.messages[0]', state: 'resolved', tool_name: 'Bash' }],
  });
  const fx = createFixtureReadTransport();
  fx.respond('requests', () => ({ items: [request], next_cursor: null }));
  fx.respond('detail', () => request);
  fx.respond('body', input => {
    if (input.from === 0 && input.to === 0) return bodyPage(0, 0, 41, { protocol: 'chat' });
    if (input.from === 1 && input.to === 41) {
      if (failTail) throw readError('unavailable');
      return bodyPage(1, 41, 41, { protocol: 'chat' });
    }
    if (input.from === 0 && input.to === 1) {
      const page = bodyPage(0, 1, 41, { protocol: 'chat' });
      page.messages[0]!.value = { role: 'tool', content: '<script>synthetic result</script>' };
      return page;
    }
    throw readError('not_found');
  });
  const store = createReaderStore(fx.transport);
  await store.selectSession('k', 30);
  await store.readRequest(2);
  const failed = await store.loadDelta(2);
  expect(failed.structure.back).toBe(0);
  expect(failed.structure.next).toBe(0);
  expect(failed.structure.error).toBe('unavailable');
  expect(projectSteps(request as never, failed).find(step => step.key === '2:unassigned-more')?.text).toContain('点击重试');
  failTail = false;
  const first = await store.loadStructure(2);
  expect(first.structure.back).toBe(1);
  expect(first.structure.next).toBe(41);
  const pending = projectSteps(request as never, first).find(step => step.key === '2:unassigned-more');
  expect(pending?.text).toContain('还有 1 条更早的请求消息未读取');
  const last = await store.loadStructure(2);
  expect(last.structure.back).toBe(0);
  expect(projectSteps(request as never, last).some(step => step.key === '2:unassigned-more')).toBe(false);
  const steps = projectSteps(request as never, last);
  const result = steps.find(step => step.kind === 'tool_result');
  expect(result?.pairOwner).toBeNull();
  expect(resolveSelectedSource(result ?? null)).toEqual({ side: 'request', target: 'message', path: 'request.messages[0]', messageOrd: 0 });
  const html = renderTraceRows(request as never, steps, 1, null);
  expect(html).not.toContain('<script>synthetic result</script>');
  expect(html).toContain('&lt;script&gt;synthetic result&lt;/script&gt;');
  expect(fx.count('body', i => i.from === 1 && i.to === 41)).toBe(2);
  expect(fx.count('body', i => i.from === 0 && i.to === 1)).toBe(1);
});

test('总数未知时先读第一页取 total，再读尾片', async () => {
  const request = detail(9);
  const fx = createFixtureReadTransport();
  fx.respond('requests', () => ({ items: [request], next_cursor: null }));
  fx.respond('detail', () => request);
  fx.respond('body', input => {
    if (input.from === 0 && input.to === 0) return bodyPage(0, 0, null);
    if (input.from === 0 && input.to === 40) return bodyPage(0, 40, 100);
    if (input.from === 60 && input.to === 100) return bodyPage(60, 100, 100);
    throw readError('not_found');
  });
  const store = createReaderStore(fx.transport);
  await store.selectSession('k', 30);
  await store.readRequest(9);
  const read = await store.loadStructure(9);
  // 第一页只为拿总数；已读窗口是尾片 [60,100)，两段之间的空洞由列表标出。
  expect(read.structure.total).toBe(100);
  expect(read.structure.back).toBe(60);
  expect(read.structure.next).toBe(100);
  expect(read.structure.ords).toEqual([...Array.from({ length: 40 }, (_, i) => i), ...Array.from({ length: 40 }, (_, i) => 60 + i)]);
  expect(read.entries.map(entry => entry.ord)).toEqual(read.structure.ords);
  expect(fx.count('body', i => i.from === 0 && i.to === 40)).toBe(1);
  expect(fx.count('body', i => i.from === 60 && i.to === 100)).toBe(1);
});

test('孤立请求结构页部分缺失时重试不丢弃已读消息', async () => {
  let missing = true;
  let pageReads = 0;
  const request = detail(6, {
    actor: null, actor_state: 'unknown', derived_state: 'dirty', prev_relation: null, delta_ordinals: null,
    derivation: { state: 'dirty', chain_state: 'unavailable' },
  });
  const fx = createFixtureReadTransport();
  fx.respond('requests', () => ({ items: [request], next_cursor: null }));
  fx.respond('detail', () => request);
  fx.respond('body', input => {
    if (input.from === 0 && input.to === 0) return bodyPage(0, 0, 2);
    if (input.from === 0 && input.to === 2) {
      pageReads += 1;
      const page = bodyPage(0, 2, 2);
      if (missing) page.messages = page.messages.filter(message => message.ord === 0);
      return page;
    }
    throw readError('not_found');
  });
  const store = createReaderStore(fx.transport);
  await store.selectSession(request.conv_key, 30);
  await store.readRequest(6);
  const partial = await store.loadDelta(6);
  expect(partial.structure.next).toBe(0);
  expect(partial.structure.error).toBe('body_page_gap');
  expect(partial.entries.map(entry => entry.ord)).toEqual([0]);
  const repeated = await store.loadStructure(6);
  expect(repeated.structure.error).toBe('body_page_gap');
  missing = false;
  const recovered = await store.loadStructure(6);
  expect(recovered.structure.back).toBe(0);
  expect(recovered.structure.next).toBe(2);
  expect(recovered.structure.error).toBeNull();
  expect(recovered.entries.map(entry => entry.ord)).toEqual([0, 1]);
  expect(pageReads).toBe(3);
});

test('孤立请求结构页缺少消息时保留位置并可重试', async () => {
  let missingPage = true;
  const request = detail(3, {
    actor: null, actor_state: 'unknown', derived_state: 'dirty', prev_relation: null, delta_ordinals: null,
    derivation: { state: 'dirty', chain_state: 'unavailable', summary_state: 'retained', reason: 'derive_dirty' },
  });
  const fx = createFixtureReadTransport();
  fx.respond('requests', () => ({ items: [request], next_cursor: null }));
  fx.respond('detail', () => request);
  fx.respond('body', input => {
    if (input.from === 0 && input.to === 0) return bodyPage(0, 0, 41);
    if (input.from === 1 && input.to === 41) {
      return bodyPage(1, 41, 41, missingPage ? { messages: [], interpretations: [] } : {});
    }
    if (input.from === 0 && input.to === 1) return bodyPage(0, 1, 41);
    throw readError('not_found');
  });
  const store = createReaderStore(fx.transport);
  await store.selectSession(request.conv_key, 30);
  await store.readRequest(3);
  await store.loadDelta(3);
  const failed = await store.loadStructure(3);
  expect(failed.structure.back).toBe(0);
  expect(failed.structure.error).toBe('body_page_empty');
  expect(projectSteps(request as never, failed).find(step => step.key === '3:unassigned-more')?.text).toContain('点击重试');
  missingPage = false;
  const retry = await store.loadStructure(3);
  expect(retry.structure.back).toBe(1);
  expect(retry.structure.next).toBe(41);
  expect(retry.entries).toHaveLength(40);
  const head = await store.loadStructure(3);
  expect(head.structure.back).toBe(0);
  expect(head.entries).toHaveLength(41);
  // 续读一次、失败一次、成功后重试一次：三次都读尾片区间。
  expect(fx.count('body', i => i.from === 1 && i.to === 41)).toBe(3);
});

test('孤立请求正文换版本后自动重读新消息', async () => {
  let token = TOKEN;
  let conflict = false;
  let notify: () => void = () => {};
  const refreshed = new Promise<void>(resolve => { notify = resolve; });
  const request = detail(4, {
    actor: null, actor_state: 'unknown', derived_state: 'dirty', prev_relation: null, delta_ordinals: null,
    derivation: { state: 'dirty', chain_state: 'unavailable', summary_state: 'retained', reason: 'derive_dirty' },
  });
  const fx = createFixtureReadTransport();
  fx.respond('requests', () => ({ items: [request], next_cursor: null }));
  fx.respond('detail', () => ({ ...request, reading_token: token }));
  fx.respond('body', input => {
    if (input.from === 0 && input.to === 0) return bodyPage(0, 0, 1);
    if (input.from === 0 && input.to === 1) {
      if (conflict) { conflict = false; token = TOKEN2; throw readError('reading_changed'); }
      return bodyPage(0, 1, 1, { messages: [{ ord: 0, value: { role: 'user', content: token === TOKEN ? 'before' : 'after' } }] });
    }
    throw readError('not_found');
  });
  const store = createReaderStore(fx.transport, id => {
    const read = store.peekRequest(id);
    if (read?.token === TOKEN2 && read.entries[0]?.preview === 'after') notify();
  }, { autoRereadCooldownMs: 0 });
  await store.selectSession(request.conv_key, 30);
  await store.readRequest(4);
  conflict = true;
  await expect(store.loadDelta(4)).rejects.toThrow('reading_changed');
  await Promise.race([refreshed, delay(1000).then(() => { throw new Error('auto_reread_timeout'); })]);
  const read = store.peekRequest(4);
  expect(read?.token).toBe(TOKEN2);
  expect(read?.entries[0]?.preview).toBe('after');
  expect(read?.structure.next).toBe(1);
});

test('同会话作废后迟到的路由成功响应不可用，新缓存保留', async () => {
  let routeCalls = 0;
  let release: ((value: unknown) => void) | null = null;
  const gated = new Promise<unknown>(resolve => { release = resolve; });
  const fx = createFixtureReadTransport();
  fx.respond('requests', () => ({ items: [{ req_id: 1, started_ms: 1 }], next_cursor: null }));
  fx.respond('route', () => {
    routeCalls += 1;
    return routeCalls === 1 ? gated : { state: 'absent', summary: null };
  });
  const store = createReaderStore(fx.transport);
  await store.selectSession('k', 30);
  const stale = store.readRoute(1);
  await delay(5);
  store.invalidate(1);
  const fresh = await store.readRoute(1);
  expect(fresh).toEqual({ state: 'absent', summary: null });
  release!({ state: 'present', summary: { served: 'stale' } });
  // 旧任务已被取代：成功响应也不能作为可用值返回。
  await expect(stale).rejects.toThrow('reading_changed');
  // 新缓存原样：第三次读取不发网。
  expect(await store.readRoute(1)).toEqual({ state: 'absent', summary: null });
  expect(fx.count('route')).toBe(2);
});

test('迟到的路由失败不清除已重建的新路由缓存', async () => {
  let routeCalls = 0;
  let release: (() => void) | null = null;
  const gated = new Promise<void>(resolve => { release = resolve; });
  const fx = createFixtureReadTransport();
  fx.respond('requests', () => ({ items: [{ req_id: 1, started_ms: 1 }], next_cursor: null }));
  fx.respond('route', () => {
    routeCalls += 1;
    if (routeCalls === 1) return gated.then(() => { throw readError('unavailable'); });
    return { state: 'absent', summary: null };
  });
  const store = createReaderStore(fx.transport);
  await store.selectSession('k', 30);
  const stale = store.readRoute(1);
  await delay(5);
  store.invalidate(1);
  await expect(store.readRoute(1)).resolves.toEqual({ state: 'absent', summary: null });
  release!();
  await expect(stale).rejects.toThrow();
  // 旧失败已迟到：新缓存保留，第三次读取不发网。
  await expect(store.readRoute(1)).resolves.toEqual({ state: 'absent', summary: null });
  expect(fx.count('route')).toBe(2);
});

test('409 只在真正作废当前记录时通知页面', async () => {
  let token = TOKEN;
  let bodyConflicts = false;
  let rangeCalls = 0;
  let releaseStale: (() => void) | null = null;
  const gated = new Promise<void>(resolve => { releaseStale = resolve; });
  const fx = createFixtureReadTransport();
  fx.respond('requests', () => ({ items: [{ req_id: 1, started_ms: 1 }], next_cursor: null }));
  fx.respond('detail', () => detail(1, { reading_token: token }));
  fx.respond('body', input => {
    if (input.from === 1 && input.to === 2) {
      rangeCalls += 1;
      if (rangeCalls === 1) return gated.then(() => {
        if (bodyConflicts) throw readError('reading_changed');
        return bodyPage(1, 2, 3);
      });
      if (bodyConflicts) throw readError('reading_changed');
      return bodyPage(1, 2, 3);
    }
    return bodyPage(0, 0, 3);
  });
  const invalidated: number[] = [];
  const store = createReaderStore(fx.transport, id => invalidated.push(id));
  await store.selectSession('k', 30);
  await store.readRequest(1);
  const stale = store.readRange(1, 1, 2);
  await delay(5);
  // 旧请求还挂着时版本重建：token 变化是真正作废，通知一次。
  token = TOKEN2;
  await store.readRequest(1, true);
  expect(invalidated).toEqual([1]);
  releaseStale!();
  await expect(stale).rejects.toThrow('reading_changed');
  // 迟到 409：不作废、不新增通知，新缓存保留。
  expect(invalidated).toEqual([1]);
  // 当前版本的 409：整笔作废并再次通知。
  bodyConflicts = true;
  await expect(store.readRange(1, 1, 2)).rejects.toThrow('reading_changed');
  expect(invalidated).toEqual([1, 1]);
});

test('peek 同步读取入口：不发网、无快照为 null、失败占位与作废可见', async () => {
  let detailFails = false;
  const fx = createFixtureReadTransport();
  fx.respond('requests', () => ({ items: [{ req_id: 1, started_ms: 1 }], next_cursor: null }));
  fx.respond('detail', () => {
    if (detailFails) throw readError('unavailable');
    return detail(1);
  });
  fx.respond('body', () => bodyPage(0, 0, 1));
  fx.respond('toolResult', input => {
    if (input.ord === 1) throw readError('unavailable');
    return toolReading(1, input.ord, { content: 'ok' });
  });
  fx.respond('route', () => ({ state: 'absent', summary: null }));
  const store = createReaderStore(fx.transport);
  // 未读：同步读取都是 null。
  expect(store.peekRequest(1)).toBeNull();
  expect(store.peekToolResult(1, 0)).toBeNull();
  expect(store.peekRoute(1)).toBeNull();
  await store.selectSession('k', 30);
  await store.readRequest(1);
  const peeked = store.peekRequest(1);
  expect(peeked?.detail?.req_id).toBe(1);
  // 路由没读仍是 null；读到后同步可见。
  expect(store.peekRoute(1)).toBeNull();
  await store.readRoute(1);
  expect(store.peekRoute(1)).toEqual({ state: 'absent', summary: null });
  await store.readToolResult(1, 0);
  expect(store.peekToolResult(1, 0)?.content).toBe('ok');
  // 失败登记不可读占位：同步可见，重试仍显式发起。
  await expect(store.readToolResult(1, 1)).rejects.toThrow();
  expect(store.peekToolResult(1, 1)?.state).toBe('unavailable');
  // peek 不发网络。
  const callsAtPeek = fx.calls.length;
  store.peekRequest(1);
  store.peekToolResult(1, 0);
  store.peekRoute(1);
  expect(fx.calls.length).toBe(callsAtPeek);
  // 详情读取失败如实可见：快照带 failed 态与原因，重读成功后清空。
  expect(store.peekRequest(1)?.detailError).toBeNull();
  detailFails = true;
  store.invalidate(1);
  await expect(store.readRequest(1)).rejects.toThrow('unavailable');
  expect(store.peekRequest(1)?.status).toBe('failed');
  expect(store.peekRequest(1)?.detail).toBeNull();
  expect(store.peekRequest(1)?.detailError).toBe('unavailable');
  detailFails = false;
  await store.readRequest(1);
  expect(store.peekRequest(1)?.detailError).toBeNull();
  expect(store.peekRequest(1)?.status).toBe('fresh');
  // 作废后记录保留、落作废态；换会话清空。
  store.invalidate(1);
  expect(store.peekRequest(1)?.status).toBe('invalidated');
  expect(store.peekToolResult(1, 0)).toBeNull();
  expect(store.peekRoute(1)).toBeNull();
  await store.readRequest(1);
  await store.readRoute(1);
  await store.selectSession('k2', 30);
  expect(store.peekRequest(1)).toBeNull();
  expect(store.peekRoute(1)).toBeNull();
});

test('作废即自动重读：冷却内不重复发起', async () => {
  let token = TOKEN;
  const fx = createFixtureReadTransport();
  fx.respond('requests', () => ({ items: [{ req_id: 1, started_ms: 1 }], next_cursor: null }));
  fx.respond('detail', () => detail(1, { reading_token: token }));
  fx.respond('body', input => {
    // 定点区间 0/1 永远 409：作废入口；详情与元信息正常。
    if (input.from === 0 && input.to === 1) throw readError('reading_changed');
    return bodyPage(0, 0, 1);
  });
  const store = createReaderStore(fx.transport, undefined, { autoRereadCooldownMs: 80 });
  await store.selectSession('k', 30);
  await store.readRequest(1);
  token = TOKEN2;
  await expect(store.readRange(1, 0, 1)).rejects.toThrow('reading_changed');
  expect(store.peekRequest(1)?.status).toBe('invalidated');
  expect(store.peekRequest(1)?.detail).toBeNull();
  // 自动重读在定时器里发起：换新成功后 fresh、带新 token；显示层不设成功标记。
  await delay(20);
  expect(store.peekRequest(1)?.status).toBe('fresh');
  expect(store.peekRequest(1)?.token).toBe(TOKEN2);
  // 冷却内再次作废：不立即重发；冷却到期后才再发起并换新。
  const detailCalls = fx.count('detail', i => i.id === 1);
  token = TOKEN;
  await expect(store.readRange(1, 0, 1)).rejects.toThrow('reading_changed');
  await delay(15);
  expect(fx.count('detail', i => i.id === 1)).toBe(detailCalls);
  await delay(160);
  expect(fx.count('detail', i => i.id === 1)).toBe(detailCalls + 1);
  expect(store.peekRequest(1)?.status).toBe('fresh');
  expect(store.peekRequest(1)?.token).toBe(TOKEN);
});

test('自动重读在换会话后完成，不通知新会话', async () => {
  let release: ((value: unknown) => void) | null = null;
  const gated = new Promise<unknown>(resolve => { release = resolve; });
  let started: () => void = () => {};
  const rereadStarted = new Promise<void>(resolve => { started = resolve; });
  let details = 0;
  const changes: number[] = [];
  const fx = createFixtureReadTransport();
  fx.respond('requests', () => ({ items: [{ req_id: 1, started_ms: 1 }], next_cursor: null }));
  fx.respond('detail', () => {
    details += 1;
    if (details === 2) { started(); return gated; }
    return detail(1);
  });
  fx.respond('body', input => {
    if (input.from === 0 && input.to === 0) return bodyPage(0, 0, 1);
    throw readError('reading_changed');
  });
  const store = createReaderStore(fx.transport, id => changes.push(id), { autoRereadCooldownMs: 0 });
  await store.selectSession('old', 30);
  await store.readRequest(1);
  await expect(store.readRange(1, 0, 1)).rejects.toThrow('reading_changed');
  await rereadStarted;
  await store.selectSession('new', 30);
  const afterSwitch = changes.length;
  release!(detail(1));
  await delay(5);
  expect(changes).toHaveLength(afterSwitch);
  expect(store.peekRequest(1)).toBeNull();
});

test('共享调度槽并发不超过 4', async () => {
  const slow = <T,>(value: T) => new Promise<T>(resolve => setTimeout(() => resolve(value), 15));
  const fx = createFixtureReadTransport();
  fx.respond('requests', () => slow({ items: [{ req_id: 1, started_ms: 1 }], next_cursor: null }));
  fx.respond('detail', () => slow(detail(1)));
  fx.respond('body', input => slow(bodyPage(input.from, input.to, 60)));
  const store = createReaderStore(fx.transport);
  await store.selectSession('k', 30);
  await store.readRequest(1);
  await Promise.all(Array.from({ length: 10 }, (_, i) => store.readRange(1, i * 5 + 1, i * 5 + 6)));
  expect(fx.maxInflight()).toBeLessThanOrEqual(4);
});

test('轮次快照：按累计窗口下界请求，失败与 404 落 absent，头锚点下界不随后续加载移动', async () => {
  let turnsStatus: 200 | 503 | 404 = 200;
  const changed: number[] = [];
  const fx = createFixtureReadTransport();
  fx.respond('requests', input => {
    if (input.key === 'empty') return { items: [], next_cursor: null };
    if (input.cursor === null) return { items: [{ req_id: 5, started_ms: 5 }], next_cursor: 'c1' };
    return { items: [{ req_id: 10, started_ms: 10 }], next_cursor: null };
  });
  fx.respond('turns', input => {
    if (turnsStatus === 503) throw readError('unavailable');
    if (turnsStatus === 404) throw readError('not_found');
    return { items: [
      { turn: 1, start_req: 7, ordinals: [2], reply_req: 8 },
      { turn: 2, start_req: 12, ordinals: [2], reply_req: 12 },
    ].filter(t => t.start_req >= input.from) };
  });
  const store = createReaderStore(fx.transport, undefined, { onTurnsChanged: () => changed.push(1) });
  // 选会话后自动取一次，下界取窗口最早请求（头锚点即会话开头一页的最早笔）。
  await store.selectSession('k', 30);
  await store.loadTurns();
  expect(fx.calls.some(call =>
    call.operation === 'turns' && (call.input as { from: number }).from === 5)).toBe(true);
  expect(store.peekTurns().status).toBe('ready');
  // 起点 7 与 12 都在下界 5 之后：两轮都在快照里。
  expect(store.peekTurns().items.map(t => t.turn)).toEqual([1, 2]);
  // 加载后续：窗口向尾部追加，下界不动，轮次无需重取。
  await store.loadLater();
  expect(store.getWindow().requests.map(r => r.req_id)).toEqual([5, 10]);
  await store.loadTurns();
  expect(fx.calls.some(call =>
    call.operation === 'turns' && (call.input as { from: number }).from === 10)).toBe(false);
  expect(store.peekTurns().items.map(t => t.turn)).toEqual([1, 2]);
  // 读取失败落 absent：带不渲染，不占位；恢复后下次触发重取。
  turnsStatus = 503;
  await store.loadTurns();
  expect(store.peekTurns().status).toBe('absent');
  expect(store.peekTurns().items).toEqual([]);
  turnsStatus = 200;
  await store.loadTurns();
  expect(store.peekTurns().status).toBe('ready');
  // 后端未部署（404）同样 absent。
  turnsStatus = 404;
  await store.loadTurns();
  expect(store.peekTurns().status).toBe('absent');
  // 空窗口不发轮次请求，直接落 absent。
  const turnsCalls = fx.count('turns');
  await store.selectSession('empty', 30);
  await store.loadTurns();
  expect(store.peekTurns().status).toBe('absent');
  expect(fx.count('turns')).toBe(turnsCalls);
  // 每次落地都通知页面重绘。
  expect(changed.length).toBeGreaterThan(0);
});

const session = (key: string) => ({
  conv_key: key, title: key, last_ms: 1, request_count: 1, agents: ['claude'], flags: [] as string[],
});

test('会话列表跨页按 conv_key 去重', async () => {
  const fx = createFixtureReadTransport();
  fx.respond('sessions', input => input.cursor === 'c1'
    ? { items: [session('b'), session('a')], next_cursor: null }
    : { items: [session('a'), session('b')], next_cursor: 'c1' });
  const store = createReaderStore(fx.transport);
  await store.loadSessions();
  await store.loadSessions('c1');
  // 分页边界把同一会话返回两次：列表只保留先出现的一条。
  expect(store.getSessions().items.map(item => item.conv_key)).toEqual(['a', 'b']);
});

test('会话列表并发加载只发一次请求', async () => {
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fx = createFixtureReadTransport();
  fx.respond('sessions', () => gate.then(() => ({ items: [session('a')], next_cursor: null })));
  const store = createReaderStore(fx.transport);
  const first = store.loadSessions();
  const second = store.loadSessions();
  release();
  await Promise.all([first, second]);
  expect(fx.count('sessions')).toBe(1);
});

test('退出会话清窗口与缓存，迟到的会话读取不能复活内容', async () => {
  const fx = createFixtureReadTransport();
  fx.respond('requests', () => ({ items: [{ req_id: 1, started_ms: 1 }], next_cursor: null }));
  fx.respond('detail', () => detail(1));
  fx.respond('body', () => bodyPage(0, 0, 1));
  const store = createReaderStore(fx.transport);
  await store.selectSession('k', 30);
  // 详情读取停在 transport 里，窗口还在时离开会话。
  fx.hold('detail');
  const pending = store.readRequest(1);
  await fx.started('detail');
  store.leaveSession();
  // 取消即时生效：在途执行被 abort 并以 cancelled 结算，迟到的读取不复活窗口内容。
  await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  expect(store.getWindow().sessionKey).toBeNull();
  expect(store.getWindow().requests).toEqual([]);
  expect(store.getWindow().newerCursor).toBeNull();
  expect(store.peekRequest(1)).toBeNull();
});

test('dispose 后读取以 cancelled 拒绝', async () => {
  const fx = createFixtureReadTransport();
  fx.respond('detail', () => detail(1));
  const store = createReaderStore(fx.transport);
  store.dispose();
  await expect(store.readRequest(1)).rejects.toMatchObject({ code: 'cancelled' });
  await expect(store.loadStats()).rejects.toMatchObject({ code: 'cancelled' });
  // 未配置操作在 dispose 前也不发网：dispose 已停止调度。
  expect(fx.calls).toEqual([]);
});

test('弹窗读取走 dialog scope：关闭即取消，不进全局正文缓存', async () => {
  const fx = createFixtureReadTransport();
  fx.respond('contextItem', () => ({ state: 'available', reason: null, notes: [], entries: [], next_cursor: null }));
  fx.respond('body', input => bodyPage(input.from, input.to, 1));
  fx.respond('toolResult', () => toolReading(1, 0, { content: 'tool body' }));
  const store = createReaderStore(fx.transport);
  const controller = new AbortController();
  const dir = store.readContextItem(1, { kind: 'results', name: null, tag: null, cursor: null }, TOKEN, controller.signal);
  await expect(dir).resolves.toMatchObject({ state: 'available' });
  const body = store.readContextBody({ operation: 'body', input: { id: 1, token: TOKEN, from: 0, to: 1 } }, controller.signal);
  await expect(body).resolves.toMatchObject({ from: 0 });
  const tool = store.readContextBody(
    { operation: 'toolResult', input: { id: 1, ord: 0, token: TOKEN } }, controller.signal);
  await expect(tool).resolves.toMatchObject({ content: 'tool body' });
  // 关闭弹窗：在途读取被取消。
  fx.hold('body');
  const pending = store.readContextBody({ operation: 'body', input: { id: 1, token: TOKEN, from: 0, to: 1 } }, controller.signal);
  await fx.started('body');
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  // 弹窗读取不进全局正文缓存，也不发全局读取。
  expect(store.peekRequest(1)).toBeNull();
});
