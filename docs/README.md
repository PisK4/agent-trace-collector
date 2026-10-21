# agent-trace-collector 文档

这个目录存放 trace 工具的调研与设计文档。另有[可交互的界面原型](../prototypes/README.md)，用于比较阅读结构；采集与查询后端尚未实现，实现依据见[收敛型技术架构设计](architecture-design.md)。

## 索引

| 文档 | 内容 |
| --- | --- |
| [project-overview.md](project-overview.md) | 项目定位：按请求保存、按对话导航，右侧读Response参数；顶部注明版本/direct/实时trace三处旧约定，实施以架构与计划为准 |
| [magpie-integration-research.md](magpie-integration-research.md) | magpie 0.1.1294 的 Agent 识别、session 与 conv 两套会话标识、四条可接入面及原采集结果；新增研究补充了部分机制边界，见文首说明 |
| [magpie-mechanisms-research.md](magpie-mechanisms-research.md) | 模型、路由与上下文容量的真实控制流，现成 prompt 分解、classifier、缓存亲和性、尝试与账本、插件形态及直接集成或借鉴的取舍 |
| [architecture-design.md](architecture-design.md) | 收敛型架构设计：账本物理记录身份与增量读取协议、三路证据收敛、SQLite 表结构与正文状态、内容去重与乱序重算、查询接口、正文预算与总磁盘硬上限、版本与形状探针、访问控制、AVA 下线顺序与分步落地判据；文末附两轮评审的逐条对照 |
| [architecture-review.md](architecture-review.md) | 基于设计提交的落地前评审：账本身份、持久化与恢复、正文预算和回收、乱序派生、协议与费用来源、安全边界及合成验收条件；文末两轮结论已逐条落进设计文档 |
| [operations.md](operations.md) | 运维手册：维护命令与错误码、备份与恢复流程、维护锁、掉电边界、费用时钟冲突诊断、容量门槛 |
| [实施总入口](superpowers/plans/2026-10-20-collector-implementation.md) | 阶段依赖、共同接口、文件职责、架构矛盾的实施修正建议与验收对照；从这里开始执行 |
| [持久化与真实页面](superpowers/plans/2026-10-20-collector-foundation.md) | A1–A5：SQLite、文件代际与恢复、账本路由和费用、访问控制、真实分页页面 |
| [正文与关联派生](superpowers/plans/2026-10-20-collector-body.md) | B1–B5：脱敏内容库、协议适配、薄 hook、证据关联、乱序派生与正文阅读 |
| [保留恢复与切换](superpowers/plans/2026-10-20-collector-retention.md) | C1–C3：预算回收、暂停与补采、备份恢复、并行核对、AVA 切换与回滚 |

实施进度以计划里的复选框为准：A1–A5 已完成（存储、文件代际与恢复、账本路由与费用同步、访问控制、接真实分页数据的页面），B1–B5 与 C1 已完成，C2 完成实现与文档，C3 尚未开始。页面的合成验收记录见[项目 README](../README.md)。

## 调研文档回答了什么

- magpie 如何把一笔请求归属到某个 Agent，这套归属有多可信，外部能不能读到它的 Agent 表。
- 同一段对话的请求靠什么聚在一起。答案是两套标识：客户端声明的 `session` 和 magpie 对首条用户消息做的哈希 `conv`，两者互斥且覆盖的 Agent 群体互补。
- 外部能调用的接口有哪些，各自的访问控制、分页上限、筛选语义。
- 正文、元数据、路由决策适合从哪些通道取得，通道之间靠什么字段连接，以及缺失、截断和关联歧义的边界。

## 尚未做的事

当前有研究与定位文档、收敛型架构设计、分阶段实施计划，以及采用合成数据的界面原型，尚无生产实现。实施计划从持久化验证开始，按任务列出文件、接口、测试和验收；其中新增的契约修正仍是工程建议，不表示已上线或已通过验收。magpie 与现有 AVA 保持未修改。

架构已给定一个持久化验证阶段加四步落地顺序，第一步（只读账本与路由、出真实数据页面）不依赖 hook，可以先做。仍在等待确认的问题列在架构文档末尾：超大请求的回调为什么丢失、direct 是否还会新增、分级保留的切分点、推理正文是否入库、路由摘要是否保留 prompt 分解、多实例标识、长期元数据的实际成本、direct 的稳定身份、是否开启请求归档、`handed_on` 行会不会真出现。
