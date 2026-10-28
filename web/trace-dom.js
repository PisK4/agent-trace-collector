// @ts-check
import { planCommit } from './trace-commit.js';

/**
 * 中栏的键控提交：会话头、轮次带与步骤列表各自保留节点，请求组按 req_id、
 * 步骤行按稳定步骤键复用，只有可见结果变化时才替换。选择不进比较，提交后
 * 只写 `aria-current`；只有选择变化时整次提交不读布局、不动 DOM 结构。
 *
 * 提交前记录首条可见稳定步骤的视口偏移，提交后就地校正滚动，让补读、头部
 * 高度变化与 prepend 不改写读者的阅读位置。原生滚动锚定由 CSS 关闭，
 * 补偿只有这一处，避免两套机制同时移动。
 *
 * 可见上沿是吸顶的会话头与轮次带下沿，不是滚动容器盒顶：被吸顶元素盖住的
 * 行不参与锚点选择，补偿也不会把锚点塞回它们下面。
 *
 * 这里只做 DOM 装配：模型由 app 组装（不读 store、不改选择）。
 *
 * @typedef {{key: string, html: string}} CommitItem
 * @typedef {{key: string, reqId: number, status: string, current: boolean, stale: 'reading' | 'failed' | null,
 *   placeholder: boolean, rows: CommitItem[]}} GroupModel
 *   组身份是字符串键：承载请求的组是 `req:<id>`，末尾回复组是 `tail:<id>`，同号可以相邻。
 *   `reqId` 仍是数字请求号，写进 DOM 的 `data-req` 供定位与读取；节点复用与锚点按字符串键工作。
 * @typedef {{headHtml: string, bandHtml: string, listClass: string, ordDigits: number,
 *   loaderHtml: string, emptyHtml: string, endHtml: string, groups: GroupModel[],
 *   selectedStep: string | null}} MainModel
 * @typedef {{node: Element, html: string}} Shown
 * @typedef {{key: string, node: HTMLElement, rows: Map<string, Shown>, order: string[], status: string, current: boolean,
 *   stale: 'reading' | 'failed' | null, placeholder: boolean}} GroupState
 * @typedef {{kind: 'step' | 'group', key: string, top: number}} Anchor 提交前首条可见稳定步骤（或目标组）及其视口偏移
 */

/** 旧版本标记文案：绝对定位、不占高度；读取中与读取失败分开说。 @type {Record<'reading' | 'failed', string>} */
const STALE_LABELS = { reading: '旧版本 · 重读中', failed: '旧版本 · 重读失败' };

/** @param {string} html @returns {Element | null} */
function elementOf(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content.firstElementChild;
}

/** @param {Map<string, Shown>} entries @returns {Map<string, string>} */
function shownHtml(entries) {
  /** @type {Map<string, string>} */
  const shown = new Map();
  for (const [key, entry] of entries) shown.set(key, entry.html);
  return shown;
}

/** @param {string[]} left @param {string[]} right */
function sameOrder(left, right) {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

/**
 * 步骤列表的子节点：请求组、空态、加载入口与结尾标记。加载入口在列表尾部，
 * 与从头往下读的方向一致；组容器自身的可见结果传空串——容器的内容是它的
 * 子节点，换容器会连子节点与焦点一起丢掉。
 * @param {MainModel} model @returns {CommitItem[]}
 */
function listItems(model) {
  /** @type {CommitItem[]} */
  const items = [];
  for (const group of model.groups) items.push({ key: `group:${group.key}`, html: '' });
  if (model.emptyHtml !== '') items.push({ key: 'empty', html: model.emptyHtml });
  if (model.loaderHtml !== '') items.push({ key: 'loader', html: model.loaderHtml });
  items.push({ key: 'end', html: model.endHtml });
  return items;
}

/**
 * 按期望键序落位：从后往前，节点不在父节点或后继不对时插入。已就位的节点
 * 不移动，避免无谓的重排与滚动抖动。
 * @param {Element} parent @param {string[]} order @param {Map<string, Shown>} entries
 */
function placeChildren(parent, order, entries) {
  /** @type {Node | null} */
  let next = null;
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const entry = entries.get(order[index] ?? '');
    if (entry === undefined) continue;
    const node = entry.node;
    if (node.parentNode !== parent || node.nextSibling !== next) parent.insertBefore(node, next);
    next = node;
  }
}

/** @param {Element} root @param {string} key @returns {HTMLElement | null} */
function findByStepKey(root, key) {
  for (const button of root.querySelectorAll('.compact-select')) {
    const element = /** @type {HTMLElement} */ (button);
    if (element.dataset.stepKey === key) return element;
  }
  return null;
}

/**
 * 中栏可见区的上沿：吸顶的会话头与轮次带盖住滚动容器顶部，内容从它们下面
 * 滚过。锚点选择与恢复都按它们的下沿算，被盖住的行不算可见，补偿也不会把
 * 锚点塞回遮挡区。没有生效的吸顶元素时退回容器盒顶（文档滚动时为 0）。
 * @param {Element} main @param {Element} scroller
 */
function stickyBottom(main, scroller) {
  const documentScroll = scroller === document.scrollingElement;
  let bottom = documentScroll ? 0 : main.getBoundingClientRect().top;
  for (const node of main.querySelectorAll('.session-head, .turn-band')) {
    if (getComputedStyle(node).position !== 'sticky') continue;
    const rect = node.getBoundingClientRect();
    if (rect.bottom > bottom) bottom = rect.bottom;
  }
  return bottom;
}

/**
 * 滚动补偿的夹取：向下补偿（delta > 0）不让锚点落进吸顶遮挡区，最多把它
 * 放到遮挡区下沿；向上补偿保持原样。纯函数，单测直接断言两个方向。
 * @param {number} delta 锚点节点当前视口位置减提交前位置
 * @param {number} nodeTop 补偿前锚点节点的视口位置
 * @param {number} stickyBottom 吸顶元素下沿
 */
export function clampRestoreDelta(delta, nodeTop, stickyBottom) {
  if (delta <= 0) return delta;
  return Math.min(delta, Math.max(0, nodeTop - stickyBottom));
}

/**
 * 提交前锚点：优先目标组内的首条可见稳定步骤；目标组整体在视口内但没有可见
 * 步骤时以组本身为锚；否则退回全列表首条可见稳定步骤——读者正在读别处时，
 * 不把位置拉回目标组。
 * @param {Element} main @param {Element} scroller @param {number|null} preferredReq
 * @returns {Anchor | null}
 */
function captureAnchor(main, scroller, preferredReq) {
  const box = main.getBoundingClientRect();
  const documentScroll = scroller === document.scrollingElement;
  const top = stickyBottom(main, scroller);
  const bottom = documentScroll ? window.innerHeight : box.bottom;
  /** @type {Anchor | null} */
  let first = null;
  /** @type {Anchor | null} */
  let preferred = null;
  for (const group of main.querySelectorAll('.trace-group')) {
    const node = /** @type {HTMLElement} */ (group);
    const wanted = preferredReq !== null && node.dataset.groupKey === `req:${preferredReq}`;
    if (!wanted && (preferredReq === null ? first !== null : preferred !== null)) break;
    const groupRect = node.getBoundingClientRect();
    /** @type {Anchor | null} */
    let found = null;
    // 准备行在组备齐时整行消失；锚在组上，提交后组顶回原位，读者看到的仍是同一笔请求。
    if (!node.hasAttribute('data-placeholder')) {
      for (const step of node.querySelectorAll('.compact-step')) {
        const rect = step.getBoundingClientRect();
        if (rect.bottom <= top || rect.top >= bottom) continue;
        const select = /** @type {HTMLElement | null} */ (step.querySelector('[data-step-key]'));
        const key = select?.dataset.stepKey ?? null;
        if (key !== null) found = { kind: 'step', key, top: rect.top };
        break;
      }
    }
    // 目标组整组可见却还没有步骤（读取中的空组）：以组本身为锚，补读不会把它推走。
    if (found === null && (wanted || node.hasAttribute('data-placeholder'))
      && groupRect.top < bottom && groupRect.bottom > top) {
      found = { kind: 'group', key: node.dataset.groupKey ?? '', top: groupRect.top };
    }
    if (found === null) continue;
    if (first === null) first = found;
    if (wanted) preferred = found;
  }
  return preferred ?? first;
}

/**
 * 提交后把锚点放回原来的视口位置。锚点节点被真实删除时不动滚动：猜一个
 * 替代位置会把读者带到别处，保留现有位置更诚实。头部抬高后补偿不得把
 * 锚点推到吸顶元素下面。
 * @param {Element} main @param {Element} scroller @param {Anchor | null} anchor
 */
function restoreAnchor(main, scroller, anchor) {
  if (anchor === null) return;
  /** @type {Element | null} */
  let node = null;
  if (anchor.kind === 'group') {
    node = main.querySelector(`.trace-group[data-group-key="${CSS.escape(anchor.key)}"]`);
  } else {
    const button = findByStepKey(main, anchor.key);
    node = button?.closest('.compact-step') ?? null;
  }
  if (node === null) return;
  const nodeTop = node.getBoundingClientRect().top;
  const delta = clampRestoreDelta(nodeTop - anchor.top, nodeTop, stickyBottom(main, scroller));
  if (Math.abs(delta) < 0.5) return;
  scroller.scrollTop += delta;
}

/**
 * @param {HTMLElement} main 中栏容器
 * @returns {{commit: (model: MainModel, scroller: Element, preferredReq?: number | null) => void, reset: () => void}}
 */
export function createMainView(main) {
  /** @type {Element | null} */
  let head = null;
  let headHtml = '';
  /** @type {Element | null} */
  let band = null;
  let bandHtml = '';
  /** @type {HTMLElement | null} */
  let list = null;
  let listClass = '';
  /** @type {Map<string, Shown>} */
  const children = new Map();
  /** @type {string[]} */
  let childOrder = [];
  /** @type {Map<string, GroupState>} */
  const groupStates = new Map();
  /** @type {HTMLElement | null} */
  let selected = null;
  /** @type {string | null} */
  let selectedKey = null;

  /** 请求组容器在这里创建：组自身不承载可见结果，内容由行级计划维护。 @param {GroupModel} model @returns {GroupState} */
  function makeGroupState(model) {
    const node = document.createElement('section');
    node.className = 'trace-group';
    node.setAttribute('data-req', String(model.reqId));
    node.setAttribute('data-group-key', model.key);
    node.setAttribute('aria-current', 'false');
    /** @type {Map<string, Shown>} */
    const rows = new Map();
    return { key: model.key, node, rows, order: [], status: '', current: false, stale: null, placeholder: false };
  }

  /** 选择是独立 UI 状态：只改高亮，不参与可见结果比较。 @param {string | null} stepKey */
  function applySelection(stepKey) {
    const next = stepKey === null ? null : findByStepKey(main, stepKey);
    if (selected !== null && selected !== next && selected.isConnected) {
      selected.setAttribute('aria-current', 'false');
    }
    if (next !== null && next.getAttribute('aria-current') !== 'true') next.setAttribute('aria-current', 'true');
    selected = next;
    selectedKey = stepKey;
  }

  /** 骨架固定为会话头、可选轮次带与步骤列表三段；整栏被外部替换过时重建。 @param {MainModel} model */
  function ensureSkeleton(model) {
    if (head !== null && list !== null && main.contains(head) && main.contains(list)) {
      if (model.headHtml !== headHtml) {
        const node = elementOf(model.headHtml);
        if (node !== null) {
          head.replaceWith(node);
          head = node;
          headHtml = model.headHtml;
        }
      }
      return false;
    }
    main.replaceChildren();
    children.clear();
    childOrder = [];
    groupStates.clear();
    selected = null;
    selectedKey = null;
    head = elementOf(model.headHtml) ?? document.createElement('header');
    headHtml = model.headHtml;
    main.append(head);
    band = null;
    bandHtml = '';
    list = document.createElement('div');
    listClass = model.listClass;
    list.className = listClass;
    main.append(list);
    return true;
  }

  /** @param {MainModel} model @param {CommitItem[]} items */
  function commitChildren(model, items) {
    if (list === null) return;
    const plan = planCommit(shownHtml(children), items);
    /** @type {Map<string, string>} */
    const desired = new Map(items.map(item => /** @type {[string, string]} */ ([item.key, item.html])));
    const groupsByKey = new Map(model.groups.map(group => [group.key, group]));
    for (const key of plan.remove) {
      const entry = children.get(key);
      if (entry === undefined) continue;
      entry.node.remove();
      children.delete(key);
      if (key.startsWith('group:')) groupStates.delete(key.slice('group:'.length));
    }
    for (const key of plan.create) {
      if (key.startsWith('group:')) {
        const groupModel = groupsByKey.get(key.slice('group:'.length));
        if (groupModel === undefined) continue;
        const state = makeGroupState(groupModel);
        children.set(key, { node: state.node, html: '' });
        groupStates.set(state.key, state);
      } else {
        const html = desired.get(key) ?? '';
        const node = elementOf(html);
        if (node === null) continue;
        children.set(key, { node, html });
      }
    }
    for (const key of plan.replace) {
      if (key.startsWith('group:')) continue;
      const entry = children.get(key);
      if (entry === undefined) continue;
      const html = desired.get(key) ?? '';
      const node = elementOf(html);
      if (node === null) continue;
      entry.node.replaceWith(node);
      children.set(key, { node, html });
    }
    placeChildren(list, plan.order, children);
    childOrder = [...plan.order];
  }

  /** @param {GroupModel} model */
  function commitGroup(model) {
    const state = groupStates.get(model.key);
    if (state === undefined) return;
    if (state.status !== model.status) {
      state.status = model.status;
      state.node.dataset.status = model.status;
    }
    if (state.current !== model.current) {
      state.current = model.current;
      state.node.setAttribute('aria-current', String(model.current));
    }
    // 旧版本标记只在这组显示的不是当前读取结果时出现；不占高度，由样式让位。
    if (state.stale !== model.stale) {
      state.stale = model.stale;
      if (model.stale === null) state.node.removeAttribute('data-stale');
      else state.node.setAttribute('data-stale', STALE_LABELS[model.stale]);
    }
    // 准备行只是占位：组内交互（锚点、文本选择）按「还没有真实步骤」处理。
    if (state.placeholder !== model.placeholder) {
      state.placeholder = model.placeholder;
      if (model.placeholder) state.node.setAttribute('data-placeholder', '');
      else state.node.removeAttribute('data-placeholder');
    }
    const plan = planCommit(shownHtml(state.rows), model.rows);
    /** @type {Map<string, string>} */
    const desired = new Map(model.rows.map(item => /** @type {[string, string]} */ ([item.key, item.html])));
    for (const key of plan.remove) {
      const entry = state.rows.get(key);
      if (entry === undefined) continue;
      entry.node.remove();
      state.rows.delete(key);
    }
    for (const key of plan.create) {
      const html = desired.get(key) ?? '';
      const node = elementOf(html);
      if (node === null) continue;
      state.rows.set(key, { node, html });
    }
    for (const key of plan.replace) {
      const entry = state.rows.get(key);
      if (entry === undefined) continue;
      const html = desired.get(key) ?? '';
      const node = elementOf(html);
      if (node === null) continue;
      entry.node.replaceWith(node);
      state.rows.set(key, { node, html });
    }
    placeChildren(state.node, plan.order, state.rows);
    state.order = [...plan.order];
  }

  /**
   * 一次比较回答两件事：模型与上次提交是否全等（可整次跳过），以及结构是否
   * 全等、只有选择不同（可只写高亮、不读布局）。两者的判据都是完整计划，
   * 不靠数量近似——同长度但换了内容的情况必须走结构提交。
   * @param {MainModel} model @param {CommitItem[]} items
   * @returns {{clean: boolean, selectionOnly: boolean}}
   */
  function inspect(model, items) {
    if (head === null || list === null || !main.contains(head) || !main.contains(list)) {
      return { clean: false, selectionOnly: false };
    }
    let structural = headHtml !== model.headHtml || bandHtml !== model.bandHtml || listClass !== model.listClass;
    const plan = planCommit(shownHtml(children), items);
    if (plan.remove.length > 0 || plan.create.length > 0 || plan.replace.length > 0) structural = true;
    if (!sameOrder(plan.order, childOrder)) structural = true;
    for (const group of model.groups) {
      const state = groupStates.get(group.key);
      if (state === undefined) { structural = true; continue; }
      if (state.status !== group.status || state.current !== group.current || state.stale !== group.stale
        || state.placeholder !== group.placeholder) structural = true;
      const rows = planCommit(shownHtml(state.rows), group.rows);
      if (rows.remove.length > 0 || rows.create.length > 0 || rows.replace.length > 0) structural = true;
      if (!sameOrder(rows.order, state.order)) structural = true;
    }
    if (model.groups.length !== groupStates.size) structural = true;
    const selectionChanged = model.selectedStep !== selectedKey;
    return { clean: !structural && !selectionChanged, selectionOnly: !structural && selectionChanged };
  }

  /**
   * @param {MainModel} model
   * @param {Element} scroller 中栏滚动容器（桌面为 main，窄屏为文档滚动元素）
   * @param {number|null} [preferredReq] 目标组：首载与定点期间优先保持它不动
   */
  function commit(model, scroller, preferredReq = null) {
    const items = listItems(model);
    const verdict = inspect(model, items);
    if (verdict.clean) return;
    if (verdict.selectionOnly) {
      applySelection(model.selectedStep);
      return;
    }
    const anchor = list === null ? null : captureAnchor(main, scroller, preferredReq);
    ensureSkeleton(model);
    if (list === null) return;
    // 轮次带只在内容变化时替换：它在会话头与列表之间，常驻节点不做无谓重建。
    if (model.bandHtml !== bandHtml) {
      const node = model.bandHtml === '' ? null : elementOf(model.bandHtml);
      if (band === null) {
        if (node !== null) head?.after(node);
      } else if (node === null) {
        band.remove();
      } else {
        band.replaceWith(node);
      }
      band = node;
      bandHtml = model.bandHtml;
    }
    if (listClass !== model.listClass) {
      listClass = model.listClass;
      list.className = listClass;
    }
    list.style.setProperty('--ord-digits', String(model.ordDigits));
    commitChildren(model, items);
    for (const group of model.groups) commitGroup(group);
    applySelection(model.selectedStep);
    restoreAnchor(main, scroller, anchor);
  }

  function reset() {
    head = null;
    headHtml = '';
    band = null;
    bandHtml = '';
    list = null;
    listClass = '';
    selected = null;
    selectedKey = null;
    children.clear();
    childOrder = [];
    groupStates.clear();
    main.replaceChildren();
  }

  return { commit, reset };
}