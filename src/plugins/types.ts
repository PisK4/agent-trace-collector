/**
 * Plugin 与核心之间的唯一接缝：DTO 与 Parser 契约。
 *
 * 这里只放类型和纯数据校验，不 import 查询、HTTP、页面或调度模块。Parser 从
 * tool_use 参数还原列表，交回 DTO；取数、转义、缓存、失败隔离与页签槽位由核心
 * 持有。内外两轨的 Parser 产出同一形状，registry 不区分来源。
 */
import type { TodoSnapshot } from './todo/dto';

/** 社区包声明并比对的 API 版本；不匹配的包整包拒收，内置轨照常工作。 */
export const PLUGIN_API = 1;

/** 一条 Plugin 登记项：给出算 DTO 的 Parser 与它填的页签槽位。 */
export type PluginRegistration = {
  /** 稳定 id；同时是 HTTP 操作名后缀与前端页签 key 的对齐依据。 */
  id: string;
  /** 右栏页签 key；与 web/rail-tabs.js 的登记项一致。 */
  tab: string;
  /** 是否启用；注入空数组可整路关闭，形状沿用 PURPOSE_RULES / SESSION_ADAPTERS。 */
  enabled: boolean;
  /** 该能力下各家 Agent 的形状适配；次序即尝试优先级。 */
  parsers: readonly TodoParser[];
  /** 外部 DTO 落到页面前的校验入口；畸形值返回 null。 */
  validate: (value: unknown) => TodoSnapshot | null;
};

/** 一次工具调用交给 Parser 判断的原始事实；不 import 核心类型。 */
export type TodoCall = { toolName: string; input: unknown };

/**
 * 把某家 Agent 的一次工具调用应用到当前时点，交回新快照；弃权返回 null。
 * 全量快照型忽略 previous 直接覆盖，增量命令型在 previous 上 apply 一条命令。
 * 一轮内多次更新由核心按序折叠，末次即该轮要显示的列表。
 */
export type TodoParser = {
  agent: string;
  parse(call: TodoCall, previous: TodoSnapshot | null): TodoSnapshot | null;
};

/**
 * 社区轨的折叠入口：同一批调用交给 Worker 里的外部包，核心只拿回未校验的快照。
 * 它按 agent 认领：清单里登记了某家 Agent 的社区包后，该 Agent 的内置 Parser
 * 让位，避免两套状态机各自折叠出互相覆盖的结果。
 */
export type CommunityTodoSource = {
  agent: string;
  fold(previous: TodoSnapshot | null, calls: readonly TodoCall[]):
    Promise<TodoSnapshot | null>;
};
