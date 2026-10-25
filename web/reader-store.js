// @ts-check
import { deltaOrdinals, messageEntries } from './body-view.js';

/**
 * 生产阅读的读取协调：网络、区间缓存、inflight 去重、失效与异步代次都在这里，
 * 不进 DOM 闭包。正文与工具结果带阅读版本；409 整笔作废（详情、meta、消息、
 * 区间、结构、增量、工具与路由一起），作废是记录原地重置并保留作废态：原因经
 * 快照 status 同步可查，store 随即自动重读换新（同一笔有冷却窗口，防派生高频
 * 发布时打转），换新后置 updatedSinceSeen，页面交互清除；手动「立即重读」随时
 * 可发起。token 变化的 validate 读取同样原地重置整笔快照。迟到响应必须同时
 * 匹配会话代次、当前记录归属、记录修订与捕获的 token 才可写入缓存；迟到响应
 * 与会话切换后的旧回调不作废、不通知，页面不按 reading_changed 错误自行清理。
 *
 * 缓存边界：只保留当前会话已加载窗口的请求，外加显式读取过的窗口外请求。
 */

/**
 * @typedef {Object} RequestRead 一次请求的读取快照。
 * @property {'reading'|'fresh'|'invalidated'|'failed'} status 快照生命周期：详情在手为 fresh，作废待重读为 invalidated，详情读取失败为 failed，其余 reading。只描述 detail/meta/token 层，结构、增量与逐工具的局部状态不进 status。
 * @property {string | null} detailError 详情读取失败原因；仅 failed 态非空。
 * @property {boolean} updatedSinceSeen 自动重读换新后置位；页面交互经 clearUpdated 清除。
 * @property {import('../src/queries').RequestDetail | null} detail
 * @property {import('../src/protocols').BodyPage | null} meta
 * @property {Map<number, ReturnType<typeof messageEntries>[number]>} messages
 * @property {ReturnType<typeof messageEntries>} entries
 * @property {{next: number, total: number | null, ords: number[], loading: boolean, error: string | null}} structure
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
 * @property {(id: number) => RequestRead | null} peekRequest 同步读取当前快照，不发网络；记录存在即返回（含作废、失败与读取中的半成品），null 只表示本会话没有这笔记录。
 * @property {(id: number, ord: number) => import('../src/reading').ToolResultReading | null} peekToolResult 同步读取工具结果缓存，失败占位也算可用。
 * @property {(id: number) => {state: string, summary: unknown} | null} peekRoute 同步读取路由缓存；未读到或读取失败返回 null。
 * @property {() => {status: 'idle' | 'loading' | 'ready' | 'absent', items: import('../src/queries').TurnPairRow[]}} peekTurns 同步读取轮次快照；absent 覆盖 404、读取失败与无窗口三种不可呈现态。
 * @property {() => Promise<void>} loadTurns 按当前会话与窗口下界取轮次列表；换窗后的重取排在前一次之后。
 * @property {() => {status: 'idle' | 'loading' | 'ready' | 'absent', data: import('../src/queries').SessionSummary | null}} peekSummary 同步读取会话汇总快照；absent 覆盖 404、读取失败与无会话三种不可呈现态。
 * @property {(key: string) => Promise<void>} loadSummary 打开会话即拉一次汇总，不懒加载；换会话代次变更后迟到响应不写入。
 * @property {(query: import('../src/queries').SummaryEntriesQuery) => Promise<import('../src/queries').SummaryEntries>} loadSummaryEntries 汇总条目点击后的按组查询；无缓存，每次点击现查。
 * @property {(id: number) => void} clearUpdated 清除自动重读的「已更新」标记。
 * @property {(id: number) => void} invalidate 原地清空一笔记录的缓存并落作废态；不通知、不排自动重读，测试与强制失效用。
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
 * @param {(id: number) => void} [onReadChanged] 记录快照异步变化（作废、自动重读
 *   换新或失败）时通知页面重绘；迟到响应与会话切换后的旧任务不通知。
 * @param {{ autoRereadCooldownMs?: number, onTurnsChanged?: () => void, onSummaryChanged?: () => void }} [options]
 *   自动重读的冷却窗口，默认 10 秒；轮次快照与会话汇总落地（ready 或 absent）时通知，测试可注入短窗。
 * @returns {ReaderStore}
 */
export function createReaderStore(fetcher, onReadChanged, options) {
  const autoRereadCooldownMs = options?.autoRereadCooldownMs ?? 10000;
  const onTurnsChanged = options?.onTurnsChanged ?? null;
  const onSummaryChanged = options?.onSummaryChanged ?? null;
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
  /** @type {{status: 'idle' | 'loading' | 'ready' | 'absent', items: import('../src/queries').TurnPairRow[]}} */
  let turns = { status: 'idle', items: [] };
  /** @type {Promise<void> | null} 轮次读取串行化：加载更早触发的重取排在前一次之后，后到先得。 */
  let turnsInflight = null;
  /** @type {{status: 'idle' | 'loading' | 'ready' | 'absent', data: import('../src/queries').SessionSummary | null}} */
  let summary = { status: 'idle', data: null };

  /**
   * 请求读取缓存，按 canonical id 归属。rec 的字段在运行期由各读取路径填充，
   * 结构与 RequestRead 对齐（messages 以 ord 为键保存解释后的消息）。
   * @type {Map<number, any>}
   */
  const reads = new Map();
  /** @type {Map<number, Promise<unknown>>} 路由只在用户展开时读取，单独缓存。 */
  const routes = new Map();
  /** @type {Map<number, {state: string, summary: unknown}>} 路由完成值，供同步读取。 */
  const routeValues = new Map();

  /** @param {number} id */
  function recordOf(id) {
    let rec = reads.get(id);
    if (rec === undefined) {
      rec = {
        id, token: null,
        detail: null, detailError: null,
        /** 快照生命周期；作废态由 invalidateRecord 落位。 */
        status: 'reading',
        /** 记录修订：作废时自增，迟到详情响应凭它不得写入已重置的记录。 */
        rev: 0,
        /** 自动重读换新后置位；页面交互经 clearUpdated 清除。 */
        updatedSinceSeen: false,
        /** 上次自动重读发起时间与在排的定时器。 */
        autoRereadAt: 0, autoTimer: null,
        meta: null,
        pages: new Map(),
        messages: new Map(),
        structure: { next: 0, total: null, ords: [], loading: false, error: null },
        delta: { next: 0, done: false, loading: false, error: null, unconfirmed: false },
        tools: new Map(),
        /** @type {Map<string, import('../src/reading').ToolResultReading>} 成功值与失败占位，键同 tools。 */
        toolValues: new Map(),
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

  /** @param {any} rec 清空正文缓存：作废与 validate 换版本共用的原地重置。 */
  function clearRecordContent(rec) {
    rec.token = null;
    rec.detail = null;
    rec.detailError = null;
    rec.meta = null;
    rec.pages = new Map();
    rec.messages = new Map();
    rec.structure = { next: 0, total: null, ords: [], loading: false, error: null };
    rec.delta = { next: 0, done: false, loading: false, error: null, unconfirmed: false };
    rec.tools = new Map();
    rec.toolValues = new Map();
    routes.delete(rec.id);
    routeValues.delete(rec.id);
  }

  /**
   * 整笔作废：清正文缓存但保留记录，作废态经快照 status 同步可查；
   * 修订自增，让迟到的详情响应无法写入已重置的记录。
   * @param {any} rec
   */
  function invalidateRecord(rec) {
    if (rec.autoTimer !== null) { clearTimeout(rec.autoTimer); rec.autoTimer = null; }
    clearRecordContent(rec);
    rec.status = 'invalidated';
    rec.rev += 1;
  }

  /**
   * 作废即自动重读：同一笔在冷却窗口内不重复发起（窗口内再次作废顺延到期），
   * 会话已切换或记录已被取代、重建时放弃；不设尝试上限，派生停发后自然收敛。
   * 深度与手动重读一致：详情 + 元信息，再补最多两片可信增量。
   * @param {any} rec
   */
  function scheduleAutoReread(rec) {
    if (rec.autoTimer !== null) return;
    const wait = Math.max(0, rec.autoRereadAt + autoRereadCooldownMs - Date.now());
    rec.autoTimer = setTimeout(() => {
      rec.autoTimer = null;
      if (reads.get(rec.id) !== rec || rec.status !== 'invalidated') return;
      rec.autoRereadAt = Date.now();
      void (async () => {
        try {
          await readRequest(rec.id);
        } catch { /* 重读失败：failed 态如实可见，由用户或批次重试 */ }
        if (reads.get(rec.id) === rec && rec.status === 'fresh') rec.updatedSinceSeen = true;
        onReadChanged?.(rec.id);
        if (reads.get(rec.id) === rec && rec.detail !== null && !rec.delta.done) {
          try { await loadDelta(rec.id, 2); } catch { /* 增量失败保留事件行，可再续读 */ }
          onReadChanged?.(rec.id);
        }
      })();
    }, wait);
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

  /**
   * 按当前会话与窗口下界取轮次列表。结算单位是累计窗口：下界取已加载窗口的
   * 最早请求，服务端只返回起点在下界之后的轮。404（后端未部署）与读取失败都
   * 落 absent——带不渲染、不占位、不留错误态，下次触发（选会话、刷新、加载更早）重取。
   * 换会话代次变更后，迟到响应不写入。
   */
  async function loadTurns() {
    if (turnsInflight !== null) await turnsInflight.catch(() => {});
    const myEpoch = epoch;
    const key = sessionKey;
    const rows = windowRows;
    if (key === null || rows.length === 0) {
      turns = { status: 'absent', items: [] };
      onTurnsChanged?.();
      return;
    }
    const from = Math.min(...rows.map(row => row.req_id));
    const task = (async () => {
      turns = { status: 'loading', items: turns.items };
      try {
        const page = /** @type {import('../src/queries').TurnsPage} */ (
          await getJson(`/api/sessions/${encodeURIComponent(key)}/turns?from=${from}`));
        if (myEpoch !== epoch) return;
        turns = { status: 'ready', items: page.items };
      } catch {
        if (myEpoch !== epoch) return;
        turns = { status: 'absent', items: [] };
      } finally {
        if (myEpoch === epoch) onTurnsChanged?.();
      }
    })();
    turnsInflight = task;
    try { await task; } finally { if (turnsInflight === task) turnsInflight = null; }
  }

  /**
   * 打开会话即拉一次汇总：session-head 的合计行与折叠区都吃这份快照。
   * 404（后端未部署）与读取失败都落 absent——合计行回退窗口口径、折叠区不渲染，
   * 下次触发（选会话、刷新）重取。换会话代次变更后，迟到响应不写入。
   * @param {string} key
   */
  async function loadSummary(key) {
    const myEpoch = epoch;
    summary = { status: 'loading', data: null };
    onSummaryChanged?.();
    try {
      const data = /** @type {import('../src/queries').SessionSummary} */ (
        await getJson(`/api/sessions/${encodeURIComponent(key)}/summary`));
      if (myEpoch !== epoch) return;
      summary = { status: 'ready', data };
    } catch {
      if (myEpoch !== epoch) return;
      summary = { status: 'absent', data: null };
    } finally {
      if (myEpoch === epoch) onSummaryChanged?.();
    }
  }

  /** @param {import('../src/queries').SummaryEntriesQuery} query */
  async function loadSummaryEntries(query) {
    const params = new URLSearchParams({ kind: query.kind });
    if (query.kind === 'tool' || query.kind === 'skill') params.set('name', query.name);
    if (query.kind === 'written' || query.kind === 'read') params.set('path', query.path);
    const data = await getJson(`/api/sessions/${encodeURIComponent(String(sessionKey))}/summary/entries?${params.toString()}`);
    return /** @type {import('../src/queries').SummaryEntries} */ (data);
  }

  /** @param {string} key @param {number} limit */
  async function selectSession(key, limit = 30) {
    const myEpoch = ++epoch;
    sessionKey = key;
    windowLoading = true;
    windowError = null;
    turns = { status: 'idle', items: [] };
    summary = { status: 'idle', data: null };
    reads.clear();
    routes.clear();
    routeValues.clear();
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
      if (myEpoch === epoch) {
        windowLoading = false;
        void loadTurns();
        void loadSummary(key);
      }
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
      // 窗口下界前移：按新的累计范围重取轮次，更早的轮补进带里。
      void loadTurns();
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
      invalidateRecord(rec);
      onReadChanged?.(id);
      scheduleAutoReread(rec);
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
    const myRev = rec.rev;
    /** @type {Promise<void>} */
    const task = (async () => {
      const detail = await getJson(`/api/requests/${rec.id}`);
      // 迟到响应：会话已切换、记录已作废重置或被取代。
      if (myEpoch !== epoch || reads.get(rec.id) !== rec || rec.rev !== myRev) throwReadingChanged();
      if (validate && rec.token !== null && detail.reading_token !== rec.token) {
        // token 变化：消息、区间、结构、增量、工具、元信息与路由全部重置，避免新旧混拼。
        clearRecordContent(rec);
        onReadChanged?.(rec.id);
      }
      rec.detail = detail;
      rec.token = detail.reading_token;
      rec.detailError = null;
      rec.status = 'fresh';
    })();
    rec.detailInflight = task;
    try {
      await task;
    } catch (error) {
      if (/** @type {Error & {code?: string}} */ (error).code === 'reading_changed') {
        // 服务端 409：整笔作废并排自动重读；迟到响应（修订或代次已变）由作废方负责，不重复处理。
        if (reads.get(rec.id) === rec && rec.status !== 'invalidated') {
          invalidateRecord(rec);
          onReadChanged?.(rec.id);
          scheduleAutoReread(rec);
        }
        throw error;
      }
      rec.detailError = error instanceof Error ? error.message : 'detail_failed';
      rec.status = 'failed';
      throw error;
    } finally {
      if (rec.detailInflight === task) rec.detailInflight = undefined;
    }
  }

  /** @param {any} rec @returns {RequestRead} */
  function assemble(rec) {
    return {
      status: rec.status,
      detailError: rec.detailError,
      updatedSinceSeen: rec.updatedSinceSeen,
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
          rec.toolValues.set(key, reading);
          return reading;
        } catch (error) {
          if (/** @type {Error & {code?: string}} */ (error).code === 'reading_changed') {
            invalidateIfCurrent(rec, id, myEpoch, myToken);
            throw error;
          }
          // 普通失败登记不可读占位：同步渲染显示失败态，重试仍由调用方显式发起。
          rec.toolValues.set(key, {
            owner_req: id, call_ord: ord, reading_token: '',
            state: 'unavailable', target: null, content: null, is_error: null,
            reason: error instanceof Error ? error.message : 'read_failed',
          });
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
        routeValues.set(id, /** @type {{state: string, summary: unknown}} */ (route));
        return route;
      })();
      routes.set(id, pending);
      pending.catch(() => { if (routes.get(id) === pending) routes.delete(id); });
    }
    return pending;
  }

  /** @param {number} id @returns {RequestRead | null} 记录存在即返回快照（含作废、失败与读取中）；null 只表示本会话没有这笔记录。 */
  function peekRequest(id) {
    const rec = reads.get(id);
    if (rec === undefined) return null;
    return assemble(rec);
  }

  /** @param {number} id @param {number} ord @returns {import('../src/reading').ToolResultReading | null} */
  function peekToolResult(id, ord) {
    const rec = reads.get(id);
    if (rec === undefined || rec.detail === null) return null;
    return rec.toolValues.get(JSON.stringify([id, rec.token, ord])) ?? null;
  }

  /** @param {number} id @returns {{state: string, summary: unknown} | null} */
  function peekRoute(id) {
    return routeValues.get(id) ?? null;
  }

  /** @returns {{status: 'idle' | 'loading' | 'ready' | 'absent', items: import('../src/queries').TurnPairRow[]}} */
  function peekTurns() {
    return turns;
  }

  /** @returns {{status: 'idle' | 'loading' | 'ready' | 'absent', data: import('../src/queries').SessionSummary | null}} */
  function peekSummary() {
    return summary;
  }

  /** @param {number} id 页面交互清除自动重读的「已更新」标记。 */
  function clearUpdated(id) {
    const rec = reads.get(id);
    if (rec !== undefined) rec.updatedSinceSeen = false;
  }

  /** @param {number} id 原地清空缓存并落作废态；不通知、不排自动重读，测试与强制失效用。 */
  function invalidate(id) {
    const rec = reads.get(id);
    if (rec !== undefined) invalidateRecord(rec);
    routes.delete(id);
    routeValues.delete(id);
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
    peekRequest,
    peekToolResult,
    peekRoute,
    peekTurns,
    loadTurns,
    peekSummary,
    loadSummary,
    loadSummaryEntries,
    clearUpdated,
    invalidate,
  };
}
