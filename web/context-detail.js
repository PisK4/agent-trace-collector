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
import { baseNameOf, isPathKind, kk, partColor, partLabel } from './parts.js';

/** iid → {kind, tag, name}；iid 由 kind\01tag\01name 拼成，名字段允许含分隔符。
 *  @param {string} iid */
export function iidParse(iid) {
  const first = iid.indexOf('\u0001');
  const second = first < 0 ? -1 : iid.indexOf('\u0001', first + 1);
  if (first < 0 || second < 0) return null;
  const tag = iid.slice(first + 1, second);
  return { kind: iid.slice(0, first), tag: tag === '' ? null : tag, name: iid.slice(second + 1) };
}

/** 正文文本抽取：字符串与文本块拼接；图片与密封推理按事实标注，不生成正文。
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
 * 条目的正文 URL。工具结果走配对端点；其余按消息区间读。顶层字段条目没有
 * 消息序号，走正文根读取——拼 `from=null&to=NaN` 会被服务端 400。
 * @param {{reqId: number, token: string}} session
 * @param {{ord: number | null, call_ord: number | null, owner_req: number | null}} entry
 * @returns {string}
 */
export function entryBodyUrl(session, entry) {
  const token = encodeURIComponent(session.token);
  if (entry.call_ord !== null && entry.owner_req !== null) {
    return `/api/requests/${entry.owner_req}/tools/${entry.call_ord}/result?if_reading=${token}`;
  }
  if (entry.ord === null) return `/api/requests/${session.reqId}/body?if_reading=${token}`;
  return `/api/requests/${session.reqId}/body?from=${entry.ord}&to=${entry.ord + 1}&if_reading=${token}`;
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
 * 弹窗内部 HTML：头部是所选范围（类别色点 + 名称 + token），主体是状态说明
 * 与目录条目列表。条目默认收起（单项选择默认展开），展开时才读正文。
 * 路径类名字只显示 basename，完整名字在 title 里。
 * @param {ContextSelection} s
 * @param {{phase: string, data?: ContextDirectory, error?: string | null}} dir
 */
export function contextDetailHtml(s, dir) {
  const shown = s.name !== null && isPathKind(s.kind) ? baseNameOf(s.name) : s.label;
  const nameTitle = shown === s.label ? '' : ` title="${esc(s.label)}"`;
  const head = `<header class="ctx-d-head">
    <span class="t"><i class="dot" style="background:${partColor(s.kind)}"></i><b${nameTitle}>${esc(shown)}</b></span>
    <span class="v">${s.tokens === null ? '' : `${kk(s.tokens)} tokens`}</span>
    <span class="grow"></span>
    <button type="button" class="x" data-ctx-close aria-label="关闭明细">×</button>
  </header>`;
  const body = dir.phase === 'loading' ? '<div class="ctx-d-body"><p class="ctx-d-status">读取目录…</p></div>' : (() => {
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
      : dir.phase === 'loading' ? '<div class="ctx-d-body"><p class="ctx-d-status">读取目录…</p></div>'
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
            ? '<button type="button" class="chip-btn" data-ctx-more>继续扫描</button>' : '';
          const empty = entries.length === 0 && data?.state === 'available'
            ? '<p class="ctx-d-note">本笔请求的已保存正文里没有该范围的片段。</p>' : '';
          return `<div class="ctx-d-body">${directoryStatusHtml(data ?? null)}${empty}
            <div class="ctx-d-entries">${items}</div>${more}</div>`;
        })();
    return `${members}${inner}`;
  })();
  return `${head}${body}`;
}

/**
 * 单个条目的正文：文本直接呈现，非文本与原始对象折叠为 JSON。
 * 工具结果读 data.content；正文页读 messages[0].value；不可读状态原样说明。
 * @param {{ord: number | null, path: string, precision: string}} entry
 * @param {any} data
 */
export function entryContentHtml(entry, data) {
  if (data?.state !== undefined && data.state !== 'available' && data.state !== 'partial') {
    return `<p class="ctx-d-status">${esc(data.reason ?? data.state)}</p>`;
  }
  const value = data?.content !== undefined && data?.content !== null
    ? data.content
    : data?.messages?.[0]?.value ?? null;
  const text = contentTextOf(value);
  const state = data?.is_error === true ? '<p class="ctx-d-status">工具结果标记为失败（is_error）</p>' : '';
  const textHtml = text === null ? '' : `<pre class="ctx-d-text">${esc(text)}</pre>`;
  const rawHtml = `<details class="ctx-d-raw"><summary>原始对象</summary><pre>${esc(JSON.stringify(value, null, 1))}</pre></details>`;
  return `${state}${textHtml}${rawHtml}`;
}

/**
 * @param {{ fetcher: (url: string) => Promise<Response> }} io
 */
export function createContextMenu({ fetcher }) {
  /** @type {{s: ContextSelection, dir: {phase: string, data?: any, error?: string | null}, contents: Map<number, {phase: string, data?: any, error?: string | null}>, trigger: Element | null} | null} */
  let open = null;
  let generation = 0;
  /** @type {HTMLElement | null} */
  let root = null;

  const jsonOf = async (/** @type {string} */ url) => {
    const response = await fetcher(url);
    if (response.status === 409) throw new Error('reading_changed');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  };

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
    if (s === null) return;
    const gen = generation;
    const params = new URLSearchParams({ kind: s.s.kind, if_reading: s.s.token });
    if (s.s.name !== null) params.set('name', s.s.name);
    if (s.s.tag !== null) params.set('tag', s.s.tag);
    try {
      const data = await jsonOf(`/api/requests/${s.s.reqId}/context-item?${params}`);
      if (open === null || generation !== gen) return;
      open.dir = { phase: 'ready', data };
    } catch (error) {
      if (open === null || generation !== gen) return;
      open.dir = { phase: 'error', error: error instanceof Error ? error.message : '读取失败' };
    }
    paint();
  }

  async function loadMore() {
    const s = open;
    if (s === null || s.dir.phase !== 'ready') return;
    const gen = generation;
    const cursor = s.dir.data?.next_cursor;
    const params = new URLSearchParams({ kind: s.s.kind, if_reading: s.s.token, cursor });
    if (s.s.name !== null) params.set('name', s.s.name);
    if (s.s.tag !== null) params.set('tag', s.s.tag);
    try {
      const data = await jsonOf(`/api/requests/${s.s.reqId}/context-item?${params}`);
      if (open === null || generation !== gen) return;
      s.dir.data.entries.push(...data.entries);
      s.dir.data.next_cursor = data.next_cursor;
    } catch (error) {
      if (open === null || generation !== gen) return;
      s.dir.error = error instanceof Error ? error.message : '读取失败';
    }
    paint();
  }

  async function loadEntry(/** @type {number} */ index) {
    const s = open;
    if (s === null || s.dir.phase !== 'ready') return;
    const entry = s.dir.data?.entries?.[index];
    const slot = root?.querySelector(`[data-ctx-content="${index}"]`) ?? null;
    if (entry === undefined || slot === null) return;
    if (s.contents.get(index)?.phase === 'ready') return;
    s.contents.set(index, { phase: 'loading' });
    slot.innerHTML = '<p class="ctx-d-note">读取正文…</p>';
    const gen = generation;
    const url = entryBodyUrl({ reqId: s.s.reqId, token: s.s.token }, entry);
    try {
      const data = await jsonOf(url);
      if (open === null || generation !== gen) return;
      s.contents.set(index, { phase: 'ready', data });
      slot.innerHTML = entryContentHtml(entry, data);
    } catch (error) {
      if (open === null || generation !== gen) return;
      s.contents.set(index, { phase: 'error' });
      slot.innerHTML = `<p class="ctx-d-status">${
        error instanceof Error && error.message === 'reading_changed'
          ? '阅读依据已变化' : '正文读取失败'}</p>`;
    }
  }

  /**
   * 打开明细。label 与 tokens 由调用方从点击源给出；members 是集合块的
   * 成员身份（仅用于标注，目录按类别范围取）。
   * @param {ContextSelection} selection
   * @param {Element | null} [trigger]
   */
  function openDetail(selection, trigger = null) {
    ensureRoot();
    generation += 1;
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
    if (root !== null) root.hidden = true;
    if (trigger instanceof HTMLElement) trigger.focus();
  }

  /** 切换请求或会话时调用：弹窗身份不再成立，直接关闭。 */
  function closeIfFor(/** @type {number} */ reqId) {
    if (open !== null && open.s.reqId !== reqId) close();
  }

  const isOpen = () => open !== null;

  return { openDetail, close, closeIfFor, isOpen, get root() { return root; } };
}
