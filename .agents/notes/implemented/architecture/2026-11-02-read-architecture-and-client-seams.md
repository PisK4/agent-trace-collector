# Agent Note: 读取架构与多客户端演进

Status: implemented

本文由同名 proposed 评审稿按交付范围转入：Task 1–7（具名契约、统一调度与生命周期、批端点、批量窗口准备、依赖感知显示模型、接入规则与边界检查）已交付；macOS 宿主连接、后台任务与切片重构不在本轮，仍是未来工作。

## Problem

后续 feature 会增加读取操作。当前页面大部分读取经过 reader-store，但它同时承担 URL 编码、HTTP 错误映射、网络排队、证据缓存和恢复。上下文明细与统计另走直接 Fetch，无法共享并发、取消与诊断规则。每次扩展都可能重新引入无界队列、迟到回写和整窗计算。

[第二轮性能调研](../bug-fix/2026-11-01-interaction-latency-round2-and-rail-consistency.md)证明这些成本已经影响长会话。[性能评估](../../../../docs/superpowers/plans/2026-11-02-interaction-performance-optimization.md)给出了局部候选，但只增加两个批量端点，仍不能约束下一批 feature 怎样读取、缓存和刷新页面。

Pis 于 2026-11-02 明确要求从全局架构制定规则，并为中期 macOS 客户端做好准备。当前未选定 WebView、SwiftUI 或其他桌面技术，也未确认打包、更新和后台驻留方式。这些决定不应成为本轮读取优化的前置条件。

## Decision

把阅读能力组织为可测试的 module。变化应集中在拥有该知识的 module：HTTP adapter 负责编码与连接，调度 module 负责有界执行，reader-store 负责证据与版本，投影 module 负责显示模型，DOM module 负责节点、焦点和锚点。feature 描述需要读取什么，不自行决定并发数、URL 或版本恢复。

本提案已按[实施计划](../../../../docs/superpowers/plans/2026-11-02-read-architecture.md)交付：`src/read-contract.ts`（Task 1）、`web/read-scheduler.js` 与统一退出生命周期（Task 2–3）、有界阅读批与批端点（Task 4）、批量窗口准备（Task 5）、依赖感知显示模型（Task 6）分别落地，各自带行为测试与 note。新增 feature 的准入规则见[读取接入规则](../../../../docs/read-feature-rules.md)，架构事实见[架构设计](../../../../docs/architecture-design.md)。

### 覆盖关系

Supersession check：本提案部分调整[生产阅读缓存](../../implemented/feature/2026-10-24-reader-store-cache.md)的 URL/队列归属、[页面缓存单一归属](../../implemented/architecture/2026-10-24-page-cache-single-home.md)的读取接入面、[准备流水线](../../implemented/architecture/2026-10-27-trace-window-preparation.md)的逐笔通知，以及[键控提交](../../implemented/architecture/2026-10-27-keyed-trace-main-view.md)的全模型生成成本。它们的唯一缓存所有者、两套游标、版本守卫、准备资格、稳定键、焦点与视口保护继续有效；调整后的现状见各实施 note 与[架构设计](../../../../docs/architecture-design.md)。

[稳定阅读提案](2026-10-27-stable-progressive-trace-reader.md)继续拥有自动读取范围、投影保留与虚拟化体验取舍。本提案不批准整场排空、不削减 20 片准备预算、不改变顶部入口。[第一轮性能治理](../../implemented/bug-fix/2026-11-01-collection-interactive-latency.md)与[派生预算工作单元](../../implemented/architecture/2026-10-24-budgeted-derive-unit.md)继续拥有单组事务、预算及线程隔离触发条件。

### Module 与 Interface

| Module | Interface 中调用者需要知道什么 | 隐藏的 Implementation |
| --- | --- | --- |
| 读取契约 | 具名操作、参数、结果、错误语义与读取上限 | 不包含 URL、Response、SQLite、DOM |
| HTTP adapter | `execute(operation, input, {signal})` | 路径编码、GET、状态码、响应解析、可选认证 |
| 读取调度 | `run(scope, priority, signal, task)`、scope 取消与 dispose | 并发、队列容量、公平性、取消及无正文计时 |
| reader-store | 原有读取/peek，加 `leaveSession`、`dispose` 和内容修订 | 缓存、去重、原子回写、版本恢复与生命周期 |
| 阅读准备 | 目标优先、范围内准备、一次提交通知 | 批量读取、依赖补齐、增量预算、准备代次 |
| 显示投影 | 请求组与变化依赖生成稳定显示结果 | 排序结果、依赖索引、保留投影、纯计算复用 |
| DOM 提交 | 稳定键模型、选择与锚点 | HTML 转义、节点操作、布局测量与焦点 |

调度和 HTTP adapter 是 reader-store 内部的 Seam，不要求 UI 学会它们。实际存在生产 HTTP 与合成测试 adapter，足以支持注入；未来 IPC adapter 等真实宿主确定后再实现。不要为只有一种行为的函数加转发外壳。

### 操作契约与类型

新增 `src/read-contract.ts`，显式列出当前操作的输入与输出，导出 `ReadOperations`、`ReadInput<K>`、`ReadOutput<K>`、`ReadTransport`、`ReadErrorCode`。它只包含类型，不生成运行代码；初期通过 type-only import 引用既有 DTO，避免复制 `RequestDetail` 等结构。此阶段仍有编译期路径依赖，不宣称已经成为独立 SDK。

操作集合覆盖 sessions、requests、detail、body、toolResult、route、turns、bgJobs、summary、summaryEntries、contextItem、stats，以及新增的 readings 和 bodyRanges。名称是明确的读取用途，不是客户端传 SQL 或任意 URL 的通用执行器。操作集合不自动生成服务端路由；HTTP 层继续显式解析与校验，后端查询仍调用现有函数。

Interface：`execute<K extends keyof ReadOperations>(operation: K, input: ReadInput<K>, options: {signal: AbortSignal}): Promise<ReadOutput<K>>`。AbortSignal 是执行控制，不进入 JSON。结果只含 JSON 可表达的数据，客户端 Map、Error、Date、函数和 DOM 引用不得跨进程传递。现有 `unknown` 协议对象继续透传，不把未知内容转换成已解释事实。

错误码至少包括 `reading_changed`、`not_found`、`invalid_input`、`unavailable`、`unauthorized`、`forbidden`、`unsupported_operation`、`invalid_response`、`cancelled`、`queue_full`、`batch_too_large`。HTTP adapter 保留 HTTP status 供诊断，store 仅消费稳定错误码。未识别的 500、网络失败和 404 不自动触发批量到单项回退；旧版本能力必须由明确握手或配置证实，不能拿普通资源不存在推断接口不支持。

初期校验响应的顶层形状、批次完整对应、身份、token、区间和游标；不引入 schema 生成框架，不宣称 TypeScript 类型就是运行时校验。新桌面宿主若需要独立发布，再定义完整 DTO schema 与协议兼容矩阵；现有 `r1-` reading token 不是应用协议版本。

### HTTP adapter 与调度分别持有什么

`web/read-http.js` 是生产页面唯一允许执行网络 Fetch 的读取模块。构造时注入 fetcher、base URL 和可选 header 提供函数。默认使用相对地址与现有同源认证，macOS 将来可在受信宿主注入连接信息；不在 URL、日志、localStorage 或浏览器页面里保存长期凭证。认证配置失败原样报错，不通过放宽 Host/Origin/CORS 迁就宿主。

HTTP adapter 不排队、不缓存、不自动重读。它的任务持续到响应体读完、JSON 解析和顶层校验完成；取消后仍必须在返回前检查 signal。仅等待 response headers 就释放并发槽，会漏算下载和解析阶段。

`web/read-scheduler.js` 接收已命名的异步任务，不识别 URL 或请求正文。建议初始活动上限 4、待发上限 64、后台最多占 3 个活动槽，给交互保留一个槽。交互任务优先；后台已经饥饿时，最多连续放行 8 个交互任务后允许一个后台任务。公平规则只在存在合适活动槽时执行，不中断已运行任务。参数在同一处定义与注入测试，不散布在 feature 中。

待发满时，新的交互任务可以取消最旧的待发后台任务；没有可淘汰后台任务则返回 `queue_full`。后台满队列立即返回 `queue_full`，不能不断登记 Promise 充当背压。准备流程只保持一个当前批次与一个有限后继，不把整场数千个任务一次塞进队列。

scope 按 page、session、dialog 管理。会话退出取消 session scope，弹窗关闭取消 dialog scope，应用销毁取消全部。页级列表和 stats 不因会话切换被误取消。弹窗与会话读取若共享在途任务，不能由任一消费者直接取消整个共享任务；本轮不增加跨 owner 的在途共享，已有同记录去重继续由 store 持有。

取消先移除待发任务，再通知在途 adapter。任务必须 settle，取消不计为服务器读取失败；回写仍检查 epoch、记录归属、本地修订和 token。任何任务结束、失败、取消都释放活动槽。非协作任务可能忽略取消，`dispose` 不把它错误记为已停止；迟到结果不得进入 store。

### 批量是阅读用例，不是任意请求打包

新增详情/元信息批和正文区间批，以当前小批 JSON 验证收益。条数、响应字节、同步处理时间、单项超大和首个可读片段共同受控。初始候选为 32 个详情项、64 个区间项、16 KiB URL、约 1 MiB 响应与 20 ms 同步读取软预算。单次 SQL、解压和序列化不可被这个软预算中断，指标必须说明超时来源。

每项保留稳定输入位置 `index`、requested id、canonical id 与 reading token。批内同快照；跨批不冻结整场历史。参数非法整体拒绝；资源不存在、reading_changed、超大项和单项失败逐项返回。`next_index` 必须严格推进，未完成项不冒充成功。客户端先校验整份批次的对应和完整性，再原子合入每项，避免坏响应污染缓存。

单项详情与元信息只算一次 reading identity，正文作用域复用骨架、System 与能力准备；解释规则继续只有一份。增量区间选择留在已有客户端纯规则，不在服务端再写一份。工具结果、route、上下文明细和汇总明细仍按需，不因批量变成预取。

### 内容修订与显示更新

reading token 绑定证据身份；本地 `contentRevision` 绑定当前客户端已经读到什么。相同 token 下新消息到达、增量消费、准备失败或恢复都可能改变投影，因此不能只用 token 缓存显示。

store 持有内容修订，按实际变化递增；选择与折叠 UI 状态不写入证据修订。投影 module 记录前驱、工具调用方及背景作业依赖，并维护反向依赖索引。某项变化只使本组和依赖它的组失效；窗口结构变化才重建顺序、序号和尾部资格。不能把一次选择升级为所有组的内容修订。

准备完成通知按一个受控批次聚合。提交前锚点捕获与提交后补偿仍在同一同步阶段，不把恢复滚动推迟一帧。DOM module 已实现键控复用；本轮补足模型生成复用，不重写框架。缓存中的旧投影必须保留旧来源身份，不能用新 token 去解释旧坐标。

### 缓存、预算与可观察性

证据缓存只有 reader-store 一个所有者，投影缓存只有显示 module 一个所有者。缓存生命周期是 page/session/request/dialog，键必须包含对应身份与版本。成功 Promise 不得同时充当无界结果存储；在途索引与完成值分开。退出统一清除 timer、窗口、正文、显示和在途登记。

本轮提供计数与约束：待发/在途峰值、每操作次数与取消数、批次项数、响应字节、解析与投影耗时、store 记录数、消息数和退出后残留。标签只用固定操作名，不记录 session key、路径参数、正文或 token。时间测量包含队列等待与执行两个区间，重试单列。

不以未经 GC 的堆读数断言泄漏；也不因 clear 已执行就排除其他持有。资源目标沿用性能评估，未达标须归因。正文预算淘汰、紧凑中栏读模型与虚拟化是按证据进入的独立阶段，需处理被选中项与依赖 pin，不能静默截断内容。

### macOS 的准备程度

| 路径 | 本轮能准备的内容 | 届时必须补的工作 |
| --- | --- | --- |
| WebView 复用页面 | 统一读取 Interface、无 DOM store/投影、宿主连接参数 | 安全 origin、认证注入、导航白名单、生命周期与打包 |
| 原生界面 + 本机 HTTP | JSON 读取契约、版本和错误语义、契约用例 | Swift 等语言 DTO 与读取协调、界面实现 |
| 原生界面 + IPC | 无 HTTP 依赖的后端阅读函数、唯一 writer 原则 | 白名单命令、进程身份、大小限制、取消、故障恢复 |

SQLite 继续由 collector 管理，UI 不直接开生产库写入；否则 schema、回收和派生发布都会泄漏到客户端。窗口关闭不等于停止采集；launchd 托管与用户级后台采集生命周期独立，未来宿主不得用窗口退出任意 kill 采集器。

当前不实现 IPC、菜单栏、自动更新、沙盒权限、Keychain 或打包器，不预选 Electron/Tauri/SwiftUI。native 不会直接复用 DOM，Swift 也不会自动复用 JavaScript store；本轮可复用的是 Interface、后端判定与验收向量。若使用 WebView，则可复用现有原生 JS 页面。

## Alternatives considered

**只把所有 Fetch 拼成通用 batch。** 传输减少，但缓存、取消和版本仍由各调用者负责，且任意操作组合难以设置一致性和大小限制。采用具名阅读批。

**新增通用 `request(url)` 包装器。** 它没有隐藏 URL、错误和读取上限，feature 仍需知道 HTTP 细节。采用具名操作 Interface，并用实际 HTTP 与测试 adapter 验证 Seam。

**先抽一个独立 SDK 与完整 schema 生成器。** 当前只有单仓库发布，没有证据值得承担构建、包发布和类型迁移。先定义内部契约，显式保留 type-only 编译依赖；出现第二个独立发布客户端再提取。

**为了 macOS 现在改用桌面框架。** 尚未确定原生能力和分发要求，不能据此承担重写。先解除传输、证据和 DOM 的耦合。

**所有 feature 共享通用全局可写缓存或事件总线。** owner 和失效责任会模糊。store 继续唯一持有证据，变化通知使用明确记录身份，不开放任意写入。

**仅迁移 reader-store，保留弹窗和统计直连。** 新的调度限制仍会被旁路绕过。所有页面读取同批迁移；弹窗保留自己的交互状态和有限结果，不成为第二份正文仓库。

**立刻重构所有后台任务与切片。** 客户端读取与后台单组事务是不同工作。读取改造独立交付；后台继续按现有预算与性能触发条件评审，不能靠新 Interface 宣称阻塞消失。

## Consequences

已达成的现状：生产页面只有 HTTP adapter 执行读取 Fetch（`read-boundaries` AST 检查守门，fetcher 构造注入除外）；HTTP adapter 与合成内存 adapter 共用读取行为测试；并发、后台保留槽、待发上限、公平性、scope 取消、失败释放与 dispose 有确定性测试；读批次覆盖逐项错误、别名、跨会话、区间空洞、预算截断、超大单项、迟到 409 与正文回收；追加新组时未变化旧组的投影调用为零、依赖更新只重生成对应组（trace-model 测试）；同页切换、弹窗关闭、无 session 历史恢复与页面销毁释放对应 owner；不新增生产数据库直连 UI、不放宽监听或访问控制、不引运行依赖、不启用生产切片、不改变派生语义。

仍未覆盖：2,500 笔规模的 GC 后堆读数与长任务采样、真实流量只读复测——两者按[验收记录](../../../../docs/acceptance.md)登记的范围另行执行。首次迁移为弹窗读取、静态白名单与合成服务器带来一次性成本；Interface 的长期代价是 feature 不能再就地 fetch，接入问题见[读取接入规则](../../../../docs/read-feature-rules.md)。

## Risks

Interface 会增加首次迁移工作，尤其是弹窗读取、静态模块白名单、类型测试与合成服务器。分阶段保持行为一致，每个提交带同范围的测试和 note；不保留长期 fetcher/transport 双入口。

调度无法抢占已运行的同步 JavaScript，也不能强制中断 Bun SQLite。后台大事务与超大单项仍可能导致响应尖刺，必须依靠测量和后续执行隔离解决。

依赖感知的投影缓存若漏记输入，会显示旧事实。优先用内容修订与依赖身份组成显式键，保留版本冲突、调用方更新及旧来源坐标反例，不能用一次全量哈希掩盖遗漏。

本提案为 macOS 减少迁移成本，不承诺桌面打包即可上线。原生权限、凭证、安装更新和后台进程所有权必须在宿主确定后独立设计。
