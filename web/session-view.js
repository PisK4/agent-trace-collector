// @ts-check
/**
 * 会话头与双列分组的纯展示：会话行、窗口、汇总快照、分组显隐与定位提示
 * 都是显式入参，不读 store、不发网络请求；汇总条目列表的网络与状态更新在
 * 控制器，这里只画。
 * @typedef {import('../src/queries/projection').RequestRow} RequestRow
 * @typedef {import('../src/queries/sessions').SessionRow} SessionRow
 * @typedef {import('../src/queries/session-summary').SessionSummary} SessionSummary
 */

import { toolTint } from './body-view.js';
import { esc } from './html.js';
import { kk } from './rail-facts.js';
import { bodyStateText } from './row-summary.js';
import { secs } from './duration.js';
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
  return `<div class="sess-fold"><button class="chip-btn" data-fold-toggle="1">${esc(label)}</button></div>`;
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

/** 分组图标：每组一枚 14px 线性图形，颜色随文字；名称承担含义，图标只帮助定位。 */
const GROUP_ICONS = {
  resource: '<ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v6c0 4 14 4 14 0V5M5 11v6c0 4 14 4 14 0v-6"/>',
  structure: '<path d="M6 4v16M6 8h9a3 3 0 0 1 3 3v9"/><circle cx="6" cy="4" r="2"/><circle cx="6" cy="20" r="2"/><circle cx="18" cy="20" r="2"/>',
  performance: '<circle cx="12" cy="13" r="8"/><path d="M9 2h6M12 5V2M12 13l3-4"/>',
  tools: '<path d="M14 5a6 6 0 0 0-7 8L3 17a3 3 0 0 0 4 4l5-5a6 6 0 0 0 7-8l-4 4-3-3 4-4Z"/>',
  skills: '<path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z"/>',
  write: '<path d="m4 16 11-11 4 4L8 20H4v-4ZM13 7l4 4"/>',
  read: '<path d="M12 6C9 4 5 4 2 5v14c3-1 7-1 10 1 3-2 7-2 10-1V5c-3-1-7-1-10 1v14"/>',
};

/** @typedef {{kind: keyof typeof GROUP_ICONS, label: string, desc: string, data: string}} GroupCue */
/**
 * 分组标题：图标加短标签。统计范围、口径与覆盖缺口放在 data-desc 里，
 * 悬停与键盘聚焦（tabindex）都能看到；常驻正文不写解释句。
 * @param {keyof typeof GROUP_ICONS} kind @param {string} label @param {string} desc
 */
function groupHead(kind, label, desc) {
  return `<div class="cue" tabindex="0" data-desc="${esc(desc)}" aria-label="${esc(`${label}：${desc}`)}">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GROUP_ICONS[kind]}</svg>
    <strong>${esc(label)}</strong>
  </div>`;
}

/** @param {keyof typeof GROUP_ICONS} kind @param {string} label @param {string} desc @param {string} data @param {string} [extraClass] */
function cueRow(kind, label, desc, data, extraClass = '') {
  return `<section class="cue-row">${groupHead(kind, label, desc)}<div class="cue-data${extraClass}">${data}</div></section>`;
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
      t.in_tok !== null ? `提示 <b>${kk(t.in_tok)}</b>` : '',
      t.out_tok !== null ? `输出 <b>${kk(t.out_tok)}</b>` : '',
      t.cost !== null ? `费用 <b>$${t.cost.toFixed(4)}</b>` : '',
      t.cache_hit !== null ? `缓存 <b>${Math.round(t.cache_hit * 100)}%</b>` : '',
    ].filter(Boolean).join(' · ')}</span>`;
    return { kind: 'resource', label: '资源', desc, data };
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
    `提示 <b>${kk(totalIn)}</b>`,
    `输出 <b>${kk(totalOut)}</b>`,
    `费用 <b>$${totalCost.toFixed(4)}</b>`,
  ].join(' · ')}</span><span class="scope-tag">已加载窗口</span>`;
  return { kind: 'resource', label: '资源', desc, data };
}

/**
 * 结构组：主链/旁路与峰值常驻，子代理、重试与多模型足迹非零才出现。
 * @param {SessionSummary} s
  * @returns {GroupCue | null}
 */
function structureGroup(s) {
  const st = s.structure;
  const data = [
    st.main !== null ? `主链 <b>${st.main}</b> · 旁路 <b>${st.bypass}</b>` : '',
    st.context_peak_pct !== null ? `峰值 <b>${st.context_peak_pct}%</b>` : '',
    st.subagent_actors > 0 ? `子代理 <b>${st.subagent_actors}</b> 个 · <b>${st.subagent_requests}</b> 笔` : '',
    st.retries !== null && st.retries > 0 ? `重试 <b>${st.retries}</b> 笔` : '',
    st.models.length > 1 ? `模型 <b>${st.models.length}</b>` : '',
  ].filter(Boolean).join(' · ');
  if (data === '') return null;
  const desc = [
    '整个会话',
    '旁路＝分类器与标题生成等排除请求',
    st.context_peak_pct !== null ? '上下文峰值＝max(prompt_tokens ÷ prompt_window)' : '上下文峰值没有可用分母，不给数',
    st.models.length > 1 ? `模型＝${st.models.map(m => `${m.name} ×${m.count}`).join(' · ')}` : null,
  ].filter(Boolean).join('；');
  return { kind: 'structure', label: '结构', desc, data: `<span class="cue-line">${data}</span>` };
}

/** 性能组的计时读数；口径是当前已加载窗口，首字为 p50（说明进组标题）。 @param {RequestRow[]} rows */
function performanceData(rows) {
  const timing = timingSummary(rows);
  const parts = [
    timing.median !== null ? `首字 <b>${secs(timing.median)}</b>` : '',
    timing.average !== null ? `平均 <b>${secs(timing.average)}</b>` : '',
    timing.speed !== null ? `<b>${timing.speed}</b> tok/s` : '',
  ].filter(Boolean);
  return parts.length === 0 ? '' : `<span class="cue-line">${parts.join(' · ')}</span>`;
}

/** 工具组：chip 沿用身份色，按调用次数取前三直接可见，其余进 +N 展开；
 *  失败数只在非零时出现，0 次中断不占位。调用总数与覆盖情况（未配对、未判定、
 *  中断判定缺失）进标题的按需说明。
 *  @param {SessionSummary} s  * @returns {GroupCue | null}
 */
function toolsGroup(s) {
  const chip = (/** @type {{name: string, count: number, errors: number, paired: number, error_known: number}} */ t) => {
    const warn = t.errors > 0 ? `<span class="err">${t.errors} 失败</span>` : '';
    const unknown = t.count - t.error_known;
    const title = [
      `点击定位 ${t.name} 的 ${t.count} 次调用`,
      t.count - t.paired > 0 ? `${t.count - t.paired} 次未配对` : null,
      unknown > 0 ? `${unknown} 次结果未判定（不计入失败）` : null,
    ].filter(Boolean).join(' · ');
    return `<button class="tool-chip ${toolTint(t.name)}" data-summary-tool="${esc(t.name)}" title="${esc(title)}"><span>${esc(t.name)}</span><span class="n">${t.count}</span>${warn}</button>`;
  };
  const head = s.tools.slice(0, 3).map(chip).join('');
  const rest = s.tools.slice(3);
  const more = rest.length > 0
    ? `<details class="path-more t"><summary title="工具共 ${s.tools.length} 把">+${rest.length}</summary><div class="more-body">${rest.map(chip).join('')}</div></details>`
    : '';
  const failures = s.tools.reduce((a, t) => a + t.errors, 0);
  const data = [
    head + more,
    failures > 0 ? `<button class="warn-n" data-summary-failures="1" title="点击定位这 ${failures} 次失败调用">⚠ ${failures} 失败</button>` : '',
    s.interrupts.count > 0 ? `<span class="interrupt">已识别用户中断 <b>${s.interrupts.count}</b></span>` : '',
  ].filter(Boolean).join('');
  if (data === '') return null;
  return { kind: 'tools', label: '工具', desc: `整个会话：${coverageHoverText(s)}`, data };
}

/** Skill 组：黄色系 chip，前三加二级展开；没有显式调用整组不渲染。
 *  @param {SessionSummary} s  * @returns {GroupCue | null}
 */
function skillsGroup(s) {
  if (s.skills.length === 0) return null;
  const chip = (/** @type {{name: string, count: number}} */ k) =>
    `<button class="tool-chip tint-skill" data-summary-skill="${esc(k.name)}" title="点击定位该 Skill 的 ${k.count} 次调用"><span>${esc(k.name)}</span><span class="n">${k.count}</span></button>`;
  const head = s.skills.slice(0, 3).map(chip).join('');
  const rest = s.skills.slice(3);
  const more = rest.length > 0
    ? `<details class="path-more s"><summary title="显式 Skill 调用共 ${s.skills.length} 个">+${rest.length}</summary>
        <div class="more-body">${rest.map(chip).join('')}</div></details>`
    : '';
  return {
    kind: 'skills', label: 'Skill',
    desc: `显式调用限定：共 ${s.skills.length} 个显式 Skill 调用；技能经 system 声明进入上下文而未发生 Skill 调用时不计`,
    data: head + more,
  };
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
 * 计数是发出的调用，不表示执行或产物成功。
 * @param {{path: string, count: number}[]} list @param {'w' | 'r'} side
  * @returns {GroupCue | null}
 */
function pathGroup(list, side) {
  if (list.length === 0) return null;
  const label = side === 'w' ? '写入尝试' : '读取请求';
  const names = list.map(p => p.path);
  const chip = (/** @type {{path: string, count: number}} */ p) =>
    `<button class="path-chip ${side}" data-summary-path="${esc(p.path)}" data-summary-side="${side}"
      title="${esc(p.path)} · ${label} ${p.count} 次"><span>${esc(pathLabel(p.path, names))}</span><span class="c">${p.count}</span></button>`;
  const head = list.slice(0, 3).map(chip).join('');
  const more = list.length > 3
    ? `<details class="path-more ${side}"><summary title="${label}共 ${list.length} 条路径">+${list.length - 3}</summary>
      <div class="more-body">${list.slice(3).map(chip).join('')}</div></details>`
    : '';
  return {
    kind: side === 'w' ? 'write' : 'read', label,
    desc: `${label}共 ${list.length} 条路径；按调用参数的原始值分组，发出的调用不表示执行或产物成功`,
    data: head + more,
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
    <summary>无正文 <b>${hidden.length}</b> 笔</summary>
    <div class="more-body">${items.join('')}</div>
  </details>`;
}

/**
 * 会话头双列分组板：左资源、结构、性能，右工具、Skill、写入尝试、读取请求。
 * 分组只在有可展示事实时出现；整列都空时不保留空列与列间分隔线。
 * @param {SessionSummary | null} s @param {'idle' | 'loading' | 'ready' | 'absent'} status
 * @param {RequestRow[]} rows @param {RequestRow[]} hidden
 * @param {string | null} sessionKey @param {boolean} hiddenFoldOpen
 */
function sessionBoard(s, status, rows, hidden, sessionKey, hiddenFoldOpen) {
  const left = [];
  const right = [];
  const resource = resourceGroup(s, status, rows);
  if (resource !== null) left.push(cueRow(resource.kind, resource.label, resource.desc, resource.data));
  if (s !== null) {
    const structure = structureGroup(s);
    if (structure !== null) left.push(cueRow(structure.kind, structure.label, structure.desc, structure.data));
  }
  const perf = performanceData(rows);
  const hiddenEntry = sessionHiddenFold(rows, hidden, sessionKey, hiddenFoldOpen);
  if (perf !== '' || hiddenEntry !== '') {
    // 重绘按 data-fold 恢复 open 属性时，展开类要在构建时带上，否则单行裁掉清单。
    left.push(cueRow('performance', '性能', '只统计当前已加载窗口；首字为 p50，未加载页不进计时',
      perf + hiddenEntry, hiddenFoldOpen ? ' open-wrap' : ''));
  }
  if (s !== null) {
    const tools = toolsGroup(s);
    if (tools !== null) right.push(cueRow(tools.kind, tools.label, tools.desc, tools.data));
    const skills = skillsGroup(s);
    if (skills !== null) right.push(cueRow(skills.kind, skills.label, skills.desc, skills.data));
    const written = pathGroup(s.paths.written, 'w');
    if (written !== null) right.push(cueRow(written.kind, written.label, written.desc, written.data));
    const read = pathGroup(s.paths.read, 'r');
    if (read !== null) right.push(cueRow(read.kind, read.label, read.desc, read.data));
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
        <button class="chip-btn" id="refresh-window" title="重新读取当前窗口；输入变化会换发阅读版本">刷新</button>
        ${windowAnchor === 'latest'
          ? '<button class="chip-btn" id="jump-opposite" title="重建为会话最早一页，从头阅读">回到开头 ↑</button>'
          : '<button class="chip-btn" id="jump-opposite" title="重建为会话最新一页，选中最新一笔">回到最新 ↓</button>'}
      </div>
    </div>
    <div class="session-facts">
      ${row && row.agents.length > 0 ? row.agents.map((/** @type {string} */ a) => `<span><b title="${esc(a)}">${esc(agentLabel(a))}</b></span>`).join('') : '<span class="muted">归属未知</span>'}
      <span class="mono" title="${esc(sessionKey ?? '')}">${esc(sessionKey === null ? '' : sessionKeyLabel(sessionKey))}</span>
      ${sessionKey !== null ? '<button class="fact-copy" id="copy-session" aria-label="复制当前会话 ID" title="复制当前会话 ID">⧉</button>' : ''}
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

/** 右栏的会话汇总条目列表：支撑记录逐项可跳。
 *  @param {{kind: string, param: string, label: string, loading: boolean, error: string | null,
 *    data: import('../src/queries/session-summary').SummaryEntries | null} | null} list
 *  @param {(id: number) => string} labelOf 请求的窗口内序号标签 */
export function railSummaryListHtml(list, labelOf) {
  if (list === null) return '';
  let body;
  if (list.loading) {
    body = '<p class="note">正在读取条目…</p>';
  } else if (list.error !== null) {
    body = `<p class="note warn">读取失败：${esc(list.error)}。重新点击条目可重试。</p>`;
  } else if (list.data !== null && 'requests' in list.data) {
    const rows = list.data.requests.map(item =>
      `<button class="tool-row tool-link" data-summary-req="${item.req_id}">
        <span>${esc(labelOf(item.req_id))}</span><span class="muted">· ${item.count} 次中断</span>
      </button>`);
    body = rows.length > 0 ? rows.join('') : '<p class="note">没有支撑记录。</p>';
  } else if (list.data !== null && 'items' in list.data) {
    const rows = list.data.items.map(item => {
      const warn = item.state !== 'resolved'
        ? `<span class="tool-chip miss"><span>${esc(pairStateText(item.state))}</span></span>` : '';
      return `<button class="tool-row tool-link" data-summary-pair="1" data-owner="${item.req_id}" data-ord="${item.ord}">
        <span class="tool-chip call ${toolTint(item.tool_name ?? '')}" title="${esc(item.tool_name ?? '')}"><span>${esc(item.tool_name ?? 'unknown')} · 调用 #${item.ord}</span></span>
        <span class="muted">${esc(labelOf(item.req_id))}</span>${warn}
      </button>`;
    });
    body = rows.length > 0 ? rows.join('') : '<p class="note">没有支撑记录。</p>';
  } else {
    body = '<p class="note">没有支撑记录。</p>';
  }
  return `<section class="rail-section">
    <div class="tool-page-head">
      <button class="chip-btn" data-summary-back="1">← 返回会话</button>
      <span class="mono">${esc(list.label)}</span>
    </div>
    ${body}
    ${list.data !== null && 'items' in list.data && list.data.truncated
      ? '<p class="rail-note">条目超过上限，只列出前 1000 条。</p>' : ''}
  </section>`;
}
