# Agent Note: responses 协议适配

Status: proposed

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

这个取舍在落地时是有记录的。`docs/architecture-design.md` 写的是「第一版实现 `anthropic` 与 `chat` 两个适配器，覆盖当前全部流量；`responses` 与 `gemini` 先保存、标记 `unsupported`」，`docs/acceptance.md` 也把「responses 标原对象已保存、没有逐条消息视图」列为一条验收结果。当时的前提是「覆盖当前全部流量」；Codex 走 magpie 之后这个前提不成立，做过的取舍要重做。补一个协议名单项不够。

还有一处后果不在页面上：`readPurposeViewTx` 用 `parse_state` 当闸门，`unsupported` 直接返回空视图，用途判定停在 `unsupported`，链归属与 `kind` 只能沿用既有值。这批 Codex 请求从未按自己的内容判过用途，适配之后它们的结论会变。

## Proposal

把「协议 → 消息数组键、文本块类型、工具调用、工具结果、系统提示」这几份形状知识收在一处，五条读取路径共用同一张表。不建插件框架，也不让浏览器依赖带 SQLite 读取的 `protocols.ts`；共用的只是几个纯函数。

### 形状

键名与类型取自本机真实流量的脱敏骨架，值不看、不抄进仓库。标准 Responses 形状按公开规范补全；本地样本里没出现的项，实现时以抓到的样本为准，不凭想象预写分支。

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

### 第一批支持范围

本机修复不需要实现整个 Responses API。第一批认这些形态：

| 形态 | 第一批行为 |
| --- | --- |
| `input` 数组，含 `message`、`function_call`、`function_call_output`、`custom_tool_call`、`custom_tool_call_output`、`reasoning` | 全部拆块，按 `type` 解释角色与工具往返 |
| `input` 裸字符串 | 拆成一条 user 消息，保留 Responses 的回归测试 |
| `instructions` 非空 | 并入系统文本，与 `developer` 消息同源合并 |
| 未知 `type` | 拆块保留原对象，角色记 unknown，指纹按整项计入 |
| 带 `previous_response_id` 的增量输入 | 正常解析，但本笔的上下文不完整，链关系不得判成 `confirmed` |

最后一行的边界在 `docs/architecture-design.md` 已经写过：Responses 的前序响应引用不能解释为本笔包含全会话历史。增量输入接在别处，本笔的 `input` 只是新增部分，拿它跟上一笔比共同前缀会得出错误结论。派生侧要么把这类请求标成关系未知，要么在比较前确认本笔确实是完整历史。

### 改动

**一张形状表。** 在 `src/protocols.ts` 导出「协议 → 消息数组键」，三个已知协议各一行（`anthropic` 与 `chat` 是 `messages`，`responses` 是 `input`）。提取、剥离、恢复三处读同一份来源：`body.ts` 的 `messagesOf`、`withoutMessages`、`readBodyTx`。只改前两处会让恢复出来的对象键名错位。

**语义指纹。** `fingerprint.ts` 的 `partOf` 增加 Responses 的工具项与文本块类型；`messageFingerprint` 在 `parts` 为空时退回整条消息的规范化 JSON。没有最后这条，`function_call`、`reasoning` 这类既无 `content` 也无 `tool_calls` 的顶层项会全部退化成同一个空指纹，两笔只在工具结果处不同的请求被判成完整前缀、增量算成空。这条 fallback 与 `partOf` 末尾「认不出的块按规范化 JSON 原样计入」是同一条原则，补在消息层而已。

**输入解释。** `input-interpretation.ts` 的 `textBlocks` 认 `input_text` 与 `output_text`。认不出它们，用户消息的 `is_input` 为假，轨迹里没有用户步骤，标题与轮次命令识别一起落空。这里走通用规则，不加 Codex 门控：未知与空 agent 标签同样生效。

**角色编码。** `roleCode` 对没有 `role` 的 Responses 项按 `type` 推断：调用与推理记 assistant，工具结果记 tool。留在 unknown 会让工具结果混进 user 块，污染用途判定读的 user 块首。

**解析适配。** `CAPABLE_PROTOCOLS` 加 `responses`；`parseProtocol` 里三处「anthropic 还是 chat」的二选一改成按协议查表，否则新协议会静默落进 chat 的实现。新增 `responsesMessageCount`、`responsesCalls`、`responsesResults`，路径写成 `request.input[i]` 与 `reply.output[i]`。`getBodyPage` 的系统文本来源加上 `instructions`，`systemPresent` 一并计入。

**派生抽取。** `derive/decision.ts` 的两个抽取入口加协议参数，按协议分派到同一份形状表。函数名带上 `anthropic` 而实际也处理 chat，已经名不副实，一并改成 `replyCallsOf` 与 `requestResultsOf`。调用点有 `derive/sync.ts`、`derive/slice/requests.ts`、`replyShapeOf`、`replyToolSummary`、`toolResultPreviewOf` 五处，全部要传协议。配对阶梯、增量判定与摘要算法都不动。

**回复文本与形状。** `assistantText`、`replyTextsOf` 认 `reply.output` 里的文本块；`replyShapeOf` 认 Responses 的 `status`。映射要保守：带有效工具调用的完成回复仍是工具循环，未完成与失败不判 `final`，状态缺失落 `unknown`。现有三态与轮次结算规则不变。

**系统提示。** `instructions` 要同时进四处：`getBodyPage` 的系统文本、`systemPresent`、用途侧的 `purposeSystemTextsTx`、前端 `topSystemText`。只补第一处会出现能力视图有技能、用途侧没有系统文本、轨迹没有顶层 System 的三种不一致。

**结果定位。** `reading.ts` 的 `RESULT_PATH_RE` 增加 `request.input[N]` 一支，读取分支按协议校验：Responses 认 `call_id`、读 `output`。前端 `trace-view.js` 与 `trace-pair.js` 里写死的 `request.messages[...]` 前缀跟着改成按协议取键。同 actor、同会话与 reading token 的检查不动。

**读侧渲染。** `web/body-model.js` 的 `replyView` 增加 `reply.output` 一支；`messageBlocks` 增加 Responses 顶层项一支，让请求历史里的调用与结果也能出块。块序号与路径沿用现有约定。

**hook 合并。** `hook.ts` 搬运正文时漏了 `adapter_version`，导致有正文的存活请求可以留着 NULL 版本。补齐这一列，否则回填按版本筛选会漏行。

### 版本与顺序

`ADAPTER_VERSION` 从 1 升到 2，回填按它筛选，条件写成 `adapter_version IS NULL OR adapter_version < ?`——NULL 是历史版本，不能当已处理跳过。

落地分四步，每步可独立运行、可回退：

1. 形状读取与无损恢复。形状表、指纹、输入解释、角色编码、回复文本与形状、系统提示、结果定位，全部按 `responses` 已存在但未拆块的状态写，不改生产写入布局。
2. 贯通派生与页面。派生抽取入口加协议参数，同步与切片两条路径都走通；读侧渲染补齐。
3. 启用拆块与版本升级。`CAPABLE_PROTOCOLS` 加 `responses`，`persistBodyTx` 开始按 `input` 拆块，`ADAPTER_VERSION` 升到 2。
4. 显式回填。新增 `bun run maintain reparse --db <path> --protocol responses`。

前三步的次序不能换。原先把拆块放在第一步，中间任何一次运行都会写出旧恢复代码读错的布局。

回填的契约：逐笔独立事务；先用 `validateSkeleton` 严格校验，不用只判断是不是对象的 `skeletonLike`；两种布局都要覆盖（`has_messages=false` 时完整请求在骨架里，`has_messages=true` 时先从块完整恢复再重写）；`partial` 明确拒绝，保留原状态与原因；失败行原样不动并报告原因；重复执行不新增块，也不无故推进输入修订。协议从骨架里的长期字段取，不依赖可能已过期的 `raw_hook`。

## 交付状态

四步全部交付。

- `src/protocol-shape.ts` 收下全部形状知识：消息数组键与形态、裸字符串输入的合成与还原、按 `type` 推断角色、文本块类型、回复侧调用、请求侧结果、增量输入判据。名单外协议一律返回空表。
- 骨架新增 `messages_key` 与 `messages_form`，恢复按记录放回原键与原形态；旧骨架缺这两项时按 `messages`/`array` 读，`validateSkeleton` 同时校验裸字符串形态的条数必须是一条。
- `persistBodyTx` 改走 `requestItemsOf`：`responses` 的 `input` 数组与裸字符串都拆进块库，骨架只留其余字段，恢复逐字相等。`CAPABLE_PROTOCOLS` 加 `responses`，`ADAPTER_VERSION` 升到 2，新写入的 `responses` 行 `parse_state` 为 `ok`。
- 指纹、输入解释、角色编码、系统提示（含 `instructions`）、回复文本与形状、派生抽取（`replyCallsOf`、`requestResultsOf`）、结果定位（`request.input[N]`）都已按协议工作；前端以 `BodyPage.protocol` 为准取键，不再写死 `request.messages` 与 `request.system`。
- 读侧渲染补齐：`replyView` 读 `reply.output`，块路径与序号按项定位（`reply.output[i]`，调用序号与 `tool_call.ord` 同口径）；`messageBlocks` 让无 `role` 的顶层项整项出块；`incomplete` 的原因抬到 finish，`completed` 不再触发「停止原因未知」。
- 增量输入的判据 `isIncrementalRequest` 住在形状表，同步与切片两条扫描路径都把它当「不可比」：本笔关系落 `unknown`，也不充当后续请求的祖先。端到端断言已随拆块启用落地。
- `hook.ts` 搬运正文时补齐 `adapter_version`，按版本筛选的回填不会漏掉有正文的存活行。
- `bun run maintain reparse --db <path> --protocol <name>` 按版本筛选逐行重写：严格 `validateSkeleton`、两种布局先完整恢复、`partial` 与损坏骨架拒绝并保留原状态、单行失败不影响其它行、重复执行无写入。命令与报告字段见[运维手册](../../../../docs/operations.md#reparse)。
- 文档同步：`docs/architecture-design.md` 的协议适配一节、`docs/trace-format.md` 的骨架字段与适配器范围、`docs/operations.md` 的 reparse 一节、`docs/acceptance.md` 的合成验收轮次。

本机库里已有的 `responses` 行尚未执行回填，Codex 会话仍停在旧布局；真实流量验收记录在验收文档里单独标为未做。

## Alternatives considered

**按字段猜协议，不按 `protocol` 分派。** 见到 `input` 数组就当 Responses，见到 `messages` 就当 chat。少一张表，但 `input` 在别的协议里可以合法指别的东西，猜错时错得很安静：消息照样进块，只是按错的角色与路径解释。架构评审已经定过按实际 `protocol` 分派，这里不翻案。

**只加 `CAPABLE_PROTOCOLS`，不动 `messagesOf`。** 解析层能读出条数、工具与回复，正文一栏仍然停在「原对象已保存」，因为块从未拆开。逐条消息与分页一样没有，只修好一半。

**只修 `parseProtocol`，不改派生抽取。** 这是最像已完成、实际最没用的一条：`parseProtocol` 的 `calls` 与 `results` 在生产代码里没有消费者，`tool_call` 表一行都不会多。页面看起来有了条数，工具页签仍是空的。

**旧行不修，只让新请求可读。** 省掉回填命令。代价是本机已有的这批 Codex 正文永久停在不可读状态，而它们正是接入验收要看的对象。数据在库里却读不出，比没有数据更难解释。

**读时懒重建：`adapter_version` 落后就在 `getBodyPage` 里重写。** 读取连接是只读的，写操作要抢写锁，页面滚动就能触发重建，等于把读路径变成写路径。重建的触发权应该留在显式命令手里。

**把 Responses 先归一成 chat 形状再走现有适配器。** 少写一套提取，但归一要丢字段、造出一个不存在的协议形状，以后回溯真实请求时对不上原对象。解析层应该解释原形状，不做改写。

## Acceptance criteria

每一条都要落成可执行的合成用例。真实正文不进 fixture。

| 验收对象 | 必须证明的结果 |
| --- | --- |
| 存储往返 | 非空数组、空数组、`input` 为字符串、未知顶层字段，经保存与恢复后与已脱敏原对象逐字相等 |
| 语义指纹 | 不同 `call_id`、不同参数、不同 `output`、不同未知项不产生相同指纹；两笔只在工具结果处变化的请求不被判成无新增的 `confirmed` |
| 输入阅读 | `input_text` 的用户消息与 `developer` 消息都能形成输入步骤、标题与摘要 |
| 系统提示 | `instructions` 与 `developer` 文本在能力视图、用途侧与页面侧一致可读，合并顺序与去重明确 |
| 工具往返 | 两笔请求经真实派生流程得到 `resolved` 配对，`tool_call` 落库，结果位置正确；HTTP 结果接口返回正确 `output` |
| 回复与轮次 | 纯文本完成、工具循环、未完成、失败四种回复分别得到正确的回复形状与轮次行为，含一条从用户命令到最终回复的结算 |
| 历史回填 | NULL 与旧版本都被处理；损坏骨架、缺失块引用、两种布局、单行写入失败各自有明确结果；成功行与失败行混合处理不互相影响；中断后可续跑；第二次执行无额外写入、不推进输入修订 |
| 回归 | Anthropic 与 chat 的恢复、指纹、分页、工具配对结果不变 |

现有把 `responses` 当作「未适配协议」样本的测试（`tests/protocols.test.ts`、`tests/capabilities.test.ts`、`tests/body.test.ts`、`tests/body-api.test.ts`）分两种处理：证明名单外协议的断言改用 `gemini`；`input` 为字符串那条保留，改成断言 Responses 自己的行为。

## Risks

- **用途判定会变。** 这批请求的链归属与 `kind` 从沿用值变成按内容判定，列表里的主链与旁路分组可能重排。回填必须连带重建派生，只改正文状态不够。
- **`input` 不是纯消息数组。** 它混着工具调用、工具结果、推理项与 Codex 自有项。块按项存，角色映射与工具配对要按 `type` 判定；漏判会把工具结果读成未知角色。
- **前序响应引用会让链判错。** 带 `previous_response_id` 的增量输入不包含完整历史，共同前缀比较会把两笔无关的请求连成父子。这是本方案唯一会污染派生结论的失败面，派生侧必须有明确判据。
- **骨架体积是隐性的第二处缺口。** 不剥离 `input` 的实现会让骨架随上下文线性增长，`req 13560` 的 30 KB 只是单轮请求，长会话每笔都会重存整段历史。验收要看骨架大小，不能只看页面能不能读出内容。
- **`instructions` 与 `developer` 消息并存。** 两者都承载系统级文本，合并顺序与去重会影响技能清单的判定。沿用现有 `systemTexts` 的合并方式，不新造优先级。
- **重命名会扩大 diff。** `anthropicReplyCalls` 与 `anthropicRequestResults` 改名并加参数，五个调用点都要动。分成独立提交，与行为改动分开，便于单独回退。
- **部分取代既有记录。** 实现时 `docs/architecture-design.md` 的「第一版只做两种适配器」段落要在同一变更里改写；`docs/acceptance.md` 的旧行按轮次保留，另起一轮记新结果；`tests/` 里以 `responses` 为未适配样本的断言同步换协议。这三处不跟改，文档与代码就会互相矛盾。
