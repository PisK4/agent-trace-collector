/**
 * 本地 Agent 来源目录。
 *
 * 只登记“这台机器上可能有哪些来源”，不在这里做解析。`implemented` 表示已有
 * 适配器；`local_data` 表示本机根存在但尚未接入；`unimplemented` 表示格式已知
 * 但本机没有数据。真实覆盖状态由 source-health 按 evidence 与 cursor 另算，
 * 不能拿这张表当“已支持”。
 */

export type CatalogStatus = 'implemented' | 'local_data' | 'unimplemented';

export type CatalogEntry = {
  agent: string;
  /** 已实现适配器的 source_kind；未实现为 null，避免先猜库内身份。 */
  sourceKind: string | null;
  format: string;
  status: CatalogStatus;
};

export const CATALOG: readonly CatalogEntry[] = [
  { agent: 'claude', sourceKind: 'claude_session', format: 'jsonl', status: 'implemented' },
  { agent: 'codex', sourceKind: 'codex_session', format: 'jsonl+zstd', status: 'implemented' },
  { agent: 'opencode', sourceKind: null, format: 'sqlite/json', status: 'unimplemented' },
  { agent: 'pi', sourceKind: 'pi_session', format: 'jsonl', status: 'implemented' },
  { agent: 'omp', sourceKind: 'omp_session', format: 'jsonl', status: 'implemented' },
  { agent: 'zcode', sourceKind: 'zcode_session', format: 'sqlite', status: 'implemented' },
  { agent: 'dsh', sourceKind: 'dsh_session', format: 'jsonl+zstd', status: 'implemented' },
  { agent: 'cline', sourceKind: null, format: 'json', status: 'unimplemented' },
  { agent: 'qoder', sourceKind: null, format: 'jsonl', status: 'local_data' },
  { agent: 'qoder-cn', sourceKind: null, format: 'jsonl', status: 'unimplemented' },
  { agent: 'grok', sourceKind: 'grok_session', format: 'jsonl+summary', status: 'implemented' },
  { agent: 'workbuddy', sourceKind: 'workbuddy_session', format: 'jsonl', status: 'implemented' },
  { agent: 'codebuddy', sourceKind: null, format: 'jsonl', status: 'unimplemented' },
  { agent: 'droid', sourceKind: 'droid_transcript', format: 'transcript', status: 'implemented' },
  { agent: 'cursor', sourceKind: null, format: 'sqlite+transcript', status: 'unimplemented' },
  { agent: 'hermes', sourceKind: 'hermes_session', format: 'sqlite', status: 'implemented' },
  { agent: 'alma', sourceKind: null, format: 'sqlite', status: 'unimplemented' },
  { agent: 'kimi', sourceKind: null, format: 'jsonl', status: 'unimplemented' },
  { agent: 'agy', sourceKind: null, format: 'jsonl+sqlite', status: 'unimplemented' },
];

export function catalogEntry(agent: string): CatalogEntry | null {
  return CATALOG.find(entry => entry.agent === agent) ?? null;
}
