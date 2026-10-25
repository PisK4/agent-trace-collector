# Agent Note: Harness 语义的静态扩展

Status: proposed

## Problem

ATC 需要持续接入外部与自研 Harness。对已支持协议和证据通道而言，新增 Harness 的特殊用途、输入包装或技能声明，不应要求维护者在派生、查询和页面里分别理解同一条识别规则。扩展成本应取决于新增的语义，而非已有消费者数量。

现有基础已经解决了一部分问题：[用途解释与结算](../../implemented/architecture/2026-10-22-request-purpose-and-chain.md)分开，输入与能力由[服务端统一解释](../../implemented/feature/2026-10-22-server-side-input-interpretation.md)，页面消费结果。剩余问题是规则所有权：Claude 分类器与 OMP skill_hint 同住 [semantics.ts](../../../../src/semantics.ts)，包装与 OMP 归档规则同住 [input-interpretation.ts](../../../../src/input-interpretation.ts)，共享标签与 Claude 技能格式同住 [capabilities.ts](../../../../src/capabilities.ts)。新增规则仍直接改这些通用 implementation。

规则适用范围也不一致。用途识别检查 agent；输入解释使用全局标签集合；技能提取接收 agent，但不据此分派。2026-10-26 的内存合成探针中，`<file>synthetic user content</file>` 在 omp、claude、custom-harness 与空标签下均返回 injected、空展示文本，original 保留。它证明共享规则会影响不同客户端，不证明真实正文已损坏。未知 agent 解析共享格式是既有测试约定，不能在重构时顺手改掉。

[注册表提案](2026-10-22-agent-request-kind-registry.md#与现有记录的关系)把静态扩展推迟到第二种 Agent 专属类别出现。当前已有 Claude auto-mode-classifier 与 OMP skill_hint，触发条件成立。继续把每个新规则加入通用文件，会让这些文件承担越来越多的 Harness 知识；直接建设全能插件系统，又会把存储、身份、调度和页面的不同问题绑在一起。

## Proposal

先建立进程内、编译期登记的 Harness 语义 seam，供不同 adapter 提供专属解释。优先迁移已有用途判定，再整理输入与技能规则的归属；保持三种操作各自的执行时机。目标是增加 module 的 depth：调用者只需理解解释所需的证据与结果，专属指纹、适用范围和格式差异由 implementation 持有。

第一轮以行为保持为约束，不新增 Harness Feature，不改变持久化形状。已有能力的新表达应主要落在对应 adapter、静态登记和合成用例；全新领域事实仍可能需要显式扩展持久化、查询与页面，不承诺任意 Feature 都能只加文件。

### module 的职责

下表是各归属的职责边界。Review 已按 2026-10-26 的已提交源码核对：静态 seam 的收益不在现有调用者（它们本来就只见 `classifyPurpose` 一个入口），而在新增规则与理解单个 Harness 时的 locality；两个既有专属判定都 agent 门控、指纹自足，够格验证 seam。用途分派的最小形态据此定案，输入与技能的结论见[共享规则与专属规则](#共享规则与专属规则)。

| 归属 | 持有的知识 | 调用者不再承担的知识 |
| --- | --- | --- |
| 语义分派 module | 静态登记、已知标签选取、显式共享规则、稳定执行次序 | 每种 Harness 的专属名称与分派分支 |
| Harness adapter | 本 Harness 的强指纹、文本格式、识别依据；内部按用途、输入、技能分别实现 | 专属模板、标签及其解释细节 |
| 共享解释 implementation | 已证实跨 Harness 复用的格式和现有回退行为 | 各 adapter 复制通用清洗与缺失状态规则 |
| 请求用途结算 | 正文读取预算、CAS、重试、修订、持久化与显式升级 | 不向 adapter 暴露 Database、Store 或任意取数能力 |
| 输入与能力调用者 | 已读消息或 system 文本、覆盖状态、消息位置 | 不复制 adapter 的识别规则 |

语义规则可以按 Harness 集中组织，但不得为一个新标签建立只转发 generic 行为的空壳 adapter。用途、输入、技能不是互斥 Feature：一条请求可以同时有用途与输入解释，不能因用途命中就跳过另两种操作。

用途 adapter 只负责专属证据解释。来源 kind、标题兼容、不可读时保留旧结论、通用回退与最终版本策略继续有一个确定的归属，不散入每个 adapter。规则次序必须可从实现中直接确认，不依赖对象枚举、导入副作用或任意数字优先级。

定案的最小形态：分派 module 是 `src/harness/purpose.ts`，持有 `HarnessPurposeRule` 类型、静态登记数组与 `classifyPurpose` 编排；adapter 是各 Harness 一个的判定函数文件，agent 标签与判定的绑定只写在登记处，按登记次序选取，同 agent 多条规则时数组次序即优先级。semantics.ts 保持叶子：类型、`PURPOSE_VERSION`、视图字段提取、标题回复解析与通用判定（来源 kind、标题兼容、不可读保留）留在原处，导出给分派编排。`classifyPurpose` 移交分派 module 是依赖方向的要求——adapter 判定要写 `PURPOSE_VERSION` 这个值，编排留在 semantics.ts 会造出 semantics 与 harness 之间的运行时环；移走后方向单向（harness→semantics），结算方 request-purpose.ts 只改导入。agent 门控收进登记选取（标签不等直接跳过），判定函数不再自查 agent，结果信号里的 agent 证据保持原值。

### interface 的约束

沿用现有调用者能提供的已读取事实；先看 [PurposeView 与 classifyPurpose](../../../../src/semantics.ts)、[用途取数与结算](../../../../src/request-purpose.ts)、[消息解释](../../../../src/input-interpretation.ts)、[能力提取](../../../../src/capabilities.ts)及 [正文分页](../../../../src/protocols.ts)。不预建任意 Feature 生命周期，不把所有输入拼成一个巨大的上下文对象。

- agent 是上游标签，用于选择已知规则，不是身份凭证；未知标签与空标签沿用明确的共享回退，不根据正文猜客户端身份。
- adapter 不读数据库、文件或网络，不写派生列、不推进修订、不调度任务、不提供任意 HTML。
- 请求用途继续在请求结算时解释；输入按消息解释；技能按正文阅读覆盖状态解释。不得为统一组织而强制扫描完整历史或持久化技能描述。
- 识别依据与状态继续使用现有结果语义，包括 purpose_rule、signals、missing、unrecognized、unsupported、retained。规则搬迁不能把历史结果重新标成当前规则确认。
- 输入解释保留 original，不改变保存对象、块哈希与语义指纹。消息 ord、工具路径、原文还原仍由现有机制负责。

### 共享规则与专属规则

第一轮迁移前列清各规则当前的适用范围，随后按行为保持归位。Claude 分类器与 OMP skill_hint 已有明确 agent 门控，可直接作为两个真实 adapter 的验证对象；标题兼容、共享标签和未知 agent 回退保持既有语义。

某条规则的名称包含 OMP 或 Claude，不足以证明它应立即增加 agent 门控。OMP 归档识别目前存在无 agent 参数的调用路径，输入包装又对未知客户端通用；将其收紧属于行为变化。Review 需要明确其归属与依赖，但第一轮保留当前适用范围，必要时让共享实现复用单一纯解析器，不复制字符串。

后续收紧规则时，另列命中、同文异客户端、未知标签、用户引用与缺证据的反例；确定影响用途、标题、增量或上下文事件的哪一种结果，再按相应版本与重建机制交付。不能在目录重排中悄悄改变显示文本或主链参与。

Review 落到清单上：第一轮一条定义都不搬。输入包装、OMP 归档锚点与 Claude 技能标题格式留在 input-interpretation.ts 与 capabilities.ts。这些规则全部无 agent 门控——`<file>` 包装在 omp、claude、custom-harness 与空标签下同样命中，OMP 归档判定存在无 agent 参数的调用路径，技能标题按 system 文本匹配；消费方（finalize、派生的 omp_compaction 事件、extractSkills）无论定义放在哪个文件都得理解这条品牌语义，只改导入地址是空壳转发。等某条规则带上真实门控、反例与版本策略齐了，再随行为变化一起搬家。

### 实施分段

1. 核对最新源码与工作区，Review 本提案和旧记录的分工；确定每种解释的最小 interface，确认它减少了调用者知识。把 Review 修订写回本提案后再实现。
2. 迁移用途专属规则。以现有 Claude 分类器和 OMP skill_hint 验证静态 seam，保留来源 kind、标题、不可读状态、固定顺序及结算路径。不要把旧注册表提案里的类型和匹配门槛照搬进代码。
3. 整理输入与技能解释。保持外部结果和执行时机，集中共享格式与专属实现的归属，避免循环依赖和空壳转发。若某项没有减少调用者知识，说明理由并保留现状，不为目录整齐强拆。
4. 验证新增同类解释的 locality：用测试内的合成 adapter 走用途的窄测试 seam `classifyPurposeWithRules(rules, view)`（生产入口 `classifyPurpose` 即以静态登记调用它），证明规则可在登记处接入，通用分派和结算无需新增品牌分支；测试 adapter 不进入生产登记。已有黑盒行为回归继续穿过原有外部 interface。
5. 同步实际职责到架构文档及相关 note，按交付范围处理提案生命周期；只有已完成的决定转 implemented，未完成范围不得借状态转换宣称完成。

移动 implementation 且结果语义、选择次序、读取范围均未改变时，不因文件路径变化提升算法版本。若 Review 决定修改规则，则将行为变更与机械迁移分开说明，并遵循 [派生版本与状态](../../../../docs/architecture-design.md#派生算法版本)及 [显式会话重建](../../../../src/maintenance/rebuild.ts)；真实库重建不属于本提案编写或交接动作，需单独确定运行范围。schema 变化不在第一轮范围。

### Supersession 与既有决定

已在活动 note 树做 supersession check。本提案承接旧[Agent Profile 与请求类别注册表](2026-10-22-agent-request-kind-registry.md)的静态扩展主题，更新其触发条件判断并持有本轮 Review 与实现范围。旧提案保留问题材料及更广的待办，不整篇转 rejected；旧提案未修订的 interface、匹配门槛与迁移章节仍不作执行依据。两文互链，不另建中央索引。

[架构演进决定](../../implemented/architecture/2026-10-22-atc-architecture-evolution.md)关于三个独立语义操作、请求级触发和有界读取的决定继续有效；[用途解释](../../implemented/architecture/2026-10-22-request-purpose-and-chain.md)与[服务端输入解释](../../implemented/feature/2026-10-22-server-side-input-interpretation.md)的行为约束不被取代。本提案处于 proposed，当前架构权威不提前改写；实施时依据实际交付同步路径和职责，并对真正改变的决定重新做 supersession check。

[ZCode 支持](../feature/2026-10-24-zcode-agent-support.md)仍是独立 Feature 提案，不作为第一轮架构迁移必须实现的内容。[OTLP 接收端](../feature/2026-10-25-otlp-receiver.md)持有新证据通道的范围，不纳入 Harness 语义 adapter。评估时工作区已有其他工作的 OTLP 文件，实施前必须重新确认并行状态。

### 后续独立工作

工具身份与参数语义值得另立范围：当前别名知识分散于 [派生参数提取](../../../../src/derive/decision.ts)、[会话汇总](../../../../src/queries/session-summary.ts)、[步骤摘要](../../../../web/trace-view.js)和 [工具色类](../../../../web/body-view.js)。可以在本轮 seam 确认后评审怎样共享语义，但不能借此统一不同页面的长度预算，既有[回复拆分决定](../../implemented/architecture/2026-10-25-reply-single-protocol-split.md)继续有效。

正文协议和证据来源分别回答 wire shape 与证据身份问题，不由 Harness adapter 接管。新背景作业或压缩机制还可能需要独立的跨请求结算 module；有第二种真实生命周期后再比较，不提前承诺同一事件模型适用于全部 Harness。

## Alternatives considered

**继续在通用文件里加分支。** 单条规则改动最短，但第二个专属类别已出现，规则适用范围也已有差异。继续推进会扩大理解一个 Harness 所需的位置，不利于 locality。

**直接落地旧注册表提案的全部设计。** 旧方案包含与当前用途结算不同的类型、优先级、证据列和升级假设；部分行为已由现有机制交付。直接照搬会重复持久化或削弱判定，故只承接其静态 seam 动机。

**一个 RequestKind 处理全部 Feature。** 用途、输入和技能可以同时成立，互斥匹配会遮蔽其他解释；各自读取预算与时机也不同。保留独立操作，按 Harness 组织 implementation 即可。

**只搬目录并保留逐层转发。** 文件位置改变，调用者仍知道专属规则，增加的 module 会是 shallow。deletion test 要求删除新 module 后，专属复杂度会回到多个调用者；如果删除只减少一次转发，该拆分没有提供 depth。

**把所有识别搬到摄入或页面。** 摄入时证据和归属可能未齐；页面没有用途结算与历史版本的所有权。两者都会破坏既有解释与结算分工，或让消费者各自判断。

**立即收紧所有共享包装为 agent 专属。** 会改变未知标签及共享格式的既有行为。先保持行为并明确归属，收紧另以反例和版本策略验证。

**建设动态插件加载器或全能 Feature interface。** 当前需求是本仓库内持续添加适配，不需要第三方代码执行、热加载、插件市场或任意写库能力；扩大 interface 会降低 depth，同时增加部署与失败模式。

## Acceptance criteria

- 现有 Claude 分类器与 OMP skill_hint 通过静态 adapter seam 执行；新增同类专属判定不要求通用分派或结算增加 Harness 名称分支。共享回退与次序有唯一归属。
- 用途、输入、技能保留独立执行时机；adapter 不访问 Database、Store、网络或文件，也不改变调度与单 writer 约定。不得只为未知标签新增空壳 adapter。
- 现有结果保持一致：用途状态、kind、chain、rule、signals、modelTitle；输入 state、kind、text、original、removed；技能内容、格式、去重及覆盖状态。补充调用链断言验证派生与正文阅读消费一致解释，不只测试孤立 matcher。
- 合成用例覆盖正确匹配、错误 agent、空与未知标签、未闭合包装、用户引用、部分或不可读正文、retained，以及多种解释同时存在。规则收紧若超出第一轮则明确延期，不用改测试期望掩盖行为变化。
- 保留 CAS stale、三次失败终态、普通 tick 不升级历史、显式重建和回收后保留旧版本的回归；不引入全消息解压、重复解析或逐规则查询。读取范围变化必须说明实际成本。
- 每段实施只运行能覆盖相应回归的窄测试；涉及调用与类型变化运行 typecheck。按改动选择输入、能力、semantics、request-purpose、protocols、派生及正文阅读测试，避免仅以纯函数通过替代完整调用者验证。
- 提交前执行 verify:notes；架构权威、相关 note 与实际路径同步。没有行为变化不升版、不开历史重建；有行为变化明确版本、重算与无法重算时的保留行为。真实流量验收与合成测试分开报告。

## Risks

**注册表转移了复杂度却没有减少知识。** 任意优先级、复杂配置和多级转发会让调用 interface 比原先更难理解。Review 以两个现有 adapter 和调用者为依据，不按目录或文件数量验收。

**共享格式的适用范围被误改。** agent 名称只是上游标签；共享工具或自研 Harness 可能复用现有格式。第一轮固定回归结果，不把品牌名称当作独占格式的证据。

**规则与数据版本脱节。** 名称或路径移动无需重算，但匹配、顺序、证据读取变化可能影响历史结果。implementation 版本变化不能冒充历史结论已更新，也不能把 retained 行标成新算法确认。

**为了统一解释扩大读取成本。** 某条规则只需要块首，其他规则只需要 system；大上下文对象或懒加载回调可能绕过现有预算。读取由调用者持有，adapter 只消费所需事实。

**范围膨胀。** 工具语义、OTLP、ZCode 新规则和背景作业修复各有实际价值，但一起落地会失去行为保持的对照。第一轮范围之外的发现交回其所属提案或独立修复。

**并行开发使基线失效。** 本提案的源码审查以 2026-10-26 当时的已提交实现为准，未评审同时出现的 OTLP 未提交文件。下一位 Agent 必须先检查 git 状态与相关调用者变化，不能覆盖或纳入其他工作的文件。
