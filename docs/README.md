# agent-trace-collector 文档

这个目录存放 trace 工具的调研与设计文档。另有[可交互的界面原型](../prototypes/README.md)，用于比较阅读结构；采集与查询后端已实现，实现依据见[收敛型技术架构设计](architecture-design.md)。

## 索引

| 文档 | 内容 |
| --- | --- |
| [project-overview.md](project-overview.md) | 项目定位：按请求保存、按对话导航，右侧读Response参数；顶部注明版本/direct/实时trace三处旧约定，实施以架构与计划为准 |
| [magpie-integration-research.md](magpie-integration-research.md) | magpie 0.1.1294 的 Agent 识别、session 与 conv 两套会话标识、四条可接入面及原采集结果；新增研究补充了部分机制边界，见文首说明 |
| [magpie-mechanisms-research.md](magpie-mechanisms-research.md) | 模型、路由与上下文容量的真实控制流，现成 prompt 分解、classifier、缓存亲和性、尝试与账本、会话续写判定与语义指纹、插件形态及直接集成或借鉴的取舍 |
| [auto-mode-classifier-research.md](auto-mode-classifier-research.md) | Claude Code auto mode 分类器请求：两条拼接消息、`<block>` 判定、出现频率、页面折叠与派生错位；附未决的识别与呈现选项 |
| [atc-real-format-research.md](atc-real-format-research.md) | 真实库 v4 归档副本的形状普查：账本、路由、正文与语义层的键名、类型与计数，当前代码对上的键与未采用的读数，归档窗口外的 `conv` 对照与复核 SQL |
| [agent-request-kind-review.md](agent-request-kind-review.md) | Agent 语义与字段保真联合评审；附请求触发、派生排序与摘要依赖、版本消费者、来源完整性及合成反例 |
| [architecture-evolution-v2.md](architecture-evolution-v2.md) | 下一轮架构统筹提案：来源完整性、请求级触发、统一派生依赖、破坏式结构替换、阶段依赖与容量验收；具体证据见联合评审 |
| [architecture-design.md](architecture-design.md) | 收敛型架构设计：账本物理记录身份与增量读取协议、三路证据收敛、SQLite 表结构与正文状态、内容去重与语义指纹、乱序重算、查询接口、正文预算与总磁盘硬上限、版本与形状探针、访问控制、AVA 下线顺序与分步落地判据；文末附两轮评审的逐条对照 |
| [architecture-review.md](architecture-review.md) | 基于设计提交的落地前评审：账本身份、持久化与恢复、正文预算和回收、乱序派生、协议与费用来源、安全边界及合成验收条件；文末两轮结论已逐条落进设计文档 |
| [operations.md](operations.md) | 运维手册：维护命令与错误码、备份与恢复流程、维护锁、掉电边界、费用时钟冲突诊断、容量门槛、切换核对与 AVA 下线/回滚步骤 |
| [AGENTS.md](AGENTS.md) | 文档分层、写作规则与文风禁区；note 与架构文档的接缝 |
| [架构演进实施入口](superpowers/plans/2026-10-22-atc-evolution-implementation.md) | A—F 批次依赖、跨计划验收与执行导航；运行时尚未实施 |
| [同步派生正确性](superpowers/plans/2026-10-22-atc-derive-correctness.md) | 正文可比较性、统一顺序、当前工具关联、摘要与事务完成；含调用者迁移、故障恢复和历史对齐验收 |
| [来源与在线事实](superpowers/plans/2026-10-22-atc-source-projection.md) | 真实字段、统一隐私、owner 完整性、最终尝试及全部在线写入路径 |
| [长期事实与显式重建](superpowers/plans/2026-10-22-atc-durable-rebuild.md) | v5、请求与组修订、来源依据、保留状态、迁移续跑与盐恢复 |
| [请求用途](superpowers/plans/2026-10-22-atc-request-purpose.md) | 版本化解释、分类器强指纹、请求待处理、链参与和全部消费者 |
| [输入与能力阅读](superpowers/plans/2026-10-22-atc-input-capability-reading.md) | 服务端包装解释、消息覆盖、工具技能提取、尝试链与页面纠错 |
| [容量基线与收敛](superpowers/plans/2026-10-22-atc-capacity-convergence.md) | 隔离合成负载、固定原因观测、预算、路由解码优化与条件切片 |
| [首轮 Collector 实施总入口](superpowers/plans/2026-10-20-collector-implementation.md) | 首轮阶段依赖、共同接口、文件职责与验收；实际切换继续遵守 C3 授权要求 |
| [持久化与真实页面](superpowers/plans/2026-10-20-collector-foundation.md) | A1–A5：SQLite、文件代际与恢复、账本路由和费用、访问控制、真实分页页面 |
| [正文与关联派生](superpowers/plans/2026-10-20-collector-body.md) | B1–B5：脱敏内容库、协议适配、薄 hook、证据关联、乱序派生与正文阅读 |
| [保留恢复与切换](superpowers/plans/2026-10-20-collector-retention.md) | C1–C3：预算回收、暂停与补采、备份恢复、并行核对、AVA 切换与回滚 |

实施进度以计划里的复选框为准：A1–A5、B1–B5、C1 已完成；C2 与 C3 的脚本、测试与文档已完成，但 C3 里的真实并行观察、停 AVA 与回滚演练尚未执行，需要单独授权。页面的合成验收记录见[项目 README](../README.md)。

## 调研文档回答了什么

- magpie 如何把一笔请求归属到某个 Agent，这套归属有多可信，外部能不能读到它的 Agent 表。
- 同一段对话的请求靠什么聚在一起。答案是两套标识：客户端声明的 `session` 和 magpie 对首条用户消息做的哈希 `conv`，两者互斥且覆盖的 Agent 群体互补。
- 外部能调用的接口有哪些，各自的访问控制、分页上限、筛选语义。
- 正文、元数据、路由决策适合从哪些通道取得，通道之间靠什么字段连接，以及缺失、截断和关联歧义的边界。
- Claude Code auto mode 分类器请求长什么样、为什么会被页面当成普通对话、出现频率有多高。

## 尚未做的事

C3 的真实并行观察、停 AVA 与回滚演练尚未执行，需要单独授权。magpie 与现有 AVA 保持未修改。

下一轮实施从[架构演进实施入口](superpowers/plans/2026-10-22-atc-evolution-implementation.md)进入，按 A—F 子计划及其依赖执行；容量测量触发后才实施条件切片。[架构演进方案 v2](architecture-evolution-v2.md)维护目标约束，理由见[架构演进提案](../.agents/notes/proposed/architecture/2026-10-22-atc-architecture-evolution.md)。[Agent Profile 原提案](../.agents/notes/proposed/architecture/2026-10-22-agent-request-kind-registry.md)与[字段保真原提案](../.agents/notes/proposed/architecture/2026-10-22-magpie-parity-and-field-fidelity.md)保留为输入材料，具体事实修正见[联合评审](agent-request-kind-review.md#与字段保真方案的联合评估)，分类器形状证据见[auto mode 分类器研究](auto-mode-classifier-research.md)。

仍在等待确认的问题列在架构文档末尾：超大请求的回调为什么丢失、direct 是否还会新增、分级保留的切分点、推理正文是否入库、路由摘要是否保留 prompt 分解、多实例标识、长期元数据的实际成本、direct 的稳定身份、是否开启请求归档、`handed_on` 行会不会真出现。
