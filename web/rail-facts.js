// @ts-check
/**
 * 右栏读数页的组合纯函数：事实页、请求结构、工具概览、用量折叠行与选中来源解析。
 * 只拼 HTML 字符串，不读写 DOM，也不发起读取；测试直接断言输出。
 * @typedef {import('../src/queries/projection').RequestRow} RequestRow
 * @typedef {import('../src/queries/requests').RequestDetail} RequestDetail
 * @typedef {import('../src/protocols').BodyPage} BodyPage
 * @typedef {import('./reader-store.js').RequestRead} RequestRead
 * @typedef {import('../src/queries/readings').PromptReading} PromptReading
 */

import {
  renderMessageDetail, renderMessages,
} from './body-view.js';
import { esc } from './html.js';
import { isFixedKind, kk, partLabel, partShade } from './parts.js';
import { contextMapShellHtml, contextRowsHtml } from './context-map.js';
import { messagePathOf, replyView, topSystemText } from './body-model.js';
import { isErrorText, loadStateText, pairStateText } from './trace-pair.js';
import { bodyLabelText, bodyStateText } from './row-summary.js';
import { secs, secsValue, tierOf, TIER_LIMITS } from './duration.js';

// 类别口径与 token 缩写的定义在 parts.js（与 context-map 共用），这里转发既有消费者。
export { kk, partLabel };

/**
 * 尝试链。每一行只用服务端白名单字段；未知 fail 原样转义。
 * 缺开始时间时只附说明，不计算任何相邻尝试的时间差。
 * @param {import('../src/queries/routes').AttemptChain | null | undefined} chain
 * @returns {string}
 */
export function renderAttemptChain(chain) {
  if (chain === null || chain === undefined || chain.state !== 'present') {
    return '<p class="note">没有可读取的尝试记录。</p>';
  }
  const rows = chain.items.map(item => {
    /** @type {string[]} 已转义的片段；只有尝试时长按档位换成 HTML。 */
    const bits = [esc(item.model ?? '模型未报告')];
    const text = (/** @type {string} */ v) => bits.push(esc(v));
    if (item.served !== null && item.served !== item.model) text(`served ${item.served}`);
    if (item.status !== null) text(`HTTP ${item.status}`);
    if (item.fail !== null) text(`fail ${item.fail}`);
    if (item.effort !== null) text(`effort ${item.effort}`);
    if (item.tier_served !== null) text(`tier ${item.tier_served}`);
    if (item.reasoning_hidden === true) text('推理隐藏');
    if (item.done === false) text('未结束');
    if (item.start_ms !== null) {
      const started = new Date(item.start_ms);
      if (!Number.isNaN(started.getTime())) text(started.toISOString());
    }
    if (item.ms !== null) {
      const tier = tierOf(item.ms, TIER_LIMITS.attempt);
      const value = esc(`${item.ms} ms`);
      bits.push(tier === 'good' ? value : `<b class="t-${tier}">${value}</b>`);
    }
    if (item.ttft_ms !== null) text(`首 token ${item.ttft_ms} ms`);
    if (item.first_reasoning_ms !== null) text(`首个推理 ${item.first_reasoning_ms} ms`);
    if (item.first_text_ms !== null) text(`首个文本 ${item.first_text_ms} ms`);
    return `<span class="attempt-name">${item.index + 1}. ${bits.join(' · ')}</span>`;
  }).join('<br>');
  const note = chain.timing.state === 'partial'
    ? `<p class="note">${esc(chain.timing.note)}</p>` : '';
  return `${rows}${note}`;
}

/**
 * 右栏读数页：证据（选中组级状态行时）→ 本次回复 → 请求结构 → 能力清单 →
 * 用量与上下文 → 身份完整性（异常时）。计时与用量在末位折叠行，头部只留身份行；
 * 区块缺的跳过，不重排也不补位。
 * @param {{evidenceHtml?: string, replyHtml: string, structureHtml: string, capabilitiesHtml: string, usageHtml: string, completenessHtml: string}} parts
 * @returns {string}
 */
export function railFactsHtml(parts) {
  return [
    parts.evidenceHtml ?? '', parts.replyHtml, parts.structureHtml, parts.capabilitiesHtml,
    parts.usageHtml, parts.completenessHtml,
  ].filter(html => html !== '').join('');
}

/**
 * 结构还有没读到的消息：从未读过（structure.total 为 null）时按元信息总数判断，
 * 读过后看已读窗口下界 `back`；读取失败保留重试入口。
 * 正文页签与请求结构折叠共用这一口径。
 * @param {{ back: number, next: number, total: number | null, loading: boolean, error: string | null }} structure
 * @param {number | null | undefined} total
 * @returns {boolean}
 */
export function structureUnread(structure, total) {
  if (structure.error !== null) return true;
  if (structure.total === null) return total !== null && total !== undefined && total > 0;
  return structure.back > 0;
}

/**
 * 结构续读的按钮与失败提示，正文页签与请求结构折叠共用一份。
 * 加载中禁用按钮，失败时按钮改「重试读取」并附原因；是否显示按钮由调用方判断，
 * 两个页签的正文可读性前置条件不同。已读窗口是 `[back, next)`，向前读更早的片；
 * 从未读过时没有「更早」，按钮读作从末尾读取。
 * @param {{ back: number, next: number, total?: number | null, loading: boolean, error: string | null }} structure
 * @param {number} reqId
 * @param {number | string | null} total
 * @returns {{button: string, note: string}}
 */
export function structureMoreParts(structure, reqId, total) {
  const label = structure.error !== null ? '重试读取'
    : structure.total === null ? `从末尾读取（共 ${total} 条）`
      : `加载更早（已读 ${structure.back}–${structure.next} / ${total}）`;
  return {
    button: `<button class="chip-btn" data-structure-more="${reqId}"${structure.loading ? ' disabled' : ''}>${label}</button>`,
    note: structure.error ? `<p class="note warn">结构读取失败：${esc(structure.error)}</p>` : '',
  };
}

/**
 * 请求结构折叠区。默认 closed，开合与选中消息按 req 稳定保存（重绘后由
 * data-fold 恢复）；total 在结构未读时取自元信息页，未读取也显示数量而不是空列表。
 * 列表展示已缓存消息的有序并集：连续历史、定点读与增量读到的消息都在，
 * 相邻序号之间的空洞标明未读取；连续历史上界仍由结构游标表达。
 * `selected` 是结构列表里点开的消息，详情替换列表；`highlight` 是中栏选中的
 * 消息，只在列表里高亮，不展开详情。
 * @param {{
 *   reqId: number,
 *   row: { body_state: string, miss_reason?: string | null },
 *   meta: { total: number | null, message_location?: BodyPage['message_location'] } | null,
 *   entries: import('./body-model.js').Entry[],
 *   structure: { back: number, next: number, total: number | null, ords: number[], loading: boolean, error: string | null },
 *   delta: Set<number> | null,
 *   deltaState?: { next: number, done: boolean, loading: boolean, error: string | null } | null,
 *   parseState?: string | null,
 *   relation: string,
 *   open?: boolean,
 *   selected?: number | null,
 *   highlight?: number | null,
 *   pairOf?: ((block: import('./body-model.js').Block, path: string) => {owner: number, callOrd: number} | null) | null,
 * }} input
 * @returns {string}
 */
export function structureFoldHtml(input) {
  const { reqId, row, meta, entries, structure, delta, deltaState = null, parseState = null, relation, open = false, selected = null, highlight = null, pairOf = null } = input;
  const total = structure.total ?? (meta ? meta.total : null);
  const count = total === null || total === undefined ? '消息总数未读取' : `${total} 条消息`;
  const canLoad = row.body_state === 'available' || row.body_state === 'partial';
  // 未读判定与正文页签同一口径：从未读过按总数，读过后看已读下界。
  const unread = structureUnread(structure, total);
  const chosen = selected === null
    ? null : entries.find(entry => entry.ord === selected) ?? null;
  let body;
  if (chosen !== null) {
    // 返回入口在详情上方：长消息的正文可以把页脚推到视口外，返回就不该跟着正文
    // 一起沉底。位置与「加载更早」一致，都在列表／详情的上方。
    body = `<div class="conv-tools"><button class="chip-btn" data-structure-back="${reqId}">返回消息列表</button></div>
      ${renderMessageDetail(chosen, messagePathOf(meta, chosen.ord), pairOf)}`;
  } else if (entries.length === 0 && !canLoad) {
    body = `<p class="note">${esc(bodyLabelText(row))}</p>`;
  } else if (entries.length === 0 && parseState === 'unsupported') {
    // 协议未适配是解释边界：原文完整也不按已知协议展开消息结构。
    body = '<p class="note">协议未适配：原对象已保存，但不按已知协议解释消息结构；请求字段与回复按原文阅读。</p>';
  } else if (entries.length === 0) {
    body = `<p class="note">${structure.loading ? '正在读取消息结构…' : '尚未读取消息正文；展开后从末尾读取最近 40 条。'}</p>`;
  } else {
    const consumed = deltaState === null ? delta?.size ?? 0 : Math.min(deltaState.next, delta?.size ?? 0);
    // 新增的标识交给列表内蓝缘（msg-new 行）；全部消费完的纯计数行不再占一行，
    // 未消费完与失败态保留——它们带交互与错误语义。
    const deltaNote = delta === null
      ? relation ? `<p class="note">${esc(relation)}：不标记新增消息，按原顺序列出。</p>` : ''
      : deltaState !== null && deltaState.error !== null
        ? `<p class="note warn">新增读取失败（${esc(deltaState.error)}）：已消费 ${consumed} / ${delta.size}，未读位置保留，不吞掉剩余输入。<button class="chip-btn" data-delta-more="${reqId}"${deltaState.loading ? ' disabled' : ''}>重试续读</button></p>`
        : deltaState !== null && !deltaState.done
          ? `<p class="note">新增 ${delta.size} 条消息 · 已消费 ${consumed} / ${delta.size}。<button class="chip-btn" data-delta-more="${reqId}"${deltaState.loading ? ' disabled' : ''}>继续读取</button></p>`
          : '';
    // 已缓存消息的有序并集；相邻序号的空洞是未读区间，不用连续游标删掉缓存尾部。
    const listEntries = [...entries].sort((a, b) => a.ord - b.ord);
    /** @type {{from: number, to: number}[]} */
    const gaps = [];
    let prev = -1;
    for (const entry of listEntries) {
      if (entry.ord > prev + 1) gaps.push({ from: prev + 1, to: entry.ord - 1 });
      prev = entry.ord;
    }
    body = `${deltaNote}${renderMessages(listEntries, { delta, limit: listEntries.length, selectedOrd: selected ?? highlight, gaps })}`;
  }
  const { button, note: errorNote } = structureMoreParts(structure, reqId, total);
  // 按钮与失败说明放在列表上方，与「向前读更早」的方向一致。
  const more = unread && canLoad ? button : '';
  return `<details class="rail-fold" data-structure-fold="${reqId}" data-fold="structure:${reqId}"${open ? ' open' : ''}>
    <summary>请求结构<span class="fold-count">${esc(count)}</span></summary>
    <div class="fold-body">${errorNote}${more}${body}</div>
  </details>`;
}

/**
 * 关联与加载状态的固定文案已迁入 trace-pair.js，与配对页共用同一套口径。
 * resolved 不当成功：is_error 三态表达工具是否报告失败。
 */

/**
 * 工具概览：配对状态与正文加载状态分立。模型响应时长归属请求，工具执行时长未采集。
 * @param {number} ownerReq
 * @param {{state: string, ord?: number, result_req: number | null, result_ord: number | null} | null} pair
 * @param {import('../src/reading').ToolResultReading | null} reading
 * @returns {string}
 */
export function toolOverviewHtml(ownerReq, pair, reading) {
  const pairState = pair === null || pair === undefined ? 'unpaired' : pair.state;
  const loadState = reading === null ? 'not_loaded'
    : reading.state === 'available' ? 'loaded' : reading.state;
  const row = (/** @type {string} */ k, /** @type {string} */ v) =>
    `<div class="chain-row"><dt>${k}</dt><dd>${v}</dd></div>`;
  return `<div class="chain">
    ${row('调用方', `请求 ${ownerReq}${pair?.ord !== undefined ? ` · 调用 #${pair.ord}` : ''}`)}
    ${row('配对状态', esc(pairStateText(pairState)))}
    ${pair !== null && pair.state === 'resolved' && pair.result_req !== null
    ? row('结果位置', `请求 ${pair.result_req} · 消息 #${pair.result_ord}`) : ''}
    ${row('正文加载', esc(loadStateText(loadState, reading?.reason ?? null)))}
    ${reading !== null && reading.state === 'available' ? row('错误标记', esc(isErrorText(reading.is_error))) : ''}
  </div>
  <p class="rail-note">模型响应时长归属承载它的请求；执行段按结果请求开始减调用请求结束推算，含客户端处理与人工确认，是上界。</p>`;
}

/**
 * 工具 Schema 页。只读当前元信息页的能力视图，不读可能为 null 的请求对象；
 * 0 项时按能力状态区分「未声明」与「不可读」，同名多定义逐项列出，不任选第一项。
 * @param {{tools: {state: string, items: {name: string, description?: string, schema: unknown, source?: string}[], reason: string | null}} | null | undefined} capabilities
 * @param {string} toolName
 * @returns {string}
 */
export function toolSchemaSection(capabilities, toolName) {
  if (capabilities === null || capabilities === undefined) {
    return '<p class="note">能力视图不可读，无法取得工具定义。</p>';
  }
  const tools = capabilities.tools;
  const matches = tools.state === 'present' ? tools.items.filter(item => item.name === toolName) : [];
  if (matches.length === 1) {
    const schema = matches[0]?.schema;
    return schema === null || schema === undefined
      ? '<p class="note">这个工具没有随请求携带输入 Schema。</p>'
      : `<pre class="raw" tabindex="0">${esc(JSON.stringify(schema, null, 2))}</pre>`;
  }
  if (matches.length > 1) {
    return `<p class="note warn">能力清单里有 ${matches.length} 个同名工具，无法唯一选择，逐项列出：</p>${
      matches.map(item => `<div class="schema-item"><div class="label">来源 ${esc(String(item.source ?? 'tools'))}</div><pre class="raw" tabindex="0">${
        item.schema === null || item.schema === undefined ? '（无 Schema）' : esc(JSON.stringify(item.schema, null, 2))
      }</pre></div>`).join('')}`;
  }
  if (tools.state === 'present') return `<p class="note">本请求未声明工具 ${esc(toolName)}：能力清单里没有这个名字。</p>`;
  if (tools.state === 'empty') return '<p class="note">这一笔请求没有携带工具定义，查不到它的 Schema。</p>';
  if (tools.state === 'unrecognized') return `<p class="note warn">工具字段存在但格式未识别，无法取得 ${esc(toolName)} 的定义。</p>`;
  if (tools.state === 'partial') {
    return `<p class="note warn">工具定义未读完（${esc(tools.reason ?? '原因未记录')}），${esc(toolName)} 的定义可能不完整。</p>`;
  }
  return `<p class="note warn">工具定义缺失（${esc(tools.reason ?? '原因未记录')}），无法取得 ${esc(toolName)} 的定义。</p>`;
}

/**
 * 阅读版本变化的统一说明：缓存已作废，store 正按冷却自动重读；保留立即重读入口。
 * @param {number} reqId
 */
export function readingChangedNote(reqId) {
  return `<p class="note warn">阅读版本已变化：这一笔的详情与正文缓存已作废，正在自动重读。</p>
    <div class="conv-tools"><button class="chip-btn" data-body-load="${reqId}">立即重读</button></div>`;
}

/**
 * 顶层 System 上下文：读当前请求的 system 文本，并与同 actor 的已确认前驱比较。
 * 前驱由派生的 prev_req_id 给出，不按相邻时间猜；前驱不在窗口、未读或 system
 * 不可读时只声明当前上下文（changed=null），不宣称首次出现或未变化。
 * @param {RequestRow} row
 * @param {(id: number) => RequestRead | null} readOf
 * @returns {{text: string, changed: boolean | null} | null}
 */
export function systemContextOf(row, readOf) {
  const read = readOf(row.req_id);
  const text = topSystemText(/** @type {import('../src/protocols').BodyPage | null} */ (read?.meta ?? null));
  if (text === null) return null;
  const detail = read?.detail ?? null;
  const prevId = detail?.prev_req_id ?? null;
  if (detail === null || detail.prev_relation !== 'confirmed' || prevId === null) {
    return { text, changed: null };
  }
  const prevText = topSystemText(/** @type {import('../src/protocols').BodyPage | null} */ (readOf(prevId)?.meta ?? null));
  if (prevText === null) return { text, changed: null };
  return { text, changed: prevText !== text };
}

/**
 * 证据折叠区：选中中栏组级状态行时出现在读数页顶部。四行各写一路证据自己的
 * 到达情况，缺的那一路写明它依赖谁；「没有」只写本库没有收到，不推断上游没发。
 * 数据全部来自已加载的行、详情与正文首片，不新增读取。
 * @param {RequestRow} row
 * @param {RequestDetail | null} detail
 * @param {BodyPage | null} meta
 * @returns {string}
 */
export function evidenceFoldHtml(row, detail, meta) {
  const hook = detail?.source_facts?.hook?.successes ?? [];
  const error = detail?.source_facts?.selected?.error ?? null;
  const view = meta === null ? null : replyView(meta);
  /** @param {'ok'|'miss'|'wait'} state @param {string} text */
  const rowHtml = (state, text) =>
    `<div class="chain-row"><dt><span class="ev ${state}" aria-hidden="true">${state === 'ok' ? '✓' : state === 'miss' ? '✗' : '?'}</span></dt><dd>${text}</dd></div>`;
  const ledger = row.status !== null
    ? rowHtml('ok', `HTTP ${row.status}${error !== null ? ` · ${esc(error)}` : ''}`)
    : rowHtml('miss', '没有关联到账本行');
  const callback = hook.includes('success')
    ? rowHtml('ok', hook.includes('failure') ? '已收到 · 成功与失败报告并存' : '已收到')
    : hook.includes('failure')
      ? rowHtml('ok', '已收到 · 报告失败')
      : rowHtml('miss', row.miss_reason === 'hook_absent'
        ? '无关联证据 · 等满 1 小时仍没有回调关联到本笔' : '无关联证据');
  const body = row.body_state === 'available' || row.body_state === 'partial'
    ? rowHtml('ok', esc(bodyStateText(row)))
    : rowHtml('miss', `${esc(bodyStateText(row))}${row.miss_reason !== null ? ` · ${esc(row.miss_reason)}` : ''}`);
  const reply = view === null
    ? rowHtml('wait', '依赖正文')
    : view.state === 'ok'
      ? rowHtml('ok', '已收到')
      : view.state === 'absent'
        ? rowHtml('miss', '无回复')
        : rowHtml('wait', `依赖正文 · ${esc(view.state)}`);
  // 结论句：整表没有一条 ok 时，读者需要一句话说明这一笔是什么，而不是一张空表。
  const arrived = [ledger, callback, body, reply].filter(html => html.includes('class="ev ok"')).length;
  const conclusion = arrived === 0
    ? '<p class="note warn">这一笔只有一条孤立记录：账本、回调与正文都没有到达本库。</p>'
    : callback.includes('class="ev miss"') && ledger.includes('class="ev ok"')
      ? '<p class="note">本库没有这笔的回调证据。这不等于上游没有回调过：投递超时或宿主中止都会静默放弃。</p>'
      : ledger.includes('class="ev miss"')
        ? '<p class="note">本库没有这笔的账本证据：回调没有携带可核验的 response ID，两边各自成行，不按时间近邻合并。</p>'
        : '';
  return `<details class="rail-fold" data-fold="evidence:${row.req_id}" open>
    <summary>证据</summary>
    <div class="fold-body">
      <dl class="chain evidence-chain">${ledger}${callback}${body}${reply}</dl>
      ${conclusion}
    </div>
  </details>`;
}

/**
 * 选中来源解析：把当前选中的步骤解析成右栏的阅读目标。
 * `state.selectedStep` 是唯一选择；右栏来源只从这一步解析，不按时间跳别的请求。
 * 请求侧分支处理输入消息、承载真实内容的 assistant 消息与结果消息，按消息号定位；
 * 回复侧分支只服务末尾组，按回复块定位。配对页不在这里推导：它只由「配对两端」
 * 与工具页列表等显式入口打开。
 * @param {import('./trace-view.js').TraceStep | null} step
 * @param {string | null} [selectedKey] 消息列表选中的稳定键，主轨迹未投影时用于定位缓存原文。
 * @param {RequestRead | null} [read]
 * @returns {{side:'none'}
 *   | {side:'evidence'}
 *   | {side:'request', target:'system', path:string, text:string}
 *   | {side:'request', target:'message', path:string, messageOrd:number}
 *   | {side:'reply', target:'text', path:string, blockIndex:number, text:string}
 *   | {side:'reply', target:'block', path:string, blockIndex:number, raw:unknown}
 *   | {side:'reply', target:'call', path:string, callOrd:number, ownerReq:number}}
 */
export function resolveSelectedSource(step, selectedKey = null, read = null) {
  if (step === null && read?.detail !== null && read?.detail !== undefined && selectedKey !== null) {
    const prefix = `${read.detail.req_id}:message:`;
    const ordText = selectedKey.startsWith(prefix) ? selectedKey.slice(prefix.length) : '';
    const ord = /^\d+$/.test(ordText) ? Number(ordText) : -1;
    if (read.entries.some(entry => entry.ord === ord)) {
      return { side: 'request', target: 'message', path: messagePathOf(read.meta, ord), messageOrd: ord };
    }
  }
  // 组级状态行不落在协议对象上：右栏顶部展开四路证据，不落到请求级读数页。
  if (step !== null && step.kind === 'flag') return { side: 'evidence' };
  if (step === null || step.source === null) return { side: 'none' };
  const s = step.source;
  if (s.side === 'request') {
    if (typeof s.messageOrd === 'number') {
      return { side: 'request', target: 'message', path: s.path, messageOrd: s.messageOrd };
    }
    // 系统提示的路径随协议不同（request.system / request.instructions），原样透传。
    return { side: 'request', target: 'system', path: s.path, text: String(step.raw ?? '') };
  }
  if (step.kind === 'tool' && step.callOrd !== null) {
    return { side: 'reply', target: 'call', path: s.path, callOrd: step.callOrd, ownerReq: step.reqId };
  }
  if (step.kind === 'assistant') {
    return { side: 'reply', target: 'text', path: s.path, blockIndex: s.blockIndex ?? 0, text: String(step.raw ?? '') };
  }
  return { side: 'reply', target: 'block', path: s.path, blockIndex: s.blockIndex ?? 0, raw: step.raw };
}

/** @param {number | null | undefined} v */
const n = (v) => (v == null ? '—' : v.toLocaleString('en-US'));
/** 费用按 6 位有效数字渲染，去掉上游浮点尾差（账本存原始 float）。 @param {number} v */
const fmtCost = (v) => String(Number(v.toPrecision(6)));

/**
 * 计时读数的唯一口径：「耗时」指标与窗口外请求的读数行共用。
 * 首 token 与首个文本是两个测量事件（第一个内容 vs 第一个文本块），分别取值，不按数值接近合并；
 * 速度分母用「总 − 首 token」，缺首 token 才退回账本 flow_ms（存在 1ms 这类退化值）。
 * 首个文本只从详情读：账本行没有这个字段，未读正文时不给值，不当作 0。
 * @param {RequestRow} r
 * @param {RequestDetail | null} [detail]
 * @returns {{ttft: number | null, ms: number | null, speed: number | null, firstText: number | null}}
 */
function timingReadingsOf(r, detail = null) {
  const ttft = detail?.ttft_ms ?? r.ttft_ms;
  const ms = detail?.ms ?? r.ms;
  const flow = ttft !== null && ms !== null ? Math.max(0, ms - ttft) : (detail?.flow_ms ?? r.flow_ms);
  const speed = flow && r.out_tok ? Math.round(r.out_tok / (flow / 1000)) : null;
  const firstText = detail?.first_text_ms ?? null;
  return { ttft, ms, speed, firstText };
}

/**
 * 计时与用量读数：窗口外请求的读数行共用。
 * 口径解释放每个数值的 title；计时有值才展示，合法的 0 不按缺失处理；数值缺位显示「—」，不当作 0。
 * @param {RequestRow} r
 * @param {RequestDetail | null} [detail]
 * @returns {{timing: string, usage: string}}
 */
export function ledgerParts(r, detail = null) {
  const { ttft, ms, speed, firstText } = timingReadingsOf(r, detail);
  /** @param {string} label @param {string | null} v @param {string} tip */
  const row = (label, v, tip) =>
    `<div class="chain-row"><dt>${label}</dt><dd title="${esc(tip)}">${v === null ? '<i class="miss">—</i>' : v}</dd></div>`;
  const timing = [
    ttft !== null ? row('首 token', secs(ttft), 'TTFT：到第一个内容；第一个内容可能是文本、推理或工具调用') : '',
    ms !== null ? row('总', secs(ms), '从请求到回复结束') : '',
    speed !== null && speed > 0 ? row('速度', `${n(speed)} tok/s`, '输出 token ÷（总 − 首 token）') : '',
    firstText !== null ? row('首个文本', secs(firstText), '第一个文本块到达的时刻') : '',
  ].filter(Boolean).join('');
  const anyUsage = r.in_tok !== null || r.out_tok !== null || r.cache_read !== null || r.cache_write !== null;
  let usage = '';
  if (anyUsage) {
    usage = [
      row('入', r.in_tok === null ? null : n(r.in_tok), '输入 token，不含缓存读取与写入'),
      row('出', r.out_tok === null ? null : n(r.out_tok), '输出 token'),
      row('缓读', r.cache_read === null ? null : n(r.cache_read), '缓存读取 token；请求级命中见构成区「提示词缓存」，会话级命中见会话头合计行'),
      row('缓写', r.cache_write === null ? null : n(r.cache_write), '缓存写入 token'),
      r.cost_state === 'priced' && r.cost !== null ? row('费用', `$${fmtCost(r.cost)}`, '费用（上游报告）') : '',
      r.cost_state === 'zero' ? row('费用', '$0', '费用（上游报告）') : '',
    ].join('');
  }
  return {
    timing: timing === '' ? '' : `<dl class="chain ledger-chain">${timing}</dl>`,
    usage: usage === '' ? '' : `<dl class="chain ledger-chain">${usage}</dl>`,
  };
}

/** 折叠行外复用（窗口外请求）：计时与用量两组读数，全缺时整块不渲染。 @param {RequestRow} r @param {RequestDetail | null} [detail] */
export function ledgerRowsHtml(r, detail = null) {
  const p = ledgerParts(r, detail);
  return `${p.timing}${p.usage}`;
}

/**
 * 客户端随请求声明的 reasoning_effort：正文首片的 request_fields 顶层字段。
 * 值来自骨架而不是尝试链，单次干净调用没有异常态也读得到。
 * @param {BodyPage | null | undefined} page
 * @returns {string | null}
 */
export function requestEffortOf(page) {
  const fields = page === null || page === undefined ? null : page.request_fields;
  const value = fields !== null && typeof fields === 'object'
    ? (/** @type {Record<string, unknown>} */ (fields)).reasoning_effort : null;
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 请求级缓存命中：`cache_read ÷ (in_tok + cache_read)`，与会话头合计行同口径，
 * 只计两个读数都在的请求。缺任一读数或分母为 0 时不给数（不写 0，不当作未命中）；
 * 合法的 0 是「读了 0 个缓存 token」，显示 0%。
 * @param {RequestRow} r
 * @returns {{hit: number | null, read: number | null, fresh: number | null}}
 */
export function cacheHitOf(r) {
  const read = r.cache_read;
  const fresh = r.in_tok;
  if (read === null || read === undefined || fresh === null || fresh === undefined) {
    return { hit: null, read: null, fresh: null };
  }
  const total = read + fresh;
  return { hit: total > 0 ? read / total : null, read, fresh };
}

/** 占比读数的整数百分比；无值返回 null，不写 0。 @param {number | null} ratio */
const pctOf = (ratio) => (ratio === null ? null : Math.round(ratio * 100));

/**
 * 固定开销：系统提示 + 工具定义 + 技能 + 记忆的 token 和。
 * 口径按类别集合算，不按「总量减去其余」倒推，所以已知类别之外的 kind 不计入。
 * 没有构成分类时返回 null（不给数、不写 0）；集合内全为 0 是合法的 0。
 * @param {import('../src/queries/routes').RoutePromptPart[]} list
 * @returns {number | null}
 */
function fixedOverheadOf(list) {
  if (list.length === 0) return null;
  return list.reduce((sum, part) => sum + (isFixedKind(String(part.kind)) ? part.tokens : 0), 0);
}

/**
 * 构成区顶部的四个指标：已用上下文、固定开销、提示词缓存、耗时。
 *
 * 已用上下文是提示总量，与 treemap 面积同源；窗口与已用比例降为副行，分母只在
 * `recomputed` 且窗口为正时出现，否则写「模型的窗口大小未知」——不给分母就不给比例，
 * 不按旧结果或默认值编一个分母出来。异常态 pill 挂在标签行：比例 ≥90% 占满、
 * ≥75% 接近占满；估算行（counted=false）的「本地估计」也挂这一行，两处都只在异常时出现。
 * 固定开销按类别集合算，副行是它占已用的比例；缺构成分类时写「—」。
 * 提示词缓存缺读数时写「—」并说明未上报，有读数才给整百分点。
 * 耗时把计时四行合成一个读数，副行依次是首 token、首个文本与速度，缺项跳过。
 * 每个指标在缺值处写一句缺什么，不把缺失画成 0 或空条。
 * @param {RequestRow} r
 * @param {PromptReading | null} p 没有路由侧的 prompt 分析时四格留白说明
 * @param {RequestDetail | null} [detail] 首个文本只在详情里，未读正文时耗时副行没有这一项
 * @returns {string}
 */
export function contextStatsHtml(r, p, detail = null) {
  const list = /** @type {import('../src/queries/routes').RoutePromptPart[]} */ (p?.parts ?? []);
  const used = p === null || p.tokens === null ? null : kk(p.tokens);
  const window = p !== null && p.window !== null && p.window > 0 ? p.window : null;
  const pct = pctOf(p?.ratio ?? null);
  const est = p !== null && p.counted === false
    ? '<span class="u-pill" title="分类按请求正文估算，未经本次回复的实测 token 校准">本地估计</span>' : '';
  const full = p === null || p.ratio === null ? '' : p.ratio >= 0.9 ? '占满' : p.ratio >= 0.75 ? '接近占满' : '';
  const usedSub = p === null ? '没有路由侧的 prompt 分析'
    : used === null ? '没有可用 token 读数'
      : window === null ? '模型的窗口大小未知'
        : pct === null ? `总 ${kk(window)} · 不计算进度` : `总 ${kk(window)} · 已用 ${pct}%`;
  const usedTip = p === null
    ? '路由侧没有这份请求的 prompt 分析'
    : window === null
      ? '路由侧没有报告回答模型的上下文窗口'
      : pct !== null
        ? '已用上下文 ÷ 总上下文，取整百分点'
        : p.state === 'recomputed'
          ? '没有可用 token 读数'
          : ({ retained: '旧结果，不计算进度', missing: '结果缺失，不计算进度' }[p.state] ?? '不计算进度');
  const fixed = fixedOverheadOf(list);
  const fixedSub = fixed === null
    ? '没有构成分类'
    : p !== null && p.tokens !== null && p.tokens > 0 ? `占已用 ${Math.round(fixed / p.tokens * 100)}%` : '没有可用分母';
  const cache = cacheHitOf(r);
  const hitPct = pctOf(cache.hit);
  const { ttft, ms, speed, firstText } = timingReadingsOf(r, detail);
  const timeSub = [
    ttft !== null ? `首 token ${secs(ttft)}` : '',
    firstText !== null ? `首个文本 ${secs(firstText)}` : '',
    speed !== null && speed > 0 ? `${n(speed)} tok/s` : '',
  ].filter(Boolean).join(' · ');
  return `<div class="ctx-stats">
    <div class="ctx-stat">
      <div class="ctx-k">已用上下文${est}${full !== '' ? `<span class="u-pill warn">${full}</span>` : ''}</div>
      <div class="ctx-big"><b>${used === null ? '<i class="miss">—</i>' : used}</b>${used === null ? '' : '<span>token</span>'}</div>
      <div class="ctx-sub" title="${esc(usedTip)}">${usedSub}</div>
    </div>
    <div class="ctx-stat">
      <div class="ctx-k">固定开销</div>
      <div class="ctx-big"><b>${fixed === null ? '<i class="miss">—</i>' : kk(fixed)}</b>${fixed === null ? '' : '<span>token</span>'}</div>
      <div class="ctx-sub" title="系统提示 + 工具定义 + 技能 + 记忆：每笔请求都要背的部分，与对话无关">${fixedSub}</div>
    </div>
    <div class="ctx-stat">
      <div class="ctx-k" title="缓存命中＝cache_read ÷（入 + cache_read）；只计两个读数都在的请求">提示词缓存</div>
      <div class="ctx-big"><b>${hitPct === null ? '<i class="miss">—</i>' : hitPct + '%'}</b>${hitPct === null ? '' : '<span>命中</span>'}</div>
      ${hitPct === null ? '<div class="ctx-sub">缓存读数未上报</div>' : ''}
    </div>
    <div class="ctx-stat ctx-stat-time">
      <div class="ctx-k">耗时</div>
      <div class="ctx-big"><b>${ms === null ? '<i class="miss">—</i>' : secsValue(ms)}</b>${ms === null ? '' : '<span>s</span>'}</div>
      <div class="ctx-sub" title="总时长；首 token 到第一个内容，首个文本到第一个文本块，速度＝输出 ÷（总 − 首 token）">${ms === null ? '没有计时读数' : timeSub}</div>
    </div>
  </div>`;
}

/**
 * 用量与上下文折叠行（读数页末位，默认展开）：四个指标 → treemap → 图例 → 内容列表，
 * 最后是默认收起的「用量明细」（入/出/缓读/缓写/费用与 effort）。
 * 指标行已经回答「多少、多快」，逐项账本只是回看时偶尔要对数的账目，收进二级折叠
 * 把折叠行省下的高度留住。treemap 外壳在此渲染，tile 由 app.js 测量容器后填充；
 * 图例按 token 数降序。异常态才出标签：占用 ≥75% 出「接近占满」、≥90% 出「占满」，
 * 估算行（counted=false）出「本地估计」，两者都挂在指标行；正常态零状态提示。
 * 没有正值类别时不留空的图例容器，四个指标与缺失或估计说明保留。
 * @param {RequestRow} r
 * @param {RequestDetail | null} detail
 * @param {BodyPage | null} [meta] 正文首片；effort 从 request_fields 取，未读到不显示该行
 * @returns {string}
 */
export function usageFoldHtml(r, detail, meta = null) {
  const p = detail?.prompt ?? null;
  const list = /** @type {import('../src/queries/routes').RoutePromptPart[]} */ (p?.parts ?? []);
  const hasComp = p !== null && !(p.tokens === null && list.length === 0);
  let comp = contextStatsHtml(r, p, detail);
  if (hasComp) {
    // Prompt.calibrate 按总量缩放各类并舍入，已估计的正值类别也可能得到 0；
    // 零值与缺失类别在图例中均不可见，总量只保留总数口径。
    const positive = list.filter(x => x.tokens > 0);
    const sum = list.reduce((a, x) => a + x.tokens, 0) || 1;
    const mapHtml = positive.length > 0 ? contextMapShellHtml(p, r.req_id) : '';
    const rowsHtml = positive.length > 0 ? contextRowsHtml(p, r.req_id) : '';
    const legend = positive.length > 0
      ? `<div class="comp-legend">${[...positive].sort((a, b) => b.tokens - a.tokens).map(x => `<button type="button" class="name" data-ctx-kind="${esc(String(x.kind))}" data-ctx-req="${r.req_id}" aria-label="${esc(partLabel(String(x.kind)))}，打开明细"><span>${esc(partLabel(String(x.kind)))}</span></button>
        <span class="val">${kk(x.tokens)}</span><span class="pct">${Math.round(x.tokens / sum * 100)}%</span>`).join('')}</div>`
      : '';
    comp += `${mapHtml}${legend}${rowsHtml}`;
  }
  const hint = p === null || p.state === 'recomputed' ? '' : [
    ({ recomputed: '当前结果', retained: '旧结果', missing: '缺失' }[p.state] ?? p.state),
  ].filter(Boolean).join(' · ');
  const note = hasComp
    ? (p?.note ?? '分类是估计分配，不是逐类精确计数。')
    : (p?.note ?? '没有路由侧的 prompt 分析。可能是该请求未经网关规则路由，或路由记录已超出保留期。');
  const effort = requestEffortOf(meta);
  const effortHtml = effort === null ? ''
    : `<dl class="chain ledger-chain"><div class="chain-row"><dt>effort</dt><dd title="客户端随请求声明的 reasoning_effort">${esc(effort)}</dd></div></dl>`;
  const usageRows = ledgerParts(r, detail).usage;
  const more = usageRows === '' && effortHtml === ''
    ? ''
    : `<details class="usage-more" data-fold="usage:${r.req_id}">
        <summary>用量明细</summary>
        ${usageRows}${effortHtml}
      </details>`;
  return `<details class="rail-fold" data-fold="prompt:${r.req_id}" open>
    <summary>用量与上下文</summary>
    <div class="fold-body">
      ${hint !== '' ? `<p class="note">${esc(hint)}</p>` : ''}
      ${comp}
      ${more}
      <p class="rail-note">${esc(note)}</p>
    </div>
  </details>`;
}
