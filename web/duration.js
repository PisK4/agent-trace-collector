// @ts-check
/**
 * 时长读数的唯一口径：格式化、档位阈值与工具类别同住一处。
 * 同一读数有两种密度：右栏用 secs（两位小数秒），中栏行尾槽用 compact
 * （按量级换单位，最宽形态也落在定宽槽内）。调用方不再自己换算。
 */

/**
 * 档位阈值（毫秒）：ms ≤ t1 为 good，≤ t2 为 warn，其余 bad。
 * 读写 1s/10s、命令 5s/30s、联网 15s/60s、子代理 30s/120s；reason 是推理段
 * （首个文本 − 首 token），attempt 是尝试链的单次调用。阈值描述本机观察到的
 * 正常量级，不是上游 SLA，也不用于跨模型比较。
 * @type {Record<string, readonly [number, number]>}
 */
export const TIER_LIMITS = {
  reason: [5000, 30000],
  file: [1000, 10000],
  command: [5000, 30000],
  web: [15000, 60000],
  agent: [30000, 120000],
  attempt: [30000, 60000],
};

/**
 * @param {number} ms
 * @param {readonly [number, number]} limits
 * @returns {'good'|'warn'|'bad'}
 */
export function tierOf(ms, limits) {
  return ms <= limits[0] ? 'good' : ms <= limits[1] ? 'warn' : 'bad';
}

/** 两位小数秒：右栏读数密度，缺值写 —。 @param {number|null|undefined} ms */
export const secs = (ms) => (ms == null ? '—' : (ms / 1000).toFixed(2) + ' s');

/**
 * 紧凑时长：中栏行尾槽的密度。不足 1 秒用毫秒，1 分钟内一位小数秒，
 * 再长换「分 + 两位秒」。59.96 s 按秒进位成 1m 00s，不出现 60.0s。
 * @param {number} ms
 */
export function compact(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 59950) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
}

/**
 * 工具名到档位类别。等待型工具（等人回答、等后台条件）不上色：长窗口来自
 * 等人或等待本身，不说明工具开销。未登记的工具归命令档，走通用阈值。
 * @type {Record<string, string>}
 */
const TOOL_CATEGORY = {
  read: 'file', edit: 'file', write: 'file',
  bash: 'command', terminal: 'command', skill: 'command',
  webfetch: 'web', websearch: 'web',
  agent: 'agent', task: 'agent', sendmessage: 'agent', subagenthandback: 'agent',
  askuserquestion: 'wait', ask: 'wait', clarify: 'wait', wait: 'wait', monitor: 'wait',
};

/**
 * @param {string|null|undefined} name
 * @returns {string} TIER_LIMITS 的键；wait 无阈值。
 */
export function toolCategory(name) {
  return TOOL_CATEGORY[String(name ?? '').toLowerCase()] ?? 'command';
}
