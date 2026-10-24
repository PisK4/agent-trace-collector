// @ts-check
import { deltaOrdinals, messageEntries } from './body-view.js';

/**
 * 生产阅读的读取协调：网络、区间缓存、inflight 去重、失效与异步代次都在这里，
 * 不进 DOM 闭包。正文与工具结果带阅读版本；409 整笔作废（详情、meta、消息、
 * 区间、结构、增量、工具与路由一起），下一次普通读取重建。token 变化的 validate
 * 读取同样重置整笔快照。迟到响应必须同时匹配会话代次、当前记录归属与捕获的
 * token 才可写入缓存；作废记录不再作为可用快照返回。真正作废当前记录时通过
 * onInvalidated 通知页面；迟到响应与会话切换后的旧回调不作废、不通知，页面
 * 不按 reading_changed 错误自行清理副本。
 *
 * 缓存边界：只保留当前会话已加载窗口的请求，外加显式读取过的窗口外请求。
 */

/**
 * @typedef {Object} RequestRead 一次请求的读取快照。
 * @property {import('../src/queries').RequestDetail | null} detail
 * @property {import('../src/protocols').BodyPage | null} meta
 * @property {Map<number, ReturnType<typeof messageEntries>[number]>} messages
 * @property {ReturnType<typeof messageEntries>} entries
 * @property {{open: boolean, next: number, total: number | null, ords: number[], selected: number | null, loading: boolean, error: string | null}} structure
 * @property {{next: number, done: boolean, loading: boolean, error: string | null, unconfirmed: boolean}} delta
 * @property {string | null} token
 */

/**
 * @typedef {Object} ReaderStore
 * @property {() => {sessionKey: string | null, requests: import('../src/queries').RequestRow[], olderCursor: string | null, loading: boolean, error: string | null}} getWindow
 * @property {() => {items: import('../src/queries').SessionRow[], cursor: string | null, error: string | null}} getSessions
 * @property {(cursor?: string) => Promise<void>} loadSessions
 * @property {(key: string, limit?: number) => Promise<void>} selectSession
 * @property {() => Promise<void>} loadEarlier
 * @property {(id: number, validate?: boolean) => Promise<RequestRead>} readRequest
 * @property {(id: number, from: number, to: number) => Promise<import('../src/protocols').BodyPage>} readRange
 * @property {(id: number) => Promise<RequestRead>} loadStructure
 * @property {(id: number, pages?: number) => Promise<RequestRead>} loadDelta
 * @property {(id: number, ord: number) => Promise<import('../src/reading').ToolResultReading>} readToolResult
 * @property {(id: number) => Promise<unknown>} readRoute
 * @property {(id: number) => void} invalidate
 */

/**
 * 固定 N 并发的网络队列：失败在 finally 释放，不占住后续请求。
 * @param {number} limit
 * @param {(url: string) => Promise<Response>} fetcher
 */
function createLanes(limit, fetcher) {
  /** @type {{task: () => Promise<unknown>, resolve: (value: Response) => void, reject: (reason?: unknown) => void}[]} */
  const queue = [];
  let active = 0;
  const pump = () => {
    while (active < limit && queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) break;
      active += 1;
      next.task().then(value => next.resolve(/** @type {Response} */ (value)), reason => next.reject(reason))
        .finally(() => { active -= 1; pump(); });
    }
  };
  /** @param {string} url @returns {Promise<Response>} */
  const run = url => new Promise((resolve, reject) => {
    queue.push({ task: () => fetcher(url), resolve, reject });
    pump();
  });
  return run;
}

/**
 * @param {(url: string) => Promise<Response>} fetcher
 * @param {(id: number) => void} [onInvalidated] store 真正作废当前记录时通知页面；
 *   迟到响应与会话切换后的旧任务不作废、不通知。
 * @returns {ReaderStore}
 */
export function createReaderStore(fetcher, onInvalidated) {
  const lane = createLanes(4, fetcher);
  let epoch = 0;

  /** @type {{items: import('../src/queries').SessionRow[], cursor: string | null, error: string | null}} */
  const sessions = { items: [], cursor: null, error: null };
  /** @type {string | null} */
  let sessionKey = null;
  /** @type {import('../src/queries').RequestRow[]} */
  let windowRows = [];
  /** @type {string | null} */
  let olderCursor = null;
  let windowLoading = false;
  /** @type {string | null} */
  let windowError = null;

  /**
   * 请求读取缓存，按 canonical id 归属。rec 的字段在运行期由各读取路径填充，
   * 结构与 RequestRead 对齐（messages 以 ord 为键保存解释后的消息）。
   * @type {Map<number, any>}
   */
  const reads = new Map();
  /** @type {Map<number, Promise<unknown>>} 路由只在用户展开时读取，单独缓存。 */
  const routes = new Map();

  /** @param {number} id */
  function recordOf(id) {
    let rec = reads.get(id);
    if (rec === undefined) {
      rec = {
        id, token: null,
        detail: null, detailError: null,
        meta: null,
        pages: new Map(),
        messages: new Map(),
        structure: { open: false, next: 0, total: null, ords: [], selected: null, loading: false, error: null },
        delta: { next: 0, done: false, loading: false, error: null, unconfirmed: false },
        tools: new Map(),
      };
      reads.set(id, rec);
    }
    return rec;
  }

  /** @param {any} rec */
  const sortedEntries = rec => [...rec.messages.values()].sort((/** @type {{ord: number}} */ a, /** @type {{ord: number}} */ b) => a.ord - b.ord);

  /** @param {any} rec @param {import('../src/protocols').BodyPage} page */
  function mergeMessages(rec, page) {
    for (const entry of messageEntries(page)) {
      if (!rec.messages.has(entry.ord)) rec.messages.set(entry.ord, entry);
    }
  }

  /** @param {string | undefined} cursor */
  async function loadSessions(cursor) {
    try {
      const page = await getJson(`/api/sessions?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      sessions.items = cursor ? [...sessions.items, ...page.items] : page.items;
      sessions.cursor = page.next_cursor;
      sessions.error = null;
    } catch (error) {
      sessions.error = error instanceof Error ? error.message : 'load_failed';
    }
  }

  /** @param {string} url */
  async function getJson(url) {
    const response = await lane(url);
    if (response.status === 409) {
      const error = /** @type {Error & {code?: string}} */ (new Error('reading_changed'));
      error.code = 'reading_changed';
      throw error;
    }
    if (!response.ok) {
      const error = /** @type {Error & {code?: string}} */ (new Error(`http_${response.status}`));
      error.code = response.status === 503 ? 'unavailable' : `http_${response.status}`;
      throw error;
    }
    return response.json();
  }

  /** @param {string} key @param {number} limit */
  async function selectSession(key, limit = 30) {
    const myEpoch = ++epoch;
    sessionKey = key;
    windowLoading = true;
    windowError = null;
    reads.clear();
    routes.clear();
    try {
      const page = await getJson(`/api/sessions/${encodeURIComponent(key)}/requests?direction=older&limit=${limit}`);
      if (myEpoch !== epoch) return;
      windowRows = page.items;
      olderCursor = page.next_cursor;
    } catch (error) {
      if (myEpoch !== epoch) return;
      windowRows = [];
      olderCursor = null;
      windowError = error instanceof Error ? error.message : 'window_failed';
    } finally {
      if (myEpoch === epoch) windowLoading = false;
    }
  }

  async function loadEarlier() {
    if (windowLoading || olderCursor === null) return;
    const myEpoch = epoch;
    windowLoading = true;
    windowError = null;
    try {
      // 服务端窗口分页上限 200（queries.checkLimit）：翻倍请求越过上限后
      // 每次都会 400，窗口停在 400 行以内；clamp 到上限继续按页加载。
      const page = await getJson(`/api/sessions/${encodeURIComponent(String(sessionKey))}/requests?direction=older&limit=${Math.min(windowRows.length > 0 ? windowRows.length : 30, 200)}&cursor=${encodeURIComponent(olderCursor)}`);
      if (myEpoch !== epoch) return;
      // prepend + 去重 + 排序：失败保留旧 rows/cursor 由 catch 负责。
      const seen = new Set(windowRows.map(row => row.req_id));
      windowRows = [...page.items.filter((/** @type {{req_id: number}} */ row) => !seen.has(row.req_id)), ...windowRows]
        .sort((a, b) => a.started_ms - b.started_ms || a.req_id - b.req_id);
      olderCursor = page.next_cursor;
    } catch (error) {
      if (myEpoch !== epoch) return;
      windowError = error instanceof Error ? error.message : 'window_failed';
    } finally {
      if (myEpoch === epoch) windowLoading = false;
    }
  }

  /**
   * 一次请求的读取快照必须归属当前记录：异步读取在回写前同时校验会话代次、
   * reads 归属与捕获的 token，任一不符抛 reading_changed，不写入旧对象。
   * @returns {never}
   */
  function throwReadingChanged() {
    const error = /** @type {Error & {code?: string}} */ (new Error('reading_changed'));
    error.code = 'reading_changed';
    throw error;
  }

  /**
   * 409 只在失败读取仍是当前记录的当前版本时整笔作废；迟到 409 不能清掉已重建的新缓存。
   * @param {any} rec @param {number} id @param {number} myEpoch @param {string | null} myToken
   */
  function invalidateIfCurrent(rec, id, myEpoch, myToken) {
    if (myEpoch === epoch && reads.get(id) === rec && rec.token === myToken) {
      invalidate(id);
      onInvalidated?.(id);
    }
  }

  /** @param {any} rec @param {boolean} validate */
  async function fetchDetail(rec, validate) {
    if (rec.detail !== null && !validate) return;
    // 普通读取合并进在跑的详情读取；validate 必须等它结束再拉一次，不把旧读取当成验证完成。
    while (rec.detailInflight !== undefined) {
      const pending = rec.detailInflight;
      try { await pending; } catch { /* 旧读取失败：合并方在下面重新发起，不继承失败为成功 */ }
      if (rec.detail !== null && !validate) return;
      if (rec.detailInflight === pending) break;
    }
    if (rec.detail !== null && !validate) return;
    const myEpoch = epoch;
    /** @type {Promise<void>} */
    const task = (async () => {
      const detail = await getJson(`/api/requests/${rec.id}`);
      if (myEpoch !== epoch || reads.get(rec.id) !== rec) throwReadingChanged();
      if (validate && rec.token !== null && detail.reading_token !== rec.token) {
        // token 变化：消息、区间、结构、增量、工具、元信息与路由全部作废，避免新旧混拼。
        rec.pages = new Map();
        rec.messages = new Map();
        rec.meta = null;
        rec.structure = { open: false, next: 0, total: null, ords: [], selected: null, loading: false, error: null };
        rec.delta = { next: 0, done: false, loading: false, error: null, unconfirmed: false };
        rec.tools = new Map();
        routes.delete(rec.id);
        onInvalidated?.(rec.id);
      }
      rec.detail = detail;
      rec.token = detail.reading_token;
      rec.detailError = null;
    })();
    rec.detailInflight = task;
    try {
      await task;
    } catch (error) {
      if (/** @type {Error & {code?: string}} */ (error).code === 'reading_changed') {
        if (reads.get(rec.id) === rec) {
          reads.delete(rec.id);
          onInvalidated?.(rec.id);
        }
        throw error;
      }
      rec.detailError = error instanceof Error ? error.message : 'detail_failed';
      throw error;
    } finally {
      if (rec.detailInflight === task) rec.detailInflight = undefined;
    }
  }

  /** @param {any} rec @returns {RequestRead} */
  function assemble(rec) {
    return {
      detail: rec.detail,
      meta: rec.meta,
      messages: rec.messages,
      entries: sortedEntries(rec),
      structure: rec.structure,
      delta: rec.delta,
      token: rec.token,
    };
  }

  /** @param {number} id @param {boolean} validate @returns {Promise<RequestRead>} */
  async function readRequest(id, validate = false) {
    const rec = recordOf(id);
    await fetchDetail(rec, validate);
    if (reads.get(id) !== rec) throwReadingChanged();
    if (rec.meta === null && rec.detail !== null) {
      // 首次 detail 后读 body 0/0 元信息；后续区间读取不覆盖 meta。
      const meta = await readRange(id, 0, 0);
      if (reads.get(id) !== rec) throwReadingChanged();
      if (meta !== null) rec.meta = meta;
    }
    return assemble(rec);
  }

  /** @param {number} id @param {number} from @param {number} to @returns {Promise<import('../src/protocols').BodyPage>} */
  async function readRange(id, from, to) {
    const rec = recordOf(id);
    if (rec.detail === null) await fetchDetail(rec, false);
    if (rec.detail === null) throw rec.detailError ?? new Error('detail_unavailable');
    const key = JSON.stringify([id, rec.token, from, to]);
    let pending = rec.pages.get(key);
    if (pending === undefined) {
      const myEpoch = epoch;
      const myToken = rec.token;
      pending = (async () => {
        try {
          const page = await getJson(`/api/requests/${id}/body?from=${from}&to=${to}&if_reading=${myToken}`);
          // 迟到响应：会话已切换、记录已作废重建，或版本已换（validate 原地重置）。
          if (myEpoch !== epoch || reads.get(id) !== rec || rec.token !== myToken) throwReadingChanged();
          mergeMessages(rec, page);
          if (from === 0 && to === 0 && rec.meta === null) rec.meta = page;
          return page;
        } catch (error) {
          if (/** @type {Error & {code?: string}} */ (error).code === 'reading_changed') {
            invalidateIfCurrent(rec, id, myEpoch, myToken);
          }
          throw error;
        }
      })();
      rec.pages.set(key, pending);
      pending.catch(() => { rec.pages.delete(key); });
    }
    return pending;
  }

  /** @param {number} id @returns {Promise<RequestRead>} */
  async function loadStructure(id) {
    const rec = recordOf(id);
    const state = rec.structure;
    if (state.loading || state.total !== null && state.next >= state.total) return assemble(rec);
    state.loading = true;
    state.error = null;
    try {
      const to = state.total === null ? state.next + 40 : Math.min(state.next + 40, state.total);
      const page = await readRange(id, state.next, to);
      const entries = messageEntries(page);
      const ords = new Set(state.ords);
      for (const entry of entries) ords.add(entry.ord);
      state.ords = [...ords].sort((a, b) => a - b);
      state.total = page.total;
      if (entries.length === 0 && page.total !== null && page.to < page.total) {
        // 空页且未到起点：next 不动，调用方按错误重试，不把空洞当已读。
        state.error = 'body_page_empty';
      } else {
        // 只有结构读取成功才推进 next：定点读与增量读不影响连续历史上界。
        state.next = Math.min(page.to, page.total ?? page.to);
      }
    } catch (error) {
      // 整笔已作废（409 路径）：结构失败不落在孤立记录上，交给调用方统一处理。
      if (/** @type {Error & {code?: string}} */ (error).code === 'reading_changed') throw error;
      state.error = error instanceof Error ? error.message : 'structure_failed';
    } finally {
      state.loading = false;
    }
    return assemble(rec);
  }

  /** @param {number} id @param {number} [pages] @returns {Promise<RequestRead>} */
  async function loadDelta(id, pages = 2) {
    const rec = recordOf(id);
    const state = rec.delta;
    if (rec.detail === null) return assemble(rec);
    const trusted = deltaOrdinals(rec.detail);
    if (trusted === null) {
      // 关系未确认：不标新增、不读消息，调用方展示关系状态。
      state.unconfirmed = true;
      state.done = true;
      return assemble(rec);
    }
    if (state.loading || state.done) return assemble(rec);
    const ords = [...trusted].sort((a, b) => a - b).slice(state.next);
    if (ords.length === 0) { state.done = true; return assemble(rec); }
    state.loading = true;
    state.error = null;
    try {
      let consumed = 0;
      // 每片跨度小于 40 的连续可信 delta 合成一片，每轮最多 pages 片。
      for (let piece = 0; piece < pages && consumed < ords.length;) {
        const start = ords[consumed] ?? 0;
        let end = consumed;
        while (end < ords.length && (ords[end] ?? 0) < start + 40) end += 1;
        const pieceEnd = (ords[end - 1] ?? start) + 1;
        const page = await readRange(id, start, pieceEnd);
        // 每片返回后验证所需 ord 都实际拿到：缺口不推进消费位置，不吞掉剩余输入。
        const gotOrds = new Set((page.messages ?? []).map((/** @type {{ord: number}} */ m) => m.ord));
        for (let o = start; o < pieceEnd; o += 1) {
          if (!gotOrds.has(o)) {
            // 缺口页不留在缓存：重试必须重新走网络，不能永远命中同一片坏页。
            rec.pages.delete(JSON.stringify([id, rec.token, start, pieceEnd]));
            const error = /** @type {Error & {code?: string}} */ (new Error('delta_gap'));
            error.code = 'delta_gap';
            throw error;
          }
        }
        // 只消费 delta 集合内的消息；额外读到的历史不推进消费。
        consumed = end;
        piece += 1;
      }
      state.next += consumed;
      if (state.next >= trusted.size) state.done = true;
    } catch (error) {
      // 整笔已作废（409 路径）：增量失败不落在孤立记录上，交给调用方统一处理。
      if (/** @type {Error & {code?: string}} */ (error).code === 'reading_changed') throw error;
      state.error = /** @type {Error & {code?: string}} */ (error).code === 'delta_gap' ? 'delta_gap'
        : error instanceof Error ? error.message : 'delta_failed';
    } finally {
      state.loading = false;
    }
    return assemble(rec);
  }

  /** @param {number} id @param {number} ord @returns {Promise<import('../src/reading').ToolResultReading>} */
  async function readToolResult(id, ord) {
    const rec = recordOf(id);
    if (rec.detail === null) await fetchDetail(rec, false);
    if (rec.detail === null) throw rec.detailError ?? new Error('detail_unavailable');
    const key = JSON.stringify([id, rec.token, ord]);
    let pending = rec.tools.get(key);
    if (pending === undefined) {
      const myEpoch = epoch;
      const myToken = rec.token;
      pending = (async () => {
        try {
          const reading = /** @type {import('../src/reading').ToolResultReading} */ (await getJson(`/api/requests/${id}/tools/${ord}/result?if_reading=${myToken}`));
          // 迟到响应：会话已切换、记录已作废重建，或版本已换（validate 原地重置）。
          if (myEpoch !== epoch || reads.get(id) !== rec || rec.token !== myToken) throwReadingChanged();
          return reading;
        } catch (error) {
          if (/** @type {Error & {code?: string}} */ (error).code === 'reading_changed') {
            invalidateIfCurrent(rec, id, myEpoch, myToken);
          }
          throw error;
        }
      })();
      rec.tools.set(key, pending);
      pending.catch(() => { rec.tools.delete(key); });
    }
    return pending;
  }

  /** @param {number} id @returns {Promise<unknown>} */
  async function readRoute(id) {
    let pending = routes.get(id);
    if (pending === undefined) {
      const myEpoch = epoch;
      pending = (async () => {
        const route = await getJson(`/api/requests/${id}/route`);
        // 迟到响应：会话已切换，或本任务已作废被新读取取代；成功路径同样核对身份。
        if (myEpoch !== epoch || routes.get(id) !== pending) throwReadingChanged();
        return route;
      })();
      routes.set(id, pending);
      pending.catch(() => { if (routes.get(id) === pending) routes.delete(id); });
    }
    return pending;
  }

  /** @param {number} id */
  function invalidate(id) {
    reads.delete(id);
    routes.delete(id);
  }

  return {
    getWindow: () => ({ sessionKey, requests: windowRows, olderCursor, loading: windowLoading, error: windowError }),
    getSessions: () => sessions,
    loadSessions,
    selectSession,
    loadEarlier,
    readRequest,
    readRange,
    loadStructure,
    loadDelta,
    readToolResult,
    readRoute,
    invalidate,
  };
}
