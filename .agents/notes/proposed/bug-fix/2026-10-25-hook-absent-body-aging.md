# Agent Note: hook 缺席正文的老化标注（miss_reason=hook_absent）

Status: proposed

## Problem

正文载体是 hook 证据。账本先到、hook 不来的请求，`body_state` 会永远停在 `pending`，没有任何机制承认"正文不会再来了"。架构文档已经为这个场景设计了终结方式，但实现从未落地。

### 生产现场

会话 `["session","98da290b-7df1-4759-9dd4-d7d6482ea858"]`（标题"ATC 架构优化方案"，320 条请求）里有两行典型样本：

| req_id | started_ms（本地时间） | status | ms | have | body_state | miss_reason | derived_state |
|---|---|---|---|---|---|---|---|
| 6005 | 1792858127229（2026-10-25 00:08:47） | 499 | 89950 | 6 | pending | NULL | retained |
| 6054 | 1792858689725（2026-10-25 00:18:09） | 499 | 89977 | 6 | pending | NULL | retained |

解读：magpie 账本记到这两笔 chat 请求在约 90 秒时 HTTP 499（客户端断开）。`have=6` 是账本位（2）加路由位（4），hook 位（1）未置——hook 从未到达。请求已被中断，回复与正文永远不会来。这不是孤例：生产库当前有 79 行满足"`body_state='pending'` 且 `(have & 1)=0` 且超时 1 小时"（76 条 `via='through'`，3 条 `via='rejected'`），`miss_reason` 全部为 NULL。

阅读页把这批行渲染成一组 Event 记录："未收到回复""请求失败 · HTTP 499；已收到的输入与回复仍保留在步骤里""正文状态：pending"（`web/trace-view.js` 的 `projectSteps()`）。其中 pending 的文案依据是 `body_state` 的文档语义——"账本已到，正文预期会到，尚未到"（[architecture-design.md](../../../../docs/architecture-design.md) 正文缺失节的语义表）。对会话早已结束的行，"预期会到"是假的。正文区文案进一步放大：`web/row-summary.js` 显示"正文未到"；`web/body-view.js` 在原因为空时说"正文未到；回调可能稍后到达。"

### 文档与实现的缺口

[architecture-design.md](../../../../docs/architecture-design.md) 正文缺失节定义了五个 `miss_reason` 值及其判定依据：

| 值 | 文档判定依据 |
|---|---|
| `hook_absent` | 账本已到，等满阈值仍没有任何 hook |
| `reply_unavailable` | hook 到了，但 `success=0` 且 `response_z IS NULL` |
| `parse_failed` | hook 到了，`parse_state=invalid` |
| `unsupported_protocol` | hook 到了，`parse_state=unsupported` |
| `origin_not_local` | hook 到了，`origin` 不是 `local` |

这五个值在 `src/` 里零实现（git 历史中也从未实现过）。`origin_not_local` 只作为 hook 准入拒绝原因出现在 `src/http.ts` 与 `src/capacity.ts` 的指标里，不是 `miss_reason`。`miss_reason` 现有的全部写入点只有两处，都在 `src/hook.ts` 的 `acceptHook()`：`disk_body_paused`（写前准入暂停）与 collector 超限原因（`collector_object_limit` / `collector_envelope_limit`）。"等满阈值"的守卫不存在：`pendingTick`（`src/main.ts` 装配，每 5 秒一轮）只调用 `reconcilePending()` 做 hook 并入重试，从不检查账本行的 hook 缺席；`body_state='pending'` 也没有除"hook 到达转 available/partial"之外的转出路径。

连带观察：req 6005 的派生态停在 `retained`，`delta_ordinals` 为 null，中栏因此只出 Event 行（"新增输入未确认 · retained"），没有任何可信输入步骤。本方案只解决"缺席无人承认"，不承诺改变这批行的派生态。

## Proposal

给 `pendingTick` 加一个 hook 缺席老化守卫，把文档承诺的 `hook_absent` 落地为存储事实；阅读器跟随 `miss_reason` 渲染，不自行推断年龄。

### 守卫设计

- **位置**：新函数 `markHookAbsent(store, now)`，与 `reconcilePending()` 同放 `src/hook.ts`；`pendingTick` 在每轮 `reconcilePending()` 之后调用它。任务体不进 `main.ts`（定时器只做 wiring，依据 [main.ts 的定时任务体归位](../../implemented/architecture/2026-10-23-main-orchestration-delegation.md)）。缺席判定与等待并入是同一概念的两面，放同一定时器最内聚。
- **判定条件**（全部满足才标注）：
  1. `body_state='pending'`；
  2. `(have & 1)=0`，即 `HAVE_BODY` 位未置（位定义见 `src/evidence.ts`，与显示规则表"有账本、无 hook"的口径一致）；
  3. `started_ms < now - HOOK_ABSENT_THRESHOLD_MS`。锚点用 `started_ms`：hook 正常在请求结束时到达，等待从请求开始起算。不用 `updated_at`，任何触碰都会刷新它；
  4. `miss_reason IS NULL`，不覆盖已有原因。
- **动作**：只写 `miss_reason='hook_absent'`，不改 `body_state`。`body_state` 回答"正文现在在不在"（`src/store.ts` 的类型注释），`miss_reason` 回答"为什么没有"；正文确实没有，pending 仍是事实。阅读器在 `miss_reason` 存在时已按原因渲染（`web/row-summary.js` 的 `正文未到：${reason}` 分支、`web/body-view.js` 的 `正文未到：${page.reason}` 分支），store 落地后阅读器自动获得准确文案。`miss_reason` 已在列表行投影上（`src/queries.ts`），中栏无需新的读模型列。
- **阈值**：常量 `HOOK_ABSENT_THRESHOLD_MS`，默认 1 小时。依据：本会话正常 chat 请求实测最长约 129 秒，1 小时留了一个数量级余量。偏长的代价只是标签晚出现；偏短的代价是给仍在运行的超长请求写错误事实，违背"报告忠实"。hook 迟到有自愈路径：`acceptHook()` 落正文时 `persistBodyTx()` 置 available，且 `src/hook.ts` 已有 `miss_reason` 清 NULL 的语句，标签自动消失，所以阈值取保守侧不会造成永久错标。
- **每轮限额**：仿照 `reconcilePending()` 的限额模式（每轮最多 10 笔合并），标注设每轮上限（建议 200）：先 SELECT 命中 id，再按 `IN (...)` UPDATE。生产库当前 pending 行共 79 行，量级小，部署后首轮即可清完积压；partial index（`WHERE body_state='pending'`）留待量级增长后再评估，首轮不做。

### 留给评审的决策点

- `via='rejected'` 的行（生产库 3 行）请求被拒，永远不会有 hook。按判定条件它们同样会被标注。这是事实成立的标注（确实等满阈值无 hook），本方案默认包含；若评审认为"rejected 从不预期 hook、标注是噪音"，实施时排除 `via='rejected'` 即可，判定条件加一项。
- `web/body-view.js` 在原因为空时说"回调可能稍后到达"。reason 非空时已自动改走原因分支；如评审希望进一步区分措辞（如"回调未到达"），随实施定，但 reason 非空时不得再说"可能稍后到达"。

### 收尾改动

- `web/trace-view.js` 的 Event 行 `正文状态：${row.body_state}` 追加原因，与 row-summary 同口径：`正文状态：pending（hook_absent）`。`row.miss_reason` 已可用，`NULL` 时保持原文案。
- [architecture-design.md](../../../../docs/architecture-design.md) 正文缺失节把"等满阈值"写明为默认 1 小时常量与守卫位置（默认值与判定口径归架构文档，note 只记为什么）。
- 指标沿用现有 stderr 汇报模式：首轮标注数大于 0 时写 `hook_absent_marked:N`，不新增 metrics 结构。

## Alternatives considered

**新增 `body_state` 终态（如 `missing`）。** 落选。`body_state` 的封闭值集被 schema 注释、queries、derive 与阅读器多处分支消费，扩值影响面大；而"为什么没有"本来就是 `miss_reason` 的职责，文档已定义 `hook_absent`，缺的只是实现。

**读侧即时推导，不落库。** 查询与渲染时按 have 位和当前时间算"已缺席"。落选：文档把 `hook_absent` 定义为 `miss_reason` 存储值；row-summary、body-view、trace-view 与 API 消费方要各自实现同一年龄比较，口径漂移风险高。写侧标注一次即可，迟到的 hook 已有清除路径。读侧方案同样绕不开阈值选择，省下的只是一次写入。

**塞进 derive 或 raw_prune 等现有任务顺带做。** 落选：任务体按概念归位；"等 hook"与"hook 等不到"是同一概念，归属 `pendingTick` 与 `src/hook.ts` 最内聚，跨任务搭车只省一个定时器调用。

**不改存储，只把阅读器文案改成"正文未到（可能已缺席）"。** 落选：含糊其辞违背"报告忠实"；文档与实现的背离原样保留，79 行积压继续无人承认。

## Acceptance criteria

- 合成用例（bun test，最窄相关）：账本行无 hook、超阈值 → `miss_reason='hook_absent'`，`body_state` 仍为 `pending`；阈值内不标；已有 `miss_reason` 的行不覆盖；hook 迟到并入后 `miss_reason` 清空、`body_state='available'`（复用现有 `acceptHook()` 路径）；每轮限额生效。
- 生产验收：部署后 79 行积压（含 req 6005 / 6054）在首轮守卫内获得 `hook_absent`；阅读页正文区显示"正文未到：hook_absent"，中栏 Event 行带同一原因；"回调可能稍后到达"只在原因为空时出现。合成数据验收与真实流量验收分开写。
- `bun run typecheck` 与 `bun run verify:notes` 通过。
- [architecture-design.md](../../../../docs/architecture-design.md) 正文缺失节写明阈值默认值与守卫位置。

## Risks

- **误标仍在运行的超长请求**。阈值 1 小时起步偏保守；late hook 自愈把误标从永久事实降为临时错标。若生产出现真实的超过 1 小时的 hook 迟到案例，上调常量即可。
- **一次可见的显示变化**。79 行积压的阅读页会从"可能稍后到达"变成"已确认缺席"。这是本方案的意图，但 commit 与 note 需向既有读者说明。
- **rejected 行标注的噪音**。见 Proposal 的决策点，默认包含，评审可翻转为排除。
- **每轮 SELECT 的扫描成本**。当前按 `body_state='pending'` 过滤的行数为 79，无压力；量级增长后需 partial index，本轮不做。
