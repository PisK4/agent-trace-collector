/**
 * 会话适配器的注册表。
 *
 * 调度按数组次序轮转，一家一轮；新增一家只在数组里加一行，并在
 * `src/sources/files.ts` 的 SourceKind 里补对应的值。根目录与环境变量
 * 归各适配器的 `roots()`，这里不写路径。
 *
 * droid 也实现了 `SessionAdapter`，但它保留独立的 60 秒定时器与 8 MiB
 * 预算；放进轮转会被两个定时器重复摄入，所以不在这里登记。
 */

import type { SessionAdapter } from './types';
import { claudeAdapter } from './adapters/claude';
import { codexAdapter } from './adapters/codex';
import { dshAdapter } from './adapters/dsh';
import { grokAdapter } from './adapters/grok';
import { hermesAdapter } from './adapters/hermes';
import { ompAdapter } from './adapters/omp';
import { piAdapter } from './adapters/pi';
import { workbuddyAdapter } from './adapters/workbuddy';
import { zcodeAdapter } from './adapters/zcode';

export const SESSION_ADAPTERS: readonly SessionAdapter[] = [
  claudeAdapter,
  codexAdapter,
  dshAdapter,
  grokAdapter,
  hermesAdapter,
  zcodeAdapter,
  ompAdapter,
  piAdapter,
  workbuddyAdapter,
];
