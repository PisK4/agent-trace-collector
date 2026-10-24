// @ts-check
import { esc, toolTint } from './body-view.js';

/**
 * 工具配对页：一次调用的两端在右栏同屏就地阅读，Call 在上、Result 在下，
 * 默认同时展开。纯字符串拼接，不碰 DOM、不发请求；读取与失效由 app 装配。
 * 视觉与交互边界：复用正文详情的 body-panel/pre.raw 组件语言，不分左右栏；
 * 两端身份与承载请求只以文本显示，不提供跳转到别处阅读的按钮。
 * 面板头用与中栏同款的工具色类 chip（配对 result 沿用 call 的颜色，未配对中性）。
 */

/**
 * 关联状态的固定文案。
 * @param {string} state
 */
export function pairStateText(state) {
  if (state === 'resolved') return '已确认配对';
  if (state === 'pending') return '结果位置待定';
  if (state === 'ambiguous') return '结果有多个候选，未配对';
  return '还没有见到结果';
}

/**
 * 正文加载状态的固定文案。
 * @param {string} state
 */
export function loadStateText(state) {
  if (state === 'not_loaded') return '待读取（打开配对页自动读取一次）';
  if (state === 'loading' || state === 'loaded') return state === 'loaded' ? '已读取' : '正在读取';
  if (state === 'invalid_location') return '结果位置无效，不回退猜测';
  if (state === 'available') return '已读取';
  return '读取失败，可重试';
}

/**
 * is_error 三态：true 为失败、false 为上游未标错、null 为未报告；resolved 不当成功。
 * @param {boolean | null | undefined} isError
 */
export function isErrorText(isError) {
  if (isError === true) return '工具执行失败（is_error=true）';
  if (isError === false) return '上游未标记错误（is_error=false）';
  return '上游未报告错误标记（is_error 缺失，不等于成功）';
}

/**
 * 调用参数按缩进 JSON 展示：能解析就格式化，不能就按原文，不猜语义。
 * 与结果正文共用 pre.raw 样式。
 * @param {string} inputText
 * @returns {string}
 */
export function prettyJson(inputText) {
  try {
    return JSON.stringify(JSON.parse(inputText), null, 2) ?? inputText;
  } catch {
    return inputText;
  }
}

/**
 * Edit 调用的对照渲染：old_string 与 new_string 各成一个红绿 soft 着色块（空串不渲染），
 * 其余键维持缩进 JSON，原始参数 JSON 折叠保留。非 Edit 或参数不可解析返回 null。
 * @param {string} name @param {string} inputText @param {string} foldKey
 * @returns {string | null}
 */
export function editCompareHtml(name, inputText, foldKey) {
  if (name !== 'Edit') return null;
  let args = null;
  try { args = JSON.parse(inputText); } catch { return null; }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null;
  const record = /** @type {Record<string, unknown>} */ (args);
  const oldS = typeof record.old_string === 'string' && record.old_string !== '' ? record.old_string : null;
  const newS = typeof record.new_string === 'string' && record.new_string !== '' ? record.new_string : null;
  if (oldS === null && newS === null) return null;
  const rest = { ...record };
  delete rest.old_string;
  delete rest.new_string;
  const restHtml = Object.keys(rest).length > 0
    ? `<pre class="raw" tabindex="0">${esc(JSON.stringify(rest, null, 2) ?? '')}</pre>` : '';
  const block = (/** @type {string} */ cls, /** @type {string} */ label, /** @type {string | null} */ text) =>
    text === null ? '' : `<div class="edit-block ${cls}"><span class="edit-tag">${esc(label)}</span><pre class="raw" tabindex="0">${esc(text)}</pre></div>`;
  const fold = `<details class="rail-fold sub" data-fold="${esc(foldKey)}"><summary>原始参数 JSON</summary><div class="fold-body"><pre class="raw" tabindex="0">${esc(prettyJson(inputText))}</pre></div></details>`;
  return `${restHtml}${block('old', 'old_string', oldS)}${block('new', 'new_string', newS)}${fold}`;
}

/**
 * 配对页主体。关联与正文加载分立；未确认关联不显示结果正文，
 * 读取失败保留重试，两端默认展开，身份只作文本。
 * @param {{
 *   owner: number,
 *   ownerLabel: string,
 *   call: {id?: string, name: string, inputText: string, ord: number, path?: string},
 *   pair: {state: string, result_req: number | null, result_ord: number | null, result_path: string | null} | null,
 *   reading: import('../src/reading').ToolResultReading | null,
 *   carrierLabel: string | null,
 * }} input
 * @returns {string}
 */
export function renderTracePair(input) {
  const pair = input.pair ?? null;
  const pairState = pair === null || pair === undefined ? 'unpaired' : pair.state;
  const reading = input.reading ?? null;
  const loadState = reading === null ? 'not_loaded'
    : reading.state === 'available' ? 'loaded' : reading.state;
  const carrier = pair !== null && pair.state === 'resolved' && pair.result_req !== null
    ? input.carrierLabel ?? `请求 ${pair.result_req}` : null;
  // 正常态（已配对且正文已读或待读取）不挂状态行；结果承载由结果面板的 bp-meta 承担。
  const loadAbnormal = loadState !== 'not_loaded' && loadState !== 'loaded' && loadState !== 'pending'
    && loadState !== 'ambiguous' && loadState !== 'unpaired';
  const statusBits = [
    pairState !== 'resolved' || loadAbnormal ? `关联 ${esc(pairStateText(pairState))}` : '',
    loadAbnormal ? `正文加载 ${esc(loadStateText(loadState))}` : '',
  ].filter(Boolean).join(' · ');
  const status = statusBits === '' ? '' : `<div class="bp-meta">${statusBits}</div>`;
  const callName = input.call.name || '未命名工具';
  const compare = editCompareHtml(input.call.name, input.call.inputText, `edit:${input.owner}:${input.call.ord}`);
  const callBody = compare !== null ? compare
    : `<pre class="raw" tabindex="0">${esc(prettyJson(input.call.inputText))}</pre>`;
  const callPanel = `<div class="body-panel">
    <div class="bp-head">
      <span class="kind bp-kind ${toolTint(input.call.name)}">${esc(callName)}</span>
      <span class="bp-path">${esc(input.call.path ?? 'reply')}</span>
    </div>
    <div class="bp-meta"><span>请求 ${esc(input.ownerLabel)} · 调用 #${input.call.ord}</span></div>
    ${callBody}
  </div>`;
  /** @type {string} */
  let resultBody;
  if (reading === null) {
    if (pair !== null && pair.state === 'resolved' && pair.result_req !== null) {
      resultBody = `<p class="note">结果已确认配对，正文待读取；进入配对页会自动读取一次。</p>
        <div class="conv-tools">
          <button class="chip-btn" data-tool-read="${input.owner}" data-call-ord="${input.call.ord}">读取结果正文</button>
        </div>`;
    } else {
      resultBody = `<p class="note">${esc(pairStateText(pairState))}；没有可读取的结果正文。</p>`;
    }
  } else if (reading.state === 'available') {
    // is_error=false 是上游明确给出的正常态，静默；true 与未报告才挂标签。
    resultBody = `<pre class="raw" tabindex="0">${esc(typeof reading.content === 'string' ? reading.content : JSON.stringify(reading.content, null, 2) ?? '')}</pre>
      ${reading.is_error === false ? '' : `<p class="note">${esc(isErrorText(reading.is_error))}</p>`}`;
  } else if (reading.state === 'pending') {
    resultBody = '<p class="note">结果位置待定：派生还没算完，不猜配对。</p>';
  } else if (reading.state === 'ambiguous') {
    resultBody = '<p class="note">结果有多个候选，未配对；不显示任何候选正文。</p>';
  } else if (reading.state === 'unpaired') {
    resultBody = '<p class="note">还没有见到这一调用的结果。</p>';
  } else if (reading.state === 'invalid_location') {
    resultBody = `<p class="note warn">结果位置无效（${esc(reading.reason ?? '')}），不跨请求搜索或回退第一块。</p>`;
  } else {
    resultBody = `<p class="note warn">结果正文不可读（${esc(reading.reason ?? '')}）。</p>
      <div class="conv-tools">
        <button class="chip-btn" data-tool-retry="${input.owner}" data-call-ord="${input.call.ord}">重试读取</button>
      </div>`;
  }
  const resultPath = reading !== null && reading.target !== null ? reading.target.path
    : pair !== null ? pair.result_path : null;
  const metaBits = [
    carrier !== null ? `请求 ${esc(carrier)}` : '',
    pair !== null && pair.result_ord !== null ? `messages[${pair.result_ord}]` : '',
  ].filter(Boolean).join('<span>·</span>');
  // 配对确认后面板头沿用 call 的工具色类；未确认保持中性。is_error=true 给整块 warn 软色。
  const resolved = pairState === 'resolved';
  const errorTint = reading !== null && reading.state === 'available' && reading.is_error === true
    ? ' pair-error' : '';
  const resultPanel = `<div class="body-panel${errorTint}">
    <div class="bp-head">
      <span class="kind bp-kind ${resolved ? toolTint(input.call.name) : 'tint-other'}">${esc(resolved ? callName : 'Tool result')}</span>
      <span class="bp-path">${esc(resultPath ?? '未定位')}</span>
    </div>
    ${metaBits !== '' ? `<div class="bp-meta">${metaBits}</div>` : ''}
    ${resultBody}
  </div>`;
  return `${status}${callPanel}${resultPanel}`;
}
