/**
 * Plugin 的静态登记：登记次序即页签次序，新增一家 Agent 或一个 Plugin 只加一行。
 * 形状沿用 PURPOSE_RULES 与 SESSION_ADAPTERS：生产数组与注入数组共用同一份编排，
 * 注入空数组即可整路关闭。这里不读库、不发 HTTP、不拼页面，只声明谁算 DTO。
 */
import type { PluginRegistration } from './types';
import { validateTodoSnapshot } from './todo/dto';
import { zcodeParser } from './todo/parsers/zcode';
import { droidParser } from './todo/parsers/droid';
import { piParser } from './todo/parsers/pi';
import { ompParser } from './todo/parsers/omp';

export const PLUGIN_REGISTRY: readonly PluginRegistration[] = [
  {
    id: 'todo',
    tab: 'todo',
    enabled: true,
    // 第一批全量快照，第二批增量命令；同一 Plugin 容纳两种状态模型。
    parsers: [zcodeParser, droidParser, piParser, ompParser],
    validate: validateTodoSnapshot,
  },
];

/** 取一个 id 的 Parser；未登记或已关闭返回空数组，核心照常工作。 */
export function parsersOf(registrations: readonly PluginRegistration[], id: string) {
  return registrations.find(entry => entry.id === id && entry.enabled)?.parsers ?? [];
}
