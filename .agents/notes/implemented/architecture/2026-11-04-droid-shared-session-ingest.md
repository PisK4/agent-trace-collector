# Agent Note: droid 会话摄入并入共用写路径

Status: implemented

## Problem

droid 是第一个本地会话来源，它的 `src/sources/droid/ingest.ts` 自己实现了发现取件、原始层重放、owner 认领、证据写入、正文落库与游标更新。随后接入的 Claude Code、Codex、Zcode、OMP 与 Pi 把这套逻辑抽到 `src/sources/session/ingest.ts`，droid 却留在原路径上。

两条写路径并存时，同一类修复要改两遍。跨来源模型名去重、`tool_call` 同序冲突与 Zcode 原始层重复存储这三次修复都只落在共用路径；droid 靠旧逻辑碰巧没有暴露出同类问题，不代表以后不会。会话适配器提案把「droid 并入」列为阶段 6，验收要求是迁移前后行数、正文可读率与 issue 数不变。

## Decision

### droid 变成一个适配器

新增 `src/sources/session/adapters/droid.ts`，实现现有 `SessionAdapter` 契约：

- `discover` 复用 `src/sources/droid/discover.ts`，按游标算剩余字节；`read` 复用 `readBatch`。
- `parse` 与 `apply` 包装现有 `parseDroidLine` / `applyDroidLine`，不重写解析。
- 每条 assistant 消息映射成一个 `SessionCall`；fork 复制段仍只进窗口，子代理仍保留自己的会话 id 与 `parent_agent`。
- `bodyProtocol='droid-session'`、`evidenceKind='session_call'`、`sortSource='droid_session'`、`attemptState='not_applicable'` 都按原值保留。

`src/sources/droid/ingest.ts` 缩成批次入口：调用 `ingestSessionBatch`，批次结束后刷新已记录主会话的 settings，再把结果映射回 `DroidIngestResult`。原始层、证据、正文、认领与游标不再有第二份实现。

### 契约只加来源确实需要的可选位

共用契约新增五个可选/扩展点，均有明确用途，默认值让其余五家行为不变：

| 扩展 | 用途 |
| --- | --- |
| `SessionKind` 加 `droid_transcript` | 让 droid 使用同一个 `sourceKind` 联合 |
| `bodyProtocol` 加 `droid-session` | 保留历史正文协议，读取端按 Anthropic 形状解释 |
| `SessionCall.reasoningEffort` | droid 的思考档位只进 `source_facts`，不写 `reasoning` token 列 |
| `SessionAdapter.attemptState` | droid 原值为 `not_applicable`，默认 `known` |
| `batch.order: 'remaining'` | droid 保持按剩余字节优先；其余家仍按 mtime 新到旧 |
| `afterFile(db, state, file, now)` | droid 的 `.settings.json` 刷新仍在同一写事务内，失败不推进游标 |
| `unreadableReason` | 保留 `droid_file_unreadable`，不把读取失败折成通用原因 |

`afterFile` 是共用摄入里唯一的来源私有钩子。它只接收当前文件归约后的状态，返回变更数（计入 `sideEffects`）；共用层不知道 settings 表，也不为 droid 写分支。

### 调度不变

droid 继续用独立的 60 秒 `droid` 定时器与 8 MiB 预算，不进入 `SESSION_ADAPTERS` 的五家轮转。写路径统一与调度统一是两件事：把 droid 放进轮转会让它从每分钟一轮降到每 6 分钟一轮，或者在两个定时器下被重复摄入。注册表注释写明这一例外。

## Alternatives considered

**保留 droid 的独立摄入，只把公共函数 import 进来。** 这正是迁移前的状态：解析是共用的，写入不是。owner 查找、证据、正文与游标的每次修复仍要在两份代码里各改一次，且两边的结果形状会继续分叉。

**让 `ingestDroidBatch` 直接调用共用摄入的内部函数，而不实现适配器。** 能省一个适配器文件，但共用摄入会重新长出一组 droid 专用参数与分支；适配器契约本来就是为这种差异准备的，包一层比在引擎里开口子更小。

**把 droid 加进 `SESSION_ADAPTERS` 轮转。** 五个适配器每 60 秒轮一家，droid 会变成每 6 分钟才被读取一次；本地转录是追加文件，延迟直接体现在页面。若同时保留 droid 定时器，则会双份摄入。保持独立定时器，等调度层有统一的优先级与预算模型再合并。

**settings 刷新改成批次后扫描目录。** 需要从文件名反推会话 id，或重新解析 `session_start`，还要自己判断主/子代理；`afterFile` 拿到的正是已经归约好的状态，且与转录写入在同一事务里，不会出现「请求行已提交、用量行没写」的半状态。

## Consequences

- droid 的原始层、证据、正文、认领与游标现在只有一份实现；后续修去重、正文预算或游标问题不会再漏掉 droid。
- droid 的行为参数全部由适配器字段表达，共用引擎没有 droid 分支；新增来源仍只需实现契约。
- `SessionAdapter` 多了一个 `afterFile` 钩子和几个可选字段。它们不是通用能力，只有来源确有旁路数据时才使用；没有旁路数据的适配器不实现。
- droid 的调度仍是特例：独立定时器、8 MiB 预算、按剩余字节取件。这是有意保留的现状，不是共用缝的遗漏。
- 没有 schema 变更，没有数据回填；已有 `request`、`request_evidence`、`raw_session_event` 与 `source_cursor` 行保持原样，下一次摄入从原游标继续。

## Testing

- `tests/droid-parse.test.ts`、`droid-ingest.test.ts`、`droid-dedupe.test.ts`、`droid-acceptance.test.ts` 全部通过：逐 assistant 建行、fork 复制段零建行、子代理归属、settings 覆盖写、坏行停游标、原始层脱敏、跨来源认领。
- 新增取件次序用例：`order='remaining'` 时先读剩余字节大的文件，不受 mtime 影响；`droid-ingest` 的建行断言补上 `attempt_state='not_applicable'`。
- `session-*.test.ts`、`owner-fingerprint.test.ts`、`main.test.ts` 与 `session-dedupe.test.ts` 通过，确认共用契约扩展没有改变其余五家行为。
- `bun run typecheck` 通过。

## Related

- [Droid 会话文件摄入与跨来源去重](../feature/2026-11-04-droid-session-ingestion.md) 记录解析、身份与 settings 口径；本文只改写入路径。
- [本地 Agent 会话适配器第一版](../../proposed/feature/2026-11-04-agent-session-adapters.md) 的阶段 6 由本文落地；目录检测与 health 仍在那边。
