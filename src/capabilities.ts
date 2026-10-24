/**
 * 能力提取：从请求顶层字段与 system 文本里读出工具与技能声明。
 *
 * 只做解释，不读数据库、不解压正文；调用方负责把已读出的请求字段与 system
 * 文本传进来。未知格式保留为 unrecognized，正文不完整时只报 partial，
 * 不拿缺数据冒充"零技能"。
 */
export type CapabilityState = 'present' | 'empty' | 'unrecognized' | 'missing' | 'partial';

export type ToolCapability = { name: string; description: string; schema: unknown; source: 'tools' | 'functions' };
export type SkillCapability = { name: string; description: string; format: 'tagged' | 'claude-heading' };

export type CapabilityCoverage = {
  complete: boolean;
  reason: 'available' | 'body_partial' | 'body_unavailable';
  from: number;
  to: number;
  total: number | null;
};

export type CapabilityResult<T> = {
  state: CapabilityState;
  items: T[];
  reason: string | null;
};

export type CapabilityView = {
  tools: CapabilityResult<ToolCapability>;
  skills: CapabilityResult<SkillCapability>;
  coverage: CapabilityCoverage;
  agent: string | null;
};

const SKILL_LINE = /^\s*-\s*([^:：]+)[:：]\s*(.*)$/;
const CLAUDE_HEAD = 'The following skills are available for use with the Skill tool:';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 能力提取支持的协议名单与谓词：能力视图、协议适配与 response 关联共用。
 * 名单外的协议（如 gemini）仍能按各自形状提取响应身份，只是不做消息解析。
 */
export const CAPABLE_PROTOCOLS = ['anthropic', 'chat'] as const;

export function protocolSupported(protocol: string): boolean {
  return (CAPABLE_PROTOCOLS as readonly string[]).includes(protocol);
}

/** 工具定义：Anthropic 的 `tools` 与 chat 的 `functions` 两种形状都认。 */
export function extractTools(protocol: string, request: unknown): CapabilityResult<ToolCapability> {
  if (!protocolSupported(protocol)) {
    return { state: 'missing', items: [], reason: 'protocol_unsupported' };
  }
  if (!isRecord(request)) return { state: 'missing', items: [], reason: 'request_unavailable' };
  if (!('tools' in request) && !('functions' in request)) {
    return { state: 'missing', items: [], reason: 'no_tools_field' };
  }
  const list = Array.isArray(request.tools) ? request.tools
    : Array.isArray(request.functions) ? request.functions : null;
  if (list === null) return { state: 'unrecognized', items: [], reason: 'tools_not_array' };
  if (list.length === 0) return { state: 'empty', items: [], reason: 'no_tools_declared' };
  const items: ToolCapability[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const fn = isRecord(entry.function) ? entry.function : null;
    const name = textOf(fn === null ? entry.name : fn.name);
    if (name === null) continue;
    const description = fn !== null && typeof fn.description === 'string' ? fn.description
      : typeof entry.description === 'string' ? entry.description : '';
    const schema = entry.input_schema ?? entry.parameters ?? (fn === null ? null : fn.parameters) ?? null;
    items.push({
      name,
      description,
      schema,
      source: Array.isArray(request.tools) ? 'tools' : 'functions',
    });
  }
  if (items.length === 0) return { state: 'unrecognized', items: [], reason: 'tool_items_invalid' };
  return { state: 'present', items, reason: null };
}

function skillRows(text: string, format: SkillCapability['format']): SkillCapability[] {
  const rows: SkillCapability[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = SKILL_LINE.exec(line);
    if (match === null) continue;
    const name = (match[1] ?? '').trim();
    if (name.length === 0) continue;
    rows.push({ name, description: (match[2] ?? '').trim(), format });
  }
  return rows;
}

function taggedRows(text: string, tag: string): SkillCapability[] {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const rows: SkillCapability[] = [];
  let from = 0;
  while (from < text.length) {
    const start = text.indexOf(open, from);
    if (start < 0) break;
    const end = text.indexOf(close, start + open.length);
    if (end < 0) break;
    rows.push(...skillRows(text.slice(start + open.length, end), 'tagged'));
    from = end + close.length;
  }
  return rows;
}

/** Claude Code 的标题后只吃连续列表行；空行之后的内容不再算技能。 */
function claudeRows(text: string): SkillCapability[] {
  const lines = text.split(/\r?\n/);
  const rows: SkillCapability[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.includes(CLAUDE_HEAD)) continue;
    let cursor = index + 1;
    while (cursor < lines.length && (lines[cursor] ?? '').trim() === '') cursor += 1;
    while (cursor < lines.length) {
      const match = SKILL_LINE.exec(lines[cursor] ?? '');
      if (match === null) break;
      const name = (match[1] ?? '').trim();
      if (name.length > 0) rows.push({ name, description: (match[2] ?? '').trim(), format: 'claude-heading' });
      cursor += 1;
    }
  }
  return rows;
}

function hasSkillMarker(texts: readonly string[]): boolean {
  return texts.some(text => /<skills[\s>]/i.test(text)
    || /<available_skills[\s>]/i.test(text)
    || text.includes(CLAUDE_HEAD));
}

/**
 * 技能声明：system 文本里的标签列表或 Claude Code 标题列表。
 *
 * 覆盖状态先于内容：正文不可读报 missing，正文不完整报 partial，都不解析
 * 已读到的片段。格式认不出时保留 unrecognized，不降级成 empty。
 */
export function extractSkills(
  systemTexts: readonly string[],
  coverage: CapabilityCoverage,
  systemPresent: boolean,
  agent: string | null,
): CapabilityResult<SkillCapability> {
  if (coverage.reason === 'body_unavailable') {
    return { state: 'missing', items: [], reason: 'body_unavailable' };
  }
  if (!coverage.complete) return { state: 'partial', items: [], reason: 'body_partial' };
  const rows = systemTexts.flatMap(text => [
    ...taggedRows(text, 'skills'),
    ...taggedRows(text, 'available_skills'),
    ...claudeRows(text),
  ]);
  const seen = new Set<string>();
  const items = rows.filter(row => {
    if (seen.has(row.name)) return false;
    seen.add(row.name);
    return true;
  });
  if (items.length > 0) return { state: 'present', items, reason: null };
  if (!systemPresent) return { state: 'empty', items: [], reason: 'no_system_field' };
  if (hasSkillMarker(systemTexts)) return { state: 'unrecognized', items: [], reason: 'skill_format_unknown' };
  return { state: 'empty', items: [], reason: 'no_skill_declaration' };
}

/**
 * 一笔请求的能力视图。
 *
 * 覆盖状态（coverage）描述已保存正文的读取情况，协议能否解释由调用方传入的
 * parse_state/协议名决定：未适配协议的工具与技能统一报
 * `missing/protocol_unsupported`——完整保存不证明技能可判定，不以零冒充未知。
 */
export function capabilityView(input: {
  protocol: string;
  request: unknown;
  systemTexts: readonly string[];
  coverage: CapabilityCoverage;
  systemPresent: boolean;
  agent: string | null;
}): CapabilityView {
  const supported = protocolSupported(input.protocol);
  const unsupported: 'protocol_unsupported' = 'protocol_unsupported';
  return {
    tools: supported ? extractTools(input.protocol, input.request)
      : { state: 'missing', items: [], reason: unsupported },
    skills: supported ? extractSkills(input.systemTexts, input.coverage, input.systemPresent, input.agent)
      : { state: 'missing', items: [], reason: unsupported },
    coverage: input.coverage,
    agent: input.agent,
  };
}
