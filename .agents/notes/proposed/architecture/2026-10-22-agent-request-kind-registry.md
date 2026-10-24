# Agent Note: Agent Profile 与请求类别注册表

Status: proposed

本提案作为 Agent 语义问题的输入材料保留。下一轮统筹范围与顺序见[架构演进方案 v2](../../../../docs/architecture-evolution-v2.md)，具体规则修正见[联合评审](../../../../docs/agent-request-kind-review.md)。本文尚未修订的 Interface、匹配门槛与迁移验收不直接作为执行依据。zcode 一家的实测形状、它需要的那条规则与验收见[zcode 的 Agent 支持](../feature/2026-10-24-zcode-agent-support.md)。

## Problem

ATC 要成为本机所有 agent 的唯一 trace 入口。它的记录单位是请求，阅读入口是会话。每一笔经过 magpie 的请求留一条记录，账本保存请求本身，派生字段再把请求组织成可读的会话。这个选择来自两个前身：AVA 自己判定会话归属，判不准；ATA 的事件账本要先还原成请求，才能知道模型当时看到了什么（[项目定位](../../../../docs/project-overview.md)）。本项目的回答是不再自己发明归属，直接用 magpie 已经输出的请求、agent 与 session，把事实记下来，视图从事实派生。

因此账本有两层不能混：请求是事实，会话是派生视图。三路证据先收敛成同一条请求，派生字段在摄入时算好、证据到达时局部重算。查询与页面的设计前提是只消费派生结果（[架构设计](../../../../docs/architecture-design.md#派生字段)）。协议差异已经有自己的位置，`anthropic` 与 `chat` 的 wire shape 由 `src/protocols.ts` 的适配器转成统一字段，未实现的协议保存原对象并标 `unsupported`。Agent 身份则完全沿用 magpie 的标签，ATC 不解析 User-Agent，不维护 Agent 名单（[项目定位](../../../../docs/project-overview.md)）。

缺的是夹在协议适配与派生之间的那一层：一笔请求对某个 agent 意味着什么。提案撰写时，派生管线只认识普通对话和硬编码的 Title Generator，页面又从 `reply_preview.startsWith('标题 · ')` 重新猜一次标题。这带来三个后果。

- harness 的旁路请求没有地方声明，只能伪装成 chat。Claude Code 的 auto mode 分类器是当前样本：两条拼接消息、工具数为 0、回复 `<block>no`，被标成 `branch`，折叠行只显示 `<transcript>`。2026-10-21 23:46 的快照里，641 笔请求中有 120 笔 Stage 1、8 笔 Stage 2 分类器；样本会话 130 笔中有 42 笔。
- 每加一种 agent 语义，要同时改 derive、查询层和页面。改漏一处，三处判断就会互相矛盾。查询层还会把未知 `req_kind` 折叠成 `chat`、未知 `chain_role` 折叠成 `main`，即使派生写出了新值，数据模型也表达不出来。这两处折叠现已按本节末尾的交付现状改为原样保留。
- 页面从摘要字符串反推语义，显示结果与账本里的派生值可以不一致。标题请求已经出现这条裂缝，分类器只是让它变得明显。

这不是一笔请求的显示问题，而是通用账本模型缺少一个存放 agent 语义的位置。多 agent 是 ATC 的前提：同一本账上会出现 Claude Code、OMP、Codex、Pi 等不同 harness，每个 harness 都可能在自己的主循环之外发标题、压缩摘要、权限分类、记忆提取这类旁路请求。Title Generator 与 auto mode 分类器已经在本机样本里实测到，其余类别是否出现取决于具体客户端。结构上的问题是同一个，通用派生管线不应该认识这些特称。

首版 tag 之前是补这个缝成本最低的时候。仓库的立场是地基优先于兼容，目录、命名与接口可以自由调整（[根 AGENTS.md](../../../../AGENTS.md)）。现在补，代价是一次 `derive_version` 升版与重跑。等 schema 与派生契约冻结后再补，代价是迁移与兼容路径。

## Proposal

把 agent 语义从通用派生管线里移出去，做成一个显式的、静态的扩展缝。账本继续只认识请求、证据与派生。一笔请求属于标题生成还是权限分类，由 Agent Profile 挂载的 RequestKind 纯函数判定。分类器不是这个机制要新增的能力，它只是第一个只属于某个 agent 的类别。Title Generator 是共享类别，而且已经交付，先迁进注册表，机制因此有一条现成的回归基线。

缝放在派生阶段，因为只有那里同时具备三个条件：agent 标签、回复形状与请求体已经收敛；同一笔请求只判定一次；判定结果能随 `derive_version` 重跑。把缝放在 ingest 太早，agent 与账本证据可能还没到；放在查询或页面则会让每个消费者各自解释一遍，标题的现状已经证明这条路的代价。

三层各自负责一种变化：

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| 协议适配层 | anthropic 与 chat 等 wire shape 转成统一的消息、文本块与工具调用视图 | agent 语义、请求类别 |
| Agent Profile | 声明某个 agent 启用了哪些 RequestKind | 数据库、网络、页面 |
| RequestKind | 纯函数，判断一笔请求是否属于这个类别，返回派生摘要与证据 | 数据库查询、调用顺序 |

派生时只经过一个缝：

```ts
const view = buildRequestView(db, reqId);
const profile = profileFor(row.agent);
const match = classifyRequest(profile, view);
```

`match` 返回 null 就走现有 chat 路径。命中则写 `req_kind`、`chain_role='aux'`、`input_preview`、`input_preview_kind`、`reply_preview`，标题生成再写 `model_title`。

接口保持窄，匹配器不碰数据库：

```ts
type RequestView = {
  agent: string | null;
  protocol: string;
  messageCount: number;
  toolCount: number;
  systemTexts(): string[];
  messages(): unknown[];
  replyText(): string | null;
  requestFields(): Record<string, unknown>;
};

type RequestKindMatch = {
  kind: string;
  chainRole: 'aux';
  inputPreview: string | null;
  inputPreviewKind: 'aux' | 'title';
  replyPreview: string | null;
  modelTitle?: string | null;
  evidence: string;
};

type RequestKind = {
  id: string;
  label: string;
  match(view: RequestView): RequestKindMatch | null;
};

type AgentProfile = {
  id: string;
  kinds: RequestKind[];
};
```

初始注册表把跨 agent 与 agent 特有分开：

```ts
const SHARED_KINDS = [titleGenerator];

const claudeProfile = {
  id: 'claude',
  kinds: [...SHARED_KINDS, autoModeClassifier],
};

const ompProfile = {
  id: 'omp',
  kinds: [...SHARED_KINDS],
};

const genericProfile = {
  id: 'generic',
  kinds: SHARED_KINDS,
};
```

Title Generator 在 Claude Code 与 OMP 上都能识别，放共享集合；auto mode 分类器只属于 Claude Code，放 `claude` profile。共享类别只依赖协议与回复形状，不依赖 agent 特称。agent 特有类别只注册在对应 profile。agent 标签缺失或未知时走 generic，不用内容形状去猜 agent。

## 边界：这不是什么

- **不是 agent 身份系统。** Profile 的 key 是 magpie 给的标签，未知标签走 generic；不解析 User-Agent，不维护 Agent 名单，不把标签当身份凭证。
- **不是插件系统。** RequestKind 是进程内编译期注册的纯函数表，没有动态加载、沙箱或第三方扩展点。
- **不是通用 trace 摄入协议。** 不接 magpie 之外的网关，不改变三路证据模型，也不给别的网关预留适配层。
- **不是给页面加标签。** 页面只消费 `req_kind` 与 `chain_role`，删掉从摘要字符串重新识别的启发式。
- **不是把分类器藏起来。** 分类器仍然是一笔请求，仍然入账，仍然可审计；变的只是它的语义从 chat 改成 aux。

## 分类器匹配规则

`auto-mode-classifier.match` 用组合信号，不靠单一字符串：

- system 文本包含 `security monitor for autonomous AI coding agents`
- `stop_sequences` 包含 `</block>`
- 回复匹配 `<block>yes|no`
- 消息数为 2，工具数为 0

至少命中两个独立信号才算。只命中 `<block>no` 不分类，避免普通对话恰好输出这个标签。命中后返回：

- `kind = 'auto-mode-classifier'`
- `chainRole = 'aux'`
- `replyPreview = '放行 · <block>no'` 或 `'拦截 · <block>yes'`
- `inputPreview` 从 `<transcript>` 最后一条工具调用提取待裁决动作，解析失败写 `待裁决动作`
- `evidence` 记录命中的信号，例如 `system.security-monitor+stop.block+reply.block`

匹配器只注册在 `claude` profile。agent 缺失时不启用，宁可退回 chat，也不误判。

## 存储与派生

复用 `req_kind` 作为 RequestKind 的稳定 ID，不新增专表：

| 字段 | 规则 |
| --- | --- |
| `req_kind` | `chat`、`title`、`auto-mode-classifier` 或未来稳定 ID |
| `chain_role` | 所有旁路请求写 `aux` |
| `prev_relation` | 旁路请求写 `aux`，不参与前缀比较 |
| `input_preview_kind` | 增加 `aux`，标题继续用 `title` |
| `model_title` | 只有 Title Generator 写 |

`assignChainRoles` 已经只处理 `req_kind='chat'`，新类别不会进入主链。`SESSION_TITLE_SQL` 也只取 `req_kind='chat'`，分类器不会污染会话标题。

查询层必须保留未知值。`getRequest` 不能把未知 `req_kind` 折叠成 `chat`、未知 `chain_role` 折叠成 `main`，未知值要原样返回，页面用通用样式兜底。正文不可读时，派生要保留已存的 `req_kind`，不能重新判成 chat。现有 Title 逻辑已经这样处理，新机制沿用。

`derive_version` 升版，按会话重跑派生。不需要 schema 迁移，现有 `scripts/backfill-fingerprint.ts` 的入队与 drain 模式可以复用。可选的 `req_kind_evidence TEXT` 用于记录分类依据，审计价值高，但不是第一版的必要条件。

## 页面与序号

页面只读派生结果，不再识别请求：

- `req_kind='title'` 显示 `标题生成`
- `req_kind='auto-mode-classifier'` 显示 `自动模式分类`
- `chain_role='aux'` 不进 USER 气泡，显示一行辅助请求摘要，可折叠
- 未知 `req_kind` 显示原始 ID 和通用辅助样式

需要替换的启发式（前两条已随用途判定交付删除，记在此处是为了说明当时要动的位置）：

- `web/app.js` 的 `isAuxTitleRequest`
- `web/app.js` 里 `reply_preview.startsWith('标题 · ')` 的判断
- `web/app.js` 把 `branch` 直接写成 `另起一支` 的文案，至少区分 `aux` 与真实分支

账本里的 `Request N` 可以是全部请求的索引。会话视图的轮次只数主链请求，辅助行用 `辅助` 或 `A1` 标记。这样不会再出现 Request 10 是一笔分类器调用的误解。

## 新增一个 RequestKind 的流程

1. 抓一笔真实样本，确认 agent、协议与请求形状。
2. 判断它属于跨 agent 还是某个 agent 独有。
3. 在 `src/features/<id>.ts` 写纯 `match(view)`，返回摘要与 evidence。
4. 注册进对应的 Agent Profile。
5. 如果是新 ID，扩展 `req_kind` 的 TypeScript 类型与页面标签映射。
6. 补四类合成测试：命中、形状相似但 agent 不符、正文缺失、重跑派生幂等。
7. 升 `derive_version`，在库副本上重跑派生，核对会话标题、主链与序号。
8. 只有第二个 RequestKind 也需要同一个新概念时，才加 schema 字段。

## 与现有记录的关系

**交付现状。** 用途判定已交付，形状与本文不同：`req_kind` 用作稳定 ID，旁路请求写 `chain_role='aux'`，未知值原样保留，正文不可读时保留已存 `req_kind`，标题请求单独写 `model_title`——这些都已落地。判据与依据记在 `purpose_*` 列上（`purpose_version`、`purpose_rule`、`purpose_signals`、`purpose_chain`、`purpose_pending`），不是本文设想的 `req_feature` 文档加 `req_kind_evidence` 列，见[请求用途与链](../../implemented/architecture/2026-10-22-request-purpose-and-chain.md)与[组发布前处理请求](../../implemented/architecture/2026-10-22-request-work-before-group-publish.md)。页面按 `purpose_chain` 与 `chain_role` 读：本文点名的 `isAuxTitleRequest` 与 `reply_preview.startsWith('标题 · ')` 已经不在，`web/app.js` 里 `prev_relation === 'branch'` 的文案仍在。未建的是注册表机制本身：没有 `src/features/<id>.ts` 的纯匹配器，也没有 Agent Profile 注册入口，新增一个类别仍要改派生代码，本文的「新增一个 RequestKind 的流程」尚未成立。

**扩展缝的触发条件。** 当前没有第二个消费者：zcode 的实测结论是只有记忆维护轮一类需要新规则，输入壳与标题形状已被通用规则正确解释，因此[zcode 的 Agent 支持](../feature/2026-10-24-zcode-agent-support.md)选择给它加一条用途规则，没有建 Profile。注册表在满足下列任一条件之前不动工，避免为一个消费者预建框架：

- 出现第二种 agent 特有类别，需要在同一处注册、或需要按 agent 门控同一类别的不同变体；
- 新增类别的改动需要同时落在派生、查询与页面三处各写一遍；
- 某类判定需要独立的证据列（届时 `req_kind_evidence` 的必要性才成立）。

在那之前，新类别按 zcode 那条路加在 `classifyPurpose` 的优先级档位里，并复用 `purpose_rule` 记录是哪条规则判的。

这篇提案不取代 [Title Generator 与主链分离](../../implemented/feature/2026-10-21-title-generator-and-main-chain.md)。标题请求的识别与主链规则继续以那篇为准。这篇只把它的 `req_kind='title'`、`chain_role='aux'` 扩展成可注册的通用机制。

语义指纹与任意祖先共同前缀、正文不可读请求保持中性这两条规则不变，分别见[语义指纹与任意祖先共同前缀](../../implemented/architecture/2026-10-20-semantic-fingerprint-and-ancestor-predecessor.md)和[正文不可读的请求保持中性](../../implemented/bug-fix/2026-10-21-unreadable-requests-stay-neutral.md)。

分类器的证据与频率在[auto mode 分类器请求研究](../../../../docs/auto-mode-classifier-research.md)，决策与验收以本文为准。

## 待评审的决策点

1. `req_kind` 直接用作 RequestKind ID，还是保留宽类别再加 `req_feature`。本文建议前者，复用现有列，不迁移。
2. 分类器请求在会话视图里显示为折叠的辅助行，还是完全隐藏。本文建议显示但折叠，账本始终保留。
3. 是否加 `req_kind_evidence` 记录分类依据。本文建议加，成本是一列和一次回填；不想动 schema 就先写日志。
4. agent 标签缺失但内容指纹明确命中时，是否分类。本文建议不分类，走 generic，失败方向保守。

## Alternatives considered

**只加 `req_kind='classifier'`，在 derive 里写一个判断。** 这是最短路径，一两个文件就能解决当前问题。代价是 web 里的标题启发式还在，下一个 agent 的旁路请求还要再改一次 derive。如果确定只处理这一种分类器，可以接受；它不能回答多 agent 的扩展问题。

**在 derive 与 web 里直接写 `if (agent === 'claude')`。** 判断会散落在派生、查询和页面三处，测试只能靠整条链路，新增 agent 时容易漏改。

**用配置或正则表驱动。** 分类器需要解析 transcript、提取待裁决动作、生成 verdict 摘要，纯正则做不了；配置还会绕过类型检查与合成测试。

**做动态插件加载器。** 这是本机单进程采集器，RequestKind 是静态纯函数列表，不需要运行时加载、沙箱或插件市场。

**把检测放在 web。** API 的其他消费者也需要分类结果，页面只应该负责展示。

**每个 RequestKind 建一张表。** 派生列已经足够，专表会增加迁移、查询与回收成本。

## Acceptance criteria

- 合成一笔 Claude Code 分类器请求后，`req_kind='auto-mode-classifier'`、`chain_role='aux'`、`prev_relation='aux'`，不进入主链，会话标题不受影响。
- 普通对话回复恰好是 `<block>no`、但 system 指纹不匹配时，仍记 `chat`。
- 同一请求把 agent 改成 `omp` 时，仍记 `chat`，证明类别受 Agent Profile 门控。
- 正文已回收的分类器请求重跑派生后，`req_kind` 与 `chain_role` 保持不变，不回退成 chat。
- 页面把分类器请求显示为辅助行，包含类别、判定与待裁决动作，不画成 USER 气泡；未知 `req_kind` 安全兜底。
- 现有 Title Generator 测试不变，标题请求仍是 `req_kind='title'`、`chain_role='aux'`，会话标题优先级不变。
- 重跑派生幂等；`bun test`、`bun run typecheck`、`bun run verify:notes` 通过。
- 不新增 schema 列时无迁移；若加 `req_kind_evidence`，回填允许为空，并在运维手册记录。

## Risks

- **误判**：`<block>no` 是通用标签，必须组合多个信号；只命中一个就退回 chat，并保留 evidence 供追查。
- **版本漂移**：分类器 system 提示词会随 Claude Code 版本变化。匹配稳定子串，不匹配整段提示词；不命中时退回 chat。
- **正文已回收**：分类结果必须保留，重跑派生不能把已回收行重置成 chat。
- **性能**：`RequestView` 懒加载，先看回复、消息数、工具数，最后才解压 system 文本；需要测骨架解压的增量成本。
- **agent 标签不可靠**：magpie 的 `agent` 是客户端标签，不是安全边界。未知 agent 走 generic，失败方向保守。
- **重跑派生改变序号与标题**：先在库副本上重跑，核对主链、会话标题与页面序号，再对真实库执行。
- **过度抽象**：注册表只做分类与摘要，不接管身份、协议、存储或 UI；Agent Profile 第一版只有 `kinds`，不加全能接口。
