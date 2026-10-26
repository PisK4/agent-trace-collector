# Agent Note: responses 协议适配

Status: implemented

## Problem

Codex 接进本机流量后，页面出现一类「正文全在、一条读不出」的请求：magpie 路把完整请求与回复存进了库，轨迹里没有一行内容，右栏只写「协议未适配」。

抽查会话 `01a1765f-478f-7df1-9d99-fedff3e7dcc9` 的两行可以把这个现象拆开。`req 13560` 走 magpie（`via=through`、`have=7`、`body_state=available`），`parse_state` 与 `reply_state` 都是 `unsupported`；`req 13565` 是同一笔的 OTLP 行，`body_state=summary`，本来就没有正文，这是 Codex 导出通道的正常形态。读不出内容的只有 magpie 那一行。

根因是 `protocol='responses'` 不在 `CAPABLE_PROTOCOLS` 里。Codex CLI 走 OpenAI Responses API，magpie 按客户端原始协议形状落库，于是这批请求没有任何消息进入消息视图。

缺口不止解析与存储两层。逐条读代码，实际有五处独立的协议读取路径，任何一处漏掉都留着一条读不通的路：

- 存储拆块：`messagesOf` 只认 `request.messages`。Responses 的消息数组在 `request.input`，取不到就让 `has_messages=false`，整段 `input` 原样留在骨架里。没有 `request_block` 行，块级去重不生效，分页也没有可翻的东西。`req 13560` 的骨架因此有 30,089 字节，而 hook 收到的请求对象是 70,223 字节。
- 无损恢复：`readBodyTx` 把消息拼回 `messages`。存储层一旦按 `input` 拆块，恢复出来的对象就会多一个 `messages` 键、少一个 `input` 键，原始脱敏对象对不上。
- 解析状态：`parseProtocol` 对名单外协议直接返回 `unsupported`，逐条消息、工具配对与回复侧全部缺失。
- 派生抽取：`derive/sync.ts` 与 `derive/slice/requests.ts` 调 `anthropicReplyCalls` 与 `anthropicRequestResults`，这两个只覆盖 Anthropic 与 chat。`parseProtocol` 返回的 `calls` 与 `results` 在生产代码里没有消费者，只被测试读。修好 `parseProtocol` 不会让 `tool_call` 表多出一行。
- 读取定位：工具结果接口用 `/^request\.messages\[(\d+)\](?:\.content\[(\d+)\])?$/` 认位置，`request.input[3]` 直接判 `invalid_location`；通过之后还要按 chat 的 `tool_call_id` 或 Anthropic 的 `tool_use_id` 校验，Responses 用 `call_id`。

这条链上还有三处只读回复文本或形状的地方，同样只认 `content` 与 `choices[].message.content`：`assistantText`（折叠行摘要）、`replyTextsOf`（用途判定）、`replyShapeOf`（轮次收尾）。页面就算渲染出完整回复，列表摘要与轮次带仍然是空的。

这个取舍当初是有记录的。`docs/architecture-design.md` 写的是「第一版实现 `anthropic` 与 `chat` 两个适配器，覆盖当前全部流量；`responses` 与 `gemini` 先保存、标记 `unsupported`」，`docs/acceptance.md` 也把「responses 标原对象已保存、没有逐条消息视图」列为一条验收结果。那个前提是「覆盖当前全部流量」；Codex 走 magpie 之后前提不成立，做过的取舍要重做。补一个协议名单项不够。

还有一处后果不在页面上：`readPurposeViewTx` 用 `parse_state` 当闸门，`unsupported` 直接返回空视图，用途判定停在 `unsupported`，链归属与 `kind` 只能沿用既有值。这批 Codex 请求从未按自己的内容判过用途，适配之后它们的结论会变。

## Decision

把「协议 → 消息数组键、文本块类型、工具调用、工具结果、系统提示、增量输入」这几份形状知识收在 `src/protocol-shape.ts` 一处，存储、恢复、解析、派生与阅读共用同一张表。不建插件框架，也不让浏览器依赖带 SQLite 读取的 `protocols.ts`；共用的只是几个纯函数。

**存储与恢复。** `requestItemsOf` 按协议取消息数组的键与形态：`anthropic` 与 `chat` 是 `messages` 数组，`responses` 是 `input`，且 `input` 允许裸字符串。裸字符串合成一条标准用户消息进块，`withItems` 恢复时逐字还原成字符串。骨架记录 `messages_key` 与 `messages_form`，恢复按记录放回原键，不按协议名二次推断；旧骨架缺这两项时按 `messages`/`array` 读，`validateSkeleton` 对裸字符串形态要求块恰好一条。

**解析与派生。** `CAPABLE_PROTOCOLS` 含 `anthropic`、`chat` 与 `responses`；`parseProtocol` 的条数、调用与结果全按形状表分派，名单外协议（如 `gemini`）返回空表并标 `unsupported`。`ADAPTER_VERSION` 为 2。派生抽取入口 `replyCallsOf` 与 `requestResultsOf` 收协议参数，`replyShapeOf` 对 Responses 只认 `status === 'completed'`：带有效调用判 `tools`，无调用判 `final`；`incomplete`、`failed`、缺失状态与缺 `call_id` 的调用项一律 `unknown`。配对阶梯、增量判定与摘要算法不变。

**语义指纹。** `partOf` 认 Responses 的文本块与工具项；`messageFingerprint` 在 `parts` 为空时退回整条消息的规范化 JSON。少了这条，`function_call`、`reasoning` 这类既无 `content` 也无 `tool_calls` 的顶层项会退化成同一个空指纹，两笔只在工具结果处不同的请求被判成完整前缀、增量算成空。

**输入解释与角色。** `textBlocks` 走 `isTextBlockType`，认 `input_text` 与 `output_text`；`roleNameOfItem` 对没有 `role` 的项按 `type` 推断：调用与推理记 assistant，工具结果记 tool。两条都是通用规则，不加 Codex 门控。

**系统提示。** `instructions` 同时进四处：`getBodyPage` 的系统文本、`systemPresent`、用途侧的 `purposeSystemTextsTx`、前端 `topSystemText`。只补一处会出现能力视图有技能、用途侧没有系统文本、轨迹没有顶层 System 的三种不一致。`systemTextsOf` 把 `instructions` 与 `developer` 消息并成同一份系统文本，顺序为先 `instructions` 后消息，沿用现有合并方式，没有新造优先级。

**结果定位。** `RESULT_PATH_RE` 认 `request.input[N]`，读取分支按协议校验：Responses 认 `call_id`、读 `output`，`raw` 返回整条结果项。前端按 `BodyPage.protocol` 取消息数组键与系统路径，不再写死 `request.messages` 与 `request.system`。

**读侧渲染。** `replyView` 读 `reply.output`，块路径与序号按项定位（`reply.output[i]`，调用序号与 `tool_call.ord` 同口径）；`messageBlocks` 让无 `role` 的顶层项整项出块，`reasoning` 出摘要或占位文案，两类工具调用共用 `callLabel`。`incomplete` 的原因抬到 finish，`completed` 归入正常收尾。

**增量输入。** `isIncrementalRequest` 只认 Responses 顶层的 `previous_response_id`，值必须是具体的响应 id；同步与切片两条扫描路径都把它当不可比：本笔关系落 `unknown`，也不充当后续请求的祖先。

**历史回填。** `bun run maintain reparse --db <path> --protocol <name>` 按 `adapter_version` 筛选逐行重写，命令与报告字段见[运维手册](../../../../docs/operations.md#reparse)。写入布局最后才改：先让读取与恢复认得 `input`，再启用拆块，中间任何一次运行都不会写出旧恢复代码读错的布局。

### 形状

键名与类型取自本机真实流量的脱敏骨架，值不抄进仓库；标准 Responses 形状按公开规范补全。

| 位置 | 事实 |
| --- | --- |
| 请求消息数组 | 顶层 `input`，元素带 `type`；`message` 项有 `role` 与 `content` |
| 请求消息数组的另一种形态 | `input` 可以是裸字符串，单条用户输入 |
| 角色 | 出现 `developer`；`ROLE_BY_NAME` 已把它映到 system 码 2 |
| 系统提示 | 顶层 `instructions`，不在 `input` 里 |
| 请求侧工具结果 | `custom_tool_call_output` 与 `function_call_output` 项，用 `call_id` 指向调用 |
| 回复消息 | `output` 数组；`message` 项 `role=assistant`，`content[]` 里是 `output_text` 一类块 |
| 回复侧工具调用 | `custom_tool_call`（`call_id`、`name`、`input`）与 `function_call`（`call_id`、`name`、`arguments`） |
| 回复 id | 顶层 `id`；`responseIdOf` 现有分支已能取到 |
| 回复完成状态 | 顶层 `status`，取值与 `stop_reason` 不是同一套 |
| 用量 | `usage.input_tokens`、`usage.output_tokens`、`usage.total_tokens` 与两族 details |

Codex 还会在请求里带 `additional_tools` 这类自有项，它不属于消息，按未知项原样保留，不解释也不丢。

### 支持范围

| 形态 | 行为 |
| --- | --- |
| `input` 数组，含 `message`、`function_call`、`function_call_output`、`custom_tool_call`、`custom_tool_call_output`、`reasoning` | 全部拆块，按 `type` 解释角色与工具往返 |
| `input` 裸字符串 | 拆成一条 user 消息，恢复逐字还原 |
| `instructions` 非空 | 并入系统文本，与 `developer` 消息同源合并 |
| 未知 `type` | 拆块保留原对象，角色记 unknown，指纹按整项计入 |
| 带 `previous_response_id` 的增量输入 | 正常解析，但本笔的上下文不完整，链关系落 `unknown`，也不充当后续请求的祖先 |

最后一行的边界在 `docs/architecture-design.md` 已经写过：Responses 的前序响应引用不能解释为本笔包含全会话历史。增量输入接在别处，本笔的 `input` 只是新增部分，拿它跟上一笔比共同前缀会得出错误结论。派生侧的判据就是 `isIncrementalRequest` 一处，不在各调用点各写一遍。

### 回填契约

逐笔独立事务；`validateSkeleton` 严格校验骨架，不用只判断是不是对象的 `skeletonLike`；两种布局都覆盖（`has_messages=false` 时完整请求在骨架里，`has_messages=true` 时先从块完整恢复再重写）；`partial`、正文缺失、损坏骨架与协议不符的行明确拒绝并保留原状态与原因；失败行原样不动，单行失败不影响其它行；重复执行不新增块，也不无故推进输入修订。协议从骨架里的长期字段取，不依赖可能已过期的 `raw_hook`。

## Alternatives considered

**按字段猜协议，不按 `protocol` 分派。** 见到 `input` 数组就当 Responses，见到 `messages` 就当 chat。少一张表，但 `input` 在别的协议里可以合法指别的东西，猜错时错得很安静：消息照样进块，只是按错的角色与路径解释。架构评审已经定过按实际 `protocol` 分派，这里不翻案。

**只加 `CAPABLE_PROTOCOLS`，不动 `messagesOf`。** 解析层能读出条数、工具与回复，正文一栏仍然停在「原对象已保存」，因为块从未拆开。逐条消息与分页一样没有，只修好一半。

**只修 `parseProtocol`，不改派生抽取。** 这是最像已完成、实际最没用的一条：`parseProtocol` 的 `calls` 与 `results` 在生产代码里没有消费者，`tool_call` 表一行都不会多。页面看起来有了条数，工具页签仍是空的。

**旧行不修，只让新请求可读。** 省掉回填命令。代价是本机已有的这批 Codex 正文永久停在不可读状态，而它们正是接入验收要看的对象。数据在库里却读不出，比没有数据更难解释。

**读时懒重建：`adapter_version` 落后就在 `getBodyPage` 里重写。** 读取连接是只读的，写操作要抢写锁，页面滚动就能触发重建，等于把读路径变成写路径。重建的触发权应该留在显式命令手里。

**把 Responses 先归一成 chat 形状再走现有适配器。** 少写一套提取，但归一要丢字段、造出一个不存在的协议形状，以后回溯真实请求时对不上原对象。解析层应该解释原形状，不做改写。

## Consequences

**用途判定会变。** 这批请求的链归属与 `kind` 从沿用值变成按内容判定，列表里的主链与旁路分组可能重排。回填会推进输入修订并标脏分组，派生结论在重算完成后才按新解释生效。

**骨架体积回到按新增增长。** `input` 拆块后骨架只留系统提示与其余字段；不剥离的实现会让骨架随上下文线性增长，`req 13560` 的 30 KB 只是单轮请求，长会话每笔都会重存整段历史。

**`input` 不是纯消息数组。** 它混着工具调用、工具结果、推理项与 Codex 自有项。块按项存，角色映射与工具配对按 `type` 判定；漏判会把工具结果读成未知角色。未知项不解释也不丢，指纹按整项计入。

**前序响应引用不再污染链。** 带 `previous_response_id` 的请求不判 `confirmed`，也不当祖先；代价是这类请求的增量序号恒为 `null`，摘要与工具配对按「没有本轮新增」的口径走。

**共享形状表有明确边界。** 名单外协议返回空表，新协议要加表行；存储、恢复、派生与阅读读同一份来源，改一处不会漏另一处。浏览器拿不到 TS，`web/body-model.js` 按 `BodyPage.protocol` 取键，与形状表同构，两边靠测试锁住。

**命名 diff 扩大了改动面。** `anthropicReplyCalls` 与 `anthropicRequestResults` 改名 `replyCallsOf` 与 `requestResultsOf` 并加协议参数，五个调用点同步改动。

**文档同步。** 协议适配范围、骨架字段、reparse 命令与合成验收轮次已在同一轮交付里改到[架构设计](../../../../docs/architecture-design.md)、[trace 格式](../../../../docs/trace-format.md)、[运维手册](../../../../docs/operations.md) 与[验收记录](../../../../docs/acceptance.md)。

## Testing

每一条都落成了合成用例，真实正文不进 fixture。

| 验收对象 | 锁定结果 |
| --- | --- |
| 存储往返 | 非空数组、空数组、`input` 为字符串、未知顶层字段，经保存与恢复后与已脱敏原对象逐字相等 |
| 语义指纹 | 不同 `call_id`、不同参数、不同 `output`、不同未知项不产生相同指纹；两笔只在工具结果处变化的请求不被判成无新增的 `confirmed` |
| 输入阅读 | `input_text` 的用户消息与 `developer` 消息都能形成输入步骤、标题与摘要 |
| 系统提示 | `instructions` 与 `developer` 文本在能力视图、用途侧与页面侧一致可读，合并顺序为 `instructions` 在前 |
| 工具往返 | 两笔请求经真实派生流程得到 `resolved` 配对，`tool_call` 落库，结果位置为 `request.input[N]`；HTTP 结果接口返回正确 `output`，`call_id` 不符判 `call_id_mismatch` |
| 回复与轮次 | 纯文本完成、工具循环、未完成、失败四种回复分别得到正确的回复形状与轮次行为，含一条从用户命令到最终回复的结算 |
| 增量输入 | 带 `previous_response_id` 的请求不判 `confirmed`，也不充当后续请求的祖先；判据只读骨架，不读消息块 |
| 历史回填 | NULL 与旧版本都被处理；损坏骨架、缺失块引用、两种布局、单行写入失败各自有明确结果；成功行与失败行混合处理不互相影响；第二次执行 `scanned: 0`，不新增块、不推进输入修订 |
| 回归 | Anthropic 与 chat 的恢复、指纹、分页、工具配对结果不变 |

原先以 `responses` 当「未适配协议」样本的断言改用 `gemini`；`input` 为字符串那条保留，改成断言 Responses 自己的行为。

本机库里已有的 `responses` 行尚未执行回填，Codex 会话仍停在旧布局；真实流量验收未做，与合成验收分开记录在[验收记录](../../../../docs/acceptance.md)。
