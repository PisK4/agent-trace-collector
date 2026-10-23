# AGENTS.md — 文档标准

本文件定义文档分层、写作规则与文风禁区。核心原则：一个事实只有一个家；别处链接过去。

## 分层：一个事实一个家

| 层 | 职责 | 不放什么 |
|---|---|---|
| 根 [AGENTS.md](../AGENTS.md) | 常备规则：每个会话都要在上下文里的规则，每条一到三行并链接出处 | 故事、案例、流程细节、从链接出处复述的内容 |
| [architecture-design.md](architecture-design.md) | 组成、证据身份、存储模型、派生、接口、容量与安全边界的设计权威 | 事故叙事、任务步骤、过期状态 |
| [project-overview.md](project-overview.md) | 项目定位、记录单位、数据来源与名词 | 实现细节、决策 rationale |
| [architecture-review.md](architecture-review.md)、[agent-request-kind-review.md](agent-request-kind-review.md) | 落地前评审记录与证据 | 现行行为的权威描述 |
| [architecture-evolution-v2.md](architecture-evolution-v2.md) | 本轮架构演进的目标约束与阶段划分：目标职责、依赖、阶段与容量验收；交付记录见实施入口 | 已交付行为、来源证据表的副本 |
| [magpie-integration-research.md](magpie-integration-research.md)、[magpie-mechanisms-research.md](magpie-mechanisms-research.md) | 对 magpie 机制的研究证据，带锚定版本与证据标签 | 本项目已交付行为的描述 |
| [auto-mode-classifier-research.md](auto-mode-classifier-research.md) | 对 Claude Code auto mode 分类器请求的研究证据，带采集时间与证据等级 | 本项目已交付行为的权威描述、UI 决策 |
| [atc-real-format-research.md](atc-real-format-research.md) | 对本机真实库归档的形状研究：键名、类型、计数与窗口对照，带证据等级 | 本项目已交付行为的权威描述、实现步骤 |
| [operations.md](operations.md) | 运维命令、错误码、备份恢复与 AVA 切换步骤 | 设计 rationale，链接到所属 note |
| [superpowers/plans/](superpowers/plans/) | 执行计划：步骤、复选框、验收清单 | 常备规则、已交付事实的权威 |
| [.agents/notes/](../.agents/notes/README.md) | 活跃决策记录：why、放弃了什么、必需的验证 | 迁移计划、验收清单、spec 腔 |
| [.agents/notes/archived/](../.agents/notes/archived/AGENTS.md) | 冻结的历史快照 | 现行权威 |
| [README.md](../README.md) | 当前状态、运行命令、验收记录 | 常备规则、设计 rationale |
| [../prototypes/README.md](../prototypes/README.md) | 原型目的与版式比较结论 | 生产契约 |

放置口诀：bug 进 postmortem；rationale 进 note；流程进 cookbook；包契约进 README；常备规则进根 AGENTS.md 加一行链接。

### note 与架构文档的接缝

note 的 `## Decision` 不复述 schema 字段、默认值、接口形状与表结构。这些事实以 [architecture-design.md](architecture-design.md) 为准；note 只记录为什么这样定、否决了哪些方案、代价是什么，并链接到对应章节。这样代码或设计变更时只需要改一个家，note 的同步负担落在引用是否还有效，而不是抄写是否及时。

## 写作规则

- **文档写现状，不写变更史。** 避免 previously、now、no longer、renamed；点名现行机制。变更史进 commit、note 或 postmortem。README 里的合成验收记录与「本轮修掉」属于待迁移的已知例外，迁移前不改写其中的事实。
- **每段一个物理行**（编辑器软换行）；代码块、表格、列表保持自身格式。
- **交叉引用一律相对 Markdown 链接**，拒绝裸文件名或 note 编号；链接检查器就绪后拒绝死链与死锚点。
- **注释与 JSDoc 写完整契约**：行为、失败、时机、所有权、后果、非显然的定位；删推理转写、代码复述、评审分析。
- **直接写，点名施动者与事实。** contract、boundary、shape、gate 这类词先过一遍：更精确的名词存在就用它。

## slop 清单

任何文档里都要猎杀：

- 同一条规则有多个家。grep 一句独特措辞；保留一个家，其余改链接。
- 叙述历史或战争故事：previously、now、no longer、used to、renamed、被移动过。写当前事实，需要时链接 note 或 postmortem。
- 实现状态标注（「已实现！」「future: …」）。状态会腐烂；仓库布局与清单文件才是承载。
- 手抄目录、JSDoc 或测试/模块/状态清单，而源码或生成器才是权威。
- 推理转写：逐步实现叙述、显然分支的证明、测试走读、被否决的本地备选。保留结果契约或耐久 rationale，删掉推导路径。
- rationale 重复出现在兄弟方法旁，而不是唯一的所属能力处。
- 段落墙：一段塞多条规则与括号插入语。拆开或下放到家。
- 强调通胀：到处加粗、大写、critically，等于没有重点。强调留给改变行为的那个从句。
- implemented note 里的 spec 腔：should、迁移计划、验收清单。implemented note 描述现在是什么。
