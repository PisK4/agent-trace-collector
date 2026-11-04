# Agent Note: Codex 桌面接入的辅助线程归类、标题与 OTLP 服务名

Status: proposed

## Problem

### 背景：只用一个对话，左栏出现四条 Codex 会话

2026-11-03，项目所有者反馈：最近只在 Codex 桌面里持续用一个对话，ATC 左栏却出现多条 Codex 记录，标题还完全一致，无法分辨哪条是正在进行的主对话。用户预期是「一个活跃对话对应一个主 trace，其余只应是可折叠的旁路，例如 Memory Update」。

这次调查先核对记录归属，再判断是上游真的发出了独立请求，还是 ATC 把同一会话拆错了。ATC 的 SQLite 以只读连接打开，正文只在内存中解压比对；本次没有改代码、没有写库、没有重启，下面的数量是核对时的快照，会随新请求增长。

### 实测：四条会话对应四个真实 thread

最近一轮 Codex 使用（12:51:54–14:55:32）共有 **4 个 `conv_key` / 52 条请求**：

| `conv_key` 的 thread id | 时间范围 | 请求数 | 用途 | 证据通道 |
| --- | --- | --- | --- | --- |
| `01a19fc1-b301-…-2af2cf31edac` | 12:53:56–14:55:32 | 38 | 全部 `chat` | 35 `through` + 3 hook-only，其中 3 条 499 |
| `01a19fc1-b46a-…-f954572d43a9` | 12:53:55 | 1 | `source:thread_title` | route + ledger + hook |
| `01a19fc1-b4ae-…-d9d7fb182b1f` | 12:53:56–12:54:38 | 7 | 5 条 `ambient_suggestions` + 1 条 `chat` + 1 条未知（499） | 6 `through` + 1 hook |
| `01a19fbf-d007-…-c30782448aa7` | 12:51:54–12:52:36 | 6 | 全部 `source:ambient_suggestions` | 6 `through`，三路齐全 |

证据覆盖方面，52 条请求里 **48 条有关联 hook 回调**；4 条缺失全是 499 中断，不是请求类型盲区。`through` 行一般同时有 route 与 ledger。`via='hook'` 的 4 条是只有回调、没有 magpie 路由的取消请求。

表里的用途列直接抄自落库结果，两种写法并存：`b4ae` 的 `ambient_suggestions` 没带 `source:` 前缀，`d007` 带了。前者可能是 magpie 原始 kind，后者是 `sourceDecision` 加了前缀的 `req_kind`；实施前按 `req_id` 复核，不能把两种口径混在一张表里当请求级事实。

全库 Codex 共 **9 个 `conv_key` / 62 条请求**。2026-10-26 还有一组 ambient 与 `source:memory_consolidation`，说明辅助线程是持续形态，不是这一天的偶发异常。用户记忆中的「Memory Update」不在 11-03 批次，来自 10-26 的 `01a17656-cb3c-…`（2 条，memory consolidation + chat）。

### 身份没有被拆错

每个请求体都带 `client_metadata["x-codex-turn-metadata"]`，原文可直接区分用途：

| 会话 | `thread_source` | `turn_trigger` | `request_kind` |
| --- | --- | --- | --- |
| 主线程 `b301` | `user` | `composer` | `turn` |
| 标题 `b46a` | `thread_title` | `thread_title` | `turn` |
| 建议 `b4ae` | `ambient_suggestions` | `ambient_suggestions` | `turn` |
| 建议 `d007` | `ambient_suggestions` | `ambient_suggestions` | `turn` |

hook 的 `session`、magpie 的 `session` 和 `conv_key` 三者都等于同一个 `thread_id`，`conv_source='session'`。没有出现两个 thread 被并成一个，也没有一个 thread 被拆成两个。**身份层没有拆错，四个会话就是上游的四个 thread。**

### 归类错了：辅助用途被当成主链

[用途编排](../../../../src/semantics.ts#L178-L205)只把精确的 `source_kind === 'title'` 判成排除主链。Codex 上游给的是 `thread_title`，于是它落到 `source:thread_title`，并保留 `chain='participate'`。`ambient_suggestions` 与 `memory_consolidation` 同样只加 `source:` 前缀，没有旁路或后台标记。库里的实际结果一致：这些行的 `purpose_status='recognized'`、`purpose_chain='participate'`、`chain_role='main'`，因此会话列表没有理由折叠它们。

核对代码后还能确定两件事，它们决定实施路径：

- magpie 的 `kind` 本身就是 `thread_title` / `ambient_suggestions`，已经落在 `source_facts_json` 的 `kinds` 里（[来源事实](../../../../src/sources/facts.ts)、[请求用途读取](../../../../src/request-purpose.ts)的 `parseSource`）。用途判定不需要新开正文通道就能读到它们。`x-codex-turn-metadata` 是补充证据，用来覆盖 magpie kind 报成 `chat` 的漏网行。
- 上面表格按 thread 汇总，P0 的判定却按请求发生。`b4ae` 组内有 1 条 `chat` 和 1 条 499 未知行，10-26 的 memory 组也有一条 `chat` 混入。实施前要按 `req_id` 列出每条请求的 `thread_source` 与 `kind`，不能把 thread 级结论直接当成请求级规则。

### 标题为什么退化

四条会话在只读 `/api/sessions` 里显示同一个标题：

```
# AGENTS.md instructions for /path/to/agent-trace-collector…
```

这不是「无标题」，而是「标题退化成注入头且四条同质」。主会话首条 `role=user` 块（请求 92858 的 `ord=3`）就是 Codex 注入的 `# AGENTS.md instructions for …`；该行 `title_source='user_delta'`。62 条 Codex 请求里 `model_title` 全部为空。

Codex **确实发了标题生成请求**。`b46a` 的 92850 是 1 次独立请求，输入 24,945 / 输出 54，回复正文为：

```json
{"description":"评估并重绘 agent-trace-collector 的黑色矩阵 IP，适配前端左上角与桌面应用","title":"重绘 ATC 矩阵 IP"}
```

标题在三处被丢掉：

1. **来源类别只认 `'title'`**。[用途编排](../../../../src/semantics.ts#L184)对 `thread_title` 不命中，判成参与主链，`modelTitle=null`。
2. **回复双键被拒**。[标题解析](../../../../src/semantics.ts#L148-L166)只接受 `<title>…</title>` 或只有一个 `title` 键的 JSON；Codex 的 `title` + `description` 因为 `keys.length !== 1` 直接返回 null。
3. **标题属于另一个 `conv_key`**。标题请求在 `b46a`，而[会话列表的标题子查询](../../../../src/queries/sessions.ts#L64-L94)只在同一 `conv_key` 内找 `model_title`，主会话 `b301` 永远取不到。

还有一层展示兜底：[共享输入解释](../../../../src/input-interpretation.ts#L42-L46)没有 Codex 的 `# AGENTS.md instructions for <path>` 包装规则，标题只能取首个用户文本。四个 thread 都带同一段注入，所以四条标题完全相同。同一会话里还出现过 `title='<turn_aborted>'` 的 `user_delta`，说明 `<external_codex_apps_open_page>…`、`<turn_aborted>` 等包装同样会污染标题候选。

标题生成走 [deriveTitle](../../../../src/derive/decision.ts#L466-L475)：它取确定新增的 user 消息里第一个 `state='text'` 的文本块首行。`# AGENTS.md instructions for …` 目前不被输入解释识别，仍算 `text`，所以直接成了标题。这也说明修好输入解释就能让主会话标题回到真实用户首句，不必等跨组标题归属。

### OTLP 白名单与真实 `service.name` 仍然对不上

[Codex 映射](../../../../src/sources/otlp/mapping.ts#L87-L106)登记的 originator 是下划线形式 `codex_app_server`，本机真实上报的是连字符形式 `codex-app-server`。[服务归属判定](../../../../src/sources/otlp/mapping.ts#L50-L52)是精确匹配，没有做 `-`/`_` 归一化，因此整个服务被[跳过并记为 `service_not_registered`](../../../../src/sources/otlp/ingest.ts#L101-L105)。

核对时的数字：

- `service.name=codex-app-server`：109,579 条 span，其中 `session_task.turn` 14 条（主线程 11、标题 1、ambient 2），**转成请求行 0 条**。此前一次读取为 108,395，数字随采集增长。
- `service.name=codex-exec-server`：139 条 span，没有 `session_task.turn`。
- `service.name=codex_exec`：2,507 条 span，2 条 turn，`via='otlp'` 请求行 1 条（10-26）。
- `service_not_registered` 记录从 10-26 持续到 11-03，覆盖 `codex-app-server` 与 `codex-exec-server`。

测试没有拦住这个偏差：[OTLP 回归](../../../../tests/otlp-ingest.test.ts#L238)的族名单同样写成下划线，合成用例一直通过。[Codex exporter 档案](../../../../docs/otlp-exporter-profile.md#L36-L40)也只是把当时验证过的 `codex_exec` 写进范围。

### 已验证范围与未决证据

- 52 条请求和 4 个 thread 的归属由 `conv_key`、hook `session`、magpie `session` 三处一致确认；4 条缺 hook 的是 499 取消，不据此推断未知用途。
- 用途证据来自请求正文或 magpie `kind`。OTLP 的 `session_task.turn` 只带 `thread.id`、`turn.id`、模型和用量，**不带 `thread_source` / `turn_trigger`**，所以 OTLP 单独无法完成用途判定。
- `x-codex-turn-metadata` 里没有 `parent_thread_id`。标题、建议与主 thread 之间没有显式父子指针，本文不把时间接近当作身份。
- 标题与主会话的内容关系已核对：标题提示词的 `User prompt:` 段与主会话 92858 的 `ord=7` 用户消息逐字一致，只有尾部空白差异。这是唯一可复核的绑定依据。
- 请求级的 `thread_source` 分布没有列出。`b4ae` 那条 `chat` 的 `thread_source` 是否仍是 `ambient_suggestions`、499 行有没有 hook 回调，决定 P0 的覆盖边界，实施前要补。
- 本次评审只把代码与 note 交叉核对，没有复验生产库计数；上表的 span 与请求数是核对时快照。

### 与已有记录的关系

已检查活动 note 树，无须归档或拒绝旧记录：

- [标题生成与主链](../../implemented/feature/2026-10-21-title-generator-and-main-chain.md)继续持有标题识别优先级与主链规则。本提案只补 Codex 的 `thread_title` 来源与双键回复，不改变「强指纹 > 来源类别 > 标题兼容 > 回退」的顺序。
- [请求用途与链](../../implemented/architecture/2026-10-22-request-purpose-and-chain.md)继续持有 `source:*` 与 `chat` 的结算契约。本提案新增的是 Codex 专属来源的正常化与后台标记。
- [OTLP exporter 与 Codex](../../implemented/feature/2026-10-26-otlp-exporter-profile-and-codex.md)记录的是 `codex_exec` 直连范围。桌面端 `codex-app-server` 不在当时范围，本条属于**部分取代其 originator 边界**：新增桌面服务名，但不改变格式、字段与拒收语义。
- [Hermes 视觉辅助会话噪音](../bug-fix/2026-11-01-hermes-auxiliary-session-noise.md)与本次机制相同：辅助请求各自成组、用途未识别。它已经论证「不合并真实执行身份、只识别用途并复用旁路折叠」。本提案沿用该结论，并补上 Codex 的**项目级后台**形态，后者不应绑定到任何一条对话。
- [会话标题脏组扫描](../bug-fix/2026-11-03-session-title-dirty-scan.md)继续持有标题子查询的 `CASE` 短路。若本提案为跨组标题归属新增关系，必须保留该短路，不能把标题成本退回到整组扫描。
- [空 session 身份修复](../../implemented/bug-fix/2026-10-27-empty-session-identity-migration.md)解决的是空串身份回退。本提案不反转其规则，也不改 `conv_key`。
- [hook 投递诊断](../../implemented/feature/2026-10-27-hook-delivery-diagnostics.md)继续持有 `hook_absent` 的分层语义。本文不把缺少回调归因于投递丢失。

## Proposal

目标不变：保留真实请求与费用事实，辅助 thread 不再以普通会话卡出现，标题回到可读的用户内容。首轮不改 `conv_key`、不写伪造父子关系、不新增 Codex 采集通道。

### 交付状态：已落地部分与未交付部分

2026-11-03 的 `feat/codex-integration` 已合入 master（`a8c9752`）。本篇仍留在 proposed，因为下面仍有未交付档位与原创未决项；已落地的部分以本小节为准，不再按「没做过」理解。

**已落地（`5d39fb9`）**：Codex 用途识别规则 `codex.thread.v1`（[src/harness/codex.ts](../../../../src/harness/codex.ts)、[purpose.ts](../../../../src/harness/purpose.ts) 注册），读 `x-codex-turn-metadata` 的 `thread_source` / `turn_trigger`，并以 magpie `kind` 兜底；`thread_title` 判 `title` 且排除主链，`ambient_suggestions` / `memory_consolidation` 判 `source:*` 且排除主链；Codex 双键 `{title, description}` 回复在 adapter 内解析。组级 `background` 标志落在 [src/queries/sessions.ts](../../../../src/queries/sessions.ts)（`has_background` 且无 `has_recognized_main` 时置位），列表与页面消费该标志。OTLP 侧登记连字符服务名 `codex-app-server`、`codex-exec-server` 等，并按 `turn_ref` 与 magpie 行去重（[mapping.ts](../../../../src/sources/otlp/mapping.ts)、[ingest.ts](../../../../src/sources/otlp/ingest.ts)）。schema v10 加 `user_fingerprint` 与 `turn_ref`，跨组标题绑定已按指纹唯一命中实现（[schema-v10.sql](../../../../src/schema-v10.sql)、[sessions.ts](../../../../src/queries/sessions.ts)）。

**已落地（`11cd736`）**：输入包装清洗，`# AGENTS.md instructions for …`、`<external_codex_apps_open_page>`、`<turn_aborted>` 不再成为标题候选；主会话标题回到用户首句（[src/input-interpretation.ts](../../../../src/input-interpretation.ts)）。注意这一档属于本篇的「P0：输入包装清洗」，不是 P2。

**未交付**：Codex 原生 `hooks.json` 仍未接入 ATC（本篇 P2），采集继续依赖 magpie 薄 hook；历史显式 rebuild 没有执行，生产库计数也未复验；未决问题第 1、4、5、7 条仍未定，其中第 5 条真实流量的去重误配率没有测量记录。未决问题第 2、3、6 条在实现里已经按具体方案落定（指纹跨组绑定、组级折叠判据、主会话侧指纹列），保留原文是为了记录评审时的问题，不再作为待办。

实施顺序按收益与依赖重排。用途识别与输入清洗直接改善左栏，先做；列表折叠次之；OTLP 服务名依赖 turn 落点与去重。跨组标题归属按验收档位定：选模型标题档时与 P0 同批，选最小档时不做。

### P0：Codex 辅助线程的用途识别

在 Codex 适配层新增来源规则，实际 ID 为 `codex.thread.v1`（提案时暂定 `codex.thread-source.v1`），登记在 [purpose.ts](../../../../src/harness/purpose.ts#L34-L42) 的 `PURPOSE_RULES`，agent 标签 `codex`。判定输入按优先级取两路：

1. `client_metadata["x-codex-turn-metadata"].thread_source` / `turn_trigger`：请求体顶层字段，骨架的 `request_without_messages` 已保留，[用途视图](../../../../src/request-purpose.ts)的 `readPurposeViewTx` 可以读到。只取这两个有界字符串键，不把整条请求交给 adapter。这是上游自述的来源，能覆盖 magpie kind 报成 `chat` 的请求。
2. `view.source`：`source_facts_json` 里的 magpie `kind`。`thread_title`、`ambient_suggestions`、`memory_consolidation` 已经在这里，作为无正文或元数据缺失时的补充。只有 `state` 为 `single` 或 `agree` 时可信。

映射：

- `thread_title` → `kind='title'`、`chain='exclude'`、`modelTitle` 非空。
- `ambient_suggestions` / `memory_consolidation` → `kind='source:<value>'`、`chain='exclude'`。
- `user` / `composer` 与未知值弃权，落回通用判定，不改变链角色。

标题解析：Codex 的回复是 `{title, description}` 双键 JSON，[共享解析](../../../../src/semantics.ts#L148-L166)只接受单键。**放宽必须写在 Codex adapter 内，不能改 `parseTitleReply`**：它同时服务 `titleDecision` 的通用兜底，放宽会让任意聊天回复里的同名 JSON 被排除主链。adapter 自己解析时仍要求来源是 `thread_title` 或命中标题提示词指纹，取 `title` 并压空白。

`PurposeView` 的增补：当前视图没有 `client_metadata` 字段。实现时在 `readPurposeViewTx` 里从已解出的骨架读一个有界来源事实（只含 `thread_source` / `turn_trigger` 两个字符串），不改共享视图的其他字段。两路都拿不到的行保持 `unknown`，不按时间或模型猜。

契约：`req_kind` 不新增字符串；后台用途保留 `source:*`，不另加 `scope` 字段。展示层需要的后台判据直接用 `req_kind`，见折叠小节。

### P0：输入包装清洗

[共享输入解释](../../../../src/input-interpretation.ts#L42-L46)增加已核对的 Codex 注入包装：

- `# AGENTS.md instructions for <path>`：首行前缀，不是标签。现有机理只剥 `<tag>`，需要新增前缀规则，类似 `CWD_PREFIX`。
- `<external_codex_apps_open_page>…</…>`、`<turn_aborted>`：按完整标签结构识别。确认整块都是注入才进 `DROP_TAGS`；块内还有用户指令时剥壳保留内部，不能整块丢弃。

`# AGENTS.md` 按完整结构识别，不能当通配前缀删除。实施前必须先取样该块的完整内容：头部行之后是否紧跟 AGENTS.md 正文、是否与真实用户指令同块。若同块还有用户指令，剥掉注入后必须保留；结构不完整时整段保留并记 `unrecognized`，不猜边界。

这一条是标题退化的直接解法：[deriveTitle](../../../../src/derive/decision.ts#L466-L475)取第一个 `state='text'` 的 user 文本首行，注入块一旦被判成 `injected` 或剥净，主会话标题自然回到用户首句。跨组标题归属因此不再是先决条件。

包装定义继续遵守共享解释的无 agent 门控约定，实施前用其他标签与未知标签跑反例。输入解释变化会影响用途判定与派生标题，按版本小节处理。

### P1：会话列表折叠与组级后台标志

现有 `bypass` 已覆盖全组 exclude 的情况，标题组不需要新标志。缺口在组内混合：

- `b4ae` 组有 1 条 499 未知行，拿不到正文与 `thread_source`，按保守规则保持 `participate`；`has_participate === 0` 不成立，组不会折叠。
- 组内也可能混入 magpie kind 为 `chat` 的请求。

折叠规则改成组级判据：组内存在已识别的后台用途（`req_kind IN ('source:ambient_suggestions','source:memory_consolidation')`），且不存在已识别的主用途，才加 `background` 标志。未知行不参与推断，也不阻止后台组折叠；真实主用途只要出现一条，组就留在主列表。

`background` 的落点选最小方案：不新增事实列，在 [SESSION_FLAG_COLUMNS](../../../../src/queries/sessions.ts#L32-L55)里按 `req_kind` 聚合，`GET /api/sessions` 的 `flags` 多一个值。若后续产品要求按 `thread_source` 而非 `req_kind` 判定，再评审是否落组级事实。

契约变化：`flags` 多一个 `background`；页面多一个后台分组或折叠入口。`conv_key`、请求行、证据行不变。

风险：真实独立的新会话不能被后台规则吞掉。判据只认显式用途，不以单笔、无标题或时间接近作为旁路条件。

### 折叠依据：title 折旁路，ambient / memory 归后台

**title 不绑定主会话时，先靠输入清洗与折叠解决辨识。** 标题 thread 的用途被识别后，若组内没有无正文行，全组 exclude，现有 `bypass` 自动折叠；主会话标题由清洗后的用户首句提供。若后续仍要挂 Codex 生成的标题，按 P2 的条件做，不把它当本轮前置。

**ambient / memory 不折叠进某一条对话。** ambient 是**项目级**后台流程，不是会话分支：

- 请求提示词原文是 `Generate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this local project: <projectRoot>`，目标是项目，不是某个 thread。
- 落盘文件 `~/.codex/ambient-suggestions/<projectHash>/ambient-suggestions.json` 的字段只有 `projectRoot`、`generatedAtMs`、`currentSuggestionIds`、`suggestions`，没有 thread id；同一时段还存在指向另一个 `projectRoot` 的文件，说明键是项目而非会话。
- `d007` 在 12:51:54 开始，早于主 thread 的 12:53:54，且使用仓库快照 `0c4c681`；主会话首笔是 `4a4108f`。把这次运行绑到主会话会混淆两个时间点的项目状态。

因此 ambient / memory 进入后台，保留成本与请求事实，但不改变主会话链。标题若做跨组归属，ambient / memory 不跟随：它们的绑定键是 `projectRoot`，不是某条用户消息。若未来上游提供显式父 thread，再评审是否按父 thread 折叠；当前不写伪造父子关系。

### P1：OTLP 服务名显式登记与去重

先把 [Codex 映射](../../../../src/sources/otlp/mapping.ts#L87-L106)的 originator 显式加入 `codex-app-server`。不做 `-`/`_` 归一化：mapping 表的设计是方言差异全部收在表里，归一化会顺带放宽所有服务规则，属于跨规则语义变化。旧下划线名继续保留。

`codex-exec-server` 不登记：139 条 span 里没有 `session_task.turn`，登记只会增加分类成本。

单独放行会重复计数，去重必须与登记同批交付。当前两路证据的情况：

- magpie 行不保存 `turn.id`，代码里也没有读取 `client_metadata` 的地方。
- OTLP 的 `turn.id` 只在 `raw_otlp_span.attributes_json` 里，`SpanMapping` 没有这一项。

实施分两步：

1. **建立 turn 身份落点**：magpie 侧从请求体读 `turn.id` 写入 `source_facts_json`；OTLP 侧从 span 属性读 `turn.id`。两边都拿不到时才退化为 `thread_id + 时间窗 + 模型`。
2. **双向去重**：OTLP 建行前查 magpie；magpie 建行前查 OTLP；两支都错过时留一条晚到合并路径。晚到合并落在哪一层（摄入路径、[reconcile](../../../../src/reconcile.ts) 的补写或派生前的合并）实施时定。只做 OTLP 侧查询会漏掉 OTLP 先到、magpie 后到的顺序。匹配依据写进 `source_facts_json`，便于复核。

顺序上先有 turn 落点与去重，再放行服务名。`SPAN_RULES` 改表即升 `OTLP_MAPPING_VERSION`。分类只对 `session_task.turn` 建行，其它 span 保持跳过。

这是交接约束：服务名与去重不能拆成两个提交。只把 `codex-app-server` 加进白名单，每个 turn 会多出一条 `via='otlp'` 行，与 magpie 行重复计数。

风险：`codex-app-server` 有十万级 span，注册后分类成本与重复行风险都要用真实流量核对；去重窗口参数见未决问题。

### P1/P2：跨组标题归属（验收档位决定）

交接约束：标题识别修好后，标题请求仍属于另一个 `conv_key`，`model_title` 只落在标题 thread 上。只改来源类别与双键解析，主会话拿不到 Codex 生成的标题。这一条决定验收档位，不决定技术路径：

- **最小档**：只要求左栏能分辨主对话。P0 的用途识别加输入清洗已经够；主会话标题为用户首句，标题 thread 折叠。跨组归属不做。
- **模型标题档**：要求主会话标题是 Codex 生成的「重绘 ATC 矩阵 IP」。跨组归属与 P0 同批交付，不能拆成后续增量。

无论哪一档，跨组归属都有前置条件没满足：

- `request` 表没有 workspace 列，仓内也没有这个字段，按 workspace 约束的匹配写不出来。
- 列表读取不碰正文；能拿到的 `derive_request_result.title` 是 60 字截断并压过空白的值（[TITLE_UNICODE_LIMIT](../../../../src/derive/decision.ts#L447)），不是用户消息原文，无法与标题提示词的 `User prompt:` 段做逐字指纹。
- 主会话侧没有用户消息指纹的落点。只把 hash 写进标题请求的 `source_facts_json`，读侧没有可比的另一端。

若选最小档，本轮不做归属；若选模型标题档，按下面的最小路径实施：

1. 在 derive 阶段为参与链请求新增用户消息指纹列（新派生列 + 显式重建）。
2. 标题请求成功后，从 `User prompt:` 段生成同口径指纹，写 `source_facts_json`。
3. 读侧在同一 agent、同一时间窗内按指纹匹配；唯一命中才把标题挂到该会话，零命中与多命中保持未绑定。

绑定只改展示用的标题来源，不改 `conv_key`、不写父子列。误绑风险仍在：同一段用户文本可以在多个会话重复出现，跨时间窗的相同 prompt 也会误绑。没有 `parent_thread_id` 时，内容指纹不是身份凭证。

档位选择的依据是用户预期，不是实现难度：主会话标题回到用户首句后，左栏的辨识问题已经消失；模型标题只是更精炼的展示。若产品验收坚持原验收里的「重绘 ATC 矩阵 IP」，就必须接受指纹派生列与显式重建的成本，不能只做来源类别与双键解析。

### P2：Codex 原生 hook

Codex 原生 `hooks.json` 目前只接 skills-manager、intent-memory、memmy，**没有 ATC**；ATC 的 Codex 正文与会话来自 magpie gateway 的薄 hook。正式集成应把这一依赖写进接入文档，并单独评审是否安装原生 hooks。安装会修改用户 Codex 配置，属于需要上游/用户配合的范围，不在本提案首轮内执行。

### 交付与版本

用途分类、标题解析和输入解释都有可观察行为变化。实施时在最新基线上提升 `PURPOSE_VERSION`，并核对同步组与切片组持久化的标题、摘要算法版本，分别更新受影响算法；不把 `derive_version` 的更新次数当算法版本。

改 `SPAN_RULES` 必须同时提升 `OTLP_MAPPING_VERSION`（[mapping.ts](../../../../src/sources/otlp/mapping.ts#L18)注释写明改表即升）。输入解释不是脱敏变换，不动 `PRIVACY_TRANSFORM_VERSION`。

历史按显式 rebuild 交付。实施前只读枚举候选：本次 4 个 `conv_key`、10-26 的 ambient/memory 行、OTLP 服务名修复后新增的 turn 行，以及 P0 输入清洗影响到的 Codex 派生标题。重建以整个键为作用域，报告同键其他 agent 与用途的影响；不可读、缺证据、保留旧版本与错误终态分别计数。重建只修用途、标题与展示标志，不改 `conv_key`、原生 session 或证据身份。真实库操作按运维手册安排窗口与备份，本提案本身不执行任何写库、配置调整或服务重启。

## 未决问题

1. **请求级 `thread_source` 分布。** `b4ae` 的 1 条 `chat` 与 1 条 499 未知行、10-26 的 memory + chat，需要按 `req_id` 列出各自的 `thread_source` 与 magpie `kind`，才能确定 P0 的覆盖边界。未列出的行不能按 thread 级结论推断。
2. **验收档位。** 主会话标题要用户首句（最小档）还是 Codex 生成的模型标题（模型标题档）。最小档不需要跨组归属；模型标题档必须与 P0 同批，并先补主会话侧指纹派生列。需要产品确认。
3. **组内混合行的产品规则。** 已识别后台用途与未知行同组时，是整组进后台、保留在列表，还是拆成两条卡。本文选「有后台用途且无已识别主用途才折叠」，需要产品确认。
4. **`parent_thread_id` 缺失。** Codex 当前的 `x-codex-turn-metadata` 没有父 thread 指针。标题只能靠内容身份绑定，ambient 只能按项目归后台。应向上游提出补充父 thread 或 `thread_source` 的稳定契约；在此之前不猜身份。
5. **OTLP 去重窗口与到达顺序。** `turn.id` 两侧都拿不到时只能用 `thread_id + 时间窗 + 模型`。还要覆盖 OTLP 先到、magpie 后到的合并路径；实施前要用真实流量测误配率，并把结果写进验收记录。
6. **主会话侧指纹落点。** 跨组标题归属落地前，必须先给参与链请求加派生指纹列；这会改读取成本与重建范围，需要单独评审。
7. **`codex-exec-server` 是否登记。** 它是工具执行侧，目前 139 条 span、没有 turn。若登记，只应保留明确映射的 span 类型，不能把工具 span 变成请求行。

## Alternatives considered

**把这四个 `conv_key` 直接合并成一条会话。** 会破坏真实执行边界，也会把项目级建议和旧快照运行混进主对话。Hermes 的两份证据已经证明「合并身份」不是降噪手段；本提案只改用途与展示。

**按时间接近或标题相似度绑定标题与主会话。** 并发对话、重复提问和多项目切换都可能重叠。内容身份至少要求提示词逐字一致，且唯一命中才绑定；时间只作为候选约束，不作为证据。

**把所有 ambient 都折叠进当前活跃会话。** ambient 的提示词与落盘键都是 `projectRoot`，同一次运行可能发生在主 thread 之前、使用旧 commit。绑定会污染主会话的链与项目状态。

**在页面隐藏所有单笔或缺正文条目。** 单笔可能是真实新会话，缺正文也是需要保留的采集事实。由页面另做模板匹配会重复服务端语义；应由服务端给出后台标志。

**先修 OTLP 服务名，不做去重。** 会为每个 turn 多造一条无正文行，计数与费用翻倍。服务名与去重必须同批交付，或者先让 OTLP 只补 magpie 缺行。

**把 `codex-app-server` 与 `codex_app_server` 做 `-`/`_` 归一化。** 一次改动会让所有服务规则的匹配同时放宽，未来 `claude-code` 与 `claude_code` 也会互相命中。mapping 表本来就是方言登记处，显式加一个值更小，也更容易在测试里钉住。

**改通用 `parseTitleReply` 接受双键 JSON。** 它同时服务 `titleDecision` 的通用兜底，放宽后任意聊天回复里的同名 JSON 都可能被排除主链。双键解析只能放在 Codex adapter 内，并用来源类别或指纹收口。

**直接改写历史派生列或删除辅助记录。** 会掩盖旧版本依据，或丢失真实调用与费用。历史使用显式重建，缺证据保持未知。

## Acceptance criteria

### 合成回归

- 构造 `client_metadata["x-codex-turn-metadata"].thread_source='thread_title'`、回复 `{"title":"重绘 ATC 矩阵 IP","description":"…"}` 的请求，经正文存储与结算路径后 `req_kind='title'`、`chain='exclude'`、`model_title` 非空；改动前同一输入返回 null。普通 `chat` 回复同样 JSON 不得被当标题。
- 构造 `thread_source=ambient_suggestions` 与 `memory_consolidation` 的请求，组被标后台；`conv_key` 不变，请求数、用量与费用在折叠前后守恒。
- 构造一个含 1 条可读 ambient 请求与 1 条无正文 499 行的组：`background` 标志成立，组不因未知行留在主列表；同组混入一条已识别主用途后，标志撤销。
- 构造标题提示词与主会话用户消息文本逐字相同（仅尾部空白）的请求，模型标题档下读侧唯一命中并显示主会话标题；零命中与多命中保持未绑定，不抛错、不误挂。
- 构造 `service.name=codex-app-server`、`name=session_task.turn` 的 OTLP span，能建 1 条请求行；同一 `thread.id + turn.id` 已存在 magpie 行时只保留 1 条；OTLP 先到、magpie 后到同样只保留 1 条。旧下划线名继续可用，未知服务继续记 `service_not_registered`；`OTLP_MAPPING_VERSION` 已提升。
- `# AGENTS.md instructions for …`、`<external_codex_apps_open_page>…` 与 `<turn_aborted>` 不再成为可用标题；包装后存在真实用户指令时必须保留；其他标签与未知标签的反例照旧。

### 真实复核与完成条件

- 对本次批次完成显式重建后，`GET /api/sessions` 中该 Codex 批次只出现 **1 条主会话卡**，标题 thread 不再单独成卡。最小档验收：主会话标题为用户首句；模型标题档验收：主会话标题为「重绘 ATC 矩阵 IP」。
- ambient 与 memory 记录进入后台区域（或按产品决策的独立面板），不进入主会话链；52 条请求与对应费用在列表和后台合计中仍可核对。
- 数据库请求行总数不因折叠减少；`conv_key`、hook/route/ledger/otlp 证据行与正文在重建前后守恒。
- `service_not_registered` 不再出现 `codex-app-server` 与 `codex-exec-server`；`via='otlp'` 新增行与 magpie 行不重复计数。
- 运行能对本次回归失败的最窄测试、类型检查和提交前 `verify:notes`。代码验收与真实流量验收分开，只有合成通过不能关闭真实列表复核。

## Risks

`thread_source` 只在有正文时可得。hook-only 或 OTLP-only 行可能拿不到它，若为了降噪而按时间或模型推断，会把真实会话误标后台。实施时宁可保留 `unknown`，不扩大推断规则。

两路证据可能冲突。`thread_source` 给出辅助值时按辅助处理；它是 `user` / `composer` 而 magpie `kind` 是辅助值时，不据此折叠，只记 `source.conflict` signal，落回通用判定。`thread_source` 缺失时才用 `view.source`。这是宁可漏判、不误判的顺序；若真实流量里冲突频繁，实施前要重新评审。

组级后台标志改变页面可见集合，可能让用户以为记录被删除。判据必须要求「有已识别后台用途且无已识别主用途」，验收同时证明请求、费用与证据未丢失。

标题的内容身份依赖提示词与用户消息的可读性。重复 prompt、跨 workspace 或跨时间窗的相同文本会造成误绑；唯一命中约束能限制范围，但不能把内容指纹当身份凭证。跨组归属落地前先补主会话侧派生列，不能让读侧去碰正文。

OTLP 注册会引入十万级 span 的分类成本与重复行风险。去重规则依赖 `turn.id` 或时间窗，窗口参数需要用真实流量校准；在去重完成前放行服务名是净负收益。晚到合并如果只做一侧，仍会重复计数。

共享输入解释的包装规则会影响其他标签。`# AGENTS.md` 不能被当作通配前缀，`<external_codex_apps_open_page>` 也不能因一条消息含包装就把整个请求判成旁路；跨标签反例属于本次必要范围。
