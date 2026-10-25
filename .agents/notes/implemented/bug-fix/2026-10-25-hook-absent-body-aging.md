# Agent Note: hook 缺席正文的老化标注（miss_reason=hook_absent）

Status: implemented

## Problem

正文载体是 hook 证据。账本先到、hook 证据不来的请求，`body_state` 会永远停在 `pending`，没有任何机制承认"正文不会再来了"。架构文档为这个场景设计了终结方式，但实现从未落地。

### 生产现场

会话 `["session","98da290b-7df1-4759-9dd4-d7d6482ea858"]`（标题"ATC 架构优化方案"，320 条请求）里有两行典型样本：

| req_id | started_ms（本地时间） | status | ms | have | body_state | miss_reason | derived_state |
|---|---|---|---|---|---|---|---|
| 6005 | 1792858127229（2026-10-25 00:08:47） | 499 | 89950 | 6 | pending | NULL | retained |
| 6054 | 1792858689725（2026-10-25 00:18:09） | 499 | 89977 | 6 | pending | NULL | retained |

解读：magpie 账本记到这两笔 chat 请求在约 90 秒时 HTTP 499（客户端断开）。`have=6` 是账本位（2）加路由位（4），hook 位（1）未置——本行没有任何已关联的 hook 证据。

hook 其实到过。raw_hook 里 `a59f14a6`（00:10:17，success=0）恰在 6005 的结束时刻（00:08:47 + 89.95s），`9d36f8de`（00:19:39，success=0）恰在 6054 的结束时刻。它们 success=0、reply 缺失、没有 response id，而 hook 与账本的关联只认 response ID、不按时间近邻猜（`src/hook.ts` 模块注释的不变量），所以永远无法并进这两行。生产库当时有 47 笔这样的 reply 缺失 hook（2026-10-24 10:59 起持续产生），全部积在 `pending_hook`。另有 79 行满足"`body_state='pending'` 且 `(have & 1)=0` 且超时 1 小时"（76 条 `via='through'`，3 条 `via='rejected'`），`miss_reason` 全部为 NULL。

于是对这批行，存储层按自身证据能力能负责任说的话只有一句：本行没有任何已关联的 hook 证据，等待关联队列中也没有指向本行的候选。"hook 从未发生"是存储层无权断言的——对 6005 恰恰是假的。

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

缺口在两处：`hook_absent` 的"等满阈值"守卫不存在——`pendingTick`（`src/main.ts` 装配，每 5 秒一轮）只调用 `reconcilePending()` 做 hook 并入重试，从不检查账本行的 hook 缺席；`body_state='pending'` 也没有除"hook 到达转 available/partial"之外的转出路径。其余四个值仍未实现，`origin_not_local` 只作为 hook 准入拒绝原因出现在 `src/http.ts` 与 `src/capacity.ts` 的指标里，不是 `miss_reason`——它们不在本决策范围内。

连带观察：req 6005 的派生态停在 `retained`，`delta_ordinals` 为 null，中栏因此只出 Event 行（"新增输入未确认 · retained"），没有任何可信输入步骤。本决策只解决"缺席无人承认"，不承诺改变这批行的派生态。

## Decision

`pendingTick` 里加了 hook 缺席老化守卫，把文档承诺的 `hook_absent` 落地为存储事实，判定口径限定在存储层的证据能力之内；后台合并带上原因对账，已有标注随证据变化解除。阅读器跟随 `miss_reason` 渲染，不自行推断年龄。

### 守卫

- **位置**：`markHookAbsent(store, now)` 与 `reconcilePending()` 同放 `src/hook.ts`；`pendingTick` 在每轮 `reconcilePending()` 之后调用它。任务体不进 `main.ts`（定时器只做 wiring，依据 [main.ts 的定时任务体归位](../architecture/2026-10-23-main-orchestration-delegation.md)）。缺席判定与等待并入是同一概念的两面，放同一定时器最内聚。
- **判定条件**（全部满足才标注）：
  1. `body_state='pending'`；
  2. `(have & HAVE_BODY)=0`，即 hook 位未置（位定义见 `src/evidence.ts`，与显示规则表"有账本、无 hook"的口径一致）；
  3. `NOT EXISTS (SELECT 1 FROM pending_hook ph WHERE ph.response_id_norm = request.response_id_norm)`。等待关联队列里已有 hook 以本行的 response id 指向本行时（含歧义候选行），合并随时可能发生，不标注。不用 `NOT IN` 子查询：目标列为 NULL 时 `NOT IN` 恒为 NULL，会把 `response_id_norm` 为 NULL 的行（顺序不可证被清空响应身份的）永久漏掉；`NOT EXISTS` 的等值比较对 NULL 两边都过滤，NULL 行自然放行为"无指向、可标注"；
  4. `started_ms < now - HOOK_ABSENT_THRESHOLD_MS`。锚点用 `started_ms`：hook 正常在请求结束时到达，等待从请求开始起算。不用 `updated_at`，任何触碰都会刷新它；
  5. `miss_reason IS NULL`，不覆盖已有原因。
- **动作**：只写 `miss_reason='hook_absent'`，不改 `body_state`。`body_state` 回答"正文现在在不在"（`src/store.ts` 的类型注释），`miss_reason` 回答"为什么没有"；正文确实没有，pending 仍是事实。判定依据按证据能力表述：等满阈值，仍没有任何 hook 证据关联到本请求，且等待关联队列中没有指向本行的候选。不宣称 hook 从未发生——生产库 47 笔孤儿 hook 证明这个断言会出错。`miss_reason` 已在列表行投影上（`src/queries.ts`），store 落地后阅读器自动获得准确文案。
- **阈值**：常量 `HOOK_ABSENT_THRESHOLD_MS`，默认 1 小时。依据：本会话正常 chat 请求实测最长约 129 秒，1 小时留了一个数量级余量。偏长的代价只是标签晚出现；偏短的代价是给仍在运行的超长请求写错误事实，违背"报告忠实"。
- **合并时的原因对账**：`mergeHookInto()` 只迁移正文、正文引用与证据，原本不碰 `miss_reason`；现在合并事务内按合并后的正文现实对账一次：正文完整（`available`，无论迁移与否）→ `miss_reason=NULL`；否则取源行的 `miss_reason`——迁移了是源行正文自己的降级原因，未迁移时源行的降级原因仍是本行正文现实的最好描述，源行没有就清空。hook 证据已关联，"`hook_absent`"必为假，这一条规则在三种形态（迁移后 available、迁移后 partial、无骨架未迁移）下都把它解除。合并后 have 位已置（步骤 5 的 `have=have|HAVE_BODY`），守卫条件 2 保证不会重标，无震荡。
- **每轮限额**：每轮最多 200 笔：先 SELECT 命中 id（按 `started_ms` 升序），再按 `IN (...)` UPDATE。部署首轮即清完积压；partial index（`WHERE body_state='pending'`）留待量级增长后再评估。

### 评审决策点的落点

- `via='rejected'` 的行（生产库 3 行）请求被拒，永远不会有 hook，标注是事实成立的，包含在守卫内。
- 歧义候选行（`pending_hook.candidates` 有多个候选）在歧义解除前保持无标签 pending。它们与 held hook 的关系是"待裁决"，不是"缺席"。
- `web/body-view.js` 措辞未改：reason 非空时已自动改走 `正文未到：${reason}` 分支，不再说"可能稍后到达"；"回调可能稍后到达"只在原因为空时出现。

### 阅读器与指标

- `web/trace-view.js` 的 Event 行：`正文状态：${row.body_state}${row.miss_reason ? `（${row.miss_reason}）` : ''}`，例如 `正文状态：pending（hook_absent）`；`miss_reason` 为 NULL 保持原文案。`row.miss_reason` 已在列表行投影上。
- [architecture-design.md](../../../../docs/architecture-design.md) 正文缺失节：`hook_absent` 的判定依据写证据能力口径，阈值默认值与守卫位置（`src/hook.ts` 的 `markHookAbsent`）随表落在同节。
- 指标沿用现有 stderr 汇报模式：每轮标注数大于 0 时 `pendingTick` 写 `hook_absent_marked:N`，不新增 metrics 结构。

### 明确不做

把 reply 缺失的孤儿 hook 按 session 加 `observed_start_ms` 的精确身份关联回账本行。这能把生产库 47 笔孤儿 hook 归位，让 6005 / 6054 拿到比 `hook_absent` 更准的"上游未回复"事实（文档 `reply_unavailable` 的形态）。但它改动"关联只认 response ID"这条既有不变量，属独立决策；且它替代不了老化守卫——hook 真没到的行仍然存在。列为后续方向。

## Alternatives considered

**新增 `body_state` 终态（如 `missing`）。** 落选。`body_state` 的封闭值集被 schema 注释、queries、derive 与阅读器多处分支消费，扩值影响面大；而"为什么没有"本来就是 `miss_reason` 的职责，文档已定义 `hook_absent`，缺的只是实现。

**读侧即时推导，不落库。** 查询与渲染时按 have 位和当前时间算"已缺席"。落选：文档把 `hook_absent` 定义为 `miss_reason` 存储值；row-summary、body-view、trace-view 与 API 消费方要各自实现同一年龄比较与队列排除口径，漂移风险高。写侧标注一次即可；迟到的 hook 由两条清除路径（直接命中、后台合并）解除，不会僵化。读侧方案同样绕不开阈值选择，省下的只是一次写入。

**塞进 derive 或 raw_prune 等现有任务顺带做。** 落选：任务体按概念归位；"等 hook"与"hook 等不到"是同一概念，归属 `pendingTick` 与 `src/hook.ts` 最内聚，跨任务搭车只省一个定时器调用。

**按精确身份关联孤儿 hook，替代 hook_absent。** 见"明确不做"。对本决策落选：它动的是关联不变量，解决的是更上游的归属问题，且不能覆盖 hook 真没到的行；作为后续方向保留。

**不改存储，只把阅读器文案改成"正文未到（可能已缺席）"。** 落选：含糊其辞违背"报告忠实"；文档与实现的背离原样保留，积压行继续无人承认。

## Testing

合成用例在 `tests/hook.test.ts`，覆盖：基本标注（超阈值标 `hook_absent` 且 `body_state` 保持 `pending`；阈值内不标；已有 `miss_reason` 不覆盖；不重复标注）；等待关联排除（12 笔 hook 先入 `pending_hook`、对应 12 笔超龄账本行后到，等待轮次与合并限额余量内一行不标，合并完成后正文 `available` 且无 `hook_absent` 残留）；歧义候选行不标注；`response_id_norm` 为 NULL 的行仍被标注（`NOT EXISTS` 口径，不踩 `NOT IN` 的 NULL 陷阱）；每轮 200 限额与余量续标；两条恢复路径分别验证——直接命中（`acceptHook()` 落正文清原因）与后台合并（`mergeHookInto()` 对账：迁移后 `available` 清空、取源行降级原因、无骨架无原因时清 `hook_absent` 且 have 位防重标）。`bun run typecheck` 与全量 `bun test`（634 例）通过。

生产验收（2026-10-25 部署当轮）：重启 launchd 服务后首轮 `hook_absent_marked:81`（提案时积压 79 行，写入时又老化出 2 行）；目标会话 320 条中原 12 条 `miss_reason=NULL` 的 pending 行全部带 `hook_absent`，`body_state` 仍为 `pending`，req 6005 / 6054 在内；`/api/requests/6005/body` 返回 `{state:"pending", reason:"hook_absent"}`，正文区与中栏 Event 行的文案链路打通。

## Consequences

一次可见的显示变化：积压行的阅读页从"回调可能稍后到达"变成"已确认缺席"。这是本决策的意图；对既有读者这是一个口径变化，由本 note 与提交说明承担解释。

`hook_absent` 的准确含义是"没有已关联的 hook 证据"，不是"hook 从未发生"。生产库 reply 缺失的孤儿 hook 是长期现实，不是边缘个案：6005 这类行被标 `hook_absent` 时，hook 其实到过，只是没有 response ID 可关联。架构文档的判定依据句随实现一起落地，防止读者把这类行误读成 collector 没收到任何回调。

误标仍在运行的超长请求的代价被控制在临时错标：阈值 1 小时起步偏保守，两条清除路径（直接命中、后台合并）把误标降为可自动解除的状态。若生产出现真实的超过 1 小时的 hook 迟到案例，上调 `HOOK_ABSENT_THRESHOLD_MS` 即可。rejected 行也被标注，是接受的一点噪音（它们永远不会拿到 hook，标注不会解除）。

每轮守卫的 SELECT 按 `body_state='pending'` 过滤，现有部分索引可服务；当前量级（两位数）无压力，量级增长后需评估 partial index。对账 UPDATE 在每次后台合并生效，不只为带标注的行：无标注时多数是同值写，代价可忽略。
