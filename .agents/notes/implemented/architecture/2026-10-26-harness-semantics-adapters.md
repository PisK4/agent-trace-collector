# Agent Note: Harness 语义的静态扩展

Status: implemented

## Problem

ATC 需要持续接入外部与自研 Harness。对已支持协议和证据通道而言，新增 Harness 的特殊用途、输入包装或技能声明，不应要求维护者在派生、查询和页面里分别理解同一条识别规则。扩展成本应取决于新增的语义，而非已有消费者数量。

现有基础已经解决了一部分问题：[用途解释与结算](2026-10-22-request-purpose-and-chain.md)分开，输入与能力由[服务端统一解释](../feature/2026-10-22-server-side-input-interpretation.md)，页面消费结果。动手前剩余的问题是规则所有权：Claude 分类器与 OMP skill_hint 同住 [semantics.ts](../../../../src/semantics.ts)，包装与 OMP 归档规则同住 [input-interpretation.ts](../../../../src/input-interpretation.ts)，共享标签与 Claude 技能格式同住 [capabilities.ts](../../../../src/capabilities.ts)。每条新规则都要直接改这些通用 implementation。

规则适用范围也不一致。用途识别检查 agent；输入解释使用全局标签集合；技能提取接收 agent，但不据此分派。2026-10-26 的内存合成探针中，`<file>synthetic user content</file>` 在 omp、claude、custom-harness 与空标签下均返回 injected、空展示文本，original 保留。它证明共享规则会影响不同客户端，不证明真实正文已损坏。未知 agent 解析共享格式是既有测试约定，不能在重构时顺手改掉。

[注册表提案](../../proposed/architecture/2026-10-22-agent-request-kind-registry.md#与现有记录的关系)把静态扩展推迟到第二种 Agent 专属类别出现。当时 Claude auto-mode-classifier 与 OMP skill_hint 已经在场，触发条件成立。继续把每个新规则加入通用文件，会让这些文件承担越来越多的 Harness 知识；直接建设全能插件系统，又会把存储、身份、调度和页面的不同问题绑在一起。

## Decision

用途的专属判定走进程内、编译期登记的静态 seam：登记与编排在 [harness/purpose](../../../../src/harness/purpose.ts)，每条登记项绑定一个已知 agent 标签与一个判定函数，同 agent 多条规则按登记次序取胜；Claude 分类器与 OMP skill_hint 分别住在 [harness/claude](../../../../src/harness/claude.ts) 与 [harness/omp](../../../../src/harness/omp.ts)。agent 标签的选取收进登记处（标签不等直接跳过），判定函数不自查标签，结果信号里的 agent 证据保持原值。新增同类专属判定只加一个 adapter 文件与一行登记，通用分派与结算不出现品牌分支；次序与指纹判据见[架构设计的用途阶段](../../../../docs/architecture-design.md#两个粒度请求用途先于组结果)。

[semantics.ts](../../../../src/semantics.ts) 保持叶子：类型、`PURPOSE_VERSION`、视图字段提取、标题回复解析与通用判定（来源 kind、标题兼容、不可读保留）留在原处，导出给分派编排。`classifyPurpose` 随编排移入分派 module 是依赖方向的要求——adapter 判定要写 `PURPOSE_VERSION` 这个值，编排留在 semantics.ts 会造出 semantics 与 harness 之间的运行时环；移走后方向单向（harness→semantics），结算方与测试只改导入。

各归属的职责边界如下，adapter 与调用者互不承担对方的知识：

| 归属 | 持有的知识 | 调用者不再承担的知识 |
| --- | --- | --- |
| 语义分派（[harness/purpose](../../../../src/harness/purpose.ts)） | 静态登记、已知标签选取、显式共享规则、稳定执行次序 | 每种 Harness 的专属名称与分派分支 |
| Harness adapter（[claude](../../../../src/harness/claude.ts)、[omp](../../../../src/harness/omp.ts)） | 本 Harness 的强指纹与识别依据 | 专属模板、标签及其解释细节 |
| 共享解释 implementation（[semantics](../../../../src/semantics.ts) 等） | 已证实跨 Harness 复用的格式和现有回退行为 | 各 adapter 复制通用清洗与缺失状态规则 |
| 请求用途结算（[request-purpose](../../../../src/request-purpose.ts)） | 正文读取预算、CAS、重试、修订、持久化与显式升级 | 不向 adapter 暴露 Database、Store 或任意取数能力 |
| 输入与能力调用者（turns、derive/read、protocols） | 已读消息或 system 文本、覆盖状态、消息位置 | 不复制 adapter 的识别规则 |

adapter 不读数据库、文件或网络，不写派生列、不推进修订、不调度任务；读取由调用者持有，adapter 只消费视图里的事实。agent 是上游标签不是身份凭证，未知与空标签不命中任何登记项，沿用共享回退，不根据正文猜客户端身份。识别依据与状态沿用现有结果语义（purpose_rule、signals、missing、unrecognized、unsupported、retained）；规则搬家不把历史结果重新标成当前规则确认，`retained` 行说明的是它当时按哪一版算出来的。

行为保持是本次交付的硬约束：判定结果、信号、状态与结算路径全部不变，纯移动不升 `PURPOSE_VERSION`、不触发历史重建。`classifyPurposeWithRules(rules, view)` 是窄测试 seam，生产入口 `classifyPurpose` 即以静态登记调用它；[harness-purpose 测试](../../../../tests/harness-purpose.test.ts)用它登记合成 adapter，证明登记次序即优先级、合成规则只命中自家标签、弃权落回通用判定、生产登记对测试规则封闭。

### 输入与技能的归属决定

输入包装、OMP 归档锚点与 Claude 技能标题格式的定义留在 [input-interpretation](../../../../src/input-interpretation.ts) 与 [capabilities](../../../../src/capabilities.ts)。这些规则全部无 agent 门控——`<file>` 包装在 omp、claude、custom-harness 与空标签下同样命中，OMP 归档判定存在无 agent 参数的调用路径，技能标题按 system 文本匹配；消费方（finalize、派生的 omp_compaction 事件、extractSkills）无论定义放在哪个文件都得理解这条品牌语义，只改导入地址是空壳转发。等某条规则带上真实门控再随行为变化搬家：届时另列命中、同文异客户端、未知标签、用户引用与缺证据的反例，确定影响用途、标题、增量或上下文事件的哪一种结果，按相应版本与重建机制交付，不在目录重排中悄悄改变显示文本或主链参与。

用途、输入、技能保持三个独立操作：请求用途在请求结算时解释，输入按消息解释，技能按正文阅读覆盖状态解释；一条请求可以同时有用途与输入解释，不能因用途命中就跳过另两种操作。输入解释保留 original，不改保存对象、块哈希与语义指纹。

### Supersession 与既有决定

已在活动 note 树做 supersession check。本记录承接旧[Agent Profile 与请求类别注册表](../../proposed/architecture/2026-10-22-agent-request-kind-registry.md)的静态扩展主题，持有本轮 Review 与实现范围。旧提案保留问题材料及更广的待办，不整篇转 rejected；其未修订的 interface、匹配门槛与迁移章节不作执行依据。两文互链，不另建中央索引。

[架构演进决定](2026-10-22-atc-architecture-evolution.md)关于三个独立语义操作、请求级触发和有界读取的决定继续有效；[用途解释](2026-10-22-request-purpose-and-chain.md)与[服务端输入解释](../feature/2026-10-22-server-side-input-interpretation.md)的行为约束不被取代。架构设计的用途阶段描述已随本次交付同步，没有决定被取代，未触发新的 supersession。

[ZCode 支持](../../proposed/feature/2026-10-24-zcode-agent-support.md)仍是独立 Feature 提案，[OTLP 接收端](../../proposed/feature/2026-10-25-otlp-receiver.md)持有新证据通道的范围，都不由 Harness 语义 adapter 承载。

## Alternatives considered

**继续在通用文件里加分支。** 单条规则改动最短，但第二个专属类别已出现，规则适用范围也已有差异。继续推进会扩大理解一个 Harness 所需的位置，不利于 locality。

**直接落地旧注册表提案的全部设计。** 旧方案包含与当前用途结算不同的类型、优先级、证据列和升级假设；部分行为已由现有机制交付。直接照搬会重复持久化或削弱判定，故只承接其静态 seam 动机。

**一个 RequestKind 处理全部 Feature。** 用途、输入和技能可以同时成立，互斥匹配会遮蔽其他解释；各自读取预算与时机也不同。保留独立操作，按 Harness 组织 implementation 即可。

**只搬目录并保留逐层转发。** 文件位置改变，调用者仍知道专属规则，增加的 module 会是 shallow。deletion test 要求删除新 module 后，专属复杂度会回到多个调用者；如果删除只减少一次转发，该拆分没有提供 depth。

**把所有识别搬到摄入或页面。** 摄入时证据和归属可能未齐；页面没有用途结算与历史版本的所有权。两者都会破坏既有解释与结算分工，或让消费者各自判断。

**立即收紧所有共享包装为 agent 专属。** 会改变未知标签及共享格式的既有行为。先保持行为并明确归属，收紧另以反例和版本策略验证。

**建设动态插件加载器或全能 Feature interface。** 当前需求是本仓库内持续添加适配，不需要第三方代码执行、热加载、插件市场或任意写库能力；扩大 interface 会降低 depth，同时增加部署与失败模式。

## Consequences

理解一个 Harness 的指纹知识同址，扩展成本从改共享文件变成加文件加一行登记；代价是 seam 目前只覆盖用途专属判定，输入与技能的专属格式仍住共享文件，`classifyPurpose` 的导入方随编排搬家换了路径。

规则与数据版本脱节的风险由行为保持约束住：本次纯移动不升 `PURPOSE_VERSION`、不开历史重建；后续若经此 seam 修改规则语义，行为变更与机械迁移分开说明，并遵循[派生版本与状态](../../../../docs/architecture-design.md#派生算法版本)及显式会话重建，真实库重建单独确定运行范围。

工具身份与参数语义另立范围：别名知识今天分散于[派生参数提取](../../../../src/derive/decision.ts)、[会话汇总](../../../../src/queries/session-summary.ts)、[步骤摘要](../../../../web/trace-view.js)和[工具色类](../../../../web/body-view.js)，seam 确认后可评审怎样共享语义，但不借此统一不同页面的长度预算；[回复拆分决定](2026-10-25-reply-single-protocol-split.md)继续有效。正文协议与证据来源分别回答 wire shape 与证据身份问题，不由 Harness adapter 接管。

## Testing

[semantics 测试](../../../../tests/semantics.test.ts)穿过 `classifyPurpose` 外部 interface 的黑盒回归保持原断言：分类器优先级、标题形状、来源 kind、retained 与 unsupported 路径未动。[harness-purpose 测试](../../../../tests/harness-purpose.test.ts)锁登记次序即优先级、合成规则只命中自家标签、弃权落回通用判定、生产登记只含已知品牌。[request-purpose 测试](../../../../tests/request-purpose.test.ts)锁 CAS stale、三次失败终态与升级路径。交付时窄测试 30 通过、`tsc --noEmit` 通过；无行为变化，未做真实流量重验，真实库也未重建。
