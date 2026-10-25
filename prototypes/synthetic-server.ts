// 合成阅读场景：只监听回环地址，返回与 collector GET 相同形状的
// 详情、正文、能力与工具关联。不连接真实库，不读取令牌，不启动 collector。
// 场景覆盖：HTTP 失败但保留输入与回复、Chat length、Anthropic max_tokens、
// 未知停止原因、resolved 未读取、pending、ambiguous、辅助请求、分支请求、
// 能力五态、同名工具、路由 absent/expired 与尝试链。
import type { CapabilityView, ToolCapability } from '../src/capabilities';
import { replyShapeOf } from '../src/derive/decision';
import type { BodyCoverage, BodyPage, MessageInterpretation } from '../src/protocols';
import type { RequestRow } from '../src/queries/projection';
import type { ToolResultIndexRow } from '../src/queries/requests';
import type { AttemptChain, RouteSummaryReading } from '../src/queries/routes';
import type { PromptReading } from '../src/queries/readings';
import type { SessionRow } from '../src/queries/sessions';
import type { TurnPairRow } from '../src/queries/turns';
import type { ReadingDetail } from '../src/reading';
import { WEB_HEADERS, serveWeb } from './static-web';

const port = 8770;
const convKey = 'conv-synthetic-reading';
const convWindow = 'conv-synthetic-window';
const convHook = 'conv-synthetic-hook';
const convTurns = 'conv-synthetic-turns';

// 合成时间基准：Demo 的会话与请求显示为连续的一段时间，而不是 1970 的 id 秒。
const BASE_MS = Date.UTC(2026, 9, 24, 8, 0, 0);
const startOf = (r: { id: number }) =>
  BASE_MS + (r.id >= 700 ? r.id - 700 : r.id >= 600 ? r.id - 600 : r.id >= 500 ? r.id - 500 : r.id - 101) * 60000;

type SynthCall = {
  call_id: string; ord: number; tool_name: string;
  result_req: number | null; result_ord: number | null; result_path: string | null; state: string;
};
type SynthMessage = { role: string; content: unknown; tool_calls?: unknown[] };
type SynthAttempt = {
  index: number; model: string | null; effort: string | null; status: number | null;
  fail: string | null; error: string | null; start_ms: number | null; ms: number | null;
  ttft_ms: number | null; flow_ms: number | null; first_text_ms: number | null;
  first_reasoning_ms: number | null; served: string | null; done: boolean | null;
  tier_served: string | null; reasoning_hidden: boolean | null; queued_ms: number | null;
};
type SynthRequest = {
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
};

const SYS = '你是合成场景里的编码助手，只依据已读文件回答。';
const BRIEF = '合成场景说明：排查 parse-helper 的空状态渲染问题，目录 /synth/workspace。';
const TOOL_READ = {type:'function', function:{name:'read_file', description:'读取文件。', parameters:{type:'object', properties:{path:{type:'string'}}, required:['path']}}};
const TOOL_BASH = {type:'function', function:{name:'Bash', description:'运行命令。', parameters:{type:'object', properties:{command:{type:'string'}}, required:['command']}}};
const TOOL_GREP = {type:'function', function:{name:'Grep', description:'搜索文本。', parameters:{type:'object', properties:{pattern:{type:'string'}}, required:['pattern']}}};
const TOOL_READ_ALT = {type:'function', function:{name:'read_file', description:'读取文件（同名第二定义，参数不同）。', parameters:{type:'object', properties:{path:{type:'string'}, offset:{type:'number'}}, required:['path']}}};

// 技能清单与工具清单分开：生产右栏各占一行，present 有内容时才出现。
const SKILLS = [
  {name:'code-review', description:'按仓库规则审查改动，输出问题与修正建议。'},
  {name:'deploy', description:'发布与回滚本机服务，检查端口与数据目录。'},
];

const A = (text: string) => ({role:'assistant', content:text});
const U = (text: string) => ({role:'user', content:text});

// 历史压缩成最近一轮问答，保持每个请求的消息量可控；阅读只依赖 delta 与回复。
const REQUESTS: SynthRequest[] = [
  { id:101, title:'parse-helper 空状态怎么渲染', status:200, protocol:'anthropic',
    history:[], inputs:[{message:U('parse-helper 里空状态是怎么渲染的？'),userInput:true},{message:U('顺便说下调用方有谁。'),userInput:true}],
    reply:{model:'synth-a', stop_reason:'end_turn', content:[
      {type:'text', text:'空状态在 renderEmpty 里渲染：列表为空时显示「暂无条目」，只有一个分支。'},
      {type:'text', text:'调用方目前只有 RequestList 一处，筛选后的空集合也走同一个分支。'}]},
    tools:[TOOL_READ, TOOL_BASH, TOOL_GREP], bodyState:'available', bodyReason:null,
    delta:[2,3], prevRelation:'first', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[], usage:{in:2200,out:412,read:0,write:2400,cost:0.0021}, timing:{ms:3180,ttft:540,flow:2570,firstText:610} },

  { id:102, title:'读取 parse-helper.ts 当前实现', status:200, protocol:'anthropic',
    history:[U('parse-helper 里空状态是怎么渲染的？'), A('空状态在 renderEmpty 里渲染，只有一个分支。')],
    inputs:[{message:U('读一下 parse-helper.ts 的当前实现。'),userInput:true},{message:U('顺带看下它的测试。'),userInput:true}],
    reply:{model:'synth-a', stop_reason:'tool_use', content:[
      {type:'tool_use', id:'call_rc_1', name:'read_file', input:{path:'src/parse-helper.ts'}}]},
    tools:[TOOL_READ, TOOL_BASH, TOOL_GREP], bodyState:'available', bodyReason:null,
    delta:[4,5], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[{call_id:'call_rc_1', ord:0, tool_name:'read_file', result_req:103, result_ord:4, result_path:'request.messages[4].content[0]', state:'resolved'}],
    usage:{in:2600,out:96,read:3400,write:120,cost:0.0029}, timing:{ms:1780,ttft:410,flow:1370,firstText:null} },

  { id:103, title:'读取结果与继续回答', status:200, protocol:'anthropic',
    history:[A('空状态在 renderEmpty 里渲染，只有一个分支。'), U('读一下 parse-helper.ts 的当前实现。')],
    inputs:[{message:{role:'user', content:[{type:'tool_result', tool_use_id:'call_rc_1', content:'export function renderEmpty(list){ return list.length ? null : hint ?? "暂无条目"; }'}]}, userInput:false}],
    reply:{model:'synth-a', stop_reason:'end_turn', content:[
      {type:'text', text:'当前实现只区分「列表为空」，没有区分「筛选后为空」，两者都落到「暂无条目」。'},
      {type:'text', text:'hint 变量从全局取，测试里没有覆盖筛选场景。'}]},
    tools:[TOOL_READ, TOOL_BASH, TOOL_GREP], bodyState:'available', bodyReason:null,
    delta:[4], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[], usage:{in:3100,out:388,read:3900,write:300,cost:0.0048}, timing:{ms:3120,ttft:505,flow:2560,firstText:590} },

  { id:104, title:'搜索其它组件的筛选空态处理', status:200, protocol:'anthropic',
    history:[U('读一下 parse-helper.ts 的当前实现。'), A('当前实现只区分「列表为空」，没有区分「筛选后为空」。')],
    inputs:[{message:U('搜一下其它组件怎么处理筛选后为空。'),userInput:true},{message:U('重点看表格类组件。'),userInput:true}],
    reply:{model:'synth-a', stop_reason:'tool_use', content:[
      {type:'tool_use', id:'call_amb_1', name:'Grep', input:{pattern:'filtered.length === 0'}}]},
    tools:[TOOL_READ, TOOL_BASH, TOOL_GREP], bodyState:'available', bodyReason:null,
    delta:[4,5], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[{call_id:'call_amb_1', ord:0, tool_name:'Grep', result_req:null, result_ord:null, result_path:null, state:'ambiguous'}],
    usage:{in:4200,out:60,read:4200,write:400,cost:0.0051}, timing:{ms:1500,ttft:420,flow:1100,firstText:null} },

  { id:105, title:'分支：先看规范文档', status:200, protocol:'anthropic',
    history:[A('搜索结果有多个候选，关联未确认。'), U('（换方向）先看设计规范。')],
    inputs:[{message:U('分支：直接看设计规范里的空状态一节。'),userInput:true},{message:U('版本用最新的。'),userInput:true}],
    reply:{model:'synth-a', stop_reason:'end_turn', content:[
      {type:'text', text:'规范要求区分三种空态：初始为空、筛选为空、加载失败；文案各不相同。'},
      {type:'text', text:'本分支只查规范，不改动代码；主链稍后按规范落地。'}]},
    tools:[TOOL_READ, TOOL_BASH, TOOL_GREP], bodyState:'available', bodyReason:null,
    delta:[4,5], prevRelation:'branch', chainRole:'branch', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[], usage:{in:4400,out:300,read:4400,write:200,cost:0.0055}, timing:{ms:2200,ttft:500,flow:1700,firstText:580} },

  { id:106, title:'标题生成请求（辅助）', status:200, protocol:'anthropic',
    history:[], inputs:[{message:U('为这段会话生成一个简短标题。'),userInput:false}],
    reply:null,
    tools:undefined, bodyState:'pending', bodyReason:'合成：正文回调未到',
    delta:null, prevRelation:'aux', chainRole:'aux', purposeChain:'exclude', reqKind:'title', modelTitle:'空状态排查',
    have:3, costState:'zero', titleSource:'model_time', routeState:'absent',
    toolCalls:[], usage:{in:300,out:12,read:0,write:0,cost:0}, timing:{ms:900,ttft:null,flow:null,firstText:null} },

  { id:107, title:'补空状态（HTTP 500，回复部分保留）', status:500, protocol:'anthropic',
    history:[A('规范要求区分三种空态。'), U('按规范补上。')],
    inputs:[
      {message:U('把两种空状态都补上。'),userInput:true},
      {message:U('用规范里的文案。'),userInput:true},
      {message:U('改完直接跑检查。'),userInput:true}],
    reply:{model:'synth-a', stop_reason:'end_turn', content:[
      {type:'text', text:'我先补初始为空的分支，再加筛选为空的提示。上游返回 500 之前，这一段回复已经生成并保留。'}]},
    tools:[TOOL_READ, TOOL_BASH, TOOL_GREP], bodyState:'available', bodyReason:null,
    delta:[4,5,6], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[], usage:{in:5100,out:96,read:7000,write:500,cost:0.0064}, timing:{ms:12800,ttft:640,flow:null,firstText:700},
    attempts:[
      {index:0, model:'synth-a', effort:null, status:429, fail:'上游限流，随后尝试下一候选', error:null,
        start_ms:startOf({id:107})-12800, ms:360, ttft_ms:null, flow_ms:null, first_text_ms:null,
        first_reasoning_ms:null, served:null, done:true, tier_served:null, reasoning_hidden:null, queued_ms:38},
      {index:1, model:'synth-c', effort:null, status:500, fail:'上游返回 500，客户端请求最终失败', error:null,
        start_ms:startOf({id:107})-12100, ms:12100, ttft_ms:640, flow_ms:null, first_text_ms:700,
        first_reasoning_ms:null, served:null, done:true, tier_served:null, reasoning_hidden:null, queued_ms:52},
    ] },

  { id:108, title:'继续列改动（长度上限截断）', status:200, protocol:'chat',
    history:[U('把两种空状态都补上。'), A('我先补初始为空的分支（上一笔 HTTP 500 中断）。')],
    inputs:[{message:U('继续，把改动列完整。'),userInput:true},{message:U('按文件分组。'),userInput:true}],
    reply:{model:'synth-c', choices:[{finish_reason:'length', message:{role:'assistant', content:[
      {type:'text', text:'改动清单：'},
      {type:'text', text:'一、parse-helper 增加 emptyKind 参数，空态文案按种类选取；'},
      {type:'text', text:'二、（后续内容因长度上限截断）'}]}}]},
    tools:[TOOL_READ, TOOL_BASH, TOOL_GREP], bodyState:'available', bodyReason:null,
    delta:[4,5], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[], usage:{in:5300,out:2048,read:7000,write:500,cost:0.0121}, timing:{ms:12800,ttft:488,flow:12312,firstText:566} },

  { id:109, title:'Anthropic max_tokens 截断样本', status:200, protocol:'anthropic',
    history:[U('继续，把改动列完整。'), A('改动清单：一、parse-helper…（截断）')],
    inputs:[{message:U('接着上一条继续。'),userInput:true},{message:U('不用重复已列的。'),userInput:true}],
    reply:{model:'synth-a', stop_reason:'max_tokens', content:[
      {type:'text', text:'改动清单（续）：'},
      {type:'text', text:'二、RequestList 传入 emptyKind；三、测试补筛选场景。'}]},
    tools:[TOOL_READ, TOOL_BASH, TOOL_GREP], bodyState:'available', bodyReason:null,
    delta:[4,5], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[], usage:{in:5600,out:2048,read:7400,write:500,cost:0.0118}, timing:{ms:9800,ttft:470,flow:9300,firstText:540} },

  { id:110, title:'未知停止原因样本', status:200, protocol:'chat',
    history:[A('改动清单（续）：二、三…'), U('把这些改动落地。')],
    inputs:[{message:U('把上面的改动直接落地。'),userInput:true},{message:U('先只改 parse-helper。'),userInput:true}],
    reply:{model:'synth-c', choices:[{finish_reason:'refusal', message:{role:'assistant', content:'这个改动范围我需要先确认边界再继续。'}}]},
    tools:[TOOL_READ, TOOL_BASH, TOOL_GREP], bodyState:'available', bodyReason:null,
    delta:[4,5], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[], usage:{in:5800,out:80,read:7600,write:300,cost:0.0049}, timing:{ms:1400,ttft:400,flow:1000,firstText:460} },

  { id:111, title:'缩小范围后落地', status:200, protocol:'chat',
    history:[U('先只改 parse-helper。'), A('这个改动范围我需要先确认边界再继续。')],
    inputs:[{message:U('只改 parse-helper 一个文件。'),userInput:true},{message:U('其它文件下一轮再说。'),userInput:true}],
    reply:{model:'synth-c', choices:[{finish_reason:'stop', message:{role:'assistant', content:[
      {type:'text', text:'已按最小范围落地 parse-helper：'},
      {type:'text', text:'renderEmpty 增加第二个参数，调用方传入 emptyKind；'},
      {type:'text', text:'其它文件保持不动，下一轮再处理。'}]}}]},
    tools:[TOOL_READ, TOOL_BASH, TOOL_GREP], bodyState:'available', bodyReason:null,
    delta:[4,5], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[], usage:{in:6000,out:520,read:7800,write:400,cost:0.0091}, timing:{ms:4100,ttft:490,flow:3600,firstText:560} },

  { id:112, title:'空工具样本 + 重复 call_id', status:200, protocol:'chat',
    system:`${SYS}\n这一轮只读，不修改文件。`,
    history:[A('已按最小范围落地 parse-helper。'), U('再搜一遍确认没漏。')],
    inputs:[{message:U('再搜一遍空状态的引用，确认没漏。'),userInput:true}],
    reply:{model:'synth-c', choices:[{finish_reason:'tool_calls', message:{role:'assistant', content:null, tool_calls:[
      {id:'call_rc_1', type:'function', function:{name:'Grep', arguments:'{"pattern":"暂无条目"}'}}]}}]},
    tools:undefined, bodyState:'available', bodyReason:null,
    delta:[4], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[{call_id:'call_rc_1', ord:0, tool_name:'Grep', result_req:null, result_ord:null, result_path:null, state:'unpaired'}],
    usage:{in:6200,out:40,read:8000,write:200,cost:0.0032}, timing:{ms:1200,ttft:380,flow:800,firstText:null} },

  { id:113, title:'正文不完整 + 结果位置待定', status:200, protocol:'anthropic',
    history:[U('再搜一遍空状态的引用。'), A('（结果未确认）')],
    inputs:[{message:U('回头读一下 parse-helper 的现状。'),userInput:true}],
    reply:{model:'synth-a', stop_reason:'tool_use', content:[
      {type:'tool_use', id:'call_pend_1', name:'read_file', input:{path:'src/parse-helper.ts'}}]},
    tools:[TOOL_READ, TOOL_BASH, TOOL_GREP], bodyState:'partial', bodyReason:'合成：正文回调只到达一半',
    delta:[4], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[{call_id:'call_pend_1', ord:0, tool_name:'read_file', result_req:null, result_ord:null, result_path:null, state:'pending'}],
    usage:{in:6300,out:70,read:8100,write:200,cost:0.0038}, timing:{ms:1600,ttft:410,flow:1200,firstText:null} },

  { id:114, title:'工具字段格式未识别样本', status:200, protocol:'anthropic',
    history:[U('回头读一下 parse-helper 的现状。'), A('（正文不完整）')],
    inputs:[{message:U('把 parse-helper 全文打出来。'),userInput:true}],
    reply:{model:'synth-a', stop_reason:'tool_use', content:[
      {type:'tool_use', id:'call_un_1', name:'read_file', input:{path:'src/parse-helper.ts'}}]},
    tools:'all', bodyState:'available', bodyReason:null,
    delta:[4], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    routeState:'expired',
    toolCalls:[{call_id:'call_un_1', ord:0, tool_name:'read_file', result_req:null, result_ord:null, result_path:null, state:'unpaired'}],
    usage:{in:6400,out:30,read:8200,write:100,cost:0.0029}, timing:{ms:1100,ttft:360,flow:700,firstText:null} },

  { id:115, title:'同名工具定义样本', status:200, protocol:'anthropic',
    history:[U('把 parse-helper 全文打出来。'), A('（工具定义不可唯一识别）')],
    inputs:[{message:U('再读一次 parse-helper，看最新版本。'),userInput:true}],
    reply:{model:'synth-a', stop_reason:'tool_use', content:[
      {type:'tool_use', id:'call_dup_rf', name:'read_file', input:{path:'src/parse-helper.ts'}}]},
    tools:[TOOL_READ, TOOL_READ_ALT, TOOL_BASH], bodyState:'available', bodyReason:null,
    delta:[4], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[{call_id:'call_dup_rf', ord:0, tool_name:'read_file', result_req:116, result_ord:4, result_path:'request.messages[4].content[0]', state:'resolved'}],
    usage:{in:6500,out:30,read:8300,write:100,cost:0.0029}, timing:{ms:1150,ttft:370,flow:780,firstText:null} },

  { id:116, title:'运行检查（两调用同请求）', status:200, protocol:'anthropic',
    history:[U('再读一次 parse-helper，看最新版本。'), A('（读取结果在下一笔）')],
    inputs:[
      {message:{role:'user', content:[{type:'tool_result', tool_use_id:'call_dup_rf', content:'export function renderEmpty(list, kind){ return kind === "filtered" ? "没有匹配的条目" : "暂无条目"; }'}]}, userInput:false},
      {message:U('运行检查。'),userInput:true}],
    reply:{model:'synth-a', stop_reason:'tool_use', content:[
      {type:'tool_use', id:'call_chk_bash', name:'Bash', input:{command:'bun test tests/parse-helper.test.ts'}},
      {type:'tool_use', id:'call_chk_read', name:'read_file', input:{path:'tests/parse-helper.test.ts'}}]},
    tools:[TOOL_READ, TOOL_BASH, TOOL_GREP], bodyState:'available', bodyReason:null,
    delta:[4,5], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[
      {call_id:'call_chk_bash', ord:0, tool_name:'Bash', result_req:117, result_ord:4, result_path:'request.messages[4].content[0]', state:'resolved'},
      {call_id:'call_chk_read', ord:1, tool_name:'read_file', result_req:117, result_ord:4, result_path:'request.messages[4].content[1]', state:'resolved'}],
    usage:{in:7900,out:132,read:9400,write:600,cost:0.0149}, timing:{ms:1810,ttft:392,flow:1418,firstText:null} },

  { id:117, title:'检查结果与结论', status:200, protocol:'anthropic',
    history:[U('运行检查。'), A('（两个调用的结果都在这笔输入里）')],
    inputs:[{message:{role:'user', content:[
      {type:'tool_result', tool_use_id:'call_chk_bash', content:'3 checks passed: initial empty, filtered empty, fallback hint.'},
      {type:'tool_result', tool_use_id:'call_chk_read', content:'tests/parse-helper.test.ts 共 41 行，覆盖三种空状态断言。'}]}, userInput:false}],
    reply:{model:'synth-a', stop_reason:'end_turn', content:[
      {type:'text', text:'检查通过：初始为空、筛选为空、fallback 三种断言都在。'},
      {type:'text', text:'剩下只差最终文案确认；改动范围保持一个文件。'}]},
    tools:[TOOL_READ, TOOL_BASH, TOOL_GREP], bodyState:'available', bodyReason:null,
    delta:[4], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[], usage:{in:8200,out:780,read:9600,write:600,cost:0.0156}, timing:{ms:4810,ttft:512,flow:4298,firstText:604},
    attempts:[
      {index:0, model:'synth-a', effort:null, status:429, fail:'上游限流，随后尝试下一候选', error:null,
        start_ms:startOf({id:117})-4810, ms:360, ttft_ms:null, flow_ms:null, first_text_ms:null,
        first_reasoning_ms:null, served:null, done:true, tier_served:null, reasoning_hidden:null, queued_ms:41},
      {index:1, model:'synth-a', effort:null, status:200, fail:null, error:null,
        start_ms:startOf({id:117})-4450, ms:4450, ttft_ms:512, flow_ms:3938, first_text_ms:604,
        first_reasoning_ms:null, served:'synth-a', done:true, tier_served:null, reasoning_hidden:null, queued_ms:44},
    ] },

  { id:118, title:'查文档建议（未声明工具）', status:200, protocol:'anthropic',
    history:[A('检查通过，只差文案确认。'), U('查下官方建议。')],
    inputs:[{message:U('查一下官方文档对空状态文案的建议。'),userInput:true},{message:U('回来再定稿。'),userInput:true}],
    reply:{model:'synth-a', stop_reason:'tool_use', content:[
      {type:'text', text:'我先查文档建议，回来再定稿；这一轮还没有结论。'},
      {type:'text', text:'| 场景 | 建议文案 |\n| --- | --- |\n| 尚无请求 | 等待第一笔请求 |\n| 筛选为空 | 调整筛选条件 |\n\n- 空状态只说明当前事实，不解释原因。\n- 两种空状态使用不同文案。'},
      {type:'tool_use', id:'call_ws_1', name:'WebSearch', input:{query:'empty state copy guideline'}}]},
    tools:[TOOL_READ, TOOL_BASH, TOOL_GREP], bodyState:'available', bodyReason:null,
    delta:[4,5], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[{call_id:'call_ws_1', ord:0, tool_name:'WebSearch', result_req:null, result_ord:null, result_path:null, state:'unpaired'}],
    usage:{in:8400,out:160,read:9800,write:600,cost:0.0061}, timing:{ms:1900,ttft:430,flow:1400,firstText:500} },

  // Task 7 验收：45 条消息的深样本，覆盖结构 40+5 分页、消息详情与返回。
  { id:119, title:'长上下文样本（45 条消息）', status:200, protocol:'anthropic',
    history:Array.from({length:42}, (_, i) => i % 2 === 0
      ? U(`历史问题 ${Math.floor(i / 2) + 1}：长上下文分页怎么读？`)
      : A(`历史回答 ${Math.floor(i / 2) + 1}：按 40 条一片连续读取，缺口不静默跳过。`)),
    inputs:[{message:U('把上面的约定整理成三条。'),userInput:true}],
    reply:{model:'synth-a', stop_reason:'end_turn', content:[
      {type:'text', text:'一、结构按 40+5 分页；二、缺口提示不冒充已读；三、返回列表保留计数。'}]},
    tools:[TOOL_READ, TOOL_BASH], bodyState:'available', bodyReason:null,
    delta:[44], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[],
    usage:{in:9000,out:120,read:10000,write:700,cost:0.0081}, timing:{ms:2100,ttft:420,flow:1680,firstText:480} },
];

// 窗口会话：52 笔简单请求，默认 30 笔窗口留下更早历史，够翻两页。
const WINDOW_REQUESTS: SynthRequest[] = Array.from({length: 52}, (_, i) => ({
  id: 500 + i, title: `窗口样本 ${i + 1}`, status: 200, protocol: 'anthropic',
  history: [], inputs: [{message: U(`窗口样本问题 ${i + 1}`), userInput: true}],
  reply: {model: 'synth-a', stop_reason: 'end_turn', content: [{type: 'text', text: `窗口样本回答 ${i + 1}`}]},
  tools: [TOOL_READ], bodyState: 'available', bodyReason: null,
  delta: [2], prevRelation: i === 0 ? 'first' : 'confirmed', chainRole: 'main',
  purposeChain: 'participate', reqKind: 'chat', modelTitle: null,
  toolCalls: [],
  usage: {in: 100 + i, out: 20, read: 0, write: 0, cost: 0.001},
  timing: {ms: 1000 + i, ttft: 100, flow: 800, firstText: 120},
}));

// 缺通道会话：第一笔缺正文回调与路由，第二笔恢复。用来展示缺正文标记、
// 身份完整性异常与「新增输入未确认」，不把缺失写成 0 或空会话。
const HOOK_REQUESTS: SynthRequest[] = [
  { id:600, title:'正文回调缺失（保留身份与读数）', status:200, protocol:'anthropic',
    history:[], inputs:[{message:U('把工作目录下的说明读一遍。'),userInput:true}],
    reply:null, tools:undefined, bodyState:'pending', bodyReason:'合成：回调没有到达',
    delta:null, prevRelation:'unknown', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    have:3, routeState:'absent',
    toolCalls:[], usage:{in:2400,out:null,read:null,write:null,cost:null},
    timing:{ms:null,ttft:null,flow:null,firstText:null} },

  { id:601, title:'正文回调恢复后的下一笔', status:200, protocol:'chat',
    history:[U('把工作目录下的说明读一遍。')],
    inputs:[{message:U('按说明里的入口逐个确认。'),userInput:true}],
    reply:{model:'synth-c', choices:[{finish_reason:'stop', message:{role:'assistant', content:[
      {type:'text', text:'入口已逐个确认：请求列表、请求详情、会话视图三个都可达。'}]}}]},
    tools:[TOOL_READ], bodyState:'available', bodyReason:null,
    delta:[2], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[], usage:{in:2600,out:210,read:1200,write:0,cost:0.0031},
    timing:{ms:2600,ttft:460,flow:1900,firstText:520} },
];

// 轮次配对会话：13 笔请求、7 个已结算轮，逐个覆盖轮次判据的场景样本。
// 703 被打断不结算；709 的终点带着新命令，回复归新轮两端同笔；
// 711 正文已回收但起点照常进带，命令与回复面板落回收态。
const TURN_REQUESTS: SynthRequest[] = [
  { id:700, title:'帮我把 README 的安装一节重写。', status:200, protocol:'anthropic',
    history:[], inputs:[{message:U('帮我把 README 的安装一节重写。'),userInput:true}],
    reply:{model:'synth-a', stop_reason:'tool_use', content:[
      {type:'tool_use', id:'call_t1', name:'read_file', input:{path:'README.md'}}]},
    tools:[TOOL_READ, TOOL_BASH], bodyState:'available', bodyReason:null,
    delta:[2], prevRelation:'first', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[{call_id:'call_t1', ord:0, tool_name:'read_file', result_req:701, result_ord:4, result_path:'request.messages[4].content[0]', state:'resolved'}],
    usage:{in:2100,out:88,read:0,write:100,cost:0.0022}, timing:{ms:1720,ttft:402,flow:1310,firstText:null} },

  { id:701, title:'读取结果与重写收尾', status:200, protocol:'anthropic',
    history:[U('帮我把 README 的安装一节重写。'), A('（读取 README 的调用在下一笔）')],
    inputs:[{message:{role:'user', content:[{type:'tool_result', tool_use_id:'call_t1', content:'# Install\nnpm install 后运行 bun run setup 即可。'}]}, userInput:false}],
    reply:{model:'synth-a', stop_reason:'end_turn', content:[
      {type:'text', text:'安装一节已重写：步骤按系统依赖分组，验证命令放在末尾，原段落里过时的全局安装路径已移除。'}]},
    tools:[TOOL_READ, TOOL_BASH], bodyState:'available', bodyReason:null,
    delta:[4], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[], usage:{in:2900,out:310,read:3200,write:260,cost:0.0044}, timing:{ms:3050,ttft:498,flow:2500,firstText:580} },

  { id:702, title:'顺便检查一下 README 里的链接有效性。', status:200, protocol:'anthropic',
    history:[A('安装一节已重写：步骤按系统依赖分组。')],
    inputs:[{message:U('顺便检查一下 README 里的链接有效性。'),userInput:true}],
    reply:{model:'synth-a', stop_reason:'end_turn', content:[
      {type:'text', text:'链接逐个检查过：三个外链都可达，两个章节锚点因重写换了标题，已一并修正。'}]},
    tools:[TOOL_READ, TOOL_BASH], bodyState:'available', bodyReason:null,
    delta:[3], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[], usage:{in:3300,out:240,read:3600,write:180,cost:0.0039}, timing:{ms:2410,ttft:470,flow:1900,firstText:560} },

  { id:703, title:'再把贡献指南补一节。', status:200, protocol:'anthropic',
    history:[A('链接检查完成，锚点已修正。')],
    inputs:[{message:U('再把贡献指南补一节。'),userInput:true}],
    reply:{model:'synth-a', stop_reason:'tool_use', content:[
      {type:'tool_use', id:'call_t2', name:'read_file', input:{path:'CONTRIBUTING.md'}}]},
    tools:[TOOL_READ, TOOL_BASH], bodyState:'available', bodyReason:null,
    delta:[3], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[{call_id:'call_t2', ord:0, tool_name:'read_file', result_req:null, result_ord:null, result_path:null, state:'unpaired'}],
    usage:{in:3600,out:52,read:3900,write:120,cost:0.0028}, timing:{ms:1310,ttft:405,flow:900,firstText:null} },

  { id:704, title:'算了，先处理部署脚本的问题。', status:200, protocol:'anthropic',
    history:[A('（贡献指南的读取被新命令打断）')],
    inputs:[{message:U('算了，先处理部署脚本的问题。'),userInput:true}],
    reply:{model:'synth-a', stop_reason:'end_turn', content:[
      {type:'text', text:'部署脚本的问题定位在 env 加载顺序：变量在读取前被引用，已改为显式传入。贡献指南被打断，没有产出。'}]},
    tools:[TOOL_READ, TOOL_BASH], bodyState:'available', bodyReason:null,
    delta:[3], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[], usage:{in:3900,out:290,read:4200,write:200,cost:0.0046}, timing:{ms:2870,ttft:480,flow:2360,firstText:590} },

  { id:705, title:'跑一下完整测试。', status:200, protocol:'anthropic',
    history:[A('部署脚本的问题已修复。')],
    inputs:[{message:U('跑一下完整测试。'),userInput:true}],
    reply:{model:'synth-a', stop_reason:'tool_use', content:[
      {type:'tool_use', id:'call_t3', name:'Bash', input:{command:'bun test'}}]},
    tools:[TOOL_READ, TOOL_BASH], bodyState:'available', bodyReason:null,
    delta:[3], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[{call_id:'call_t3', ord:0, tool_name:'Bash', result_req:706, result_ord:3, result_path:'request.messages[3].content[0]', state:'resolved'}],
    usage:{in:4200,out:46,read:4500,write:100,cost:0.0027}, timing:{ms:1180,ttft:380,flow:790,firstText:null} },

  { id:706, title:'完整测试收尾（队列前旧任务的总结）', status:200, protocol:'anthropic',
    history:[U('跑一下完整测试。')],
    inputs:[{message:{role:'user', content:[{type:'tool_result', tool_use_id:'call_t3', content:'42 pass, 0 fail'}]}, userInput:false}],
    reply:{model:'synth-a', stop_reason:'end_turn', content:[
      {type:'text', text:'完整测试跑完：42 通过 0 失败。测试这条任务到这里收尾。'}]},
    tools:[TOOL_READ, TOOL_BASH], bodyState:'available', bodyReason:null,
    delta:[3], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[], usage:{in:4500,out:150,read:4800,write:140,cost:0.0036}, timing:{ms:2010,ttft:450,flow:1540,firstText:570} },

  { id:707, title:'把测试输出也存一份到 reports/。', status:200, protocol:'anthropic',
    history:[A('完整测试通过，42 通过 0 失败。')],
    inputs:[{message:U('把测试输出也存一份到 reports/。'),userInput:true,kind:'midturn'}],
    reply:{model:'synth-a', stop_reason:'tool_use', content:[
      {type:'tool_use', id:'call_t4', name:'Bash', input:{command:'bun test | tee reports/test-run.txt'}}]},
    tools:[TOOL_READ, TOOL_BASH], bodyState:'available', bodyReason:null,
    delta:[3], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[{call_id:'call_t4', ord:0, tool_name:'Bash', result_req:708, result_ord:3, result_path:'request.messages[3].content[0]', state:'resolved'}],
    usage:{in:4800,out:50,read:5100,write:110,cost:0.0028}, timing:{ms:1220,ttft:390,flow:820,firstText:null} },

  { id:708, title:'测试输出存档收尾', status:200, protocol:'anthropic',
    history:[U('把测试输出也存一份到 reports/。')],
    inputs:[{message:{role:'user', content:[{type:'tool_result', tool_use_id:'call_t4', content:'written reports/test-run.txt'}]}, userInput:false}],
    reply:{model:'synth-a', stop_reason:'end_turn', content:[
      {type:'text', text:'输出已存到 reports/test-run.txt，与终端一致。'}]},
    tools:[TOOL_READ, TOOL_BASH], bodyState:'available', bodyReason:null,
    delta:[3], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[], usage:{in:5100,out:110,read:5400,write:120,cost:0.0031}, timing:{ms:1640,ttft:440,flow:1190,firstText:560} },

  { id:709, title:'看看部署脚本的现状。', status:200, protocol:'anthropic',
    history:[A('输出已存档到 reports/。')],
    inputs:[{message:U('看看部署脚本的现状。'),userInput:true}],
    reply:{model:'synth-a', stop_reason:'tool_use', content:[
      {type:'tool_use', id:'call_t5', name:'read_file', input:{path:'scripts/deploy.sh'}}]},
    tools:[TOOL_READ, TOOL_BASH], bodyState:'available', bodyReason:null,
    delta:[3], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[{call_id:'call_t5', ord:0, tool_name:'read_file', result_req:710, result_ord:3, result_path:'request.messages[3].content[0]', state:'resolved'}],
    usage:{in:5400,out:48,read:5700,write:100,cost:0.0027}, timing:{ms:1190,ttft:385,flow:800,firstText:null} },

  { id:710, title:'直接把回滚说明加上。', status:200, protocol:'anthropic',
    history:[U('看看部署脚本的现状。')],
    inputs:[
      {message:{role:'user', content:[{type:'tool_result', tool_use_id:'call_t5', content:'#!/usr/bin/env bash\nset -euo pipefail\nbun run build && bun run restart'}]}, userInput:false},
      {message:U('直接把回滚说明加上。'),userInput:true}],
    reply:{model:'synth-a', stop_reason:'end_turn', content:[
      {type:'text', text:'回滚说明已加到部署脚本末尾：记录上一版构建号，restart 失败时按号回退。'}]},
    tools:[TOOL_READ, TOOL_BASH], bodyState:'available', bodyReason:null,
    delta:[3,4], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[], usage:{in:5900,out:260,read:6300,write:180,cost:0.0041}, timing:{ms:2520,ttft:470,flow:2020,firstText:580} },

  { id:711, title:'回顾一下今天的改动。', status:200, protocol:'anthropic',
    history:[A('回滚说明已加到部署脚本末尾。')],
    inputs:[{message:U('回顾一下今天的改动。'),userInput:true}],
    reply:{model:'synth-a', stop_reason:'end_turn', content:[
      {type:'text', text:'今天动了三处：README 安装一节重写、部署脚本 env 加载修复、回滚说明补充。测试保持全绿。'}]},
    tools:[TOOL_READ, TOOL_BASH], bodyState:'evicted', bodyReason:'合成：正文已回收（演示回收起点）',
    delta:[3], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[], usage:{in:6200,out:180,read:6600,write:150,cost:0.0037}, timing:{ms:2130,ttft:460,flow:1650,firstText:570} },
];

const byId = new Map([...REQUESTS, ...WINDOW_REQUESTS, ...HOOK_REQUESTS, ...TURN_REQUESTS].map(r => [r.id, r]));

/**
 * 已结算轮表：模块一阶段按判据手工推导的固定列表，只服务界面验证，不参与
 * 生产验收。轮号是会话内已结算轮的全序序号；缺通道会话没有可结算轮，
 * 轮次带整条不渲染。
 */
const TURNS_BY_SESSION = new Map<string, TurnPairRow[]>([
  [convKey, [
    {turn:1, start_req:101, ordinals:[2,3], reply_req:101},
    {turn:2, start_req:102, ordinals:[4,5], reply_req:103},
    {turn:3, start_req:107, ordinals:[4,5,6], reply_req:107},
    {turn:4, start_req:111, ordinals:[4,5], reply_req:111},
    {turn:5, start_req:116, ordinals:[5], reply_req:117},
    {turn:6, start_req:119, ordinals:[44], reply_req:119},
  ]],
  [convWindow, WINDOW_REQUESTS.map((r, i) => ({turn:i+1, start_req:r.id, ordinals:[2], reply_req:r.id}))],
  [convHook, []],
  [convTurns, [
    {turn:1, start_req:700, ordinals:[2], reply_req:701},
    {turn:2, start_req:702, ordinals:[3], reply_req:702},
    {turn:3, start_req:704, ordinals:[3], reply_req:704},
    {turn:4, start_req:705, ordinals:[3], reply_req:706},
    {turn:5, start_req:707, ordinals:[3], reply_req:708},
    {turn:6, start_req:710, ordinals:[4], reply_req:710},
    {turn:7, start_req:711, ordinals:[3], reply_req:711},
  ]],
]);

/** 合成会话池：列表顺序即 Demo 的默认会话顺序。 */
const POOLS = [
  { key: convKey, title: '空状态排查（合成场景）', agent: 'claude', rows: REQUESTS, flags: ['failed', 'missing_body'] },
  { key: convWindow, title: '窗口分页样本（合成）', agent: 'omp', rows: WINDOW_REQUESTS, flags: [] },
  { key: convHook, title: '缺少通道的请求（合成）', agent: 'claude', rows: HOOK_REQUESTS, flags: ['missing_body'] },
  { key: convTurns, title: '轮次配对样本（合成）', agent: 'claude', rows: TURN_REQUESTS, flags: ['missing_body'] },
];

const convOf = (r: SynthRequest) => r.id >= 700 ? convTurns : r.id >= 600 ? convHook : r.id >= 500 ? convWindow : convKey;
const agentOf = (r: SynthRequest) => r.id >= 500 && r.id < 600 ? 'omp' : 'claude';
const haveOf = (r: SynthRequest) => r.have ?? 7;
const titleSourceOf = (r: SynthRequest) => r.titleSource ?? 'user_delta';
const costStateOf = (r: SynthRequest) => r.costState
  ?? (r.usage.cost === null ? 'absent' : r.usage.cost === 0 ? 'zero' : 'priced');
const systemOf = (r: SynthRequest) => r.system ?? SYS;

const PARTS_ORDER = ['system', 'tools', 'memory', 'files', 'results', 'chat'];
const PARTS_WEIGHT = [0.06, 0.12, 0.18, 0.10, 0.18, 0.36];

/**
 * 路由侧 prompt 构成：总量取输入 + 缓存，六类按固定权重分配。
 * 正文不可读时返回 missing，界面据此不画构成条，也不把缺数据当 0。
 */
function promptOf(r: SynthRequest): PromptReading {
  if (r.bodyState !== 'available') {
    return {state:'missing', reason:'legacy_unknown', actual_version:null, tokens:null, counted:null,
      window:null, held:null, parts:[], ratio:null, legacy:false, note:null};
  }
  const tokens = (r.usage.in ?? 0) + (r.usage.read ?? 0) + (r.usage.write ?? 0);
  const window = r.protocol === 'chat' ? 128000 : 200000;
  const parts = PARTS_ORDER.map((kind, index) => ({kind, tokens: Math.round(tokens * (PARTS_WEIGHT[index] ?? 0))}));
  return {state:'recomputed', reason:'complete', actual_version:1, tokens, counted:true, window, held:null,
    parts, ratio: window > 0 ? tokens / window : null, legacy:false, note:null};
}

/** 尝试链：只有显式给出时才是 present；没有尝试不冒充失败。 */
function attemptsOf(r: SynthRequest): AttemptChain {
  if (r.attempts !== undefined) {
    return {state:'present', items:r.attempts,
      timing:{state:'recorded', note:'时间来自各次尝试的开始时间'}};
  }
  return {state:'empty', items:[], timing:{state:'absent', note:'合成场景没有尝试链'}};
}

/** 路由三态：absent 没有 summary，expired 有身份但摘要已回收。 */
function routeOf(r: SynthRequest): {state: 'available' | 'absent' | 'expired'; summary: RouteSummaryReading | null} {
  const state = r.routeState ?? 'available';
  if (state !== 'available') return {state, summary:null};
  const prompt = promptOf(r);
  return {state, summary:{
    format:2, route_id:r.id, time_ms:startOf(r),
    model:'synth-group', served:r.protocol === 'chat' ? 'synth-c' : 'synth-a', provider:'relay-synth',
    status:r.status, ms:r.timing.ms, ttft:r.timing.ttft, flow:r.timing.flow, first_text:r.timing.firstText,
    kind:null, folder:null, effort:null,
    prompt:prompt.tokens === null ? null : {tokens:prompt.tokens, counted:true, window:prompt.window, held:null, parts:prompt.parts},
    error:null,
    order:[{model:'synth-group'}, {model:r.protocol === 'chat' ? 'synth-c' : 'synth-a'}],
    attempts:attemptsOf(r), affinity:null,
  }};
}

/** 反向配对：本请求承载了哪些调用方的结果块，与生产 tool_results 同形。 */
function toolResultsOf(r: SynthRequest): ToolResultIndexRow[] {
  const rows: ToolResultIndexRow[] = [];
  for (const owner of byId.values()) {
    for (const call of owner.toolCalls) {
      if (call.result_req === r.id) rows.push({...call, owner_req: owner.id});
    }
  }
  return rows.sort((a, b) => a.owner_req - b.owner_req || a.ord - b.ord);
}

/** 同一会话中上一笔参与主链的请求；辅助请求不参与，避免把分类器请求当上下文。 */
function mainPrevOf(r: SynthRequest): number | null {
  if (r.purposeChain === 'exclude' || r.chainRole === 'aux') return null;
  const pool = r.id >= 700 ? TURN_REQUESTS : r.id >= 600 ? HOOK_REQUESTS : r.id >= 500 ? WINDOW_REQUESTS : REQUESTS;
  for (let index = pool.indexOf(r) - 1; index >= 0; index -= 1) {
    const prev = pool[index]!;
    if (prev.purposeChain === 'exclude' || prev.chainRole === 'aux') continue;
    return prev.id;
  }
  return null;
}

function fullMessages(r: SynthRequest): SynthMessage[] {
  return [{role:'system', content:systemOf(r)}, {role:'user', content:BRIEF}, ...r.history, ...r.inputs.map(i => i.message)];
}

/** 列表行：与生产 RequestRow 同形，状态语义来自派生结果。 */
function rowOf(r: SynthRequest): RequestRow {
  return {
    req_id: r.id, conv_key: convOf(r), actor: 'actor-main', actor_state: 'known',
    agent: agentOf(r), started_ms: startOf(r), title: r.title, title_source: titleSourceOf(r),
    status: r.status, model_requested: 'synth-group', model_served: r.protocol === 'chat' ? 'synth-c' : 'synth-a',
    in_tok: r.usage.in, out_tok: r.usage.out, cache_read: r.usage.read, cache_write: r.usage.write,
    cost: r.usage.cost, cost_state: costStateOf(r), have: haveOf(r),
    ms: r.timing.ms, ttft_ms: r.timing.ttft, flow_ms: r.timing.flow,
    body_state: r.bodyState, miss_reason: r.bodyReason,
    input_preview: r.title, input_preview_kind: 'delta', reply_preview: null,
    reply_shape: r.reply === null ? null : replyShapeOf(r.reply),
    context_event: 'none',
    req_kind: r.reqKind, chain_role: r.chainRole, model_title: r.modelTitle,
    purpose_status: 'selected', purpose_version: 1, purpose_rule: null, purpose_chain: r.purposeChain,
    derived_state: 'current',
  };
}

/** 阅读版本：合成稳定值；同一请求的输入与正文状态不变时不变。 */
function readingTokenOf(r: SynthRequest): string {
  return 'r1-' + Buffer.from(`synth-${r.id}-${r.bodyState}`).toString('hex').padEnd(64, '0').slice(0, 64);
}

function detailOf(r: SynthRequest): ReadingDetail {
  const prompt = promptOf(r);
  const readingToken = readingTokenOf(r);
  return {
    req_id:r.id, conv_key:convOf(r), actor:'actor-main', actor_state:'known', agent:agentOf(r),
    started_ms:startOf(r), title:r.title, title_source:titleSourceOf(r), status:r.status,
    model_requested:'synth-group', model_served:r.protocol === 'chat' ? 'synth-c' : 'synth-a',
    in_tok:r.usage.in, out_tok:r.usage.out, cache_read:r.usage.read, cache_write:r.usage.write,
    cost:r.usage.cost, cost_state:costStateOf(r), have:haveOf(r),
    ms:r.timing.ms, ttft_ms:r.timing.ttft, flow_ms:r.timing.flow,
    body_state:r.bodyState, miss_reason:r.bodyState === 'available' ? null : r.bodyReason,
    input_preview:r.title, input_preview_kind:'delta', reply_preview:null,
    reply_shape:r.reply === null ? null : replyShapeOf(r.reply),
    context_event:'none',
    req_kind:r.reqKind, chain_role:r.chainRole, model_title:r.modelTitle,
    purpose_status:'selected', purpose_version:1, purpose_rule:null, purpose_chain:r.purposeChain,
    derived_state:'current',
    prev_req_id:mainPrevOf(r), prev_relation:r.prevRelation, delta_ordinals:r.delta,
    parse_state:r.bodyState === 'available' || r.bodyState === 'partial' ? 'ok' : null,
    reply_state:r.bodyState === 'available' || r.bodyState === 'partial' ? (r.reply === null ? 'absent' : 'ok') : null,
    first_text_ms:r.timing.firstText, reasoning:null,
    prompt_tokens:prompt.tokens, prompt_counted:prompt.counted === null ? null : prompt.counted ? 1 : 0,
    prompt_window:prompt.window, prompt_turns:null, parts:prompt.parts,
    attempt_count:r.attempts?.length ?? 1, attempt_billed:null, attempt_in:null, attempt_out:null,
    attempt_cache_read:null, attempt_cache_write:null, attempt_reasoning:null,
    attempt_cost:null, attempt_cost_state:'absent',
    summary_state:'recomputed', summary_algorithm:1, summary_basis:'{}',
    derive_version:1, archive:null, route_state:r.routeState ?? 'available', model_provider:'relay-synth',
    source_facts:{selected:null, hook:null},
    projection_meta:{prompt:{actualVersion:prompt.state === 'recomputed' ? 1 : null,
      state:prompt.state, reason:prompt.reason, basis:[]}},
    prompt,
    derivation:{state:'clean', chain_state:'current', summary_state:'current', reason:null},
    tool_calls:r.toolCalls, tool_results:toolResultsOf(r), historical:null, reading_token: readingToken,
  };
}

function capabilityOf(r: SynthRequest, coverage: {
  complete: boolean; reason: CapabilityView['coverage']['reason'];
  from: number; to: number; total: number | null;
}): CapabilityView {
  if (r.bodyState !== 'available' && r.bodyState !== 'partial') {
    return {tools:{state:'missing', items:[], reason:'body_unavailable'}, skills:{state:'missing', items:[], reason:'body_unavailable'}, coverage, agent:agentOf(r)};
  }
  if (r.bodyState === 'partial') {
    return {tools:{state:'partial', items:[], reason:'body_partial'}, skills:{state:'partial', items:[], reason:'body_partial'}, coverage, agent:agentOf(r)};
  }
  const tools = r.tools;
  let toolResult: CapabilityView['tools'];
  if (tools === undefined) toolResult = {state:'empty', items:[], reason:null};
  else if (!Array.isArray(tools)) toolResult = {state:'unrecognized', items:[], reason:'tools_not_array'};
  else toolResult = {state:'present', items:tools.map((t:any): ToolCapability => ({name:t.function.name, description:t.function.description, schema:t.function.parameters, source:'tools'})), reason:null};
  return {tools:toolResult, skills:{state:'present', items:SKILLS.map(skill => ({...skill, format:'claude-heading'})), reason:null}, coverage, agent:agentOf(r)};
}

function bodyPageOf(r: SynthRequest, from: number, to: number): BodyPage {
  const ms = fullMessages(r);
  const readable = r.bodyState === 'available' || r.bodyState === 'partial';
  const total = readable ? ms.length : null;
  const sliced = readable && from < to
    ? ms.slice(from, Math.min(to, ms.length)).map((message, i) => ({ord:from+i, value:message}))
    : [];
  const interpretations = ms.map((message, index): MessageInterpretation | null => {
    if (message.role !== 'user') return null;
    const input = r.inputs.find(i => i.message === message);
    if (input === undefined || !input.userInput) return {ord:index, role:'user', role_state:'known', input:null, is_input:false};
    const text = typeof message.content === 'string' ? message.content : '';
    return {ord:index, role:'user', role_state:'known',
      input:{state:'text', kind:input.kind ?? 'plain', text, original:text, removed:[], agent:'synthetic-agent', rule:'generic'},
      is_input:true};
  }).filter((item): item is MessageInterpretation => item !== null);
  const coverage: BodyCoverage = {from, to, total, complete:r.bodyState === 'available',
    loaded_complete:readable && total !== null && to >= total,
    reason:r.bodyState === 'available' ? 'available' : r.bodyState === 'partial' ? 'body_partial' : 'body_unavailable'};
  return {
    state:r.bodyState,
    parse_state:r.bodyState === 'available' || r.bodyState === 'partial' ? 'ok' : null,
    reply_state:r.bodyState === 'available' || r.bodyState === 'partial' ? (r.reply === null ? 'absent' : 'ok') : null,
    from, to, total, messages:sliced,
    request_fields:readable && from === 0 ? {model:r.protocol === 'chat' ? 'synth-group' : 'synth-a', stream:true, system:systemOf(r), ...(r.tools === undefined ? {} : {tools:r.tools})} : null,
    reply:readable && from === 0 ? r.reply : null,
    reason:r.bodyState === 'available' ? null : r.bodyReason,
    interpretations, coverage,
    capabilities:capabilityOf(r, coverage),
  };
}

// Demo 只提供数据，不提供第二套界面：静态请求由 static-web 直接读生产 web/。
const headers = WEB_HEADERS;
const json = (value:unknown, status = 200) => new Response(JSON.stringify(value), {status, headers:{...headers, 'content-type':'application/json'}});

/** 与生产同口径的不透明游标：base64url(JSON 数组)。 */
const encodeCursor = (value: unknown[]) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
const decodeCursor = (raw: string | null): unknown[] | null => {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return Array.isArray(parsed) && parsed.every(Number.isSafeInteger) ? parsed : null;
  } catch { return null; }
};

Bun.serve({
  hostname:'127.0.0.1', port,
  async fetch(req) {
    const url = new URL(req.url);
    const host = req.headers.get('host');
    if (!['127.0.0.1:'+port, 'localhost:'+port].includes(host ?? '')) return json({error:'host'}, 403);
    const origin = req.headers.get('origin');
    if (origin !== null && origin !== 'http://'+host) return json({error:'origin'}, 403);
    if (req.method !== 'GET') return json({error:'method'}, 405);
    if (!url.pathname.startsWith('/api/')) {
      const staticResponse = await serveWeb(url.pathname);
      return staticResponse ?? json({error:'not_found'}, 404);
    }
    if (origin === null && req.headers.get('sec-fetch-site') !== 'same-origin') return json({error:'same_origin_required'}, 403);
    if (url.pathname === '/api/sessions') {
      const rawLimit = url.searchParams.get('limit');
      if (rawLimit !== null && !/^\d+$/.test(rawLimit)) return json({error:'invalid_limit'}, 400);
      const limit = rawLimit === null ? 50 : Math.min(100, Number(rawLimit));
      const rawCursor = url.searchParams.get('cursor');
      let bound: [number, string] | null = null;
      if (rawCursor !== null) {
        try {
          const parsed: unknown = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8'));
          if (!Array.isArray(parsed) || parsed.length !== 2
            || !Number.isFinite(parsed[0]) || typeof parsed[1] !== 'string') {
            return json({error:'invalid_cursor'}, 400);
          }
          bound = [parsed[0] as number, parsed[1]];
        } catch {
          return json({error:'invalid_cursor'}, 400);
        }
      }
      const all: SessionRow[] = POOLS.map(pool => ({
        conv_key: pool.key, title: pool.title, agents: [pool.agent],
        request_count: pool.rows.length, flags: pool.flags,
        last_ms: Math.max(...pool.rows.map(startOf)),
      })).sort((a, b) => b.last_ms - a.last_ms || (a.conv_key < b.conv_key ? 1 : -1));
      const rows = bound === null
        ? all
        : all.filter(row => row.last_ms < (bound[0] as number)
          || row.last_ms === bound[0] && row.conv_key < (bound[1] as string));
      const items = rows.slice(0, limit);
      const last = items[items.length - 1];
      return json({items, next_cursor: rows.length > limit && last !== undefined
        ? encodeCursor([last.last_ms, last.conv_key]) : null});
    }
    const list = /^\/api\/sessions\/([^/]+)\/requests$/.exec(url.pathname);
    if (list) {
      const key = decodeURIComponent(list[1]!);
      const pool = POOLS.find(entry => entry.key === key)?.rows ?? null;
      if (pool === null) return json({error:'not_found'}, 404);
      // 生产列表端点：older 无游标取最近窗口，游标向更早翻；forward 保持最早页语义。
      const direction = url.searchParams.get('direction') ?? 'forward';
      if (direction !== 'forward' && direction !== 'older') return json({error:'invalid_direction'}, 400);
      const rawLimit = url.searchParams.get('limit');
      if (rawLimit !== null && !/^\d+$/.test(rawLimit)) return json({error:'invalid_limit'}, 400);
      const limit = rawLimit === null ? 100 : Number(rawLimit);
      const cursor = decodeCursor(url.searchParams.get('cursor'));
      if (url.searchParams.get('cursor') !== null && cursor === null) return json({error:'invalid_cursor'}, 400);
      if (direction === 'older') {
        const rows = cursor === null
          ? [...pool].sort((a,b)=>b.id-a.id).slice(0, limit+1)
          : pool.filter(r=>r.id<(cursor![1] as number)).sort((a,b)=>b.id-a.id).slice(0, limit+1);
        const items = rows.slice(0, limit).reverse().map(rowOf);
        return json({items, next_cursor: rows.length>limit && items.length>0 ? encodeCursor([items[0]!.started_ms, items[0]!.req_id]) : null});
      }
      const rows = cursor === null
        ? pool.slice(0, limit+1)
        : pool.filter(r=>r.id>(cursor![1] as number)).slice(0, limit+1);
      const items = rows.slice(0, limit).map(rowOf);
      return json({items, next_cursor: rows.length>limit && items.length>0 ? encodeCursor([items[items.length-1]!.started_ms, items[items.length-1]!.req_id]) : null});
    }
    const turns = /^\/api\/sessions\/([^/]+)\/turns$/.exec(url.pathname);
    if (turns) {
      const key = decodeURIComponent(turns[1]!);
      // 与生产同形：未知会话返回空表，不报 404。
      const all = TURNS_BY_SESSION.get(key) ?? [];
      // 累计窗口下界：只返回起点在下界之后的轮；缺参数按全会话结算。
      const rawFrom = url.searchParams.get('from');
      if (rawFrom !== null && !/^\d+$/.test(rawFrom)) return json({error:'invalid_from'}, 400);
      const from = rawFrom === null ? null : Number(rawFrom);
      return json({items: from === null ? all : all.filter(t => t.start_req >= from)});
    }
    const body = /^\/api\/requests\/(\d+)\/body$/.exec(url.pathname);
    if (body) {
      const r = byId.get(Number(body[1]));
      if (!r) return json({error:'not_found'}, 404);
      const from = Number(url.searchParams.get('from') ?? '0');
      const to = Number(url.searchParams.get('to') ?? String(from + 40));
      if (!Number.isInteger(from) || !Number.isInteger(to) || from<0 || to<from || to-from>40) return json({error:'invalid_body_range'}, 400);
      const expected = url.searchParams.get('if_reading');
      if (expected !== null && !/^r1-[0-9a-f]{64}$/.test(expected)) return json({error:'invalid_reading_token'}, 400);
      if (expected !== null && expected !== readingTokenOf(r)) return json({error:'reading_changed'}, 409);
      return json({...bodyPageOf(r, from, to), req_id:r.id, reading_token:readingTokenOf(r)});
    }
    const toolResult = /^\/api\/requests\/(\d+)\/tools\/(\d+)\/result$/.exec(url.pathname);
    if (toolResult) {
      const expected = url.searchParams.get('if_reading');
      if (expected === null || !/^r1-[0-9a-f]{64}$/.test(expected)) return json({error:'invalid_reading_token'}, 400);
      const owner = byId.get(Number(toolResult[1]));
      if (owner === undefined) return json({error:'not_found'}, 404);
      if (expected !== readingTokenOf(owner)) return json({error:'reading_changed'}, 409);
      const ord = Number(toolResult[2]);
      const d = detailOf(owner);
      const pair = (d.tool_calls as SynthCall[]).find(c => c.ord === ord);
      const base = { owner_req: owner.id, call_ord: ord, reading_token: expected, raw:null };
      if (pair === undefined) return json({...base, state:'unpaired', target:null, content:null, is_error:null, reason:'call_not_found'});
      if (pair.state !== 'resolved' || pair.result_req === null) {
        return json({...base, state: pair.state === 'pending' ? 'pending' : pair.state === 'ambiguous' ? 'ambiguous' : 'unpaired', target:null, content:null, is_error:null, reason:pair.state});
      }
      const target = byId.get(pair.result_req);
      if (target === undefined) return json({...base, state:'invalid_location', target:null, content:null, is_error:null, reason:'location_mismatch'});
      const page = bodyPageOf(target, pair.result_ord ?? 0, (pair.result_ord ?? 0) + 1);
      const message = page.messages.find(m => m.ord === pair.result_ord)?.value as {content?: unknown} | undefined;
      const match = /^request\.messages\[(\d+)\](?:\.content\[(\d+)\])?$/.exec(pair.result_path ?? '');
      if (!message || !match) return json({...base, state:'unavailable', target:null, content:null, is_error:null, reason:'body_evicted'});
      const blocks = message.content;
      const block = match[2] !== undefined && Array.isArray(blocks)
        ? (blocks[Number(match[2])] as {content?: unknown, is_error?: unknown})
        : { content: typeof blocks === 'string' ? blocks : null };
      return json({...base, state:'available',
        target:{ req_id: target.id, ord: pair.result_ord, path: pair.result_path },
        content: block.content ?? null,
        is_error: (block as {is_error?: unknown}).is_error === true ? true : (block as {is_error?: unknown}).is_error === false ? false : null,
        raw: block, reason: null});
    }
    const route = /^\/api\/requests\/(\d+)\/route$/.exec(url.pathname);
    if (route) {
      const r = byId.get(Number(route[1]));
      if (!r) return json({error:'not_found'}, 404);
      return json(routeOf(r));
    }
    const detail = /^\/api\/requests\/(\d+)$/.exec(url.pathname);
    if (detail) {
      const r = byId.get(Number(detail[1]));
      if (!r) return json({error:'not_found'}, 404);
      return json(detailOf(r));
    }
    return json({error:'not_found'}, 404);
  },
});
console.log('合成阅读场景：http://127.0.0.1:'+port+'/?session='+convKey);
console.log('窗口分页场景：http://127.0.0.1:'+port+'/?session='+convWindow);
console.log('缺通道场景：  http://127.0.0.1:'+port+'/?session='+convHook);
console.log('轮次配对场景：http://127.0.0.1:'+port+'/?session='+convTurns);
