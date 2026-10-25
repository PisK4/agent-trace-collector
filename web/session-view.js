// @ts-check
/**
 * 会话头与汇总折叠区的纯展示：会话行、窗口、汇总快照、展开状态与定位提示
 * 都是显式入参，不读 store、不发网络请求；汇总条目列表的网络与状态更新在
 * 控制器，这里只画。
 * @typedef {import('../src/queries/projection').RequestRow} RequestRow
 * @typedef {import('../src/queries/sessions').SessionRow} SessionRow
 * @typedef {import('../src/queries/session-summary').SessionSummary} SessionSummary
 */

import { toolTint } from './body-view.js';
import { esc } from './html.js';
import { kk, secs } from './rail-facts.js';
import { pairStateText } from './trace-pair.js';

/** @param {number} ms */
export const clock = (ms) => new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
/** @param {number} ms */
export const dayTime = (ms) => new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const AGENT_LABELS = /** @type {Record<string, string>} */ ({ claude: 'Claude Code', omp: 'OMP' });
/** @param {string} v */
export const agentLabel = (v) => AGENT_LABELS[v] ?? v;

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
  const genMs = rows.reduce((a, r) => {
    if (r.flow_ms !== null) return a + r.flow_ms;
    if (r.ms !== null && r.ttft_ms !== null) return a + Math.max(0, r.ms - r.ttft_ms);
    return a;
  }, 0);
  const outTok = rows.reduce((a, r) => a + (r.out_tok ?? 0), 0);
  return {
    median, average,
    speed: genMs > 0 && outTok > 0 ? Math.round(outTok / (genMs / 1000)) : null,
  };
}

/** 会话合计行：token、费用与缓存命中是会话口径；覆盖缺口进悬停。 @param {SessionSummary} s */
export function sessionTotalsHtml(s) {
  const t = s.totals;
  if (t.in_tok === null && t.out_tok === null && t.cost === null) return '';
  const parts = [`会话合计 <span class="num">${kk(t.in_tok)}</span> 提示 · <span class="num">${kk(t.out_tok)}</span> 输出`];
  if (t.cost !== null) parts.push(`$<span class="num">${t.cost.toFixed(4)}</span>`);
  if (t.cache_hit !== null) parts.push(`缓存命中 <span class="num">${Math.round(t.cache_hit * 100)}%</span>`);
  const title = [
    t.cost_absent > 0 ? `${t.cost_absent} 笔未取得费用` : null,
    '缓存命中＝Σcache_read ÷ Σ(in_tok + cache_read)，只计两个读数都在的请求',
    t.cache_hit === null ? '本次没有可用分母，不给数' : null,
  ].filter(Boolean).join('；');
  return `<span class="sum" title="${esc(title)}">${parts.join(' · ')}</span>`;
}

/** 折叠区收起行的覆盖度悬停：缺口如实列出，不计入失败。 @param {SessionSummary} s */
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

/** @param {string} path @param {string[]} all 同组全部路径：同名 basename 并列时补上一段。 */
export function pathLabel(path, all) {
  const parts = path.split('/').filter(Boolean);
  const base = parts[parts.length - 1] ?? path;
  if (all.filter(other => other.split('/').pop() === base).length > 1 && parts.length >= 2) {
    return `${parts[parts.length - 2]}/${base}`;
  }
  return base;
}

/** 工具 chip 行：失败数只在非零时出现；未判定与覆盖缺口进悬停。 @param {SessionSummary} s */
export function summaryToolChips(s) {
  if (s.tools.length === 0) return '';
  const chips = s.tools.map(t => {
    const warn = t.errors > 0 ? `<span class="err">${t.errors} 失败</span>` : '';
    const unknown = t.count - t.error_known;
    const title = [
      `点击定位 ${t.name} 的 ${t.count} 次调用`,
      t.count - t.paired > 0 ? `${t.count - t.paired} 次未配对` : null,
      unknown > 0 ? `${unknown} 次结果未判定（不计入失败）` : null,
    ].filter(Boolean).join(' · ');
    return `<button class="tool-chip ${toolTint(t.name)}" data-summary-tool="${esc(t.name)}" title="${esc(title)}"><span>${esc(t.name)}</span><span class="n">${t.count}</span>${warn}</button>`;
  }).join('');
  return `<div class="tool-row">${chips}</div>`;
}

/** 涉及路径：单行流式双色 chip，写入=橙、读取=蓝，各前三加同色 +N 展开。 @param {SessionSummary} s */
export function summaryPathFlow(s) {
  const written = s.paths.written;
  const read = s.paths.read;
  if (written.length === 0 && read.length === 0) return '';
  const writtenNames = written.map(p => p.path);
  const readNames = read.map(p => p.path);
  const chip = (/** @type {{path: string, count: number}} */ p, /** @type {'w' | 'r'} */ side) => {
    const label = side === 'w' ? '写入尝试' : '读取请求';
    const names = side === 'w' ? writtenNames : readNames;
    return `<button class="path-chip ${side}" data-summary-path="${esc(p.path)}" data-summary-side="${side}"
      title="${esc(p.path)} · ${label} ${p.count} 次"><span>${esc(pathLabel(p.path, names))}</span><span class="c">${p.count}</span></button>`;
  };
  const group = (/** @type {{path: string, count: number}[]} */ list, /** @type {'w' | 'r'} */ side) => {
    const head = list.slice(0, 3).map(p => chip(p, side)).join('');
    if (list.length <= 3) return head;
    const label = side === 'w' ? '写入尝试' : '读取请求';
    return `${head}<details class="path-more ${side}"><summary title="${label}共 ${list.length} 条路径">+${list.length - 3}</summary>
      <div class="more-body">${list.slice(3).map(p => chip(p, side)).join('')}</div></details>`;
  };
  const sep = written.length > 0 && read.length > 0 ? '<i class="flow-sep"></i>' : '';
  return `<div class="path-flow">${group(written, 'w')}${sep}${group(read, 'r')}</div>`;
}

/** 显式 Skill 调用：黄色系 chip，前三加二级展开；没有调用整区不渲染。 @param {SessionSummary} s */
export function summarySkills(s) {
  if (s.skills.length === 0) return '';
  const chip = (/** @type {{name: string, count: number}} */ k) =>
    `<button class="tool-chip tint-skill" data-summary-skill="${esc(k.name)}" title="点击定位该 Skill 的 ${k.count} 次调用"><span>${esc(k.name)}</span><span class="n">${k.count}</span></button>`;
  const head = s.skills.slice(0, 3).map(chip).join('');
  const rest = s.skills.slice(3);
  const more = rest.length > 0
    ? `<details class="path-more s"><summary title="显式 Skill 调用共 ${s.skills.length} 个">+${rest.length}</summary>
        <div class="more-body">${rest.map(chip).join('')}</div></details>`
    : '';
  return `<div class="sum-skills">${head}${more}</div>`;
}

/** 结构行：主链/旁路与峰值常驻，子代理、重试与多模型足迹非零才出现。 @param {SessionSummary} s */
export function summaryStructure(s) {
  const st = s.structure;
  const parts = [`主链 <b>${st.main}</b>`, `旁路 <b>${st.bypass}</b>`];
  if (st.context_peak_pct !== null) parts.push(`上下文峰值 <b>${st.context_peak_pct}%</b>`);
  if (st.subagent_actors > 0) parts.push(`子代理 <b>${st.subagent_actors}</b> 个 · <b>${st.subagent_requests}</b> 笔`);
  if (st.retries > 0) parts.push(`重试 <b>${st.retries}</b> 笔`);
  if (st.models.length > 1) parts.push(`模型 <b>${st.models.length}</b>`);
  const title = [
    '旁路＝分类器与标题生成等排除请求',
    st.context_peak_pct !== null ? '上下文峰值＝max(prompt_tokens ÷ prompt_window)' : '上下文峰值没有可用分母，不给数',
    st.models.length > 1 ? `模型＝${st.models.map(m => `${m.name} ×${m.count}`).join(' · ')}` : null,
  ].filter(Boolean).join('；');
  return `<div class="sum-structure" title="${esc(title)}">${parts.join(' · ')}</div>`;
}

/** session-head 内的汇总折叠区：收起一行核心数，展开四个分区。
 *  @param {SessionSummary | null} s @param {string | null} sessionKey @param {boolean} open 折叠区当前开合（folds 表按 `summary:<key>` 记） */
export function sessionSummaryFold(s, sessionKey, open) {
  if (s === null) return '';
  const failures = s.tools.reduce((a, t) => a + t.errors, 0);
  const writtenPaths = s.paths.written.length;
  const readPaths = s.paths.read.length;
  if (s.coverage.calls_total === 0 && s.interrupts.count === 0
    && writtenPaths === 0 && readPaths === 0) return '';
  const key = `summary:${sessionKey ?? ''}`;
  return `<details class="rail-fold session-fold" data-fold="${esc(key)}"${open ? ' open' : ''}>
    <summary><span class="sum-line" title="${esc(coverageHoverText(s))}"><b>${s.coverage.calls_total}</b> 次工具
      ${failures > 0 ? `· <button class="warn-n" data-summary-failures="1" title="点击定位这 ${failures} 次失败调用">${failures} 失败</button> ` : ''}· <b>${s.interrupts.count}</b> 次中断
      · 写入尝试 <b>${writtenPaths}</b> / 读取请求 <b>${readPaths}</b> 条路径</span></summary>
    <div class="fold-body">
      ${s.dirty ? '<p class="note warn">部分组的派生还没追上输入：这里是上一次完成的结果。</p>' : ''}
      ${summaryToolChips(s)}${summaryPathFlow(s)}${summarySkills(s)}${summaryStructure(s)}
    </div>
  </details>`;
}

/** 会话头：标题、身份行、窗口合计与汇总折叠区、视图操作行与定位提示。
 *  @param {{sessionKey: string | null, row: SessionRow | null, rows: RequestRow[], refreshedAt: number | null,
 *    missingReqId: number | null, offPageReqId: number | null, windowError: string | null,
 *    summary: SessionSummary | null, summaryFoldOpen: boolean}} input */
export function sessionHead(input) {
  const { sessionKey, row, rows, refreshedAt, missingReqId, offPageReqId, windowError, summary } = input;
  const unknown = sessionKey !== null && row === null;
  const first = rows[0] ?? null;
  const latest = rows[rows.length - 1] ?? null;
  // 窗口口径合计只在汇总快照未就绪时兜底：ready 后由会话合计顶替。
  const totalIn = rows.reduce((a, r) => a + (r.in_tok ?? 0) + (r.cache_read ?? 0) + (r.cache_write ?? 0), 0);
  const totalOut = rows.reduce((a, r) => a + (r.out_tok ?? 0), 0);
  const priced = rows.filter(r => r.cost_state === 'priced' || r.cost_state === 'zero');
  const totalCost = priced.reduce((a, r) => a + (r.cost ?? 0), 0);
  const hasUsage = rows.some(r => r.in_tok !== null || r.out_tok !== null);
  const timing = timingSummary(rows);
  const timingParts = [
    timing.median !== null ? `首字 p50 ${secs(timing.median)}` : null,
    timing.average !== null ? `平均时长 ${secs(timing.average)}` : null,
    timing.speed !== null ? `输出 ${timing.speed} tok/s` : null,
  ].filter(Boolean);
  return `<header class="session-head">
    <h1>${esc(row ? row.title || '（无标题）' : unknown ? '这个会话不在已加载列表里' : '未选择会话')}</h1>
    <div class="session-facts">
      ${row && row.agents.length > 0 ? row.agents.map((/** @type {string} */ a) => `<span><b title="${esc(a)}">${esc(agentLabel(a))}</b></span>`).join('') : '<span class="muted">归属未知</span>'}
      <span class="mono" title="${esc(sessionKey ?? '')}">${esc(sessionKey === null ? '' : sessionKeyLabel(sessionKey))}</span>
      ${sessionKey !== null ? '<button class="fact-copy" id="copy-session" aria-label="复制当前会话 ID" title="复制当前会话 ID">⧉</button>' : ''}
      <span>已加载 <b>${rows.length}</b> 笔 Request</span>
      ${first && latest ? `<span>${esc(dayTime(first.started_ms))}–${esc(clock(latest.started_ms))}</span>` : ''}
      ${timingParts.length > 0 ? `<span class="sum">${timingParts.join(' · ')}</span>` : ''}
      ${summary !== null ? sessionTotalsHtml(summary)
      : hasUsage
        ? `<span class="sum" title="汇总快照读取中；这是已加载窗口的相加，不是会话口径">已加载相加：${kk(totalIn)} 提示 · ${kk(totalOut)} 输出 · $${totalCost.toFixed(4)}${priced.length < rows.length ? ` · ${rows.length - priced.length} 笔未取得费用` : ''}</span>`
        : '<span class="sum muted">这批记录没有报告的用量，合计为空</span>'}
    </div>
    ${sessionSummaryFold(summary, sessionKey, input.summaryFoldOpen)}
    <div class="view-row">
      <span class="grow"></span>
      ${refreshedAt !== null ? `<span class="muted" style="font-size:10.5px">刷新于 ${esc(clock(refreshedAt))}</span>` : ''}
      <button class="chip-btn" id="refresh-window" title="重新读取最近窗口；输入变化会换发阅读版本">刷新</button>
      <button class="chip-btn" id="jump-latest">回到最新 ↓</button>
    </div>
    ${unknown ? `<div class="session-note warn"><span>↳</span><span>链接里的会话 key 不在已加载的会话里：可能是已淘汰、从未记录，或者还在后面的会话页。下面没有用别的会话顶替。</span></div>` : ''}
    ${missingReqId !== null ? `<div class="session-note warn"><span>↳</span><span>链接里的 Request ${missingReqId} 在当前库里不存在，也没有别名指向它。下面显示的是本会话的请求，不是那一笔。</span></div>` : ''}
    ${offPageReqId !== null ? `<div class="session-note"><span>↳</span><span>链接里的 Request ${offPageReqId} 存在，但不在当前载入窗口（可能在更早的历史里）；从顶部加载更早记录后可以选到它，右栏已显示它的详情。不自动扫描全部历史。</span></div>` : ''}
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
        <span class="tool-chip call" title="${esc(item.tool_name ?? '')}"><span>${esc(item.tool_name ?? 'unknown')} · 调用 #${item.ord}</span></span>
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
