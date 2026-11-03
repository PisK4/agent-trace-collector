// @ts-check
/**
 * 中栏键控提交的纯计划：输入只有「上次提交的目标」与「这次想提交的目标」，
 * 每个目标是一个稳定键加它的可见结果 HTML。计划回答删哪些、建哪些、换哪些、
 * 按什么顺序落位；不碰 DOM、不读 store、不做选择。
 *
 * 可见结果就是实际渲染输入生成的 HTML，不另建指纹。结构容器（步骤列表的
 * 加载入口、请求组、空态与结尾标记）自身的 HTML 传空串：容器的内容是子节点，
 * 换容器会把子节点一起丢掉，所以它们只按键保留、只在内部做行级计划。
 * 选择状态不进比较；渲染输入没变时同一个键的 HTML 不变，节点原地保留。
 */

/**
 * @typedef {{key: string, html: string}} CommitItem 一个稳定键与它的可见结果
 * @typedef {{remove: string[], create: string[], replace: string[], order: string[]}} CommitPlan
 */

/**
 * 比较上次提交的目标与这次的目标。同一个键 HTML 不同才替换；键在 desired 里
 * 必须唯一，重复键只认第一次出现（步骤键由投影保证唯一，重复是调用方缺陷）。
 * order 是期望的完整键序，应用层按它落位并跳过已就位的节点。
 * @param {Map<string, string>} shown 上次提交的键到可见结果 HTML
 * @param {CommitItem[]} desired 这次期望的键与可见结果
 * @returns {CommitPlan}
 */
export function planCommit(shown, desired) {
  /** @type {string[]} */
  const order = [];
  /** @type {string[]} */
  const create = [];
  /** @type {string[]} */
  const replace = [];
  const wanted = new Set();
  for (const item of desired) {
    if (wanted.has(item.key)) continue;
    wanted.add(item.key);
    order.push(item.key);
    const html = shown.get(item.key);
    if (html === undefined) create.push(item.key);
    else if (html !== item.html) replace.push(item.key);
  }
  /** @type {string[]} */
  const remove = [];
  for (const key of shown.keys()) {
    if (!wanted.has(key)) remove.push(key);
  }
  return { remove, create, replace, order };
}

/**
 * 尾部追加判定：本次新建的键全部严格位于幸存旧键之后，才整批算「尾部追加」，
 * 供调用方做一次性入场动效。首屏填充（没有幸存旧键）与窗口重建（旧键全部
 * 换掉）都不算；新建键散插在中段也不算。纯函数，单测直接断言。
 * 调用方先过滤掉不参与比较的键（如 end/loader 这类总排在尾部的结构标记）。
 * @param {string[]} create 本次新建的键（已过滤）
 * @param {string[]} order 期望的完整键序
 * @param {Set<string>} existing 提交前已存在的键（已过滤）
 * @returns {string[]} 判定为尾部追加的新建键（保持 create 原序）
 */
export function tailAppendKeys(create, order, existing) {
  if (create.length === 0) return [];
  let lastOld = -1;
  for (let index = order.length - 1; index >= 0; index -= 1) {
    if (existing.has(/** @type {string} */ (order[index]))) { lastOld = index; break; }
  }
  if (lastOld < 0) return [];
  const created = new Set(create);
  const firstNew = order.findIndex(key => created.has(key));
  return firstNew > lastOld ? create : [];
}
