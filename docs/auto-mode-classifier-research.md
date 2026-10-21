# Claude Code auto mode 分类器请求

2026-10-21 在本机 trace 库中核对到一类被页面按普通对话请求展示的记录。它来自 Claude Code 的 auto mode 权限分类器：每次工具调用前，harness 把会话快照和待裁决动作发给模型，要求返回 `<block>yes|no</block>`。本文记录这类请求的形状、识别依据、出现频率，以及它为什么在现有页面上看起来没有信息量。

## 结论先行

- 它是 harness 的旁路请求，不是用户发言，也不是主循环的回复。
- 回复 `<block>no` 表示不拦截，工具调用被自动放行；`<block>yes` 表示拦截。页面上的 `<block>no` 是分类器判定，不是对话内容。
- 出现频率不低。2026-10-21 23:46 的快照里，641 笔请求中有 120 笔 Stage 1、8 笔 Stage 2；同会话 130 笔中有 42 笔分类器。读主链时它是噪声，审计自动放行时它是证据。

## 请求形状

以 req 26020（2026-10-21 23:14:27）为例。请求头带 `cc_version=2.1.306.231; cc_entrypoint=cli`，system 里有 `You are a security monitor for autonomous AI coding agents.`，`stop_sequences` 为 `["</block>"]`，没有 tools。

消息只有两条，都是 harness 拼的：

| 序号 | 内容 | 作用 |
| --- | --- | --- |
| `#0` | 把用户的 CLAUDE.md 包进 `user_claude_md` 标签 | 给分类器提供用户意图上下文 |
| `#1` | `<transcript>` 标签、会话到当前时刻的用户消息与工具调用快照、最后一条待裁决动作，再加 Stage 1 指令 | 让分类器在完整上下文里判断这一次动作 |

Stage 1 指令以 `Err on the side of blocking. Stage 1 does NOT apply user intent or ALLOW exceptions` 开头。Stage 2 的输入尾巴是 `Review the classification process and follow it carefully...`。本机样本里没有看到 `<block>yes`，可见判定都是放行；Stage 2 的触发条件需要客户端源码或更多样本才能确定。

回复由推理块和结论块组成。req 26020 的推理说明待裁决动作是一条读取临时图片尺寸的只读命令，没有外发和破坏，随后输出 `<block>no`。这次请求用了 620 个新输入 token、32,000 个缓存输入 token，输出 263 个 token，其中 254 个是推理，耗时 3.98 秒。分类器与主循环使用同一个模型，样本里是 DeepSeek-V4.1-Flash。

## 为什么页面看起来没有信息

折叠行只取第一条非空内容块的前 140 字（`web/body-view.js:223`、`web/body-view.js:365`）。`#1` 的第一块恰好是 `<transcript>\n`，整行只剩这个标签；完整快照和待裁决动作要点开 `#1` 才看得到。回复卡片默认把推理块折叠，只露出 `<block>no`。

采集器目前只把 Title Generator 识别为辅助请求（`src/derive.ts:641`、`web/app.js:556`），分类器请求按普通 chat 派生。样本里的这笔两条消息不延续主链，所以被标成 `branch`，页面显示 `另起一支`（`web/app.js:364`）；它不定义工具，所以请求能力显示 0 工具、0 技能。这些判断在普通分支请求上成立，放到分类器请求上就成了语义错位。

派生规则与字段口径见[架构设计的派生字段](architecture-design.md#派生字段)，Title Generator 的处理见[Title Generator 与主链分离](../.agents/notes/implemented/feature/2026-10-21-title-generator-and-main-chain.md)。

## 出现频率

2026-10-21 23:46 的只读快照：

| 指标 | 数量 |
| --- | --- |
| 请求总数 | 641 |
| Stage 1 分类器 | 120 |
| Stage 2 分类器 | 8 |
| 以 `<block>` 开头的回复 | 121 |
| 标题生成请求 | 3 |
| 同会话请求数 | 130 |
| 同会话分类器请求 | 42 |

分类器约占全部请求的 20%，在样本会话里约占 32%。数字随本机使用增长，引用时要带采集时间。

复现查询：

```sql
SELECT req_id, started_ms, input_preview, reply_preview
FROM request
WHERE input_preview LIKE 'Err on the side of blocking%'
   OR input_preview LIKE 'Review the classification process%'
ORDER BY req_id;
```

库的位置与只读连接方式见[运维手册](operations.md#数据目录)。

## 对 collector 的含义

以下选项尚未定案，其中一套已整理为[Agent Profile 与请求类别注册表](../.agents/notes/proposed/architecture/2026-10-22-agent-request-kind-registry.md)。

- 给这类请求一个新的 `req_kind` 或 `chain_role='aux'`，判定条件可以组合 `stop_sequences=["</block>"]`、system 里的 security monitor 文本、回复匹配 `<block>yes|no</block>`。
- 会话视图默认折叠或隐藏分类器请求，或把它作为被放行工具调用的标记附在主请求上；账本保留原始请求，审计仍然可读。
- 折叠行显示 `自动模式分类 · Stage 1 · 放行` 之类的摘要，并把 `<transcript>` 最后一条工具调用提为待裁决动作。
- 统计会话请求数时把主链请求与分类器请求分开，避免序号被旁路请求撑大。

## 证据边界

- 请求形状、`cc_version`、system 文本、消息内容与用量读数来自本机 trace 库的 req 26020，等级为 `实测`，物证为 `采集@2026-10-21-atc`，采集时间是 2026-10-21 23:14。
- 频率数字来自 2026-10-21 23:46 的只读查询，等级为 `实测`，物证同上，会随本机使用增长。
- 页面折叠、派生分类与链角色的现状来自当前工作树的 `web/` 与 `src/`，行号按本文写作时的 HEAD。
- 把分类器请求识别为 aux 并调整页面呈现的建议，等级为 `推断`。
- 本地另有一份第三方逆向复原 fork 的源码，版本与安装版不同，不能用于判定官方产品行为；本文不引用它作证据。
- 本文没有复制请求正文、CLAUDE.md 内容或会话标识；复现需要本机 trace 库与请求编号。
