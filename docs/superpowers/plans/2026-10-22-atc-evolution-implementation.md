# ATC 架构演进实施总入口

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 执行技能以执行会话的可用列表为准；缺少上述技能时，按任务完成相同的测试、复核与检查，不虚构调用。本文是分批交付导航，只有已链接的详细计划属于可执行任务。

**Goal:** 分批修正 ATC 的来源事实、派生正确性和请求语义，并通过合成实验决定容量优化。

**Architecture:** 沿用单进程、SQLite 单 writer 与独立只读查询，加深来源投影、请求语义和派生执行三个 Module。A—F 全部详细计划完成并通过跨计划自审后才交接实施；执行时先得到确定且可恢复的同步完整重建，再交付长期信息迁移与语义规则。容量基线可并行建立，条件切片的契约与步骤预先写明，只有测量触发后实施。

**Tech Stack:** TypeScript、Bun 1.4.0、`bun:sqlite`、`node:zlib`、原生 JavaScript；不增加第三方运行依赖。

**Spec:** [架构演进方案 v2](../../architecture-evolution-v2.md)定义目标，[联合评审](../../agent-request-kind-review.md#执行与恢复补充评审)保存证据，[现行架构](../../architecture-design.md)约束当前实现。决策理由见[所属提案](../../../.agents/notes/proposed/architecture/2026-10-22-atc-architecture-evolution.md)。

## Global Constraints

- 单进程 TypeScript + Bun、SQLite WAL 与单 writer、独立只读连接、原生 JavaScript 页面、不增加第三方运行依赖。
- 监听地址写死 `127.0.0.1`，不读环境变量覆盖；数据目录在仓库外，文件权限 0600、目录 0700。
- 测试只用合成数据；真实请求正文、账号、令牌和用户配置不进 fixture、日志或提交。
- 正文与路由内容在页面一律转义，不直接插 HTML。
- writer 只允许同步事务，yield 必须在事务外。
- 不删除 request_evidence 绕过幂等保护；不删库、删正文或清空不可重算结果完成迁移。
- `.agents/notes/archived/` 冻结；本轮计划不改变 implemented 决策的生命周期。
- 本轮不执行真实库回填、服务切换或外部发布。计划中的提交步骤只在执行会话获得提交授权后执行；没有授权时保留可审阅工作区。

---

## 基准与适用范围

全套子计划以 ATC `00e20a2` 为文档基准，A 最初定位沿用 `b58aee8`，这些提交的运行时代码与 `a9df065` 相同。执行前核对 HEAD、工作区与相关文件；已有后续运行时变更时先校正任务中的定位和调用关系。所有命令在 ATC 仓库根执行，不在父知识库运行；相对路径均相对于 ATC。

[首轮 Collector 计划](2026-10-20-collector-implementation.md)保留首轮交付与 C3 的实际切换约束。本入口管理架构演进工作，不续用首轮计划中的批量或排序文字作为本轮实现指令。现行架构与代码的差异由详细任务明确修复；文档基准检查不等于运行验收。

全套规划包含 A—F 六份详细计划，实施交接前逐项核对文件、Interface、迁移、失败断言与验收覆盖；下表不代替各子计划。容量结果依实际测量取得，计划提前定义条件分支与退出条件，不预填测量结论。

## 文件职责

| 文件 | 职责 | 本次是否改动运行时 |
| --- | --- | --- |
| 本文件 | 依赖、交付范围、跨计划验收与计划覆盖 | 否 |
| [同步派生正确性计划](2026-10-22-atc-derive-correctness.md) | 正文可比较性、统一逻辑排序、当前工具关联、摘要、事务完成及历史对齐验收 | 否，仅编写计划 |
| [来源与在线事实](2026-10-22-atc-source-projection.md) | 真实字段与形状状态、统一隐私、owner 完整性、保守最终尝试及全部在线写入路径 | 否，仅编写计划 |
| [长期事实与显式重建](2026-10-22-atc-durable-rebuild.md) | v5 结构、请求与组修订、有界来源事实、同快照读模型、盐绑定、可续跑迁移 | 否，仅编写计划 |
| [请求用途](2026-10-22-atc-request-purpose.md) | 版本化解释、分类器强指纹、单笔 CAS、组延后发布及全部用途消费者 | 否，仅编写计划 |
| [输入与能力阅读](2026-10-22-atc-input-capability-reading.md) | 服务端包装解释、消息覆盖、工具与技能提取、尝试链、分页与页面纠错 | 否，仅编写计划 |
| [容量基线与收敛](2026-10-22-atc-capacity-convergence.md) | 隔离合成负载、固定原因观测、预算门槛、路由解码优化与条件 v6 切片 | 否，仅编写计划 |
| [v2](../../architecture-evolution-v2.md) | 目标职责、迁移与容量验收的唯一提案定义 | 否 |
| [联合评审](../../agent-request-kind-review.md) | 已有反例与验证范围，不复制到独立证据文件 | 否 |
| [现行架构](../../architecture-design.md)、[运维](../../operations.md) | 对应代码交付时同步现状和命令 | 本次不修改 |
| [proposed note](../../../.agents/notes/proposed/architecture/2026-10-22-atc-architecture-evolution.md) | 统筹与分批推进的理由，不复制任务步骤 | 否 |

## 交付依赖

| 批次 | 可独立验收的结果 | 进入条件及覆盖 |
| --- | --- | --- |
| A：同步派生正确性 | 一个同步组任务提交链、角色、工具和摘要，失败保留任务；相同证据反复重建一致 | [详细计划](2026-10-22-atc-derive-correctness.md)；覆盖对应 0a 与阶段 2 可提前交付的同步修复 |
| B：来源与在线事实 | 对应字段在全部写入路径上解释一致，统一隐私形态 | [来源投影详细计划](2026-10-22-atc-source-projection.md)；先固定本项 0a，B 无新列纠错可独立交付；长期字段由 C 扩展同一投影 |
| C：长期信息与显式重建 | 来源依据、请求修订、保留状态、版本报告及盐恢复可解释；在线原始行与迁移行写同一组来源版本常量；合成旧库迁移可续跑 | [长期事实与显式重建](2026-10-22-atc-durable-rebuild.md)；依赖 A/B，冻结 v5 schema、启动拒绝、迁移和恢复契约 |
| D：请求用途 | actor 未定仍能判定，title/classifier 的链参与与读模型一致 | [请求用途详细计划](2026-10-22-atc-request-purpose.md)；依赖 C 请求状态，替换兼容用途版本，不增加竞争写入者 |
| E：输入与能力阅读 | 服务端统一包装解释和技能提取，原文与覆盖状态可读 | [输入与能力阅读](2026-10-22-atc-input-capability-reading.md)；按实际消费者依赖 C/D，不改 block.fingerprint |
| F：容量基线与收敛 | 可重复负载、资源与排空报告；测量触发已定义的优化分支 | [容量收敛详细计划](2026-10-22-atc-capacity-convergence.md)；基线可并行，优化比较 A，必要切片按条件实施 v6 |

第一条执行路径为 A：先补正文可比较性，再修排序与同步完成。时间优先符合设计目标，但相对当前裸 sort_key 链计算属于规则改变；缺正文保护、零长度祖先门槛和标题兜底也可能改变旧结果。代码交付与历史对齐分别验收，真实库授权、目标会话重建和保留结果报告见[上线与历史结果对齐](2026-10-22-atc-derive-correctness.md#上线与历史结果对齐)；没有执行该步骤时不能宣布旧数据已采用新规则。

B 中无需新增列的纠错可独立开展，无需等待 A 全部完成。C 的请求修订、来源映射和历史保留与 A 保留的旧版本写入行为分批交付；A 新增本次重算/保留计数，不宣称持久算法版本已经迁移。F 的切片契约与迁移步骤在规划阶段写清，测量证明需要后才实施 v6；基线未触发时不建代际表、worker 或通用队列。

## 跨计划验收

### 共享 Seam 归属

每一行只有一个权威实现文件；其它批次通过该 Interface 消费，不复制第二份规则。

| Seam | 权威定义 | 消费方 |
| --- | --- | --- |
| `drainDeriveTx(db,{limit,scope?,purposeLimit?})` 与 `DeriveScope={convKey}` | A 定义签名与阶段顺序，C 增加 `purpose_*` 计数，D 替换用途阶段实现 | 实时 tick、维护、迁移、F 切片入口 |
| `projectRequestTx(db,reqId,{now,mappingVersion})` 与 `collectOwnerEvidenceTx` | B；`mappingVersion` 传 B 导出的 `SOURCE_PROJECTION_VERSION` | 在线账本/route/hook 写入、C 迁移 project 阶段 |
| `writePreparedLedgerTx` / `writePreparedRouteTx` | B（只 UPDATE 既有 raw），C 扩展列清单以写入 `err` 与两个版本列 | C 迁移 remap 阶段；同一列清单让在线行与迁移行带同一组版本 |
| `markRequestInputTx` / `markGroupDirtyTx` / `markRequestGroupsTx` | C | 全部输入变化写入者、D 用途阶段 |
| `derived_state`、`source_facts_json`、`projection_meta_json` 读投影 | C 在单一只读快照内提供 | D 会话标题筛选、E 详情与页面、F 报告 |
| `families[*].current`、`identity.orderState`、`prompt_retained` | B 产出，C 落列并联结顺序语义 | C 读模型、E 展示 |
| `purpose_chain`、`req_kind`、`model_title` | C 定义列与取值域（`CHECK(purpose_chain IN ('participate','exclude'))`），D 独占写入 | 同一组列配三种判据，不得合并：`purpose_chain === 'participate'` 判是否参与链、`=== 'exclude'` 判链身份与工具配对弃权、`req_kind === 'title'` 判标题字段；A 迁移前按现有 `req_kind`/`model_title` 消费 |
| `v5` 结构、迁移 marker、盐绑定、bundle 与 `RESTORABLE_SCHEMA_VERSIONS` | C | D 用途列；F 的 v6 迁移只扩展该白名单数组，不复制 marker 解析与备份恢复代码 |
| v6 代际表、发布指针与切片步骤 | F 条件分支 | 无（未触发时不创建） |

## 跨计划执行准入

A—F 的详细步骤已各自写定，本节是执行时的准入核对：进入某批次前先确认这些约束仍然成立，它们不代替子计划里的任务步骤与断言。

### B：来源投影

先核对 `src/sources/magpie.ts`、`src/reconcile.ts`、`src/hook.ts`、`src/privacy.ts` 与对应现有测试。固定 req/provider model/served 各异及缺 req、零费用、err/err_type、Prompt counted 布尔、省略与非法类型反例。所有保存路径从统一处理后的对象形成列、payload 与长期摘要；account 别名与已有占位符不重复散列。

owner 收集和完整性判断由来源投影 Module 持有，在线与离线共享；重复证据与不完整聚合分别检查。raw 过期后不得从部分输入缩小长期尝试合计，也不得用 MAX 掩盖重复费用。hook 模型与 success 独立保存；在 C 未提供存储前，不提交将 hook 值写进 ledger.req、served 或合成 HTTP 状态的过渡实现。有关固定上游结构只定点复核已锁定的 magpie 检出，不 fetch、不扩大接入面。

### C：长期信息与恢复

编写 C 的可执行任务前，确定本次 schema 的全部键、列归属、缺失状态及索引，并逐项列出写入者、消费者和增长上限。必须覆盖 v2 的[必需长期信息](../../architecture-evolution-v2.md#历史修复与迁移)：来源 kind 集合及冲突、模型和最终尝试最小依据、请求输入/消费修订与待处理、组修订、工具/摘要原算法及保留状态、来源映射与隐私变换版本、数据库与盐绑定。代际结构仅在 C 同时交付切片时纳入。

请求标记须覆盖直接 hook、归属合并、正文/回复与标签后到、回收和规则升级；费用变化不触发用途重判。旧任务不能以合并后复用的身份或修订通过校验。算法目标、实际产出、缺证据保留与未完成分别报告；维护 MAX、旧测试和运维字段一起迁移，不复用 adapter_version 的协议语义。

显式脚本须有范围预览、维护锁、结构与迁移完成分开检查、每批数据与检查点同事务、异常范围停止与可续跑报告。合成验证保住请求/alias/owner/正文引用/费用/游标/淘汰墓碑，重复运行收敛。盐恢复测试使用合成盐：首次空库、已有库缺盐、错盐、绑定不明、恢复后继续摄入及仅数据库只读快照。旧库显式确认不伪称已证明原盐；认证 token 独立处理。

### D/E：用途与阅读

请求用途、输入解释、技能提取保持独立操作，只持久化确有消费者的短结果。D 明确定义规则优先级与未知用途的兼容政策；所有用途消费者，包括会话标题 SQL、工具候选和页面，使用同一参与政策。缺回复、不适用 Agent、普通 `<block>no`、规则冲突、回收后旧版本保留均有断言。

E 明确消息 ord 与分页覆盖：包装中真实文本、插话、畸形标签、多条新增用户消息不得丢失；技能为空、未识别、缺失及未读全分开。part、未知 kind/role、分页方向、flags 可单独纠错；尝试链不补造重试间隔，上下文比例缺分母不显示。account/host 展示、全文搜索、direct 和专有指纹不纳入这些任务。

### F：测量与性能选择

复用 `startCollector(config)`、`createHandler` 和现有 `Config` 注入路径，不先造第二套采集链。负载只连接独立临时目录、合成来源、独立本地端口及合成上游；验证任何未覆盖的默认配置都不会连向真实 magpie。固定种子、机器、Bun 与配置，按 v2 的[容量场景](../../architecture-evolution-v2.md#容量目标与验证方法)运行，记录接收/拒绝/重试、查询和 hook 分位、最大事务、事件循环延迟、RSS、积压年龄、排空和数据库/WAL/暂存量。

拒绝使用固定原因进程计数，经认证入口读取，注明启动时间与重启归零；不逐次写拒绝正文或放宽准入。先完成计数与负载端核对，再设积压/排空阈值。比较性能前要求 A 的相同输入产物一致；元数据按每请求/每组空间与日量估算，不宣称秒级峰值等于全年均值。

路由缓存先查失败是否被误当为空及替换检测；切片先冻结代际键、发布指针、读取快照与旧结果保留、临时空间预算及清理。切片期间的新证据、归属变化、规则变化和回收使计算失效；停止输入后必须排空。没有测量结果时保留同步路径，不填写猜测的预算或吞吐结论。

## 执行与验收记录

- [ ] A：按详细计划完成全部任务，报告实际测试及尚未覆盖项。
- [ ] B：来源子计划通过文件、类型、失败断言和全部写入路径自审后执行。
- [ ] C：schema/恢复设计完成，显式迁移合成验收通过后再安排真实库授权。
- [ ] D：用途子计划覆盖全部链参与消费者后执行。
- [ ] E：阅读子计划覆盖原文可读、分页与转义后执行。
- [ ] F：先交付基线；依据实测选择保留同步或进入条件切片，两条分支的步骤与退出条件都已在子计划写定。

每个代码任务先观察对应断言失败，再实现并跑最窄相关测试。只在新改动或失败需要时扩大检查；不为计划文档重跑运行时测试。任务提交包含其拥有的 note；有提交授权后才 stage/commit，禁止把父仓库或其它任务的改动带入。真实数据、服务切换与 push 均不由本计划授权。
