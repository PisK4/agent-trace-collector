import { expect, test } from 'bun:test';
import { applyIntent } from '../web/selection.js';

type SelectionState = Parameters<typeof applyIntent>[0];
type Intent = Parameters<typeof applyIntent>[1];
type Result = ReturnType<typeof applyIntent>;

/** 基线状态：一笔已选中的请求，步骤与工具选择齐全。 */
function base(overrides: Partial<SelectionState> = {}): SelectionState {
  return {
    session: '["session","k1"]', reqId: 7, selectedStep: '7:call:1', toolOrd: 1, toolOwner: 7,
    toolPage: 'pair', railTab: 'tools', missingReqId: null, offPageReqId: null, turn: null,
    ...overrides,
  } as SelectionState;
}

const kinds = (result: Result) => result.effects.map(fx => fx.kind);

test('open-session 清选择元组，页签与工具页按现行行为保留', () => {
  const result = applyIntent(base(), { kind: 'open-session', sessionKey: 'k2', wantedTrace: 9 });
  expect(result.state.session).toBe('k2');
  expect(result.state.reqId).toBe(9);
  expect(result.state.selectedStep).toBeNull();
  expect(result.state.toolOrd).toBeNull();
  expect(result.state.toolOwner).toBeNull();
  expect(result.state.missingReqId).toBeNull();
  expect(result.state.offPageReqId).toBeNull();
  // 页签与工具页保留：URL 直达、popstate 与手动切会话都保留当前顶层页签。
  expect(result.state.railTab).toBe('tools');
  expect(result.state.toolPage).toBe('pair');
  expect(result.effects).toEqual([]);
});

test('restore-url 页签按 URL 声明，selectedStep 沿用 popstate 现行行为不清', () => {
  const result = applyIntent(base({ railTab: 'tools' }), {
    kind: 'restore-url', session: 'k2', trace: 12, tab: 'facts',
  });
  expect(result.state.session).toBe('k2');
  expect(result.state.reqId).toBe(12);
  expect(result.state.railTab).toBe('facts');
  expect(result.state.toolOrd).toBeNull();
  expect(result.state.toolOwner).toBeNull();
  expect(result.state.selectedStep).toBe('7:call:1'); // 随后的 open-session 会清
  expect(result.effects).toEqual([]);
});

test('trace-resolved 三分支：canonical 跳转、off-page 与 missing 互斥落位、in-page 不动', () => {
  const canonical = applyIntent(base({ reqId: 3 }), { kind: 'trace-resolved', result: 'canonical', reqId: 9 });
  expect(canonical.state.reqId).toBe(9);
  expect(canonical.state.offPageReqId).toBeNull();

  const offPage = applyIntent(base({ reqId: 3, selectedStep: null, toolOrd: null, toolOwner: null }), { kind: 'trace-resolved', result: 'off-page', reqId: null });
  expect(offPage.state.offPageReqId).toBe(3);
  expect(offPage.state.reqId).toBeNull();
  expect(offPage.state.missingReqId).toBeNull();

  const missing = applyIntent(base({ reqId: 3, selectedStep: null, toolOrd: null, toolOwner: null }), { kind: 'trace-resolved', result: 'missing', reqId: null });
  expect(missing.state.missingReqId).toBe(3);
  expect(missing.state.reqId).toBeNull();
  expect(missing.state.offPageReqId).toBeNull();

  const inPage = applyIntent(base(), { kind: 'trace-resolved', result: 'in-page', reqId: 7 });
  expect(inPage.state).toEqual(base());
});

test('session-default 只在无 trace 且无窗口外目标时选第一笔，不用它顶替', () => {
  const defaulted = applyIntent(base({ reqId: null, toolOrd: null, toolOwner: null, selectedStep: null, railTab: 'facts' }), { kind: 'session-default', firstReqId: 42 });
  expect(defaulted.state.reqId).toBe(42);

  const kept = applyIntent(base({ offPageReqId: 55, reqId: null, selectedStep: null, toolOrd: null, toolOwner: null }), { kind: 'session-default', firstReqId: 42 });
  expect(kept.state.reqId).toBeNull();
  expect(kept.state.offPageReqId).toBe(55);

  const selected = applyIntent(base(), { kind: 'session-default', firstReqId: 42 });
  expect(selected.state.reqId).toBe(7);
});

test('select-latest 无条件回最新并清选择（尾锚点刷新）', () => {
  const result = applyIntent(base(), { kind: 'select-latest', latestReqId: 42 });
  expect(result.state.reqId).toBe(42);
  expect(result.state.selectedStep).toBeNull();
  expect(result.state.toolOrd).toBeNull();
  expect(result.state.toolOwner).toBeNull();
});

test('select-first 无条件回第一笔并清选择（头锚点刷新）', () => {
  const result = applyIntent(base(), { kind: 'select-first', firstReqId: 3 });
  expect(result.state.reqId).toBe(3);
  expect(result.state.selectedStep).toBeNull();
  expect(result.state.toolOrd).toBeNull();
  expect(result.state.toolOwner).toBeNull();
});

test('locate 清全部选择并按现行顺序发效果；路由页时带 read-route', () => {
  const result = applyIntent(base({ railTab: 'route' }), { kind: 'locate', reqId: 9 });
  expect(result.state.reqId).toBe(9);
  expect(result.state.selectedStep).toBeNull();
  expect(result.state.missingReqId).toBeNull();
  expect(result.state.offPageReqId).toBeNull();
  expect(kinds(result)).toEqual(['render-main', 'render-rail', 'render-crumb', 'update-url', 'read-route', 'scroll-group', 'ensure-read']);

  const noRoute = applyIntent(base({ railTab: 'facts' }), { kind: 'locate', reqId: 9 });
  expect(kinds(noRoute)).toEqual(['render-main', 'render-rail', 'render-crumb', 'update-url', 'scroll-group', 'ensure-read']);
});

test('select-step：配对来源进工具页并可跨请求归属 owner', () => {
  const result = applyIntent(base(), {
    kind: 'select-step', reqId: 8, stepKey: '8:message:2:result:0',
    source: { side: 'pair', ownerReq: 9, callOrd: 3 },
  });
  expect(result.state.reqId).toBe(8);
  expect(result.state.selectedStep).toBe('8:message:2:result:0');
  expect(result.state.toolOrd).toBe(3);
  expect(result.state.toolOwner).toBe(9); // 配对页描述 owner 请求的调用，可不等于 reqId
  expect(result.state.toolPage).toBe('pair');
  expect(result.state.railTab).toBe('tools');
  expect(result.effects).toContainEqual({ kind: 'ensure-pair', owner: 9, callOrd: 3 });
  expect(result.effects).toContainEqual({ kind: 'ensure-read', reqId: 8 });
  expect(result.effects).toContainEqual({ kind: 'focus-step' });
});

test('select-step：回复侧调用按 reply/call 配对，请求侧进正文页并清工具选择', () => {
  const call = applyIntent(base(), {
    kind: 'select-step', reqId: 7, stepKey: '7:call:1',
    source: { side: 'reply', target: 'call', callOrd: 1, ownerReq: 7 },
  });
  expect(call.state.railTab).toBe('tools');
  expect(call.state.toolOrd).toBe(1);
  expect(call.state.toolOwner).toBe(7);

  const message = applyIntent(base(), {
    kind: 'select-step', reqId: 7, stepKey: '7:message:3',
    source: { side: 'request', target: 'message' },
  });
  expect(message.state.railTab).toBe('body');
  expect(message.state.toolOrd).toBeNull();
  expect(message.state.toolOwner).toBeNull();
  expect(kinds(message)).not.toContain('ensure-pair');

  const record = applyIntent(base(), {
    kind: 'select-step', reqId: 7, stepKey: '7:loading',
    source: { side: 'none' },
  });
  expect(record.state.railTab).toBe('facts');
  expect(record.state.toolOrd).toBeNull();
});

test('select-message：清工具选择；bodyTab 控制页签；missing/offPage 按现行行为保留', () => {
  const group = applyIntent(base({ railTab: 'route', missingReqId: null }), {
    kind: 'select-message', reqId: 7, stepKey: '7:message:2', bodyTab: true,
  });
  expect(group.state.railTab).toBe('body');
  expect(group.state.toolOrd).toBeNull();
  expect(kinds(group)).toEqual(['render-main', 'render-rail', 'update-url']);

  const fold = applyIntent(base({ railTab: 'facts', missingReqId: 3 }), {
    kind: 'select-message', reqId: 7, stepKey: '7:message:2', bodyTab: false,
  });
  expect(fold.state.railTab).toBe('facts');
  expect(fold.state.missingReqId).toBe(3); // 现行行为：消息选择不清 missing/offPage
});

test('select-delta 打开读数页并续读；open-tool 同步调用步骤；open-pair 跨请求直达工具页', () => {
  const delta = applyIntent(base(), { kind: 'select-delta', reqId: 7 });
  expect(delta.state.railTab).toBe('facts');
  expect(delta.state.selectedStep).toBeNull();
  expect(delta.state.toolPage).toBe('pair');
  expect(kinds(delta)).toEqual(['open-rail', 'render-main', 'render-rail', 'render-crumb', 'update-url', 'resume-delta']);

  const tool = applyIntent(base({ selectedStep: null, toolOrd: null, toolOwner: null, railTab: 'tools', toolPage: 'schema' }), {
    kind: 'open-tool', reqId: 7, callOrd: 2,
  });
  expect(tool.state.toolOrd).toBe(2);
  expect(tool.state.toolOwner).toBe(7);
  expect(tool.state.toolPage).toBe('pair');
  expect(tool.state.selectedStep).toBe('7:call:2');
  expect(kinds(tool)).toEqual(['render-main', 'render-rail', 'update-url', 'ensure-pair']);

  const pair = applyIntent(base({ railTab: 'body' }), { kind: 'open-pair', owner: 9, callOrd: 4 });
  expect(pair.state.toolOrd).toBe(4);
  expect(pair.state.toolOwner).toBe(9);
  expect(pair.state.railTab).toBe('tools');
  expect(pair.state.selectedStep).toBe('9:call:4');
  expect(pair.effects).toContainEqual({ kind: 'ensure-pair', owner: 9, callOrd: 4 });
});

test('close-tool 与 select-tab：Escape 连页签回读数，页签归一化并按需发路由读取', () => {
  const back = applyIntent(base(), { kind: 'close-tool', andTab: false });
  expect(back.state.toolOrd).toBeNull();
  expect(back.state.railTab).toBe('tools');
  expect(kinds(back)).toEqual(['render-rail', 'update-url']);

  const escape = applyIntent(base(), { kind: 'close-tool', andTab: true });
  expect(escape.state.railTab).toBe('facts');

  const tab = applyIntent(base({ railTab: 'facts', reqId: 7, selectedStep: null, toolOrd: null, toolOwner: null }), { kind: 'select-tab', tab: 'route' });
  expect(tab.state.railTab).toBe('route');
  expect(kinds(tab)).toEqual(['read-route', 'render-rail', 'update-url']); // 路由读取先于渲染（现行顺序）

  const invalid = applyIntent(base(), { kind: 'select-tab', tab: 'nonsense' });
  expect(invalid.state.railTab).toBe('body');

  const notRoute = applyIntent(base(), { kind: 'select-tab', tab: 'tools' });
  expect(kinds(notRoute)).toEqual(['render-rail', 'update-url']);
});

test('select-tool-page 归一化且不更新 URL；clear-step 只清步骤；tool-gone 只清工具', () => {
  const page = applyIntent(base({ toolPage: 'pair' }), { kind: 'select-tool-page', page: 'schema' });
  expect(page.state.toolPage).toBe('schema');
  expect(kinds(page)).toEqual(['render-rail']); // 现行行为：页内导航不落 URL

  const fallback = applyIntent(base(), { kind: 'select-tool-page', page: 'weird' });
  expect(fallback.state.toolPage).toBe('pair');

  const cleared = applyIntent(base({ railTab: 'body' }), { kind: 'clear-step' });
  expect(cleared.state.selectedStep).toBeNull();
  expect(cleared.state.railTab).toBe('body');
  expect(kinds(cleared)).toEqual(['render-rail']); // 「本次回复」不更新 URL（现行行为）

  const gone = applyIntent(base(), { kind: 'tool-gone' });
  expect(gone.state.toolOrd).toBeNull();
  expect(gone.state.toolOwner).toBeNull();
  expect(gone.state.selectedStep).toBe('7:call:1');
  expect(gone.effects).toEqual([]);
});

test('nav-settled 是路由读取的唯一接线点之一：只在路由页且有请求时发出', () => {
  const fired = applyIntent(base({ railTab: 'route', reqId: 7, selectedStep: null, toolOrd: null, toolOwner: null }), { kind: 'nav-settled' });
  expect(kinds(fired)).toEqual(['read-route']);
  expect(fired.state).toEqual(base({ railTab: 'route', reqId: 7, selectedStep: null, toolOrd: null, toolOwner: null }));

  const noReq = applyIntent(base({ railTab: 'route', reqId: null }), { kind: 'nav-settled' });
  expect(noReq.effects).toEqual([]);

  const noTab = applyIntent(base({ railTab: 'facts' }), { kind: 'nav-settled' });
  expect(noTab.effects).toEqual([]);
});

test('select-turn 进轮次态并带两端补读效果，请求侧选择保持', () => {
  const row = { turn: 2, start_req: 7, ordinals: [4, 5], reply_req: 9 };
  const result = applyIntent(base({ turn: 1 }), { kind: 'select-turn', row });
  expect(result.state.turn).toBe(2);
  expect(result.state.reqId).toBe(7); // 请求侧选择不动：轨迹高亮保持，回来还在
  expect(result.state.toolOrd).toBeNull(); // 过期工具选择清掉
  expect(result.state.toolOwner).toBeNull();
  expect(result.effects).toEqual([
    { kind: 'render-main' }, { kind: 'render-rail' },
    { kind: 'ensure-turn', startReq: 7, replyReq: 9, ords: [4, 5] },
  ]);
});

test('点轨迹任意行与导航意图清轮次：select-step、select-message、locate、open-session、刷新', () => {
  const row = { turn: 2, start_req: 7, ordinals: [4, 5], reply_req: 9 };
  const step = applyIntent(base({ turn: 2 }), {
    kind: 'select-step', reqId: 8, stepKey: '8:message:2',
    source: { side: 'request', target: 'message' },
  });
  expect(step.state.turn).toBeNull();

  const message = applyIntent(base({ turn: 2 }), { kind: 'select-message', reqId: 8, stepKey: '8:message:2', bodyTab: true });
  expect(message.state.turn).toBeNull();

  const locate = applyIntent(base({ turn: 2 }), { kind: 'locate', reqId: 9 });
  expect(locate.state.turn).toBeNull();

  const session = applyIntent(base({ turn: 2 }), { kind: 'open-session', sessionKey: 'k2', wantedTrace: null });
  expect(session.state.turn).toBeNull();

  const refresh = applyIntent(base({ turn: 2 }), { kind: 'select-latest', latestReqId: 42 });
  expect(refresh.state.turn).toBeNull();

  // 选中不落 URL 的对立面核实：select-turn 不发 update-url。
  expect(kinds(applyIntent(base(), { kind: 'select-turn', row }))).not.toContain('update-url');
});

test('turn-gone 只清轮次；tool-gone 是清理不是选择，轮次态保持', () => {
  const gone = applyIntent(base({ turn: 5 }), { kind: 'turn-gone' });
  expect(gone.state.turn).toBeNull();
  expect(gone.effects).toEqual([]);

  const toolGone = applyIntent(base({ turn: 5 }), { kind: 'tool-gone' });
  expect(toolGone.state.turn).toBe(5);
  expect(toolGone.state.toolOrd).toBeNull();
  expect(toolGone.state.toolOwner).toBeNull();
});
