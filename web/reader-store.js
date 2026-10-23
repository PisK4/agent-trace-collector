import { deltaOrdinals, messageEntries } from './body-view.js';

/**
 * 生产阅读的读取协调：网络、区间缓存、inflight 去重、失效与异步代次都在这里，
 * 不进 DOM 闭包。正文与工具结果带阅读版本；409 整笔作废，下一次显式读取重建。
 * 迟到响应必须同时匹配会话代次与当前请求 token 才可写入缓存。
 *
 * 缓存边界：只保留当前会话已加载窗口的请求，外加显式读取过的窗口外请求
 * （工具结果的目标请求不装载整份历史，只保留该次读取）。
 */

/** 固定 4 并发的网络队列：失败在 finally 释放，不占住后续请求。 */
function createLanes(limit = 4) {
  const queue = [];
  let active = 0;
  const pump = () => {
    while (active < limit && queue.length > 0) {
      const next = queue.shift();
      active += 1;
      next.task().then(next.resolve, next.reject).finally(() => { active -= 1; pump(); });
    }
  };
  return task => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

export function createReaderStore(fetcher) {
  const lane = createLanes(4);
  let epoch = 0;

  const sessions = { items: [], cursor: null, error: null };
  let sessionKey = null;
  let windowRows = [];
  let olderCursor = null;
  let windowLoading = false;
  let windowError = null;

  /** @type {Map<number, Record<string, unknown>>} 请求读取缓存，按 canonical id 归属。 */
  const reads = new Map();
  /** @type {Map<number, unknown>} 路由只在用户展开时读取，单独缓存。 */
  const routes = new Map();

  const pageKey = (id, token, from, to) => JSON.stringify([id, token, from, to]);
  const resultKey = (owner, token, ord) => JSON.stringify([owner, token, ord]);

  async function getJson(url) {
    const response = await lane(() => fetcher(url));
    if (response.status === 409) {
      const error = new Error('reading_changed');
      error.code = 'reading_changed';
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`http_${response.status}`);
      error.code = response.status === 503 ? 'unavailable' : `http_${response.status}`;
      error.body = await response.json().catch(() => null);
      throw error;
    }
    return response.json();
  }

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

  const sortedEntries = rec => [...rec.messages.values()].sort((a, b) => a.ord - b.ord);

  function mergeMessages(rec, page) {
    for (const entry of messageEntries(page)) {
      if (!rec.messages.has(entry.ord)) rec.messages.set(entry.ord, entry);
    }
  }

  async function loadSessions(cursor) {
    try {
      const page = await getJson(`/api/sessions?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      sessions.items = cursor ? [...sessions.items, ...page.items] : page.items;
      sessions.cursor = page.next_cursor;
      sessions.error = null;
    } catch (error) {
      sessions.error = error.message;
    }
  }

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
      windowError = error.message;
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
      const page = await getJson(`/api/sessions/${encodeURIComponent(sessionKey)}/requests?direction=older&limit=${windowRows.length > 0 ? windowRows.length : 30}&cursor=${encodeURIComponent(olderCursor)}`);
      if (myEpoch !== epoch) return;
      // prepend + 去重 + 排序：失败保留旧 rows/cursor 由 catch 负责。
      const seen = new Set(windowRows.map(row => row.req_id));
      windowRows = [...page.items.filter(row => !seen.has(row.req_id)), ...windowRows]
        .sort((a, b) => a.started_ms - b.started_ms || a.req_id - b.req_id);
      olderCursor = page.next_cursor;
    } catch (error) {
      if (myEpoch !== epoch) return;
      windowError = error.message;
    } finally {
      if (myEpoch === epoch) windowLoading = false;
    }
  }

  async function fetchDetail(rec, validate) {
    if (rec.detail !== null && !validate) return;
    const myEpoch = epoch;
    try {
      const detail = await getJson(`/api/requests/${rec.id}`);
      if (myEpoch !== epoch) return;
      // validate 时 token 变化先清掉旧内容，避免新旧混拼。
      if (validate && rec.token !== null && detail.reading_token !== rec.token) {
        rec.pages.clear();
        rec.messages.clear();
        rec.structure = { open: false, next: 0, total: null, ords: [], selected: null, loading: false, error: null };
        rec.delta = { next: 0, done: false, loading: false, error: null, unconfirmed: false };
        rec.tools.clear();
        routes.delete(rec.id);
      }
      rec.detail = detail;
      rec.token = detail.reading_token;
      rec.detailError = null;
    } catch (error) {
      if (myEpoch !== epoch) return;
      if (error.code === 'reading_changed') { reads.delete(rec.id); throw error; }
      rec.detailError = error.message;
      throw error;
    }
  }

  async function readRequest(id, validate = false) {
    const rec = recordOf(id);
    await fetchDetail(rec, validate);
    if (rec.meta === null && rec.detail !== null) {
      // 首次 detail 后读 body 0/0 元信息；后续区间读取不覆盖 meta。
      const meta = await readRange(id, 0, 0);
      if (meta !== null) rec.meta = meta;
    }
    return assemble(rec);
  }

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

  async function readRange(id, from, to) {
    const rec = recordOf(id);
    if (rec.detail === null) await fetchDetail(rec, false);
    if (rec.detail === null) throw rec.detailError ?? new Error('detail_unavailable');
    const key = pageKey(id, rec.token, from, to);
    let pending = rec.pages.get(key);
    if (pending === undefined) {
      const myEpoch = epoch;
      const myToken = rec.token;
      pending = (async () => {
        const page = await getJson(`/api/requests/${id}/body?from=${from}&to=${to}&if_reading=${myToken}`);
        // 迟到响应：会话已切换，或请求已换版本（409 重建后 token 变了）。
        if (myEpoch !== epoch || reads.get(id)?.token !== myToken) {
          const error = new Error('reading_changed');
          error.code = 'reading_changed';
          throw error;
        }
        mergeMessages(rec, page);
        if (from === 0 && to === 0 && rec.meta === null) rec.meta = page;
        return page;
      })();
      rec.pages.set(key, pending);
      pending.catch(() => { rec.pages.delete(key); });
    }
    const page = await pending;
    return page;
  }

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
      state.error = error.code === 'reading_changed' ? 'reading_changed' : error.message;
    } finally {
      state.loading = false;
    }
    return assemble(rec);
  }

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
        const start = ords[consumed];
        let end = consumed;
        while (end < ords.length && ords[end] < start + 40) end += 1;
        const page = await readRange(id, start, ords[end - 1] + 1);
        // 只消费 delta 集合内的消息；额外读到的历史不推进消费。
        consumed = end;
        piece += 1;
      }
      state.next += consumed;
      if (state.next >= trusted.size) state.done = true;
    } catch (error) {
      state.error = error.code === 'reading_changed' ? 'reading_changed' : error.message;
    } finally {
      state.loading = false;
    }
    return assemble(rec);
  }

  async function readToolResult(id, ord) {
    const rec = recordOf(id);
    if (rec.detail === null) await fetchDetail(rec, false);
    if (rec.detail === null) throw rec.detailError ?? new Error('detail_unavailable');
    const key = resultKey(id, rec.token, ord);
    let pending = rec.tools.get(key);
    if (pending === undefined) {
      const myEpoch = epoch;
      const myToken = rec.token;
      pending = (async () => {
        const reading = await getJson(`/api/requests/${id}/tools/${ord}/result?if_reading=${myToken}`);
        if (myEpoch !== epoch || reads.get(id)?.token !== myToken) {
          const error = new Error('reading_changed');
          error.code = 'reading_changed';
          throw error;
        }
        return reading;
      })();
      rec.tools.set(key, pending);
      pending.catch(() => { rec.tools.delete(key); });
    }
    return pending;
  }

  async function readRoute(id) {
    let pending = routes.get(id);
    if (pending === undefined) {
      const myEpoch = epoch;
      pending = (async () => {
        const route = await getJson(`/api/requests/${id}/route`);
        if (myEpoch !== epoch) {
          const error = new Error('reading_changed');
          error.code = 'reading_changed';
          throw error;
        }
        return route;
      })();
      routes.set(id, pending);
      pending.catch(() => { routes.delete(id); });
    }
    return pending;
  }

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
