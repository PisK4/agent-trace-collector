# Agent Note: zcode 的 Agent 支持——覆盖实测、记忆维护轮识别与标签补齐

Status: proposed

本文承接两篇既有提案：[Agent Profile 与请求类别注册表](../architecture/2026-10-22-agent-request-kind-registry.md)拥有扩展缝本身，[字段保真与 magpie 对标](../architecture/2026-10-22-magpie-parity-and-field-fidelity.md)拥有 direct 行的入口决定。本文只记录 zcode 这一家的实测形状、它需要的那一条请求类别规则，以及一处标签补齐，不复述缝与入口的提案。调研于 2026-10-24 完成，全程只读；引用的本机数字带采集时间，随使用增长。

## Problem

zcode 是本机实际在用的客户端之一，但它在 ATC 里几乎不可见，而可见的那一部分又被解释错。

覆盖的差距是数量级的（实测，2026-10-24）：magpie 侧 30 天内 `agent=zcode` 有 6,365 次调用，ATC 的 `raw_ledger` 里 zcode 只有 56 笔。差在入口：用量同步写死 `via=through`（`src/sources/magpie.ts:644`），而 zcode 的请求大部分不经网关。这条 trace 的两条会话最能说明差距：`session_b26f1fe1…` 走 magpie，56 笔全部入库；与它并列的 `session_5b33aaf8…` 由 provider `account:zai-start-plan` 直连，ATC 三路证据各 0 行，同一会话在 magpie 侧可见 67 笔。入口决定属于上文的对标提案，本文只记一个结论：**先接入口，再谈语义**，否则本文的规则只覆盖不到百分之一的 zcode 流量。

已入库的那 56 笔里，通用解释层大部分是对的：会话键取自 `x-session-id`（在 magpie `sessionOf` 的取值列表内），三路证据齐（每笔 `have=7`）；注入提醒与用户正文拼在同一条 user 消息的多个文本块里，逐块清洗能正确取出用户的话；标题请求的回复是单键 JSON，命中既有的回复形状规则。所以本文不主张给 zcode 建语义 Profile。

被解释错的是 zcode 在主循环之外追加的**记忆维护轮**（实测 + 版本锁定）：

- 两笔请求（`req_id` 2274、2520）的最后一条 user 消息是 `You are now acting as the memory extraction subagent.` 开头的整段指令，由 zcode 的 harness 追加，用户没有说过这句话。
- ATC 把它当成主链上的新增用户输入（`input_preview_kind='delta'`），并让该笔请求的折叠行标题变成这串提示（`title_source='user_delta'`）。
- 同一轮还有两笔续写（消息尾是工具结果，`responseId` 形如 `as-8iu5ewwssr`，且**不在 zcode 自己的 rollout 文件里**），三轮连续把这条链重建到 ord 21；用户在 15:16 之后的 45 笔真实对话接不上链上最新节点，`prev_req_id=null`、`prev_relation='branch'`；按主链判定（`src/derive.ts:325-352`，第一个根是主链），这 45 笔全部 `chain_role='branch'`，而 14:54 的 11 笔——中止的一轮加记忆维护——占着主链。
- 对照 Claude Code：全库 `input_preview like '%memory extraction%'` 只有上述 zcode 2 笔，Claude Code 侧没有这种注入；它的子代理靠 `x-claude-code-agent-id` 分成独立 actor（333 笔 subagent 各自主链）。zcode 的等价信号不吃 header，所以这类请求落在父会话里。

zcode 的语义信号全部走 header，而 header 不在任何证据通道里（`raw_hook` 没有 header 列、账本没有、`raw_route.payload_json` 里 `x-zcode` 命中 0 行）。这些 header 里有两个名字会误导：`x-zcode-agent: glm` 是后端名不是子代理标识，`x-title: Z Code@electron` 是窗口标题不是会话标题。还有第二处缺的是标签：`web/app.js:346` 的 `AGENT_LABELS` 只有 `claude` 与 `omp`，zcode 在筛选条上显示成裸 id，而 magpie 自己的 Agent 注册表里是 `{id: zcode, name: ZCode, icon: zcode}`。

## Proposal

### 记忆维护轮：一条请求类别规则，两层各用一次

指纹（实测，两次出现都成立）：末条 user 文本块以 `You are now acting as the memory extraction subagent.` 开头，且同一块内含 `use them to update your persistent memory systems.` 与 `paths inside the memory directory only`。中间的消息条数会变（实测出现 ~11 与 ~57 两种），所以指纹不含数字。形状信号另记：同一轮的 3 笔 `max_tokens` 都是 5000，而主轮是 128000；这个信号只写进 `signals`，不作门槛，理由与分类器一致（上游改额度时仍要认得出这一轮）。

指纹常量放一处、两层共用，避免同一个字符串写两遍。两层各自的作用：

| 层 | 位置 | 产出 |
| --- | --- | --- |
| 请求用途 | `src/semantics.ts` 的 `classifyPurpose`，插在强指纹档（分类器之后、来源 kind 之前） | `req_kind='memory-maintenance'`、`chain='exclude'`，`modelTitle=null` |
| 输入解释 | `src/input-interpretation.ts` 的内容规则（与 `SKILL_INJECTION`、`STEPPED_AWAY` 同档） | 该段文本 `state='injected'`、`kind='system_notice'`，不进用户气泡、不进标题候选 |

用途层给出 `exclude` 之后，其余事实由既有机制自动落定，不需要新代码（版本锁定）：组阶段把 `purpose_chain='exclude'` 的行写成 `prev_relation='aux'`、`delta=null`、`chain_role='aux'`，并把它排除在祖先比较之外（`src/derive.ts:488-522`）；非标题的 aux 行不取用户增量当标题，只留模型标题或时间兜底（`src/derive-decision.ts:469-475`）。阅读端也已通用：`web/app.js:48-52` 与 `web/trace-view.js:83-85` 已按 `purpose_chain`/`chain_role` 渲染成一笔辅助记录，只需补一句中文标签。

输入层的规则要一并做，因为**只靠用途层不够**：指纹只命中记忆轮的第一笔，后两笔的末条消息是工具结果。若第一笔被排除、后两笔仍参与链，它们会以 2270 为父节点接上（最长完整前缀祖先，`src/derive-decision.ts:145-172`），增量里 15 号位仍是那串提示，于是 `deriveTitle` 会把假标题挪到后两笔上。输入层认成注入后，`deriveTitle` 的 `state !== 'text'` 判断跳过它（`src/derive-decision.ts:276-283`），三轮都不再提供用户标题。

用途层的取数契约需要一处扩展：`readPurposeViewTx` 目前只解 role=2 的 System 块（`src/request-purpose.ts:158-175`），而指纹落在 user 文本块上。扩展内容是读取 `request_block` 里 role=0 且 ord 最大的那一行（一次单行查询、一个块解压），不随正文体积增长。这与[联合评审](../../../../docs/agent-request-kind-review.md)的成本契约一致：先复用实际派生上下文，需要新能力时再扩大 Interface。

`PURPOSE_VERSION` 由 3 升到 4，按既有重算路径处理：正文可读的行按新规则重算，正文已回收的行保留旧结论与旧版本号（`retained`），不把旧值冒充成本次结果。

### 标签补齐

`AGENT_LABELS` 增加 `zcode: 'ZCode'`。取值与 magpie 的 Agent 注册表一致，不自己发明显示名。

### 顺序

先接入口（归属见对标提案），再做本规则。本规则不依赖入口：56 笔现状样本已经能复现全部现象，可以先落地并验收。

## Alternatives considered

**按 agent 建 Profile，为 zcode 声明一整套类别。** 否决。实测下来只有记忆维护轮一类需要新规则；输入壳（`<system-reminder>`、裸文本、工具结果后紧跟提醒）与标题形状都已被通用规则正确解释。注册表提案与[联合评审](../../../../docs/agent-request-kind-review.md)已给出同一立场：不为只有共享形状的 Agent 建空壳 Profile。

**靠 header 判用途，例如 `x-zcode-query-source`。** 否决。三路证据都没有 header（实测），hook 的上下文契约也不含 header；把 header 引入采集层是另一个决定，且要动 magpie 侧，超出本文范围。指纹规则不依赖它，`session_title` 的识别继续靠回复形状（实测该请求的回复是 `{"title":"评估 Pair 功能案例扩展方案"}`）。

**用 `max_tokens` 小额当门槛。** 否决。分类器已经确立同类立场：形状信号写进 `signals`，门槛只认请求指纹。额度随上游版本变化，当门槛会在改版时静默失效。

**只做用途层，不做输入层。** 否决。假标题会从第一笔挪到后两笔（见上文），等于把问题搬了个位置。

**把记忆维护轮带出的整轮都标成辅助（跟随前驱传播）。** 否决。那需要一条跨请求的传播机制，是注册表提案明确要求避免的预建框架；本文的指纹规则已能让三轮都得到正确解释。

**把 zcode 的子代理当独立 actor 拆出来。** 否决，暂无依据。zcode 自己在会话库里有子会话谱系（`session.parent_id`、`task_type='subagent_child'`、`session_task_link`），但它在模型请求里没有可供 ATC 读取的关联字段（实测 56 笔 `subagent` 全空、`raw_route.subagent_id` 全空），本文样本里也没有子代理请求可对照。留到有真实样本再提案。

**直接摄入 zcode 自己的会话库（`~/.zcode/cli/db/db.sqlite`）。** 否决。它与 direct 行属于同一类身份问题（同一调用会被账本与本地库各记一次），且本地库是另一个存储格式的兼容面；对标提案已把 direct 行走在前面，本文不另开一条。

## Acceptance criteria

在合成数据上（不碰真实正文）：

1. 命中：`agent='zcode'` + 末条 user 块以指纹开头 → `req_kind='memory-maintenance'`、`purpose_chain='exclude'`、`prev_relation='aux'`、`chain_role='aux'`、`delta_ordinals=null`、`title_source='model_time'`；同一笔的输入解释为 `state='injected'`、`kind='system_notice'`。
2. 反例一：同样文本但 `agent='claude'` 或 `agent=null` → 不命中，仍按普通对话处理。
3. 反例二：`agent='zcode'`、末条 user 块提到记忆但语句不满足两个文本指纹（例如用户自己粘贴了一份记忆说明）→ 不命中。
4. 标题：构造一轮记忆维护加两笔工具结果续写，三轮都不得产出 `title_source='user_delta'`。
5. 链：把该轮插在两笔正常对话之间，重算后正常对话必须回到参与链，即后一笔的 `prev_relation='confirmed'`（父节点落在参与链上）且 `chain_role='main'`；若仍为 `branch`，先查清链判定的实际原因，再判断本规则的价值。

在本机库上回归（正文与账号不入测试，只核对派生字段）：

| 项 | 现状（2026-10-24） | 期望 |
| --- | --- | --- |
| 2274、2520 | `delta` 用户输入、`title_source='user_delta'`、承接 2270 的主链 | `aux`，`req_kind='memory-maintenance'`，标题回到时间兜底 |
| 2276、2278 | 承接 2274 的续写 | 不再提供用户标题 |
| 2522、2524 | 承接 2520 的续写（2520 起是分支链） | 不再提供用户标题 |
| 2390 起 45 笔 | `prev_relation='branch'`、`chain_role='branch'` | 回到参与链、`chain_role='main'` |
| 会话标题 | 首句，未被带偏（`SESSION_TITLE_SQL` 取最早一笔 `user_delta`） | 不变 |

`bun test` 覆盖上述合成断言，`bun run typecheck` 通过；`PURPOSE_VERSION` 升版后的重算在合成库上跑一遍等价性核对。

## Risks

- **误伤真实输入。** 指纹规则会在用户恰好粘出这两句话时命中。门槛因此要求 agent 与两个文本子串同时成立，且必须以固定前缀开头；仍属启发式，与分类器和标题兼容同级。命中面缩到 zcode 一家，但规则本身不做版本锁定，形态漂移时退回未识别并留原因。
- **只治一处症状。** 本规则解决的是记忆维护轮，zcode 的压缩（`session_input.kind='compact'`，实测 3 笔）与网页抓取处理（`x-zcode-query-source=web_fetch_processing`，实测 1 笔）同样属于主循环之外的请求，本文不覆盖。其中压缩请求若走网关，会在链上留下与本文同类的痕迹；等有可复现样本再逐条提案，不预建整套能力框架。
- **覆盖仍是少数派。** 不接入口的情况下，这条规则只作用于经网关的 zcode 流量。
- **链判定可能另有原因。** 第 5 条验收成立与否取决于父节点匹配的实际行为；若不成立，本文的价值判断要重做，而不只是调整规则。
- **升版重算的代价。** `PURPOSE_VERSION` 升版会让相关组重新结算一次用途；正文已回收的行按 `retained` 保留，不会被新规则覆盖。

## 边界外

- **cwd 与项目归属。** zcode 的 56 笔 hook 里 `cwd` 全空，`raw_route.folder` 也全空；而它的系统提示里 73 处都有 `Primary working directory`（对照：claude 侧 1,449 笔里 526 笔为空）。这指向 magpie 的目录抽取没有命中 zcode 的文案位置，需要先查 magpie 侧；ATC 侧没有可加的 feature。
- **direct 行与身份键。** 归对标提案；本文只提供 zcode 的量级证据。
- **zcode 子代理谱系。** 见 Alternatives considered 末两条。