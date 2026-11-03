# Agent Note: WebSearch 子事件卡（18 张）的收起方案

Status: proposed

## Problem

### 现象

2026-11-03 主页左栏在 16:25–16:26 出现 6 条 `(无标题)`、各 1 笔的 Claude Code 卡；同一族在当前库里共 18 张：14 条 `["request",…]` 卡 + 4 张 `["conv","magpie-…"]` 卡（标题 `<model> · <time>`）。另有 16:46 的 Scout（96 笔，缺正文 `o`）与 18:34 的三条（336 / 124 / 20 笔）。

只读核查（`sqlite3 "file:…trace.db?mode=ro"`，未写库、未重启）结论：

- 这 18 张不是会话，是 Claude Code 那侧 **WebSearch 工具执行的账本记录**。14 条 `["request",…]` 是 `kind=web_search, source=search` 的检索子事件，`in/out=0`、无 route、无正文；4 张 conv 卡是搜索执行本身，带真实用量（合计 $0.2398）。
- 16:46 / 18:34 四条是**四个独立顶层 Claude 会话**：`4abeeb02`（336）、`189dd9bd`（124）、`ad65da93`（20）、`97cedc47`（96）。它们各自一份 transcript、`isSidechain=false`、`subagent/parent_agent` 为空；18:34 同时冒头是同一次 `<gugu_delivery>` 编排广播，不是父子会话。
- 成因分三层，缺一不可。

### 证据表（本文修复对象）

| 类型 | req_id | conv_key 尾部 | started_ms | 本地时间 | 成本 |
| --- | --- | --- | --- | --- | --- |
| request | 94256 / 94257 / 94258 / 94259 | 59553198 / 59553467 / 59553736 / 59554005 | 1793694311497 | 16:25:11.497 | 0 |
| request | 94243 / 94244 / 94245 / 94248 / 94249 / 94250 / 94286 / 94287 | 59548332 / 59548601 / 59548870 / 59550520 / 59550788 / 59551056 / 59563940 / 59564209 | 1793694314098 | 16:25:14.098 | 0 |
| request | 94253 / 94254 | 59552181 / 59552426 | 1793694372062 | 16:26:12.062 | 0 |
| conv | 94242 / 94247 / 94255 / 94285 | `magpie-2a849…` / `magpie-a99ba…` / `magpie-b3392…` / `magpie-a34fe…` | 16:25:14 / 16:25:11 | — | $0.0628 / $0.0537 / $0.0761 / $0.0472 |

14 条 request 卡共同字段：`conv_source=request`、`req_kind=source:web_search`、`purpose_status=recognized`、`purpose_chain=participate`、`chain_role=main`、`via=through`、`body_state=pending`、`have=2`（只有账本位）、`miss_reason=hook_absent`、`actor=NULL`、`session=NULL`、`title_source=model_time`、`model_title=NULL`。

当前全库同类卡：`claude request` 67 张（0 成本）、`claude conv` 64 张（$1.4319）、`zcode conv` 5 张；`session` 非空的 0 张。这就是“工具子事件族”，没有一张属于真实会话。

### 三层成因

1. **身份回退**：请求没有原生 session，`conv_key` 回退成请求级 `["request",…]`；路由有 conv 的则回退成 `["conv","magpie-…"]`。回退键各自成 1 笔组。
2. **用途判据依赖正文**：[claude.ts](../../../../src/harness/claude.ts) 的 `web_search` 辅助识别靠 user 尾部模板 `"Perform a web search for the query: "`。这些行 `hook_absent`、没有正文，模板判据无法执行，落到 [sourceDecision](../../../../src/semantics.ts) 的 `source.kind.v1` 兜底；该规则只把精确 `'title'` 判成 `exclude`，`web_search` 不在名单里，于是 `participate/main`。
3. **组从未派生**：[requestGroupTx](../../../../src/derive/state.ts) 在 `actor_state !== 'known'` 时返回 `null`，不建派生组。全库 414 个 `["request",…]` key、414 行，`derive_queue` 命中 **0**。列表 SQL 的四个标题候选全部 `JOIN derive_queue`，组不存在 → 四候选全空；`SESSION_TITLE_GUARD_SQL` 同样不成立；`bypass` 也永远标不出来。列表只能读 `derivedColSql` 的原始列回退，于是显示 `main/participate`、无标题。

### 与 F31 / F32 的关系

F31（`source:web_search` 被判成主链参与，实为辅助）与 F32（unknown-actor 的 `["request",…]` 组从不进派生队列，标题恒空）已在[监控核查记录](./2026-11-03-monitoring-health-check-findings.md)归档为证据条目。本文只持有这两条的**修复方案与验收口径**，不改动那篇笔记；两边的编号互链即可。

### 已验证范围

- 已实测：18 张卡的全部字段、414 个 request key 与 0 个派生组、四会话的 `conv_key`/计数/成本、64 张 conv 卡的成本、transcript 的 `tool_use` 时间与 `gugu_delivery` 头。
- 未实测：16:25:11/14 四条与 `97cedc47` 的父子归属（route 上 `session=NULL`，只有时间与工具调用吻合）；派生 414 个新组的实际耗时。

## Proposal

先止血、再补判定、最后才动组身份。**推荐 P0（展示层折叠）今天做，P1（判定层）同批做但明确它只解决一半，P2（结构根治）另立批次。**

### P0 止血：新增 `tool_event` 标志并默认折叠

在[会话列表](../../../../src/queries/sessions.ts)的聚合列增加两个事实：`has_session`（组内是否存在非空 `session`）与 `cost_usd`（组内成本合计）。新增标志：

```
tool_event = conv_source IN ('request','conv')
           AND 组内所有 req_kind = 'source:web_search'
           AND has_session = 0
```

命中后由页面默认折起，折叠条走一条新通道「工具子事件」。**不删除行、不改 `conv_key`、不补正文。**

- 改动面：`src/queries/sessions.ts` +8～12 行；`web/app.js` +1 行（`folded()` 加 `tool_event`）；`web/session-view.js` +8～10 行（第三类计数与文案）；`tests/queries.test.ts` +40 行。
- 用户可见变化：这批卡默认不出现；折叠条显示条数与**成本合计**；展开后仍可点进详情。命中范围为全库同类 136 张（claude 131 + zcode 5）——比截图里的 18 张多，是因为 16:25 只是当前窗口的一批；按形态整体收走才是自洽口径。
- 成本核算：行不删除，`/api/stats` 仍从 `request` 汇总；折叠条额外显示这批 `cost_usd` 之和（当前 $1.4319 + zcode）。成本既不消失，也不被并进任何真实会话。
- 回填：**不需要**。只改读模型与渲染。
- 风险：极低。`has_session=0` 保证 4 个真实会话（都有 `session`）不受影响；标志可一行删除回退。
- 可逆性：完全可逆，纯读侧。

### P1 判定层：`source.kind.v1` 增加不依赖正文的 web_search 判据

在 [sourceDecision](../../../../src/semantics.ts) 增加 `kindValue === 'web_search'` → `exclude`、`kind='web_search'`、`chain='exclude'`、`modelTitle=null`，与 `tailTemplateDecision` 的输出保持一致。

**必须写清的两个事实（与 F32 的前提有出入）：**

- 对 14 张 `["request",…]` 卡：**单独做这一条，收起效果为零**。它们没有派生组，列表读原始列回退，改名单不会改变任何一行。
- 对 64 张 `["conv","magpie-…"]` 卡：**单独做这一条是有效的**。这些 conv 组都已在 `derive_queue`；[`upgradePurposeTargetTx`](../../../../src/request-purpose.ts) 在 `purpose_target < PURPOSE_VERSION` 时标脏重派生，`isAux = purpose_chain === 'exclude'`（[sync.ts](../../../../src/derive/sync.ts)）会把 `chain_role` 改成 `aux`，列表出现 `bypass`，走既有折叠。也就是说，截图里 4 张 conv 卡能被 B 收走，14 张 request 卡不能。

因此 B 与 P0 不是替代关系：P0 负责让 14 条今天就不出现；B 负责让 4 张 conv 卡在数据层自描述为辅助，避免以后换读侧又露出来。

- 改动面：`src/semantics.ts` +6～8 行；`tests/queries.test.ts` / `tests/purpose.test.ts` +30 行。
- 回填：需要一次版本 bump 触发的重派生（限于已有 conv 组），**不覆盖** 414 个 request 组。
- 风险：中低。若某真实会话的 source 全组一致为 `web_search` 且无正文，会被判辅助；现有真实 web_search 均有正文，模板判定结果同为 `web_search/exclude`，行为不变。需要反例用例。
- 可逆性：改规则 + bump 版本即可回退，但历史已重派生，需再 bump 一次。

### P2 根治（本批不做）：让 unknown-actor 组进入派生

去掉 `actor_state !== 'known'` 闸门只是第一步；真正的成本在**组身份**：

- `deriveJoinSql`、[schema-v6.sql](../../../../src/schema-v6.sql) 的视图、`requests.ts` / `turns.ts` / `session-summary.ts` 以及标题 SQL 全部按 `q.actor = r.actor` 连接；`actor` 为 NULL 时永远连不上。
- 因此必须引入哨兵（如 `''`），把连接改成 `coalesce(r.actor,'')`，并重建视图（新 schema 版本 + `schema_rebuild_required` 流程）。
- `purposePendingSql`、`upgradePurposeTargetTx` 也都显式过滤 `actor_state='known'`，需要一并放开。

**判据可靠性**：这些组没有 actor/session，唯一可靠的判据是 P1 的非正文规则（source kind = `web_search`、无正文、无用量、无 session）→ `exclude`。`chain_role` 由 `exclude` 推出 `aux`（`sync.ts` 的 `isAux`），不需要父指针；1 行组也不会被错配成主链。

**规模与耗时（测量方法，不靠猜）：**

- 结构上已知：+414 组 / 现有 1,137 组（+36%）；+414 行 / 53,139 行（+0.78%），且每个组恰好 1 行、无正文，判定路径最短。
- 实测方法：`sqlite3 "file:$DB?mode=ro" "VACUUM INTO '/tmp/trace-copy.db'"` 生成副本 → 用副本跑一次完整 `derive`（`time` 包裹，先跑基线、再跑含新组的版本）→ 比较 `derive` 墙钟与 `event_loop.max_ms`；再在 `tests/derive*.test.ts` 里用 414 组合成 fixture 计时，给出单组均值。不要在生产库上试。
- 排序 / 活跃 / `live`：不受影响。`live` 与 60 秒窗口按行的 `last_ms` 计算（`web/app.js` 的 `livePartition`），与组身份无关；排序同样按 `last_ms`。会变的是分页与总数——所以 P0 先折叠，避免总量突变。
- 风险：高。需要视图重建 + 414 组 backfill + 重派生，和监控笔记里已记录的写锁竞争窗口同源；应另开维护窗口。
- 可逆性：中。哨兵与连接改动可回退，但已写入的 414 个派生组需要清理或保留（保留也不影响，只是多 414 行 `derive_queue`）。

### P0 与 P2 的取舍

P2 让数据自描述，读侧不再依赖形态启发；P0 是立刻见效、零 backfill 的止血。若先做 P2，414 个新组会先以 `participate/main` 派生一遍，仍需要 P1 才有 `aux`，再重派生一次，等于两轮写库；且期间列表总量会先变。故顺序定为 **P0 → P1 →（另批）P2**。

### C（读侧硬过滤）与 D（归并）

- **C：列表 SQL 直接排除**（`conv_source='request' AND miss_reason='hook_absent' AND have<3` 等）。3～5 行、当天生效，但买来三个问题：这些行从列表与搜索里彻底消失，只能靠 `conv_key` 直接访问详情（[listRequests](../../../../src/queries/requests.ts) 仍可用，但没有 UI 入口）；折叠条无从计数，成本在会话视图里“看不见但还在”；属于“遮了但没治”。**只作 P0 的应急替代，不推荐。**
- **D：按时间窗 + `tool_use` 把 18 张挂回前序会话**。没有外键、provider 也不同（搜索走 codex/workbuddy，父请求走 raccoon），16:25:11/14 四条连父会话都无法确证。错挂会把工具成本并入错误会话，且 `conv_key` 一旦改写就难以无痕撤回；也违反“不伪造父子关系”。**放弃。** 若未来重启：门槛必须唯一命中（同一 agent、同一 folder、父请求结束到搜索开始 ≤5s、该窗口内只有一个 in-flight 请求），并写 `merge_event` 审计表保留原 `conv_key` 才可撤回。

## Alternatives considered

**把 `source:web_search` 加进 `PROBE_KINDS`。** 2 行，能收走 67 张 0 用量的 request 卡，但 64 张 conv 卡有真实用量（`has_usage=1`），不会折；文案也变成“探针记录”，与语义不符。不足以覆盖目标。

**只做 P1，宣称“规则已修”。** 4 张 conv 卡会消失，14 张 request 卡纹丝不动，截图问题仍在。

**只做 C，不动渲染。** 见上，牺牲可观测性与成本可见性。

**只做 P2，不补 B。** 414 组会以 `participate/main` 派生，标题仍是空的、卡仍在，只是多写了 414 组数据。

**直接 UPDATE 历史列或删除行。** 掩盖旧证据、丢调用与成本；存量应走显式 rebuild，而不是改列。

## Acceptance criteria

### 合成回归

- `tests/queries.test.ts` 新增：`conv_source='request'` + `req_kind='source:web_search'` + `session=NULL` 的 1 笔组 → `flags` 含 `tool_event`、默认折叠；展开后可见、详情可进。
- `conv_source='conv'` + 同 kind + 带成本 → 同样 `tool_event`，且折叠条的 `cost_usd` 合计包含它；`sum(cost)` 与修复前一致。
- 真实会话 fixture（或现有 336/124/20/96 快照）→ 无 `tool_event`、计数/成本/标题不变。
- 反例：`conv_source='request'` 但 `session` 非空，或 `req_kind='source:chat'` 且有用量 → 不得折叠。
- P1 用例：`source.kind=web_search` 无正文 → `exclude/aux`；有正文且尾部模板命中 → 仍 `exclude/aux`（同一结果）；混组（state≠single/agree）→ 不命中。

### 真实复核（只读，不写生产库）

1. 族清单（应全部被折叠，0 张以普通会话出现）：
   `SELECT conv_source, count(*), count(DISTINCT conv_key), round(sum(cost),4) FROM request WHERE req_kind='source:web_search' AND session IS NULL;`
   基线：`request` 67 / 0；`conv`（claude）64 / $1.4319；`zcode conv` 5。
2. 四会话不变：
   `SELECT conv_key, count(*), round(sum(cost),6), sum(in_tok+out_tok) FROM request WHERE conv_key IN (四个 key) GROUP BY conv_key;`
   基线：336 / $0.210465 / 1,940,595；124 / $0.151715 / 1,028,728；96 / $0.199038 / 1,545,537；20 / $0.026095 / 216,369。
3. 总量守恒：以修复时刻为界，比较 `req_id <= 界` 的 `count(*)`、`sum(cost)`、`sum(in_tok)`、`sum(out_tok)` 与基线（修复是只读的视图改动，数值必须逐项相等；库持续写入，不要用全表绝对值）。
4. 列表断言：`listSessions(50).items` 中，默认渲染可见条目里 `flags` 不含 `tool_event`；折叠条计数 ≥ 18 且成本合计 ≥ $0.2398；展开后 18 张均在前 50 条内（16:25–16:26 这批位于第 13–30 位）。

## 不确定点

- **实测**：18 张卡字段、414 key / 0 组、四会话身份与计数、成本与 `tool_use` 时间、`gugu_delivery` 广播。
- **推断**：16:25:11/14 的父会话是 `97cedc47`（时间与工具序列吻合，route 无 session）；16:26:12 属于 `4abeeb02`（3 秒内，provider 不同）；A 的实际派生耗时（需副本实测）；B 在 64 张 conv 卡上生效依赖版本 bump 重派生（机制已读，未实际执行）。

## Risks

| 方案 | 工时 | 风险 | 回填 | 可逆 |
| --- | --- | --- | --- | --- |
| P0 `tool_event` 折叠 | 0.5 天 | 低 | 无 | 完全 |
| P1 判定层 | 0.5 天 | 中低 | 仅 conv 组重派生 | 需再 bump |
| P2 组身份 | 2–3 天 | 高 | 414 组 + 视图重建 | 中 |
| C 读侧过滤 | 0.25 天 | 中 | 无 | 完全，但丢可观测性 |
| D 归并回填 | 3 天+ | 高 | 改写 `conv_key` | 难 |

本文只做方案评估，不改代码、不写库、不重启。实施时按仓库约定在 worktree 分支推进，P0 与 P1 各自独立提交，P2 单独立项。
