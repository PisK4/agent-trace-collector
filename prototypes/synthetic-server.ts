// Task 0 的合成阅读场景：只监听回环地址，返回与 collector GET 相同形状的
// 合成详情、正文、能力与工具关联。不连接真实库，不读取令牌，不启动 collector。
// 场景覆盖：HTTP 失败但保留输入与回复、Chat length、Anthropic max_tokens、
// 未知停止原因、resolved 未读取、pending、ambiguous、结果在窗口外（first50 截断）、
// 辅助请求、分支请求、能力五态与同名工具。
const port = 8770;
const convKey = 'conv-synthetic-reading';
const windowSize = 8;

type SynthCall = {
  call_id: string; ord: number; tool_name: string;
  result_req: number | null; result_ord: number | null; result_path: string | null; state: string;
};
type SynthMessage = { role: string; content: unknown; tool_calls?: unknown[] };
type SynthRequest = {
  id: number; title: string; status: number | null;
  protocol: 'anthropic' | 'chat';
  history: SynthMessage[];
  inputs: { message: SynthMessage; userInput: boolean }[];
  reply: unknown;
  tools: unknown;
  bodyState: 'available' | 'partial' | 'pending';
  bodyReason: string | null;
  delta: number[] | null;
  prevRelation: string; chainRole: string; purposeChain: string; reqKind: string;
  modelTitle: string | null;
  toolCalls: SynthCall[];
  usage: { in: number; out: number; read: number; write: number; cost: number };
  timing: { ms: number; ttft: number | null; flow: number | null; firstText: number | null };
};

const SYS = '你是合成场景里的编码助手，只依据已读文件回答。';
const BRIEF = '合成场景说明：排查 parse-helper 的空状态渲染问题，目录 /synth/workspace。';
const TOOL_READ = {type:'function', function:{name:'read_file', description:'读取文件。', parameters:{type:'object', properties:{path:{type:'string'}}, required:['path']}}};
const TOOL_BASH = {type:'function', function:{name:'Bash', description:'运行命令。', parameters:{type:'object', properties:{command:{type:'string'}}, required:['command']}}};
const TOOL_GREP = {type:'function', function:{name:'Grep', description:'搜索文本。', parameters:{type:'object', properties:{pattern:{type:'string'}}, required:['pattern']}}};
const TOOL_READ_ALT = {type:'function', function:{name:'read_file', description:'读取文件（同名第二定义，参数不同）。', parameters:{type:'object', properties:{path:{type:'string'}, offset:{type:'number'}}, required:['path']}}};

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
    toolCalls:[], usage:{in:300,out:12,read:0,write:0,cost:0.0002}, timing:{ms:900,ttft:null,flow:null,firstText:null} },

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
    toolCalls:[], usage:{in:5100,out:96,read:7000,write:500,cost:0.0064}, timing:{ms:12800,ttft:640,flow:null,firstText:700} },

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
    toolCalls:[], usage:{in:8200,out:780,read:9600,write:600,cost:0.0156}, timing:{ms:4810,ttft:512,flow:4298,firstText:604} },

  { id:118, title:'查文档建议（未声明工具）', status:200, protocol:'anthropic',
    history:[A('检查通过，只差文案确认。'), U('查下官方建议。')],
    inputs:[{message:U('查一下官方文档对空状态文案的建议。'),userInput:true},{message:U('回来再定稿。'),userInput:true}],
    reply:{model:'synth-a', stop_reason:'tool_use', content:[
      {type:'text', text:'我先查文档建议，回来再定稿；这一轮还没有结论。'},
      {type:'tool_use', id:'call_ws_1', name:'WebSearch', input:{query:'empty state copy guideline'}}]},
    tools:[TOOL_READ, TOOL_BASH, TOOL_GREP], bodyState:'available', bodyReason:null,
    delta:[4,5], prevRelation:'confirmed', chainRole:'main', purposeChain:'participate', reqKind:'chat', modelTitle:null,
    toolCalls:[{call_id:'call_ws_1', ord:0, tool_name:'WebSearch', result_req:null, result_ord:null, result_path:null, state:'unpaired'}],
    usage:{in:8400,out:160,read:9800,write:600,cost:0.0061}, timing:{ms:1900,ttft:430,flow:1400,firstText:500} },
];

// Task 6 验收用的窗口会话：42 笔简单请求，默认 30 笔窗口留下两页更早历史。
const convWindow = 'conv-synthetic-window';
const WINDOW_REQUESTS: SynthRequest[] = Array.from({length: 42}, (_, i) => ({
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

const byId = new Map([...REQUESTS, ...WINDOW_REQUESTS].map(r => [r.id, r]));

function fullMessages(r: SynthRequest): SynthMessage[] {
  return [{role:'system', content:SYS}, {role:'user', content:BRIEF}, ...r.history, ...r.inputs.map(i => i.message)];
}

/** 列表行：与生产 RequestRow 同形，状态语义来自派生结果。 */
function rowOf(r: SynthRequest) {
  return {
    req_id: r.id, conv_key: r.id >= 500 ? convWindow : convKey, actor: 'actor-main', actor_state: 'known',
    agent: 'synthetic-agent', started_ms: r.id * 1000, title: r.title, title_source: 'user_delta',
    status: r.status, model_requested: 'synth-group', model_served: r.protocol === 'chat' ? 'synth-c' : 'synth-a',
    in_tok: r.usage.in, out_tok: r.usage.out, cache_read: r.usage.read, cache_write: r.usage.write,
    cost: r.usage.cost, cost_state: 'reported', have: 7,
    ms: r.timing.ms, ttft_ms: r.timing.ttft, flow_ms: r.timing.flow,
    body_state: r.bodyState, miss_reason: r.bodyReason,
    input_preview: r.title, input_preview_kind: 'delta', reply_preview: null,
    req_kind: r.reqKind, chain_role: r.chainRole, model_title: r.modelTitle,
    purpose_status: 'selected', purpose_version: 1, purpose_rule: null, purpose_chain: r.purposeChain,
    derived_state: 'current',
  };
}

function detailOf(r: SynthRequest) {
  const ms = fullMessages(r);
  // 阅读版本：合成稳定值（同一请求输入不变则不变）。
  const readingToken = 'r1-' + Buffer.from(`synth-${r.id}-${r.input_revision ?? 0}-${r.bodyState}`).toString('hex').padEnd(64, '0').slice(0, 64);
  return {
    req_id:r.id, conv_key:convKey, actor:'actor-main', actor_state:'known', agent:'synthetic-agent',
    started_ms:r.id*1000, title:r.title, title_source:'user_delta', status:r.status,
    model_requested:'synth-group', model_served:r.protocol === 'chat' ? 'synth-c' : 'synth-a',
    in_tok:r.usage.in, out_tok:r.usage.out, cache_read:r.usage.read, cache_write:r.usage.write,
    cost:r.usage.cost, cost_state:'reported', have:7,
    ms:r.timing.ms, ttft_ms:r.timing.ttft, flow_ms:r.timing.flow,
    body_state:r.bodyState, miss_reason:r.bodyState === 'available' ? null : r.bodyReason,
    input_preview:r.title, input_preview_kind:'delta', reply_preview:null,
    req_kind:r.reqKind, chain_role:r.chainRole, model_title:r.modelTitle,
    purpose_status:'selected', purpose_version:1, purpose_rule:null, purpose_chain:r.purposeChain,
    derived_state:'current',
    prev_req_id:r.id > 101 ? r.id-1 : null, prev_relation:r.prevRelation, delta_ordinals:r.delta,
    parse_state:'parsed', reply_state:r.reply === null ? 'absent' : 'parsed',
    first_text_ms:r.timing.firstText, reasoning:null,
    prompt_tokens:null, prompt_counted:null, prompt_window:null, prompt_turns:null, parts:null,
    attempt_count:1, attempt_billed:null, attempt_in:null, attempt_out:null,
    attempt_cache_read:null, attempt_cache_write:null, attempt_reasoning:null,
    attempt_cost:null, attempt_cost_state:'absent',
    summary_state:'recomputed', summary_algorithm:1, summary_basis:'{}',
    derive_version:1, archive:null, route_state:'available', model_provider:'relay-synth',
    source_facts:{}, projection_meta:{}, prompt:{state:'missing', reason:'legacy_unknown', tokens:null, counted:false, window:null, parts:[], ratio:null, note:null},
    derivation:{state:'clean', chain_state:'current', summary_state:'current', reason:null},
    tool_calls:r.toolCalls, historical:null, reading_token: readingToken,
    total_messages:ms.length,
  };
}

function capabilityOf(r: SynthRequest, coverage: {complete:boolean; reason:string; from:number; to:number; total:number|null}) {
  if (r.bodyState !== 'available' && r.bodyState !== 'partial') {
    return {tools:{state:'missing', items:[], reason:'body_unavailable'}, skills:{state:'missing', items:[], reason:'body_unavailable'}, coverage, agent:'synthetic-agent'};
  }
  if (r.bodyState === 'partial') {
    return {tools:{state:'partial', items:[], reason:'body_partial'}, skills:{state:'partial', items:[], reason:'body_partial'}, coverage, agent:'synthetic-agent'};
  }
  const tools = r.tools;
  let toolResult;
  if (tools === undefined) toolResult = {state:'empty', items:[], reason:null};
  else if (!Array.isArray(tools)) toolResult = {state:'unrecognized', items:[], reason:'tools_not_array'};
  else toolResult = {state:'present', items:tools.map((t:any) => ({name:t.function.name, description:t.function.description, schema:t.function.parameters, source:'tools'})), reason:null};
  return {tools:toolResult, skills:{state:'present', items:[], reason:null}, coverage, agent:'synthetic-agent'};
}

function bodyPageOf(r: SynthRequest, from: number, to: number) {
  const ms = fullMessages(r);
  const readable = r.bodyState === 'available' || r.bodyState === 'partial';
  const total = readable ? ms.length : null;
  const sliced = readable && from < to
    ? ms.slice(from, Math.min(to, ms.length)).map((message, i) => ({ord:from+i, value:message}))
    : [];
  const interpretations = ms.map((message, index) => {
    if (message.role !== 'user') return null;
    const input = r.inputs.find(i => i.message === message);
    if (input === undefined || !input.userInput) return {ord:index, role:'user', role_state:'known', input:null, is_input:false};
    const text = typeof message.content === 'string' ? message.content : '';
    return {ord:index, role:'user', role_state:'known',
      input:{state:'text', kind:'direct', text, original:text, removed:[], agent:'synthetic-agent', rule:'generic'},
      is_input:true};
  }).filter(Boolean);
  const coverage = {from, to, total, complete:r.bodyState === 'available',
    loaded_complete:readable && total !== null && to >= total,
    reason:r.bodyState === 'available' ? 'available' : r.bodyState === 'partial' ? 'body_partial' : 'body_unavailable'};
  return {
    state:r.bodyState, parse_state:'parsed', reply_state:r.reply === null ? 'absent' : 'parsed',
    from, to, total, messages:sliced,
    request_fields:from === 0 ? {model:r.protocol === 'chat' ? 'synth-group' : 'synth-a', stream:true, ...(r.tools === undefined ? {} : {tools:r.tools})} : null,
    reply:from === 0 ? r.reply : null,
    reason:r.bodyState === 'available' ? null : r.bodyReason,
    interpretations, coverage,
    capabilities:capabilityOf(r, {complete:coverage.complete, reason:coverage.reason, from, to, total}),
  };
}

const files: Record<string, [URL, string]> = {
  '/': [new URL('./trace-reader-prototype.html', import.meta.url), 'text/html; charset=utf-8'],
  '/trace-reader-prototype.html': [new URL('./trace-reader-prototype.html', import.meta.url), 'text/html; charset=utf-8'],
  '/local-data.js': [new URL('./local-data.js', import.meta.url), 'text/javascript; charset=utf-8'],
  '/web/body-view.js': [new URL('../web/body-view.js', import.meta.url), 'text/javascript; charset=utf-8'],
  // 生产页面走 /production 前缀，同一合成 API。
  '/production': [new URL('../web/index.html', import.meta.url), 'text/html; charset=utf-8'],
  '/app.js': [new URL('../web/app.js', import.meta.url), 'text/javascript; charset=utf-8'],
  '/reader-store.js': [new URL('../web/reader-store.js', import.meta.url), 'text/javascript; charset=utf-8'],
  '/trace-view.js': [new URL('../web/trace-view.js', import.meta.url), 'text/javascript; charset=utf-8'],
  '/body-view.js': [new URL('../web/body-view.js', import.meta.url), 'text/javascript; charset=utf-8'],
};
const headers = { 'cache-control':'no-store', 'x-content-type-options':'nosniff', 'content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
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
      const file = files[url.pathname];
      if (!file) return json({error:'not_found'}, 404);
      if (url.pathname === '/production') {
        // 临时错误采集：合成验收用，失败栈写进 window.__pageErrors。
        const html = await Bun.file(file[0]).text();
        const instrumented = html.replace('<head>', `<head><script>window.__pageErrors=[];window.addEventListener('error',e=>window.__pageErrors.push(String(e.message)+' @ '+(e.filename||'')+':'+e.lineno));window.addEventListener('unhandledrejection',e=>window.__pageErrors.push('rejection: '+String(e.reason && e.reason.stack || e.reason)));</script>`);
        return new Response(instrumented, {headers:{...headers, 'content-type':file[1]}});
      }
      return new Response(Bun.file(file[0]), {headers:{...headers, 'content-type':file[1]}});
    }
    if (origin === null && req.headers.get('sec-fetch-site') !== 'same-origin') return json({error:'same_origin_required'}, 403);
    if (url.pathname === '/api/sessions') {
      return json({items:[
        {conv_key:convKey, title:'空状态排查（合成场景）', agents:['synthetic-agent'], request_count:REQUESTS.length, flags:[], last_ms:118000},
        {conv_key:convWindow, title:'窗口分页样本（合成）', agents:['synthetic-agent'], request_count:WINDOW_REQUESTS.length, flags:[], last_ms:(500+41)*1000},
      ], next_cursor:null});
    }
    if (url.pathname === '/api/local-session') {
      const prefix = url.searchParams.get('prefix') || '';
      if (!convKey.includes(prefix)) return json({error:'session_not_found'}, 400);
      return json({key:convKey, session:convKey, title:'空状态排查（合成场景）', agent:'synthetic-agent', requests:[], total:REQUESTS.length});
    }
    if (url.pathname === '/api/local-window') {
      const session = url.searchParams.get('session');
      const pool = session === convWindow ? WINDOW_REQUESTS : session === convKey ? REQUESTS : null;
      if (pool === null) return json({error:'session_required'}, 400);
      let before:number[] | null = null;
      try { before = JSON.parse(url.searchParams.get('before') ?? 'null'); } catch { return json({error:'cursor'}, 400); }
      const rows = before === null
        ? [...pool].sort((a,b)=>b.id-a.id).slice(0, windowSize+1)
        : pool.filter(r=>r.id<before[1]).sort((a,b)=>b.id-a.id).slice(0, windowSize+1);
      const selected = rows.slice(0, windowSize).reverse();
      return json({items:selected.map(r=>({req_id:r.id, started_ms:r.id*1000})), more:rows.length>windowSize});
    }
    const list = /^\/api\/sessions\/([^/]+)\/requests$/.exec(url.pathname);
    if (list) {
      const pool = decodeURIComponent(list[1]!) === convWindow ? WINDOW_REQUESTS
        : decodeURIComponent(list[1]!) === convKey ? REQUESTS : null;
      if (pool === null) return json({error:'not_found'}, 404);
      // 生产列表端点：older 无游标取最近窗口，游标向更早翻；forward 保持最早页语义。
      const direction = url.searchParams.get('direction') ?? 'forward';
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? '100')));
      if (direction !== 'forward' && direction !== 'older') return json({error:'invalid_direction'}, 400);
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
    const body = /^\/api\/requests\/(\d+)\/body$/.exec(url.pathname);
    if (body) {
      const r = byId.get(Number(body[1]));
      if (!r) return json({error:'not_found'}, 404);
      const from = Number(url.searchParams.get('from') ?? '0');
      const to = Number(url.searchParams.get('to') ?? String(from));
      if (!Number.isInteger(from) || !Number.isInteger(to) || from<0 || to<from || to-from>40) return json({error:'invalid_body_range'}, 400);
      return json(bodyPageOf(r, from, to));
    }
    const toolResult = /^\/api\/requests\/(\d+)\/tools\/(\d+)\/result$/.exec(url.pathname);
    if (toolResult) {
      const owner = byId.get(Number(toolResult[1]));
      const ord = Number(toolResult[2]);
      const expected = url.searchParams.get('if_reading');
      if (owner === undefined) return json({error:'not_found'}, 404);
      if (expected === null || !/^r1-[0-9a-f]{16,}$/.test(expected)) return json({error:'invalid_reading_token'}, 400);
      const d = detailOf(owner);
      const pair = (d.tool_calls as SynthCall[]).find(c => c.ord === ord);
      const base = { owner_req: owner.id, call_ord: ord, reading_token: expected };
      if (pair === undefined) return json({...base, state:'unpaired', target:null, content:null, is_error:null, reason:'call_not_found'});
      if (pair.state !== 'resolved' || pair.result_req === null) {
        return json({...base, state: pair.state === 'pending' ? 'pending' : pair.state === 'ambiguous' ? 'ambiguous' : 'unpaired', target:null, content:null, is_error:null, reason:pair.state});
      }
      const target = byId.get(pair.result_req);
      if (target === undefined) return json({...base, state:'invalid_location', target:null, content:null, is_error:null, reason:'location_mismatch'});
      const page = bodyPageOf(target, pair.result_ord, pair.result_ord + 1);
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
        reason: null});
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
console.log('合成阅读场景：http://127.0.0.1:'+port+'/?data=local&session='+convKey);
console.log('first50 截断模式：http://127.0.0.1:'+port+'/?data=local&session='+convKey+'&sample=first50');
