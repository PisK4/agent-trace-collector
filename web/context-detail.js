// @ts-check
/**
 * 上下文明细弹窗：tile、图例与列表行共用的选择动作。
 *
 * 打开时按所选范围取目录（/api/requests/:id/context-item），片段正文按需走
 * 既有正文分页与工具结果端点，不在打开时预读全部正文。弹窗身份（请求 + 范围
 * + 读取代次）在每次请求发起时捕获，晚到响应与已关闭或已切换的弹窗不匹配即
 * 丢弃。Esc、关闭按钮与遮罩点击三种关闭途径，关闭后焦点回触发控件。
 * 矩阵与列表留在原位：打开弹窗不触发右栏重绘。
 *
 * @typedef {{
 *   reqId: number, kind: string, name: string | null, tag: string | null,
 *   label: string, tokens: number | null, token: string,
 *   members?: string[],
 * }} ContextSelection
 */

import { esc } from './html.js';
import { icon } from './icons.js';
import { motion, settled } from './motion.js';
import { baseNameOf, isPathKind, kk, partLabel } from './parts.js';

/** iid → {kind, tag, name}；iid 由 kind\01tag\01name 拼成，名字段允许含分隔符。
 *  @param {string} iid */
export function iidParse(iid) {
  const first = iid.indexOf('\u0001');
  const second = first < 0 ? -1 : iid.indexOf('\u0001', first + 1);
  if (first < 0 || second < 0) return null;
  const tag = iid.slice(first + 1, second);
  return { kind: iid.slice(0, first), tag: tag === '' ? null : tag, name: iid.slice(second + 1) };
}

/** 正文文本抽取：字符串、文本块与消息对象（递归抽 content）拼接；图片与
 *  密封推理按事实标注，不生成正文。
 *  @param {unknown} value */
export function contentTextOf(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value.map(block => {
      if (typeof block === 'string') return block;
      if (block === null || typeof block !== 'object') return '';
      const b = /** @type {Record<string, unknown>} */ (block);
      if (typeof b.text === 'string') return b.text;
      if (typeof b.output === 'string') return b.output;
      if (b.type === 'image') return '[图片块：不以文本呈现]';
      if (b.type === 'thinking' || b.type === 'reasoning') return '[推理内容：密封不可读]';
      return '';
    }).filter(s => s !== '');
    return parts.length > 0 ? parts.join('\n') : null;
  }
  if (value !== null && typeof value === 'object') {
    const v = /** @type {Record<string, unknown>} */ (value);
    if (typeof v.text === 'string') return v.text;
    if (typeof v.output === 'string') return v.output;
    // 消息对象：递归抽 content；tool_calls 参数不进文本，与中栏投影同口径。
    if (typeof v.role === 'string' && v.content !== undefined) return contentTextOf(v.content);
  }
  return null;
}

/** @typedef {{
 *   req_id: number, ord: number | null, path: string, precision: 'located' | 'carrier',
 *   tool_name: string | null, call_ord: number | null, owner_req: number | null, role: string | null,
 * }} ContextEntry
 * @typedef {{state: string, reason: string | null, notes: string[], entries: ContextEntry[], next_cursor: string | null}} ContextDirectory
 */

/**
 * 条目的正文读取目标。工具结果走配对操作；其余按消息区间读。顶层字段条目
 * 没有消息序号，保留正文头部区间 [0,40) 语义——request_fields 只在头部页返回，
 * 条目按 path 从 request_fields 解引用。
 * @param {{reqId: number, token: string}} session
 * @param {{ord: number | null, call_ord: number | null, owner_req: number | null}} entry
 * @returns {import('../src/read-contract').ContextBodyTarget}
 */
export function entryReadTarget(session, entry) {
  const token = session.token;
  if (entry.call_ord !== null && entry.owner_req !== null) {
    return { operation: 'toolResult', input: { id: entry.owner_req, ord: entry.call_ord, token } };
  }
  if (entry.ord === null) {
    return { operation: 'body', input: { id: session.reqId, token, from: 0, to: 40 } };
  }
  return { operation: 'body', input: { id: session.reqId, token, from: entry.ord, to: entry.ord + 1 } };
}

/** 目录条目的位置与身份列；正文按 entry 的落点分流到两种既有端点。
 *  @param {ContextEntry} entry */
function entryMeta(entry) {
  const isResult = entry.call_ord !== null && entry.owner_req !== null;
  const where = isResult
    ? `调用 ${entry.call_ord} · 结果在 req ${entry.owner_req}`
    : entry.ord !== null ? `消息 ${entry.ord}` : '请求顶层字段';
  const who = entry.tool_name ?? entry.role ?? '';
  return { isResult, where, who };
}

const PRECISION_TEXT = { located: '片段', carrier: '承载块' };

/**
 * 目录状态的呈现行：可读性按事实透传，notes 原文列出。
 * @param {ContextDirectory | null} data
 */
export function directoryStatusHtml(data) {
  if (data === null) return '';
  /** @type {Record<string, string | null>} */
  const STATE_TEXT = {
    available: null,
    partial: '正文部分保存，目录可能不完整',
    pending: '正文未取得（采集时正文没有落库）',
    evicted: '正文已按保留策略回收',
    summary: '正文已被摘要替代，原块不可读',
    unsupported: '该类别没有正文定位规则',
  };
  const head = STATE_TEXT[data.state] === null || STATE_TEXT[data.state] === undefined ? ''
    : `<p class="ctx-d-status">${esc(STATE_TEXT[data.state] ?? data.state)}${data.reason !== null && data.reason !== data.state ? `（${esc(data.reason)}）` : ''}</p>`;
  const notes = data.notes.map(note => `<p class="ctx-d-note">${esc(note)}</p>`).join('');
  return `${head}${notes}`;
}

/**
 * 弹窗内部 HTML：头部是所选范围（名称 + token），主体是状态说明
 * 与目录条目列表。条目默认收起（单项选择默认展开），展开时才读正文。
 * 路径类名字只显示 basename，完整名字在 title 里。
 * @param {ContextSelection} s
 * @param {{phase: string, data?: ContextDirectory, error?: string | null}} dir
 */
export function contextDetailHtml(s, dir) {
  const shown = s.name !== null && isPathKind(s.kind) ? baseNameOf(s.name) : s.label;
  const nameTitle = shown === s.label ? '' : ` title="${esc(s.label)}"`;
  const head = `<header class="ctx-d-head">
    <span class="t"><b${nameTitle}>${esc(shown)}</b></span>
    <span class="v">${s.tokens === null ? '' : `${kk(s.tokens)} tokens`}</span>
    <span class="grow"></span>
    <button type="button" class="x" data-ctx-close aria-label="关闭明细" title="关闭明细">${icon('close', 20)}</button>
  </header>`;
  const body = dir.phase === 'loading' ? '<div class="ctx-d-body"><p class="ctx-d-status pulse">读取目录…</p></div>' : (() => {
    // 集合块的成员身份：目录按类别范围取，成员名单在此如实列出。
    // 路径类名字只显示 basename，完整名字在 title 里。
    const members = s.members !== undefined && s.members.length > 0
      ? `<div class="ctx-d-body"><p class="ctx-d-note">成员：${
        s.members.map(m => {
          const parsed = iidParse(m);
          if (parsed === null) return '';
          if (!isPathKind(parsed.kind)) return esc(parsed.name);
          const base = baseNameOf(parsed.name);
          return base === parsed.name ? esc(base) : `<span title="${esc(parsed.name)}">${esc(base)}</span>`;
        }).filter(x => x !== '').join('、')}</p></div>` : '';
    const inner = dir.phase === 'error' ? `<div class="ctx-d-body"><p class="ctx-d-status">${esc(dir.error ?? '读取失败')}</p>${
      dir.error === 'reading_changed' ? '<p class="ctx-d-note">阅读依据已变化，关闭后重新打开。</p>' : ''}</div>`
      : dir.phase === 'loading' ? '<div class="ctx-d-body"><p class="ctx-d-status pulse">读取目录…</p></div>'
        : (() => {
          const data = dir.data;
          const entries = data?.entries ?? [];
          const items = entries.map((entry, index) => {
            const meta = entryMeta(entry);
            const open = entries.length === 1 && s.name !== null ? ' open' : '';
            return `<details class="ctx-d-entry"${open} data-ctx-entry="${index}">
              <summary><span class="p ${entry.precision}">${PRECISION_TEXT[entry.precision] ?? entry.precision}</span>
                <span class="who">${esc(meta.who === '' ? meta.where : `${meta.who} · ${meta.where}`)}</span>
                <code class="path">${esc(entry.path)}</code></summary>
              <div class="ctx-d-content" data-ctx-content="${index}"><p class="ctx-d-note">未读取</p></div>
            </details>`;
          }).join('');
          const more = data?.next_cursor !== null && data?.next_cursor !== undefined && data?.next_cursor !== null
            ? `<button type="button" class="chip-btn ico" data-ctx-more aria-label="继续扫描" title="继续扫描">${icon('retry', 20)}</button>` : '';
          const empty = entries.length === 0 && data?.state === 'available'
            ? '<p class="ctx-d-note">本笔请求的已保存正文里没有该范围的片段。</p>' : '';
          return `<div class="ctx-d-body">${directoryStatusHtml(data ?? null)}${empty}
            <div class="ctx-d-entries">${items}</div>${more}</div>`;
        })();
    return `${members}${inner}`;
  })();
  return `${head}${body}`;
}

/** 顶层字段条目的 path：`request.<field>` 或 `request.<field>[<index>]`。 */
const TOP_FIELD_RE = /^request\.([a-z_]+)(?:\[(\d+)\])?$/;

/**
 * 单个条目的正文：展开即内容，只渲染一层——抽得出文本给文本，抽不出给
 * 缩进 JSON。工具结果读 data.content；顶层字段条目（工具定义、system 等）
 * 按 path 从 request_fields 解引用，渲染该字段本身——正文根读取里混着的
 * messages 不再兜底，避免渲染出与条目无关的消息；正文页读 messages[0].value；
 * 不可读状态原样说明。
 * @param {{ord: number | null, path: string, precision: string}} entry
 * @param {any} data
 */
export function entryContentHtml(entry, data) {
  if (data?.state !== undefined && data.state !== 'available' && data.state !== 'partial') {
    return `<p class="ctx-d-status">${esc(data.reason ?? data.state)}</p>`;
  }
  if (entry.ord === null) {
    const match = TOP_FIELD_RE.exec(entry.path);
    const fields = data?.request_fields;
    const hasFields = fields !== null && fields !== undefined && typeof fields === 'object'
      && !Array.isArray(fields);
    const list = match !== null && hasFields ? fields[match[1]] : undefined;
    const value = match !== null && match[2] !== undefined && Array.isArray(list)
      ? list[Number(match[2])]
      : list;
    if (value === undefined || value === null) {
      const why = match === null ? '条目路径无法定位正文' : '该字段不在这笔已保存正文里';
      return `<p class="ctx-d-status">${esc(why)}</p>`;
    }
    const text = contentTextOf(value);
    return `<pre class="ctx-d-text">${esc(text === null ? JSON.stringify(value, null, 1) : text)}</pre>`;
  }
  const value = data?.content !== undefined && data?.content !== null
    ? data.content
    : data?.messages?.[0]?.value ?? null;
  const text = contentTextOf(value);
  const state = data?.is_error === true ? '<p class="ctx-d-status">工具结果标记为失败（is_error）</p>' : '';
  const body = text === null ? JSON.stringify(value, null, 1) : text;
  return `${state}<pre class="ctx-d-text">${esc(body)}</pre>`;
}

/**
 * 条目正文的弹窗内读取：同一目标只发一次请求。已就绪直接复用；进行中共用
 * 同一 promise——多个工具定义行展开时共享一次头部区间读取；失败不缓存，
 * 下次展开重试。
 * @param {Map<string, {phase: string, data?: any, promise?: Promise<{data: any} | {error: unknown}>}>} contents
 * @param {string} key 目标缓存键（序列化的读取目标）
 * @param {() => Promise<any>} doRead
 * @returns {Promise<{data: any} | {error: unknown}>}
 */
export function sharedEntryRead(contents, key, doRead) {
  const cached = contents.get(key);
  if (cached?.phase === 'ready') return Promise.resolve({ data: cached.data });
  if (cached?.promise !== undefined) return cached.promise;
  const promise = doRead().then(
    data => ({ data }),
    error => {
      contents.delete(key);
      return { error };
    },
  );
  contents.set(key, { phase: 'loading', promise });
  return promise;
}

/**
 * @param {{
 *   readDirectory: (selection: ContextSelection, cursor: string | null, signal: AbortSignal) => Promise<ContextDirectory>,
 *   readEntry: (target: import('../src/read-contract').ContextBodyTarget, signal: AbortSignal) => Promise<any>,
 * }} io 读取经注入的具名操作 facade 走统一调度；弹窗不直接 Fetch。
 */
export function createContextMenu({ readDirectory, readEntry }) {
  /** @type {{s: ContextSelection, dir: {phase: string, data?: any, error?: string | null}, contents: Map<string, {phase: string, data?: any, promise?: Promise<{data: any} | {error: unknown}>}>, trigger: Element | null} | null} */
  let open = null;
  let generation = 0;
  /** @type {HTMLElement | null} */
  let root = null;
  /** 弹窗生命周期：关闭与换代次即取消在途读取。 */
  /** @type {AbortController | null} */
  let controller = null;

  /** @param {unknown} error @returns {boolean} 关闭取消不是失败：不落错误态。 */
  const isCancelled = error => /** @type {Error & {code?: string}} */ (error).code === 'cancelled';

  function ensureRoot() {
    if (root !== null) return;
    root = document.createElement('div');
    root.className = 'ctx-dialog-root';
    root.hidden = true;
    root.addEventListener('mousedown', (e) => {
      if (e.target === root) close();
    });
    document.body.append(root);
  }

  function paint() {
    if (root === null || open === null) return;
    root.innerHTML = `<div class="ctx-dialog" role="dialog" aria-modal="true" aria-label="上下文明细">${
      contextDetailHtml(open.s, open.dir)}</div>`;
    const dialog = /** @type {HTMLElement | null} */ (root.firstElementChild);
    dialog?.querySelector('[data-ctx-close]')?.addEventListener('click', () => close());
    dialog?.querySelector('[data-ctx-more]')?.addEventListener('click', () => { void loadMore(); });
    // 条目展开时读正文；toggle 不冒泡，逐个绑定。
    for (const details of /** @type {NodeListOf<HTMLDetailsElement>} */ (dialog?.querySelectorAll('[data-ctx-entry]') ?? [])) {
      details.addEventListener('toggle', () => {
        if (!details.open) return;
        void loadEntry(Number(details.dataset.ctxEntry));
      });
    }
  }

  async function loadDirectory() {
    const s = open;
    if (s === null || controller === null) return;
    const gen = generation;
    try {
      const data = await readDirectory(s.s, null, controller.signal);
      if (open === null || generation !== gen) return;
      open.dir = { phase: 'ready', data };
    } catch (error) {
      if (open === null || generation !== gen || isCancelled(error)) return;
      open.dir = { phase: 'error', error: error instanceof Error ? error.message : '读取失败' };
    }
    paint();
  }

  async function loadMore() {
    const s = open;
    if (s === null || s.dir.phase !== 'ready' || controller === null) return;
    const gen = generation;
    try {
      const data = await readDirectory(s.s, s.dir.data?.next_cursor ?? null, controller.signal);
      if (open === null || generation !== gen) return;
      s.dir.data.entries.push(...data.entries);
      s.dir.data.next_cursor = data.next_cursor;
    } catch (error) {
      if (open === null || generation !== gen || isCancelled(error)) return;
      s.dir.error = error instanceof Error ? error.message : '读取失败';
    }
    paint();
  }

  async function loadEntry(/** @type {number} */ index) {
    const s = open;
    const active = controller;
    if (s === null || s.dir.phase !== 'ready' || active === null) return;
    const entry = s.dir.data?.entries?.[index];
    const slot = root?.querySelector(`[data-ctx-content="${index}"]`) ?? null;
    if (entry === undefined || slot === null) return;
    const gen = generation;
    const target = entryReadTarget({ reqId: s.s.reqId, token: s.s.token }, entry);
    // 缓存按序列化目标而不是条目序号：两个工具定义行展开共享同一次头部区间读取。
    const key = JSON.stringify(target);
    const ready = s.contents.get(key);
    if (ready?.phase === 'ready') {
      slot.innerHTML = entryContentHtml(entry, ready.data);
      motion(slot, { opacity: [0, 1] }, 0.14);
      return;
    }
    slot.innerHTML = '<p class="ctx-d-note pulse">读取正文…</p>';
    const result = await sharedEntryRead(s.contents, key, () => readEntry(target, active.signal));
    if (open === null || generation !== gen) return;
    if ('error' in result) {
      slot.innerHTML = `<p class="ctx-d-status">${
        result.error instanceof Error && result.error.message === 'reading_changed'
          ? '阅读依据已变化' : '正文读取失败'}</p>`;
      return;
    }
    slot.innerHTML = entryContentHtml(entry, result.data);
    motion(slot, { opacity: [0, 1] }, 0.14);
  }

  /** 离场动画在飞时的 controls：重开即取消，播完才真正 hidden。 */
  let exitAnims = /** @type {{finished: Promise<unknown>, cancel: () => void}[]} */ ([]);

  /**
   * 打开明细。label 与 tokens 由调用方从点击源给出；members 是集合块的
   * 成员身份（仅用于标注，目录按类别范围取）。
   * @param {ContextSelection} selection
   * @param {Element | null} [trigger]
   */
  function openDetail(selection, trigger = null) {
    ensureRoot();
    generation += 1;
    controller?.abort();
    controller = new AbortController();
    // 离场未完就重开：取消在飞的退场，遮罩与面板当场回到可见态。
    for (const anim of exitAnims) anim.cancel();
    exitAnims = [];
    const triggerFocus = document.activeElement;
    const container = /** @type {HTMLElement} */ (root);
    open = { s: selection, dir: { phase: 'loading' }, contents: new Map(), trigger: triggerFocus instanceof Element ? triggerFocus : trigger };
    container.hidden = false;
    paint();
    void loadDirectory();
    const closeBtn = /** @type {HTMLElement | null} */ (container.querySelector('[data-ctx-close]'));
    closeBtn?.focus();
  }

  function close() {
    if (open === null) return;
    const trigger = open.trigger;
    open = null;
    generation += 1;
    controller?.abort();
    controller = null;
    // 焦点先回触发控件再播离场：键盘用户的落点不等待动画。
    if (trigger instanceof HTMLElement) trigger.focus();
    if (root === null) return;
    const container = root;
    const panel = container.firstElementChild;
    const anims = [
      motion(container, { opacity: [1, 0] }, 0.14),
      panel !== null ? motion(panel, { opacity: [1, 0], transform: ['translateY(0px) scale(1)', 'translateY(4px) scale(0.99)'] }, 0.14) : null,
    ].filter(a => a !== null);
    if (anims.length === 0) { container.hidden = true; return; }
    exitAnims = anims;
    // settled 带超时兜底：动画时钟不前进的环境里 finished 永不 settle，不能等它。
    void Promise.all(anims.map(a => settled(a, 220))).then(() => {
      // 期间重开过（openDetail 换了新数组）就不隐藏。
      if (exitAnims !== anims) return;
      container.hidden = true;
      exitAnims = [];
    });
  }

  /** 切换请求或会话时调用：弹窗身份不再成立，直接关闭。 */
  function closeIfFor(/** @type {number} */ reqId) {
    if (open !== null && open.s.reqId !== reqId) close();
  }

  const isOpen = () => open !== null;

  return { openDetail, close, closeIfFor, isOpen, get root() { return root; } };
}
