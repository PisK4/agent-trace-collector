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

  /* backend-state */
  '正文预算已满': 'Body budget full',
  '磁盘预算已满': 'Disk budget full',
  '存储降级 · 正文暂停': 'Storage degraded · bodies paused',
  '{why}：只收元数据，新请求的正文不再保存；账本、路由与请求元数据仍在接收。点按重新读取。':
    '{why}: metadata only — bodies of new requests are no longer saved. Ledger, routing, and request metadata are still accepted. Click to re-read.',
  '磁盘剩余空间不足': 'Disk space low',
  '存储降级 · 采集暂停': 'Storage degraded · ingestion paused',
  '{why}：写入被拒绝，新的请求证据不会入库。点按重新读取。':
    '{why}: writes are rejected, new request evidence will not be stored. Click to re-read.',

  /* parts */
  '系统提示': 'System prompt',
  '工具定义': 'Tool definitions',
  '记忆': 'Memory',
  '文件引用': 'File references',
  '工具结果': 'Tool results',
  '对话内容': 'Conversation',
  '技能': 'Skills',

  /* row-summary */
  '正文可读': 'Body readable',
  '正文未到': 'Body not yet arrived',
  '正文不完整': 'Body incomplete',
  '正文已回收': 'Body evicted',
  'OTLP 摘要': 'OTLP summary',
  '协议暂不支持': 'Protocol not interpreted',
  '正文可读，尚未读取；点开后才下载这一片。': 'Body readable, not yet read; opening it downloads this slice.',
  '正文未到：{reason}': 'Body not yet arrived: {reason}',
  '正文不完整：{reason}': 'Body incomplete: {reason}',
  '正文已回收：{reason}': 'Body evicted: {reason}',
  '正文来自 OTLP 摘要：{reason}': 'Body from OTLP summary: {reason}',
  '正文来自 OTLP 摘要': 'Body from OTLP summary',
  '原对象已保存，暂不支持结构化解析。': 'Raw object saved; structured parsing not supported yet.',
  '缺失回复': 'Reply missing',
  '回复未到': 'Reply not yet arrived',
  '回复暂不可读': 'Reply temporarily unreadable',
  '摘要无回复': 'No reply in summary',
  '回复无法解析': 'Reply unparseable',
  '回复状态未知': 'Reply state unknown',
  '完整性未报告': 'Completeness not reported',
  '回复截断': 'Reply truncated',
  '回复完整': 'Reply complete',
  '完整性未知（{finish}）': 'Completeness unknown ({finish})',

  /* tool-summary */
  '{from}–{to} 行': 'lines {from}–{to}',
  '前 {n} 行': 'first {n} lines',
  '{n} 行起': 'from line {n}',
  '{a}→{b} 行': 'lines {a}→{b}',
  '全部替换': 'replace all',
  '未命名工具': 'Unnamed tool',
};
