// @ts-check
import { bodyNotice, renderReplyDetail } from './body-view.js';
import { messagePathOf, replyView } from './body-model.js';
import { esc } from './html.js';
import { bodyLabelText, bodyStateText } from './row-summary.js';

/**
 * 轮次目录与右栏轮次态的纯渲染。轮次带是轨迹的目录层：一行高度横滚、吸顶贴
 * session-head 下沿、无可结算轮整条不渲染；块上只有轮号与命令摘要，不加二级标签。
 * 右栏轮次态用面板读两端（命令组在上、最终回复在下），复用 body-panel 组件语言，
 * 页签行在轮次态隐藏——页签是请求作用域。读取、失效与选中由 app 装配；
 * 这里只拼字符串，不碰 DOM、不发请求，正文一律转义。
 *
 * @typedef {import('../src/queries/turns').TurnPairRow} TurnPairRow
 * @typedef {import('../src/input-interpretation').UserInputView} UserInputView
 * @typedef {import('../src/protocols').BodyPage} BodyPage
 * @typedef {{body_state: string, miss_reason?: string | null}} BodyRow 轮次面板只消费正文状态两字段
 * @typedef {{ord: number, blocks: {kind: string, text: string}[], input: UserInputView | null}} CommandEntry 命令组消息的读取切片
 * @typedef {{entries: CommandEntry[], meta: BodyPage | null} | null} TurnRead 面板用到的读取快照切片；null 表示正在读取
 */

/** @param {string} text @param {number} max */
function clip(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max).join('')}…`;
}

/**
 * 轮次带：旧轮在左，与轨迹时间方向一致。起点不在当前窗口的轮不进带（没有
 * 滚动目标也没有行摘要），号段按实留空洞；没有可渲染的轮返回空串，不占位。
 * @param {TurnPairRow[]} items 已结算轮（会话全序编号）
 * @param {number | null} selected 当前选中轮号
 * @param {{req_id: number, input_preview: string | null}[]} rows 当前载入窗口的请求行
 * @returns {string}
 */
export function renderTurnBand(items, selected, rows) {
  const chips = [];
  for (const turn of items) {
    const row = rows.find(candidate => candidate.req_id === turn.start_req) ?? null;
    if (row === null) continue;
    const preview = typeof row.input_preview === 'string' ? row.input_preview : '';
    chips.push(`<button class="turn-chip" data-turn="${turn.turn}" aria-pressed="${selected === turn.turn}" title="${esc(preview)}"><b>${turn.turn}</b><span>${esc(clip(preview, 32))}</span></button>`);
  }
  if (chips.length === 0) return '';
  return `<nav class="turn-band" id="turn-band" aria-label="轮次">${chips.join('')}</nav>`;
}

/**
 * 右栏轮次态的身份行：只留轮号。两端请求号曾是手动定位的锚点，但轮次态里
 * 没有「跳到那笔请求」的动作可发起，号本身不可操作，阅读路径用不到它。
 * @param {TurnPairRow} turn
 */
export function renderTurnRailHead(turn) {
  return `<div class="rail-id"><span>轮 ${turn.turn}</span></div>`;
}

/**
 * 命令组的一条面板。正文读不到时分两种：正文状态本身不可读落回收/缺失态
 * （与轨迹视图保留 retained 摘要同一立场），可读但分片未到落读取中。
 * 命令文本用解释后的用户输入（包装已剥出），与轨迹用户行同源；没有解释时回退块文本。
 * @param {CommandEntry | null} entry
 * @param {number} ord
 * @param {number} ownerId 复制原文按 owner 请求读取：轮次态的 owner 与当前请求可以不同
 * @param {BodyRow | null} ownerRow
 * @param {string} path
 */
function commandPanel(entry, ord, ownerId, ownerRow, path) {
  const head = `<div class="bp-head">
    <span class="kind user bp-kind">User</span>
    ${path === '' ? '' : `<span class="bp-path">${esc(path)}</span>`}
    ${entry !== null ? `<button class="chip-btn" data-copy-msg="${ord}" data-copy-owner="${ownerId}">复制原文</button>` : ''}
  </div>`;
  if (entry === null) {
    if (ownerRow !== null && ownerRow.body_state !== 'available' && ownerRow.body_state !== 'partial') {
      return `<div class="body-panel">${head}<div class="rail-empty turn-panel-empty"><b>${esc(bodyStateText(ownerRow))}</b>${esc(bodyLabelText(ownerRow))}</div></div>`;
    }
    return `<div class="body-panel">${head}<p class="note">正在读取这条消息…</p></div>`;
  }
  const text = entry.input !== null && entry.input.state === 'text' ? entry.input.text
    : entry.blocks.map(block => block.text).filter(part => part.length > 0).join('\n\n');
  return `<div class="body-panel">${head}<div class="bp-text bp-plain">${esc(text)}</div></div>`;
}

/** @param {TurnRead} read @param {BodyRow | null} row */
function missingCommandPanel(read, row) {
  const head = '<div class="bp-head"><span class="kind user bp-kind">User</span></div>';
  const page = read?.meta ?? null;
  if (row !== null && row.body_state !== 'available' && row.body_state !== 'partial') {
    return `<div class="body-panel">${head}<div class="rail-empty turn-panel-empty"><b>${esc(bodyStateText(row))}</b>${esc(bodyLabelText(row))}</div></div>`;
  }
  if (page === null) {
    return `<div class="body-panel">${head}<p class="note">正在读取命令正文…</p></div>`;
  }
  if (page !== null && page.state !== 'available' && page.state !== 'partial') {
    return `<div class="body-panel">${head}<div class="rail-empty turn-panel-empty"><b>${esc(bodyNotice(page) || '正文不可读')}</b></div></div>`;
  }
  return `<div class="body-panel">${head}<p class="note">命令位置不可用，无法读取命令正文。</p></div>`;
}

/**
 * 最终回复面板。回复全文读终点请求的 reply；正文不可读落回收/缺失态，
 * 不拿相邻请求的回复顶替。
 * @param {TurnRead} read
 * @param {BodyRow | null} row
 * @param {string} foldKey 折叠持久化键（终点 req_id）；行未知时空串不持久化
 */
function replyPanel(read, row, foldKey) {
  const head = '<div class="bp-head"><span class="kind REPLY bp-kind">REPLY</span><span class="bp-path">reply</span></div>';
  const page = read?.meta ?? null;
  if (page === null) {
    return `<div class="body-panel">${head}<p class="note">正在读取回复正文…</p></div>`;
  }
  if (page.state !== 'available' && page.state !== 'partial') {
    const title = bodyNotice(page) || (row !== null ? bodyStateText(row) : '正文不可读');
    const label = row !== null ? bodyLabelText(row) : '';
    return `<div class="body-panel">${head}<div class="rail-empty turn-panel-empty"><b>${esc(title)}</b>${esc(label)}</div></div>`;
  }
  const view = replyView(page);
  if (view.state === 'invalid') {
    return `<div class="body-panel">${head}<div class="reply-empty"><b>回复对象无法结构化</b><span>原对象仍保存在库里。</span></div></div>`;
  }
  return renderReplyDetail(view, [], foldKey);
}

/**
 * 右栏轮次态主体：命令组面板在上（同笔多条用户消息按序），最终回复面板在下，
 * 默认同时展开。
 * @param {{
 *   turn: TurnPairRow,
 *   startRead: TurnRead,
 *   replyRead: TurnRead,
 *   startRow: (BodyRow & {req_id?: number}) | null,
 *   replyRow: (BodyRow & {req_id?: number}) | null,
 * }} input
 */
export function renderTurnRail(input) {
  const commands = input.turn.ordinals.length === 0 ? missingCommandPanel(input.startRead, input.startRow)
    : input.turn.ordinals.map(ord => {
      const path = messagePathOf(input.startRead?.meta ?? null, ord).replace(/^request\./, '');
      return commandPanel(input.startRead?.entries.find(entry => entry.ord === ord) ?? null,
        ord, input.turn.start_req, input.startRow, path);
    }).join('');
  return `${commands}${replyPanel(input.replyRead, input.replyRow, String(input.replyRow?.req_id ?? ''))}`;
}
