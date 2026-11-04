# Agent Note: Hermes 本地来源侦查——两套会话命名空间与调用级记录缺口

Status: implemented

## Problem

[覆盖矩阵](../../../../docs/agent-coverage.md)把 Hermes 排在批次 C，前置条件写成「先落地[多来源同一调用的身份归一](../../proposed/feature/2026-11-04-multi-source-call-identity.md)，再按网关侧 4,778 行与本地 state.db 对账，确认唯一命中率」。[覆盖矩阵提案](../../proposed/feature/2026-11-04-agent-coverage-matrix.md)给的理由是「补一个本地解析器会把同一批调用第二次送进库」。这两条判断来自生产库的证据构成与文件数统计，没有验证过本地库里的会话 id 能否与网关侧对上，也没有验证过本地库存不存在逐笔模型调用。批次 B 的[侦查记录](2026-11-04-batch-b-source-recon.md)说明只看文件规模会排错顺序，所以在决定批次 C 之前补一次只读侦查。

问题边界：这次只回答「本地 state.db 里有什么、能不能与网关侧对上、能不能还原逐笔调用」。不改覆盖矩阵的批次 C 与前置条件，不改去重提案，不写适配器，不动生产服务。

## Decision

记录三条只读实测结论，作为后续决定批次 C 的依据。按用户 2026-11-05 的方向选择，**路线暂不调整**，本记录不把结论升级为改判。

侦查只读 `~/Library/Application Support/tracery/trace.db` 与 `~/.hermes/state.db` 的元数据、聚合与键的交集；不读正文、账号、令牌与用户配置，不把任何真实值写进记录。

**一、两侧会话 id 零交集。** 网关侧 `request.agent='hermes'` 共 4,787 行，`session` 全为 NULL，`conv_key` 全非空且是 JSON 数组：`["conv", <31 字符>]` 4,720 行、`["hook", <36 字符 UUID>]` 69 行。抽出第二段得 588 个不同 id，与本地 `sessions.id`（162）、`sessions.session_key`（161，全部 90 字符）、`sessions.chat_id`（161）、`messages.session_id`（153）逐列求交集，命中都是 0。反向用本地三类 id 与网关侧 13,517 个不同 `ref_key` 求交集，同样是 0。`source_facts_json` 的顶层 key 是 `format`、`kinds`、`hook`、`selected`，`kinds` 下是 `ledger`/`route`/`state`/`value`，说明这批行由 magpie 的 hook 与账本合成，会话坐标是 magpie 侧的，与 Hermes 本地 `state.db` 的命名空间不同。「补本地解析器会把同一调用第二次送进库」在当前数据上不成立，因为两边不是同一批调用。

**二、本地库没有逐笔模型调用。** `~/.hermes/state.db` 有 105 MB，表含 `sessions`（162 行、65 列）、`messages`（11,523 行、30 列）、`session_model_usage`（247 行、18 列）、`session_admissions`（295 行）与 `messages_fts` 一套。`messages` 按 role 分是 tool 5,895、assistant 5,301、user 328；assistant 行的 `token_count` 全部为空、`platform_message_id` 全部为空，5,246 行有 `finish_reason`、4,985 行带 `tool_calls`，`message_uid` 全部有值。`session_model_usage` 是 `(session_id, model, billing_provider, …)` 的聚合行，247 行累计 `api_call_count` 5,975，单行最多 901 次调用，没有逐调用的时间或消息 id。`sessions.api_call_count` 累计 5,110 次，同样是会话级。`session_admissions` 是准入事件，`session_turn_leases`、`hosted_room_policy_transcript` 为 0 行。逐条消息能还原对话与工具往返，逐笔用量只存在于聚合值里，要建「一次模型调用一行」的 request 缺的是调用级记录，不是去重规则。

**三、时间范围重叠但粒度不同。** 本地 `messages` 与 `session_model_usage` 都覆盖 2026-10-26 14:58 到 2026-11-05 00:00，网关侧覆盖 2026-10-27 20:34 到 2026-11-05 00:00，时间没有缺口。网关侧 `started_ms`、`response_id_norm`、`in_tok`、`route_id` 分别有 4,784 / 4,585 / 4,690 / 4,690 行非空；`via` 是 `through` 4,548、`hook` 232。两侧数据在同一段时间都在产生，但身份与粒度各自独立。

这批结论不等于「去重提案没用」：该提案的实测对象是 zcode、Claude Code、Codex、OMP/Pi 与 droid 的本地会话对网关账本与 direct 行，637/637 与 585/585 的唯一命中来自那些来源，Hermes 不在它的实测样本里。它也不等于「Hermes 本地数据没价值」：162 个会话、11,523 条消息与工具往返可以作为会话与消息的补充证据，只是补不出逐笔调用。覆盖矩阵批次 C 的前置条件需要重估，重估要先明确「接 Hermes 想补什么」，本轮不做这个决定。

## Alternatives considered

**按零交集直接把 Hermes 降为不排期，或把批次 C 的前置条件改成别的。** 用户明确选择先记结论、路线暂不改。降为不排期会丢掉 4,778 笔网关侧行与本地 5.2 GB 数据可能的补充价值；改写前置条件则需要先定「一次调用一行」还是「会话与消息作补充证据」这个目标，属于产品判断，不该由一次只读侦查替用户拍板。本记录只提供事实，不改变矩阵与提案。

**把这三条写进覆盖矩阵正文，不另起 note。** 覆盖矩阵是「覆盖状态」这一事实的家，一次侦查的做法、否决的备选与代价按[文档标准](../../../../docs/AGENTS.md)归 note；矩阵正文若塞进 105 MB 库的表结构、交集算法与改判讨论，会变成既有快照又有论证。本轮按用户选择也不改矩阵正文。

**继续按原路线先落地去重，再回来接 Hermes。** 去重提案自身有价值，但用它当 Hermes 的前置不充分：即使做完，本地库仍缺调用级记录，逐笔用量只能继续以网关为准。把「后置条件不成立」提前记下来，避免投入之后才发现接不上；这不否决议案按自身判据单独推进。

**把 `session_model_usage` 的 247 行按 5,975 次调用摊成 request 行。** 聚合行没有逐调用时间、消息 id 与 token 分布，摊出来的行是造出来的，不是还原出来的，会污染 `request_evidence` 的 `ref_key` 与用量口径。批次 A 已把 Grok 的同类情况处理为「逐笔留 null、累计写 `session_usage`」，那是逐笔 assistant 行存在、只是缺用量；Hermes 连逐笔调用都不存在，不能照搬。

## Consequences

收益：批次 C 的前置条件从「一个未验证的假设」变成「有实测依据、待定目标」；下一次讨论 Hermes 时不必重扫 105 MB 库与 4,787 行网关数据。去重提案仍按自己的实测样本推进，不被这次零交集误伤。

代价：路线没有变干净，覆盖矩阵里「先解决去重」仍写着，读者需要同时看本记录才知道这个条件已被质疑。矩阵正文与提案 note 的批次 C 段落暂时保留原文，等目标明确后一次性同步，避免在同一轮里既记结论又改判。

后续判断点（不在本轮执行）：若目标是一次调用一行，本地 Hermes 的补充价值有限，逐笔用量继续以网关为准，批次 C 的实际工作会缩小为会话与消息证据；若目标是会话级补全，就要另定证据键与展示归属，并重新评估是否与 `request` 的记录单位冲突。两条路都要先回答「接 Hermes 想补什么」。

相关：[批次 B 侦查记录](2026-11-04-batch-b-source-recon.md)、[覆盖矩阵提案](../../proposed/feature/2026-11-04-agent-coverage-matrix.md)、[多来源身份归一提案](../../proposed/feature/2026-11-04-multi-source-call-identity.md)、[Hermes Agent 接入提案](../../proposed/feature/2026-10-27-hermes-agent-integration.md)。
