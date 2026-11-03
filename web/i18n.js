// @ts-check
/**
 * 界面双语：语言状态与 t()。中文原文即 key，web/i18n-en.js 做 zh→en 映射，
 * 缺 key 回退原文——按文件分批抽取时，没抽到的界面保持中文，不显示 key 名。
 * 偏好存 localStorage('tc.lang')，缺省跟随 navigator.language；语言切换后的
 * 界面重绘归调用点（app.js 的 onLocaleChange），本模块只管文案与偏好。
 */

import { dict } from './i18n-en.js';

/**
 * 字典值：字符串走 {name} 占位替换；函数收原始 params，处理单复数等
 * 表达差异，返回最终文案。两种取值都不做 HTML 转义，转义归调用点的 esc。
 * @typedef {Record<string, string | ((params: Record<string, string | number>) => string)>} Dict
 */

/** @type {'zh' | 'en'} */
let locale = 'zh';

/**
 * @param {string} text
 * @param {Record<string, string | number> | undefined} params
 */
function fill(text, params) {
  if (params === undefined) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 */
export function t(key, params) {
  if (locale !== 'zh') {
    const entry = dict[key];
    if (entry !== undefined) {
      return typeof entry === 'function' ? entry(params ?? {}) : fill(entry, params);
    }
  }
  return fill(key, params);
}

/** @param {'zh' | 'en'} next */
export function setLocale(next) { locale = next; }

export function currentLocale() { return locale; }

/** 切换钮的目标语言；图形是目标语言的称呼，说明文案走 t。 */
export function otherLocale() { return locale === 'zh' ? 'en' : 'zh'; }

export function htmlLang() { return locale === 'zh' ? 'zh-CN' : 'en'; }

/** 启动时调用一次：偏好优先，缺省跟随 navigator.language。 */
export function initLocale() {
  let saved = null;
  try { saved = localStorage.getItem('tc.lang'); } catch { /* storage may be blocked */ }
  if (saved === 'zh' || saved === 'en') { locale = saved; return; }
  const lang = typeof navigator === 'undefined' ? '' : navigator.language ?? '';
  locale = lang.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** 切换并持久化；DOM 与界面重绘归调用点。 @param {'zh' | 'en'} next */
export function changeLocale(next) {
  setLocale(next);
  try { localStorage.setItem('tc.lang', next); } catch { /* storage may be blocked */ }
}
