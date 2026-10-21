import type { Database } from 'bun:sqlite';
import { zstdDecompressSync } from 'node:zlib';
import type { Store } from './store';

/** 从回复里取工具调用；两种协议结构都认。 */
function anthropicReplyCalls(reply: unknown): { id: string; name: string; ord: number }[] {
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) return [];
  const content = (reply as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    // chat 形状：choices[0].message.tool_calls
    const choices = (reply as Record<string, unknown>).choices;
    if (!Array.isArray(choices)) return [];
    const out: { id: string; name: string; ord: number }[] = [];
    for (const choice of choices) {
      if (choice === null || typeof choice !== 'object') continue;
      const message = (choice as Record<string, unknown>).message;
      if (message === null || typeof message !== 'object') continue;
      const calls = (message as Record<string, unknown>).tool_calls;
      if (!Array.isArray(calls)) continue;
      for (const [index, call] of calls.entries()) {
        if (call === null || typeof call !== 'object') continue;
        const record = call as Record<string, unknown>;
        const id = record.id;
        const fn = record.function;
        if (typeof id !== 'string' || fn === null || typeof fn !== 'object') continue;
        out.push({ id, name: String((fn as Record<string, unknown>).name ?? ''), ord: index });
      }
    }
    return out;
  }
  const out: { id: string; name: string; ord: number }[] = [];
  for (const [ord, block] of content.entries()) {
    if (block === null || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if (record.type !== 'tool_use' || typeof record.id !== 'string') continue;
    out.push({ id: record.id, name: String(record.name ?? ''), ord });
  }
  return out;
}

/** 从请求里取工具结果；Anthropic 的 tool_result 与 chat 的 role=tool。 */
function anthropicRequestResults(request: unknown): { id: string; ord: number; path: string; value: unknown }[] {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return [];
  const messages = (request as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return [];
  const out: { id: string; ord: number; path: string; value: unknown }[] = [];
  for (const [ord, message] of messages.entries()) {
    if (message === null || typeof message !== 'object') continue;
    const record = message as Record<string, unknown>;
    if (record.role === 'tool' && typeof record.tool_call_id === 'string') {
      out.push({ id: record.tool_call_id, ord, path: `request.messages[${ord}]`, value: record.content ?? null });
      continue;
    }
    const content = record.content;
    if (!Array.isArray(content)) continue;
    for (const [index, block] of content.entries()) {
      if (block === null || typeof block !== 'object') continue;
      const entry = block as Record<string, unknown>;
      if (entry.type !== 'tool_result' || typeof entry.tool_use_id !== 'string') continue;
      out.push({
        id: entry.tool_use_id, ord,
        path: `request.messages[${ord}].content[${index}]`,
        value: entry.content ?? null,
      });
    }
  }
  return out;
}

/**
 * 派生：前驱关系、确定增量、标题与工具往返。
 *
 * 归属未知（actor_state='unknown'）的请求不参与派生：不进队列、不算增量、
 * 不配工具、标题回落到模型时间。身份确认后才入队，避免跨子代理串数据。
 */

export type SequenceRelation = 'first' | 'confirmed' | 'unknown';

export type SequenceResult = {
  relation: SequenceRelation;
  delta: number[] | null;
};

/**
 * 比较两笔请求的消息块序列。只有上一笔的序列是本笔的完整前缀时才确认增量；
 * 压缩、裁剪、分支或结构指令变化一律未知，不猜。
 */
export function compareSequence(
  previous: readonly number[] | null,
  current: readonly number[],
  hasPredecessor: boolean,
): SequenceResult {
  if (!hasPredecessor) return { relation: 'first', delta: current.map((_, index) => index) };
  if (previous === null || previous.length > current.length ||
      previous.some((id, index) => id !== current[index])) {
    return { relation: 'unknown', delta: null };
  }
  return {
    relation: 'confirmed',
    delta: current.slice(previous.length).map((_, offset) => offset + previous.length),
  };
}

const SYSTEM_TAG = /^\s*<(?:system-reminder|command-[a-z-]+)>[\s\S]*?<\/(?:system-reminder|command-[a-z-]+)>\s*/i;
const CWD_WRAPPER = /^\s*(?:工作目录|working directory|cwd)[:：][^\n]*\n?/i;
const TITLE_UNICODE_LIMIT = 60;

/** 取第一个确定新增 USER 文本的首行；没有可用增量时回落到模型时间。 */
export function deriveTitle(
  messages: readonly unknown[],
  delta: readonly number[] | null,
  fallback: string,
): { title: string; source: 'user_delta' | 'model_time' } {
  if (delta === null) return { title: fallback, source: 'model_time' };
  for (const ordinal of delta) {
    const text = userText(messages[ordinal]);
    if (text === null) continue;
    const cleaned = text
      .replace(SYSTEM_TAG, '')
      .replace(CWD_WRAPPER, '')
      .split('\n')[0]
      ?.replace(/\s+/g, ' ')
      .trim();
    if (cleaned === undefined || cleaned.length === 0) continue;
    return { title: [...cleaned].slice(0, TITLE_UNICODE_LIMIT).join(''), source: 'user_delta' };
  }
  return { title: fallback, source: 'model_time' };
}

function userText(message: unknown): string | null {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return null;
  const record = message as Record<string, unknown>;
  if (record.role !== 'user') return null;
  const content = record.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (block !== null && typeof block === 'object' && !Array.isArray(block)) {
      const value = (block as Record<string, unknown>).text;
      if (typeof value === 'string') parts.push(value);
    }
  }
  return parts.length === 0 ? null : parts.join('\n');
}

/** 只接受已确认归属的分组；调用方先守卫，这里再挡一层。 */
export function enqueueDerive(store: Store, convKey: string, actor: string, fromSort: string): void {
  store.write(db => enqueueDeriveTx(db, convKey, actor, fromSort));
}

/** 事务内版本：调用方已在事务里时用它，避免嵌套事务。 */
export function enqueueDeriveTx(db: Database, convKey: string, actor: string, fromSort: string): void {
  const known = db.query<{ req_id: number }, [string, string]>(`
    SELECT req_id FROM request
    WHERE conv_key=? AND actor=? AND actor_state='known' LIMIT 1`).get(convKey, actor);
  if (known == null) return;
  db.run(
    `INSERT INTO derive_queue(conv_key,actor,from_sort) VALUES (?,?,?)
     ON CONFLICT(conv_key,actor) DO UPDATE SET from_sort=MIN(derive_queue.from_sort,excluded.from_sort)`,
    [convKey, actor, fromSort],
  );
}

/** 稳定排序键：优先账本物理位置，其次是时间与请求号。 */
function sortKeyOf(row: {
  sort_source: string | null; sort_key: string | null; started_ms: number; req_id: number;
}): string {
  if (row.sort_source !== null && row.sort_key !== null) return row.sort_key;
  return `time|${String(row.started_ms).padStart(16, '0')}|${String(row.req_id).padStart(20, '0')}`;
}

type ChainRow = {
  req_id: number; actor: string; actor_state: string; started_ms: number;
  sort_source: string | null; sort_key: string | null;
  prev_req_id: number | null; prev_relation: string | null;
  title_source: string | null; title: string | null; model_served: string | null;
};

function blocksOf(db: Database, reqId: number): number[] | null {
  const body = db.query<{ body_state: string }, [number]>(
    'SELECT body_state FROM request WHERE req_id=?',
  ).get(reqId);
  if (body == null || (body.body_state !== 'available' && body.body_state !== 'partial')) return null;
  return db.query<{ block: number }, [number]>(
    'SELECT block FROM request_block WHERE req_id=? ORDER BY ord',
  ).all(reqId).map(row => row.block);
}

function messageAt(db: Database, reqId: number, ordinal: number): unknown | null {
  const row = db.query<{ z: Uint8Array }, [number, number]>(`
    SELECT b.z AS z FROM request_block rb JOIN block b ON b.id = rb.block
    WHERE rb.req_id=? AND rb.ord=?`).get(reqId, ordinal);
  if (row == null) return null;
  try {
    return JSON.parse(zstdDecompressSync(row.z).toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * 处理队列里的一批分组。每个分组按稳定顺序从头重算整条链：
 * 这样乱序到达、迟到正文与归属变化都收敛到同一个结果，与到达顺序无关。
 * 返回本批处理过的分组，供调用方只重配这些分组的工具往返。
 */
export function drainDerive(store: Store, limit = 100): {
  processed: number; remaining: number; groups: { conv_key: string; actor: string }[];
} {
  return store.write(db => {
    const groups = db.query<{ conv_key: string; actor: string }, [number]>(
      'SELECT conv_key, actor FROM derive_queue ORDER BY conv_key, actor LIMIT ?').all(limit);
    const touched: { conv_key: string; actor: string }[] = [];
    let processed = 0;
    for (const group of groups) {
      const rows = db.query<ChainRow, [string, string]>(`
        SELECT req_id, actor, actor_state, started_ms, sort_source, sort_key, prev_req_id, prev_relation,
               title_source, title, model_served
        FROM request WHERE conv_key=? AND actor=? AND actor_state='known'`).all(group.conv_key, group.actor);
      const ordered = [...rows].sort((left, right) =>
        sortKeyOf(left).localeCompare(sortKeyOf(right)));
      let previous: ChainRow | null = null;
      let previousBlocks: number[] | null = null;
      for (const row of ordered) {
        const currentBlocks = blocksOf(db, row.req_id);
        const comparable = previous !== null && previousBlocks !== null && currentBlocks !== null;
        const result = compareSequence(
          previousBlocks,
          currentBlocks ?? [],
          previous !== null,
        );
        const relation: SequenceRelation = comparable && currentBlocks !== null
          ? result.relation
          : previous === null ? 'first' : 'unknown';
        const delta = relation === 'first' ? result.delta
          : relation === 'confirmed' ? result.delta
            : null;

        const fallback = row.title ?? `${row.model_served ?? '模型'} · ${clock(row.started_ms)}`;
        let title = fallback;
        let source: 'user_delta' | 'model_time' = 'model_time';
        if (delta !== null && delta.length > 0) {
          // delta 里存的是本笔的 ord；取出对应消息后按 0..n-1 重新编号给 deriveTitle。
          const messages = delta.map(ordinal => messageAt(db, row.req_id, ordinal));
          const derived = deriveTitle(messages, delta.map((_, index) => index), fallback);
          title = derived.title;
          source = derived.source;
        }
        db.run(
          `UPDATE request SET prev_req_id=?, prev_relation=?, delta_ordinals=?, title=?, title_source=?,
             derive_version=derive_version+1 WHERE req_id=?`,
          [
            previous?.req_id ?? null, relation,
            delta === null ? null : JSON.stringify(delta),
            title, source, row.req_id,
          ],
        );
        previous = row;
        previousBlocks = currentBlocks;
        processed += 1;
      }
      db.run('DELETE FROM derive_queue WHERE conv_key=? AND actor=?', [group.conv_key, group.actor]);
      touched.push(group);
    }
    const remaining = (db.query('SELECT COUNT(*) AS n FROM derive_queue').get() as { n: number }).n;
    return { processed, remaining, groups: touched };
  });
}

function clock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

type TxBody = { request: unknown; reply: unknown } | null;

/**
 * 事务内读取正文。必须用事务自己的连接：只读连接是另一个快照，
 * 看不到本事务刚写入的块。
 */
function bodyInTx(db: Database, reqId: number): TxBody {
  const row = db.query<{ skeleton_z: Uint8Array | null; body_state: string }, [number]>(
    'SELECT skeleton_z, body_state FROM request WHERE req_id=?',
  ).get(reqId);
  if (row == null || row.skeleton_z == null) return null;
  if (row.body_state !== 'available' && row.body_state !== 'partial') return null;
  const skeleton = JSON.parse(zstdDecompressSync(row.skeleton_z).toString('utf8')) as {
    request_without_messages?: unknown; reply?: unknown; has_messages?: boolean;
  };
  let request = skeleton.request_without_messages ?? null;
  if (skeleton.has_messages === true) {
    const refs = db.query<{ z: Uint8Array }, [number]>(
      'SELECT b.z AS z FROM request_block rb JOIN block b ON b.id = rb.block WHERE rb.req_id=? ORDER BY rb.ord',
    ).all(reqId);
    const messages = refs.map(ref => JSON.parse(zstdDecompressSync(ref.z).toString('utf8')));
    request = { ...((request ?? {}) as Record<string, unknown>), messages };
  }
  return { request, reply: skeleton.reply ?? null };
}

/**
 * 工具往返：调用来自回复，结果出现在后续同 conv/actor 的请求里。
 *
 * 只配已有确定增量覆盖的结果（confirmed/first）；unknown 请求里的结果最多
 * 建候选，不标 resolved。同一 call_id 命中多个发起请求时标 ambiguous，
 * 不挑最近的一个，也不跨 actor 配对。
 */
export function pairToolCalls(store: Store, convKey: string, actor: string): { resolved: number; ambiguous: number; pending: number } {
  return store.write(db => {
    const rows = db.query<{
      req_id: number; prev_relation: string | null; delta_ordinals: string | null;
    }, [string, string]>(`
      SELECT req_id, prev_relation, delta_ordinals FROM request
      WHERE conv_key=? AND actor=? AND actor_state='known'
      ORDER BY started_ms, req_id`).all(convKey, actor);
    if (rows.length === 0) return { resolved: 0, ambiguous: 0, pending: 0 };

    // 先清空本组旧配对，再按当前数据重建；配对是可变状态，重算比增量修补更不容易漂移。
    db.run(`
      DELETE FROM tool_call WHERE req_id IN (
        SELECT req_id FROM request WHERE conv_key=? AND actor=? AND actor_state='known')`,
    [convKey, actor]);

    type Call = { req_id: number; ord: number; call_id: string; name: string; index: number };
    const calls: Call[] = [];
    const results: { req_id: number; index: number; ord: number; path: string; call_id: string; value: unknown; confirmed: boolean }[] = [];

    for (const [index, row] of rows.entries()) {
      const body = bodyInTx(db, row.req_id);
      if (body === null) continue;
      // 结果是否落在确定增量的 ord 上；unknown/first 的规则不同。
      const delta = row.delta_ordinals === null ? null : JSON.parse(row.delta_ordinals) as number[];
      const ordinalConfirmed = (ord: number): boolean =>
        row.prev_relation === 'first' ? true : delta !== null && delta.includes(ord);
      for (const block of anthropicReplyCalls(body.reply)) {
        calls.push({ req_id: row.req_id, ord: block.ord, call_id: block.id, name: block.name, index });
      }
      for (const result of anthropicRequestResults(body.request)) {
        results.push({
          req_id: row.req_id, index, ord: result.ord, path: result.path,
          call_id: result.id, value: result.value, confirmed: ordinalConfirmed(result.ord),
        });
      }
    }

    const byCallId = new Map<string, Call[]>();
    for (const call of calls) {
      const list = byCallId.get(call.call_id) ?? [];
      list.push(call);
      byCallId.set(call.call_id, list);
    }

    let resolved = 0;
    let ambiguous = 0;
    let pending = 0;
    for (const call of calls) {
      const candidates = byCallId.get(call.call_id) ?? [];
      const state = candidates.length > 1 ? 'ambiguous' : 'pending';
      if (state === 'ambiguous') ambiguous += 1;
      else pending += 1;
      db.run(
        `INSERT INTO tool_call(call_id,req_id,ord,tool_name,result_req,result_ord,result_path,state,derive_version)
         VALUES (?,?,?,?,NULL,NULL,NULL,?,1)`,
        [call.call_id, call.req_id, call.ord, call.name, state],
      );
    }

    for (const result of results) {
      const candidates = byCallId.get(result.call_id) ?? [];
      if (candidates.length === 0) continue;
      if (candidates.length > 1) {
        // 多候选保持 ambiguous，结果位置仍然记下，便于人工核对。
        for (const call of candidates) {
          db.run(
            `UPDATE tool_call SET result_req=?, result_ord=?, result_path=?, state='ambiguous'
             WHERE req_id=? AND ord=?`,
            [result.req_id, result.ord, result.path, call.req_id, call.ord],
          );
        }
        continue;
      }
      const call = candidates[0]!;
      // 结果必须晚于调用；同一请求内的结果顺序不可靠，不配对。
      if (call.index >= result.index) continue;
      // 后续请求会重发整段历史，同一结果会反复出现。已确认的配对是终态，
      // 重发样本只可能把它降级成 pending，因此直接跳过。
      const paired = db.query<{ state: string }, [number, number]>(
        'SELECT state FROM tool_call WHERE req_id=? AND ord=?',
      ).get(call.req_id, call.ord);
      if (paired?.state === 'resolved') continue;
      if (!result.confirmed) {
        // 增量关系未知：只建立候选，不标 resolved。若这一格此前已有候选位置，
        // 保留更早的那个位置——候选只记首次见到的地方。
        if (paired?.state === 'pending') continue;
        db.run(
          `UPDATE tool_call SET result_req=?, result_ord=?, result_path=?, state='pending'
           WHERE req_id=? AND ord=?`,
          [result.req_id, result.ord, result.path, call.req_id, call.ord],
        );
        continue;
      }
      db.run(
        `UPDATE tool_call SET result_req=?, result_ord=?, result_path=?, state='resolved'
         WHERE req_id=? AND ord=?`,
        [result.req_id, result.ord, result.path, call.req_id, call.ord],
      );
      resolved += 1;
    }

    db.run(
      `UPDATE tool_call SET derive_version=derive_version+1 WHERE req_id IN (
        SELECT req_id FROM request WHERE conv_key=? AND actor=? AND actor_state='known')`,
      [convKey, actor],
    );
    return { resolved, ambiguous, pending };
  });
}

/** 维护命令：整条链重排一次；正文不可用的请求保持未知。 */
export function rebuildDerived(store: Store, convKey: string): { queued: number; unavailable: number } {
  return store.write(db => {
    const actors = db.query<{ actor: string }, [string]>(`
      SELECT DISTINCT actor FROM request
      WHERE conv_key=? AND actor IS NOT NULL AND actor_state='known'`).all(convKey);
    let unavailable = 0;
    for (const { actor } of actors) {
      const missing = db.query<{ n: number }, [string, string]>(`
        SELECT COUNT(*) AS n FROM request
        WHERE conv_key=? AND actor=? AND actor_state='known'
          AND body_state NOT IN ('available','partial')`).get(convKey, actor);
      unavailable += missing?.n ?? 0;
      db.run(
        `INSERT INTO derive_queue(conv_key,actor,from_sort) VALUES (?,?,?)
         ON CONFLICT(conv_key,actor) DO UPDATE SET from_sort=''`,
        [convKey, actor, ''],
      );
    }
    return { queued: actors.length, unavailable };
  });
}
