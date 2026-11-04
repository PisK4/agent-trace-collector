# Tracery

[![CI](https://github.com/PisK4/tracery/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/PisK4/tracery/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.4-black)](https://bun.sh)
[![Dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![Tests: 1165](https://img.shields.io/badge/tests-1165%20passing-brightgreen)](tests)
[![README: English](https://img.shields.io/badge/README-English-blue)](README.md)

[English](README.md) ｜ **简体中文**

**Tracery 记录 Agent 发出的请求，把散落的调用织成一条可以逐步骤翻看的 trace。**

一个编码 Agent 一次会话要发几十笔 LLM 调用。观测平台告诉你每笔的成本与耗时，不告诉你请求体里到底装了哪几条消息、system prompt 是怎么组装的、第 N 笔比第 N-1 笔多了什么。

Tracery 留下原始请求：把每笔调用记成一笔请求——组装后的协议对象、回复、路由决策与用量，再按会话把这些请求读回成一条可以逐行翻看的时间线。

![Tracery 三栏界面：左栏会话列表，中栏轨迹，右栏读数](docs/images/session-list.png)

它挂在数据面旁边，不是代理：不转发、不改写、不拦截。没运行时，Agent 的请求照常走完，只是这段时间没有新记录。

## 为什么需要它

- **看清发了什么。** 某一轮 Agent 到底给模型发了哪几条消息，system prompt 组装了哪些内容，工具结果怎么回填。
- **定位问题。** 失败、截断与重试发生在哪一笔请求，前一笔和后一笔差在哪几条消息。
- **横向对照。** 不同 harness 的请求放进同一套读数、同一种轨迹结构与同一个会话列表里比较。

## 从上游捕获：两条进路

两条进路可以单独开，也可以同时开，写进同一个 SQLite 库。

### 进路一 · magpie 网关：三路证据，正文完整

[magpie](https://github.com/yetone/magpie) 在请求发送点记录三路证据：hook 拿到客户端协议请求体与合并后的回复，用量账本给出状态、用量、`route_id` 与 `response_id`，路由历史给出候选顺序、尝试与规则。三路按 `response_id` 与 `route_id` 对账成一笔请求。

正文来自 hook。把 [`plugins/collector.hooks.ts`](plugins/collector.hooks.ts) 注册进 magpie 的插件配置，并把首次启动生成的 `hook.token` 交给它。插件只做三件事：请求期生成 `hook_id`、完成期上报完整对象、按固定码记录投递结果；不改正文、不做关联、不做脱敏。

不装 hook 时，页面仍能读到账本与路由两路证据，但没有请求体与回复正文。

### 进路二 · OTLP：harness 自己导出

不装 magpie 也可以。已适配 Claude Code、OMP 与 Codex CLI：把各自的 OTLP exporter 指到本机的 `POST /v1/traces` 与 `POST /v1/logs`，认证用首次启动生成的 `otlp.token`。

令牌文件是 32 字节裸二进制，环境变量里放它的 base64url 形式——直接 `cat` 文件会把非 ASCII 字节塞进 `Authorization`，请求在 HTTP 层就被判畸形：

```sh
ATC_TOKEN=$(base64 -i '<dataDir>/otlp.token' | tr '+/' '-_' | tr -d '\n=')
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:8320
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer $ATC_TOKEN"
```

- **Claude Code**：LLM span 落成请求行；要逐笔正文再加 `OTEL_LOG_RAW_API_BODIES=file`，harness 把完整请求与回复写成文件、事件里带指针，采集器按指针读入并落库，正文完整不截断。
- **OMP**：span 落成请求行，正文一栏是结构化摘要（页面标「OTLP 摘要」）；它的 OTLP 不带逐笔正文通路。
- **Codex CLI**：不读环境变量，在 `~/.codex/config.toml` 配 `[otel.trace_exporter.otlp-http]` 指向本机端点，`protocol` 写 `binary`；turn span 落成请求行，有会话、模型与用量读数，不带逐笔正文。

同一会话同时开 magpie 与 OTLP 时，时间线里每笔调用会出现两行，一行 magpie 一行 OTLP，行上来源可区分；不做自动合并。

## 快速开始

需要 [Bun](https://bun.sh) ≥ 1.4。没有其他运行时依赖：SQLite 用 `bun:sqlite`，压缩用 `node:zlib`。

### 只看界面（合成数据）

不需要 magpie，不需要任何真实数据：

```sh
bun install
bun prototypes/synthetic-server.ts
```

打开 `http://127.0.0.1:8770/?session=conv-synthetic-reading`。合成服务覆盖空状态排查、窗口分页、缺通道与轮次配对等场景；只监听回环，不连真实库、不读令牌。合成数据只服务界面验证，不是真实能力证明，也不参与生产验收。

### 接真实流量

```sh
bun run start        # 采集器，127.0.0.1:8320
```

打开 `http://127.0.0.1:8320`。首次启动在数据目录生成 `read.token`、`hook.token`、`otlp.token` 与 `redaction.salt`，权限 0600，目录 0700。默认数据目录在 macOS 上是 `~/Library/Application Support/tracery`，其他平台是 `${XDG_DATA_HOME:-~/.local/share}/tracery`。支持 macOS 与 Linux；不支持 Windows——采集器依赖的文件权限位在 Windows 上不成立。

可覆盖的项：`ATC_DATA_DIR`、`ATC_PORT`、`ATC_LEDGER_PATH`、`ATC_ROUTING_DIR`、`ATC_MAGPIE_URL`、`ATC_BODY_BUDGET`、`ATC_DISK_LIMIT`。监听地址写死回环，不接受配置成通配地址。

之后按上面的进路选：magpie 装 hook，或把 harness 的 OTLP exporter 指到本机。两条也可以同时开。

## 一条 trace 长什么样

轨迹是中栏主体：一行一个步骤，36px 高，只有序号、参与角色与内容摘要。开头固定是协议层——system prompt（连同 `cc_version`、`anthropic-beta` 这类协议字段）、user prompt、环境注入；随后是 assistant 文本与工具调用。工具调用与结果各自成行，按 `call_id` 与消息位置配对，不按工具分样式。

标题生成、分类器这类旁路请求在轨迹里标成「辅助请求」，不参与主链；标题生成请求算出的正式标题会被主会话借用。子代理与主会话共用 `conv_key`，按 `actor` 各自成组，会话头里能看到子代理个数与笔数。

点任意一行，右栏定位到该步骤对应的协议来源。右栏四个页签：读数（本次回复、请求结构、能力清单、用量与上下文、身份完整性）、正文（原始消息，按 40 条一片翻页）、工具（选中一次调用后有概览、参数、配对、Schema 四页）、路由（候选顺序与尝试链）。

<img src="docs/images/session-trace.png" alt="会话的轨迹列：assistant 行与工具调用、结果行交替出现" width="620">

assistant 文本行尾是推理段耗时，工具调用与结果行尾是执行段耗时。上图中序号 6 的 Bash 调用报 exit code 1，随后的 assistant 行给出修正方案。

<img src="docs/images/tool-pair.png" alt="工具调用与结果的配对页：调用 JSON 与结果正文并排" width="520">

「配对」页把同一个 `call_id` 的调用 JSON 与结果正文同屏并置，并注明结果由哪一笔请求带回、具体落在什么消息位置。

### 推理段与执行段

轨迹行尾有两种耗时，归属不同：

- **执行段**挂在工具调用行上，按每次调用计算：结果请求开始减调用请求结束。它含客户端处理与人工确认，因此是上界，不是工具进程自身的精确耗时。
- **推理段**挂在 assistant 文本行上，属于整笔请求：首个文本减首 token（`reasoning_span_ms`）。同一笔请求有多段文本时，每段都标同一个数。

推理是请求级的，不按工具拆分——界面不会给出「某个工具占了多少推理时间」这种数。承载这次工具调用的请求推理了多久，在同一笔的 assistant 行与右栏读数里看。

### 上下文由什么组成

右栏「读数 → 用量与上下文」把这一笔请求的 prompt 分解按 token 面积铺成上下文矩阵（treemap）：工具定义、技能、系统提示、记忆、对话内容、工具结果等各占一块，面积就是 token 占比，下方列表给出每类的绝对值与百分比。同一张卡还给出已用上下文、窗口总量、固定开销与缓存命中。

<img src="docs/images/context-map.png" alt="上下文矩阵：按 token 面积铺开的请求构成" width="640">

判断「这次上下文是不是塞了不该塞的东西」，从这里看：固定开销占了多少，对话与工具结果又占了多少。

## 多 Agent，同一套视图

左栏会话列表装不同 harness 的会话，用 Agent 标签区分与过滤；同一会话涉及多个 Agent 时，行上显示主 Agent 与 `+N`。已适配 Claude Code、OMP 与 Codex CLI。新增 harness 的成本是一个稳定的 `service.name` 加一行选取规则，规范见 [OTLP exporter 接入 profile](docs/otlp-exporter-profile.md)。

## 记录什么，存在哪

Tracery 存的是真实请求正文。这是它的用途，也值得直接说清：prompt、代码、工具输出与模型回复——凭证按规则脱敏，不是靠不写——都会落到本机的 SQLite 库里。

| | |
| --- | --- |
| 数据目录 | macOS 为 `~/Library/Application Support/tracery`，其他平台为 `${XDG_DATA_HOME:-~/.local/share}/tracery`（可用 `ATC_DATA_DIR` 覆盖） |
| 内容 | `trace.db` 与 WAL、四个令牌与盐文件、日志 |
| 权限 | 目录 0700，文件 0600 |
| 网络 | 只监听 `127.0.0.1`，写死；不接受通配地址 |
| 外发 | 读取 magpie 的本机账本与路由文件，探测 magpie 的本机端口。不上传任何内容 |
| 账号字段 | 不出接口 |
| 回收 | 正文按预算回收：正文 10 GB、总盘 16 GB。正文到 90% 预算时回收最旧的，总盘到 80% 只接元数据，到 95% 停止接收。回收的正文补不回来 |

不扫描这份范围之外的东西：Tracery 不读 Agent 自己的会话文件。OTLP 通道上唯一的文件读取是 `body_ref`——只读事件显式指到的单个文件，不列目录。

测试只用合成数据。真实请求正文、账号、令牌与用户配置不进 fixture、日志或提交。

## 边界与非目标

- **只记录观察到的东西。** 不经过网关也不导 OTLP 的请求看不见。请求统计以已保存的观测范围为限，缺正文单独标明，不能把 hook 覆盖率当作总请求量。
- **不做代理。** 不转发、不改写、不拦截任何 LLM 流量。
- **不做跨 harness 的通用摄入协议。** 唯一的通用入口是 OTLP 的 `/v1/traces` 与 `/v1/logs`；其余通用 trace 协议不做。
- **不做导出、告警、指标看板与多机聚合；不做服务端全文检索。** 页面上的搜索只按会话标题与客户端标签过滤已加载列表。
- **不做评测。** 不打分、不管理提示词版本。

## 与观测平台的分工

「这不就是 Langfuse 吗」是打开这个仓库时最常见的疑问。两者都在看 LLM 流量，但记录的东西不同。

Langfuse 这类平台的记录单位是一次 LLM 调用或一个 span：`input` / `output` 两段文本、耗时、成本、评分，用来回答「我写的应用表现如何」。Tracery 的记录单位是一笔经过网关的请求：完整的脱敏协议对象、逐块可还原的消息、三路证据的对账结论，用来回答「这次会话到底发生了什么」。

能力表上的差异不如两件具体的事重要：

- **逐笔新增消息的比对。** Tracery 保存逐条消息并按语义指纹比共同前缀，能回答「第 N 笔比第 N-1 笔多了哪几条」，并区分「另起一支」与「链断了」。观测平台以一次调用为记录单位，输入输出是发给模型的载荷，不做这一层序列比对。
- **组装后的上下文。** Langfuse 在[自己的集成文档](https://langfuse.com/resources/engineering/coding-agent-tracing)里写明：hook 读不到 `CLAUDE.md`、技能与自动加载内容对实际 system prompt 的贡献，看到的是对话与工具调用，而不是组装后的上下文。网关在发送点，看到的就是实际发出的请求体。

这两件事以外，平台明显更强：评测与数据集、提示词版本管理、多人协作与权限、聚合仪表盘与告警、跨机器共享。这些 Tracery 都不做，也不打算做。

分工可以直说：**趋势与共享交给平台，逐笔原文与对账留在本机。** 两边可以同时开：同一批请求，平台侧看成本趋势与团队对比，本机侧读这次会话到底发生了什么。

## 命令

```sh
bun install
bun run start            # 采集器，127.0.0.1:8320
bun test
bun run typecheck
bun run maintain <子命令> # 离线维护，要求采集器已停
bun run service <子命令>  # 起停与状态，走 launchd（仅 macOS）
bun run verify:notes      # 变更 note 闸门，维护者用
```

`service` 与 `maintain` 必须带子命令，裸调用只打印 usage 并退出 2。

生产实例由 launchd 以 `KeepAlive` 托管，`bun run service` 管理这套部署，仅限 macOS。其他平台用 `bun run start` 挂到你自己的进程管理器下。

## 文档

- [ATC trace 格式](docs/trace-format.md)：主实体、正文切块、派生结论与置信度
- [架构设计](docs/architecture-design.md)：证据身份、存储模型、派生、容量与安全边界
- [运维手册](docs/operations.md)：维护命令、备份恢复、容量门槛、派生切片
- [OTLP exporter 接入 profile](docs/otlp-exporter-profile.md)：harness 作者的对接规范与登记方式
- [验收记录](docs/acceptance.md)：各轮合成与真实流量的验收结果
- [项目定位](docs/project-overview.md)：记录单位与阅读入口的取舍
- [领域术语表](GLOSSARY.md)：术语定义与边界
- [文档索引](docs/README.md)
- [Demo 与合成场景](prototypes/README.md)
- [Agent Note 规则与决策记录](.agents/notes/README.md)

## 参与

欢迎提 issue 与 pull request，动笔前先读 [CONTRIBUTING.md](CONTRIBUTING.md)。两条约定不太常见，先说在前面：

- **Agent Note。** 非平凡改动要附一篇 [`.agents/notes/`](.agents/notes/README.md) 下的 note，记下决策、否决了什么、代价是什么；`bun run verify:notes` 在合并前检查这一条。纯机械或局部编辑豁免。
- **先读工作约定。** [AGENTS.md](AGENTS.md) 写明模块边界与测试守住的常备约定。

提交 pull request 前跑 `bun run typecheck` 与 `bun test`；CI 也跑这两项。

安全问题走 [SECURITY.md](SECURITY.md)，不要开公开 issue。变更记在 [CHANGELOG](CHANGELOG.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。Agent 图标资产取自 magpie，见 [NOTICE](NOTICE)。
