# magpie 机制与复用边界

研究日期 2026-10-20。本文回答 agent-trace-collector 能怎样复用 magpie 的模型、路由和上下文分析，以及哪些能力值得借鉴。本文只做研究，不确定实现语言，不创建项目骨架，不改 magpie 或本机插件配置。

本轮源码物证为 `开源源码@magpie-2374ffe`，完整提交见文末。它是 `v0.1.1295` 之后的开发提交。本轮只读版本探测显示本机仍运行 `0.1.1294`，因此以下源码结论不能直接写成安装版实测。原集成研究的 `开源源码@magpie-2c3c903` 和 `采集@2026-10-20-magpie-0.1.1294` 仍各自有效，不把旧样本数字更新成当前数字。

## 研究结论

**可以深度集成，而且应先复用 magpie 已经计算出的路由和上下文结果。** collector 最有价值的增量是长期保留请求对象，并把请求、上下文组成、路由尝试和用量连起来。模型路由器本身继续由 magpie 承担。这个取舍属于 `推断`，后文逐项列出依据。

本轮建议分成两类处理：

- 直接采用 `Route.prompt`、`rule/classified`、`affinity`、`order/left/tries`、用量明细和耗时。它们已经是 magpie 运行时产生的结果；用量项与尝试并非严格一一对应。
- 借鉴录制清除的代际校验、内容截断标记、结构与正文分开保存。只有决定脱离 magpie 运行时，才值得考虑移植 prompt 分类、窗口过滤或路由算法。

完整集成也有上限：hook 没有稳定的 route_id，窗口过滤过程并未全部留痕，短期历史与异步投递均可能缺失。若要求无歧义地关联每个失败请求，或逐项解释所有未尝试的候选，现有接入面还不够，需要与上游协商补事件字段；不能在 collector 中靠猜测补成事实。

## 可以直接接入的上下文分析

**magpie 已经计算并保存了 collector 需要的大部分上下文结构。优先读取这份结果，比重新解析请求体并维护一套 token 估算更合适。** 这是集成建议，等级为 `推断`；依据为 `开源源码@magpie-2374ffe` 的 `internal/gateway/prompt.go:43`、`internal/gateway/trace.go:129` 和 `internal/gateway/history.go:75`。

`Route.prompt` 的字段如下。整表属于 `版本锁定`，物证为 `开源源码@magpie-2374ffe`，定义在 `internal/gateway/prompt.go:43`。

| 字段 | 含义 | 展示时必须保留的限制 |
| --- | --- | --- |
| `window` | 路由收尾时查到的模型容量 | 未知时省略；最后一次尝试可能失败，不能一律称为成功应答模型 |
| `tokens` | 请求的输入 token 总量 | `counted=false` 时是本地估计 |
| `counted` | 是否已用上游输入总量校准 | 只校准总量，不证明每一分类都经过 tokenizer 精确计数 |
| `held` | 请求引用了由上游持有的前序响应 | 本次 body 可能不含完整历史 |
| `turns` | 解析器识别的用户轮次数 | 不等于工具执行次数或客户端完整会话轮数 |
| `parts[]` | 分类别的 token 与条目 | 分类来自协议结构和 Agent 文案识别 |
| `parts[].items[]` | 名称、标签、数量和 token | 有折叠上限，不是完整对象清单，也不含正文 |

六种分类是 `system / tools / memory / files / results / chat`，分别放系统与 Harness 消息、工具定义、指令文件与提醒、工具读入的文件与图片、其它工具结果、对话与工具调用。分类常量见 `internal/gateway/prompt.go:31`。非对话条目按大小排序，超过上限的折叠成 `other`；对话保留最近条目，较早轮次折叠成 `earlier`。每类最多 24 项，不能据此宣称某请求只带了 24 个文件或工具。以上为 `版本锁定`，物证 `开源源码@magpie-2374ffe`，实现见 `internal/gateway/prompt.go:176`。

### 估计值与报告值

源码先按文本估算大小：ASCII 约四字符一个 token，非 ASCII 每个字符一个 token，图片使用固定估值 1600。这是快速估算，不是对应模型的 tokenizer。随后异步写入 trace，收尾再校准。以上为 `版本锁定`，物证 `开源源码@magpie-2374ffe`，见 `internal/gateway/prompt.go:77`、`internal/gateway/prompt.go:96`、`internal/gateway/prompt.go:1146`。

校准取 `Route.usage` 中最后一个用量条目的 `in + cache_read + cache_write`，按比例缩放每个分类和条目，四舍五入的分类余数补到最大分类。报告量不大于零、初始估计不大于零或已经校准时，不会再次缩放；`window` 可单独补入。条目层面的舍入不会逐项重新配平。失败请求也可能有校准值；最后一个用量条目不必来自最后一次尝试，不能无条件与 `window` 解释为同一次成功响应。`routeUsage` 还可能保留 Deferred 的独立计费项，它是计价层次，不是新增的一次尝试。以上为 `版本锁定`，物证 `开源源码@magpie-2374ffe`，见 `internal/gateway/prompt.go:260`、`internal/gateway/prompt.go:1106`、`internal/gateway/prompt.go:1122`、`internal/gateway/trace.go:825`。

因此建议界面分别表达：输入总量是否经过上游校准、分类占用来自本地分配、窗口容量是否已知。缺少 `prompt` 表示没有这份分析，缺少 `window` 表示分母未知。都不应显示成 0% 使用率。这里是 `推断`，依据同上。

### 容量取自哪个模型

路由收尾通过 `windowOf(lastTried, model)` 查询容量，再写回 `prompt`。查询先取 provider 的逐模型覆盖 `Contexts[model]`，再找实际服务目录中该 provider/model 的 `Entry.Context`，最后调用 `Provider.ContextOf(model)`。这个过程决定的是这条路由记录里的容量，不是重新测量模型极限。以上为 `版本锁定`，物证 `开源源码@magpie-2374ffe`，见 `internal/gateway/gateway.go:3517`、`internal/gateway/gateway.go:3537`、`internal/gateway/fallback.go:1351`。

Collector 应保留请求模型、所选 provider/model、上游报告的实际模型、容量及其采集时点。不能拿当前模型目录重新算历史请求的分母，也不能拿请求里的组名当作最终容量所属模型。这是 `推断`，依据为 `开源源码@magpie-2374ffe` 的 `internal/gateway/trace.go:58`、`internal/gateway/trace.go:119` 和上述容量查询路径。

## 模型、路由与窗口怎样联动

**窗口容量确实参与选路，展示用的 `Prompt.Window` 与选路用的输入估计属于不同路径。** 发送前用粗估过滤候选，失败后按溢流语义筛选剩余候选；规则路由还允许在回合中改选更大容量的成员。以下实现均属 `版本锁定`，物证 `开源源码@magpie-2374ffe`。

| 时机 | 实现与条件 | 对 collector 的含义 |
| --- | --- | --- |
| 给 Agent 声明组容量 | 未被显式容量或最小窗口策略覆盖时，组目录默认采用成员中的最大窗口，见 `internal/provider/group.go:1007` | Agent 的压缩时机可能依据组容量，而具体请求可能落在较小成员上 |
| 发请求前过滤 | `roomy`，见 `internal/gateway/fallback.go:1459`；调用点 `internal/gateway/gateway.go:2225` | 当前候选集与组的完整成员清单可能不同 |
| 同一回合按规则迁移 | `outgrown`，见 `internal/gateway/rules.go:346` | 接近容量后可以重新命中指向更大窗口的规则；不是自动挑全组最大模型 |
| 溢流失败后换模型 | `withRoom`，见 `internal/gateway/fallback.go:1415` | 同 provider 同 model 的另一个账号也装不下，换账号不解决容量问题 |
| 没有候选能容纳 | `roomy` 保留原候选，让错误到达 Agent，见 `internal/gateway/fallback.go:1501` | compact 是否发生由 Agent 的实现与策略决定，不能把网关错误当成压缩已完成 |

### 发送前过滤的门槛

`roomy` 不会对所有请求都做精确容量判断。它要求至少两个候选、至少两个不同的 provider/model 组合、至少一份已知窗口，并先用 `len(body)/4` 与最小已知窗口比较，足够大才解析请求。解析失败时保留原候选；容量未知的模型也保留。真正过滤时比较 `estimate(req) >= window`，至少还有一个候选留下才采用过滤结果。见 `internal/gateway/fallback.go:1460`、`internal/gateway/fallback.go:1478`、`internal/gateway/fallback.go:1485`。

这里使用选路自己的 `estimate(req)`，不能拿请求完成后已经校准的 `prompt.tokens` 反推发送前一定作出了相同判断。被过滤的小窗口候选暂存在 `small/smallW`，从计划顺序里移走；`roomy` 本身没有把过滤原因补进 `pl.left`。因此历史中的 `order/left` 不保证枚举了每个原始组成员及每次过滤的理由。见 `internal/gateway/fallback.go:1486`、`internal/gateway/fallback.go:1504` 和 `internal/gateway/gateway.go:2254`。

### 规则驱动的迁移

同一回合通常沿用已经命中的规则，避免每次工具往返都重新分类。`outgrown` 只在输入达到原规则目标容量的 95% 时重新找匹配规则，并且新规则必须指向已知容量更大的目标。它不凭容量自由创建新路由，也不保证存在可迁移的规则。见 `internal/gateway/rules.go:235`、`internal/gateway/rules.go:254`、`internal/gateway/rules.go:346`。

这给我们的启发属于 `推断`：一次模型变化应同时展示所命中的规则、是否沿用上轮规则、是否发生容量迁移，以及最后实际尝试。只展示新旧模型名称，会丢掉变化原因；只展示 `window`，也看不出组容量与成员容量的差别。

### 溢流后的候选

`withRoom` 排除与失败候选相同 provider/model 的其它账号，再排除已知窗口不够的候选，未知窗口仍允许尝试。它用于已经识别为溢流的失败路径，不能扩大成所有失败都按容量自动切换。见 `internal/gateway/fallback.go:1415`、`internal/gateway/fallback.go:1431`。

路由调度还包含额度、账号状态、亲和性和组内排序。容量过滤提供可行性约束，不取代这些策略。collector 应展示 magpie 已经留下的决策证据，不在查询时再运行一遍路由器来生成历史原因。这条建议属于 `推断`，依据为 `开源源码@magpie-2374ffe` 的 `internal/gateway/trace.go:84`、`internal/gateway/trace.go:89`、`internal/gateway/trace.go:91`。

### 模型容量与 Agent 工作窗口不同

magpie 还有单独的工作窗口设置。`Settings.Working` 会按 `Compact()` 限制告知 Agent 的容量；没有显式阈值且未启用 `FullContext` 时，默认工作窗口是 272000。逐模型和逐 provider 的压缩阈值以及用户手输容量又有优先级。因此模型本身可接收的容量、告知某个 Agent 的工作容量、Agent 真正开始压缩的位置，不能合并成一个字段。事实为 `版本锁定`，物证 `开源源码@magpie-2374ffe`，见 `internal/settings/settings.go:953`、`internal/provider/compact.go:44`。

collector 展示 `Prompt.window` 足够回答该路由最后一次尝试采用的容量。若要解释为什么 Agent 在远未填满时压缩，还需要对应 Agent 的实际配置和压缩策略；当前路由结构没有把这些历史配置全量快照下来。这个判断为 `推断`。

### Agent 的压缩预算也受配置影响

本轮基准相对旧研究新增了 DSH 输出预算修正：`dshMaxTokens` 将没有用户显式覆盖的默认输出额度限制到窗口的四分之一以内，显式值仍经 `outputOr` 保留，再写入 DSH 路由模型配置。这属于 Agent 配置适配，不能据此认为网关替 Agent 执行了压缩。事实为 `版本锁定`，物证 `开源源码@magpie-2374ffe`，见 `internal/agent/dsh.go:1513`、`internal/agent/dsh.go:1535`。

同文件注释说明 DSH 会从容量中预留输出和压缩余量，这是 magpie 作者描述的适配动机；本轮未读对应版本 DSH 实现并运行验证，因此不把注释中的阈值公式当作已实测的 DSH 行为。注释位置 `internal/agent/dsh.go:1503`，属于上述固定源码中的作者声明。

对 collector 的建议是观察压缩前后请求结构与明确的 compact 标记，避免从占用骤降或模型切换单独断言发生了自动压缩。需要解释 Agent 为什么压缩时，再补对应版本的 Agent 容量与输出预算配置证据。这是 `推断`。

## 上下文数据怎样取得

路由记录本身含 `prompt` 和用量明细 `usage`；后者可能包含 Deferred 独立计费项，不能按数组长度计尝试数。请求结束时序列化完整 `Route` 到日期分桶的 JSONL 文件，正文没有放进 `PromptItem`，只有名称、标签、数量和 token。这让 collector 能在不重复解析正文的前提下，保存结构与容量。以上为 `版本锁定`，物证 `开源源码@magpie-2374ffe`，见 `internal/gateway/trace.go:129`、`internal/gateway/trace.go:145`、`internal/gateway/history.go:75`。

历史保留策略是 30 天与总量 200 MiB，过期日期文件压缩为 `.jsonl.gz`。`historyMax=2000` 是上游历史读取函数每天最多返回的最新路由数，**不是每天写到文件里的记录上限**；直接读文件的 collector 不应照搬这个读取截断。保存错误被忽略，历史写入仍属于尽力而为。以上为 `版本锁定`，物证 `开源源码@magpie-2374ffe`，见 `internal/gateway/history.go:29`、`internal/gateway/history.go:73`、`internal/gateway/history.go:99`。

单笔请求可以保留多个 `tries` 和 `usage` 项。页面顶层仍按一笔客户端请求展示，展开后显示各次尝试，这不要求把重试拆成多条顶层请求。路由类型本身就采用 `Route.Tries[]` 和 `Route.Usage[]`，属于 `版本锁定`，物证 `开源源码@magpie-2374ffe`，见 `internal/gateway/trace.go:55`、`internal/gateway/trace.go:91`。展示建议属于 `推断`。

## 其它值得复用的机制

### 意图决策与推理档位

路由组的 classifier 在新用户回合需要意图或自动推理档位时，读取新消息及有界的上轮背景，输出意图和 effort。工具往返通常沿用该回合的结果；分类失败时可延用仍适用的上一回合意图。分类缓存、超时和失败冷却分别有独立预算。以上为 `版本锁定`，物证 `开源源码@magpie-2374ffe`，见 `internal/gateway/rules.go:267`、`internal/gateway/rules.go:305`、`internal/gateway/classify.go:35`。

这份决策证据已经在 `RuleHit.classified` 中，包含分类模型、候选意图、结果、score、sure、是否命中缓存、耗时、错误和 fallback；`RuleHit.pick/wanted/useEffort` 还区分决策模型想用的 effort、为缓存保留的 effort 和规则覆盖。collector 可以把它放在路由详情里，无需再调用一个模型解释为什么选了该模型。见 `internal/gateway/rules.go:26`、`internal/gateway/rules.go:80`，事实为 `版本锁定`，建议为 `推断`，物证同上。

这些字段足以观察决策，不足以证明模型选择质量。若未来比较节省了多少费用或是否降低任务成功率，需要额外的任务结果与对照实验；不能把 classifier 的 `sure` 当成路由正确率。这是 `推断`。

### 缓存感知的会话亲和性

`affine` 会考虑上次应答的账号、模型与 effort，以及会话、回合、缓存是否值得保留等条件，记录 `why=first/session/turn/cache/cold/spent/resting/gone/strict` 等结果。缓存亲和性使请求可能继续留在原账号，即使组的常规排序更偏向另一个账号。这解释了轮换策略与实际去向不总一致。以上为 `版本锁定`，物证 `开源源码@magpie-2374ffe`，见 `internal/gateway/affinity.go:458`。

collector 可以直接展示 `Route.affinity` 的理由，配合实际用量中的缓存读写；不能把 `why=cache` 当成本次已经命中缓存。前者是发送前对保留位置的决策，后者是请求结束后的上游计量。事实字段见 `internal/gateway/trace.go:87`、`internal/gateway/trace.go:145`；事实为 `版本锁定`，展示取舍为 `推断`，物证同上。

### 原生压缩会约束后续路由

模型选择还有一个容易忽略的约束：某些 provider 返回的原生 `encrypted_content` 只能由原账号或 key 继续读取。magpie 记录密封内容的 writer，后续请求据此限制去向；不能把它当普通缓存亲和性，随意改投另一个账号。记录类型与是否透传的条件见 `internal/gateway/native_compaction.go:59`、`internal/gateway/native_compaction.go:85`、`internal/gateway/native_compaction.go:118`、`internal/gateway/native_compaction.go:135`。以上为 `版本锁定`，物证 `开源源码@magpie-2374ffe`。

与此分开，Codex 请求压缩时，网关也可以经 `codexCompact` 请求摘要并封装成 `magpie1:` 项；失败路径可能改为文本重试，特定情况下使用本地摘要回退。这是客户端发起的压缩处理，不能概括成网关自主裁剪对话。另有同会话同模型的重复失败保护，最近连续三次失败后暂时拒绝重复请求，等待五分钟再尝试。事实为 `版本锁定`，物证 `开源源码@magpie-2374ffe`，见 `internal/gateway/codex_backend.go:2361`、`internal/gateway/codex_backend.go:2389`、`internal/gateway/codex_backend.go:2460`、`internal/gateway/codex_compact_guard.go:35`、`internal/gateway/codex_compact_guard.go:66`。

对 collector 的价值是解释某会话为什么不能自由换号，以及压缩请求为什么重复失败。可以展示已有 `Route.compaction`、请求种类、失败和尝试，保留密封内容的存在与来源，不把不可读内容伪造为可恢复的聊天历史。该取舍为 `推断`，路由字段依据为 `开源源码@magpie-2374ffe` 的 `internal/gateway/trace.go:66`。

### Context 页的推断需要筛选后再采用

magpie 的 Context 页用 token 曲线下降识别疑似压缩：前值至少 20000，后值低于前值的 60%。它还排除同会话中的标题、分类等辅助请求，避免把一个较短的旁路调用误认为主对话已压缩。算法为启发式，不能当协议明确标记。事实为 `版本锁定`，物证 `开源源码@magpie-2374ffe`，见 `internal/gui/context.go:164`、`internal/gui/context.go:179`、`internal/gui/context.go:230`。

这里值得借用的是先区分调用用途再计算会话变化。需要拒绝照搬的一处是窗口未知时默认用 200000 计算占用，见 `internal/gui/context.go:22`、`internal/gui/context.go:236`；collector 更适合明确显示分母未知。两项取舍为 `推断`。

Tune 还会基于历史的增长、压缩后大小和重读量模拟其它压缩阈值的费用与等待，再挑选建议值。可以把这种历史驱动的调参作为后续分析方向；模型是模拟结果，不能声称更换阈值后必然省下同样费用，也不自动应用配置。当前第一版暂不纳入。事实为 `版本锁定`，建议为 `推断`，物证 `开源源码@magpie-2374ffe`，见 `internal/tune/tune.go:223`、`internal/tune/tune.go:283`、`internal/tune/tune.go:377`。

### 一笔请求中的多次尝试

账本行不总与客户端请求一一对应。最终行携带 `tries`；某些拒绝与提示词被拒后继续换候选的路径，会额外写入 `handed_on=true` 的行，共享同一个 `route_id`。这些行保留失败尝试消耗的用量，不是新的客户端请求，也不代表整个请求最终失败。并非每种失败尝试都会单独入账，完整顺序仍看 `Route.tries`。以上为 `版本锁定`，物证 `开源源码@magpie-2374ffe`，见 `internal/usage/usage.go:163`、`internal/gateway/gateway.go:2939`、`internal/gateway/gateway.go:2973`、`internal/gateway/gateway.go:3549`。

这要求调整原来的摄入设想：通过网关的记录以一笔路由请求组织，账本可以贡献多个用量明细；不能每拉到一行就认定有一笔新请求，也不能按 `route_id` 去重时丢掉其它尝试的费用。direct/reported 与本地拒绝仍需分别处理，不能强行补一个路由 ID。这是 `推断`，依据同上。

### OTLP 的价值在尝试结构

OTLP 的属性主要从相同用量结构生成，但它提供请求 root span 和每次尝试的 child span，也接收合法 `traceparent` 作为父节点。observer 的 `Attempt` 包含没有计费的失败与重试，所以不能把 OTLP 概括为账本换一种格式。它还存在会话去重与抑制路径，并非开启后每个请求都必然按网关请求形态导出。以上为 `版本锁定`，物证 `开源源码@magpie-2374ffe`，见 `internal/otlp/request.go:21`、`internal/otlp/request.go:61`、`internal/otlp/request.go:87`、`internal/gateway/observe.go:71`。

如果目标扩展为跨系统分布式追踪，这条路值得重新选型；当前只做本机请求查看，hook、账本和路由结构已经更贴合需求，暂不增加 OTLP collector。这是 `推断`，不是对 OTLP 信息量的否定。

### 现成本地会话录制

magpie 已有可选的 `GatewayConversations` 本地录制。它在 middleware 和协议转换外侧记录客户端交换，要求客户端明确提供 session；没有 session 就不录。录制通过协议解析、脱敏和归一化转成 `GatewayTurn`，图片变占位符，并用 `cut` 标记截断。这份数据可以补充阅读，但不能替代 collector 要保留的原协议请求对象。以上为 `版本锁定`，物证 `开源源码@magpie-2374ffe`，见 `internal/gateway/conversations.go:59`、`internal/gateway/conversations.go:93`、`internal/gateway/conversations.go:122`。

存储在 `gateway-conversations/<UTC 日期>/<身份哈希>/turns.jsonl`，保留七天，总量预算 256 MiB；单条序列化上限 1 MiB，输入和输出方向各有约 64 KiB 的内容预算。它不是完整请求存档，覆盖范围也比使用 `session or conv` 的 collector 更窄。见 `internal/sessions/gateway.go:27`、`internal/sessions/gateway.go:76`、`internal/sessions/gateway.go:89`、`internal/sessions/gateway.go:127`，等级 `版本锁定`，物证 `开源源码@magpie-2374ffe`。

值得借鉴的是停止录制与清除数据的代际校验：请求开始时读 generation，提交前在锁内重新检查，防止清除后又被在途请求写回。这是可独立采用的存储规则，不要求复用它的会话文件格式。实现见 `internal/sessions/gateway.go:63`、`internal/sessions/gateway.go:122`；事实为 `版本锁定`，建议为 `推断`，物证同上。

### 原始交换的远端归档

另有请求归档，把脱敏后的请求与响应头、正文上传到用户自己的 S3 bucket，并通过账本的 `archive` 字段关联。它需要启用 `RequestArchive` 与可用 bucket，默认正文上限 32 MiB，上传队列最多 16 项，队列满会丢弃。这里的实现只接 S3 归档 bucket，不能从同步支持 WebDAV 推断归档也支持 WebDAV。以上为 `版本锁定`，物证 `开源源码@magpie-2374ffe`，见 `internal/gateway/archive.go:37`、`internal/gateway/archive.go:49`、`internal/gateway/archive.go:58`、`internal/gateway/archive.go:82`。

它说明原研究的正文只有 hook 需要收窄为：在当前本机旁路方案里，hook 是直接拿到客户端协议请求对象和合并回复的合适入口。magpie 还有归一化录制和远端原始交换归档，它们的保留、内容与部署条件不同。collector 继续 local-first，不为复用归档引入远端存储。这是 `推断`。

### hook 已经处理流式合并

`gatewayReply` 按客户端协议读取 JSON 或 SSE，把流合并成该协议的完整回复对象；Responses 优先使用 `response.completed` 中的对象。collector 不必再维护一套 SSE 解码器。但这份回复丢掉了原始事件时序和分片，不能称为逐字节原始流。以上为 `版本锁定`，物证 `开源源码@magpie-2374ffe`，见 `internal/gateway/gateway_hooks.go:39`。

`success=false` 也不等于没有回调。捕获错误、超限、HTTP 失败或不完整回复会走 `Finish`，回复可能是 `null`；正常回复还会检查 `error` 和 `status=failed/incomplete`。`Finish` 从客户端取消中分离，在有界后台任务中执行。宿主退出、run 超限或过期、插件超时仍会造成缺失。见 `internal/gateway/gateway_hooks.go:24`、`internal/plugin/gateway.go:191`、`internal/plugin/host.js:1277`、`internal/plugin/host.js:1291`、`internal/plugin/host.js:1357`，等级 `版本锁定`，物证 `开源源码@magpie-2374ffe`。

因此要区分上游调用失败、回调报告失败、正文不可用和没有收到回调。账本能证明发生过的请求，不能因 hook 丢失而从请求统计里删除；hook 单独观察到的请求，也不能因暂时没连到账本而丢掉。这是 `推断`。

## 可以集成到多深

结论是优先进行进程外的数据集成。原始请求对象由 hook 提供，权威用量从账本取，路由与上下文结构从 trace 和历史文件取。collector 负责保存、关联和查询，不复制路由决策器。此节取舍均为 `推断`；对应源码事实见各行。

| 方式 | 判断 | 依据与限制 |
| --- | --- | --- |
| 读取现成的路由与 `prompt` | 优先采用 | 结构已经随 `Route` 序列化，见 `internal/gateway/trace.go:33`、`internal/gateway/history.go:75` |
| 用 `/v1/magpie/trace` 追实时变化 | 可作为实时补充 | 内存只保留最近 60 条，见 `internal/gateway/trace.go:30`；仍需历史补齐，不能把它当持久队列 |
| 整体 import magpie 的 Go 分析包 | 不作为普通依赖方案 | 当前代码位于 `internal/gateway`，仓库模块为 `github.com/yetone/magpie`，见 `go.mod:1`；外部项目不能直接把该 internal 路径当公共库导入 |
| 移植 prompt 分类算法 | 仅在独立于 magpie 运行时考虑 | 分类与各协议、Agent 文案和工具识别绑定，见 `internal/gateway/prompt.go:232`、`internal/gateway/prompt.go:299`；会承担跟随上游的维护成本 |
| 把所有功能做成 Bun hook | 技术上能 I/O，可靠性需自建 | hook 本身支持异步 I/O，见 `internal/plugin/gateway.go:13`；宿主只提供有界生命周期，没有保证持久投递，见 `internal/plugin/gateway.go:191`、`internal/plugin/host.js:1277` |
| 完整 UI 放进 magpie 插件页 | 当前不推荐 | 页面授权读取项只有 `usage:summary` 与 `providers:list`，见 `internal/plugin/page.go:75`；不能据此获得正文库与完整路由查询面 |
| fork 网关补稳定事件出口 | 有明确采集缺口时再讨论 | 可以补关联与过滤原因，但引入维护上游的责任，本轮未实施或验证 |

**独立运行的 collector 加一个薄 hook，是当前可行的集成形态。插件不能持久化不是技术事实。** 保持独立的理由是需要独立管理保存、补齐和查询，以及避免把它们绑到有界 hook 回调的存活期。这比原 overview 中插件装不下的说法更准确。

关联仍经过 `hook 回复 ID → 账本 response_id → 账本 route_id → Route.id`。hook 的 `GatewayContext` 不含 route_id、conv 和 subagent 字段；session/cwd 等字段也可能为空。subagent 信息应从确有该字段的账本或路由记录补入，不能承诺从 hook 原样取得。事实为 `版本锁定`，物证 `开源源码@magpie-2374ffe`，见 `internal/plugin/gateway.go:79`、`internal/usage/usage.go:153`、`internal/gateway/trace.go:70`。连接建议为 `推断`。

旧实测中删除 `chatcmpl-` 能改善连接率，不能自动扩展为删除所有协议的所有 ID 前缀。实现应保留原 ID，并把已验证的规范化规则限定在对应协议与版本；出现多个候选时标歧义。`response_id` 未匹配成功的失败回调也应保留为待关联，不能靠时间接近强制合并。这是 `推断`，不修改原样本的命中结果。

## 开始实现前要落实的输入约定

这些是本轮研究得到的实现前提，等级均为 `推断`，不是已经完成的功能。

1. **路由历史及时入库。** 原 overview 的按需读历史应改为尽早摄入，避免请求正文还在、对应路由已超过上游保留期。实时 trace 用于补充变化，完成路由与历史落盘有时间差，读取不到时先留待补齐，不立即判永久缺失。读日期文件时处理 `.jsonl/.gz` 并存、追加到一半的末行和后续重读。
2. **保存一份路由原始结构。** 先保留 `Route` JSON 与来源版本，再按查询需要提取字段；不要预先压扁多次尝试、Deferred 用量与分类条目。实时 `seq` 是变更序号，不能与 `id` 混用。路由 ID 是从进程开始时的毫秒时钟继续计数，建议按采集来源加 ID 识别，避免将来多实例或时钟异常下误合并。分配路径见 `internal/gateway/trace.go:518`。
3. **保持缺失与歧义。** 至少区分有账本无正文、有正文待关联、路由未补齐、窗口未知、用量未报告、结构仅估算。匹配键冲突时保留原始候选，不把近似匹配升级为确定关系。
4. **区分三种输入规模。** 分别保留选路规则记录的 `rule.tokens`、用于展示的 `prompt.tokens/prompt.counted`，以及上游用量分量。前两种数值可能来自不同估算或校准过程，比较时明确口径。
5. **原协议对象与上游实际输入分开。** hook 位于 Agent middleware 之外，后续还有 middleware、脱敏、协议转换和逐 provider 改写。它适合回答客户端向网关提交了什么，不能保证是每个最终模型实际看到的逐字节输入。观察位置见 `internal/gateway/middleware.go:22`、`internal/gateway/middleware.go:62`。如果实际模型输入成为硬需求，要另选逐尝试观察或上游扩展，不能改个展示标签就声称满足。
6. **继续遵守凭证不落盘。** hook 输入在网关脱敏之前，collector 自己的落盘必须去除凭证；需要保留的是脱敏后的协议对象。不能把原文可检查误解成所有秘密都照存。此项沿用项目交接硬约束，本轮不改本机脱敏设置。

## 与旧研究的关系

旧文档优先研究身份与数据连接；本轮新增模型、路由、上下文和插件形态的分析。对相同代码的补读不能写成新版本新增功能。`prompt.go`、`trace.go`、`history.go`、`middleware.go`、`internal/plugin/host.js` 和 `internal/otlp/` 在两次源码基准之间的 `git diff` 为空，因此这些路径的补充结论主要来自研究范围扩大。此处为 `版本锁定`，物证 `开源源码@magpie-2374ffe` 与 `开源源码@magpie-2c3c903`。

两组仍需单独验证的问题不影响当前旁路方案。其一，原研究关于 conv 重新序列化的实测解释，与本轮读到的 `conversationID` 使用首条用户 JSON 元素字节的实现表面不一致，见 `internal/gateway/gateway.go:6378`。本轮没有重做对应采样，不能用源码直接推翻原观察；先保留两者的适用范围，并将解释列为 `未知`。collector 采用 magpie 给出的 conv，不自行复刻哈希，所以无需在实现前猜一个答案。其二，非 Chat 协议的回复 ID 匹配率未经本轮测量，不能将原样本的命中率外推过去。

## 事实来源与来源等级

| 等级 | 含义 | 稳定性 |
| --- | --- | --- |
| `版本锁定` | 针对特定客户端版本或特定源码快照逆向得到的实现事实，包括本地文件布局、落盘结构与源码控制流 | 任何版本发布都可能改变 |
| `实测` | 受控采集下可复现的行为，未被任何官方文档承诺 | 受客户端版本约束 |
| `推断` | 从以上事实外推的解析或判定规则，不是事实 | 不稳定，仅供参考 |
| `未知` | 当前证据不能推出的内容 | — |

- `开源源码@magpie-2374ffe`：上游 [yetone/magpie@2374ffe](https://github.com/yetone/magpie/tree/2374ffe161439b02a8e7f23b793461b39a635bf8)。本地 `origin` 指向 `git@github.com:yetone/magpie.git`，本轮只读核对固定工作树和对应源码。实现结论只到此提交。
- `开源源码@magpie-2c3c903`：上游 [yetone/magpie@2c3c903](https://github.com/yetone/magpie/tree/2c3c903974b65c145f9f009d83a2cf7e0fb3ee01)。仅用于与原研究对照，不把旧行号套到新树。
- `采集@2026-10-20-magpie-0.1.1294`：原研究声明的一次受控采集，本轮没有重做。正文需要引用时保留该 ID 与原时间范围。
- 本轮版本探测只调用 `GET /v1`，得到 `0.1.1294`，属于 `实测`，没有据此推断其它接口或功能的运行情况。

文中测试若出现，仅说明读过对应测试断言；本轮没有执行 magpie 的 Go/GUI 测试，没有发送真实模型请求，也没有开启录制或修改任何用户配置。
