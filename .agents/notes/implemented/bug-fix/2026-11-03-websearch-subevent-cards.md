# Agent Note: WebSearch 子事件卡的收起方案

Status: implemented

## Problem

2026-11-03 主页左栏在 16:25–16:26 出现 6 条 `(无标题)`、各 1 笔的 Claude Code 卡。只读核查（`sqlite3 "file:…trace.db?mode=ro"`，未写库、未重启）确认它们不是会话，是 Claude Code 侧 **WebSearch 工具执行的账本记录**：`["request",…]` 请求级卡是 `kind=web_search, source=search` 的检索子事件（`in/out=0`、无 route、无正文），`["conv","magpie-…"]` 卡是搜索执行本身（带真实用量，当时合计 $0.2398）。同族当时首屏 18 张，全库 136 张（claude 131 + zcode 5），`session` 全空；16:46/18:34 另四条是真实顶层会话，不属本族。

成因分三层，缺一不可：

1. **身份回退**：请求没有原生 session，`conv_key` 回退成请求级 `["request",…]`；路由有 conv 的则回退成 `["conv","magpie-…"]`。回退键各自成 1 笔组。
2. **用途判据依赖正文**：[claude.ts](../../../../src/harness/claude.ts) 的 `web_search` 辅助识别靠 user 尾部模板 `"Perform a web search for the query: "`。这批行 `hook_absent`、没有正文，模板判据无法执行，落到 [sourceDecision](../../../../src/semantics.ts) 的 `source.kind.v1` 兜底；该规则当时只把精确 `'title'` 判成 `exclude`，于是整族 `participate/main`。
3. **组从未派生**：[requestGroupTx](../../../../src/derive/state.ts) 在 `actor_state !== 'known'` 时返回 `null`，不建派生组。列表 SQL 的四个标题候选全部 `JOIN derive_queue`，组不存在 → 标题恒空、列表读原始列回退。

F31（判据缺口）与 F32（unknown-actor 组不派生）的证据条目在[监控核查记录](../../proposed/bug-fix/2026-11-03-monitoring-health-check-findings.md)；本文持有修复决策与交付结果。

## Decision

先止血、再补判定，组身份根治另立批次。本批交付前两层：

**P0：读侧 `tool_event` 标志与默认折叠。** [sessions.ts](../../../../src/queries/sessions.ts) 的宽聚合新增三个事实：`all_tool_search`（全组 `req_kind='source:web_search'` 且 `conv_source IN ('request','conv')`）、`has_session`（组内存在非空 session）、`cost_usd`（组内成本合计）。前两者成立且 `has_session=0` 时输出 `tool_event` 标志；[web/app.js](../../../../web/app.js) 与 probe/bypass/background 同通道默认折叠，[session-view.js](../../../../web/session-view.js) 的折叠条新增第三类「工具子事件」，报条数与这批成本合计。行、`conv_key` 与成本都不删除，`/api/stats` 口径不变。判据刻意不加 actor 条件：这批行没有 actor/session，`has_session=0` 已兜住「混入有归属行即真实会话」的反例。

**P1：`source.kind.v1` 增加不依赖正文的 web_search 判据。** [semantics.ts](../../../../src/semantics.ts) 的 `sourceDecision` 把精确值 `web_search` 判成 `exclude`、`kind='web_search'`、`modelTitle=null`，与尾部模板指纹（`claude.web-search.v1`）同一结论；`PURPOSE_VERSION` 10 → 11。

**P2（未做，另立批次）**：让 unknown-actor 组进入派生。需要哨兵改连接（`coalesce(r.actor,'')`）、重建视图、414 组回填，风险高；尺寸与耗时先在 `VACUUM INTO` 副本实测，不在生产库试。P2 还要处理正文不可读行的 retained 保留（见 Consequences），只放开 `actor_state` 闸门收不回这批行的结论。

## Alternatives considered

**把 `source:web_search` 加进 `PROBE_KINDS`。** 2 行，能收走 67 张 0 用量的 request 卡，但 69 张 conv 卡有真实用量（`has_usage=1`）不会折；文案也变成「探针记录」，与语义不符。

**只做 P1，宣称「规则已修」。** 存量行一个都不动（retained 保留旧解释，见 Consequences），截图问题依旧；且 67 张 request 卡连派生组都没有。

**读侧硬过滤**（列表 SQL 直接排除 `conv_source='request' AND miss_reason='hook_absent'` 等）。当天生效，但这批行从列表与搜索里彻底消失，折叠条无从计数，成本在会话视图里「看不见但还在」。属于遮了没治，不采纳。

**按时间窗 + `tool_use` 把 18 张挂回前序会话。** 没有外键、provider 也不同（搜索走 codex/workbuddy，父请求走 raccoon），16:25:11/14 四条连父会话都无法确证；错挂会把工具成本并进错误会话，且 `conv_key` 改写难以无痕撤回。放弃。

**直接 UPDATE 历史列或删除行。** 掩盖旧证据、丢调用与成本；存量应走显式 rebuild，而不是改列。

## Consequences

- 用户可见变化：同族 136 张默认不出现；折叠条显示条数与成本合计；展开后仍可点进详情。真实库 top50 实测折叠 20 张、合计 $0.2398（见 Testing）。
- 成本核算：行不删除，`/api/stats` 仍从 `request` 汇总；折叠条额外显示这批 `cost_usd` 之和，成本既不消失也不并入任何真实会话。
- **存量行不翻判**（修正了立项时的预期）：69 个 conv 行全部 `body_state='pending'` 且已存 version=10 的 `source.kind.v1` 解释；正文不可读时 [`unavailableDecision`](../../../../src/semantics.ts) 优先保留旧解释，rebuild 重派生只会写出 retained，不会落到新判据。因此本批**不做** 69 键的 rebuild（无效果写库），存量行数据层保持 `participate/main`，由 P0 折叠兜住展示。
- P1 的真实生效面是**未来行**：新 web_search 子事件首次结算时 `purpose_version` 为空、无旧解释可保留，`sourceDecision` 直接判 `exclude`；带 conv 的行进派生组后 `isAux` 推出 `aux`，走既有 bypass 通道。族不再向 `participate/main` 增长。
- P2 未做前，request 组的原始列保持旧值、标题仍空；这是已知残留，不是回归。P2 设计时必须回答「retained 保留与 exclude 新判据谁赢」，否则派生放开后这批行仍是主链。

## Testing

- 合成回归：[queries.test.ts](../../../../tests/queries.test.ts) — request/conv 两种来源的 web_search 组标 `tool_event` 且 `cost_usd` 正确，session 非空或 `source:chat` 有用量不标；[web.test.ts](../../../../tests/web.test.ts) — 折叠条三类计数与金额、零成本不带金额段；[semantics.test.ts](../../../../tests/semantics.test.ts) — web_search 无正文判 `exclude`、尾部模板命中同结论、来源 conflict 与近似拼写不收。
- 真实复核（只读，未写生产库）：四会话计数/成本/token 与基线逐项相等（336/$0.210465/1,940,595、124/$0.151715/1,028,728、96/$0.199038/1,545,537、20/$0.026095/216,369）；族清单 request 67 / conv 69；新读模型对生产库 top50：可见条目 0 张带 `tool_event`，折叠 20 张、成本合计 $0.2398，窗口覆盖 16:25–16:26 整批。

## Risks

- P0 判据是形态启发：若未来出现「整组 web_search 且无 session」的真实会话会被折叠。判据封闭在 `source:web_search` 一个 kind 上，混入任何其它 req_kind 或任何带 session 的行都留在列表。
- P1 把「来源单一为 web_search」的行判成辅助：若上游把普通对话也标成这个 kind，真流量会从主链消失。现有真实 web_search 均为账本子事件，反例用例锁住精确匹配与冲突回落。
- 版本 bump 之后，`verify` 类工具与未来 rebuild 的目标版本都抬到 11；回退判定需再 bump 一次。
