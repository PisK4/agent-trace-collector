// @ts-check
/**
 * 会话头与双列分组的纯展示：会话行、窗口、汇总快照、分组显隐与定位提示
 * 都是显式入参，不读 store、不发网络请求；汇总条目列表的网络与状态更新在
 * 控制器，这里只画。
 * @typedef {import('../src/queries/projection').RequestRow} RequestRow
 * @typedef {import('../src/queries/sessions').SessionRow} SessionRow
 * @typedef {import('../src/queries/session-summary').SessionSummary} SessionSummary
 */

import { esc } from './html.js';
import { icon } from './icons.js';
import { kk } from './rail-facts.js';
import { bodyStateText } from './row-summary.js';
import { compact, EXEC_MS_HINT, secs } from './duration.js';
import { pairStateText } from './trace-pair.js';

/** @param {number} ms */
export const clock = (ms) => new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
/** @param {number} ms */
export const dayTime = (ms) => new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const AGENT_LABELS = /** @type {Record<string, string>} */ ({ claude: 'Claude Code', omp: 'OMP', codex: 'Codex', hermes: 'Hermes' });
/** @param {string} v */
export const agentLabel = (v) => AGENT_LABELS[v] ?? v;

/**
 * 折叠行：探针记录与旁路会话默认收起，展开只影响渲染。
 * 计数只覆盖已加载页，界面措辞如实说「已加载」；两类都为空时整行不渲染。
 * @param {SessionRow[]} items 搜索与筛选后、实际被折起的已加载条目
 * @param {boolean} showFolded 当前是否展开
 */
export function sessionsListFoldHtml(items, showFolded) {
  const probe = items.filter(s => s.flags.includes('probe')).length;
  const bypass = items.filter(s => s.flags.includes('bypass')).length;
  if (probe === 0 && bypass === 0) return '';
  const parts = [];
  if (probe > 0) parts.push(`${probe} 条探针记录`);
  if (bypass > 0) parts.push(`${bypass} 条旁路会话`);
  const label = showFolded ? `收起 ${parts.join(' · ')}` : `已折叠 ${parts.join(' · ')}（已加载页）`;
  return `<div class="sess-fold"><button class="chip-btn" data-fold-toggle="1">${icon(showFolded ? 'caret-up' : 'caret-down', 16)}<span>${esc(label)}</span></button></div>`;
}

/** @param {string} key */
function sessionKeyLabel(key) {
  try {
    const parsed = JSON.parse(key);
    if (Array.isArray(parsed) && parsed.length >= 2) {
      const value = String(parsed[1]);
      return parsed[0] === 'session' ? `session ${value.slice(0, 8)}…` : `${String(parsed[0])} ${value}`;
    }
  } catch { /* 不是 JSON 时原样显示 */ }
  return key;
}

/** @param {RequestRow[]} rows */
function timingSummary(rows) {
  const ttfts = rows.map(r => r.ttft_ms).filter(v => v !== null).sort((a, b) => a - b);
  const durations = rows.map(r => r.ms).filter(v => v !== null);
  const median = ttfts.length === 0 ? null : ttfts[Math.floor(ttfts.length / 2)] ?? null;
  const average = durations.length === 0 ? null : durations.reduce((a, v) => a + v, 0) / durations.length;
  // 速度只统计计时与输出都在的行：分母漏一行、分子照加，会把 OTLP 行放大成
  // 8000 tok/s。没有计时行时不给速度。
  const timed = rows.filter(r => r.out_tok !== null
    && (r.flow_ms !== null || (r.ms !== null && r.ttft_ms !== null)));
  const genMs = timed.reduce((a, r) => {
    if (r.flow_ms !== null) return a + r.flow_ms;
    return a + Math.max(0, (r.ms ?? 0) - (r.ttft_ms ?? 0));
  }, 0);
  const outTok = timed.reduce((a, r) => a + (r.out_tok ?? 0), 0);
  return {
    median, average,
    speed: genMs > 0 && outTok > 0 ? Math.round(outTok / (genMs / 1000)) : null,
  };
}

/** @typedef {{desc: string, data: string}} GroupCue */
/**
 * 摘要行：一行数据，不再带图标与标签。统计范围、口径与覆盖缺口放在
 * data-desc 里，悬停与键盘聚焦（tabindex）都能看到；常驻正文不写解释句。
 * @param {string} desc @param {string} data @param {string} [extraClass]
 */
function cueRow(desc, data, extraClass = '') {
  return `<section class="cue-row"><div class="cue-data${extraClass}" tabindex="0" data-desc="${esc(desc)}" aria-label="${esc(desc)}">${data}</div></section>`;
}

/**
 * 资源组：就绪快照给会话口径；未就绪回退已加载窗口相加并可见标明范围，
 * 不能只在悬停里更换统计口径。没有可用读数时整组不渲染。
 * @param {SessionSummary | null} s @param {'idle' | 'loading' | 'ready' | 'absent'} status @param {RequestRow[]} rows
  * @returns {GroupCue | null}
 */
function resourceGroup(s, status, rows) {
  if (s !== null) {
    const t = s.totals;
    if (t.in_tok === null && t.out_tok === null && t.cost === null) return null;
    const desc = [
      '整个会话的读数，含旁路与子代理',
      t.cost_absent !== null && t.cost_absent > 0 ? `${t.cost_absent} 笔未取得费用` : null,
      '缓存命中＝Σcache_read ÷ Σ(in_tok + cache_read)，只计两个读数都在的请求',
      t.cache_hit === null ? '本次没有可用分母，不给数' : null,
    ].filter(Boolean).join('；');
    const data = `<span class="cue-line">${[
      t.in_tok !== null ? `<i>提示</i> <b>${kk(t.in_tok)}</b>` : '',
      t.out_tok !== null ? `<i>输出</i> <b>${kk(t.out_tok)}</b>` : '',
      t.cost !== null ? `<i>费用</i> <b>$${t.cost.toFixed(4)}</b>` : '',
      t.cache_hit !== null ? `<i>缓存</i> <b>${Math.round(t.cache_hit * 100)}%</b>` : '',
    ].filter(Boolean).join(' · ')}</span>`;
    return { desc, data };
  }
  const hasUsage = rows.some(r => r.in_tok !== null || r.out_tok !== null);
  if (!hasUsage) return null;
  const totalIn = rows.reduce((a, r) => a + (r.in_tok ?? 0) + (r.cache_read ?? 0) + (r.cache_write ?? 0), 0);
  const totalOut = rows.reduce((a, r) => a + (r.out_tok ?? 0), 0);
  const priced = rows.filter(r => r.cost_state === 'priced' || r.cost_state === 'zero');
  const totalCost = priced.reduce((a, r) => a + (r.cost ?? 0), 0);
  const desc = [
    status === 'absent' ? '汇总快照不可用（端点缺失或读取失败）' : '汇总快照读取中',
    '这是已加载窗口的相加，不是会话口径',
    priced.length < rows.length ? `${rows.length - priced.length} 笔未取得费用` : null,
  ].filter(Boolean).join('；');
  const data = `<span class="cue-line">${[
    `<i>提示</i> <b>${kk(totalIn)}</b>`,
    `<i>输出</i> <b>${kk(totalOut)}</b>`,
    `<i>费用</i> <b>$${totalCost.toFixed(4)}</b>`,
  ].join(' · ')}</span><span class="scope-tag">已加载窗口</span>`;
  return { desc, data };
}

/**
 * 结构组：主链/旁路与峰值常驻，子代理、重试与多模型足迹非零才出现。
 * @param {SessionSummary} s
  * @returns {GroupCue | null}
 */
function structureGroup(s) {
  const st = s.structure;
  const data = [
    st.main !== null ? `<i>主链</i> <b>${st.main}</b> · <i>旁路</i> <b>${st.bypass}</b>` : '',
    st.context_peak_pct !== null ? `<i>峰值</i> <b>${st.context_peak_pct}%</b>` : '',
    st.subagent_actors > 0 ? `<i>子代理</i> <b>${st.subagent_actors}</b> 个 · <b>${st.subagent_requests}</b> 笔` : '',
    st.retries !== null && st.retries > 0 ? `<i>重试</i> <b>${st.retries}</b> 笔` : '',
    st.models.length > 1 ? `<i>模型</i> <b>${st.models.length}</b>` : '',
  ].filter(Boolean).join(' · ');
  if (data === '') return null;
  const desc = [
    '整个会话',
    '旁路＝分类器与标题生成等排除请求',
    st.context_peak_pct !== null ? '上下文峰值＝max(prompt_tokens ÷ prompt_window)' : '上下文峰值没有可用分母，不给数',
    st.models.length > 1 ? `模型＝${st.models.map(m => `${m.name} ×${m.count}`).join(' · ')}` : null,
  ].filter(Boolean).join('；');
  return { desc, data: `<span class="cue-line">${data}</span>` };
}

/** 性能组的计时读数；口径是当前已加载窗口，首字为 p50（说明进组标题）。 @param {RequestRow[]} rows */
function performanceData(rows) {
  const timing = timingSummary(rows);
  const parts = [
    timing.median !== null ? `<i>首字</i> <b>${secs(timing.median)}</b>` : '',
    timing.average !== null ? `<i>平均</i> <b>${secs(timing.average)}</b>` : '',
    timing.speed !== null ? `<b>${timing.speed}</b> tok/s` : '',
  ].filter(Boolean);
  return parts.length === 0 ? '' : `<span class="cue-line">${parts.join(' · ')}</span>`;
}

/** 工具与 Skill 组：chip 同一款中性样式，按调用次数取前三直接可见，其余进 +N 展开；
 *  Skill 并入同一行（显式调用限定，全量直出）。每个工具 chip 自带失败数红字，
 *  不再设组级失败入口。调用总数与覆盖情况（未配对、未判定、中断判定缺失）进按需说明。
 *  @param {SessionSummary} s @param {string | null} sessionKey
 *  @returns {GroupCue | null}
 */
function toolsGroup(s, sessionKey) {
  const chip = (/** @type {{name: string, count: number, errors: number, paired: number, error_known: number}} */ t) => {
    const warn = t.errors > 0 ? `<span class="err">${t.errors} 失败</span>` : '';
    const unknown = t.count - t.error_known;
    const title = [
      `点击定位 ${t.name} 的 ${t.count} 次调用`,
      t.count - t.paired > 0 ? `${t.count - t.paired} 次未配对` : null,
      unknown > 0 ? `${unknown} 次结果未判定（不计入失败）` : null,
    ].filter(Boolean).join(' · ');
    return `<button class="tool-chip" data-summary-tool="${esc(t.name)}" title="${esc(title)}"><span class="nm">${esc(t.name)}</span><span class="n">${t.count}</span>${warn}</button>`;
  };
  const skillChip = (/** @type {{name: string, count: number}} */ k) =>
    `<button class="tool-chip" data-summary-skill="${esc(k.name)}" title="点击定位该 Skill 的 ${k.count} 次调用"><span class="nm">${esc(k.name)}</span><span class="n">${k.count}</span></button>`;
  const head = s.tools.slice(0, 3).map(chip).join('');
  const rest = s.tools.slice(3);
  const more = rest.length > 0
    ? `<details class="path-more t" data-fold="headmore:tool:${esc(sessionKey ?? '')}"><summary title="工具共 ${s.tools.length} 把">+${rest.length}</summary><div class="more-body">${rest.map(chip).join('')}</div></details>`
    : '';
  const data = [
    head + more,
    s.skills.map(skillChip).join(''),
    s.interrupts.count > 0 ? `<span class="interrupt">已识别用户中断 <b>${s.interrupts.count}</b></span>` : '',
  ].filter(Boolean).join('');
  if (data === '') return null;
  const skillDesc = s.skills.length > 0
    ? `；Skill 为显式调用限定，共 ${s.skills.length} 个显式 Skill 调用，技能经 system 声明进入上下文而未发生调用时不计`
    : '';
  return { desc: `整个会话：${coverageHoverText(s)}${skillDesc}`, data };
}

/** @param {string} path @param {string[]} all 同组全部路径：同名 basename 并列时补上一段。 */
export function pathLabel(path, all) {
  const parts = path.split('/').filter(Boolean);
  const base = parts[parts.length - 1] ?? path;
  if (all.filter(other => other.split('/').pop() === base).length > 1 && parts.length >= 2) {
    return `${parts[parts.length - 2]}/${base}`;
  }
  return base;
}

/**
 * 写入尝试 / 读取请求组：完整原值进悬停与定位，前三加 +N 展开；
 * 计数是发出的调用，不表示执行或产物成功。两个字的短前缀常驻，路径名可省略。
 * @param {{path: string, count: number}[]} list @param {'w' | 'r'} side @param {string | null} sessionKey
  * @returns {GroupCue | null}
 */
function pathGroup(list, side, sessionKey) {
  if (list.length === 0) return null;
  const label = side === 'w' ? '写入尝试' : '读取请求';
  const short = side === 'w' ? '写入' : '读取';
  const names = list.map(p => p.path);
  const chip = (/** @type {{path: string, count: number}} */ p) =>
    `<button class="path-chip ${side}" data-summary-path="${esc(p.path)}" data-summary-side="${side}"
      title="${esc(p.path)} · ${label} ${p.count} 次"><span class="nm">${esc(pathLabel(p.path, names))}</span><span class="c">${p.count}</span></button>`;
  const head = list.slice(0, 3).map(chip).join('');
  const more = list.length > 3
    ? `<details class="path-more ${side}" data-fold="headmore:${side}:${esc(sessionKey ?? '')}"><summary title="${label}共 ${list.length} 条路径">+${list.length - 3}</summary>
      <div class="more-body">${list.slice(3).map(chip).join('')}</div></details>`
    : '';
  return {
    desc: `${label}共 ${list.length} 条路径；按调用参数的原始值分组，发出的调用不表示执行或产物成功`,
    data: `<span class="path-lab">${short}</span>` + head + more,
  };
}

/** 覆盖度按需说明：缺口如实列出，不计入失败。 @param {SessionSummary} s */
export function coverageHoverText(s) {
  const c = s.coverage;
  const parts = [`调用 ${c.calls_total} 次：已配对 ${c.calls_paired}，失败位已知 ${c.calls_error_known}，参数事实已知 ${c.calls_fact_known}`];
  if (c.calls_total - c.calls_fact_known > 0) {
    parts.push(`${c.calls_total - c.calls_fact_known} 次调用的参数与失败位从未提取（正文已回收或派生先于本列），路径与 Skill 明细不含它们`);
  }
  if (s.interrupts.unknown > 0) {
    parts.push(`${s.interrupts.unknown} 笔请求的中断判定缺失`);
  }
  return parts.join('；');
}

/** 默认对话时间线省略的请求：入口在性能组，展开清单按需打开，点条目走请求定位。
 *  这是请求记录的入口，不是第二套导航：序号与正文状态足以认出是哪一笔。
 *  @param {RequestRow[]} rows 当前窗口全部请求 @param {RequestRow[]} hidden 被省略的请求
 *  @param {string | null} sessionKey @param {boolean} open */
export function sessionHiddenFold(rows, hidden, sessionKey, open) {
  if (hidden.length === 0) return '';
  const items = hidden.map(item => {
    const ordinal = rows.findIndex(row => row.req_id === item.req_id) + 1;
    return `<button class="tool-row tool-link" data-summary-req="${item.req_id}">
      <span class="mono">${String(ordinal).padStart(2, '0')}</span><span class="muted">· ${esc(bodyStateText(item))}</span>
    </button>`;
  });
  return `<details class="hidden-more" data-fold="hidden:${esc(sessionKey ?? '')}"${open ? ' open' : ''}>
    <summary><span class="chev" aria-hidden="true"></span>无正文 <b>${hidden.length}</b> 笔</summary>
    <div class="more-body">${items.join('')}</div>
  </details>`;
}

/**
 * 会话头双列分组板：左资源、性能、结构，右工具、Skill、写入尝试、读取请求。
 * 分组只在有可展示事实时出现；整列都空时不保留空列与列间分隔线。
 * @param {SessionSummary | null} s @param {'idle' | 'loading' | 'ready' | 'absent'} status
 * @param {RequestRow[]} rows @param {RequestRow[]} hidden
 * @param {string | null} sessionKey @param {boolean} hiddenFoldOpen
 */
function sessionBoard(s, status, rows, hidden, sessionKey, hiddenFoldOpen) {
  const left = [];
  const right = [];
  const resource = resourceGroup(s, status, rows);
  if (resource !== null) left.push(cueRow(resource.desc, resource.data));
  const perf = performanceData(rows);
  const hiddenEntry = sessionHiddenFold(rows, hidden, sessionKey, hiddenFoldOpen);
  if (perf !== '' || hiddenEntry !== '') {
    // 重绘按 data-fold 恢复 open 属性时，展开类要在构建时带上，否则单行裁掉清单。
    left.push(cueRow('只统计当前已加载窗口；首字为 p50，未加载页不进计时',
      perf + hiddenEntry, hiddenFoldOpen ? ' open-wrap' : ''));
  }
  if (s !== null) {
    const structure = structureGroup(s);
    if (structure !== null) left.push(cueRow(structure.desc, structure.data));
  }
  if (s !== null) {
    const tools = toolsGroup(s, sessionKey);
    if (tools !== null) right.push(cueRow(tools.desc, tools.data, ' chips'));
    const written = pathGroup(s.paths.written, 'w', sessionKey);
    if (written !== null) right.push(cueRow(written.desc, written.data, ' chips'));
    const read = pathGroup(s.paths.read, 'r', sessionKey);
    if (read !== null) right.push(cueRow(read.desc, read.data, ' chips'));
  }
  if (left.length === 0 && right.length === 0) return '';
  const solo = left.length === 0 || right.length === 0 ? ' solo' : '';
  return `<div class="cue-board${solo}">
    ${left.length > 0 ? `<div class="cue-account">${left.join('')}</div>` : ''}
    ${right.length > 0 ? `<div class="cue-activity">${right.join('')}</div>` : ''}
  </div>`;
}

/** 会话头：标题行、身份行、双列分组板与定位提示。
 *  @param {{sessionKey: string | null, row: SessionRow | null, rows: RequestRow[], refreshedAt: number | null,
 *    missingReqId: number | null, offPageReqId: number | null, windowError: string | null,
 *    summary: SessionSummary | null, summaryStatus?: 'idle' | 'loading' | 'ready' | 'absent',
 *    hiddenRows?: RequestRow[], hiddenFoldOpen?: boolean,
 *    windowAnchor: 'start' | 'latest'}} input */
export function sessionHead(input) {
  const {
    sessionKey, row, rows, refreshedAt, missingReqId, offPageReqId, windowError,
    summary, summaryStatus = 'idle', windowAnchor,
  } = input;
  const hidden = input.hiddenRows ?? [];
  const unknown = sessionKey !== null && row === null;
  const first = rows[0] ?? null;
  const latest = rows[rows.length - 1] ?? null;
  return `<header class="session-head">
    <div class="head-top">
      <h1>${esc(row ? row.title || '（无标题）' : unknown ? '这个会话不在已加载列表里' : '未选择会话')}</h1>
      <div class="head-actions">
        ${refreshedAt !== null ? `<span class="muted">刷新于 ${esc(clock(refreshedAt))}</span>` : ''}
        <button class="chip-btn ghost ico" id="refresh-window" aria-label="刷新" title="重新读取当前窗口；输入变化会换发阅读版本">${icon('refresh', 20)}</button>
        ${windowAnchor === 'latest'
          ? '<button class="chip-btn ghost" id="jump-opposite" title="重建为会话最早一页，从头阅读">回到开头 ↑</button>'
          : '<button class="chip-btn ghost" id="jump-opposite" title="重建为会话最新一页，选中最新一笔">回到最新 ↓</button>'}
      </div>
    </div>
    <div class="session-facts">
      ${row && row.agents.length > 0 ? row.agents.map((/** @type {string} */ a) => `<span><b title="${esc(a)}">${esc(agentLabel(a))}</b></span>`).join('') : '<span class="muted">归属未知</span>'}
      <span class="mono" title="${esc(sessionKey ?? '')}">${esc(sessionKey === null ? '' : sessionKeyLabel(sessionKey))}</span>
      ${sessionKey !== null ? `<button class="fact-copy" id="copy-session" aria-label="复制当前会话 ID" title="复制当前会话 ID">${icon('copy', 14)}</button>` : ''}
      <span>已加载 <b>${rows.length}</b> 笔 Request</span>
      ${first && latest ? `<span>${esc(dayTime(first.started_ms))}–${esc(clock(latest.started_ms))}</span>` : ''}
    </div>
    ${summary !== null && summary.dirty ? '<div class="session-note warn"><span>部分组的派生还没追上输入：这里是上一次完成的结果。</span></div>' : ''}
    ${sessionBoard(summary, summaryStatus, rows, hidden, sessionKey, input.hiddenFoldOpen === true)}
    ${unknown ? `<div class="session-note warn"><span>↳</span><span>链接里的会话 key 不在已加载的会话里：可能是已淘汰、从未记录，或者还在后面的会话页。下面没有用别的会话顶替。</span></div>` : ''}
    ${missingReqId !== null ? `<div class="session-note warn"><span>↳</span><span>链接里的 Request ${missingReqId} 在当前库里不存在，也没有别名指向它。下面显示的是本会话的请求，不是那一笔。</span></div>` : ''}
    ${offPageReqId !== null ? `<div class="session-note"><span>↳</span><span>链接里的 Request ${offPageReqId} 存在，但不在当前载入窗口，右栏已显示它的详情。不自动扫描全部历史。<button class="chip-btn" id="switch-window">${windowAnchor === 'latest' ? '回到开头窗口' : '切到最新窗口'}</button></span></div>` : ''}
    ${windowError !== null ? `<div class="session-note warn"><span>↳</span><span>请求窗口读取失败：${esc(windowError)}。已加载内容保持不变，可重试。</span></div>` : ''}
  </header>`;
}

/**
 * 汇总条目列表：页题左侧返回钮与名称，右侧计数与失败数（mono，失败红字）；
 * 行内是调用序号与已有摘要，工具名与完整参数在配对页，不再逐行重复 chip。
 * 窗口外的行整行弱一档。labelOf 返回 {text, dim}，dim 即窗口外。
 * summaryOf 优先用条目自带摘要；调用方可同步复用已缓存的 detail/meta，不新增读取。
 * exec_ms 是执行等待窗口上界，缺值不显示，不拿请求耗时替代。
 * @param {{label: string, loading: boolean, error: string | null, data: import('../src/queries/session-summary').SummaryEntries | null, truncated?: boolean} | null} list
 * @param {(id: number) => {text: string, dim: boolean}} labelOf
 * @param {{count: number | null, errors: number}} [meta]
 * @param {(item: import('../src/queries/session-summary').SummaryEntry) => string | null} [summaryOf]
 */
export function railSummaryListHtml(list, labelOf, meta = { count: null, errors: 0 }, summaryOf = item => item.summary ?? null) {
  if (list === null) return '';
  let body;
  if (list.loading) {
    body = '<p class="note">正在读取条目…</p>';
  } else if (list.error !== null) {
    body = `<p class="note warn with-ico">${icon('empty-broken', 24)}<span>读取失败：${esc(list.error)}。重新点击条目可重试。</span></p>`;
  } else if (list.data !== null && 'requests' in list.data) {
    const rows = list.data.requests.map(item => {
      const label = labelOf(item.req_id);
      return `<button class="tool-row tool-link${label.dim ? ' dim' : ''}" data-summary-req="${item.req_id}">
        <span>${esc(label.text)}</span><span class="muted mono">· ${item.count} 次中断</span>
      </button>`;
    });
    body = rows.length > 0 ? rows.join('') : '<p class="note">没有支撑记录。</p>';
  } else if (list.data !== null && 'items' in list.data) {
    const rows = list.data.items.map(item => {
      const warn = item.state !== 'resolved'
        ? `<span class="tool-chip miss"><span>${esc(pairStateText(item.state))}</span></span>` : '';
      const label = labelOf(item.req_id);
      const summary = summaryOf(item);
      const call = `调用 #${item.ord}${summary === null || summary === '' ? '' : ` · ${esc(summary)}`}`;
      const dur = item.exec_ms === null || item.exec_ms === undefined
        ? '' : `<span class="dur" title="${esc(EXEC_MS_HINT)}"> · ${esc(compact(item.exec_ms))}</span>`;
      return `<button class="tool-row tool-link${label.dim ? ' dim' : ''}" data-summary-pair="1" data-owner="${item.req_id}" data-ord="${item.ord}">
        <span class="call">${call}</span>${warn}
        <span class="muted mono">${esc(label.text)}${dur}</span>
      </button>`;
    });
    body = rows.length > 0 ? rows.join('') : '<p class="note">没有支撑记录。</p>';
  } else {
    body = '<p class="note">没有支撑记录。</p>';
  }
  const count = meta.count !== null ? `${meta.count} 次` : '';
  const errors = meta.errors > 0
    ? `${count === '' ? '' : ' · '}<span class="err">${meta.errors} 次失败</span>` : '';
  return `<section class="rail-section">
    <div class="tool-page-head">
      <button class="chip-btn ghost" data-summary-back="1">← 返回会话</button>
      <span class="mono">${esc(list.label)}</span>
      ${count !== '' || errors !== '' ? `<span class="cnt mono">${count}${errors}</span>` : ''}
    </div>
    ${body}
    ${list.data !== null && 'items' in list.data && list.data.truncated
      ? '<p class="rail-note">条目超过上限，只列出前 1000 条。</p>' : ''}
  </section>`;
}
