# Agent Note: 术语表命名与文档职责统一

Status: implemented

## Problem

本仓把运行词汇放在根 `CONTEXT.md`，定位级名词放在[项目概览](../../../../docs/project-overview.md#名词)，README 的六概念表又给出一套起步定义。读者需要先判断词汇属于哪一层，才能找到定义。CONTEXT 这个名字也无法直接说明文件只收术语，容易被用来存项目背景、架构摘要或任务上下文。

架构评估暴露了工具入口的分歧：本机 `improve-codebase-architecture` Skill 默认查找并更新 `GLOSSARY.md`，它调用的 `domain-modeling` Skill 却要求在 `CONTEXT.md` 维护词汇。本次评估因此需要额外解释没有 GLOSSARY.md 是否意味着缺文档；后续 Agent 若照各自模板写入，还可能生成两份词汇表。

排查后确认，这是本机副本落后于上游，而非两个 Skill 的长期约定冲突：`mattpocock/skills` 在 5beb35b（2026-10-19）已把整套 Skill 的默认文件名改成 `GLOSSARY.md`，`CONTEXT-FORMAT.md` 随之改名为 `GLOSSARY-FORMAT.md`；本机装的是 3cca18b（2026-09-04），升级被 skill 管理器的删除保护挡住。2026-10-27 已把 `domain-modeling` 重指到 5beb35b，两个 Skill 现在都以 `GLOSSARY.md` 为默认名。

## Decision

根词汇表是 [GLOSSARY.md](../../../../GLOSSARY.md)，中文标题为领域术语表。运行词条与请求、session、conv、trace 的正式定义都在这一份文件里。基础名词只迁定义：conv 的哈希输入待复核等研究 caveat 留在项目概览的已知边界，并链接研究文档，不进入只收定义的术语表。README 的六概念表保留为起步导读，表前指向 GLOSSARY.md 与 trace-format；它说明字段用途与阅读顺序，不裁定术语边界，正式定义归 GLOSSARY.md，字段形状归 trace-format。

GLOSSARY.md 负责术语的含义、适用范围、容易混淆的概念，以及中文称呼与代码标识符的对应关系。词条可以链接到实现和架构说明；字段全量清单、默认值、SQL、算法步骤、命令、设计理由与当前任务状态仍归各自文档。

继承旧 note 的词条准入：实际讨论、评审或场景推演暴露概念混淆时才补词条，不把所有字段、普通中文或临时缩写登记进去。原有词条不能借改名顺便改变含义；需要修正定义时，单列理由并核对代码与现行设计。[术语定义与实现核对](2026-10-27-glossary-definition-alignment.md)记录了身份与计数、OTLP 基础名词及实现细节归属的修正依据。

迁移后不保留旧文件、副本、软链或长期跳转。本仓不创建另一份 GLOSSARY.md、GLOSSARY-MAP.md 或按子目录分散的术语表。将来出现必须分别建模的业务范围时，再讨论是否拆分以及如何说明它们的关系。

### 各类文档按问题分工

[文档标准](../../../../docs/AGENTS.md)持有下列职责；本 note 记录采用这些安排的理由与代价。

| 文档 | 回答的问题 | 与术语和决策的关系 |
| --- | --- | --- |
| 根 AGENTS.md | Agent 开始工作时要遵守什么、去哪里找事实？ | 保留常备约束和入口，明确术语表与 Agent Note 的位置，不复述正文。 |
| README.md | 项目有什么用、适合谁、如何试跑和接入？ | 用术语介绍产品，起步表只做导读，定义链接到 GLOSSARY.md。 |
| GLOSSARY.md | 一个领域词指什么，与相近词如何区分？ | 持有正式定义，链接机制说明；不收实现方案与任务记录。 |
| docs/project-overview.md | 项目的定位、范围、记录单位与数据来源是什么？ | 保留定位叙述和必要例子，基础名词定义链接到术语表；研究 caveat 留在本文。 |
| docs/architecture-design.md | 系统如何组成，存储、算法与约束是什么？ | 持有现行设计和字段事实，引用领域定义；取舍理由链接到 note。 |
| docs/trace-format.md | 保存后的 trace 在读模型中长什么样？ | 保留数据形状说明，字段细节按架构文档查阅。 |
| docs/operations.md | 如何运行、维护、迁移与恢复？ | 持有可执行步骤、错误码和恢复条件。 |
| docs/acceptance.md | 在什么版本与条件下验证过什么？ | 保存带前提的验收结果，合成测试与真实流量分开。 |
| .agents/notes/ | 为什么作出这个决定，否决了什么，代价是什么？ | 继续使用 proposed、implemented、rejected 生命周期；不另建 docs/adr/。 |
| docs/AGENTS.md | 文档各自负责什么，如何编写和维护？ | 持有文档分层与写作规则，其他入口链接到这里。 |

本决策不重写整套文档。除术语归属和相应链接外，其他文档沿用既有分工。Agent Note 已承担 ADR 的决策记录职责，继续保留现有分类、生命周期、格式检查和归档封印，不另建 docs/adr/。

### 工具先发现项目约定

根 AGENTS.md 指向 GLOSSARY.md 和 Agent Note 规则，文档标准说明各自职责。Agent 或 Skill 先读取项目声明的入口，再使用自身的默认文件名；存在明确入口时，不因缺少 CONTEXT.md 或 docs/adr/ 自动创建第二份文件，也不把文件名差异报告为文档缺失。

两个 Skill 的默认名在 2026-10-27 对齐到 GLOSSARY.md：`domain-modeling` 从 3cca18b 重指到上游 5beb35b，`improve-codebase-architecture` 本就在该版本。升级由 skills-manager 执行，属于本仓之外的全局动作；本仓不保存全局 Skill 的副本，也不以本决策为由修改其他项目的文档。项目入口声明继续保留，用来约束将来再次落后的副本与仍按旧模板写入的 Agent。

### 与现有记录的关系

本决策部分取代[仓库词汇表与术语管辖权](2026-10-24-domain-glossary-and-ownership.md)：调整词汇表文件名，并将基础名词定义并入同一入口。它的根目录可达性、词条准入、字段事实归架构文档、词汇表不接门禁等决定继续适用。旧 note 保持活跃，与本记录互相链接。

旧 note 否决的是把词汇表放在 docs/glossary.md，理由是根目录更可达；这个理由不排斥根 GLOSSARY.md。旧记录中的路径和管辖范围已同步，并指向本记录说明新决定的依据，没有改写成相反的决策。

[可读性常备规则](2026-10-26-doc-readability-standing-rules.md)的同步另起句、术语准入与首次出现写明所指继续有效。[根 AGENTS.md 收敛](2026-10-25-agents-md-single-home.md)和 [README 与 trace 文档分层](2026-10-25-readme-product-intro-and-trace-format.md)已同步链接，不因本决策整体归档。

## Alternatives considered

**保留 CONTEXT.md，只让 Skill 遵循现有入口。** 迁移成本最低，项目入口声明确实能兜住读取。但上游 5beb35b 已把两个 Skill 的默认名统一到 GLOSSARY.md，保留 CONTEXT.md 等于让本仓长期依赖入口声明去对抗工具默认值，还要单独解决定义分两处的问题。落选。

**只升级 Skill，保留现有文档结构。** 能消除工具入口分歧，改动只在本机配置。但请求、session、conv、trace 的定义仍分在项目概览，文件名也没有说明它只收术语；本决策选择把名称与定义归属一起调整。落选。

**保留 CONTEXT.md，同时新增 GLOSSARY.md 或做软链。** 两个入口会继续让读者猜测各自职责；副本可能漂移，软链又增加跨工具与跨平台处理差异。根规则中的单一链接已经能承担发现职责。

**GLOSSARY.md 放术语，CONTEXT.md 改放项目背景与架构摘要。** 当前 README、项目概览和架构设计已有这些内容，没有一个明确缺失的问题需要新文件回答。保留这个名字会增加一层重复摘要。

**为迎合 Skill 同时迁移到 docs/adr/。** Agent Note 已有决策记录、生命周期和机械检查，迁移无法改善本次术语查找问题，还会扩大链接与归档处理范围。

**一次性重命名所有设计文档并重写正文。** 本轮证据支持术语入口和定义归属的调整，尚不足以支持全套重组。其余文档按已有职责维护，具体重复另行评审。

## Consequences

改名使旧报告、外部链接和本地书签失效；仓库内的活跃引用已一次性修复，父知识库核对后没有指向本仓术语表的链接。选择不保留旧路径的代价由本记录承接。

Skill 升级在本仓之外，版本可能再次落后或回退。项目入口声明能兜住日常读取，但不能阻止按旧模板写入的 Agent；升级被删除保护挡住时，本仓会停在文件叫 GLOSSARY.md、Skill 仍要求写 CONTEXT.md 的中间态，比不改名更容易产生第二份词汇表。后续变更前需要复查两个 Skill 的实际默认名。

工作区其他仓库仍以 CONTEXT.md 作为词汇表文件名，包括 ata、intent-memory、Durable-Agent 与生产级 Agent 工程理论。本决策只改本仓，不宣称这是工作区标准；其他仓库要各自决定是否跟随上游改名，或继续用项目入口声明维持现状。

合并基础名词时容易把定位描述、字段细节和术语定义一起搬走。迁移按每段回答的问题判断归属，项目概览保留阅读连贯性，研究 caveat 留在已知边界，没有借机改写当前领域模型。

README 六概念表保留为导读后，仍可能与术语表或 trace-format 的表述产生轻微重复。它只承担起步阅读，不复制边界裁定；出现不一致时以术语表与 trace-format 为准。

词汇表不接门禁，腐化靠评审与场景压测捕捉。与「一个事实一个家」的边界由职责分工与 GLOSSARY.md 的准入规则维持。

## Testing

`bun run verify:notes` 通过：Agent Note 格式、归档封印与本次改动带 note。`node scripts/verify-agent-note-format.mjs` 检查 103 篇全部符合。活跃文档的术语表入口均已指向 GLOSSARY.md；note 中残留的 CONTEXT.md 只出现在历史动机与工具默认名说明里。`skills-manager-cli skills show domain-modeling` 显示 source_revision 与 remote_revision 均为 5beb35b，`CONTEXT-FORMAT.md` 已由 `GLOSSARY-FORMAT.md` 取代。
