# Agent Note: 上下文明细条目的内容直出补全

Status: implemented

## Problem

上下文明细弹窗（tile、图例与内容列表共用的点击明细，[web/context-detail.js](../../../../web/context-detail.js)）承诺「条目展开即内容」，但 2026-11-01 对真实请求 req 70099（chat 协议，45 条消息）逐类实测，三类条目点开后没有可读的深入内容：

1. **工具定义条目（tools 类，20 行）渲染的是无关内容。** 条目带 `path: request.tools[N]` 与 `precision: located`，但 `entryContentHtml` 只认 `data.content`（工具结果）与 `data.messages[0].value`（消息页）两种形状，从不解引用 `entry.path`。实测点开 `request.tools[4]`（memory 工具定义）渲染出约 2.2 万字符的系统提示 JSON（转义后的呈现长度）——正文根读取里 messages[0] 的内容，点开任何其他工具定义行得到的也相同。这比「内容缺失」更糟：渲染的是误导性内容。system 类的顶层字段条目（`request.system`）落到同一条路径，点开看到的是首条用户消息。
2. **承载块条目（system/chat 类）以原始 JSON 呈现。** `contentTextOf` 只覆盖字符串、文本块、`text`/`output` 字段与图片/推理块占位标注，消息对象 `{role, content}` 抽不出文本，落进 JSON 兜底分支。系统提示与对话正文都在响应里，只是没有抽出。
3. **工具结果折叠行只有配对确认的一条。** req 70099 的正文携带 24 个 role=tool 结果块（22 terminal + skill_view + execute_code，与 magpie `results` 条目计数一致），但 results 目录走 `tool_call` 配对表，只列出本笔新增的那条（owner 70098 call 0 → `messages[44]`）；其余 23 个历史副本的配对记录在更早的请求上，且 `blockDir` 对 chat 只扫 role 0/1、对 system 只扫 role 2，role=3 的消息不进任何类别的目录，从弹窗走不到。

2026-10-28 的[内容直出简化](../simplification/2026-10-28-context-detail-content-only.md)删除了「原始对象」折叠，把兜底 JSON 改为直出——当时已知消息对象抽不出文本；本轮补的是上述三类更早的覆盖缺口，不推翻该决策。

## Decision

三处独立改动，①② 只动 `web/context-detail.js`（渲染层），③ 只动 `src/reading.ts`（目录规则），不碰存储 schema、派生与 reading token，不需要 backfill。`CTX_EXPLAIN_VERSION` 1 → 2：目录返回形状变化（results 可能多出承载行），消费端只有展示层，无持久化迁移。

**① 顶层字段条目按 path 解引用。** `entryContentHtml` 对 `ord === null` 的条目按 `request.<field>[M]` 从同一响应的 `request_fields` 取对应值渲染，覆盖 tools/functions 的工具定义与 system/instructions 顶层字段。Schema 按既有兜底口径给缩进 JSON——它本来就是结构化定义，不需要伪文本化；字段不在已保存正文里时给状态说明，不再渲染 messages[0]。根读取（无 `to` 参数的 `/body`）本来就返回完整 `request_fields`，零额外网络。条目读取的缓存键从条目序号改为请求 URL（`sharedEntryRead`）：同一弹窗对同一 URL 只发一次请求，已就绪复用、进行中共用同一 promise、失败不缓存，20 个工具定义行展开共享同一次根读取。

**② contentTextOf 拆消息对象。** 值含 `role` 与 `content` 字段时递归抽 `content`；`tool_calls` 参数不进文本，与[中栏投影](../../../../web/trace-view.js)「工具结果不在回复里出内容行」的口径一致。抽不出仍落 JSON 兜底；未知块丢弃、图片与密封推理给占位标注的既有立场不变。system、chat、memory、skills 四类的承载块条目同时受益。

**③ results 目录补 role=3 承载行。** chat 与 Responses 的工具结果是独立消息：results 分支在配对行之外查 `request_block WHERE req_id=? AND role=3`（与 `blockDir` 同一形状的索引查询，零消息块解压），每个配对未确认的 role=3 消息出一个 `precision: 'carrier'` 条目，附「历史结果副本未经配对确认」的 note。承载行与配对行按消息序号合并后统一分页——乱序追加会让游标推进到承载行的序号，下一页把高序号的配对行重列一遍。名称过滤下：有配对行只列配对行（与现状一致），没有配对行降级列全部承载块并说明，比照 files 类做法。Anthropic 的工具结果块藏在 user 消息 content 数组里，消息级分不出来，不出承载行并由 note 说明该边界。协议面如实收窄：仓库支持的协议只有 anthropic/chat/responses（`CAPABLE_PROTOCOLS`），Gemini 不在其中、到不了这一分支，边界 note 只覆盖 Anthropic。

## Alternatives considered

**扫描整笔正文做片段级精确对应（含 23 个历史副本的精确工具名归属）。** 对应精度最高，但正是 2026-10-26 [treemap drilldown note](../feature/2026-10-26-context-treemap-drilldown.md) 否决并留了重开条件的路线；本轮实测其开销（40 条 0.13ms、最重 526 块全取 13.7ms，[架构文档](../../../../docs/architecture-design.md#查询接口)）说明性能不构成障碍，否决理由是诚实性——扫描重建会虚构配对表没有确认的调用级对应。本轮维持否决：role=3 承载行只声明「这条消息是工具结果承载块」，不宣称属于哪次调用。

**给 results 历史副本按 call_id 反查工具名。** 需要解压消息块抽 `tool_call_id` 再 join 配对表，打开目录的代价从「骨架一次 + 索引查询」变成「整笔解压」，且反查出的对应仍不是配对表确认的结论。否决，代价破坏「目录不解压消息块」的既有约束。

**工具定义条目改走独立端点（如 `/api/requests/:id/tools-schema`）。** 服务端新增端点只为省一次根读取，而根读取已经在发生且响应里已带数据。否决，不增加表面积。

**carrier 条目渲染整条消息的 Markdown 化视图。** 弹窗的职责是核对「这块占多少 token、里面是什么」，`<pre>` 直出与正文页的渲染职责不同；Markdown 化是正文页已有的能力，不复制到弹窗。否决。

**弹窗读取并入 reader-store 缓存。** 能复用中栏已读正文页，但 reader-store 的缓存边界、失效与自动重读都按请求级快照设计，弹窗的临时条目读取挂进去要扩它的契约；本轮条目读取保持弹窗内一次性（generation 守卫 + URL 级去重），并入 reader-store 留作后续独立提案。

## Consequences

- 点开工具定义行显示该工具的 Schema；system 顶层字段条目显示系统提示本身而不是首条消息；chat 轮与承载块条目显示正文文本，图片与密封推理仍是占位标注；results 目录在配对行之外列出历史副本承载行（70099 应为 23 承载行 + 1 配对行），附未经配对确认的说明。
- ① 的解引用从提案里的 tools/functions 扩大到全部顶层字段条目：system 顶层字段条目原本也渲染 messages[0]，属同类「静默渲染无关内容」，同一机制一并修掉，不再单独立项。
- ② 的有损面扩大：消息对象拆包后 `tool_calls` 参数与未知字段不进文本，JSON 兜底不再自动出现（抽得出文本时只给文本），丢失的块没有入口。沿用 2026-10-28 note 的既有取舍；出现真实阅读痛点时按该 note 留的口子（文本后附完整 JSON）单独提案。
- ③ 改变目录返回形状：折叠行明细从 1 条变成多条，由 `CTX_EXPLAIN_VERSION=2` 判别。中栏与列表的行、折叠计数都来自 magpie `parts`，与目录条目解耦，不受影响。
- 性能：①② 零额外网络；③ 打开 results 目录多一次 `request_block` 索引查询（70099 实测 24 行，亚毫秒），条目正文维持「点开才读」的惰性路径，不需要后台化或与其他任务并算。
- 测试：`tests/context-item.test.ts` 锁定承载行合并、混合分页游标推进、名称过滤降级与 Anthropic 边界；`tests/context-detail.test.ts` 锁定消息拆包、顶层字段解引用与 URL 级去重（含失败重试）。[架构文档](../../../../docs/architecture-design.md#查询接口)的 results 目录描述随形状更新。
