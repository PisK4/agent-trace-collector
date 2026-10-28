// @ts-check
import { routeReadTarget } from './url-route.js';

/**
 * 选择状态的唯一写者：纯转换函数，无 DOM、无网络、无 store。
 * 装配层解析事件后发意图；这里集中维护选择元组的规则——
 * 点击步骤一律进读数，工具选择只在显式打开配对页或工具页时写入，toolOwner
 * 可以不等于 reqId（配对页描述的是 owner 请求的调用）；missing 与 offPage
 * 互斥，由导航类意图清除；消息选择（右栏与结构折叠）不改页签、不清
 * missing/offPage，沿用现行行为。转换只输出新状态与待执行效果，
 * URL、读取、渲染、焦点与滚动由页面执行器完成。
 * 路由读取策略集中在此：导航完成（nav-settled）与页签选择统一按
 * routeReadTarget 计算，装配层不再各自接线。
 */

/**
 * @typedef {Object} SelectionState 选择元组。
 * @property {string | null} session
 * @property {number | null} reqId
 * @property {string | null} selectedStep
 * @property {number | null} toolOrd
 * @property {number | null} toolOwner 配对页描述的调用归属；null 表示当前请求（沿用现行为，选择时写入具体值）。
 * @property {string} toolPage
 * @property {string} railTab
 * @property {number | null} missingReqId
 * @property {number | null} offPageReqId
 * @property {number | null} turn 选中的轮次（会话内已结算轮序号）；null 表示请求态。轮次选择是
 *   瞬时阅读态，不落 URL；除 select-turn 外的选择与导航意图都清它，点轨迹任意行即回请求态。
 */

/**
 * @typedef {{side: 'none'}
 *   | {side: 'request', target: 'message' | 'system'}
 *   | {side: 'reply', target: 'call' | 'text' | 'block', callOrd?: number, ownerReq?: number}
 * } SelectedSource 装配层经 resolveSelectedSource 解析出的步骤来源，只带转换需要的字段。
 */

/**
 * @typedef {Object} Effect 待执行效果；执行器按序消费。
 * @property {'open-rail'|'render-crumb'|'render-main'|'render-rail'|'update-url'|'focus-step'|'scroll-group'|'ensure-read'|'ensure-pair'|'resume-delta'|'read-route'|'ensure-turn'} kind
 * @property {number} [reqId]
 * @property {number} [owner]
 * @property {number} [callOrd]
 * @property {number} [startReq]
 * @property {number} [replyReq]
 * @property {number[]} [ords]
 */

/**
 * @typedef {{kind: 'open-session', sessionKey: string, wantedTrace: number | null}
 *   | {kind: 'restore-url', session: string | null, trace: number | null, tab: string}
 *   | {kind: 'trace-resolved', result: 'in-page' | 'canonical' | 'off-page' | 'missing', reqId: number | null}
 *   | {kind: 'session-default', firstReqId: number | null}
 *   | {kind: 'select-latest', latestReqId: number | null}
 *   | {kind: 'select-first', firstReqId: number | null}
 *   | {kind: 'refresh-start'}
 *   | {kind: 'locate', reqId: number}
 *   | {kind: 'select-step', reqId: number, stepKey: string}
 *   | {kind: 'select-message', reqId: number, stepKey: string, bodyTab: boolean}
 *   | {kind: 'select-delta', reqId: number}
 *   | {kind: 'open-tool', reqId: number, callOrd: number}
 *   | {kind: 'open-pair', owner: number, callOrd: number}
 *   | {kind: 'open-offpage', reqId: number}
 *   | {kind: 'close-tool', andTab: boolean}
 *   | {kind: 'select-tab', tab: string}
 *   | {kind: 'select-tool-page', page: string}
 *   | {kind: 'clear-step'}
 *   | {kind: 'tool-gone'}
 *   | {kind: 'select-turn', row: import('../src/queries/turns').TurnPairRow}
 *   | {kind: 'turn-gone'}
 *   | {kind: 'nav-settled'}
 * } Intent 装配层解析事件后发出的意图。
 */

/**
 * 路由读取效果：目标非空才发出。策略唯一落点。
 * @param {SelectionState} state
 * @returns {Effect[]}
 */
const routeEffects = (state) => {
  const target = routeReadTarget(state.railTab, state.reqId);
  return target === null ? [] : [{ kind: 'read-route', reqId: target }];
};

/**
 * @param {SelectionState} state
 * @param {Intent} intent
 * @returns {{state: SelectionState, effects: Effect[]}}
 */
export function applyIntent(state, intent) {
  switch (intent.kind) {
    case 'open-session': {
      // 手动切会话：页签与工具页保留（现行 selectSession 行为），选择元组清空。
      const next = {
        ...state, session: intent.sessionKey, reqId: intent.wantedTrace,
        selectedStep: null, toolOrd: null, toolOwner: null, missingReqId: null, offPageReqId: null,
        turn: null,
      };
      return { state: next, effects: [] };
    }
    case 'restore-url': {
      // popstate 与初始载入：页签按 URL 声明；selectedStep 沿用现行 popstate 行为
      // 不在此清（随后的 open-session 会清）。
      const next = {
        ...state, session: intent.session, reqId: intent.trace, railTab: intent.tab,
        toolOrd: null, toolOwner: null, missingReqId: null, offPageReqId: null, turn: null,
      };
      return { state: next, effects: [] };
    }
    case 'trace-resolved': {
      if (intent.result === 'canonical' && intent.reqId !== null) {
        return { state: { ...state, reqId: intent.reqId, turn: null }, effects: [] };
      }
      if (intent.result === 'off-page') {
        return { state: { ...state, offPageReqId: state.reqId, reqId: null, turn: null }, effects: [] };
      }
      if (intent.result === 'missing') {
        return { state: { ...state, missingReqId: state.reqId, reqId: null, turn: null }, effects: [] };
      }
      return { state, effects: [] };
    }
    case 'session-default': {
      // 无 trace 且无窗口外目标时默认选窗口第一笔（头锚点下即会话开头）；已有目标不用它顶替。
      if (state.reqId !== null || state.offPageReqId !== null) return { state, effects: [] };
      return { state: { ...state, reqId: intent.firstReqId, turn: null }, effects: [] };
    }
    case 'select-latest': {
      // 显式刷新（尾锚点）：无条件回到最新并清选择。
      const next = { ...state, reqId: intent.latestReqId, selectedStep: null, toolOrd: null, toolOwner: null, turn: null };
      return { state: next, effects: [] };
    }
    case 'select-first': {
      // 显式刷新（头锚点）：无条件回到第一笔并清选择。
      const next = { ...state, reqId: intent.firstReqId, selectedStep: null, toolOrd: null, toolOwner: null, turn: null };
      return { state: next, effects: [] };
    }
    case 'refresh-start': {
      return { state: { ...state, missingReqId: null, offPageReqId: null, turn: null }, effects: [] };
    }
    case 'locate': {
      const next = {
        ...state, reqId: intent.reqId, selectedStep: null, toolOrd: null, toolOwner: null,
        missingReqId: null, offPageReqId: null, turn: null,
      };
      return {
        state: next,
        effects: [
          { kind: 'render-main' }, { kind: 'render-rail' }, { kind: 'render-crumb' }, { kind: 'update-url' },
          ...routeEffects(next),
          { kind: 'scroll-group', reqId: intent.reqId }, { kind: 'ensure-read', reqId: intent.reqId },
        ],
      };
    }
    case 'select-step': {
      // 点击一行一律进读数：页签固定 facts，工具选择清空；配对页只由「配对两端」
      // 与工具页列表等显式动作经 open-pair / open-tool 打开，不在这里推导。
      const next = {
        ...state, reqId: intent.reqId, selectedStep: intent.stepKey,
        toolOrd: null, toolOwner: null, toolPage: 'pair', railTab: 'facts',
        missingReqId: null, offPageReqId: null, turn: null,
      };
      /** @type {Effect[]} */
      const effects = [
        { kind: 'open-rail' }, { kind: 'render-main' }, { kind: 'render-rail' }, { kind: 'render-crumb' },
        { kind: 'update-url' }, { kind: 'focus-step' }, { kind: 'ensure-read', reqId: intent.reqId },
      ];
      return { state: next, effects };
    }
    case 'select-message': {
      // 消息选择（主栏组内 / 结构折叠 / 右栏下拉）：清工具选择、不动页签（bodyTab 时进正文），
      // 不清 missing/offPage（现行行为）。
      const next = {
        ...state, reqId: intent.reqId, selectedStep: intent.stepKey,
        toolOrd: null, toolOwner: null, turn: null,
        railTab: intent.bodyTab ? 'body' : state.railTab,
      };
      return { state: next, effects: [{ kind: 'render-main' }, { kind: 'render-rail' }, { kind: 'update-url' }] };
    }
    case 'select-delta': {
      const next = {
        ...state, reqId: intent.reqId, selectedStep: null, toolOrd: null, toolOwner: null,
        toolPage: 'pair', railTab: 'facts', missingReqId: null, offPageReqId: null, turn: null,
      };
      return {
        state: next,
        effects: [
          { kind: 'open-rail' }, { kind: 'render-main' }, { kind: 'render-rail' }, { kind: 'render-crumb' },
          { kind: 'update-url' }, { kind: 'resume-delta', reqId: intent.reqId },
        ],
      };
    }
    case 'open-tool': {
      const next = {
        ...state, toolOrd: intent.callOrd, toolOwner: intent.reqId, toolPage: 'pair', turn: null,
        selectedStep: intent.reqId !== null ? `${intent.reqId}:call:${intent.callOrd}` : state.selectedStep,
      };
      /** @type {Effect[]} */
      const effects = [{ kind: 'render-main' }, { kind: 'render-rail' }, { kind: 'update-url' }];
      if (intent.reqId !== null) effects.push({ kind: 'ensure-pair', owner: intent.reqId, callOrd: intent.callOrd });
      return { state: next, effects };
    }
    case 'open-pair': {
      const next = {
        ...state, toolOrd: intent.callOrd, toolOwner: intent.owner, toolPage: 'pair', railTab: 'tools',
        selectedStep: `${intent.owner}:call:${intent.callOrd}`, turn: null,
      };
      return {
        state: next,
        effects: [
          { kind: 'render-main' }, { kind: 'render-rail' }, { kind: 'update-url' },
          { kind: 'ensure-pair', owner: intent.owner, callOrd: intent.callOrd },
        ],
      };
    }
    case 'open-offpage': {
      // 汇总条目定位窗口外请求：详情进右栏（复用窗口外请求详情的既有导航），
      // 不自动扩窗口。中栏列表不动，主列表停在最前面。
      const next = {
        ...state, offPageReqId: intent.reqId, reqId: null, turn: null,
        toolOrd: null, toolOwner: null, missingReqId: null,
      };
      return {
        state: next,
        effects: [
          { kind: 'open-rail' }, { kind: 'render-main' }, { kind: 'render-rail' },
          { kind: 'render-crumb' }, { kind: 'update-url' },
          { kind: 'ensure-read', reqId: intent.reqId },
        ],
      };
    }
    case 'close-tool': {
      const next = intent.andTab
        ? { ...state, toolOrd: null, toolOwner: null, railTab: 'facts', turn: null }
        : { ...state, toolOrd: null, toolOwner: null, turn: null };
      return { state: next, effects: [{ kind: 'render-rail' }, { kind: 'update-url' }] };
    }
    case 'select-tab': {
      const tab = intent.tab === 'facts' || intent.tab === 'route' || intent.tab === 'tools' ? intent.tab : 'body';
      const next = { ...state, railTab: tab, turn: null };
      return { state: next, effects: [...routeEffects(next), { kind: 'render-rail' }, { kind: 'update-url' }] };
    }
    case 'select-tool-page': {
      // 工具四页导航：只改页内页签，不更新 URL（现行行为）。
      const page = intent.page === 'overview' || intent.page === 'params' || intent.page === 'schema' ? intent.page : 'pair';
      return { state: { ...state, toolPage: page, turn: null }, effects: [{ kind: 'render-rail' }] };
    }
    case 'clear-step': {
      // 「本次回复」只清步骤选择：不更新 URL（现行行为）。
      return { state: { ...state, selectedStep: null, turn: null }, effects: [{ kind: 'render-rail' }] };
    }
    case 'tool-gone': {
      // 调用方读取后选定工具不存在：清工具选择，渲染由调用方继续。
      // 轮次态保持不动：这是清理不是选择，正在阅读的轮不因工具失效而退出。
      return { state: { ...state, toolOrd: null, toolOwner: null }, effects: [] };
    }
    case 'select-turn': {
      // 轮次带点选：右栏进轮次态，请求侧选择保持（轨迹高亮不动，回来还在）；
      // 过期工具选择清掉。选中不落 URL，点轨迹任意行经其余意图回请求态。
      // 两端补读需要轮次行的请求号与命令组 ords：由装配层随意图带进来，转换不做查找。
      const next = { ...state, turn: intent.row.turn, toolOrd: null, toolOwner: null };
      return {
        state: next,
        effects: [
          { kind: 'render-main' }, { kind: 'render-rail' },
          { kind: 'ensure-turn', startReq: intent.row.start_req, replyReq: intent.row.reply_req, ords: intent.row.ordinals },
        ],
      };
    }
    case 'turn-gone': {
      // 轮次列表重算后选中的轮不在了：清选择，渲染由调用方继续。
      return { state: { ...state, turn: null }, effects: [] };
    }
    case 'nav-settled': {
      // 导航完成（选会话、刷新、定位之外的所有异步收尾）：路由读取的唯一接线点之一。
      return { state, effects: routeEffects(state) };
    }
  }
  return { state, effects: [] };
}
