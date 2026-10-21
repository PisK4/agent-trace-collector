# 请求类别与 Agent 适配评审

评审日期：2026-10-22。对象为 [Agent Profile 与请求类别注册表提案](../.agents/notes/proposed/architecture/2026-10-22-agent-request-kind-registry.md)及[字段保真与 magpie 对标提案](../.agents/notes/proposed/architecture/2026-10-22-magpie-parity-and-field-fidelity.md)。本轮核对 ATC 工作树、交接方案和固定提交的 magpie 源码，仅运行合成逻辑检查；没有读取真实请求正文或配置，没有调用模型、修改 magpie、执行回填或切换服务。

建议修订后实施。保留派生阶段的静态分类 Module、纯匹配器、未知 Agent 的通用处理，以及页面消费持久化分类的方向。实施前补齐分类门槛、用途与链角色的区别、上游用途信号、证据缺失与重算规则。容量提升需要独立验收，不能从新增注册表推导。下一轮范围与职责的统筹入口见[架构演进方案 v2](architecture-evolution-v2.md)，本文保留具体反例与源码核对。

## magpie 的兼容机制怎样借鉴

用户提出的逐家处理方向有源码依据。magpie 把多种变化放在不同位置处理：`internal/agent/agent.go:110` 的 `Agent` 描述配置位置、`Fields` 和可选回调，`Field` 提供 `Get/Set/Options`（`:89`）；`internal/agent/agents.go:89` 注册各 Agent 的具体实现。这是配置适配的 Interface，并没有一个统一的请求语义 Feature 表。以下机制均为 `版本锁定`，物证为 `开源源码@magpie-2374ffe`。

| 变化 | magpie 中的实际处理 | ATC 应采用的范围 |
| --- | --- | --- |
| 每家客户端的配置与兼容差异 | Pi 写 `compat.sendSessionAffinityHeaders`（`internal/agent/agents.go:426`）；OMP 写 `promptCacheSessionHeader`（`internal/agent/omp.go:677`）；DSH 使用专用输出预算函数（`internal/agent/dsh.go:1513`） | 借鉴每种差异有明确归属的组织方式。ATC 只读已观察到的请求，不接管这些配置写入 |
| 指令、MCP 与技能支持 | `library.Target` 分别描述存放位置（`internal/library/targets.go:23`）；`Takes` 检查对应能力是否有目标位置（`:816`） | 借鉴按实际能力声明支持范围的做法。ATC 不应从 Agent 名称推断某笔请求一定包含技能或工具 |
| 客户端标签 | `agentOf` 优先读取命名 token，再处理 UA；未知产品名继续返回（`internal/gateway/gateway.go:60`、`internal/usage/usage.go:333`） | 直接使用 magpie 输出标签，未知值原样保留；Profile 只为确有特有规则的标签建立映射 |
| 请求用途的声明 | `callKind` 按顺序读取 subagent、memgen、thread source、DSH compact 与内部搜索等请求信号（`internal/gateway/codex_backend.go:1541`） | ATC 从账本或路由读取已输出的 kind，避免复制请求头识别逻辑；hook 没有这些 header 或 kind 字段 |
| 用途别名与未知值 | `PurposeOf` 保留记录中的原始 Kind；空值归入 `unmarked`，已知别名归并，未知值直通为 `kind:<原值>`（`internal/usage/purpose.go:20`、`:40`） | 保留原始用途与派生类别两个事实。空用途表示未标记，不能证明是 chat；别名表与显示名称集中维护 |
| 客户端专有的形状启发式 | `observedKind` 在 kind 为空且客户端为 claude/claude-desktop、请求额度小、无工具时返回 auxiliary（`internal/gateway/observe.go:54`） | 只能借鉴明确门控的兜底方式。它没有区分具体辅助用途，也不足以替代 ATC 的分类器指纹 |
| 协议形状 | `Protocol` 独立定义 chat/responses/anthropic/gemini（`internal/provider/provider.go:35`） | 保持协议 Adapter 与 Agent Profile 分离。同一 Agent 可使用不同协议，相同协议也不能确定 Agent |

其中直接有用的是 `PurposeOf` 的原始值与归并值分离，以及 `Agent` 将专有变化放到各自实现中的做法。ATC 可保留 `req_kind` 为自己的稳定语义 ID，另行长期保留来源 kind；不需要复制 magpie 的整个 Agent 描述对象、动态插件运行时或配置管理 Interface。这里的采用范围属于 `推断`。

接入面也有限制。`GatewayContext` 没有 kind、conv、subagent 或请求头字段（`internal/plugin/gateway.go:79`），ATC 要在账本和路由证据到达后再利用相应信号。magpie 某些内部辅助请求还会直接进入 `serve`，绕过 Agent hook 路径（`internal/gateway/gateway.go:1437`）；因此所有经过 magpie 的机器调用都能完整采集，超出了现有 hook 的覆盖承诺。注册表改善的是已采集请求的解释能力。

不建议照搬 magpie 所有谓词。它有的消费者用 `PurposeOf` 归并键，有的仍精确判断原始 kind（`internal/gateway/session_parent.go:10`）。ATC 应把类别的链参与策略集中维护，供祖先比较、链角色和工具配对共同使用，避免新增类别后各处解释不一致。

## 提案中需要先修正的规则

### 分类器门槛会把普通请求移出主链

提案第 114–121 行列出四组信号，要求至少满足两项。合成反例是一个 `agent='claude'` 的普通请求：system 为普通助手提示，未设置 `</block>` 停止串，两条消息、零工具，回复恰好为 `<block>no`。它满足消息形状和回复标签两项，会被识别为分类器，却正好属于第 209 行要求保持 chat 的情况。后果包括退出祖先集合、改变主链及用户标题来源。这个矛盾已用 Bun 合成逻辑检查复现；生产分类器尚未实现。

建议第一版采用有明确请求指纹的门槛：对应 Agent Profile、system 中的分类器专属子串、`stop_sequences` 中的 `</block>` 同时成立。两条消息和零工具作为形状校验，回复标签用于提取 verdict，不允许凑足分类门槛。这个门槛是针对现有研究样本的保守设计建议，不是对客户端未来版本的承诺。版本漂移时退回未识别并留下原因。

用途识别与 verdict 还应分开。请求指纹成立但回复缺失、失败或格式变化时，可以识别分类器用途，同时令判定结果未知。不能从缺失回复补出放行或拦截。建议门槛的三个合成断言已通过：普通反例不命中、缺回复但请求指纹完整的请求命中、相同形状换成 OMP 不命中。这些断言没有验证真实客户端或完整派生链路。

### 用途与链角色必须能独立变化

提案第 61、138、143 行把所有匹配结果限定为 `aux`，通用链计算又只接纳 `req_kind='chat'`。它足够覆盖当前 title 与 auto mode classifier，却不能直接扩展成全部 Agent 特性的 Interface。压缩、review、搜索等用途的名字本身不能证明请求应退出对话链；是否参与链计算，要由该机制的输入输出和后继关系决定。

建议继续复用 `req_kind` 保存稳定的语义 ID，暂不增加 `req_feature`。将通用规则从非 chat 即辅助改成显式的链参与策略。当前已证实的两类仍排除在祖先比较之外；未来遇到第二种链策略再扩充 Interface，不预建整套能力框架。`chain_role` 表示最终链角色，分类器不应在匹配时替全部未来用途决定该值。

查询和页面要保留未知 `req_kind`，但未知 ID 不能自动套辅助样式。页面应先读取已保存的 `chain_role`；角色也未知时展示中性请求行。类别未知、Agent 未知、正文不可读分别处理，不能相互替代。

### 回收后的历史分类需要可解释

提案第 145 行要求正文不可读时保留类别，第 147、189 行又将分类依据持久化设为可选，并给出仅写日志的替代。正文与短期原始证据回收后，日志不能保证与长期请求记录一起保留，误判原因可能无法再查。

建议把持久化规则 ID、命中信号和判定状态作为本次分类契约的一部分。只保存枚举或短代码，避免把 system 和 transcript 再复制一份。可采用一列精简 JSON；这是 schema 变化，必须明确迁移与旧行允许为空，不能再同时宣称完全无迁移。证据就地存在请求记录中，不建立单独证据台账。

保留旧分类表示保存已有结论，不表示用新规则验证成功。正文还在时允许按新版本重算；正文已回收时保留旧类别及其规则版本，标注无法复核。没有历史分类也没有可用证据时，保持未识别，不能推断已确认属于普通对话。全局 `derive_version` 可以记录本轮重算已执行，但不能代替分类依据的版本。

### 匹配优先级与成本尚未确定

提案第 84–99 行给出了数组顺序，却没有定义多个规则同时命中时的结果。共享的 Title Generator 仅凭回复形状就能命中；其已知误判已记录在 [Title Generator 决策](../.agents/notes/implemented/feature/2026-10-21-title-generator-and-main-chain.md)。将它迁入注册表不会自动提高识别准确率。

建议显式规定 Agent 专属且具备强请求指纹的规则优先，共享的回复形状规则最后使用。首版保持固定顺序，不引入数值打分系统。对覆盖范围相交的规则补一个合成冲突测试，确认结果与优先级一致。保留 title 的现有兼容行为，同时承认它仍是启发式。

`RequestView` 的方法也需要成本契约：同次派生复用骨架和块解码，先做 Agent、协议及计数检查，再读取所需文本。提供 `messages(): unknown[]` 会鼓励所有 matcher 全量还原长历史；分类器只需按需读取 system、停止串和最后的 transcript，不应为识别辅助用途重复解压整段会话。先复用实际派生上下文，待两个匹配器确实需要同一新能力再扩大 Interface。

## ATC 现状对实施的约束

以下源码结论以本轮 ATC 基准为限，属于 `版本锁定`；改进建议属于 `推断`。

上游用途没有进入长期读模型。`src/sources/magpie.ts:158`、`:218` 解析账本与路由的 `kind`，`src/reconcile.ts:405`、`:495` 将它们保存在原始表；但 `saveRouteSummary` 的长期摘要不含该值（`:507`），派生 `req_kind` 也只来自 title 启发式。原始层按七天清理后，这条语义证据就无法从现有长期记录取回。建议先保留上游原始用途及来源，再由 Profile 解释它；不能把上游 `kind` 无条件覆盖为 ATC 的类别，也不能为有明确用途标签的请求重复扫描全文。

派生并不等待全部证据齐备。hook-only 请求以未知 actor 写入（`src/hook.ts:120`），`enqueueDeriveTx` 只接纳已知 actor（`src/derive.ts:274`），后续证据到达才可能触发分类。提案第 25 行的只判定一次不能作为契约。分类应在依赖证据变化后重算，并保证相同证据集以不同顺序到达时结果相同；不能因第一次未匹配就永久记成普通对话。

`derive_version` 当前是重算次数：`src/derive.ts:718` 执行 `derive_version=derive_version+1`，没有统一算法版本常量。因此多次重算的旧算法记录可能有更大的数，提案要求的升版和低版本回填不能直接依赖它。建议将算法版本改为显式常量赋值，已有计数不参与算法新旧比较；迁移应重新入队，而不是筛选数值小于某版本的行。

新增类别的影响也超出注册表。`src/derive.ts:643` 仅对 title 保留旧类别，`:723` 将其余请求写回 chat；`assignChainRoles` 只选 chat（`:576`）。`src/queries.ts:326` 折叠未知类别，`:102` 的会话标题 SQL 写死 title/chat。`web/app.js:365` 将所有 aux 关系解释为标题生成，`:624` 仍从摘要前缀猜测。实施时要用持久化类别和显式链策略贯通这些消费者，不能只增加一个 matcher 文件。

## 现有 Feature 的完整迁移评估

盘点覆盖派生、协议与正文存储、三路收敛、薄 hook、隐私处理、查询及生产页面。判断依据是规则解释的对象：协议字段属于协议 Adapter；客户端怎样包装用户输入、声明技能或发起特殊用途请求，属于 Agent 语义；链算法、证据归属和渲染分别保留各自职责。不能因一段代码是纯函数，或包含 anthropic 字样，就把它放入 Feature。

适合迁入的现有语义集中在三组：Title Generator、harness 输入解释、技能清单提取。auto mode classifier 是新增用途识别；上游 kind 归并是现有采集之上的语义补齐；指纹中的 harness 剥壳没有代码实现，不能算已有迁移量。以下结论是对当前源码的评估，目标组织方式属于建议。

| 功能 | 当前依据 | 迁移判断与保留职责 |
| --- | --- | --- |
| Title Generator 识别与正式标题提取 | `src/derive.ts:482` 的标签/单键 JSON 解析，`:504` 的回复摘要，`:643` 的用途判断 | 迁入共享 title Feature。返回用途、正式标题和识别依据；骨架读取与解压留派生上下文，摘要截断留通用格式化 |
| 页面再次识别标题 | `web/app.js:556` 的 `<title-request>`、`:563` 的回复解析、`:624` 的摘要前缀判断 | 删除重复判断，消费服务端保存的类别和正式标题。需要兼容的请求侧信号由 title Feature 统一评估，不能仅机械删除就宣称识别覆盖完全相同 |
| harness 包装与插话解释 | `src/derive.ts:174` 至 `:227` 的 session、命令回显、通知、技能注入及插话规则；`web/app.js:580` 至 `:599` 的另一套清洗 | 迁移规则中的客户端专有语义，形成独立的输入解释 Module，供标题、摘要和消息展示消费。识别系统注入、保留用户正文和解析失败状态由它负责；不能直接放进互斥的 RequestKind |
| 用户首句备用标题、增量和末轮摘要 | `src/derive.ts:231`、`:339`、`:355`、`:375` | 部分迁移：调用上述输入解释结果；选择哪个新增 user、首行/长度限制、无文本时的兜底仍由通用派生负责 |
| Claude Code 技能清单 | `web/body-view.js:507`、`:560` 的 Skill tool 标题与连续列表解析 | 迁入技能提取 Module 的客户端规则，Profile 选择适用解析器。技能存在于这一笔请求的声明中，不代表已调用或当前可执行 |
| 标签式技能清单 | `web/body-view.js:540`、`:612` 的 `<skills>` 与 `<available_skills>`；`tests/body-view.test.ts:270` 的 OMP 合成用例 | 与上项一起迁移。OMP 形状有合成测试；标签格式可共享，但不能仅凭标签推断 Agent 身份或宣称所有客户端支持 |
| 工具定义清单 | `web/body-view.js:589` 至 `:603` 的 tools/functions、input_schema/parameters | 属于协议读取，可与技能结果一起供能力区块展示；字段归一留协议 Adapter，不进 Agent 专有规则 |
| 请求、回复及工具块形状 | `src/derive.ts:6`、`:42`、`:251`、`:395`、`:524`；`web/body-view.js:120`、`:269` 的协议读取 | 同协议 Adapter 或协议纯函数收敛。前后端重复值得处理，但不要求在本轮重写整个正文阅读接口 |
| 语义指纹 | `src/fingerprint.ts:22`、`:40`、`:66`；`src/body.ts:114` 至 `:122` | 现有传输字段剔除、片段归一、角色与哈希保留核心层。harness 专有归一如需新增，必须单独论证，不能复用展示清洗直接丢文本 |
| 前驱、增量、主链与分支 | `src/derive.ts:138`、`:573`、`:613` | 保留通用算法。用途规则提供明确的链参与策略；算法负责计算最终角色，不按非 chat 就 aux 推断 |
| 工具调用配对与结果摘要 | `src/derive.ts:443`、`:779` | 保留通用关联。协议层读调用和结果；用途层可声明本请求是否参加配对。不能从 transcript 内的文字重放生成真实工具关系 |
| 会话最终标题选择 | `src/queries.ts:102` | 保留读模型的正式标题、主链首句与备用标题优先级；由 title Feature 供给候选，读取侧不重新解析正文 |
| 上游用途信号 | `src/sources/magpie.ts:158`、`:218`；`src/reconcile.ts:405`、`:495` | 来源解析和原始保存留采集/收敛层；用途别名归并、冲突与匹配优先级进入请求语义 Module。长期保留来源值是存储前提，不由 Feature 写库 |
| 身份、证据、费用与来源版本 | `src/hook.ts`、`src/reconcile.ts`、`src/sources/magpie.ts` | 保留来源适配和通用收敛。agent 是选规则的标签；conv_key、actor、response_id 和证据匹配不交给 Feature 发明 |
| 安全、正文保存、保留与准入 | `src/privacy.ts`、`src/body.ts`、`src/retention.ts`、`src/http.ts` | 保留统一规则。Profile 不得放宽脱敏、访问控制、预算或完整性要求，存储事务和正文分页也不进 Feature |
| 标签、折叠、导航和指标展示 | `web/app.js:149`、`:365`、`:799`；`web/body-view.js:651` | 渲染留页面。类别标签集中定义并提供未知 ID 兜底；aux 文案按类别显示。Agent 显示别名、用量算式与时间格式不需要变成插件 |

### RequestKind 只能覆盖一种变化

同一笔正常对话可以同时具有用户包装和技能清单，它仍然只有一个主要请求用途。将每种特性都注册为 `RequestKind.match()` 并取首个命中，会使技能、包装与 title/classifier 互相遮蔽。建议将 Agent 语义层组织为三个独立操作：用途分类、输入解释、技能提取。用途内部规定冲突优先级；后两项按各自规则组合，不参与用途竞争。

这三个操作有现成的变化依据：title 与 classifier 是两种用途，普通文本与 harness 包装需要不同解释，技能清单已有标签式与标题式两种解析。实现可以仍然很小：静态函数表、共享纯函数和少数有规则的 Profile；不需要一个所有 Feature 都必须实现的全能 Interface，也不需要逐 Feature 建表或把每个结果写进通用 feature JSON。

Profile 负责选择规则，协议 Adapter 提供已归一的文本与结构，调用方负责读取、缓存和持久化。用途分类继续产出稳定 `req_kind`；输入解释产出可显示文本及其类型/原因；技能提取产出本请求观察到的声明和解析状态。这是建议的职责划分，不是已经落地的字段或 Interface。无需为 OMP 建只有共享 title 的空壳 Profile，也不预建 Codex、Pi 的未知规则。

### 包装迁移不能同时改写指纹

前后端清洗并不等价。服务端有 `local-command-caveat` 和插话前后缀，前端缺少这些规则；前端正则可删除文本中间的标签块，服务端多处锚定开头。迁移时需明确一个基准及回归用例，不能把两组正则直接合并后当成行为保持。现有服务端规则也没有 Agent 门控；提取代码与收紧适用 Agent 是两种变化，后者应单独说明会影响哪些未知标签历史记录。

`renderConversation` 会对确定新增的多条用户消息逐条显示（`web/app.js:625` 至 `:666`），单个 `input_preview` 无法替代这一行为。建议从服务端按正文分页返回消息级展示解释，保留 ord、原始脱敏正文入口与增量关系；列表摘要仍在派生阶段保存。解释结果不覆盖消息原文，解析失败保留内容。正文回收后可以保留已保存摘要，但不能伪造已不存在的完整可显示消息。

生产 web 是无构建 JavaScript，不能直接 import TypeScript Feature 文件。最小迁移采用服务端输出解释结果、前端消费；如后续确需跨端复用，可以选择浏览器可加载的纯 JavaScript Module，但不为这次评估先引入构建或复制生成流程。正文请求阶段复用同一输入解释 Module，与分类在派生阶段持久化并不冲突；页面不再各自维护规则。

[架构设计](architecture-design.md#语义指纹)声称 harness 包装在指纹前剥掉，但 `src/fingerprint.ts` 实际保留文本原值。设计与代码存在缺口。丢弃 transcript/技能注入在标题展示中可能合理，用于指纹则可能将内容不同的消息判为相同，进而错误确认前驱。首轮建议明确记录该缺口并保留当前指纹行为；是否补实现需独立的等价性证据和验收。

另一个约束来自存储：`block` 以内容哈希共享，并只有一列 fingerprint；`persistBodyTx` 也未接收 agent。同样的脱敏消息可由不同 Agent 引用，在共享块上保存按 Profile 计算的不同指纹会冲突。若确需 Agent 专有指纹，需另定按请求/规则版本保存的方式，或在派生中计算并缓存；不能简单回填共享的 `block.fingerprint`，也不能让迟到的 agent 标签改变内容寻址事实。

### 能力提取的迁移不要求长期复制全文

工具定义属于协议，技能声明属于客户端约定，能力区块可以组合两种结果。解析器需区分确实为空、格式未识别、证据缺失和仅读到部分 system 消息；当前 UI 随已加载 entries 取 system 文本，迁移后不能将首个分页没读到技能显示成已确认零技能。

建议先通过正文读取路径返回归一后的工具与技能结果，复用已解码骨架，按需读取相关 system 块，并限制扫描工作量。不因迁移而长期复制全部技能描述和工具 schema。若产品要求正文回收后仍能看历史能力，再单独确定需要保留的计数、名称、来源及规则版本；这部分包含正文内容，应沿用正文保留和预算约束，不能借派生字段绕过回收。

现有 `tests/body-view.test.ts:222` 至 `:315` 同时测试工具字段解析、两类技能格式与渲染。迁移应将语义断言移到对应 Module，把 HTML/转义断言留页面测试。输入解释需覆盖包装中仍有真实用户文本、普通用户合法使用相同标签、未知 Agent、插话、嵌套和不完整标签；按已保存 ord 核对对话视图，避免只验摘要。

## 与字段保真方案的联合评估

[字段保真提案](../.agents/notes/proposed/architecture/2026-10-22-magpie-parity-and-field-fidelity.md)的优先方向成立：先准确读取上游事实，再让 Feature 解释它们。它补充来源字段与读模型，类别提案补充用途解释，两者共同依赖可追溯的输入与可重跑的派生。以下 ATC 与 magpie 源码结论属于 `版本锁定`，采用范围属于 `推断`；新提案引用的 `采集@2026-10-22` 数量没有在本轮重新查询，不作为本轮实测。

### 字段修复必须同时覆盖收敛与历史回填

`req`、`cost`、`err` 与布尔 `counted` 的核对方向正确。magpie 的 `usage.Record.Requested` 使用 `json:"req,omitempty"`，`OwnCost` 使用 `json:"cost,omitempty"`，错误文本与类型分别是 `err`、`err_type`（`internal/usage/usage.go:56`、`:198`、`:136`）；ATC 却分别读取 requested、own_cost/ownCost，且没有映射错误文本（`src/sources/magpie.ts:164`、`:199`、`:194`）。这属于来源 Adapter 的字段错误，不能由 Agent Feature 修补。

但改 mapper 后，请求模型仍会失真。`insertRequest` 与 `applySingleLedger` 直接将 fields.model 写入 model_requested（`src/reconcile.ts:165`、`:196`）；聚合路径使用 `final?.model ?? final?.requested`（`:289`）。三条写入路径都需修正。建议严格区分客户端请求值 req、provider 模型标识 model、回复声明 served；缺少 req 时保留未知，不用 model 冒充请求值。现有 model_served 的 served→model 备用也应让读者能区分回复声明与路由模型，不能显示成 vendor 已确认。

普通派生重算只更新链、标题与摘要，不能恢复模型、费用或新上浮字段（`src/derive.ts:716`）。账本重复证据又会提前跳过（`src/reconcile.ts:431`、`:478`），重新投递同一文件不能保证执行新的映射。提案第 88、147 行的按会话重算需要扩展成明确的离线流程：先按已脱敏 payload 重映射 raw，再按既有证据 owner 重新收敛 request/route_summary，最后重跑 Agent 语义、链与工具关联。req_id、正文引用、费用观测、游标与墓碑都应保留，不能通过清空证据来触发重摄入。

raw 七天回收限制可修复范围。payload 尚在的字段可以恢复；raw 过期而长期摘要仍有的字段按摘要恢复；两者都没有的字段保持未知并报告不可恢复数量。已有错误备用值若继续保留，需标记其来源与旧口径，不能继续作为可信请求值参与统计。模型差异比例只是诊断，不能以比例非零或看起来合理作为验收；应以合成证据中确切的预期值、来源和请求守恒为准。账本 cost 对应客户端自报费用，不应覆盖现有用量 API 的定价结果。

### counted 需要保留证据存在性

magpie 的 `Prompt.Counted` 为 `bool` 且带 omitempty，true 表示用 vendor 总量校准；合法 Prompt 对象里缺省表示未校准（`internal/gateway/prompt.go:43` 至 `:53`）。ATC 用 optionalNumber 读布尔，true 会丢失。提案一面把缺键解释为本地估计，一面又称历史 NULL 无法回填，混淆了上游省略与 ATC 解析丢失。

建议只有在识别到合法的 Prompt 对象及 tokens 等必要结构时，将 true 映射为 1、false/省略映射为 0；Prompt 缺失、形状不受支持或字段类型非法时保持未知。仅有 route 证据位也不能证明 Prompt 完整。有可用 raw_route 的历史 NULL 可重新解释；没有证据的 NULL 不补 0。上下文比例沿用 magpie 的 prompt_tokens/prompt_window，说明总量是否校准，窗口未知或非正时不画比例；75%/90% 只是阅读提示，不证明 Agent 将在该阈值压缩。

### 统一字段集合不等于所有字段都放 request

两份方案宜共用一轮有可执行脚本的 schema 变更，但先定义字段归属与来源优先级。共同必要项包括长期保留来源 kind、用途分类依据和显式算法版本；将全部候选字段加入 request 并不是 classifier 的前置条件。来源原值与派生 req_kind 分开保存，ledger/route 的 kind 冲突按确定规则处理，并保留来源，不能采用最后到达者覆盖。

| 字段族 | 建议归属与语义 |
| --- | --- |
| req、native_session、客户端 tier_asked | 请求侧事实，缺失不借用实际模型或当前配置补齐；native_session 不替换现有 conv_key/actor |
| host、account、effort、tier_sent、tier_served、err | 可能随尝试变化。request 可保存最终选定尝试的摘要，但必须定义最终行、全部失败和 pending_final 的选择方式；其它尝试保留在尝试证据中，不用首个非空值拼出不存在的一次调用 |
| route.kind、folder、effort、error | 属于来源决策。是否加索引列由实际查询决定；不因上浮就同时复制进 request、显式列和压缩 JSON |
| kind、分类依据、算法版本 | 是字段保真与 Feature 的共同接点；上游报告与 ATC 解释分离，依赖变化后重新入队 |

schema 策略需准确引用[既有升级决策](../.agents/notes/implemented/architecture/2026-10-20-schema-v3-rejects-in-place-upgrade.md)：拒绝的是 openStore 启动时自动升级，既有 backfill 本身会显式补列并重算，且保住正文。第 92 行不能被解释成删库或只提升 user_version。联合变更需支持失败后续跑，并让未完成的迁移状态可见，避免结构版本已更新就被误认为全部回填完成。

route_summary.z 也不能被当成完整 raw_route 的压缩备份。`saveRouteSummary` 只压缩自己选择的 summary（`src/reconcile.ts:508`），其中有 error，但没有 kind、folder、effort 或 prompt；原始层过期后不能从 z 补出这些字段。已有 order/tries 等信息是否继续同时存显式列与 z，可以按读取成本评估，但不能拿解压 z 代替保存它从未包含的字段。容量估算应按每笔请求对应的路由/尝试数量及新增字节计算；既有每笔约 2 KB 的元数据估计不等于 route_summary 单行实测大小。

### 脱敏要覆盖结构化列与摘要

新提案只从脱敏 payload 取值的要求值得保留，但当前实现并非全部字段都遵守。账本先对 parsed 调用 mapLedgerRow，再仅给 payload_json 脱敏，结构化列仍使用此前 fields（`src/reconcile.ts:461` 至 `:476`）。mapper 从 providerAccount 提取 account（`src/sources/magpie.ts:162`），而隐私规则会将 payload 中的 providerAccount 替换成稳定占位符（`src/privacy.ts:9`、`:83`）。因此两条存储路径当前可能保存不同的隐私形态；直接把 raw_ledger.account 上浮会延续这个差异。

建议在建立新列之前统一提取与脱敏顺序，并明确 account 采用已有稳定占位符；旧结构化列应有相应修复范围及无法复核的处理。路由的 order/tries 也由脱敏前 route 对象写入 summary（`src/reconcile.ts:539`、`:556` 至 `:572`），展示 vendor 原话时需一起核对。已有 redact 会替换已知凭据模式，但不是对任意错误正文的完全匿名化；截断与 HTML 转义也不能代替脱敏。

[架构设计的安全约定](architecture-design.md#安全边界)规定账号、key ID 与 host 默认不经接口返回。把它们存入 request 不代表允许列表、搜索与复制功能自动带出。默认响应应保持最小字段集；若需要在本地详情展示，先明确新的字段披露约定及测试。该修订涉及统一采集路径，不能让 Profile 自行放宽规则。

### 页面纠错、阅读增强与新来源分别验收

| 提案项目 | 联合评估 |
| --- | --- |
| 六类 prompt part 映射 | 可先修。采用 magpie 的 system/tools/memory/files/results/chat，并保留未知 kind 的名称与有效备用颜色；只替换六个已知标签不能解决未来未知值 |
| part 分布的解释 | 第 17、68 行的前三类都未映射与所列数字矛盾：前三为 files、results、system，其中 files/system 已有映射。缺映射的是 results/chat/memory。沿用提案数字的算术约占 44.4%，不是本轮查询结果 |
| 分页方向 | 现有查询 ASC 加大于游标，序号也从最早请求开始。可以直接把更早文案纠正为更晚；首屏改为最近 N 笔是另一个阅读行为决策，无需阻塞纠错 |
| flags 与尝试链 | flags 恒空是读模型未供给结果；按失败、缺正文、待确认的确定聚合规则接通。尝试链复用已有结构，缺少时间证据就不补造重试间隔；未知 fail 码保留原值 |
| 上下文提示、滚动保持、复制 | 属于读取与交互增强，可以分别实施；不进入 Agent Feature，也不作为字段修复或 classifier 的前置条件 |
| 服务端全文搜索 | 第 102 行改变了[现行查询范围](architecture-design.md#查询接口)，应另立决策。先区分长期元数据/摘要搜索与仍保留正文的全文搜索，后者需索引预算、回收/删除同步、共享块到请求映射及未覆盖状态；一次 0 命中不能证明历史不存在 |
| direct | 同一 usage API 增加 direct 查询，仍是新增的观测与逻辑身份路径。来源标签或 session 不能充当逐调用唯一键；不参与当前统一迁移的必需范围 |

magpie 的 direct 来自本地会话调用的内存派生行（`internal/usage/direct.go:40`、`:55`）；这一点不能推导成来源不是会话文件。需纠正的是 direct 已写入 usage.jsonl 的说法，并明确 ATC 通过 magpie API 读取，不直接扫描 Agent 文件。`gatewayMatches` 要求 ID，或 native session、等 token、两秒窗口且双向唯一，歧义保留可见（`internal/usage/ledger.go:364`）。native_session 因而只是关联信号，不能保证防重；数组位置也不能证明跨扫描稳定身份。

建议 direct 维持另案。观测态若读入未配对数据，应与正式请求计数和费用汇总分开，避免不合并反而重复累计。另需区分 magpie Record.Via 的转手机器含义与 API 的 through/direct 来源筛选，避免因字段同名就复用 ATC 现有 via 判定。新增来源状态变化后的配对撤销、跨分页变化、重复扫描与重启恢复，都应在接入前有明确结果。

### 合并后的实施次序

1. 修正两份 proposed 方案的事实与范围，确定模型三种值、Prompt 完整性、字段归属和脱敏输出。保留本评审作为证据与建议，不把提案改写成已交付。
2. 先做无需新增列的来源读取、模型写入路径、part 未知兜底与分页文案纠错；历史回填另有报告，不以新数据正确代替旧数据已修复。
3. 对已确认需要长期保留的字段做一次结构变更，覆盖来源用途、分类依据/版本及确有消费者的字段；执行顺序为脱敏后重映射、收敛、语义/链重派生。按证据可用性报告恢复范围。
4. 迁入 title、增加 classifier 并贯通消费者；统一输入解释、技能提取与尝试链阅读分别推进。classifier 不等待 account 展示、全文搜索或 direct。
5. 按机器流量目标独立验收采集、派生与查询；direct、正文全文搜索及 Agent 专有指纹分别评审，避免把它们混进同一 schema 上线条件。

联合验收除既有分类用例外，应覆盖三种模型值各不相同与 req 缺失、客户端自报 cost 为 0、err 与 err_type 不同、合法 Prompt 的 true/false/省略及非法/缺失形状、多尝试切换端点/账号/档位、来源冲突和乱序、raw 过期、同物理证据重复到达、回填中断续跑。核对请求数、req_id、正文引用和费用观测保持一致；迁移再次执行结果应收敛。新提案不会完全取代现有 implemented 记录，本轮无需归档。

## 机器流量的容量工作

源码已显示下列随规模增长的工作量；本轮没有运行吞吐测试，无法声称它们已经导致超时。

| 路径 | 已核对的工作 | 建议的最小改进与验收 |
| --- | --- | --- |
| 派生队列 | `src/derive.ts:617` 只读取组键，`:622` 取整组请求；逐笔比较全部更早祖先，末尾重算链角色；队列的 `from_sort` 没有用于截断计算 | 先合并相同组的触发，限制单批实际工作量并让出事件循环；复用已解码数据。后续增量方案必须与完整重建结果一致 |
| 工具配对 | `src/derive.ts:789` 再遍历组内正文，删除并重建工具关联 | 验收新增辅助请求后不会把 transcript 内的历史工具结果当作当前请求的结果；排除规则与链策略一致 |
| 路由轮询 | `src/sources/files.ts:172` 读取、hash、解压并切分所有日期文件；`src/main.ts:130` 才检查 fingerprint 是否变化 | 首先把解压推迟到指纹确认变化以后；JSONL 的完整行增量和替换检测继续遵守既有证据身份规则 |
| hook 准入 | `src/http.ts:143` 在前一 envelope 尚未结束时直接返回 429；插件有界重试，`plugins/collector.hooks.ts:133` | 用合成并发和大 envelope 测量接受率、等待及处理耗时；保留内存上限。需要时引入有界调度，不默认增加无限队列或 spool |
| 其它周期工作 | 费用窗口完成后从 offset 0 重新扫描（`src/sources/magpie.ts:486`）；正文预算通过全表 SUM 估量（`src/retention.ts:19`） | 把费用重扫和预算扫描计入混合负载测试；测出占用后再选择缓存或增量账目 |

单次完整组重算的祖先候选对数为 `N(N-1)/2`。合成操作数计算中，2,000 笔请求对应 1,999,000 个候选对；共同前缀逐条比较还要乘以实际比较长度。这是循环结构的量级说明，不是耗时测量，也不能从中推出应当删除任意祖先匹配。需要保留正确性，再测增量和缓存的收益。

容量验收应同时运行采集、派生、轮询与查询，覆盖长会话、大正文、突发并发和未变化的历史目录，记录 hook 端到端延迟及 429/503 数、派生队列最老年龄、事件循环延迟和内存峰值。既有架构文档的单次存储回放不能替代完整运行路径的验收。先声明目标负载与延迟预算，再决定是否引入 worker；无需先更换 SQLite 或拆分进程。

## 建议的实施范围

完整迁移范围包括 title、harness 输入解释与技能清单提取三个现有语义组；auto mode classifier 与来源用途解释属于新增或补齐。第一轮先完成用途分类：静态注册表迁入 title、增加 classifier，贯通类别与链策略的消费者。输入解释和技能提取分别按上一节的独立操作推进，不强行成为 RequestKind。协议 Adapter 负责消息结构；通用派生负责前驱、链角色、备用标题与工具关联；查询和页面消费结果。避免为每个被识别出来的 Agent 创建空 Profile，也不复制 magpie 的 Agent 识别、配置改写和 provider 转换。

实施验收至少覆盖普通反例、Agent 不符、缺回复、正文回收、规则冲突、未知类别与未知角色、证据不同到达顺序、同证据集重复派生，以及已有标题和主链回归。分类器历史正文已回收时允许保留旧结果，但验收需区分保留与按新算法重新确认。

建议先修正算法版本语义并长期保留来源用途及分类依据，再迁入 title、增加分类器、贯通查询与页面。随后统一 harness 输入解释及消息级展示输出，再迁技能解析并组合协议工具清单；后两项分别验收，不作为 classifier 上线的前置条件。第一步的 schema 变化需要离线迁移和旧行处理，不能依赖现有重算计数推断版本。容量工作按目标负载独立推进，分类正确与吞吐提升分别报告；指纹归一另案评估。

这次评审只部分涉及 [Title Generator 决策](../.agents/notes/implemented/feature/2026-10-21-title-generator-and-main-chain.md) 和 [不可读请求保持中性决策](../.agents/notes/implemented/bug-fix/2026-10-21-unreadable-requests-stay-neutral.md)，不取代它们；源码尚未变更，无需归档。原提案保持 proposed，本文只记录评审意见，不能作为已交付行为引用。

## 来源与验证范围

ATC 源码基准为 `a9df065c92de5f986602be2a1b0fa402c328f14e`；评审时工作树已有 docs 索引修改、未跟踪的分类器研究与提案，本文以读到的提案内容为准，不将它们视为 HEAD 中的已提交文件。magpie 源码物证为 `开源源码@magpie-2374ffe`，固定 [yetone/magpie@2374ffe](https://github.com/yetone/magpie/tree/2374ffe161439b02a8e7f23b793461b39a635bf8)。它与既有研究采用同一基准，不能据此断言本机安装版已启用相同机制。

本文中的源码机制属于 `版本锁定`：针对特定客户端版本或特定源码快照逆向得到的实现事实，包括本地文件布局、落盘结构与源码控制流；任何版本发布都可能改变。修订建议属于 `推断`：从以上事实外推的解析或判定规则，不是事实；不稳定，仅供参考。分类器真实形状与频率仅引用 [auto mode 分类器研究](auto-mode-classifier-research.md) 声明的 `采集@2026-10-21-atc`，没有重新查询，不能外推到其它 Agent 或更长时间范围。

本轮执行了双信号误判的合成反例，以及建议请求门槛的三个合成断言。它们只验证文中逻辑，不代表生产实现、真实流量验收或吞吐测试。完整迁移评估另核对了现有前端合成用例，但没有运行这些用例。字段保真联合评审另用合成输入复现 mapLedgerRow 丢失 req/cost、mapRouteRow 丢失布尔 counted，以及 account 结构化列与脱敏 payload 的差异；检查通过表示复现当前缺陷，不表示已经修复。文档本地链接、源码引用行号范围及禁用引号检查通过，`git diff --check` 通过；Agent Note 检查通过。未执行全量测试、真实库重派生和线上负载测试。
