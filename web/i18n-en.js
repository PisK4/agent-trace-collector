// @ts-check
/**
 * en 字典：中文原文 → 英文。key 必须与界面里的 t() 调用逐字一致——改中文
 * 文案时同步改这里的 key。领域词的英文定名见 GLOSSARY「界面英文定名」；
 * 英文文案遵守与中文相同的落笔风格（短句、陈述事实）。
 */

/** @type {import('./i18n.js').Dict} */
export const dict = {
  /* 布局与顶栏 */
  '会话栏': 'Sessions',
  '详情栏': 'Details',
  '展开': 'Expand',
  '收起': 'Collapse',
  '{action}{name}': ({ action, name }) => `${action} ${name}`,
  '主题：{state}（点击切换）': 'Theme: {state} (click to switch)',
  '跟随系统（{mode}）': 'Follow system ({mode})',
  '深色': 'Dark',
  '浅色': 'Light',
  '切换界面语言': 'Switch interface language',

  /* 静态 HTML（index.html boot 改写） */
  '回到主页并刷新': 'Home: reload and reset',
  '会话': 'Sessions',
  '搜索已加载会话、请求或 ID': 'Search loaded sessions, requests, or IDs',
  '搜索已加载会话': 'Search loaded sessions',
  '按 Agent 筛选': 'Filter by agent',
  '正在读取本机会话…': 'Reading local sessions…',
  '正在读取请求…': 'Reading requests…',
  '调整详情栏宽度': 'Resize details column',
  '拖动调整宽度；双击恢复默认；方向键微调': 'Drag to resize; double-click restores default; arrow keys for fine steps',
  '请求读数与正文': 'Request readings and bodies',
  '等待选择': 'Waiting for selection',
  '数据到达后再显示读数。': 'Readings appear once data arrives.',

  /* 通用(先随骨架进来的两条) */
  '已复制{label}': 'Copied {label}',
  '{n} 条探针记录': ({ n }) => (n === 1 ? '1 probe record' : `${n} probe records`),
};
