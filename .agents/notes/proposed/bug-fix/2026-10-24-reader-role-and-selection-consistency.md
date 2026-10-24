# Agent Note: 阅读角色、步骤定位与缓存一致性

Status: proposed

## Problem

中栏把用户输入、助手文本和工具调用投影成步骤，右栏请求结构按原始消息的协议角色列出。两处标签承担不同含义，却共用相同的颜色与交互预期。工具调用在中栏显示工具，在右栏显示 ASSISTANT；Anthropic 工具结果承载在 user 消息里，右栏显示 USER；辅助请求的用途标签又与这些消息角色并列。把标签翻译成英文仍会保留这些歧义。

截图所指会话在 2026-10-24 的只读复核表明，首笔请求 req 108 有两条输入，回复包含文本与 Skill(ponytail) 调用；req 110 有四条输入，回复发起 Skill(memmy-memory)；req 114 有六条输入，回复发起后续工具调用。当前回复进入后续请求的历史属于正常时序。右栏输入消息不包含同笔回复中的 Skill，符合保存的数据；整组高亮、输入与回复的分离以及缺少步骤来源定位让页面显得落后一笔。

System 的显示也不完整。`projectSteps` 的类型没有 system，输入循环只保留可信 delta 中的 `isInput`。原始消息中的 system 和顶层 system 都没有中栏阅读入口。顶层 system 已保存在正文元信息的 `request_fields`，现有请求结构只列 `messages`。正文中的 `<system-reminder>` 则不能仅按文本外观改写成协议 System，同一消息可能同时包含真实用户输入与注入文本。

另有独立的内容陈旧与阅读缺失问题。R1–R4 已用合成输入复现，R5 的回复块定位由选择代码确认，请求组与步骤同时高亮已在真实页面复核；R6–R8 的后端输入反例见表：

| 编号 | 已验证情形 | 错误结果与代码证据 |
| --- | --- | --- |
| R1 | `readRequest(id, true)` 取得新 reading token | `fetchDetail` 清区间、消息、结构、delta、工具，但保留 `meta`；新详情继续配旧回复、旧请求字段与旧能力。见 [reader-store](../../../../web/reader-store.js) 的 `fetchDetail` 与 `readRequest`。 |
| R2 | 正文区间 GET 返回 409 | `readRange` 只删除失败的区间 Promise，详情与 `meta` 仍可直接命中；工具结果的失效又依赖 app 的局部处理，形成两套规则。见 [reader-store](../../../../web/reader-store.js) 的 `readRange`、`readToolResult`，以及 [app](../../../../web/app.js) 的 `loadStructure`、`readToolResult`。 |
| R3 | 首笔可信增量包含 81 条消息 | `loadWindowReads` 只消费两片，返回 80 条，`delta.done=false`；页面既不继续消费，也不显示续读或错误入口。见 [app](../../../../web/app.js) 的 `loadWindowReads` 与 [trace-view](../../../../web/trace-view.js) 的 `projectSteps`。 |
| R4 | 缓存含历史 ord 0–39 和可信新增 ord 99，结构游标停在 40 | `structureFoldHtml` 按 `structure.ords` 过滤后隐藏 ord 99，虽然该条已缓存且文案仍写新增 1 条。这符合现有连续历史分页的实现，缺陷在于没有所选/新增内容的定位入口，也没有说明已缓存尾部被排除。见 [app](../../../../web/app.js) 的 `structureFoldHtml`。 |
| R5 | 点击同一回复中的不同 Assistant 文本块 | `selectedStep` 保存了块键，`railBody` 只识别 `message:N`；回复步骤统一退回整份回复，不能定位当前块。请求组与步骤又同时高亮。见 [app](../../../../web/app.js) 的 `selectRequest`、`railBody`，以及 [index](../../../../web/index.html) 的 `.trace-group[aria-current]`。 |
| R6 | Chat 请求的system消息含分类器指纹，stop含`</block>`，回复`<block>no`，agent为claude | `readPurposeViewTx`把已去掉messages的骨架交给`systemTextsOf`，systemTexts为空，分类器落成普通chat并参与主链；同形状Anthropic顶层system可识别。见 [request-purpose](../../../../src/request-purpose.ts) 的 `readPurposeViewTx` 与 [body](../../../../src/body.ts) 的 `readBodyMetaTx`。 |
| R7 | 未适配的 responses 协议正文已完整保存 | `body_state=available` 与 `parse_state=unsupported` 可以同时成立；能力读取仅凭完整覆盖继续解释，导致 tools 报 missing、skills 却报 empty。页面缺少解释状态的区分，容易把完整保存读成已识别零技能。见 [protocols](../../../../src/protocols.ts) 的 `getBodyPage` 与 [capabilities](../../../../src/capabilities.ts) 的 `capabilityView`。 |
| R8 | Chat回复两个choices各含一个tool_calls[0] | 两个抽取器返回重复ord=0；`tool_call`主键为(req_id,ord)，同步派生写入会冲突。纯函数输入已复现重复ord，生产是否出现该形状未验证。见 [protocols](../../../../src/protocols.ts) 的 `chatCalls`、[derive-decision](../../../../src/derive-decision.ts) 的 `anthropicReplyCalls` 与 [schema](../../../../src/schema.sql) 的 `tool_call`。 |

R3 在上述截图会话的已保存请求里没有触发：该样本最大可信 delta 为 6。R4 的合成反例已确认，真实页面的跨页点击复核未完成，不能把它描述为真实会话验收通过。英文 ASSISTANT 标签在实际页面测得分配宽 58px、内容宽 61px，存在省略号裁剪。

本次评审覆盖与截图相关的采集后消息读取、协议解释、步骤投影、缓存、选择和右栏装配。它不等于对摄入、费用、保留、并发容量及所有派生算法做全仓审计。

## Proposal

角色标签统一使用 `System`、`User`、`Assistant`、`Tool`，辅助请求和异常记录分别使用 `Aux`、`Event`。前四项表示消息或内容的参与角色，后两项表示请求用途或事件，不能伪装成模型消息。所有 tag 使用英文；正文说明继续用中文。

工具调用由 Assistant 发出，主角色显示 Assistant，并以 `Tool call` 标明内容类型；工具结果显示 Tool，并以 `Tool result` 标明内容类型。工具名保留在摘要中。原始协议角色在详情中单列，例如 `role=user`、`type=tool_result`；Chat 的 developer 同样保留原始值。含文本与结果的混合消息按内容块解释，不能把整条 user 消息改成 Tool。中栏和右栏复用同一份内容块解释，避免两边分别猜测角色。

System 分两条路径处理：顶层 `request.system` 提供独立、紧凑的 System 阅读入口；`messages[N].role=system/developer` 按真实消息位置提供 System 步骤。每个 actor 的首个已加载主请求提供当前 System 上下文；后续仅在同一 actor 的已确认前驱可读、且内容变化时标明变化，前驱不在窗口或不可读时只提供当前上下文。不能按相邻时间跨actor、跨分支比较System。窗口起点、正文缺失和辅助请求不证明全会话首次出现或变更。System 的比较只在阅读层处理，不改变消息 ord、指纹、可信 delta 或前驱关系。首屏保持一行摘要，全文放右栏。

每个可读步骤携带明确来源，至少区分请求字段、请求消息内容块、本次回复内容块，并保留原始字段路径。`reqId + stepKey` 是选中身份，`owner + callOrd` 继续是工具结果读取身份。点击输入步骤定位请求消息，点击回复步骤定位本次回复，点击调用步骤定位本次回复中的该调用及其工具详情。右栏标题明确区分请求输入与本次回复；输入计数仍只计算 `messages`，System 字段独立计数，不给 `messages` 追加虚构历史。请求组可保留细微归属提示，明确选中高亮只落在当前步骤。

缓存失效在 `reader-store` 内统一处理。token 变化重置 `meta`、消息、区间、结构、delta、工具和路由；正文或工具结果返回 409 时，只有发起读取的记录与版本仍是当前记录才能将其作废，旧响应不能清除新版本。作废记录不得再次作为可用快照返回。app 的展示副本同步清除并显示阅读已变化，提供显式重新读取入口。此处保留现有不自动重试的决定。

结构的连续游标与稀疏已读消息继续分开。结构列表显示已缓存消息的有序并集，明确尚未读取的区间；定点读不推进连续历史游标。选中消息可直接按 ord 读取，无需先顺序加载全部历史。首轮两片增量预算保留，但剩余与失败状态必须提供续读或重试入口；未成功读取的 ord 不推进消费位置。

R6 修复用途阶段的取数：除骨架顶层 System 外，只解压 `request_block.role=2` 的 System/developer 消息，损坏时按用途失败路径处理，不静默宣称没有 System。用途解释版本需提升，已保存历史沿现有 `upgradePurposeTargetTx` 与会话维护入口重新结算用途、链和标题；正文不可读的结论保留并报告。现有入口会升级目标会话内全部旧目标行，执行时选择受影响会话，不能描述为只改其中的 Chat 行。普通 tick 继续保留已完成历史。

R7 保持原对象可读，`coverage` 继续描述保存覆盖，`parse_state` 表达协议能否解释；完整保存不证明技能可判定。未适配协议的工具与技能统一报 `missing/protocol_unsupported`，结构说明未适配，原字段与回复仍由现有正文元信息读取。无需新增 raw 端点，也不修改 `body_state` 使骨架被现有可读条件挡住。

R8 沿用本项目对多 choice 的现有范围：原对象可读，多 choice 不发布确定工具位置，两个工具抽取入口都跳过配对。工具配对判据变化提升组算法版本，并验证同步、切片和按会话恢复。若将来支持多 choice 配对，再设计包含 choice 身份的调用 Interface；不能把全局编号交给仍按 choice0 读取的工具结果 Interface。

上述方案不增加长期步骤表，不改变消息位置或协议对象，不需要删库或全库重建。R6/R8 沿既有入口重算受影响会话，先在合成库验证；真实库维护不在本轮执行。展示与缓存修复不要求重写历史。实施步骤见[修复计划](../../../../docs/superpowers/plans/2026-10-24-reader-role-and-selection-consistency.md)。

本提案拟部分取代[步骤投影](../../implemented/feature/2026-10-24-trace-step-projection.md)中仅用户输入进入轨迹的范围，以及[生产轨迹视图](../../implemented/feature/2026-10-24-single-trace-production-view.md)中按请求组高亮的呈现。稳定步骤键、请求身份、工具调用身份、最近窗口和原生 JavaScript 保持有效。[阅读缓存](../../implemented/feature/2026-10-24-reader-store-cache.md)关于两套游标、4 并发、失效和不自动重试的决定继续有效，本提案修正其实现与验收缺口。[单一轨迹生产阅读](../../implemented/architecture/2026-10-23-single-timeline-production-reader.md)保留数据归属、单 choice 定位和容量限制。

后端 supersession check 对照[用途与主链](../../implemented/architecture/2026-10-22-request-purpose-and-chain.md)、[服务端输入解释与能力阅读](../../implemented/feature/2026-10-22-server-side-input-interpretation.md)和[阅读身份与工具结果](../../implemented/feature/2026-10-24-reading-identity-tool-results.md)。R6 拟部分取代只解骨架、不解消息块的用途取数范围；版本化用途、严格正文、显式会话升级和不可读时保留继续有效。R7 补齐未适配协议的能力判定，R8 落实已有单 choice 限制，均保留其余决定。以上记录保持活跃并交叉链接；提案实施时同步受影响事实。

## Alternatives considered

**仅替换中文标签。** 成本最低，但工具调用仍与协议角色混在一列，System 与输入/回复定位继续缺失，不能解决截图中的阅读问题。

**把全部工具相关消息统一改成 Tool。** 会把 Assistant 发出的调用写成工具发言，并吞掉混合 user 消息中的真实文本。原始角色和内容块类型需要同时保留。

**右栏自动改看下一笔请求。** 下一笔可能是分类器、另一 actor 或并发分支，且本次回复已经在当前请求里。按时间跳下一笔会伪造归属。

**把本次回复追加为请求消息的最后一条。** 会改变消息计数和位置含义，使页面声称模型已收到尚未生成的回复。可统一阅读结构，但输入与回复必须分区并保留各自路径。

**一次读取整个会话或整份请求消息。** 会绕过已有窗口、分页和4并发预算。保留有界读取，用显式续读与定位解决缺口。

**为每种点击增加单独缓存清理。** 会复制已出现分叉的409逻辑。版本与记录的所有权在 reader-store，失效也必须归它管理。

## Acceptance criteria

- 同一内容在中栏、请求输入、回复与工具详情使用相同的英文角色标签；调用显示 Assistant + Tool call，结果显示 Tool + Tool result，原始协议 role 可见。
- 顶层 System 和消息数组中的 System/developer 都可阅读，消息 ord、原始 role、delta 和工具路径保持可追溯；混合 user 消息不被整体重标。
- req 108 / req 110 形状的合成会话能从选中 Skill 直接读到同笔回复中的调用，输入计数仍分别为2和4，结果另按已确认配对定位。
- 一个回复包含两个文本块和两个调用时，四个步骤分别定位原块；同一请求只有当前步骤获得选中高亮。
- token 更新后详情、System、回复与能力均来自新版本；正文和工具结果409后普通 `readRequest(id)` 重新走网络；旧版本迟到响应不覆盖或删除新版本。
- 缓存包含 ord 0–39、99 时，读过历史后仍可定位99，并明确40–98未读；结构游标仍停在40。
- 81条可信新增输入在首次80条后有续读入口，第81条可读取；空页或错误不标完成、不吞掉剩余输入。
- 英文标签在400/620/1000/1240px和深浅主题可完整识别，不引入水平页面滚动；正文与工具结果继续转义。
- 同形状Chat/Anthropic分类器输入均读取System指纹并排除主链，版本化用途重算在合成库验证，无法读取历史明确保留并报告。
- unsupported协议原对象仍可阅读，结构与能力标明未适配，不把未知技能报为零；多choice工具回复不发生派生主键冲突、不提供确定调用位置。
- 每个新回归先在旧实现失败，再在修复后通过；定向 Bun 测试、typecheck、文档门禁通过，合成浏览器与真实只读复核分别报告。

## Risks

System 在每笔请求重复绘制会挤占轨迹，需要以当前窗口上下文和可确认的变化控制重复；不可读正文之间不能推断未变化。增加工具结果步骤也要保留可信增量的限制，避免历史重发重复成新步骤。

展示角色归一化容易损失协议事实，尤其是 developer、未知 role、文本与结果混合。详情保留原始值，未知值显示 Unknown，不按文本标签猜角色。协议适配的进一步发现应以实际合成反例补入实施，不扩大成存储重构。

本轮只交付评审与提案。没有修改运行代码、数据库或采集器配置。评审开始时的五个前端及测试文件由其他工作提交进 `076ba6d`；后续并行修改了用量折叠行，经差异核对未涉及这里的角色、缓存、结构与选择缺陷。并行的摄入、派生与容量工作不属于本轮修改。前端阅读 59 项、协议/输入解释/正文接口 34 项测试和 typecheck 在评审基线通过，合成反例说明这些测试尚未覆盖上述缺陷。提案与计划补齐后，`verify:notes`、本轮已跟踪文档的补丁格式、新文档的格式/相对链接/代码路径检查通过。全工作区早先的 `git diff --check` 曾发现并行文件 `src/derive-slice.ts` 末尾多一个空行，该项未作为本轮修复或验收范围。
