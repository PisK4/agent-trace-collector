# Agent Note: responses 协议适配

Status: proposed

## Problem

Codex 接进本机流量后，页面出现一类「正文全在、一条读不出」的请求：magpie 路把完整请求与回复存进了库，轨迹里没有一行内容，右栏只写「协议未适配」。

抽查会话 `01a1765f-478f-7df1-9d99-fedff3e7dcc9` 的两行可以把这个现象拆开。`req 13560` 走 magpie（`via=through`、`have=7`、`body_state=available`），`parse_state` 与 `reply_state` 都是 `unsupported`；`req 13565` 是同一笔的 OTLP 行，`body_state=summary`，本来就没有正文，这是 Codex 导出通道的正常形态。读不出内容的只有 magpie 那一行。

根因是 `protocol='responses'` 不在 `CAPABLE_PROTOCOLS` 里（`src/capabilities.ts`）。Codex CLI 走 OpenAI Responses API，magpie 按客户端原始协议形状落库，于是这批请求没有任何消息进入消息视图。

缺口分两层，只补一层不够：

- 解析层：`parseProtocol` 对名单外协议直接返回 `unsupported`，没有逐条消息、没有工具配对，回复侧同样标 `unsupported`。
- 存储层：`messagesOf` 只认 `request.messages`。Responses 的消息数组在 `request.input`，取不到就让 `has_messages=false`，整段 `input` 原样留在骨架里。没有 `request_block` 行，块级去重不生效，分页也没有可翻的东西。`req 13560` 的骨架因此有 30,089 字节，而 hook 收到的请求对象是 70,223 字节。

这个取舍在落地时是有记录的。`docs/architecture-design.md` 写的是「第一版实现 `anthropic` 与 `chat` 两个适配器，覆盖当前全部流量；`responses` 与 `gemini` 先保存、标记 `unsupported`」，`docs/acceptance.md` 也把「responses 标原对象已保存、没有逐条消息视图」列为一条验收结果。当时的前提是「覆盖当前全部流量」；Codex 走 magpie 之后这个前提不成立，做过的取舍要重做。补一个协议名单项不够。

还有一处后果不在页面上：`readPurposeViewTx` 用 `parse_state` 当闸门，`unsupported` 直接返回空视图，用途判定停在 `unsupported`，链归属与 `kind` 只能沿用既有值。这批 Codex 请求从未按自己的内容判过用途，适配之后它们的结论会变。

## Proposal

把「协议 → 消息数组键、工具调用、工具结果、系统提示」这四份形状知识收在一处，存储层与解析层共用同一张表，再让读侧按 `output` 渲染回复。

### 形状

键名与类型取自本机真实流量的脱敏骨架，值不看、不抄进仓库。标准 Responses 形状按公开规范补全；本地样本里没出现的项，实现时以抓到的样本为准，不凭想象预写分支。

| 位置 | 事实 |
| --- | --- |
| 请求消息数组 | 顶层 `input`，元素带 `type`；`message` 项有 `role` 与 `content` |
| 角色 | 出现 `developer`；`ROLE_BY_NAME` 已把它映到 system 码 2 |
| 系统提示 | 顶层 `instructions`，不在 `input` 里 |
| 请求侧工具结果 | `custom_tool_call_output` 与 `function_call_output` 项，用 `call_id` 指向调用 |
| 回复消息 | `output` 数组；`message` 项 `role=assistant`，`content[]` 里是 `output_text` 一类块 |
| 回复侧工具调用 | `custom_tool_call`（`call_id`、`name`、`input`）与 `function_call`（`call_id`、`name`、`arguments`） |
| 回复 id | 顶层 `id`；`responseIdOf` 现有分支已能取到 |
| 用量 | `usage.input_tokens`、`usage.output_tokens`、`usage.total_tokens` 与两族 details |

Codex 还会在请求里带 `additional_tools` 这类自有项，它不属于消息，按未知项原样保留，不解释也不丢。

### 改动

**一张形状表。** 在 `src/protocols.ts` 导出「协议 → 消息数组键」，三个已知协议各一行（`anthropic` 与 `chat` 是 `messages`，`responses` 是 `input`）。`body.ts` 的 `messagesOf` 与 `withoutMessages` 都读同一份来源，否则拆块与剥离会错位，骨架里会多存一份消息。

**解析适配。** `CAPABLE_PROTOCOLS` 加 `responses`；`parseProtocol` 里三处「anthropic 还是 chat」的二选一改成按协议查表，否则新协议会静默落进 chat 的实现。新增 `responsesMessageCount`（`input` 长度）、`responsesCalls`、`responsesResults`，路径写法沿用现有的 `reply.output[i]` 与 `request.input[i]`。`getBodyPage` 的系统文本来源加上 `instructions`，否则技能与工具清单对 Codex 永远显示缺失。

**能力提取。** `extractTools` 现在读 `request.tools` 数组与平铺的 `name`、`parameters`，Responses 的工具定义正好是平铺形状，预期不用改；用真实样本核对后再定。

**读侧。** `web/body-model.js` 的 `replyView` 增加 `reply.output` 一支：`message` 项拆成 text 块，`custom_tool_call` 与 `function_call` 拆成 call 块，块序号与路径从回复根算起，与另外两类协议同一套约定。工具配对仍按 `call_id`，前端配对逻辑不动。

**回填。** `has_messages=false` 时骨架保存的是完整请求对象，重拆所需的数据已经在库里，不需要原始 hook 回调。新增 `bun run maintain reparse --db <path> --protocol responses`，逐笔取出骨架，用新规则重走 `persistBodyTx`：同一事务里重写块引用与 `parse_state`，条数与 `adapter_version` 一起更新，`markRequestInputTx` 顺带把派生标脏。命令只处理 `adapter_version` 低于当前值的行，可重复执行；骨架损坏或形状不认的行逐条报告跳过原因，原行不动。

### 版本与顺序

`ADAPTER_VERSION` 从 1 升到 2，回填按它筛选。落地顺序是形状表、解析适配、读侧渲染、回填命令，四步各自提交；回填放最后，它依赖前三步到位。

## Alternatives considered

**按字段猜协议，不按 `protocol` 分派。** 见到 `input` 数组就当 Responses，见到 `messages` 就当 chat。少一张表，但 `input` 在别的协议里可以合法指别的东西，猜错时错得很安静：消息照样进块，只是按错的角色与路径解释。架构评审已经定过按实际 `protocol` 分派，这里不翻案。

**只加 `CAPABLE_PROTOCOLS`，不动 `messagesOf`。** 解析层能读出条数、工具与回复，正文一栏仍然停在「原对象已保存」，因为块从未拆开。逐条消息与分页一样没有，只修好一半。

**旧行不修，只让新请求可读。** 省掉回填命令。代价是本机已有的这批 Codex 正文永久停在不可读状态，而它们正是接入验收要看的对象。数据在库里却读不出，比没有数据更难解释。

**读时懒重建：`adapter_version` 落后就在 `getBodyPage` 里重写。** 读取连接是只读的，写操作要抢写锁，页面滚动就能触发重建，等于把读路径变成写路径。重建的触发权应该留在显式命令手里。

**把 Responses 先归一成 chat 形状再走现有适配器。** 少写一套提取，但归一要丢字段、造出一个不存在的协议形状，以后回溯真实请求时对不上原对象。解析层应该解释原形状，不做改写。

## Acceptance criteria

- 合成 Responses 请求（单轮纯文本、工具往返、`instructions` 非空、未知项存在）经 `persistBody` 后 `has_messages` 为真，`request_block` 覆盖全部 `input` 项，骨架里不再保留 `input`。
- `parse_state` 与 `reply_state` 为 `ok`；回复侧工具调用的 `call_id` 与请求侧结果配对成功。
- 页面上 Responses 行显示逐条消息、回复文本与工具行，工具卡能跳到配对结果；`instructions` 抽出的技能与工具清单不为缺失。
- 回填命令对本机现有 responses 行重跑后 `parse_state` 变为 `ok`、`msg_count` 与块引用一致，重复执行不产生新块。
- 回填后的会话里，这些行的用途不再停在 `unsupported`；`bun run maintain rebuild --session` 能排空它们的派生队列。
- 现有把 `responses` 当作「未适配协议」样本的测试（`tests/protocols.test.ts`、`tests/capabilities.test.ts`、`tests/body.test.ts`、`tests/body-api.test.ts`）改用 `gemini` 或其它名单外协议，断言内容不变。
- `anthropic` 与 `chat` 的块切分、条数与分页结果不因这次改动变化。

## Risks

- **用途判定会变。** 这批请求的链归属与 `kind` 从沿用值变成按内容判定，列表里的主链与旁路分组可能重排。回填必须连带重建派生，只改正文状态不够。
- **`input` 不是纯消息数组。** 它混着工具调用、工具结果、推理项与 Codex 自有项。块按项存，角色映射与工具配对要按 `type` 判定；漏判会把工具结果读成未知角色。
- **骨架体积是隐性的第二处缺口。** 不剥离 `input` 的实现会让骨架随上下文线性增长，`req 13560` 的 30 KB 只是单轮请求，长会话每笔都会重存整段历史。验收要看骨架大小，不能只看页面能不能读出内容。
- **`instructions` 与 `developer` 消息并存。** 两者都承载系统级文本，合并顺序与去重会影响技能清单的判定。沿用现有 `systemTexts` 的合并方式，不新造优先级。
- **回填的失败面。** 旧骨架里可能有 `skeletonLike` 不认的损坏对象。命令要逐行报告并跳过，不能中途整批回滚，把一半成功藏起来。
- **部分取代既有记录。** 实现时 `docs/architecture-design.md` 的「第一版只做两种适配器」段落要在同一变更里改写；`docs/acceptance.md` 的旧行按轮次保留，另起一轮记新结果；`tests/` 里以 `responses` 为未适配样本的断言同步换协议。这三处不跟改，文档与代码就会互相矛盾。
