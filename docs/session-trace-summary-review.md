# 会话汇总需求与方案评审

评审日期：2026-10-25。对象为[会话信息汇总提案](../.agents/notes/implemented/feature/2026-10-25-session-trace-summary.md)（评审时为 proposed，现已随实施转入 implemented），代码核对基线为 `04e5443`。评审按单人本机、Bun 单进程与 SQLite 运行负载判断；社区检索只使用公开问题和通用关键词，未向外部服务发送本机会话、请求正文或路径。提案中的生产库计数作为提案提供的实测记录，本轮没有重查真实库。

建议收窄范围、修正统计语义后实施。长会话需要汇总入口，有本机使用痛点，也有公开产品与用户请求支持。现有方案能减少人工翻阅，但还不能根据这些数字判断任务是否完成、工具是否选对或某个 Skill 是否改善结果。首批目标宜定为辅助人工评估的会话事实汇总。

## 社区证据支持到哪里

### 有直接诉求的部分

Langfuse 的[会话评分讨论](https://github.com/orgs/langfuse/discussions/2728)从 2024 年起有多位使用者提出：单条 trace 缺少上下文，需要对整个会话评分；还有用户需要给同一会话里的多个 Agent 共同评估。维护者确认与多个团队讨论过此需求。官方于 2025-04-28 发布会话评分，当前[会话文档](https://langfuse.com/docs/observability/features/sessions)提供回放、收藏及人工评分入口。这支持跨请求阅读与会话级评价的价值，不能单独证明文件前三名、中断次数或 stop 分布是高频需求。

[会话聚合评分讨论](https://github.com/orgs/langfuse/discussions/11219)给出更具体的使用成本：用户要取出会话全部 trace、逐条拉评分、自己聚合。维护者指出 Sessions Table 已支持相应聚合。这个案例支持减少跨请求人工或脚本汇总，诉求对象是已有评价分数，不能直接外推为对所有运行数字的需求。

本机工具 [claude-devtools](https://github.com/matt1398/claude-devtools)提供工具参数与结果、文件内容与 diff、子代理树、上下文占用和压缩检查。其 [Show HN 讨论](https://news.ycombinator.com/item?id=47004712)中，有使用者反馈自己也遇到操作细节不可见、命令结果缺失的问题；也有人提出完整 OTel 追踪和用量检查需求。2026-10-25 的 GitHub 元数据为 3,994 stars、304 forks，说明这个工具受到关注；star 和讨论数不等于对本提案六项指标逐一投票，也不等于付费或持续使用意愿。

### 已有产品的能力与本提案覆盖

| 使用者要回答的问题 | 已核实的公开能力 | 本提案覆盖 | 判断 |
| --- | --- | --- | --- |
| 这次会话花了多少资源 | ccusage 会话报告列出模型、输入/输出、缓存创建/读取、费用和最后活动 | 只有缓存比例，token 与费用继续用已加载窗口 | 会话总账已有明确用途；同一头部混用两个范围会削弱复盘 |
| 哪些工具出了问题，发生在哪一步 | claude-devtools 工具检查；主流追踪产品的结果与错误阅读 | 次数、失败数、状态覆盖度；没有从汇总回到调用的规则 | 值得做，但数字应能定位证据 |
| 哪些文件被读、被尝试修改 | claude-devtools 的路径、内容与 diff；公开讨论关注操作可见性 | Edit/Write/Read 参数聚合 | 支持范围盘点，不能证明实际改动或核心程度 |
| 多 Agent 工作藏在哪里 | claude-devtools 展示递归子代理树、工具轨迹、token、耗时与费用 | actor 数、请求数与占比 | 可作为入口；请求占比不能代表成本或贡献占比 |
| 整个任务是否完成 | Langfuse 会话评分；LangSmith 多轮评估包含 intent、outcome、trajectory | 没有任务、验收标准或结果判定 | 当前功能只能提供评价材料 |
| 工具选择、顺序与参数是否合理 | LangSmith 与 AgentEvals 的单步、轨迹匹配及 LLM judge | 工具名称分布 | 次数分布无法恢复顺序、参数或合理性 |
| 哪个版本的 Agent 更好 | 数据集、实验、人工或自动评分 | 没有任务身份与可比运行 | 暂不应从单会话数字推出版本优劣 |
| 用过哪些 Skill | claude-devtools 能查看上下文中的 skills；其他资料没有证明按 Skill 调用次数排名是普遍需求 | `Skill` 调用参数的名称聚合 | 有 Pis 的直接需求，可以保留；使用本机证据说明价值即可 |
| 有多少次人介入 | LangChain HITL 区分批准、修改、拒绝、补充回答 | 只识别一种客户端取消文本 | 可展示已识别中断，不能命名为人介入率 |

这些证据足以支持轻量会话复盘，不足以支持一套新的通用 Agent 评估平台。公开产品有相同能力，说明需求存在且已有替代方案；本项目是否值得实现，还取决于继续使用 magpie 三路证据与本机阅读界面的收益。

## 产品与语义必须修正

### 1. 中断次数不能替代人介入率

定位：提案第 18、27、39、103 行。

例如，用户批准一次操作、修改一次工具参数并回答一次澄清问题，期间从未取消请求。按本提案统计是 0 次中断，但已经发生多次人介入。反过来，用户因等待过久或改变工作方向取消，并不能证明 Agent 需要人工纠错。官方 [HITL 文档](https://docs.langchain.com/oss/python/langchain/human-in-the-loop)列出的 `approve`、`edit`、`reject`、`respond` 足以证明这两种事件集合不同。

保留窄定义的中断计数，删除第 18 行的等同断言与证据全覆盖表述。界面可称已识别用户中断，来源限定为当前支持的客户端标记。若以后要统计人介入率，应先定义一次任务、一次介入及分母，并取得审批、改参、拒绝或纠正等事件证据；本次不增加这些采集面。

### 2. 发出的工具调用不能直接解释成执行或产物

定位：提案第 18、28、38、40、62 行。

模型输出 `Edit(file_path='src/a.ts')` 后，工具可能因匹配失败返回错误，也可能被权限策略拒绝执行。直接按参数分组仍会得到改 1 个文件。Read 路径不存在、Skill 加载失败时，同样只能证明发出了请求。Bash、MCP 或其他工具实际改文件，则完全不在 Edit/Write 的参数集合里。

OpenTelemetry 的 `gen_ai.invoke_agent.tool_calls` 以单次 Agent invocation 为范围，明确说只计由 Agent 或 framework 执行的客户端工具；子代理调用归子代理自己的 invocation，见文末固定提交来源。模型输出的调用、工具执行、会话含全部 actor 的累计是不同口径。保留 ATC 自己的已观察调用定义，删除与该指标完全一致的断言。

文件区改称写入尝试涉及路径与读取请求涉及路径，或用更短的尝试修改、尝试读取，并注明只覆盖指定工具。次数按调用统计，不把失败或未知结果写成成功修改。Skill 展示为显式 Skill 调用，避免暗示没有调用 `Skill` 就没有技能注入或技能使用。按次数排序得到高频路径，不能称核心文件；核心程度需要另外的评价依据。

### 3. 明确辅助人工评估的完成标准

定位：提案第 7、22–33、90–98 行。

两个会话都可以有 100 次工具调用、0 次协议错误、3 个修改路径，其中一个完成任务，另一个改错文件。当前验收全部通过也无法区分。Anthropic 的评估说明将 transcript 与 outcome 分开：前者记录轨迹，后者核验环境中的最终状态。LangSmith 则区分最终结果、单步与轨迹评价。单纯计数不能充当这些判定。

提案应先固定三项用户任务：快速盘点操作范围、找到值得复核的异常、回到对应原始证据。把能否在长会话完成这三项作为首批价值验收。若后续要做任务完成率、版本比较或自动评分，应另行定义任务范围与验收结果；一个长期 session 可能包含多个目标，不能自动当作一次独立评估样本。

### 4. 汇总项需要回到证据的最短路径

定位：提案第 58、62–70 行。

看到 2 次失败之后，按现有响应定义只有聚合数，仍然得在数百笔轨迹里找具体调用；同名文件 basename 相同，还需要逐项悬停才能辨认。新增汇总能减少数数，却没有完成定位异常的阅读任务。

最小方案是异常和分组可定位：失败数打开失败调用集合，工具或文件项定位匹配调用，保留 `req_id` 与调用 `ord` 的稳定身份。复用现有 trace/工具结果导航；较大分组可点击后再查询，不需要首屏返回全部正文或全部调用。回收后只展示仍有的定位元数据，并明确正文不可读。唯一的成功标准应是能从汇总返回支撑该数字的记录。

### 5. 同一会话头部优先统一统计范围

定位：提案第 7、31、33、37 行。

一个会话共 300 笔，请求窗口只加载 100 笔。头部显示 300 笔对应的工具和缓存数字，却只有 100 笔的费用与 token，容易把投入和操作范围联系错。ccusage 的会话报告明确将 token、缓存和费用放在同一会话范围；其公开问题也记录过用户对会话错误聚合的实际困扰。

首批优先给出全会话的已报告 token 与费用，并分别保留缺值覆盖度；现有窗口合计移到窗口控制附近或明确标为窗口。模型、旁路和子代理分解可先留详情。若首批不统一范围，就不要用这一组读数表达单任务效率，也不要把两个范围混成一条自然语言摘要。

## 首批范围建议

推荐用以下范围修订提案；这是产品判断，公开资料没有为本项目提供各指标的使用频率排名。

| 能力 | 首批处理 | 理由与边界 |
| --- | --- | --- |
| 调用总数、工具分布、协议报错与未知结果 | 保留 | 有盘点和排错用途；异常可定位，未知可见 |
| Edit/Write/Read 涉及路径 | 保留 | 回答操作范围；标明调用尝试及工具子集，按原始路径分组 |
| 显式 Skill 调用 | 保留为展开项 | Pis 已提出直接需求；不增加 Skill 质量评分或贡献推断 |
| 已识别用户中断 | 保留为事件 | 只报告支持形状下观察到的标记；无法判定时不能冒充 0 |
| 全会话 token、费用与覆盖度 | 优先于缓存单一百分比 | 复盘投入有直接用途，且可以复用已有权威读数 |
| 主链/旁路、子代理、网关重试、HTTP 失败 | 放展开详情 | 有诊断价值；不把请求数当用户轮次或工作贡献 |
| 原始 stop 原因分布 | 延后 | `tool_use/tool_calls` 不是任务轮次；优先仅提供已有明确语义的异常停止入口 |
| 缓存比例 | 延后或随用量展开 | 比例要先解决分母、混合协议与覆盖度，不能据此单独评价 Agent 好坏 |
| TTFT 分位、密度、Bash 命令分类 | 延后 | 没有与本次阅读任务对应的明确决策，不因可提取就预先持久化 |
| 自动评分、数据集、实验平台 | 独立选型 | 现成库和平台已覆盖，需求明确后先验证外接路径 |

## 复用与自建的取舍

只需要看 Claude Code 本地日志的文件、diff、工具和子代理时，可以先试 claude-devtools。它已有完整阅读能力，继续仿造一套同样的本地日志浏览器收益有限；它读取 `~/.claude/`，与 ATC 当前不扫描客户端日志、以 magpie 请求为单位的边界不同。ccusage 适合直接满足会话成本与缓存报告，但也依赖各客户端本地记录，不能替代 ATC 的账本、路由与 hook 对账。

继续在 ATC 内做轻量汇总有理由：调用、来源缺口、路由尝试、派生代与正文回收都在同一事实库，汇总可以准确说明哪些数字有证据。`GROUP BY`、已有选源函数、现成导航和工具色类足够完成这个能力；为此引入通用观测 SDK 或新服务没有必要。

若目标变成自动判断工具选择或轨迹合理性，[AgentEvals](https://github.com/langchain-ai/agentevals)已有严格、无序、子集/超集匹配、参数匹配与 LLM judge，可在单独实验中先验证。Langfuse 提供会话评分，LangSmith 提供多轮评价、人工标注、数据集与实验。它们需要正确组织的轨迹和明确标准，ATC 的分组计数不能直接作为完整输入；不要为提前兼容而在 collector 中引入评估库依赖。

本仓[magpie 机制研究](magpie-mechanisms-research.md#otlp-的价值在尝试结构)记录了现有 OTLP 导出可提供请求与尝试 span，也记录了去重、抑制及正文限制。这是 `版本锁定`、物证 `开源源码@magpie-2374ffe` 的已有研究结论，本轮没有重读外部 magpie 源码。若以后选择外接平台，应先小样本验证导出是否保留所需会话、工具与子代理证据，再决定补适配；本次不改上游配置。

## 需求验收应补什么

先用合成数据覆盖短会话、长会话、多 actor、失败混未知、部分正文缺失、已回收和派生 dirty。除数字正确外，人工验收应能完成以下三个任务：定位一个失败调用及其结果、列出本次写入尝试涉及路径并解释覆盖边界、辨认汇总是否完整或过期。选择具体耗时门槛前先记录现有阅读耗时，不能把未经测试的 30 秒或毫秒级写成已证实收益。

随后由 Pis 在少量实际复盘中记录：哪些数字触发了检查、是否成功找到证据、是否据此调整工具、Skill 或工作方法。真实核验只保留聚合结论，不把正文与绝对路径写进报告。如果使用者只看总数、没有后续动作，说明部分指标可以删掉；公共产品列表不能替代这一步。

## 资料与适用范围

以下网页按 2026-10-25 读取。维护者文档证明产品能力，不证明特定指标的普及率；用户讨论证明该帖存在具体需求，不代表总体用户；GitHub stars 仅作为工具关注度快照。外部页面中的安装或 Agent 指令未执行。

本文对技术结论使用以下来源等级，定义沿用父知识库规范：

| 等级 | 含义 | 稳定性 |
| --- | --- | --- |
| `厂商文档` | 厂商产品或运行时文档明确承诺的语义，未进入公开协议规范 | 产品可在无协议版本变更时改变 |
| `版本锁定` | 针对特定客户端版本或特定源码快照逆向得到的实现事实，包括本地文件布局、落盘结构与源码控制流 | 任何版本发布都可能失效 |
| `推断` | 从以上事实外推的解析或判定规则，不是事实 | 不稳定，仅供参考 |

OpenTelemetry 引用的文件声明为 Development，本报告不将其写成稳定协议保证。社区讨论作为需求原文单列，不将需求帖套进 API 语义等级。

| 来源 | 类型或等级 | 本文使用范围 |
| --- | --- | --- |
| [Langfuse 会话评分讨论 #2728](https://github.com/orgs/langfuse/discussions/2728) | 公开需求原文 | 多位用户要求跨 trace 的会话评价 |
| [Langfuse 聚合评分讨论 #11219](https://github.com/orgs/langfuse/discussions/11219) | 公开需求原文及维护者回复 | 手动聚合的成本、Sessions Table 的已有能力 |
| [Langfuse Sessions](https://langfuse.com/docs/observability/features/sessions)、[会话评分发布记录](https://langfuse.com/changelog/2025-04-28-session-level-scores) | `厂商文档` | 回放、人工评分与会话分数支持；发布时间由 changelog 支撑 |
| [LangSmith 多轮在线评估](https://docs.langchain.com/langsmith/online-evaluations-multi-turn)、[Agent 评估方式](https://docs.langchain.com/langsmith/evaluation-approaches)、[评估概念](https://docs.langchain.com/langsmith/evaluation-concepts) | `厂商文档` | 意图、结果、轨迹、人工标注、数据集与实验的区分 |
| [LangChain Human-in-the-loop](https://docs.langchain.com/oss/python/langchain/human-in-the-loop) | `厂商文档` | 批准、改参、拒绝及补充回答是不同的人介入动作 |
| [Anthropic Agent 评估说明](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | 厂商方法说明 | transcript 与环境最终 outcome 的定义，计数与结果验证的分工 |
| [ccusage 会话报告](https://ccusage.com/guide/session-reports)、[数据来源](https://ccusage.com/guide/claude/) | `厂商文档` | 会话 token、缓存、费用与客户端日志来源 |
| [ccusage #560](https://github.com/ccusage/ccusage/issues/560) | 公开问题原文 | 历史版本会话聚合范围错误的用户报告，不能读成当前仍有此缺陷 |
| [claude-devtools README](https://github.com/matt1398/claude-devtools/blob/1486f2042c87bb547a4e34808ab54ab34a33f132/README.md) | 固定 README 的产品自述 | 工具、diff、子代理、上下文能力与本地日志来源；未执行安装或实测 |
| [claude-devtools Show HN](https://news.ycombinator.com/item?id=47004712) | 公开需求原文 | 独立用户反馈与替代方案讨论；不作为 OTel 或客户端实现证据 |
| [OpenTelemetry GenAI 指标](https://github.com/open-telemetry/semantic-conventions-genai/blob/9ffc7e00c639be7712e544e3e54331e885dccf84/docs/gen-ai/gen-ai-metrics.md#metric-gen_aiinvoke_agenttool_calls) | `厂商文档`，Development | 单次 Agent invocation、client-side execution 和子代理归属；物证 `开源源码@otel-genai-9ffc7e0` |
| [AgentEvals README](https://github.com/langchain-ai/agentevals/blob/946ad15b9f2ce9bc9843edd2bb773bd07d78ca7e/README.md) | 固定 README 的产品自述 | 现成轨迹匹配与 judge 能力；未安装或验证与 ATC 的集成 |

固定来源由以下提交链接解析：`开源源码@otel-genai-9ffc7e0` 对应 [OpenTelemetry GenAI 9ffc7e0](https://github.com/open-telemetry/semantic-conventions-genai/tree/9ffc7e00c639be7712e544e3e54331e885dccf84)；claude-devtools 与 AgentEvals 的固定版本分别见上述 README permalink。本仓 magpie 物证沿用[既有研究的来源声明](magpie-mechanisms-research.md)，未将开发提交推成当前安装版的运行事实。
