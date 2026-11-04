// @ts-check
/**
 * URL 与路由目标的纯函数：trace 参数解析、右栏页签声明与路由读取目标。
 * URL 恢复与导航完成处共用，测试直接断言。页签合法值取自 RAIL_TABS 登记，
 * 新增一栏不在这里另写白名单。
 */
import { DEFAULT_TAB, RAIL_TABS } from './rail-tabs.js';

/**
 * URL 的 trace 参数解析成请求号：只接受十进制正整数。非法值按未指定处理，
 * 不产生 NaN，也不进入「未找到」分支——那不是一条可以核对的请求号。
 * @param {string | null} value
 * @returns {number | null}
 */
export function traceIdFromParam(value) {
  if (value === null || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * URL 里的 trace 属于哪种情况。合并过的旧 id 会被服务端解析成 canonical：
 * 若 canonical 就在已加载窗口里，直接跳过去，不能报"未在窗口"。
 * @param {{req_id: number}[]} rows
 * @param {number} requested
 * @param {{req_id: number} | null} detail canonical 详情；null 表示库里不存在
 * @returns {{kind: 'in-page' | 'canonical' | 'off-page' | 'missing', reqId: number | null}}
 */
export function resolveTraceTarget(rows, requested, detail) {
  if (rows.some(row => row.req_id === requested)) return { kind: 'in-page', reqId: requested };
  if (detail === null) return { kind: 'missing', reqId: null };
  if (rows.some(row => row.req_id === detail.req_id)) return { kind: 'canonical', reqId: detail.req_id };
  return { kind: 'off-page', reqId: null };
}

/**
 * URL 的 tab 参数解析成右栏页签：合法内容页签原样采用，无效或缺省回读数；
 * 无声明进入读数是现有默认，不属于被覆盖的缺陷。
 * @param {string | null} value
 * @returns {string}
 */
export function railTabFromParam(value) {
  return value !== null && RAIL_TABS.some(tab => tab.id === value) ? value : DEFAULT_TAB;
}

/** 读数是缺省页签，不落 URL；显式内容页签原样写回。 @param {string} tab @returns {string | null} */
export function railTabParam(tab) {
  return tab !== DEFAULT_TAB && RAIL_TABS.some(entry => entry.id === tab) ? tab : null;
}

/**
 * 路由读取目标：只在路由页签且请求已定时返回要读取的 req_id。导航完成处
 * （选会话、刷新、定位）与页签点击共用；渲染函数不发起读取，无当前请求不预取。
 * @param {string} railTab
 * @param {number | null} reqId
 * @returns {number | null}
 */
export function routeReadTarget(railTab, reqId) {
  return railTab === 'route' && reqId !== null ? reqId : null;
}

/** 拍摄直达：demo=1 进入静默模式（作废不自动重读）；其他值按未指定处理。
 *  @param {string | null} value */
export function demoFromParam(value) {
  return value === '1';
}

/** 拍摄直达：expand=summary 展开 cue-board 的折叠组；其他值按未指定处理。
 *  @param {string | null} value @returns {'summary' | null} */
export function expandFromParam(value) {
  return value === 'summary' ? 'summary' : null;
}

/** 拍摄直达：summary 组清单的分组键，只收五个已知组；其他值按未指定处理。
 *  @param {string | null} value @returns {'tool' | 'read' | 'written' | 'skill' | 'interrupts' | null} */
export function summaryKindFromParam(value) {
  return value === 'tool' || value === 'read' || value === 'written'
    || value === 'skill' || value === 'interrupts' ? value : null;
}
