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
