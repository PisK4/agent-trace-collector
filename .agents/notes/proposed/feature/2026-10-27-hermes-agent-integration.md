# Agent Note: Hermes Agent 接入——用途识别、历史升级与投递诊断

Status: proposed

## Problem

### 背景与需求

2026-10-26 深夜起，本机开始用 Hermes Agent 干活。它经 magpie 网关发出模型请求，系统提示自报身份 `You are Hermes Agent, built by Nous Research`。ATC 已采集到这批流量，但用途识别、无会话请求的分组与 hook 覆盖仍有缺口。

需求是让这批 trace 的会话归属、主链、标题与用途可解释。接入沿用[Harness 语义的静态扩展](../../implemented/architecture/2026-10-26-harness-semantics-adapters.md)：已支持的协议与证据通道继续复用，新增知识限于 Hermes 的两条用途指纹。会话身份修复和投递诊断各自交付。

### 证据范围与实测形状

下表保留 2026-10-27 上午生产库只读检查的统计。原记录未保留精确采集时刻、统一截止条件与全部筛选 SQL，各项可能来自不同查询窗口；合计不能直接对账。实施前应按同一截止时刻重新记录筛选条件、分母、交集与缺失项，只保存聚合结果，不把真实正文、账号或配置写进测试或文档。

| 维度 | 原检查记录 | 解释范围与待核对项 |
| --- | --- | --- |
| 总量 | 约 1,050 笔请求 | 近似量，精确分母待复测 |
| 协议 | 820 笔 `/v1/chat/completions`，84 笔客户端 chat、上游 messages 的跨协议请求 | 两项合计 904；查询范围及是否互斥待复测，不能当全量协议分布 |
| 输入方式 | 可读样本携带历史，msg_count 从 2 到 809+ | 样本未见压缩重写，不推断全部请求历史单调增长 |
| 会话 | 路由记录涉及 106 个 conv；最大三个会话 381/246/139 笔，内部请求间隔 p50 8～33 秒 | conv 是路由提供的分组依据；历史升级还要覆盖 hook-only 行实际持有的会话键 |
| 链 | confirmed 688、unknown 201、first 71、branch 0 | 合计 960；与协议、总量的分母差异待复测。原检查将 unknown 归于无正文行，尚未在本次审阅复测 |
| 工具 | 21 个工具，含 terminal、patch、write_file；配对 resolved 732、pending 31 | 证明观察到调用与配对，不证明所有工具参数、失败语义、路径汇总与展示均已适配 |
| 标题 | 903 笔走 `model_time`，2 笔有正式标题 | 行标题统计与会话列表标题需分别验收，完整分母待复测 |

可读样本的协议形状可由现有 Chat 适配器处理：hook 保留客户端形状，跨协议请求仍按 chat 解析。既有 `tool_calls`、`role=tool` 与 `reasoning_content` 支持可以复用。本提案不据此宣告 Hermes 工具语义已全覆盖；例如[路径汇总](../../../../src/queries/session-summary.ts)按 edit/write/read 名称分类，write_file、patch 是否需要新增语义另以样本确认。

### 缺口一：审查器未排除，标题孤儿用途未识别

命令安全审查器的 system 为 `You are a security reviewer for an AI coding agent. You assess whether shell commands are safe to execute.`，回复可为 `ESCALATE` 一类短判定。原检查按双消息加短回复形状近似统计约 100 笔（样例 req 24231），其中已确认归属的样例落 `unrecognized`、`purpose_chain='participate'`，并占据 `chain_role='main'`。实施前应按 system 指纹重数，不能将形状近似量当准确命中数。

会话标题生成器的 system 含 `You name chat sessions.`，观察到带 `response_format`、回复为单键 JSON `{"title":...}`。回复可读的 2 笔已被共享规则 `title.reply.v1` 识别；约 35 笔缺回复的请求无法提供 response ID，留为 `via='hook'` 独立行，尚未被识别成标题。

这两类的链影响不同。已确认 actor 的审查器会进入组派生；hook-only 标题孤儿的 `actor_state='unknown'`，当前不进派生队列，也不作祖先候选。后者的 `purpose_chain='participate'` 是尚未排除的用途值，不能据此断言已污染主链。原检查另记 832 笔用途未识别且 signals 为空，它是未识别请求集合的统计，不能当成两类旁路请求的合计。

### 缺口二：部分请求尚未关联 hook

原检查有 159 笔 `have=6`，表示请求行已有关联的账本与路由证据，尚无关联的 hook 证据。其中 117 笔为 `status=200`、prompt 超过 10k，超龄后标 `hook_absent`；其余 42 笔为 `status=429/499`。`pending_hook` 另有 498 条缺 response ID 的历史回调，跨 agent 累积。这些数量与集合关系需在统一窗口复测。

`have=6` 与 `hook_absent` 不能单独证明回调从未到达：失败或取消请求可能仍触发 hook，但回复为 null、没有 response ID，ATC 无法精确关联。[magpie 机制研究](../../../../docs/magpie-mechanisms-research.md)在 `开源源码@magpie-2374ffe` 下已区分 HTTP 失败、回复不可用和回调缺失；该源码结论不替代当前安装版的运行验证。不能按 429/499 直接排除预期回调，也不能在没有关联依据时断言 pending 历史与 Hermes 无关。

投递丢失仍是假设。宿主的 `gatewayTimeoutMs` 与[薄插件](../../../../plugins/collector.hooks.ts)自身的总预算 1500 ms、单次 fetch 600 ms、最多两次尝试同时生效。原检查记本机宿主配置未设置、取默认 1000 ms，这一配置状态及当前加载插件需复核。调大宿主预算只能验证宿主提前终止这一种路径；`ingest_issue` 没有错误也不能排除未到达、请求超时或 HTTP 拒收。

### 缺口三：空 session 将无归属请求放进同一个列表分组

原检查中，`raw_hook` 的 834 笔 Hermes 行均有 `session=''`，无 NULL。当前 [hookConv](../../../../src/evidence.ts)只把 null 视为缺失，因此这些 hook 初建时使用 `['session','']`。约 43 笔尚未关联的 hook-only 行留在该分组，数量及其中标题请求的占比待复测。

[hook 摄入](../../../../src/hook.ts)将 hook-only 行的 actor 标为 unknown，所以这些行共享会话列表分组，但不互相作祖先候选。成功关联后，hook 行的正文与证据并入账本目标请求，保留目标已由账本、路由确认的归属；该转换不由来源投影重写会话键完成。

修复 helper 只影响后续调用，不能迁移已存的会话身份。[显式重建](../../../../src/maintenance/rebuild.ts)只升级用途与重算组派生，不重建 conv_key；重复提交同一个 hook_id 也会按幂等路径直接返回。历史修复必须有自己的执行入口。

### 与既有记录的关系

已在活动 note 树检查同类决定。本提案承接[Harness 静态扩展](../../implemented/architecture/2026-10-26-harness-semantics-adapters.md)的用途登记方式，不取代其边界；[用途解释与结算](../../implemented/architecture/2026-10-22-request-purpose-and-chain.md)和[来源投影与字段保真](../../implemented/architecture/2026-10-22-source-projection-and-field-fidelity.md)继续有效。[zcode 接入](2026-10-24-zcode-agent-support.md)保持独立。活动树中未发现持有 Hermes 两条用途指纹或空 session 历史修复的既有记录，无须归档旧决定。

## Proposal

### 第一批：用途登记与标签

新建 [src/harness/hermes.ts](../../../../src/harness/hermes.ts)，在 [PURPOSE_RULES](../../../../src/harness/purpose.ts)追加 `{ agent: 'hermes', decide: hermesDecision }`。标签选取由登记处承担，adapter 不自查 agent，不读数据库。命中门槛只读现有 [PurposeView](../../../../src/semantics.ts) 的 systemTexts，标题与审查结果信号读取 replyText。

| 规则 | 指纹（小写包含比较） | 结论 |
| --- | --- | --- |
| 命令审查器 | system 文本含 `security reviewer for an ai coding agent` | `kind='command-review'`、`chain='exclude'`、`modelTitle=null`；判定词及缺失状态只写 signals |
| 标题生成器 | system 文本含 `you name chat sessions` | `kind='title'`、`chain='exclude'`；标题复用 titleFromReply，支持单键 JSON 与 `<title>` 回复 |

规则 ID 分别为 `hermes.command-review.v1` 与 `hermes.session-title.v1`。审查器先判，标题后判，两条同时出现时按该次序取胜，并用合成反例锁定。缺回复的标题请求仍排除链；从未提取过标题时 modelTitle 为 null，曾有正式标题的行继续遵守[标题保留语义](../../../../src/semantics.ts)，不因本次缺回复撤销旧标题。

取数沿用 [readPurposeViewTx](../../../../src/request-purpose.ts)：Chat 的 system/developer 消息经 role=2 块读取，顶层 system 经骨架读取，无须扩展视图。agent 标签来自上游，不作为身份凭证；未知与空标签只走共享回退。两条指纹与现有 Claude 分类器不同，跨 harness 的不命中仍须测试，不以字符串比较替代验收。

[页面标签](../../../../web/session-view.js)补 `hermes: 'Hermes'`，zcode 的标签由其提案交付。`command-review` 实施时按[词汇表](../../../../GLOSSARY.md)的准入规则登记。

用途结果改变链参与，提升 PURPOSE_VERSION；当前基线为 4，实施前复核后在最新基线上递增，不覆盖并行变更。正文不可读时保留旧实际版本与结论，不把 retained 写成新规则已确认。

### 历史用途升级：按请求实际会话键确定范围

部署前只读枚举 `request.agent='hermes'` 的实际 conv_key，冻结本次候选请求与会话键清单，记录统一截止时点。范围必须包含路由 conv 和仍持有 `['session','']` 的 hook-only 行，不把原检查的 106 当固定数量。conv_key 为空或无法纳入现有入口的行单列拒绝原因，不隐去。

使用[显式会话重建](../../../../docs/operations.md#rebuild)逐个升级、排空，普通 tick 不代替历史升级。现有入口以整个 conv_key 为作用域，空 session 桶可能含其他 agent；本批接受对该键下所有旧目标用途行一并升级，执行前报告各 agent 的候选数量，执行后核对非 Hermes 行沿用原有判定。不得把整桶升级报告成只修改 Hermes 行。

重建不改变会话身份。第一批结束后，标题孤儿可以得到正确用途，但仍保持未知 actor 与原列表分组；身份拆分由第三批交付。真实库写入走运维手册的维护窗口、备份与服务起停步骤，执行记录包含升级、保留、失败、拒绝与剩余数，事后只读核对结果。

### 第二批：分层验证 hook 投递

先核对当前加载插件、magpie 安装版与实际生效配置，再确定实验预算。宿主默认值引用当前版本的依据；插件预算以加载文件为准，不只读仓库副本。提高 gatewayTimeoutMs（例如 5000 ms）可以作为宿主预算实验，但插件仍有独立截止，不能据结果直接确认或排除全部超时原因。

验证分别统计以下阶段，诊断只记录固定码、计数、大小与耗时，不记录正文、令牌或账号：

- 宿主是否调用完成期 hook，是否因宿主生命周期或预算终止。
- 插件是否开始投递，是否发生单次超时、总截止、网络错误或 HTTP 拒收。
- ATC 是否收到并接受 envelope，收到后是否因缺 response ID 或多候选留为 pending。
- 已有账本、路由的请求中，哪些仍未关联 hook，哪些已有正文但回复不可用。

实验使用同一截止条件的前后窗口，按 agent、状态码、请求体积与请求类别分别计数。缺口在等待阈值后统计；无法精确关联的 null ID 回调单列未知，不按时间邻近强行配对。调大宿主预算后若无改善，应继续核对插件截止与接收延迟，不能直接跳到 ATC 派生重载是丢因的结论。

本批先交付诊断与配置实验。证据若要求改插件预算或诊断能力，再单独提交代码与合成验证；不承诺所有问题仅靠配置解决。ATC 既有缺失标注保持原义，历史无正文不能因配置变化宣称已恢复。

本批已交付，实际决定、归因顺序与验证见[hook 投递分层诊断](../../implemented/feature/2026-10-27-hook-delivery-diagnostics.md)。交付的是诊断本身：ATC 侧只读窗口聚合，插件侧六个固定码；提高宿主预算的配置实验未跑，跨进程读取插件状态未做。

### 第三批：空 session 修复与显式身份迁移

该批单独立项、单独提交，在活动 note 树做 supersession check 后记录决定。本提案只规定必要结果，不将其视为第一批附带修复。

新请求的会话选择把空 session 视为缺失，原始证据仍保留上游空值。先追踪调用方：[账本与路由映射](../../../../src/sources/magpie/mapping.ts)已将空串转 null，hook envelope 当前保留空串；修复应覆盖真正缺少规范化的身份入口，并核对 actor 的取值。是否同时修改 ledgerConv、routeConv 由调用关系决定，不把无实际影响的 helper 修改冒充历史修复。

存量数据另提供显式、幂等的身份迁移入口，不依赖现有 rebuild 或重复投递。执行前输出候选清单与拒绝原因，执行时重新校验来源，至少满足以下要求：

- 只迁移可由 hook 证据证明缺少有效 session、且尚未获得账本或路由归属的行；多份 hook 证据无法确定唯一回退身份时拒绝，不取首条猜测。
- 会话键与来源回退到各自 hook 身份；actor 保持 unknown，空 actor 规范化为 null，不以拆分列表分组为由确认 actor。
- 每笔迁移在一个事务里更新身份并推进输入修订，按现有归属变更规则处理旧组、新组与已有派生产物；未知 actor 行不凭空建派生组。
- 请求 ID、正文、证据、别名、用量与费用保持守恒；后续拿到唯一 response ID 关联时仍能并入正确目标。
- 重复执行不再迁移、不推进修订；来源过期、身份冲突或执行前已完成关联的行分别报告并保留可解释结果。

迁移作用域由缺陷条件决定，不限定 Hermes。实施前统计各 agent 的影响，并核对已关联行是否存在同类错误；已关联行不符合上述孤儿迁移条件，应单列核查，不套用 hook 回退。不得直接改写原始证据来掩盖派生身份错误。

本批已交付，实际决定、拒绝判据与验证见[空 session 不是会话身份](../../implemented/bug-fix/2026-10-27-empty-session-identity-migration.md)。

### 交付边界

三批的实现决定都已分别落成 implemented 记录：[Hermes 用途识别](../../implemented/feature/2026-10-27-hermes-purpose-recognition.md)、[hook 投递分层诊断](../../implemented/feature/2026-10-27-hook-delivery-diagnostics.md)与[空 session 不是会话身份](../../implemented/bug-fix/2026-10-27-empty-session-identity-migration.md)。本文保留为未完成部分的提案：真实库的历史用途升级、宿主预算配置实验与真实流量窗口对比都尚未执行，不得因三批代码已交付就把整篇标为 implemented，也不得把合成验收当成真实库验收。

本次不新增协议适配。无压缩重写和 subagent 样本时不加识别规则；Hermes 自定义字段保持原样保存。工具名称、参数、失败语义与路径汇总的额外适配由后续证据决定，不由协议兼容结论代替。

## Alternatives considered

**为 Hermes 建整套 Profile 或动态插件接口。** 两条用途指纹已有静态登记入口，额外框架不能解决会话身份或投递缺失，增加的接口无当前消费者。

**只靠标题回复形状。** 共享规则已能识别回复可读的标题，但缺回复时只有请求侧 system 指纹可用。

**把 ESCALATE 等判定词作为门槛。** 回复可能缺失、措辞可能变化；请求侧指纹识别用途，回复判定只保留为信号。

**在共享文件里加 Hermes 分支。** 专属知识归静态 adapter；分派、结算和共享解释继续复用，不新增品牌判断。

**只重建路由提供的 conv。** 会漏掉 hook-only 所在的空 session 桶。历史升级按请求实际键枚举，接受并报告现有整键入口的作用域。

**修改会话 helper 后直接重建旧组。** 现有重建不重算身份，重复 hook 又会被幂等跳过；历史拆分必须有显式迁移。

**仅调大宿主超时后判断丢因。** 插件自身截止、宿主生命周期、HTTP 拒收与无法关联均可能表现为请求缺 hook，单一配置实验不足以区分。

**先修投递再接用途。** 正文可读的请求已有足够证据识别用途，三项工作可以分开交付；缺正文行继续如实保留缺口。

## Acceptance criteria

### 合成数据

1. 用途命中：agent 为 hermes，system 含审查器指纹时得到 command-review/exclude；标题指纹得到 title/exclude。锁定规则 ID、信号与双指纹优先级。
2. 标题回复：单键 JSON 与 `<title>` 提取成功；缺回复仍排除链，从未提取过标题时 model_title 为 null；已有正式标题时遵守保留语义。
3. 生产取数：使用实际 Chat messages 中的 system/developer 块持久化后，经 readPurposeViewTx 结算命中，不能只手工构造 PurposeView 验证 matcher。
4. 反例：指纹仅在 user 内容、agent 为 claude/omp/未知/空，均不命中 Hermes 专属规则，仍可按既有共享规则得出结论；普通 Hermes 主请求保持 chat/participate。跨 harness 指纹不误判。
5. 判定次序：来源 kind 与强指纹共存时按既有专属规则优先级结算；弃权仍走共享回退。
6. 已知 actor 的组：构造主请求 A、审查器 R、续写 B，R 得到 prev_relation/chain_role 为 aux、delta_ordinals 为 null、title_source 为 model_time；B 仍续接 A，主链与工具配对不受旁路干扰。
7. 未知 actor：空 session、缺回复的 hook-only 行可以结算用途，但不进入链候选、不建组队列，不要求已有 aux 派生字段。
8. 历史升级：构造路由组和空桶里的旧版 clean 行，枚举范围后显式升级均生效；普通 tick 保留旧目标。空桶含其他 agent 时报告整桶影响，其他规则结论保持一致；正文不可读行保留旧实际版本。
9. 投递实验：覆盖宿主截止与插件截止的区别；模拟接收方晚于插件单次截止返回成功，即使宿主预算更大也应记录失败，不能写成投递成功。延迟值以实施时插件预算为准。
10. 身份迁移在第三批锁定：新空值与 null 同路；旧孤儿拆分、重复迁移、冲突拒绝、执行前已关联、迁移后关联与数据守恒。迁移后 actor 仍未知，现有 rebuild 不冒充身份修复。

[生产登记测试](../../../../tests/harness-purpose.test.ts)更新 agent 列表及品牌回流的结构断言，使其同时覆盖 hermes。按批次运行能对相应回归失败的最窄测试；用途批覆盖 harness-purpose、request-purpose 与 derive-purpose，补会话查询断言核对列表标题；有代码改动时运行 typecheck。提交前运行 verify:notes，不为纯提案修订重复跑全量代码测试。

### 真实库验证

实施前按统一截止时点复测候选集合，记录 agent、conv_key、actor 状态、用途、版本与正文覆盖的聚合分布。写入在维护窗口执行，结果再用只读连接核对；真实正文与账号不入测试。

| 项 | 目标结果 |
| --- | --- |
| 有可读正文的审查器 | recognized、command-review、exclude；已知 actor 的组派生为 aux |
| 缺回复但请求可读的标题孤儿 | recognized、title、exclude；仍为未知 actor，不宣称已修复会话身份 |
| 已有正式标题 | 标题值保留，规则与实际用途版本按本次结算记录 |
| 历史升级范围 | 路由键与 hook-only 实际键均覆盖；空键拒绝、共享桶的其他 agent 影响分别报告 |
| 主循环 | 排除旁路后的前驱、增量、工具与标题符合合成判据；独立请求和正文缺口不被强接 |
| 版本与队列 | 可重算行使用目标版本，retained 保留旧实际版本；用途和组积压为零，错误终态另列 |
| 投递覆盖 | 可比窗口按状态、体积与类别报告新增缺口；null ID 无法关联项单列未知，不将覆盖变化直接写成丢因已证实 |
| 身份迁移 | 第三批按候选、迁移、跳过、拒绝与剩余对账；请求、正文、证据与用量守恒，重复执行零新增变更 |

本次提案审阅的合成核查已确认：hook-only 空桶行 actor 未知且不进队列；只重建路由键会漏掉空桶旧用途；现有 rebuild 保留会话身份；在仓库插件单次 600 ms 的预算下，模拟 700 ms 返回且宿主预算 5000 ms 仍会两次超时。现有三个用途测试文件共 30 项通过。这些结果只证明当前实现与合成场景，不代表新 adapter 或历史迁移已经实现，也不复核原生产库统计。

## Risks

- system 指纹依赖上游措辞与 agent 标签，变化后可能退回未识别并继续参与链；规则失效会重新影响主链，不能描述为无害。
- system 文本也可能含引用材料，包含比较仍有误判风险；user 引用不命中的测试不能证明所有 system 引用都安全。
- 原检查缺少统一分母与精确时点，约数仅用于说明问题，实施范围以部署前重新枚举为准。
- 共享空 session 桶的用途升级覆盖整键，身份缺陷也可能涉及其他 agent，必须报告实际影响，不能只验 Hermes 数量。
- 提高超时不恢复历史正文，也不提供持久投递保证；当前无稳定关联锚点的失败回调仍可能无法对账。
- 工具配对成功不证明路径汇总、失败位与工具展示均具备 Hermes 语义，完整覆盖需另行验证。
- 身份迁移处理的是已有真实数据，缺证据、冲突与关联竞态需要明确拒绝或重试路径，不能通过改原始证据消除差异。
