// 明星会话：「给 CLI 工具加 --json 输出模式」——宣传片主叙事样本。
// 数字全部从提案 note 的关键数字表派生（表是唯一口径，改数字先改表）：
// 主链 44 笔（anthropic 31 / chat 13）+ Aux 3 + OMP 对照 4，提示 208k、
// 缓存 93.2%、输出 17.4k、费用 $0.42、工具 Read 34 / Bash 22（2 失败）/
// Edit 17 / Grep 9 / Write 6、Skill 3。失败弧线：一笔网关 500（部分回复
// 保留），重试换路成功。数据只服务拍摄与界面验证，不参与生产验收。
import type { TurnPairRow } from '../src/queries/turns';
import type { SynthAttempt, SynthCall, SynthMessage, SynthRequest } from './synthetic-types';

export const STAR_CONV_KEY = 'conv-synthetic-star';

/** 明星会话时间桶：BASE_MS + (id-800) 分钟，51 笔排满最新一小时，列表置顶。 */
export const STAR_ID_BASE = 800;

export const STAR_READ_PATHS = ['src/cli.ts', 'src/commands/json.ts', 'src/serialize.ts', 'src/formats/timestamps.ts', 'package.json'];
export const STAR_WRITE_PATHS = ['src/commands/json.ts', 'src/serialize.ts', 'src/formats/timestamps.ts', 'tests/json.test.ts', 'tests/serialize.test.ts', 'README.md'];

/** 明星会话 treemap 八类占比（合计 100，与关键数字表一致）。 */
export const STAR_PLAN = [
  { kind: 'chat', share: 0.38 }, { kind: 'files', share: 0.24 }, { kind: 'results', share: 0.15 },
  { kind: 'harness', share: 0.09 }, { kind: 'tools', share: 0.08 }, { kind: 'system', share: 0.04 },
  { kind: 'memory', share: 0.013 }, { kind: 'skills', share: 0.007 },
];

/** 明星会话的系统提示：harness 字样是 harness 类叙事锚。 */
export const STAR_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.\nharness:claude-code\n输出模式遵循 CLI 全局约定。";

/** 明星会话的工具定义：请求声明与调用名对应。 */
export const STAR_TOOLS = [
  { type: 'function', function: { name: 'Read', description: '读文件。', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'Bash', description: '运行命令。', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'Edit', description: '改文件。', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } } },
  { type: 'function', function: { name: 'Write', description: '写文件。', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } } },
  { type: 'function', function: { name: 'Grep', description: '搜索文本。', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } } },
];

type StarSpec = {
  title: string;
  protocol?: 'anthropic' | 'chat';
  kind: 'main' | 'aux' | 'mirror';
  agent?: 'claude' | 'omp' | 'codex';
  input: string;
  /** 调用计划：[工具名, 次数]；调用块进本笔回复，结果块落在下一笔主链请求。 */
  calls?: [string, number][];
  /** is_error 的调用条数，取调用序列末尾。 */
  callFails?: number;
  /** Skill 调用名（不进工具分布表，进 skills 组）。 */
  skill?: string;
  /** 用户主动文本开轮；轮首笔显式标注，不在生成时猜测。 */
  newTurn?: boolean;
  status?: number;
  body?: 'partial';
  bodyReason?: string;
  replyText?: string;
  attempts?: 'gateway-fallback';
};

const U = (text: string): SynthMessage => ({ role: 'user', content: text });
const A = (text: string): SynthMessage => ({ role: 'assistant', content: text });

const BASH_COMMANDS = ['bun test tests/json.test.ts', 'bun run build', 'node dist/cli.js --json', 'git diff --stat', 'bun run lint', 'node dist/cli.js --json | head -3'];
const GREP_PATTERNS = ['console.log', 'process.stdout', 'JSON.stringify', '--pretty'];

const TOOL_OK = (tool: string, arg: string) =>
  tool === 'Read' ? `// ${arg}：文件内容示意（--json 调研）`
  : tool === 'Grep' ? `src/serialize.ts:42: ${arg}`
  : tool === 'Skill' ? 'skill 输出示意：文档渲染约定已加载'
  : `ok: ${arg} 已完成`;
const TOOL_FAIL = 'Bash exited 1: 2 tests failed (nested timestamp, empty list)';

// 51 笔脚本：44 主链（用户主动文本开轮，9 个轮次带，轮 5-6 内嵌失败弧线）
// + 3 Aux + 4 OMP 对照。mirror/aux 不承接主链 tool_result，不计入主链。
const SPECS: StarSpec[] = [
  // 轮 1：--json 输出模式从哪接入？（Read 8 + Bash 1 + Skill 1）
  { kind: 'main', newTurn: true, title: '--json 输出模式从哪接入？', input: '给 CLI 加一个 --json 输出模式，先看入口在哪。', calls: [['Read', 3]] },
  { kind: 'main', title: '入口分发读完，看参数解析层', input: '（继续）参数解析在哪一层做？', calls: [['Read', 2], ['Bash', 1]] },
  { kind: 'main', title: '参数层看完，查输出写出点', input: '（继续）结果是怎么写到 stdout 的？', calls: [['Read', 2]], skill: 'doc-render' },
  { kind: 'main', title: '写出点确认，过一遍调用方', input: '（继续）写出函数还有谁在调？', calls: [['Read', 1]] },
  { kind: 'main', title: '接入面小结', input: '（继续）把接入面小结一下。', replyText: '接入面清楚了：参数在 cli.ts 分发，写出集中在 commands/json.ts；--json 模式挂在参数层，输出走独立的 serialize 模块。' },
  { kind: 'mirror', title: '接入面小结（OMP 对照）', input: '（OMP 对照）同一问题的另一通道。', replyText: '接入面清楚：参数在 cli.ts 分发，写出集中在 commands/json.ts。' },

  // 轮 2：序列化层放哪个模块？（Read 6 + Grep 2；aux 2）
  { kind: 'main', newTurn: true, title: '序列化层放哪个模块？', input: '序列化层该新建模块还是塞进 commands？', calls: [['Read', 2], ['Grep', 1]] },
  { kind: 'main', protocol: 'chat', title: '现有序列化调用点过一遍', input: '（继续）现有 JSON.stringify 的调用点过一遍。', calls: [['Read', 2]] },
  { kind: 'main', title: '模块边界确认', input: '（继续）模块边界怎么切？', calls: [['Read', 1], ['Grep', 1]] },
  { kind: 'main', title: '序列化层小结', input: '（继续）落一个小结。', calls: [['Read', 1]], replyText: '序列化独立成 src/serialize.ts：输入是结构化结果，输出是字符串；commands 只负责编排。' },
  { kind: 'main', title: '边界复核', input: '（继续）边界复核无异议就定。', replyText: '无异议。serialize 不碰进程退出码与 TTY 判断，只管值到文本。' },
  { kind: 'aux', title: '生成会话标题', input: '根据会话内容生成一个短标题。', replyText: '给 CLI 工具加 --json 输出模式' },
  { kind: 'aux', agent: 'codex', title: '会话主题分类', input: '把这段会话归入主题分类。', replyText: 'feature/CLI-输出格式' },

  // 轮 3：序列化时间戳用哪种格式？（Read 8 + Grep 4 + Skill 1）
  { kind: 'main', newTurn: true, title: '序列化时间戳用哪种格式？', input: '时间戳序列化用 ISO 8601 还是 epoch 毫秒？', calls: [['Read', 3], ['Grep', 2]] },
  { kind: 'main', protocol: 'chat', title: '看 timestamps 现有约定', input: '（继续）formats/timestamps.ts 的现有约定是什么？', calls: [['Read', 2]] },
  { kind: 'main', title: '格式取舍讨论', input: '（继续）两种格式的取舍？', calls: [['Grep', 1]] },
  { kind: 'main', title: '查调用方对格式的假设', input: '（继续）调用方现在假设了什么格式？', calls: [['Read', 3]], skill: 'atc-notes' },
  { kind: 'main', title: '时间戳格式定稿', input: '（继续）定下来。', calls: [['Grep', 1]], replyText: '定 ISO 8601 带 UTC 偏移：人可读、排序稳定；epoch 只在二进制协议里用。' },
  { kind: 'main', title: '格式定稿确认', input: '（继续）确认无遗留疑问。', replyText: '确认。时间戳格式随字段类型在 serialize 里分发，调用方不感知。' },

  // 轮 4：为什么管道里丢了换行？（全 chat：Bash 4 + Grep 3；mirror 1）
  { kind: 'main', newTurn: true, protocol: 'chat', title: '为什么管道里丢了换行？', input: '输出接管道后换行全没了，为什么？', calls: [['Bash', 2], ['Grep', 1]] },
  { kind: 'main', protocol: 'chat', title: 'TTY 分支排查', input: '（继续）是不是 TTY 判断走了人读分支？', calls: [['Bash', 1], ['Grep', 1]] },
  { kind: 'main', protocol: 'chat', title: 'TTY 分支确认', input: '（继续）确认 TTY 分支的落点。', calls: [['Bash', 1], ['Grep', 1]], replyText: '确认：writer 按 isTTY 选格式，管道下落到人读分支；--json 要显式越过这个判断。' },
  { kind: 'main', protocol: 'chat', title: '修复方案讨论', input: '（继续）怎么修？', replyText: '在 writer 前加一层显式格式开关：--json 强制 serialize 输出，TTY 判断只管默认值。' },
  { kind: 'main', protocol: 'chat', title: '方案确认', input: '（继续）方案就这么定，开始动手。', replyText: '好，动手：先改 writer 的开关，再接 serialize。' },
  { kind: 'mirror', protocol: 'chat', title: '为什么管道里丢了换行？（OMP 对照）', input: '（OMP 对照）同一排查的另一通道。', replyText: '确认：writer 按 isTTY 选格式，管道下落到人读分支。' },

  // 轮 5：网关 500（1 笔）；轮 6：重试后继续（3 笔）——失败弧线跨两个轮次带。
  { kind: 'main', newTurn: true, protocol: 'chat', title: '500 丢了半截回复怎么办？', input: '按方案动手改，先从 writer 开始。', status: 500, body: 'partial', bodyReason: '合成：网关 500，部分回复保留', replyText: '收到，我先把 writer 的格式开关…' },
  { kind: 'main', newTurn: true, protocol: 'chat', title: '（重试）继续改 writer 格式开关', input: '（重试）刚才断了，继续改 writer。', attempts: 'gateway-fallback', replyText: '重试成功。writer 的显式格式开关已就位：--json 越过 TTY 判断。' },
  { kind: 'main', title: '改 serialize 的字段分发', input: '（继续）serialize 按字段类型分发。', calls: [['Read', 1], ['Edit', 3]] },
  { kind: 'main', title: '分发逻辑确认', input: '（继续）确认分发逻辑。', calls: [['Read', 2], ['Edit', 2]], replyText: '时间戳、列表、嵌套对象三类分发完成；单元序列化路径打通。' },

  // 轮 7：写侧改动怎么分批落？（Read 4 + Edit 4 + Write 3 + Skill 1；mirror 2）
  { kind: 'main', newTurn: true, title: '写侧改动怎么分批落？', input: '改动分几批落？先写哪个文件？', calls: [['Read', 1], ['Write', 1]] },
  { kind: 'main', title: 'serialize.ts 主体落地', input: '（继续）serialize.ts 主体写出来。', calls: [['Write', 1], ['Edit', 1]] },
  { kind: 'main', protocol: 'chat', title: 'json.ts 命令接入', input: '（继续）commands/json.ts 接入开关。', calls: [['Edit', 2], ['Read', 2]] },
  { kind: 'main', title: 'timestamps.ts 格式接入', input: '（继续）timestamps.ts 按定稿格式接。', calls: [['Edit', 1]], skill: 'doc-render' },
  { kind: 'main', protocol: 'chat', title: '写入收尾', input: '（继续）把剩下的写入收尾。', calls: [['Write', 1], ['Read', 1]], replyText: '六处写入全部落地：serialize 主体、命令接入、时间戳格式与测试文件骨架。' },
  { kind: 'main', title: '写入清单复核', input: '（继续）复核写入清单与批次。', replyText: '清单与批次一致，测试文件留到下一批。' },
  { kind: 'main', title: '批次确认', input: '（继续）批次确认，进入测试。', replyText: '确认。下一批：测试与文档。' },
  { kind: 'mirror', title: '写侧改动怎么分批落？（OMP 对照）', input: '（OMP 对照）同一写入批次的另一通道。', replyText: '六处写入全部落地。' },
  { kind: 'mirror', protocol: 'chat', title: '写侧改动怎么分批落？（OMP 对照二）', input: '（OMP 对照）批次确认通道。', replyText: '写入批次与主链一致。' },

  // 轮 8：测试覆盖哪几种格式？（Read 4 + Edit 2 + Write 3 + Bash 12，2 失败）
  { kind: 'main', newTurn: true, title: '测试覆盖哪几种格式？', input: '测试要覆盖哪几种输入？先写用例骨架。', calls: [['Write', 1], ['Read', 1]] },
  { kind: 'main', title: 'json 用例展开', input: '（继续）json.test.ts 用例展开。', calls: [['Write', 2]] },
  { kind: 'main', title: '跑第一轮测试', input: '（继续）先跑一轮看看。', calls: [['Edit', 1], ['Bash', 2]], callFails: 2, replyText: '第一轮两个用例没过：嵌套对象的时间戳没走分发；修掉再跑。' },
  { kind: 'main', title: '跑第二轮测试（还差一处）', input: '（继续）修完再跑。', calls: [['Bash', 3]], replyText: '还剩一处：空列表输出成了 null，应为 []。' },
  { kind: 'main', title: '空列表修复后再跑', input: '（继续）修空列表，再跑。', calls: [['Edit', 1], ['Bash', 2]], replyText: '全绿：12 个用例覆盖标量、时间戳、嵌套与空集合。' },
  { kind: 'main', protocol: 'chat', title: 'serialize 测试补齐', input: '（继续）serialize 自己的测试补齐。', calls: [['Read', 1], ['Bash', 2]] },
  { kind: 'main', title: '测试收尾', input: '（继续）测试收尾确认。', calls: [['Read', 2], ['Bash', 3]], replyText: '两套测试 23 个用例全绿，失败弧线的两处回归有断言钉住。' },

  // 轮 9：README 怎么写清楚开关？（Read 1 + Edit 6 + Bash 4）
  { kind: 'main', newTurn: true, title: 'README 怎么写清楚开关？', input: 'README 里 --json 一节怎么写？', calls: [['Read', 1], ['Edit', 2]] },
  { kind: 'main', protocol: 'chat', title: '用法示例核对', input: '（继续）示例命令逐个跑一遍。', calls: [['Bash', 1], ['Edit', 1]] },
  { kind: 'main', title: '示例输出核对', input: '（继续）--json 示例输出核对。', calls: [['Bash', 2], ['Edit', 2]] },
  { kind: 'main', title: '文档收尾', input: '（继续）文档收尾。', calls: [['Bash', 2], ['Edit', 1]], replyText: 'README 的 --json 一节完成：开关语义、管道行为与三个示例输出都与实现一致。' },
  { kind: 'main', title: '整体验收', input: '（继续）整体过一遍收尾。', replyText: '验收通过：--json 模式端到端可用，测试全绿，文档同步。' },

  { kind: 'aux', title: '会话归档分类', input: '把会话归档到对应项目目录。', replyText: '归档：cli-json-output' },
];

const MAIN_COUNT = SPECS.filter(spec => spec.kind === 'main').length;

// 用量从表总量分摊：提示 208k（缓存命中 93.2%）、输出 17.4k、费用 $0.42。
// 总量随轮内推进递增（上下文越滚越大），首笔无缓存命中，末笔校正余差。
function usageOf(mainIndex: number): { in: number; out: number; read: number; write: number; cost: number } {
  const input = 150 + (mainIndex * 11) % 120;
  const write = 90 + (mainIndex * 13) % 50;
  // 缓存比 93.2%：read/(in+read+write) = 13.706/14.706。
  const read = Math.round((input + write) * 13.706);
  const out = 280 + (mainIndex * 73) % 180;
  return { in: input, out, read, write, cost: 0 };
}

const MAIN_USAGE = Array.from({ length: MAIN_COUNT }, (_, i) => usageOf(i));
/** 峰值 118 tok/s 落在第 20 主链笔：out/ms 按表压出。 */
const PEAK_MAIN_INDEX = 20;
MAIN_USAGE[PEAK_MAIN_INDEX]!.out = 340;
/** 表值与基线公式的余差逐笔均摊（按累计取整分摊，末笔闭合到 0 误差）。 */
function spreadGap(gap: number, apply: (u: (typeof MAIN_USAGE)[number], delta: number) => void): void {
  let done = 0;
  MAIN_USAGE.forEach((u, i) => {
    const target = Math.round(gap * (i + 1) / MAIN_COUNT);
    apply(u, target - done);
    done = target;
  });
}
spreadGap(208000 - MAIN_USAGE.reduce((s, u) => s + u.in + u.read + u.write, 0), (u, d) => { u.read += d; });
spreadGap(17400 - MAIN_USAGE.reduce((s, u) => s + u.out, 0), (u, d) => { u.out += d; });
MAIN_USAGE.forEach((u) => { u.cost = Math.round(u.out * 0.42 / 17400 * 10000) / 10000; });
MAIN_USAGE[MAIN_COUNT - 1]!.cost = Math.round(
  (MAIN_USAGE[MAIN_COUNT - 1]!.cost + 0.42 - MAIN_USAGE.reduce((s, u) => s + u.cost, 0)) * 10000) / 10000;

function attemptsFor(id: number): SynthAttempt[] {
  // 失败弧线的两跳：synth-b 超时后网关改路 synth-a。
  const base = Date.UTC(2026, 9, 24, 8, 0, 0) + (id - STAR_ID_BASE) * 60000;
  return [
    { index: 0, model: 'synth-b', effort: null, status: null, fail: 'synth-b 超时，网关改路', error: null,
      start_ms: base - 3600, ms: 3600, ttft_ms: null, flow_ms: null, first_text_ms: null,
      first_reasoning_ms: null, served: null, done: true, tier_served: null, reasoning_hidden: null },
    { index: 1, model: 'synth-a', effort: null, status: 200, fail: null, error: null,
      start_ms: base - 2680, ms: 2680, ttft_ms: 430, flow_ms: 2250, first_text_ms: 520,
      first_reasoning_ms: null, served: 'synth-a', done: true, tier_served: null, reasoning_hidden: null },
  ];
}

type PlannedCall = { call: SynthCall; args: Record<string, unknown> };

/** 生成状态：请求、轮次带、失败调用与路径计数，summary 与静态条目共用。 */
export type StarData = {
  requests: SynthRequest[];
  turns: TurnPairRow[];
  failures: { req_id: number; ord: number; tool_name: string }[];
  readPathCounts: Map<string, number>;
  writePathCounts: Map<string, number>;
  /** 文件路径 → 本会话首次承载它的调用（context-item files 类的定位）。 */
  fileFirstCall: Map<string, { req_id: number; ord: number }>;
  /** 承接笔的 tool_result 消息序号（context-item results 类的定位）。 */
  resultMessages: { req_id: number; ord: number }[];
};

let cache: StarData | null = null;

export function starSessionData(): StarData {
  if (cache !== null) return cache;
  const requests: SynthRequest[] = [];
  const turns: TurnPairRow[] = [];
  const failures: { req_id: number; ord: number; tool_name: string }[] = [];
  const readPathCounts = new Map<string, number>();
  const writePathCounts = new Map<string, number>();
  const fileFirstCall = new Map<string, { req_id: number; ord: number }>();
  const resultMessages: { req_id: number; ord: number }[] = [];
  let readCounter = 0;
  let writeCounter = 0;
  let mainCounter = -1;
  let lastMain: SynthRequest | null = null;
  let lastMainInput = '';
  let lastTurnStartInput = '';
  let lastReplyText = '';
  let pendingCalls: SynthCall[] = [];
  let pendingPlanned: PlannedCall[] = [];
  let pendingFails = 0;
  SPECS.forEach((spec, index) => {
    const id = STAR_ID_BASE + index;
    const isMain = spec.kind === 'main';
    const messages: SynthRequest['inputs'] = [];
    const history: SynthMessage[] = [];
    if (!isMain) {
      messages.push({ message: U(spec.input), userInput: true });
    } else {
      mainCounter += 1;
      if (pendingCalls.length > 0) {
        // 承接笔：上下文是 [最近回复文本, 最近输入]，新消息是工具结果组。
        history.push(A(lastReplyText === '' ? '（推进）' : lastReplyText), U(lastMainInput));
        messages.push({
          message: { role: 'user', content: pendingPlanned.map((planned, ci) => ({
            type: 'tool_result', tool_use_id: planned.call.call_id,
            content: ci >= pendingPlanned.length - pendingFails
              ? TOOL_FAIL
              : TOOL_OK(planned.call.tool_name, String(planned.args.path ?? planned.args.file_path ?? planned.args.pattern ?? planned.args.command ?? planned.args.skill ?? '')),
          })) },
          userInput: false,
        });
      } else {
        // 轮首笔（用户主动文本）：上下文是上一轮的问答对。
        if (lastMain !== null) history.push(U(lastTurnStartInput), A(lastReplyText === '' ? '（推进）' : lastReplyText));
        messages.push({ message: U(spec.input), userInput: true });
        lastTurnStartInput = spec.input;
      }
    }
    const deltaOrd = 2 + history.length;
    if (isMain && pendingCalls.length > 0) resultMessages.push({ req_id: id, ord: deltaOrd });
    // 调用计划展开，参数此刻定案（回复正文与结果文本共用同一份）。
    const planned: PlannedCall[] = [];
    for (const [tool, count] of spec.calls ?? []) {
      for (let n = 0; n < count; n += 1) {
        let args: Record<string, unknown> = {};
        if (tool === 'Read') {
          const path = STAR_READ_PATHS[readCounter % STAR_READ_PATHS.length]!;
          readCounter += 1;
          readPathCounts.set(path, (readPathCounts.get(path) ?? 0) + 1);
          if (!fileFirstCall.has(path)) fileFirstCall.set(path, { req_id: id, ord: planned.length });
          args = { path };
        } else if (tool === 'Edit' || tool === 'Write') {
          const path = STAR_WRITE_PATHS[writeCounter % STAR_WRITE_PATHS.length]!;
          writeCounter += 1;
          writePathCounts.set(path, (writePathCounts.get(path) ?? 0) + 1);
          if (!fileFirstCall.has(path)) fileFirstCall.set(path, { req_id: id, ord: planned.length });
          args = tool === 'Edit'
            ? { file_path: path, old_string: '// TODO', new_string: '// --json 输出路径' }
            : { file_path: path, content: '// --json 模式实现' };
        } else if (tool === 'Grep') {
          args = { pattern: GREP_PATTERNS[planned.length % GREP_PATTERNS.length] };
        } else if (tool === 'Bash') {
          args = { command: BASH_COMMANDS[planned.length % BASH_COMMANDS.length] };
        }
        planned.push({ call: { call_id: `call_star_${id}_${planned.length}`, ord: planned.length, tool_name: tool,
          result_req: null, result_ord: null, result_path: null, state: 'resolved' }, args });
      }
    }
    if (spec.skill !== undefined) {
      planned.push({ call: { call_id: `call_star_${id}_s`, ord: planned.length, tool_name: 'Skill',
        result_req: null, result_ord: null, result_path: null, state: 'resolved' }, args: { skill: spec.skill } });
    }
    if (isMain && pendingCalls.length > 0 && lastMain !== null) {
      // 上一主链笔的调用结果落在本笔 tool_result 消息，回填每个调用的定位。
      for (let ci = 0; ci < pendingCalls.length; ci += 1) {
        const call = pendingCalls[ci]!;
        call.result_req = id;
        call.result_ord = deltaOrd;
        call.result_path = `request.messages[${deltaOrd}].content[${ci}]`;
      }
    }
    const u = MAIN_USAGE[mainCounter]!;
    const usage = { in: u.in, out: u.out, read: u.read, write: u.write, cost: u.cost };
    const peak = isMain && mainCounter === PEAK_MAIN_INDEX;
    const ms = peak ? Math.round(u.out / 118 * 1000) : 1900 + (index * 127) % 2900;
    const ttft = 380 + (index * 53) % 140;
    const failed = spec.status === 500;
    const calls = planned.map(p => p.call);
    const row: SynthRequest = {
      id,
      title: spec.title,
      status: failed ? 500 : 200,
      protocol: spec.protocol ?? 'anthropic',
      history,
      inputs: messages,
      reply: buildReply(spec, planned, failed),
      tools: isMain ? STAR_TOOLS : undefined,
      system: isMain ? STAR_SYSTEM : undefined,
      bodyState: spec.body ?? 'available',
      bodyReason: spec.bodyReason ?? null,
      delta: [deltaOrd],
      prevRelation: isMain ? (lastMain === null ? 'first' : 'confirmed') : 'aux',
      chainRole: isMain ? 'main' : 'aux',
      purposeChain: isMain ? 'participate' : 'exclude',
      reqKind: 'chat',
      modelTitle: spec.kind === 'mirror' ? 'OMP 对照' : null,
      toolCalls: calls,
      usage,
      timing: { ms, ttft, flow: ms - ttft, firstText: index % 3 === 0 ? ttft + 180 + (index * 17) % 120 : null },
      agent: spec.kind === 'mirror' ? 'omp' : spec.agent,
      ...(spec.attempts !== undefined ? { attempts: attemptsFor(id) } : {}),
      ...(isMain ? { promptPlan: STAR_PLAN } : {}),
    };
    requests.push(row);
    if (isMain) {
      // 轮次带：轮首笔显式开轮，轮内最后一笔 main 是 reply_req。
      if (spec.newTurn === true) turns.push({ turn: turns.length + 1, start_req: id, ordinals: [deltaOrd], reply_req: id });
      else if (turns.length > 0) turns[turns.length - 1]!.reply_req = id;
      // 失败调用定位：计划末尾 failCount 个的结果块是失败文本。
      const failCount = spec.callFails ?? 0;
      for (let ci = calls.length - failCount; ci < calls.length; ci += 1) {
        failures.push({ req_id: id, ord: calls[ci]!.ord, tool_name: calls[ci]!.tool_name });
      }
      pendingFails = failCount;
      pendingCalls = calls;
      pendingPlanned = planned;
      lastMain = row;
      lastMainInput = spec.input;
      if (spec.replyText !== undefined) lastReplyText = spec.replyText;
    }
  });
  cache = { requests, turns, failures, readPathCounts, writePathCounts, fileFirstCall, resultMessages };
  return cache;
}

/** 回复正文：调用块 + 可选文本；chat 协议走 choices 形状（tool_calls 参数是字符串）。 */
function buildReply(spec: StarSpec, planned: PlannedCall[], failed: boolean): unknown {
  const toolCalls = planned.filter(p => p.call.tool_name !== 'Skill');
  const text = spec.replyText ?? null;
  if (spec.protocol === 'chat') {
    return {
      model: failed ? 'synth-c' : 'synth-a',
      choices: [{
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        message: {
          role: 'assistant',
          content: text,
          ...(toolCalls.length > 0 ? {
            tool_calls: planned.map(p => ({
              id: p.call.call_id, type: 'function', function: {
                name: p.call.tool_name, arguments: JSON.stringify(p.args),
              },
            })),
          } : {}),
        },
      }],
    };
  }
  const content: unknown[] = planned.map(p => ({ type: 'tool_use', id: p.call.call_id, name: p.call.tool_name, input: p.args }));
  if (text !== null) content.push({ type: 'text', text });
  const hasToolUse = content.length > 0 && (content[0] as { type?: string }).type === 'tool_use';
  return {
    model: failed ? 'synth-c' : 'synth-a',
    stop_reason: hasToolUse ? 'tool_use' : failed ? 'error' : 'end_turn',
    content,
  };
}

/** 明星会话汇总：形状对齐 SessionSummary，数字取关键数字表。 */
export function starSummary() {
  const { requests, turns, failures, readPathCounts, writePathCounts } = starSessionData();
  const mainRows = requests.filter(r => r.purposeChain === 'participate');
  const countCalls = (name: string) => mainRows.reduce((sum, r) => sum + r.toolCalls.filter(c => c.tool_name === name).length, 0);
  const bashCount = countCalls('Bash');
  const callsTotal = mainRows.reduce((sum, r) => sum + r.toolCalls.length, 0);
  const byPath = (counts: Map<string, number>) =>
    [...counts.entries()].map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count);
  return {
    dirty: false,
    tools: [
      { name: 'Read', count: countCalls('Read'), paired: countCalls('Read'), error_known: countCalls('Read'), errors: 0 },
      { name: 'Bash', count: bashCount, paired: bashCount, error_known: bashCount, errors: 2 },
      { name: 'Edit', count: countCalls('Edit'), paired: countCalls('Edit'), error_known: countCalls('Edit'), errors: 0 },
      { name: 'Grep', count: countCalls('Grep'), paired: countCalls('Grep'), error_known: countCalls('Grep'), errors: 0 },
      { name: 'Write', count: countCalls('Write'), paired: countCalls('Write'), error_known: countCalls('Write'), errors: 0 },
    ],
    paths: { written: byPath(writePathCounts), read: byPath(readPathCounts) },
    skills: [{ name: 'doc-render', count: 2 }, { name: 'atc-notes', count: 1 }],
    interrupts: { count: 0, requests: [], unknown: 0 },
    totals: { in_tok: 208000, out_tok: 17400, cost: 0.42, cost_absent: 0, cache_hit: 0.932 },
    structure: {
      requests_total: requests.length, main: mainRows.length, bypass: requests.length - mainRows.length,
      subagent_actors: 0, subagent_requests: 0,
      retries: 1, context_peak_pct: 87,
      models: [{ name: 'synth-a', count: mainRows.length - 1 }, { name: 'synth-c', count: 1 }],
    },
    coverage: {
      calls_total: callsTotal,
      calls_paired: mainRows.reduce((sum, r) => sum + r.toolCalls.filter(c => c.result_req !== null).length, 0),
      calls_error_known: callsTotal,
      calls_fact_known: callsTotal,
    },
    turns: turns.length, failures, failures_truncated: false,
  };
}

/** cue-board 静态支撑条目（written/read/skill）：从生成数据取真实 ord。 */
export function starStaticEntries() {
  const { requests } = starSessionData();
  const mainRows = requests.filter(r => r.purposeChain === 'participate');
  const pick = (names: string[]) => mainRows.flatMap(r =>
    r.toolCalls.filter(c => names.includes(c.tool_name))
      .map(c => ({ req_id: r.id, ord: c.ord, tool_name: c.tool_name, state: c.state })));
  return { written: pick(['Edit', 'Write']), read: pick(['Read']), skill: pick(['Skill']) };
}

/** 明星会话轮次带：用户主动文本开轮。 */
export function starTurns(): TurnPairRow[] {
  return starSessionData().turns;
}
