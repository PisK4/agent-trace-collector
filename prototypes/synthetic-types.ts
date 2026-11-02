// 合成服务器与明星会话共享的请求形状。只放类型：数据与路由都在
// synthetic-server.ts，明星会话数据在 star-session.ts。
export type SynthCall = {
  call_id: string; ord: number; tool_name: string;
  result_req: number | null; result_ord: number | null; result_path: string | null; state: string;
  /** 调用参数里已提取的事实；未提供时摘要为 null。 */
  arg_path?: string | null; arg_skill?: string | null;
};
export type SynthMessage = { role: string; content: unknown; tool_calls?: unknown[] };
export type SynthAttempt = {
  index: number; model: string | null; effort: string | null; status: number | null;
  fail: string | null; error: string | null; start_ms: number | null; ms: number | null;
  ttft_ms: number | null; flow_ms: number | null; first_text_ms: number | null;
  first_reasoning_ms: number | null; served: string | null; done: boolean | null;
  tier_served: string | null; reasoning_hidden: boolean | null;
};
export type SynthRequest = {
  id: number; title: string; status: number | null;
  protocol: 'anthropic' | 'chat';
  history: SynthMessage[];
  inputs: { message: SynthMessage; userInput: boolean; kind?: 'plain' | 'wrapped' | 'midturn' }[];
  reply: unknown;
  tools: unknown;
  bodyState: 'available' | 'partial' | 'pending' | 'evicted';
  bodyReason: string | null;
  delta: number[] | null;
  prevRelation: 'confirmed' | 'unknown' | 'first' | 'branch' | 'aux'; chainRole: string; purposeChain: string; reqKind: string;
  modelTitle: string | null;
  toolCalls: SynthCall[];
  usage: { in: number | null; out: number | null; read: number | null; write: number | null; cost: number | null };
  timing: { ms: number | null; ttft: number | null; flow: number | null; firstText: number | null };
  /** 合成请求可覆盖的读取形态；缺省时按会话与状态推导。 */
  have?: number;
  costState?: 'priced' | 'zero' | 'absent';
  titleSource?: string;
  system?: string;
  routeState?: 'available' | 'absent' | 'expired';
  attempts?: SynthAttempt[];
  /** 路由侧 prompt 八类占比覆盖；缺省用七类默认权重。 */
  promptPlan?: { kind: string; share: number }[];
  agent?: 'claude' | 'omp' | 'codex';
};
