// @ts-check
import { deltaOrdinals, deltaPieces, messageEntries } from './body-model.js';
import { createReadScheduler } from './read-scheduler.js';

/**
 * 生产阅读的读取协调：调度、区间缓存、inflight 去重、失效与异步代次都在这里，
 * 不进 DOM 闭包。全部读取经 ReadTransport（Task 1 契约）走内部有界调度器，
 * 分页级与会话级两个取消边界：切换或离开会话即取消该会话的全部在途与待发
 * 读取，页面卸载取消全部。正文与工具结果带阅读版本；409 整笔作废（详情、
 * meta、消息、区间、结构、增量、工具与路由一起），作废是记录原地重置并保留
 * 作废态：原因经快照 status 同步可查，store 随即自动重读换新（同一笔有冷却
 * 窗口，防派生高频发布时打转）；手动「立即重读」随时可发起。token 变化的
 * validate 读取同样原地重置整笔快照。迟到响应必须同时匹配会话代次、当前
 * 记录归属、记录修订与捕获的 token 才可写入缓存；迟到响应与会话切换后的旧
 * 回调不作废、不通知，页面不按 reading_changed 错误自行清理。
 *
 * 缓存边界：只保留当前会话已加载窗口的请求，外加显式读取过的窗口外请求。
 */

/**
 * @typedef {Object} RequestRead 一次请求的读取快照。
 * @property {'reading'|'fresh'|'invalidated'|'failed'} status 快照生命周期：详情在手为 fresh，作废待重读为 invalidated，详情读取失败为 failed，其余 reading。只描述 detail/meta/token 层，结构、增量与逐工具的局部状态不进 status。
 * @property {string | null} detailError 详情读取失败原因；仅 failed 态非空。
 * @property {import('../src/queries/requests').RequestDetail | null} detail
 * @property {import('../src/protocols').BodyPage | null} meta
 * @property {Map<number, ReturnType<typeof messageEntries>[number]>} messages
 * @property {ReturnType<typeof messageEntries>} entries
 * @property {{back: number, next: number, total: number | null, ords: number[], loading: boolean, error: string | null}} structure 已读结构窗口：`[back, next)` 连续，首读尾片。
 * @property {{next: number, done: boolean, loading: boolean, error: string | null, unconfirmed: boolean}} delta
 * @property {string | null} token
 */

/**
 * @typedef {Object} ReaderStore
 * @property {() => {sessionKey: string | null, requests: import('../src/queries/projection').RequestRow[], newerCursor: string | null, loading: boolean, error: string | null}} getWindow
 * @property {() => {items: import('../src/queries/sessions').SessionRow[], cursor: string | null, error: string | null}} getSessions
 * @property {(cursor?: string) => Promise<void>} loadSessions
 * @property {(key: string, limit?: number, anchor?: 'start' | 'latest') => Promise<void>} selectSession
 * @property {() => Promise<void>} loadLater
 * @property {() => void} leaveSession 离开当前会话：取消该会话的全部在途与待发读取，清窗口与请求级缓存；迟到的会话读取不能复活任何窗口内容。
 * @property {() => void} dispose 页面卸载：取消全部读取并停止调度；之后的读取以 cancelled 拒绝。
 * @property {() => Promise<import('../src/queries/stats').Stats>} loadStats 后端状态与统计；顶栏降级标签与调试图共用。
 * @property {(id: number, validate?: boolean) => Promise<RequestRead>} readRequest
 * @property {(ids: number[]) => Promise<RequestRead[]>} readRequests 批量读取：readings 批次逐项合入，重复 id 去重，结果按调用顺序返回；批级传输失败拒绝整个调用，逐项失败写各自状态并保留成功项。
 * @property {(id: number, from: number, to: number) => Promise<import('../src/protocols').BodyPage>} readRange
 * @property {(id: number) => Promise<RequestRead>} loadStructure
 * @property {(id: number, pages?: number) => Promise<RequestRead>} loadDelta
 * @property {(ids: number[], pages?: number) => Promise<void>} loadDeltas 批量增量准备：跨请求打包 bodyRanges 批，逐请求核对后推进各自计数；在跑的 id 不重复推进。
 * @property {(id: number, ord: number) => Promise<import('../src/reading').ToolResultReading>} readToolResult
 * @property {(id: number) => Promise<unknown>} readRoute
 * @property {(id: number, query: import('../src/reading').ContextItemQuery, token: string, signal: AbortSignal) => Promise<import('../src/reading').ContextItemReading>} readContextItem 弹窗目录读取；signal 绑定弹窗生命周期，不进全局正文缓存。
 * @property {(target: import('../src/read-contract').ContextBodyTarget, signal: AbortSignal) => Promise<import('../src/protocols').BodyPage | import('../src/reading').ToolResultReading>} readContextBody 弹窗片段正文读取；按 ContextBodyTarget 分流到正文区间与工具结果。
 * @property {(id: number) => RequestRead | null} peekRequest 同步读取当前快照，不发网络；记录存在即返回（含作废、失败与读取中的半成品），null 只表示本会话没有这笔记录。
 * @property {(id: number, ord: number) => import('../src/reading').ToolResultReading | null} peekToolResult 同步读取工具结果缓存，失败占位也算可用。
 * @property {(id: number) => {state: string, summary: unknown} | null} peekRoute 同步读取路由缓存；未读到或读取失败返回 null。
 * @property {() => {status: 'idle' | 'loading' | 'ready' | 'absent', items: import('../src/queries/turns').TurnPairRow[]}} peekTurns 同步读取轮次快照；absent 覆盖 404、读取失败与无窗口三种不可呈现态。
 * @property {() => Promise<void>} loadTurns 按当前会话与窗口下界取轮次列表；换窗后的重取排在前一次之后。
 * @property {() => {status: 'idle' | 'loading' | 'ready' | 'absent', items: import('../src/queries/bg-jobs').BgJobRow[]}} peekBgJobs 同步读取背景作业配对快照；absent 覆盖 404、读取失败与无会话。
 * @property {() => Promise<void>} loadBgJobs 按当前会话取 bg_job 结算行；选会话与刷新时重取。
 * @property {() => {status: 'idle' | 'loading' | 'ready' | 'absent', data: import('../src/queries/session-summary').SessionSummary | null}} peekSummary 同步读取会话汇总快照；absent 覆盖 404、读取失败与无会话三种不可呈现态。
 * @property {(key: string) => Promise<void>} loadSummary 打开会话即拉一次汇总，不懒加载；换会话代次变更后迟到响应不写入。
 * @property {(query: import('../src/queries/session-summary').SummaryEntriesQuery) => Promise<import('../src/queries/session-summary').SummaryEntries>} loadSummaryEntries 汇总条目点击后的按组查询；无缓存，每次点击现查。
 * @property {(id: number) => void} invalidate 原地清空一笔记录的缓存并落作废态；不通知、不排自动重读，测试与强制失效用。
 * @property {() => number} batchFallbackCount 批响应 oversized 项回退单项路径的累计次数，验收观察用。
 */

/**
 * @param {import('../src/read-contract').ReadTransport} transport 具名读取的唯一执行通道；store 不拼 URL、不 Fetch。
 * @param {(id: number) => void} [onReadChanged] 记录快照异步变化（作废、自动重读
 *   换新或失败）时通知页面重绘；迟到响应与会话切换后的旧任务不通知。
 * @param {{ autoRereadCooldownMs?: number, scheduler?: object, onTurnsChanged?: () => void, onSummaryChanged?: () => void }} [options]
 *   自动重读的冷却窗口，默认 10 秒；scheduler 透传给内部有界调度器；轮次快照与会话
 *   汇总落地（ready 或 absent）时通知，测试可注入短窗。
 * @returns {ReaderStore}
 */
export function createReaderStore(transport, onReadChanged, options) {
  const autoRereadCooldownMs = options?.autoRereadCooldownMs ?? 10000;
  const onTurnsChanged = options?.onTurnsChanged ?? null;
  const onSummaryChanged = options?.onSummaryChanged ?? null;
  const scheduler = createReadScheduler(options?.scheduler);
  /** 页面级读取（会话列表、统计）的取消边界；dispose 时一并取消。 */
  let pageScope = {};
  /** 会话级读取的取消边界：切换与离开会话即换新，旧会话的在途与待发一并取消。 */
  let sessionScope = {};
  let epoch = 0;

  /**
   * 读取执行的唯一入口：transport.execute 连同响应解析在调度槽内完成。
   * 操作与输入按调用点逐一对应；此处不还原每操作的输入形状，unknown 以
   * never 收窄交给 transport 校验。
   * @template T
   * @param {object} scope @param {keyof import('../src/read-contract').ReadOperations} operation
   * @param {unknown} input @param {AbortSignal} [signal]
   * @returns {Promise<T>}
   */
  function execute(scope, operation, input, signal) {
    return /** @type {Promise<T>} */ (
      scheduler.run({ scope, priority: 'interactive', signal },
        taskSignal => /** @type {Promise<unknown>} */ (
          transport.execute(operation, /** @type {never} */ (input), { signal: taskSignal }))));
  }

  /** 弹窗读取的 scope：同一 AbortSignal（同一弹窗生命周期）复用一个 scope。 */
  const dialogScopes = new WeakMap();
  /** @param {AbortSignal} signal @returns {object} */
  function dialogScopeOf(signal) {
    let scope = dialogScopes.get(signal);
    if (scope === undefined) {
      scope = {};
      dialogScopes.set(signal, scope);
    }
    return scope;
  }

  /** @type {{items: import('../src/queries/sessions').SessionRow[], cursor: string | null, error: string | null}} */
  const sessions = { items: [], cursor: null, error: null };
  /** @type {boolean} 会话列表请求在跑：同 tick 的重复点击共用一次请求。 */
  let sessionsLoading = false;
  /** @type {string | null} */
  let sessionKey = null;
  /** @type {import('../src/queries/projection').RequestRow[]} */
  let windowRows = [];
  /** @type {string | null} 后续记录游标：耗尽表示窗口已覆盖到会话最新一笔。 */
  let newerCursor = null;
  let windowLoading = false;
  /** @type {string | null} */
  let windowError = null;
  /** @type {{status: 'idle' | 'loading' | 'ready' | 'absent', items: import('../src/queries/turns').TurnPairRow[]}} */
  let turns = { status: 'idle', items: [] };
  /** @type {Promise<void> | null} 轮次读取串行化：换窗触发的重取排在前一次之后，后到先得。 */
  let turnsInflight = null;
  /** @type {{status: 'idle' | 'loading' | 'ready' | 'absent', items: import('../src/queries/bg-jobs').BgJobRow[]}} */
  let bgJobs = { status: 'idle', items: [] };
  /** @type {{status: 'idle' | 'loading' | 'ready' | 'absent', data: import('../src/queries/session-summary').SessionSummary | null}} */
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
  /** @type {Map<number, Promise<unknown>>} 增量消费者的在跑任务：同一记录同一时刻只推进一条序列。 */
  const deltaInflight = new Map();
  /** @type {Map<number, Promise<RequestRead>>} readings 批覆盖中的记录：单项消费者等待该批视图，不另发 detail。 */
  const batchInflight = new Map();
  /** 批响应 oversized 项回退单项路径的累计次数：验收观察回退是否极少触发。 */
  let batchFallbackCount = 0;

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
        /** 上次自动重读发起时间与在排的定时器。 */
        autoRereadAt: 0, autoTimer: null,
        meta: null,
        /** @type {Map<string, import('../src/protocols').BodyPage>} 区间完成值：命中即返回，不发网。 */
        pageValues: new Map(),
        /** @type {Map<string, Promise<import('../src/protocols').BodyPage>>} 区间在途登记：去重与失败清理由各任务自己做。 */
        pageInflight: new Map(),
        messages: new Map(),
        structure: { back: 0, next: 0, total: null, ords: [], loading: false, error: null },
        delta: { next: 0, done: false, loading: false, error: null, unconfirmed: false },
        tools: new Map(),
        /** @type {Map<string, import('../src/reading').ToolResultReading>} 成功值与失败占位，键同 tools。 */
        toolValues: new Map(),
      };
      reads.set(id, rec);
    }
    return rec;
  }

  /** 会话级缓存的统一清理：先撤自动重读定时器，再清各登记。 */
  function clearReadsCache() {
    for (const rec of reads.values()) {
      if (rec.autoTimer !== null) { clearTimeout(rec.autoTimer); rec.autoTimer = null; }
    }
    reads.clear();
    deltaInflight.clear();
    batchInflight.clear();
    routes.clear();
    routeValues.clear();
  }

  /** @param {any} rec */
  const sortedEntries = rec => [...rec.messages.values()].sort((/** @type {{ord: number}} */ a, /** @type {{ord: number}} */ b) => a.ord - b.ord);

  /** @param {any} rec @param {import('../src/protocols').BodyPage} page */
  function mergeMessages(rec, page) {
    for (const entry of messageEntries(page)) {
      if (!rec.messages.has(entry.ord)) rec.messages.set(entry.ord, entry);
    }
  }

  /** @param {any} rec @param {string} key 缺口页移出缓存：完成值与在途登记一起删，重试重新走网络。 */
  function dropPage(rec, key) {
    rec.pageValues.delete(key);
    rec.pageInflight.delete(key);
  }

  /** @param {any} rec 清空正文缓存：作废与 validate 换版本共用的原地重置。 */
  function clearRecordContent(rec) {
    deltaInflight.delete(rec.id);
    rec.token = null;
    rec.detail = null;
    rec.detailError = null;
    rec.meta = null;
    rec.pageValues = new Map();
    rec.pageInflight = new Map();
    rec.messages = new Map();
    rec.structure = { back: 0, next: 0, total: null, ords: [], loading: false, error: null };
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
        if (reads.get(rec.id) !== rec) return;
        onReadChanged?.(rec.id);
        if (rec.detail !== null && !rec.delta.done) {
          try { await loadDelta(rec.id, 2); } catch { /* 增量失败保留事件行，可再续读 */ }
          if (reads.get(rec.id) === rec) onReadChanged?.(rec.id);
        }
      })();
    }, wait);
  }

  /** @param {string | undefined} cursor */
  async function loadSessions(cursor) {
    if (sessionsLoading) return;
    sessionsLoading = true;
    try {
      const page = await execute(pageScope, 'sessions', { limit: 20, cursor: cursor ?? null });
      // 同 tick 的两次点击已经由上面的闸门挡住；分页边界仍可能把同一会话
      // 返回两次（末条时间相同），按 conv_key 去重，保留先出现的一条。
      /** @type {Map<string, import('../src/queries/sessions').SessionRow>} */
      const seen = new Map();
      for (const item of [...(cursor ? sessions.items : []), ...page.items]) {
        if (!seen.has(item.conv_key)) seen.set(item.conv_key, item);
      }
      sessions.items = [...seen.values()];
      sessions.cursor = page.next_cursor;
      sessions.error = null;
    } catch (error) {
      sessions.error = error instanceof Error ? error.message : 'load_failed';
    } finally {
      sessionsLoading = false;
    }
  }

  /** 后端状态与统计：顶栏降级标签与调试图共用一次读取，不做轮询。 */
  function loadStats() {
    return /** @type {Promise<import('../src/queries/stats').Stats>} */ (
      execute(pageScope, 'stats', {}));
  }

  /**
   * 按当前会话与窗口下界取轮次列表。结算单位是累计窗口：下界取已加载窗口的
   * 最早请求，服务端只返回起点在下界之后的轮。404（后端未部署）与读取失败都
   * 落 absent——带不渲染、不占位、不留错误态，下次触发（选会话、刷新、换窗）重取。
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
        const page = await execute(sessionScope, 'turns', { key, from });
        if (myEpoch !== epoch) return;
        turns = { status: 'ready', items: page.items };
      } catch (error) {
        if (myEpoch !== epoch) return;
        // 取消不落 absent：页面卸载与会话切换都走这里，状态留给新的生命周期。
        if (/** @type {Error & {code?: string}} */ (error).code === 'cancelled') return;
        turns = { status: 'absent', items: [] };
      } finally {
        if (myEpoch === epoch) onTurnsChanged?.();
      }
    })();
    turnsInflight = task;
    try { await task; } finally { if (turnsInflight === task) turnsInflight = null; }
  }

  /**
   * 取当前会话的背景作业配对。bg_job 是派生结算表、会话级口径，不随窗口下界
   * 变化：选会话与刷新各拉一次即可。404（后端未部署）与读取失败落 absent，
   * 轨迹就不画配对标注，下次触发重取。
   */
  async function loadBgJobs() {
    const myEpoch = epoch;
    const key = sessionKey;
    if (key === null) {
      bgJobs = { status: 'absent', items: [] };
      return;
    }
    try {
      const items = await execute(sessionScope, 'bgJobs', { key });
      if (myEpoch !== epoch) return;
      bgJobs = { status: 'ready', items };
    } catch (error) {
      if (myEpoch !== epoch) return;
      if (/** @type {Error & {code?: string}} */ (error).code === 'cancelled') return;
      bgJobs = { status: 'absent', items: [] };
    }
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
      const data = await execute(sessionScope, 'summary', { key });
      if (myEpoch !== epoch) return;
      summary = { status: 'ready', data };
    } catch (error) {
      if (myEpoch !== epoch) return;
      if (/** @type {Error & {code?: string}} */ (error).code === 'cancelled') return;
      summary = { status: 'absent', data: null };
    } finally {
      if (myEpoch === epoch) onSummaryChanged?.();
    }
  }

  /** @param {import('../src/queries/session-summary').SummaryEntriesQuery} query */
  async function loadSummaryEntries(query) {
    return execute(sessionScope, 'summaryEntries',
      { key: String(sessionKey), query });
  }

  /**
   * 离开当前会话：先推进代次，再取消会话级读取并清窗口与全部请求级缓存。
   * 迟到的会话读取即便忽略取消返回，也不能复活任何窗口内容——缓存已清空，
   * 回写守卫的代次校验拒绝写入。
   */
  function leaveSession() {
    epoch += 1;
    scheduler.cancelScope(sessionScope);
    sessionScope = {};
    sessionKey = null;
    windowRows = [];
    newerCursor = null;
    windowLoading = false;
    windowError = null;
    turns = { status: 'idle', items: [] };
    bgJobs = { status: 'idle', items: [] };
    summary = { status: 'idle', data: null };
    clearReadsCache();
  }

  /** 页面卸载：取消全部读取并停止调度；之后的读取以 cancelled 拒绝。 */
  function dispose() {
    epoch += 1;
    scheduler.cancelScope(pageScope);
    scheduler.cancelScope(sessionScope);
    clearReadsCache();
    scheduler.dispose();
  }

  /**
   * 选中会话并载入初始窗口。头锚点（默认）取会话最早一页，进入即从头阅读；
   * 尾锚点取最新一页，供「回到最新」使用。两个锚点都是单页窗口，扩展只沿
   * 头锚点向会话后部追加。
   * @param {string} key @param {number} limit @param {'start' | 'latest'} [anchor]
   */
  async function selectSession(key, limit = 30, anchor = 'start') {
    const myEpoch = ++epoch;
    scheduler.cancelScope(sessionScope);
    sessionScope = {};
    clearReadsCache();
    sessionKey = key;
    windowLoading = true;
    windowError = null;
    turns = { status: 'idle', items: [] };
    bgJobs = { status: 'idle', items: [] };
    summary = { status: 'idle', data: null };
    try {
      const page = await execute(sessionScope, 'requests',
        { key, limit, cursor: null, direction: anchor === 'latest' ? 'older' : 'forward' });
      if (myEpoch !== epoch) return;
      windowRows = page.items;
      newerCursor = page.next_cursor;
    } catch (error) {
      if (myEpoch !== epoch) return;
      windowRows = [];
      newerCursor = null;
      windowError = error instanceof Error ? error.message : 'window_failed';
    } finally {
      if (myEpoch === epoch) {
        windowLoading = false;
        void loadTurns();
        void loadBgJobs();
        void loadSummary(key);
      }
    }
  }

  async function loadLater() {
    if (windowLoading || newerCursor === null) return;
    const myEpoch = epoch;
    windowLoading = true;
    windowError = null;
    try {
      // 服务端窗口分页上限 200（queries.checkLimit）：翻倍请求越过上限后
      // 每次都会 400，窗口停在 400 行以内；clamp 到上限继续按页加载。
      const page = await execute(sessionScope, 'requests',
        { key: String(sessionKey), limit: Math.min(windowRows.length > 0 ? windowRows.length : 30, 200), cursor: newerCursor, direction: 'forward' });
      if (myEpoch !== epoch) return;
      // append + 去重：forward 页按 (started_ms, req_id) 升序返回，接在尾部即全窗正序；
      // 既有行不重编号，轮次下界不动、无需重取。
      const seen = new Set(windowRows.map(row => row.req_id));
      windowRows = [...windowRows, ...page.items.filter((/** @type {{req_id: number}} */ row) => !seen.has(row.req_id))];
      newerCursor = page.next_cursor;
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
    // 批量读取在跑：等待该批对本记录的视图，落地即复用；失败后重新走单项。
    if (!validate && rec.detail === null) {
      const batchView = batchInflight.get(rec.id);
      if (batchView !== undefined) {
        await batchView.catch(() => {});
        if (rec.detail !== null) return;
        if (reads.get(rec.id) !== rec) throwReadingChanged();
      }
    }
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
      const detail = await execute(sessionScope, 'detail', { id: rec.id });
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
      detail: rec.detail,
      meta: rec.meta,
      messages: rec.messages,
      entries: sortedEntries(rec),
      structure: rec.structure,
      delta: rec.delta,
      token: rec.token,
    };
  }

  /** @param {string} code @returns {Error & {code: string}} */
  function codeErrorOf(code) {
    const error = /** @type {Error & {code?: string}} */ (new Error(code));
    error.code = code;
    return /** @type {Error & {code: string}} */ (error);
  }

  /**
   * 批项合入：资格（代次、记录归属、修订）仍相等才写 detail/meta/token，
   * token 变化按 validate 语义先重置正文缓存再写。批次成功不递增修订——
   * 批读取与单项读取是同一种证据刷新。
   * @param {any} rec @param {number} id @param {number} myEpoch @param {number} myRev
   * @param {import('../src/reading').ReadingDetail} detail @param {import('../src/protocols').BodyPage} meta
   * @returns {boolean}
   */
  function applyBundle(rec, id, myEpoch, myRev, detail, meta) {
    if (myEpoch !== epoch || reads.get(id) !== rec || rec.rev !== myRev) return false;
    if (rec.token !== null && detail.reading_token !== rec.token) clearRecordContent(rec);
    rec.detail = detail;
    rec.token = detail.reading_token;
    rec.detailError = null;
    rec.status = 'fresh';
    if (rec.meta === null) rec.meta = meta;
    return true;
  }

  /**
   * 批量读取：readings 批次逐项取详情+元信息。条数分块（服务端一次 ≤32）与
   * batch_too_large 折半在这里；URL 编码与 16 KiB 上限在 adapter。响应先验证
   * 整批 index 与 requested_id（重复或缺失报 invalid_response 整批不写入），
   * 再逐项合入；逐项错误写各自记录状态并保留成功项；批级传输失败整调用拒绝。
   * oversized 项回退单项路径（单项无批预算）。next_index 循环推进剩余输入，
   * 每轮重新捕获资格。
   * @param {number[]} ids
   * @returns {Promise<RequestRead[]>} 按调用顺序；重复 id 重复出现。
   */
  async function readRequests(ids) {
    if (sessionKey === null) throw codeErrorOf('no_session');
    const key = String(sessionKey);
    const unique = [...new Set(ids)];
    /** @type {Map<number, {resolve: (r: RequestRead) => void, reject: (e: unknown) => void, promise: Promise<RequestRead>}>} 未 settle 的视图。 */
    const pending = new Map();
    /** @type {Map<number, Promise<RequestRead>>} 全部视图，供调用顺序映射。 */
    const viewPromises = new Map();
    for (const id of unique) {
      let resolve = /** @type {(r: RequestRead) => void} */ (() => {});
      let reject = /** @type {(e: unknown) => void} */ (() => {});
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      // 批级失败会 reject 视图并同步 throw；默认吞掉 rejection，
      // 调用方按需观察（await、rejects 或结尾的 allSettled）。
      promise.catch(() => {});
      pending.set(id, { resolve, reject, promise });
      viewPromises.set(id, promise);
    }
    for (const [id, view] of pending) batchInflight.set(id, view.promise);
    /** oversized 回退与全部异步收尾，返回前等待。@type {Promise<void>[]} */
    const tail = [];
    const settle = (/** @type {number} */ id, /** @type {RequestRead} */ value) => {
      pending.get(id)?.resolve(value);
      pending.delete(id);
    };
    const failOne = (/** @type {number} */ id, /** @type {unknown} */ error) => {
      const rec = reads.get(id);
      const code = /** @type {Error & {code?: string}} */ (error).code;
      if (rec !== undefined && rec.status === 'reading') {
        rec.detailError = typeof code === 'string' ? code : 'batch_failed';
        rec.status = 'failed';
      }
      pending.get(id)?.reject(error);
      pending.delete(id);
    };
    const failAll = (/** @type {unknown} */ error) => {
      for (const id of [...pending.keys()]) failOne(id, error);
    };
    try {
      let remaining = unique;
      // 每轮批次上限：batch_too_large 时折半后保持，不自动放大服务器上限。
      let limit = 32;
      while (remaining.length > 0 && pending.size > 0) {
        const chunk = remaining.slice(0, limit);
        const rest = remaining.slice(limit);
        const caps = chunk.map(id => {
          const rec = recordOf(id);
          return { id, rec, myEpoch: epoch, myRev: rec.rev, myToken: rec.token };
        });
        /** @type {any} */
        let page;
        try {
          page = await execute(sessionScope, 'readings', { key, ids: chunk });
        } catch (error) {
          if (/** @type {Error & {code?: string}} */ (error).code === 'batch_too_large' && chunk.length > 1) {
            // 折半重试，下一轮重新捕获资格；单项批超限走批级失败，不无限二分。
            limit = Math.max(1, Math.floor(chunk.length / 2));
            continue;
          }
          failAll(error);
          throw error;
        }
        // 整批形状验证：index 唯一在界、requested_id 对应、成功项覆盖 [0, settled)。
        const settled = page.next_index === null ? chunk.length : page.next_index;
        const byIndex = new Map();
        let valid = Number.isSafeInteger(settled) && settled > 0 && settled <= chunk.length;
        if (valid) {
          for (const item of page.items) {
            if (!Number.isSafeInteger(item.index) || item.index < 0 || item.index >= settled
              || byIndex.has(item.index) || item.requested_id !== chunk[item.index]) {
              valid = false;
              break;
            }
            byIndex.set(item.index, item);
          }
          if (byIndex.size !== settled) valid = false;
        }
        if (!valid) {
          failAll(codeErrorOf('invalid_response'));
          throw codeErrorOf('invalid_response');
        }
        /** @type {number[]} */
        const oversized = [];
        for (let i = 0; i < settled; i += 1) {
          const cap = caps[i];
          const item = byIndex.get(i);
          if (item.state === 'ok') {
            if (applyBundle(cap.rec, cap.id, cap.myEpoch, cap.myRev, item.value.detail, item.value.meta)) {
              onReadChanged?.(cap.id);
              settle(cap.id, assemble(cap.rec));
            } else {
              failOne(cap.id, codeErrorOf('reading_changed'));
            }
          } else if (item.state === 'reading_changed') {
            invalidateIfCurrent(cap.rec, cap.id, cap.myEpoch, cap.myToken);
            failOne(cap.id, codeErrorOf('reading_changed'));
          } else if (item.state === 'oversized') {
            // 单项路径没有批预算，仍能取到完整详情；先撤登记与视图，单项的批等待不等自己的视图。
            batchFallbackCount += 1;
            const view = pending.get(cap.id);
            pending.delete(cap.id);
            if (batchInflight.get(cap.id) === viewPromises.get(cap.id)) batchInflight.delete(cap.id);
            tail.push((async () => {
              try {
                if (cap.rec.detail === null) await fetchDetail(cap.rec, false);
                if (reads.get(cap.id) !== cap.rec) throw codeErrorOf('reading_changed');
                if (cap.rec.detail !== null && cap.rec.meta === null) {
                  const meta = await readRange(cap.id, 0, 0);
                  if (reads.get(cap.id) !== cap.rec) throw codeErrorOf('reading_changed');
                  if (meta !== null) cap.rec.meta = meta;
                }
                view?.resolve(assemble(cap.rec));
              } catch (error) {
                view?.reject(error);
                onReadChanged?.(cap.id);
              }
            })());
          } else {
            failOne(cap.id, codeErrorOf(String(item.reason)));
          }
        }
        remaining = [...chunk.slice(settled), ...rest];
      }
    } finally {
      // 只清属于自己的登记：新批或单项任务对同一 id 的新登记不受影响。
      for (const id of viewPromises.keys()) {
        const view = viewPromises.get(id);
        if (view !== undefined && batchInflight.get(id) === view) batchInflight.delete(id);
      }
    }
    if (tail.length > 0) await Promise.all(tail);
    // 逐项失败（资格失效、冲突、not_found）不拒绝整个调用：快照状态如实返回，
    // 只有批级传输失败在循环内 throw。
    await Promise.all(unique.map(id => viewPromises.get(id)?.catch(() => {}) ?? Promise.resolve()));
    return ids.map(id => assemble(recordOf(id)));
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

  /**
   * 区间页合入（单项 readRange 与批量 readRanges 共用）：资格仍相等才合入
   * 消息与元信息。返回 false 表示资格已失效，调用方按迟到处理。
   * @param {{id: number, rec: any, myEpoch: number, myToken: string | null}} cap
   * @param {import('../src/protocols').BodyPage} page
   * @returns {boolean}
   */
  function applyRangePage(cap, page) {
    if (cap.myEpoch !== epoch || reads.get(cap.id) !== cap.rec || cap.rec.token !== cap.myToken) return false;
    mergeMessages(cap.rec, page);
    if (page.from === 0 && page.to === 0 && cap.rec.meta === null) cap.rec.meta = page;
    return true;
  }

  /**
   * 区间读取：完成值与在途登记分开缓存。命中完成值直接返回；命中在途共享
   * 同一任务；任务结束从在途登记移除、成功值落完成值——失败与缺口页不留缓存，
   * 重试重新走网络。旧任务只清属于自己的登记，不删除其他代次的新任务。
   * @param {number} id @param {number} from @param {number} to
   * @returns {Promise<import('../src/protocols').BodyPage>}
   */
  async function readRange(id, from, to) {
    const rec = recordOf(id);
    if (rec.detail === null) await fetchDetail(rec, false);
    if (rec.detail === null) throw rec.detailError ?? new Error('detail_unavailable');
    const key = JSON.stringify([id, rec.token, from, to]);
    const done = rec.pageValues.get(key);
    if (done !== undefined) return done;
    const inflight = rec.pageInflight.get(key);
    if (inflight !== undefined) return inflight;
    const myEpoch = epoch;
    const myToken = rec.token;
    const pending = (async () => {
      const page = await execute(sessionScope, 'body', { id, token: myToken, from, to });
      // 迟到响应：会话已切换、记录已作废重建，或版本已换（validate 原地重置）。
      if (!applyRangePage({ id, rec, myEpoch, myToken }, page)) throwReadingChanged();
      return page;
    })().catch(error => {
      if (/** @type {Error & {code?: string}} */ (error).code === 'reading_changed') {
        invalidateIfCurrent(rec, id, myEpoch, myToken);
      }
      throw error;
    });
    rec.pageInflight.set(key, pending);
    void pending.then(
      page => {
        if (rec.pageInflight.get(key) === pending) {
          rec.pageInflight.delete(key);
          rec.pageValues.set(key, page);
        }
      },
      () => { if (rec.pageInflight.get(key) === pending) rec.pageInflight.delete(key); },
    );
    return pending;
  }

  /**
   * 批量区间读取：bodyRanges 批次逐项取页并合入。折半与 64 项上限同
   * readRequests；逐项错误（not_found、reading_changed、oversized）留缺口
   * 返回 null，不进缓存、不推进调用方计数；批级传输失败拒绝整个调用。
   * @param {{id: number, from: number, to: number}[]} wants
   * @returns {Promise<(import('../src/protocols').BodyPage | null)[]>} 与 wants 对齐；缺口为 null。
   */
  async function readRanges(wants) {
    if (sessionKey === null) throw codeErrorOf('no_session');
    const key = String(sessionKey);
    /** @type {{id: number, from: number, to: number, rec: any, myEpoch: number, myToken: string | null, slot: number}[]} */
    const queue = [];
    wants.forEach((want, slot) => {
      const rec = reads.get(want.id);
      // 没有阅读身份的记录读不了区间：留缺口，由调用方决定补读详情。
      if (rec === undefined || rec.token === null) return;
      queue.push({ ...want, rec, myEpoch: epoch, myToken: rec.token, slot });
    });
    /** @type {(import('../src/protocols').BodyPage | null)[]} */
    const pages = wants.map(() => null);
    let remaining = queue;
    let limit = 64;
    while (remaining.length > 0) {
      const chunk = remaining.slice(0, limit);
      const rest = remaining.slice(limit);
      /** @type {any} */
      let page;
      try {
        page = await execute(sessionScope, 'bodyRanges',
          { key, ranges: chunk.map(cap => ({ id: cap.id, token: cap.myToken, from: cap.from, to: cap.to })) });
      } catch (error) {
        if (/** @type {Error & {code?: string}} */ (error).code === 'batch_too_large' && chunk.length > 1) {
          limit = Math.max(1, Math.floor(chunk.length / 2));
          continue;
        }
        throw error;
      }
      const settled = page.next_index === null ? chunk.length : page.next_index;
      const byIndex = new Map();
      let valid = Number.isSafeInteger(settled) && settled >= 0 && settled <= chunk.length;
      if (valid) {
        for (const item of page.items) {
          if (!Number.isSafeInteger(item.index) || item.index < 0 || item.index >= settled
            || byIndex.has(item.index) || item.requested_id !== chunk[item.index].id) {
            valid = false;
            break;
          }
          byIndex.set(item.index, item);
        }
        if (byIndex.size !== settled) valid = false;
      }
      if (!valid) throw codeErrorOf('invalid_response');
      for (let i = 0; i < settled; i += 1) {
        const cap = chunk[i];
        const item = byIndex.get(i);
        if (item.state === 'ok') {
          if (applyRangePage(cap, item.value)) pages[cap.slot] = item.value;
        } else if (item.state === 'reading_changed') {
          invalidateIfCurrent(cap.rec, cap.id, cap.myEpoch, cap.myToken);
        }
      }
      remaining = [...chunk.slice(settled), ...rest];
    }
    return pages;
  }

  /**
   * 结构片段的序号并集：只记结构读取真正读到的序号，定点读与增量读不混进游标。
   * @param {any} state @param {ReturnType<typeof messageEntries>} entries
   */
  function addStructureOrds(state, entries) {
    const ords = new Set(state.ords);
    for (const entry of entries) ords.add(entry.ord);
    state.ords = [...ords].sort((a, b) => a - b);
  }

  /**
   * 读一片结构区间并推进已读窗口：`[from, end)` 连续才算读到；缺口不推进
   * `back`，丢掉本片缓存让重试重新读取。
   * @param {number} id @param {any} rec @param {any} state
   * @param {number} from @param {number} to @param {number} total
   */
  async function readStructurePage(id, rec, state, from, to, total) {
    const page = await readRange(id, from, to);
    const entries = messageEntries(page);
    addStructureOrds(state, entries);
    state.total = page.total ?? total;
    const end = Math.min(page.to, page.total ?? page.to);
    const got = new Set(entries.map(entry => entry.ord));
    let gap = false;
    if (page.total !== null) {
      for (let ord = from; ord < end; ord += 1) {
        if (!got.has(ord)) { gap = true; break; }
      }
    }
    if (gap) {
      dropPage(rec, JSON.stringify([id, rec.token, from, to]));
      state.error = entries.length === 0 ? 'body_page_empty' : 'body_page_gap';
      return;
    }
    state.back = from;
    // 向前读更早的片不移动窗口上界；只有尾片把它推到新的末尾。
    state.next = Math.max(state.next, end);
  }

  /**
   * 结构读取：尾片优先。`[back, next)` 是连续已读窗口；首读写尾片
   * `[max(0,total-40), total)`，之后每次向前读一片「更早」，`back` 前移。
   * total 先取已读元信息；没有才读 0/0，仍为空再读第一页拿总数。长请求的读者
   * 关心新增与尾部，从头读等于每次展开都先看最早的上下文。
   * @param {number} id @returns {Promise<RequestRead>}
   */
  async function loadStructure(id) {
    const rec = recordOf(id);
    const state = rec.structure;
    if (state.loading) return assemble(rec);
    state.loading = true;
    state.error = null;
    try {
      if (state.total === null) {
        if (rec.meta === null) await readRequest(id);
        state.total = rec.meta?.total ?? null;
      }
      if (state.total === null) {
        // 元信息没有总数：读第一页拿 total 再决定尾片区间；这一页的序号照常计入并集。
        const first = await readRange(id, 0, 40);
        addStructureOrds(state, messageEntries(first));
        state.total = first.total;
      }
      const total = state.total;
      if (total === null) {
        state.error = 'body_total_unknown';
        return assemble(rec);
      }
      if (state.back > 0) {
        // 窗口已建立：向前读一片更早的。
        await readStructurePage(id, rec, state, Math.max(0, state.back - 40), state.back, total);
      } else if (state.next === 0 && total > 0) {
        await readStructurePage(id, rec, state, Math.max(0, total - 40), total, total);
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

  /**
   * 增量续读在跑时合并：并发调用共享同一任务，不各自推进消费位置。任务结束
   * 后释放，下一次调用继续从新位置消费。批量版本（loadDeltas）对每个覆盖的
   * id 同样登记，单项消费者等待批任务、不并发推进。
   * @param {number} id @param {number} [pages] @returns {Promise<RequestRead>}
   */
  function loadDelta(id, pages = 2) {
    const pending = deltaInflight.get(id);
    if (pending !== undefined) return /** @type {Promise<RequestRead>} */ (pending);
    const rec = recordOf(id);
    const myToken = rec.token;
    const task = runDeltas([id], pages).then(() => {
      // 记录被取代（会话切换）或版本已换（validate）：旧任务不得返回新快照。
      if (reads.get(id) !== rec || rec.token !== myToken) throwReadingChanged();
      return assemble(rec);
    });
    deltaInflight.set(id, task);
    void task.then(
      () => { if (deltaInflight.get(id) === task) deltaInflight.delete(id); },
      () => { if (deltaInflight.get(id) === task) deltaInflight.delete(id); },
    );
    return task;
  }

  /**
   * 批量增量准备：按每请求的可信 delta 构造最多 pages 片，跨请求打包进
   * bodyRanges 批，逐请求核对所需 ord 全到齐后才推进各自的消费计数。
   * 在跑的 id 不重复登记（两个消费者不各推进一次）。
   * @param {number[]} ids @param {number} [pages] @returns {Promise<void>}
   */
  function loadDeltas(ids, pages = 2) {
    const todo = [...new Set(ids)].filter(id => !deltaInflight.has(id));
    if (todo.length === 0) return Promise.resolve();
    const task = runDeltas(todo, pages);
    for (const id of todo) {
      deltaInflight.set(id, task);
      void task.then(
        () => { if (deltaInflight.get(id) === task) deltaInflight.delete(id); },
        () => { if (deltaInflight.get(id) === task) deltaInflight.delete(id); },
      );
    }
    return task;
  }

  /**
   * 增量任务的主体：构造片、批量读取、逐请求核对与推进。unknown 归属等
   * 无法派生组的请求走单项结构读取，语义与原单项增量一致。
   * @param {number[]} ids @param {number} pages
   * @returns {Promise<void>}
   */
  async function runDeltas(ids, pages) {
    /** @type {{id: number, from: number, to: number}[]} */
    const wants = [];
    /** @type {Map<number, {rec: any, trusted: Set<number>, pieces: {from: number, to: number, consumed: number}[]}>} */
    const plans = new Map();
    /** @type {Promise<RequestRead>[]} 需要单项结构读取的 unknown 归属请求。 */
    const structural = [];
    for (const id of ids) {
      const rec = recordOf(id);
      const state = rec.delta;
      if (rec.detail === null || state.loading || state.done) continue;
      const trusted = deltaOrdinals(rec.detail);
      if (trusted === null) {
        if (state.done) continue;
        state.unconfirmed = true;
        // 元信息尚未读到时先保留重试机会，不能提前标记完成。
        if (rec.detail.actor_state === 'unknown' && rec.meta === null) continue;
        state.done = true;
        // 未知归属没有可派生的组；按请求自身读取一片，不把正文当作新增。
        if (rec.detail.actor_state === 'unknown' && rec.meta !== null
          && rec.meta.total !== null && rec.meta.total > 0
          && (rec.meta.state === 'available' || rec.meta.state === 'partial')) {
          structural.push(loadStructure(id));
        }
        continue;
      }
      const ords = [...trusted].sort((a, b) => a - b).slice(state.next);
      if (ords.length === 0) { state.done = true; continue; }
      const { pieces } = deltaPieces(ords, pages);
      if (pieces.length === 0) continue;
      plans.set(id, { rec, trusted, pieces });
      for (const piece of pieces) wants.push({ id, from: piece.from, to: piece.to });
    }
    if (wants.length > 0) {
      for (const [, plan] of plans) {
        plan.rec.delta.loading = true;
        plan.rec.delta.error = null;
      }
      try {
        const got = await readRanges(wants);
        let cursor = 0;
        for (const [id, plan] of plans) {
          let reached = 0;
          let gap = false;
          for (const piece of plan.pieces) {
            const page = got[cursor] ?? null;
            cursor += 1;
            if (page === null) { gap = true; break; }
            // 每片核对所需 ord 都实际拿到：缺口不推进消费位置，不吞掉剩余输入。
            const gotOrds = new Set((page.messages ?? []).map((/** @type {{ord: number}} */ m) => m.ord));
            for (let o = piece.from; o < piece.to; o += 1) {
              if (!gotOrds.has(o)) {
                // 缺口页不留在缓存：重试必须重新走网络，不能永远命中同一片坏页。
                dropPage(plan.rec, JSON.stringify([id, plan.rec.token, piece.from, piece.to]));
                gap = true;
                break;
              }
            }
            if (gap) break;
            reached = piece.consumed;
          }
          if (gap) {
            plan.rec.delta.error = 'delta_gap';
          } else if (reached > 0) {
            plan.rec.delta.next += reached;
            if (plan.rec.delta.next >= plan.trusted.size) plan.rec.delta.done = true;
          }
        }
      } catch (error) {
        // 整笔已作废（409 路径）交给调用方统一处理；批级失败如实落在各请求上，
        // 不拒绝整个准备，可再续读。
        if (/** @type {Error & {code?: string}} */ (error).code === 'reading_changed') throw error;
        if (/** @type {Error & {code?: string}} */ (error).code !== 'cancelled') {
          for (const [, plan] of plans) {
            plan.rec.delta.error = error instanceof Error ? error.message : 'delta_failed';
          }
        }
      } finally {
        for (const [, plan] of plans) plan.rec.delta.loading = false;
      }
    }
    // 无法派生组的请求按自身读结构，不把正文当新增；等待完成与原单项增量一致。
    if (structural.length > 0) await Promise.all(structural);
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
          const reading = await execute(sessionScope, 'toolResult', { id, ord, token: myToken });
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
        const route = await execute(sessionScope, 'route', { id });
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

  /**
   * 弹窗目录读取：signal 绑定弹窗生命周期（关闭即取消），同一 signal 复用一个
   * dialog scope；经同一调度器执行，弹窗不直接调 transport，也不进全局正文缓存。
   * @param {number} id @param {import('../src/reading').ContextItemQuery} query
   * @param {string} token @param {AbortSignal} signal
   * @returns {Promise<import('../src/reading').ContextItemReading>}
   */
  function readContextItem(id, query, token, signal) {
    return execute(dialogScopeOf(signal), 'contextItem', { id, token, query }, signal);
  }

  /**
   * 弹窗片段正文读取：按 ContextBodyTarget 分流到正文区间与工具结果两个具名
   * 操作；signal 与 dialog scope 同目录读取。
   * @param {import('../src/read-contract').ContextBodyTarget} target @param {AbortSignal} signal
   * @returns {Promise<import('../src/protocols').BodyPage | import('../src/reading').ToolResultReading>}
   */
  function readContextBody(target, signal) {
    const operation = target.operation === 'toolResult' ? 'toolResult' : 'body';
    return /** @type {Promise<import('../src/protocols').BodyPage | import('../src/reading').ToolResultReading>} */ (
      execute(dialogScopeOf(signal), operation, target.input, signal));
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

  /** @returns {{status: 'idle' | 'loading' | 'ready' | 'absent', items: import('../src/queries/turns').TurnPairRow[]}} */
  function peekTurns() {
    return turns;
  }

  /** @returns {{status: 'idle' | 'loading' | 'ready' | 'absent', items: import('../src/queries/bg-jobs').BgJobRow[]}} */
  function peekBgJobs() {
    return bgJobs;
  }

  /** @returns {{status: 'idle' | 'loading' | 'ready' | 'absent', data: import('../src/queries/session-summary').SessionSummary | null}} */
  function peekSummary() {
    return summary;
  }

  /** @param {number} id 原地清空缓存并落作废态；不通知、不排自动重读，测试与强制失效用。 */
  function invalidate(id) {
    const rec = reads.get(id);
    if (rec !== undefined) invalidateRecord(rec);
    routes.delete(id);
    routeValues.delete(id);
  }

  return {
    getWindow: () => ({ sessionKey, requests: windowRows, newerCursor, loading: windowLoading, error: windowError }),
    getSessions: () => sessions,
    loadSessions,
    selectSession,
    loadLater,
    leaveSession,
    dispose,
    loadStats,
    readRequest,
    readRequests,
    readRange,
    loadStructure,
    loadDelta,
    loadDeltas,
    readToolResult,
    readRoute,
    readContextItem,
    readContextBody,
    peekRequest,
    peekToolResult,
    peekRoute,
    peekTurns,
    loadTurns,
    peekBgJobs,
    loadBgJobs,
    peekSummary,
    loadSummary,
    loadSummaryEntries,
    invalidate,
    /** oversized 项回退单项路径的累计次数，验收观察用。 */
    batchFallbackCount: () => batchFallbackCount,
  };
}
