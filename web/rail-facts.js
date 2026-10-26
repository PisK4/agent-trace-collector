// @ts-check
/**
 * 右栏读数页的组合纯函数：事实页、请求结构、工具概览、用量折叠行与选中来源解析。
 * 只拼 HTML 字符串，不读写 DOM，也不发起读取；测试直接断言输出。
 * @typedef {import('../src/queries/projection').RequestRow} RequestRow
 * @typedef {import('../src/queries/requests').RequestDetail} RequestDetail
 * @typedef {import('../src/protocols').BodyPage} BodyPage
 * @typedef {import('./reader-store.js').RequestRead} RequestRead
 */

import {
  renderMessageDetail, renderMessages,
} from './body-view.js';
import { esc } from './html.js';
import { kk, partColor, partLabel } from './parts.js';
import { contextMapHtml, contextRowsHtml } from './context-map.js';
import { topSystemText } from './body-model.js';
import { isErrorText, loadStateText, pairStateText } from './trace-pair.js';
import { bodyLabelText } from './row-summary.js';

// 类别口径与 token 缩写的定义在 parts.js（与 context-map 共用），这里转发既有消费者。
export { kk, partColor, partLabel };

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
    const bits = [item.model ?? '模型未报告'];
    if (item.served !== null && item.served !== item.model) bits.push(`served ${item.served}`);
    if (item.status !== null) bits.push(`HTTP ${item.status}`);
    if (item.fail !== null) bits.push(`fail ${item.fail}`);
    if (item.effort !== null) bits.push(`effort ${item.effort}`);
    if (item.tier_served !== null) bits.push(`tier ${item.tier_served}`);
    if (item.reasoning_hidden === true) bits.push('推理隐藏');
    if (item.done === false) bits.push('未结束');
    if (item.start_ms !== null) {
      const started = new Date(item.start_ms);
      if (!Number.isNaN(started.getTime())) bits.push(started.toISOString());
    }
    if (item.ms !== null) bits.push(`${item.ms} ms`);
    if (item.ttft_ms !== null) bits.push(`首 token ${item.ttft_ms} ms`);
    if (item.first_reasoning_ms !== null) bits.push(`首个推理 ${item.first_reasoning_ms} ms`);
    if (item.first_text_ms !== null) bits.push(`首个文本 ${item.first_text_ms} ms`);
    if (item.queued_ms !== null) bits.push(`排队 ${item.queued_ms} ms`);
    return `<span class="attempt-name">${item.index + 1}. ${bits.map(esc).join(' · ')}</span>`;
  }).join('<br>');
  const note = chain.timing.state === 'partial'
    ? `<p class="note">${esc(chain.timing.note)}</p>` : '';
  return `${rows}${note}`;
}

/**
 * 右栏读数页：本次回复 → 请求结构 → 能力清单 → 用量与上下文 → 身份完整性（异常时）。
 * 计时与用量在末位折叠行，头部只留身份行；区块缺的跳过，不重排也不补位。
 * @param {{replyHtml: string, structureHtml: string, capabilitiesHtml: string, usageHtml: string, completenessHtml: string}} parts
 * @returns {string}
 */
export function railFactsHtml(parts) {
  return [
    parts.replyHtml, parts.structureHtml, parts.capabilitiesHtml,
    parts.usageHtml, parts.completenessHtml,
  ].filter(html => html !== '').join('');
}

/**
 * 请求结构折叠区。默认 closed，开合与选中消息按 req 稳定保存（重绘后由
 * data-fold 恢复）；total 在结构未读时取自元信息页，未读取也显示数量而不是空列表。
 * 列表展示已缓存消息的有序并集：连续历史、定点读与增量读到的消息都在，
 * 相邻序号之间的空洞标明未读取；连续历史上界仍由结构游标表达。
 * @param {{
 *   reqId: number,
 *   row: { body_state: string, miss_reason?: string | null },
 *   meta: { total: number | null } | null,
 *   entries: import('./body-model.js').Entry[],
 *   structure: { next: number, total: number | null, ords: number[], loading: boolean, error: string | null },
 *   delta: Set<number> | null,
 *   deltaState?: { next: number, done: boolean, loading: boolean, error: string | null } | null,
 *   parseState?: string | null,
 *   relation: string,
 *   open?: boolean,
 *   selected?: number | null,
 * }} input
 * @returns {string}
 */
export function structureFoldHtml(input) {
  const { reqId, row, meta, entries, structure, delta, deltaState = null, parseState = null, relation, open = false, selected = null } = input;
  const total = structure.total ?? (meta ? meta.total : null);
  const count = total === null || total === undefined ? '消息总数未读取' : `${total} 条消息`;
  const canLoad = row.body_state === 'available' || row.body_state === 'partial';
  const unread = total !== null && total !== undefined && structure.next < total;
  const chosen = selected === null
    ? null : entries.find(entry => entry.ord === selected) ?? null;
  let body;
  if (chosen !== null) {
    body = `${renderMessageDetail(chosen)}
      <div class="conv-tools"><button class="chip-btn" data-structure-back="${reqId}">返回消息列表</button></div>`;
  } else if (entries.length === 0 && !canLoad) {
    body = `<p class="note">${esc(bodyLabelText(row))}</p>`;
  } else if (entries.length === 0 && parseState === 'unsupported') {
    // 协议未适配是解释边界：原文完整也不按已知协议展开消息结构。
    body = '<p class="note">协议未适配：原对象已保存，但不按已知协议解释消息结构；请求字段与回复按原文阅读。</p>';
  } else if (entries.length === 0) {
    body = `<p class="note">${structure.loading ? '正在读取消息结构…' : '尚未读取消息正文；展开后从开头读取前 40 条。'}</p>`;
  } else {
    const consumed = deltaState === null ? delta?.size ?? 0 : Math.min(deltaState.next, delta?.size ?? 0);
    const deltaNote = delta === null
      ? relation ? `<p class="note">${esc(relation)}：不标记新增消息，按原顺序列出。</p>` : ''
      : deltaState !== null && deltaState.error !== null
        ? `<p class="note warn">新增读取失败（${esc(deltaState.error)}）：已消费 ${consumed} / ${delta.size}，未读位置保留，不吞掉剩余输入。<button class="chip-btn" data-delta-more="${reqId}"${deltaState.loading ? ' disabled' : ''}>重试续读</button></p>`
        : deltaState !== null && !deltaState.done
          ? `<p class="note">新增 ${delta.size} 条消息 · 已消费 ${consumed} / ${delta.size}。<button class="chip-btn" data-delta-more="${reqId}"${deltaState.loading ? ' disabled' : ''}>继续读取</button></p>`
          : `<p class="note">新增 ${delta.size} 条消息。</p>`;
    // 已缓存消息的有序并集；相邻序号的空洞是未读区间，不用连续游标删掉缓存尾部。
    const listEntries = [...entries].sort((a, b) => a.ord - b.ord);
    /** @type {{from: number, to: number}[]} */
    const gaps = [];
    let prev = -1;
    for (const entry of listEntries) {
      if (entry.ord > prev + 1) gaps.push({ from: prev + 1, to: entry.ord - 1 });
      prev = entry.ord;
    }
    body = `${deltaNote}${renderMessages(listEntries, { delta, limit: listEntries.length, selectedOrd: selected, gaps })}`;
  }
  const more = unread && canLoad
    ? `<button class="chip-btn" data-structure-more="${reqId}"${structure.loading ? ' disabled' : ''}>${structure.error ? '重试读取' : `加载下一片（已读 ${structure.next} / ${total}）`}</button>`
    : '';
  const errorNote = structure.error ? `<p class="note warn">结构读取失败：${esc(structure.error)}</p>` : '';
  return `<details class="rail-fold" data-structure-fold="${reqId}" data-fold="structure:${reqId}"${open ? ' open' : ''}>
    <summary>请求结构<span class="fold-count">${esc(count)}</span></summary>
    <div class="fold-body">${errorNote}${body}${more}</div>
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
    ${row('正文加载', esc(loadStateText(loadState)))}
    ${reading !== null && reading.state === 'available' ? row('错误标记', esc(isErrorText(reading.is_error))) : ''}
  </div>
  <p class="rail-note">模型响应时长归属承载它的请求；工具执行时长未采集。</p>`;
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
 * 选中来源解析：把当前选中的步骤解析成右栏的阅读目标。
 * `state.selectedStep` 是唯一选择；右栏来源只从这一步解析，不按时间跳别的请求。
 * 调用与已配对的结果步骤都解析成配对目标（owner + 调用序号），右栏就地同屏阅读；
 * 未配对的结果、System 与其余输入步骤打开正文来源；记录步骤打开请求读数。
 * @param {import('./trace-view.js').TraceStep | null} step
 * @returns {{side:'none'}
 *   | {side:'request', target:'system', path:string, text:string}
 *   | {side:'request', target:'message', path:string, messageOrd:number}
 *   | {side:'reply', target:'text', path:string, blockIndex:number, text:string}
 *   | {side:'reply', target:'block', path:string, blockIndex:number, raw:unknown}
 *   | {side:'reply', target:'call', path:string, callOrd:number, ownerReq:number}
 *   | {side:'pair', ownerReq:number, callOrd:number}}
 */
export function resolveSelectedSource(step) {
  if (step === null || step.source === null) return { side: 'none' };
  const s = step.source;
  // 已配对的结果步骤优先解析成配对目标：它虽然落在 request 侧，阅读入口是两端同屏。
  if (step.kind === 'tool_result' && step.pairOwner !== null) {
    return { side: 'pair', ownerReq: step.pairOwner.reqId, callOrd: step.pairOwner.callOrd };
  }
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
/** @param {number | null | undefined} ms */
export const secs = (ms) => (ms == null ? '—' : (ms / 1000).toFixed(2) + ' s');
/** 费用按 6 位有效数字渲染，去掉上游浮点尾差（账本存原始 float）。 @param {number} v */
const fmtCost = (v) => String(Number(v.toPrecision(6)));

/**
 * 计时与用量读数：「用量与上下文」折叠行与窗口外请求共用。
 * 首 token 与首个文本是两个测量事件（第一个内容 vs 第一个文本块），分别成行，不按数值接近合并；
 * 速度分母用「总 − 首 token」，缺首 token 才退回账本 flow_ms（存在 1ms 这类退化值）。
 * 口径解释放每个数值的 title；计时有值才展示，合法的 0 不按缺失处理；数值缺位显示「—」，不当作 0。
 * @param {RequestRow} r
 * @param {RequestDetail | null} [detail]
 * @returns {{timing: string, usage: string, headline: string}}
 */
export function ledgerParts(r, detail = null) {
  const ttft = detail?.ttft_ms ?? r.ttft_ms;
  const ms = detail?.ms ?? r.ms;
  const flow = ttft !== null && ms !== null ? Math.max(0, ms - ttft) : (detail?.flow_ms ?? r.flow_ms);
  const speed = flow && r.out_tok ? Math.round(r.out_tok / (flow / 1000)) : null;
  const firstText = detail?.first_text_ms ?? null;
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
  let headline = '';
  if (anyUsage) {
    usage = [
      row('入', r.in_tok === null ? null : n(r.in_tok), '输入 token，不含缓存读取与写入'),
      row('出', r.out_tok === null ? null : n(r.out_tok), '输出 token'),
      row('缓读', r.cache_read === null ? null : n(r.cache_read), '缓存读取 token；命中率是会话级读数，见会话头合计行'),
      row('缓写', r.cache_write === null ? null : n(r.cache_write), '缓存写入 token'),
      r.cost_state === 'priced' && r.cost !== null ? row('费用', `$${fmtCost(r.cost)}`, '费用（上游报告）') : '',
      r.cost_state === 'zero' ? row('费用', '$0', '费用（上游报告）') : '',
    ].join('');
    headline = [
      ms !== null ? `总 ${(ms / 1000).toFixed(2)}s` : '',
      r.out_tok !== null ? `出 ${n(r.out_tok)}` : '',
    ].filter(Boolean).join(' · ');
  }
  return {
    timing: timing === '' ? '' : `<dl class="chain ledger-chain">${timing}</dl>`,
    usage: usage === '' ? '' : `<dl class="chain ledger-chain">${usage}</dl>`,
    headline,
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
 * 用量与上下文折叠行（读数页末位，默认展开）：计时与用量两列读数 + 构成区。
 * 构成区自上而下是构成条、treemap、图例与内容列表，末行 u-total 汇总总量、
 * 窗口与占用；构成条与图例共用正值类别，图例按 token 数降序。异常态才出标签：
 * 占用 ≥75% 出「接近占满」、≥90% 出「占满」warn pill，估算行（counted=false）
 * 出「本地估计」pill 且贴在构成区末行，正常态零状态提示。没有正值类别时
 * 不留空的条和图例容器，总量、窗口、占用与缺失或估计说明保留。
 * @param {RequestRow} r
 * @param {RequestDetail | null} detail
 * @param {BodyPage | null} [meta] 正文首片；effort 从 request_fields 取，未读到不显示该行
 * @returns {string}
 */
export function usageFoldHtml(r, detail, meta = null) {
  const p = detail?.prompt ?? null;
  const list = /** @type {import('../src/queries/routes').RoutePromptPart[]} */ (p?.parts ?? []);
  const hasComp = p !== null && !(p.tokens === null && list.length === 0);
  const ledger = ledgerParts(r, detail);
  const hint = p === null || p.state === 'recomputed' ? '' : [
    ({ recomputed: '当前结果', retained: '旧结果', missing: '缺失' }[p.state] ?? p.state),
  ].filter(Boolean).join(' · ');
  let comp = '';
  if (hasComp) {
    // Prompt.calibrate 按总量缩放各类并舍入，已估计的正值类别也可能得到 0；
    // 零值与缺失类别在图例中均不可见，总量只保留总数口径。
    const positive = list.filter(x => x.tokens > 0);
    const sum = list.reduce((a, x) => a + x.tokens, 0) || 1;
    const bar = positive.length > 0
      ? `<div class="comp-bar" aria-hidden="true">${positive.map(x => `<i style="flex:${x.tokens / sum};background:${partColor(String(x.kind))}"></i>`).join('')}</div>`
      : '';
    const mapHtml = positive.length > 0 ? contextMapHtml(p, r.req_id) : '';
    const rowsHtml = positive.length > 0 ? contextRowsHtml(p, r.req_id) : '';
    const legend = positive.length > 0
      ? `<div class="comp-legend">${[...positive].sort((a, b) => b.tokens - a.tokens).map(x => `<span class="name"><i class="sw" style="background:${partColor(String(x.kind))}"></i><span>${esc(partLabel(String(x.kind)))}</span></span>
        <span class="val">${kk(x.tokens)}</span><span class="pct">${Math.round(x.tokens / sum * 100)}%</span>`).join('')}</div>`
      : '';
    const full = p.ratio !== null && p.ratio >= 0.9 ? '占满' : p.ratio !== null && p.ratio >= 0.75 ? '接近占满' : '';
    const est = p.counted === false
      ? '<span class="u-pill" title="分类按请求正文估算，未经本次回复的实测 token 校准">本地估计</span>' : '';
    const total = `<div class="u-total" style="margin-top:8px"><span>提示总量 <b>${p.tokens === null ? '<i class="miss">—</i>' : n(p.tokens)}</b></span><span>${p.window ? `窗口 <b>${kk(p.window)}</b>` : '窗口未知'}</span>${p.ratio !== null ? `<span>占用 <b>${(p.ratio * 100).toFixed(1)}%</b></span>` : ''}${est}${full !== '' ? `<span class="u-pill warn">${full}</span>` : ''}</div>`;
    comp = `${bar}${mapHtml}${legend}${rowsHtml}${total}`;
  }
  const note = hasComp
    ? (p?.note ?? (p?.window === null ? '没有可用分母，不显示占用率。' : '分类是估计分配，不是逐类精确计数。'))
    : (p?.note ?? '没有路由侧的 prompt 分析。可能是该请求未经网关规则路由，或路由记录已超出保留期。');
  const effort = requestEffortOf(meta);
  const effortHtml = effort === null ? ''
    : `<dl class="chain ledger-chain"><div class="chain-row"><dt>effort</dt><dd title="客户端随请求声明的 reasoning_effort">${esc(effort)}</dd></div></dl>`;
  return `<details class="rail-fold" data-fold="prompt:${r.req_id}" open>
    <summary>用量与上下文${ledger.headline !== '' ? `<span class="fold-count">${esc(ledger.headline)}</span>` : ''}</summary>
    <div class="fold-body">
      ${ledger.timing}${ledger.usage}${effortHtml}
      ${hint !== '' ? `<p class="note">${esc(hint)}</p>` : ''}
      ${comp}
      <p class="rail-note">${esc(note)}</p>
    </div>
  </details>`;
}
