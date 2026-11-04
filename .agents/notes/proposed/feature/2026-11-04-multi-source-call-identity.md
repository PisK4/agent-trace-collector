# Agent Note: 多来源同一调用的身份归一与去重

Status: proposed

本文承接[droid 会话摄入](../../implemented/feature/2026-11-04-droid-session-ingestion.md)留下的统一 owner 查找，以及[magpie 对标](../architecture/2026-10-22-magpie-parity-and-field-fidelity.md)里一直未做的 direct 行入口。它部分取代[zcode 的 Agent 支持](2026-10-24-zcode-agent-support.md)中「不直接摄入本地 zcode 库」的否决结论：那条结论成立的前提是 direct 行先走，现在这个前提反过来——本地库先走，direct 只作兜底。旧提案的其余规则不受影响，仍保持活跃。

本地会话从哪里发现、按什么增量读取、第一版接哪几家，写在[本地 Agent 会话适配器第一版](2026-11-04-agent-session-adapters.md)。本文只定义适配器交出的字段与认领顺序。

2026-11-04 对生产库、本机 zcode 库与 magpie API 做过只读核对。数字是当天快照，随使用增长。

## Problem

### 同一笔调用现在可以有三份记录

ATC 已有的来源是 magpie 网关账本、路由、hook 与 OTLP span；droid 接入后多了本地转录；zcode 的真实调用还可能同时出现在本机 `~/.zcode/cli/db/db.sqlite` 与 magpie 的 direct 行里。三条路各自都能看见同一笔调用：

| 来源 | 调用单位 | 身份材料 | 运行位置 |
| --- | --- | --- | --- |
| magpie 网关账本 | 一次网关请求 | `rid`、`response_id`、`started`、token | 账本文件 |
| magpie direct 行 | 一条 assistant 消息 | 根会话 + 完成时间 + token | API 内存生成 |
| 本地 zcode | 一条 assistant 消息或一行 `model_usage` | 子会话、`started_at`、token、`assistant_message_id` | `db.sqlite` |
| OTLP | 一个 span | `thread.id`/`turn.id` 或会话 id | span 接收端 |
| droid 转录 | 一条 assistant 消息 | 会话 id + `openaiMessageId` | 转录文件 |

用户的要求是同一笔调用只留一行、同一段对话只展示一份。现有 owner 查找做不到，因为它假设三个来源共享同一套会话 id、时间语义与模型名。

### 实测：三套 id、两套时间、两套 token

**会话 id 至少有四种拼法。** zcode 主会话在 ATC 网关行里有裸 UUID（36 位、231 行）与 `session_` 前缀两种；`session_` 后又分 32 位十六进制（40 位、90 行）与 UUID（44 位、468 行），本地库里主会话则是 `sess_<uuid>`（41 位）。子代理另有 `sess_subagent_agent_…`。按字符串相等分组，同一段对话会被拆成两三个会话。

**起点时间不一致。** 网关账本的 `t` 是请求开始时间，比本地 `model_usage.started_at` 早 11–189 毫秒（637 笔匹配的中位数 -54 毫秒，另有 1 笔 -5.4 秒的离群）。direct 行的 `t` 是**完成时间**，开始时间要按 `t - ms` 反推；反推结果与本地 `started_at` 在 585 笔上逐毫秒相等。OTLP 的 `start_ms` 是 span 开始。现有 owner 把入参统一当开始时间，direct 行接进来会整体错位。

**模型名不能等值比较。** 同一笔调用在网关账本里是 `group/auto-deepseek-v4-1-flash` 与 `sn-deepseek-v4-1-flash-1017`，在本地是 `auto/deepseek-v4.1-flash`，在 direct 行里是 `GLM-5.3-Flash`。owner 的第三条线索要求 `model_requested` 或 `model_served` 相等，跨来源几乎必然落空。

**token 语义差一层缓存。** 本地与 AI SDK 的 `input` 含缓存读；magpie 账本与 direct 的 `in` 不含。本地 `input_tokens - cache_read_input_tokens - cache_creation_input_tokens` 与网关 `in` 精确相等，例如 `30,835 - 26,496 = 4,339`。不先归一，指纹对不上。

**direct 行会把子代理折叠到根会话。** magpie 的 `ocRoots` 把每个子会话的 key 改成根会话（[opencode.go:158](https://github.com/yetone/magpie/blob/3173440ca3be3eb0a855870d92faeadea6785aaa/internal/sessions/opencode.go#L158-L168)），`readZCodeCalls` 再用这个 key 当 `Session`。本机今天 642 笔 direct 行里有 57 笔挂在一个根会话下，按 token 与开始时间逐笔都能在 `sess_subagent_agent_…` 子会话里找到对应消息。只按会话 id 匹配会漏掉它们。

### 实测：重叠有多少

对生产库与本地库做只读比对（同一会话、归一后 token 四元组相等、开始时间差 ≤2 秒、候选唯一）：

| 对比 | 总数 | 唯一命中 | 多候选 | 未命中 |
| --- | --- | --- | --- | --- |
| ATC 网关 zcode 行 ↔ 本地 `provider_id='magpie'` 行 | 756 在本地会话内 | 637 | 0 | 119 |
| 本地 `provider_id='magpie'` 行 ↔ ATC 网关行 | 668 | 637 | 0 | 31（24 completed、7 error 且 token 为 0） |
| magpie direct 今日行 ↔ 本地消息 | 642 | 585 | 0 | 57（全部是子会话折叠到根会话） |

两个方向的未命中不是匹配失败，而是真实覆盖差：ATC 有 119 笔本地 `model_usage` 没记的网关调用，本地有 31 笔 ATC 没记的 magpie 路由调用，direct 的 57 笔在本地子会话里。把「未命中」强行配成一对会制造假合并；留着又会出现两个来源各有一行。取舍见下文。

### 现有规则的具体缺口

`findRequestOwnerTx` 的三条线索是 `response_id_norm` → `turn_ref` → 同 `conv_key`、同 agent、±60 秒、模型相等（[owner.ts:100](../../../../src/owner.ts#L100)）。它对 droid 与迟到账本够用，对上面三类来源不够：

- 第 3 条要求 `conv_key` 相等，而会话 id 拼法不同会直接落空；
- ±60 秒在聊天密集时会话里会同时命中多笔，最终只能是 `match_ambiguous`；
- 模型名跨来源不等值，线索直接被跳过；
- 没有 token 指纹，时间成了唯一可用的相似度。

OTLP 的认领还走另一套 `magpieTurnRequestTx`（[ingest.ts:64](../../../../src/sources/otlp/ingest.ts#L64)）：`LIMIT 1`，不排除 `via='rejected'`，也不做唯一性判断。它可能与 owner 的结论相反，也可能把 span 证据挂到一笔被上游拒绝的请求上。

### 目标

一笔调用一条 `request` 行；一份对话一个根会话；来源只补充证据与字段，不重复计算用量；无法确定的匹配保持可见，不静默合并。实现范围先覆盖 zcode、Claude Code、Codex、OMP/Pi 与 droid 的本地会话，加上 magpie 与 OTLP；其余本地 Agent 先检测，后接适配器。

## Proposal

### 1. 身份材料在适配层归一

每个来源适配器在写库前产出一组固定字段，owner 只看这组字段，不再直接读来源原文：

| 字段 | 含义 |
| --- | --- |
| `sessionRaw` | 来源原样会话 id，用于证据与排查 |
| `sessionCanonical` | 去掉已知前缀后的会话 id |
| `conversationRoot` | 沿 `parent_id` 上溯到的根会话 |
| `startedMs` / `endedMs` | 统一为开始/结束的绝对时间 |
| `timeBasis` | `start`、`end+duration`、`message-time` 或 `unknown` |
| `usage` | 归一后的 `(input_excl_cache, output, cache_read, cache_write)`，缺失为 null |
| `responseIdNorm` | 归一后的响应 id |
| `turnRef` | Codex 的 thread turn 身份 |
| `nativeCallId` | 来源内可复用的调用 id（消息 id、span id 等） |

归一放在适配层，因为每种来源的时间与 token 语义是来源自己的事实，不该让 owner 猜。新增来源时只补这张表，不改认领顺序。

### 2. 会话身份：前缀归一，根会话作为对话单位

zcode 的归一规则：去掉 `sess_` 与 `session_` 前缀，保留 `subagent` 段；`session_` 后跟 32 位十六进制与 UUID 都归到同一后缀。前缀表按 agent 维护，不做全局去前缀——不同 agent 的 id 命名空间不该互相污染。

`conversationRoot` 沿 `session.parent_id` 上溯，最多 64 层，防环。对 zcode，根会话作为 `conv_key` 的会话部分，子会话的 `session` 保留自身 id，`subagent`/`parent_agent` 记录谱系。这样 magpie direct 行（根会话）与本地子会话调用落在同一段对话里，会话列表不会出现父子两份。droid 已有子代理行是否并入根会话另定，本提案不改它的现有行为。

不建 `session_alias` 表。已知前缀能覆盖当前四种拼法；出现无法归一的第五种形式时再加表，表里每行都要带来源证据。短期用一条注释记下这个上限。

### 3. 时间统一到开始时间

- 网关账本：`t` 即开始时间，直接用。
- direct 行：`started = t - ms`；`ms` 缺失时 `timeBasis='unknown'`，不参与时间窗匹配。
- 本地 zcode：`model_usage.started_at`；没有 `model_usage` 的会话用消息的 `time.created`，两者在同一调用上相等。
- OTLP：span 的 `start_ms`。
- droid：沿用现有近似值，标 `message-time`。

`endedMs` 用于时间窗右边界。只有结束时间且没有时长的来源，不反推开始时间。

### 4. 用量指纹：缓存外置后再比

指纹是 `(input - cache_read - cache_write, output, cache_read, cache_write)`。四件套必须全部非空才可用于匹配；来源只提供部分字段时，只比双方都有的字段，并降级为弱指纹，弱指纹只在候选唯一时合并。

量本身不是身份。它是「同一会话、同一时间附近、同一组计数」的复合证据。相同上下文重复调用会得到相同的 token 计数，所以必须同时要求时间窗与候选唯一；任一不满足就不合并。

### 5. 认领顺序

写入前依次尝试，命中即停；每一步都要求候选唯一、排除 `via='rejected'`、排除同来源证据：

1. `response_id_norm` 精确命中；
2. `turn_ref` 精确命中（带 agent 约束）；
3. `(agent, conversationRoot, nativeCallId)` 精确命中，仅限双方共享同一调用 id 的来源对；
4. 同 `conversationRoot`、同 agent、开始时间差 ≤2 秒、归一后 token 四元组完全相等、候选唯一；
5. 同 `conversationRoot`、同 agent、开始时间差 ≤60 秒、模型归一后相等或一方缺失、候选唯一。

第 5 步保留现有窗口，但把模型相等降为「可证才比」：两边都有归一后的模型才比较，不能因为模型名不同就跳过；模型名不同也不再是拒绝理由，只作为歧义时的排序依据。第 4 步是新增的主力，实测覆盖 637/637 与 585/585，且 0 多候选。

多候选返回 `match_ambiguous`，零候选返回 `match_absent`，两者都不合并。规则名沿用 `MATCH_BY_*` 常量，新增 `usage_fingerprint.v1` 与 `session_call_id.v1`。

### 6. 来源取舍：本地是主，magpie 是证据与兜底

对 zcode：

- **本地消息是调用记录的基准**。它带逐条正文、子会话谱系、`assistant_message_id`、`trace_id`/`span_id`，覆盖 342 个会话、13,467 条 assistant 消息；其中 227 个会话没有 `model_usage`，但消息自带 `time.created`/`time.completed` 与 tokens，适配器要以消息为调用单位，`model_usage` 用来补 attempt、provider 与状态。
- **magpie 网关行合并为证据**，补充 `route_id`、`response_id`、`provider`、`served`、`status`、`cost` 与路由决策。用量字段以网关为准（它是实际计费读数），本地只补网关缺的字段，两者不相加。
- **magpie direct 行不直接入库**，除非本地没有对应会话。direct 行是本地消息里非网关那部分的投影（[calls_zcode.go:11](https://github.com/yetone/magpie/blob/3173440ca3be3eb0a855870d92faeadea6785aaa/internal/sessions/calls_zcode.go#L11-L21)），同时摄入必然双份。兜底场景是另一台机器的会话、本地库已删除的会话，或本地库不可读；这时 direct 行按正常来源建行，标 `via='direct'`，等本地数据到达后再按第 4 步合并。
- 其他 agent 的 direct 行同理：本地文件可读时以本地为准，direct 只补本地缺失的会话。

这条规则把「多源」压成一条主链：本地负责调用是否存在与正文，magpie 负责路由与计费事实，OTLP 负责 span 证据。三者都进 `request_evidence`，但只有一行 `request`。

### 7. OTLP

- Codex 先走 `turn_ref`；当前 span 已经带 `thread.id` 与 `turn.id`，映射版本 4 能取到。生产里那条 `turn_ref=NULL` 的旧行是映射版本 3 写入的，需要一次显式的 OTLP 重放/回填，不能靠新流量自愈。
- 没有 `turn_ref` 时走第 4、5 步；span 带 token 时用指纹，不带时只用会话 + 时间 + 模型。Claude Code 与 OMP 的 span 只有会话、没有 turn，按这条路径处理。
- 删除 `magpieTurnRequestTx` 的独立实现，统一调用 `findRequestOwnerTx`；它当前不排除 `rejected`、`LIMIT 1` 不看唯一性，这两处必须随迁移一起修。
- OTLP span 的 `trace_id`/`span_id` 只作为来源内身份，不假设与其他来源共享；除非将来某来源真的输出同一组 id。

### 8. 歧义与展示

- 会话列表按 `conversationRoot` 分组，一份根会话一行；子会话在详情里按谱系展开，不另起一段对话。
- `match_ambiguous` 的候选不合并，两条记录都保留，issue 列表给出时间、会话、token 与候选 `req_id`。界面不显示「疑似重复」这种二级标签；异常本身走既有 issue 入口。
- 合并后的行在详情页列出证据来源；缺的字段留空，不用另一来源的低置信值顶替。
- 会话累计用量不从多来源相加；以计费来源（网关）优先，缺失时才用本地读数，并在来源处标明。

### 9. 落地顺序

1. 先写归一与指纹的纯函数与测试（会话前缀、时间基准、token 四元组），不动写库路径。
2. 扩展 `findRequestOwnerTx` 加第 4 步与第 5 步的模型降级；补 `match_ambiguous` 的 issue 记录。
3. 把 OTLP 的认领切到统一 owner，修 `rejected` 与唯一性两处。
4. 接本地 zcode 适配器：以消息为调用单位，`model_usage` 补精确时间；先只读试跑，核对 637 笔网关重叠与 585 笔 direct 重叠。Claude Code、Codex、OMP/Pi 的适配器与 zcode 共用采集缝，实现顺序见[本地 Agent 会话适配器第一版](2026-11-04-agent-session-adapters.md)；zcode 仍是验证多来源规则的第一个本地来源。
5. 最后决定 direct 行入口。若做，只做兜底路径；本地可读的会话不摄入。

第 4 步之前不接 direct；否则先制造双份，再写去重，验收会被自己的数据污染。

### 10. 泛化到其他本地 Agent

这套规则不依赖 zcode。适配层输出同一组字段，认领顺序不变；变的只有每个 Agent 的会话拼法、时间基准与最强身份线索。

| 维度 | Zcode | Claude Code | Codex | OMP / Pi |
| --- | --- | --- | --- | --- |
| 本地调用记录 | `message` + `model_usage` | `**/*.jsonl` 的 assistant 行 | rollout JSONL | `*.jsonl` 的 assistant 行 + `usage`/`model_usage` 记录 |
| 本地最强 id | 消息 id、`logical_request_id`；无 response id | `message.id`（`msg_…`），归一后与网关 `response_id` 相等 | `response_id`（`resp_…`） | 消息 id；`responseId` 存在时可用；无 turn |
| direct 行 | 无 response id | 抽样无 response id | 有 `response_id` | magpie 以 `<agent>:<id>:<timestamp>` 作调用 key，没有 response id |
| 网关账本 | `rid`、`response_id` | `rid`、`response_id` | `rid`、`response_id` | `rid`、`response_id` |
| OTLP | 当前无 zcode span | 只有会话（`gen_ai.conversation.id`/`session.id`），无 turn | `thread.id` + `turn.id` | 只有会话，无 turn |
| 本地时间基准 | `time.created` / `started_at`，就是开始 | assistant 行时间是结束，用同一回合上一条消息的时间或时长推开始 | 用量记录时间是回合末，用 duration 推开始 | 消息时间是结束，用 `durationMs`/`duration` 或上一条消息推开始 |
| token 归一 | `input` 含缓存，减 cache read/write | `input` 已不含缓存 | `input` 含缓存，减 cached | `input` 不含缓存；output 含 reasoning |
| 子代理 | `session.parent_id` 链；direct 折到根 | `subagents/agent-*.jsonl` + meta | 独立 thread，`parent_thread_id` | 会话文件旁的 artifacts 目录，按父会话计 |

本机核对过一处 Claude Code 的精确线索：本地 `message.id` 为 `msg_20261104…`，去掉 `msg_` 后与 ATC 一条 `via='through'` 行的 `response_id_norm` 相等。Codex 的 `response_id` 在本地、direct 与网关三处都有。两者比 zcode 多一条精确线索，但都覆盖不了 direct 与 OTLP 的全部路径，指纹与统一 owner 仍然要做。OMP/Pi 的本地消息带完整四段 token 与 `durationMs`/`duration`，能和 direct 行做指纹；`responseId` 是否稳定出现要按真实样本核对，不能先当精确线索用。

第一版按五套适配器（六家 Agent）落地：Claude Code、Codex、Zcode、OMP/Pi 与已有的 droid。采集层的发现、增量读取、预算与验收见[本地 Agent 会话适配器第一版](2026-11-04-agent-session-adapters.md)。Magpie 本地会话列表里的其余 Agent 先做安装检测，不建请求行。

## Alternatives considered

**只靠 `response_id`。** direct 行与本地 zcode 都没有响应 id；OTLP 也没有。抽样一个月 2,500 笔 direct 行全部无 response id，单靠它覆盖不了主路径。

**把时间窗从 ±60 秒收紧到 ±2 秒，不做指纹。** 紧窗减少歧义，但聊天密集时仍可能两笔同模型调用落在 2 秒内；实测 ±60 秒出现过 2 个多候选。没有 token 指纹时，紧窗只是把猜测变窄。

**只用本地，完全不接 magpie。** 丢掉路由、状态码、计费与 119 笔本地没记的网关调用；也丢掉 direct 兜底。反过来只用 magpie 会丢掉 5,789 笔直连调用、227 个只有消息的会话与子代理谱系。

**同时摄入 direct 与本地，再在写入时合并。** 合并规则可靠时结果相同，但每次 direct 先到都会先建一行、再被本地认领，中间态会出现在页面与派生里；本地不可读时又必须保留 direct。与其先造双份再去，不如在入口处只选一个主来源。

**建 `session_alias` 表。** 当前四种拼法用前缀规则就能归一到 0 个多候选；先不加表。出现第五种拼法或跨机器会话时再加，表行必须带来源证据。

**用会话内序列对齐（LCS/DP）兜底。** 实测在 ±2 秒 + 指纹下多候选为 0，序列对齐目前没有要解决的问题；等真实出现同会话、同 token、2 秒内两笔且无法用 id 区分时再做。

**在展示层合并重复行。** 派生、计数、费用已经按 `request` 行算过，展示层再折一次会让列表数字与详情不一致，也会掩盖真实的多来源状态。

## Acceptance criteria

合成数据，覆盖双方向到达：

1. 本地 zcode ↔ 网关账本：网关先到、本地后到两种顺序都只留一行；`request_evidence` 有两种来源；`in_tok`/`out_tok` 等于网关读数，不相加；`route_id`、`response_id` 保留。
2. 本地 zcode ↔ direct 行：direct 的 `started = t - ms`；裸 UUID、`sess_`、`session_`+32 位十六进制、`session_`+UUID 四种拼法归一到同一 `conversationRoot`；子会话调用合并到根会话行，不另起对话。
3. 同会话、同 token、同模型、相隔 2 秒内的两笔本地调用：不得互认，必须是两行。
4. 同会话、同 token、相隔 2 秒内的两笔不同来源调用：唯一候选才合并；构造两个候选时返回 `match_ambiguous`，两行都保留。
5. `via='rejected'` 的行不被任何线索认领；OTLP 的独立路径同样排除它。
6. OTLP Codex span 带 `turn.id` 时按 `turn_ref` 合并；不带时走指纹；两个候选时不合并且留 issue。
7. 本地可读的 zcode 会话不摄入 direct 行；本地不可读时 direct 行正常建行并标 `via='direct'`。
8. zcode 会话列表按根会话分组：父子会话只出现一份；子会话详情保留 `parent_agent`。droid 的现有分组不变。

本机只读回归（不入测试、不进提交）：

| 项 | 现状（2026-11-04） | 期望 |
| --- | --- | --- |
| 网关 zcode ↔ 本地 `provider_id='magpie'` | 637 唯一命中、0 多候选、119 未命中 | 637 合并，119 独立保留 |
| direct 今日行 ↔ 本地消息 | 585 唯一命中、57 子会话折叠 | 585 + 57 合并，0 多候选 |
| ATC zcode 会话数 | 14 个根会话（无子会话行） | 接入本地后按根会话分组，子会话不新增对话 |
| OTLP 旧行 | `turn_ref=NULL`，span 实际带 `turn.id` | 显式回填后 `turn_ref` 非空，或 issue 说明未回填 |
| 用量 | 网关与本地两套读数 | 每行一套，来源标注清楚，无相加 |

## Risks

- **时间基准写错会把两笔并成一笔。** direct 的 `t` 是结束时间，网关的 `t` 是开始时间；适配层必须逐来源测试，不靠 owner 猜。
- **指纹会撞。** 相同上下文重复调用会得到相同计数；只靠 ±2 秒与候选唯一兜底，两候选时不合并且暴露 issue。若真实流量里多候选比例上升，再引入序列对齐。
- **zcode 根会话归一会改变现有会话计数。** 子会话从独立对话并入根会话后，会话数下降；这是为了让 magpie 与本地看到同一段对话，但历史页面与统计会变，需要一次显式重建与说明。droid 不在这次改动范围内。
- **本地优先会让网关先到的行短暂多一份。** 本地适配器到达前的窗口内，网关行已经存在；本地到达后按第 4 步合并。合并窗口内的列表可能短暂显示两份，这是可接受的过渡态，但不能让中间态进入派生结果的长期缓存。
- **227 个只有消息、没有 `model_usage` 的会话缺少 attempt、provider 与状态。** 起止时间与 tokens 在消息里都有，指纹仍可用；缺的是重试与供应商字段，不能从消息猜。
- **OTLP 旧行回填需要重放。** 只改映射版本不会改已落库行；回填必须显式执行并记录范围，不能把未回填的行描述成已修复。
- **magpie 的 direct 行语义可能随版本变化。** 适配器要锁字段与基准提交；上游改动时先核对 `t`、`ms`、`in` 与 `session` 的含义。

## Deferred

- `session_alias` 表与跨机器会话的身份。
- 序列对齐与更强的歧义消解。
- direct 行覆盖 Claude Code、Codex 的兜底入口。
- OTLP 的 `gen_ai.response.id`（当前 span 没有）。
- 跨来源费用归因与「直连 vs 网关」的统计口径。
- 子会话在详情页的展开样式与是否需要折叠。

## 落地状态（2026-11-04）

已落地：`canonicalSessionId` 在账本、路由与本地适配器入口统一归一；`findRequestOwnerTx` 增加 `usage_fingerprint.v1`（同 conv_key、同 agent、±2 秒、四段 token 逐段相等、候选唯一、排除同来源证据）；第 2 步 `turn_ref` 也排除同来源证据，一个 user turn 里的多笔模型调用不会互相认领；投影写用量列改为 `COALESCE`，网关迟到且无用量时不擦掉本地读数。合成覆盖在 `tests/owner-fingerprint.test.ts` 与各会话适配器测试里。

未落地：第 3 步 `(agent, conversationRoot, nativeCallId)`、direct 行入口、OTLP 认领切到统一 owner、弱指纹与序列对齐兜底、旧行的 OTLP 重放/回填。真实流量的多候选比例尚未测。
