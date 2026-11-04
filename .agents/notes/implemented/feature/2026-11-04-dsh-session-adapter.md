# Agent Note: DSH 本地会话适配器：追加式 zstd frame 与分叉 seed

Status: implemented

DSH（DeepSeek Harness）把会话写在 `$DSH_HOME/sessions/<project>/<session>/`，同一目录只保留版本最高的一份 `session[.vN].jsonl[.zstd]`。`.zstd` 不是一次性封口的归档，而是持续追加的 zstd frame 序列；分叉会话会把父会话的事件副本放在文件开头，子代理各自写自己的目录。接入前，Codex 的封口读取器按单 frame 与解压后偏移提交，直接套用会把追加误判成整份替换，也会把分叉的父会话调用重复计一遍。

## Problem

### 追加式压缩流没有续读位置

DSH 每写完一批事件就追加一个完整 frame，文件长度单调增长。压缩后字节无法对应到解压后行，`committed_off` 不能记解压偏移；若按整份指纹识别，又会在每次追加时重读全部历史。读取器需要同时回答两件事：这一代文件从哪继续，以及这一轮提交到哪个 frame 边界。

### 分叉会话复制父会话消息

`isSeeded` 的会话在开头带父会话的事件副本，用来延续上下文。这些 `assistant/message` 已有父会话的证据，若照常建行就是同一笔调用计两次。格式 2 起用 `session/end-seed`（`inherited: true`）标记副本结束；格式 1 没有结束事件，只能按头部的 `seedLength` 跳过前 N 个带 seq 的 assistant 事件。

### 子代理与根会话

`delegationDepth > 0` 的会话是子代理，`parentSession` 指向直接父会话。适配器要把子代理折叠到父会话的 `session` 上，同时保留 `subagent` 与 `parent_agent`，与其它本地 Agent 的行形状一致。

### 共用游标契约只认行偏移

`ingestSessionFile` 逐行用 `line.end` 推进游标，坏行退回 `line.offset`。这对文本 JSONL 成立，对 frame 容器不成立：一行的偏移只是原始层身份，不是可寻址的压缩位置。

## Decision

### 1. 发现：一个会话目录只取一份

- 根是 `$DSH_HOME/sessions`，未设置时取 `~/.dsh/sessions`。
- 文件名匹配 `^session(?:\.v(\d+))?\.jsonl(\.zstd)?$`；同目录取版本号最高的一份，同版本取 mtime 更新的一份。
- 发现只做目录遍历与 stat；`remaining` 用游标 `seenSize` 与当前大小判断，大小不变时取 `observed_off - committed_off`。

### 2. 读取：按 frame 边界提交

- `.zstd` 是追加式 frame 序列，逐个 frame 校验长度后再解压。只有累计文本以换行结尾的 frame 才能提交；文件末尾写了一半的 frame 留到下一轮。
- `committed_off` 是最后一个完整 frame 之后的压缩偏移，`observed_off` 是压缩文件长度；发现阶段用两者之差判断还有没有剩余。
- 每次读取最多 256 个 frame 或 2 MiB 解压文本，写入仍在同一个事务里完成。
- 行的 `offset` 是合成身份：`本轮起点 * 1_000_000 + 行号`，只用于原始层主键与批次内排序；`restartOff` 记该行所属 frame 的起点，坏行重读回到 frame 起点。
- 适配器声明 `lineCommit: false`：游标由读取层的整批 `committedOff` 决定，摄入引擎不再用合成行偏移推进游标。

### 3. 归约：assistant 消息是调用单位

- 首行 `type: 'session'` 是头，取 `id`、`cwd`、`version`、`isSeeded`、`seedLength`、`parentSession` 与 `delegationDepth`。
- `user/message` 进消息窗口；`assistant/message` 建一笔调用，`data.content` 是回复，`data.message.source.model` 是模型，`data.usage` 的 `inputTokens`/`outputTokens` 已是 magpie 口径，缓存读写另计。
- 调用身份优先用事件的 `seq`（`seq:<n>`）；没有 seq 时用行偏移（`off:<offset>`）。证据 `ref_key` 是 `<session>/<callId>`。
- 正文协议是 `chat`：请求侧是此前的 user/assistant 消息数组，回复侧包成 `choices[0].message`。
- 分叉：`version >= 2 && isSeeded` 时，`session/end-seed`（`inherited: true`）之前的 assistant 只进窗口不建调用；`version < 2` 用 `seq < seedLength` 判断。副本结束后自己的调用照常建行。
- 子代理：`delegationDepth > 0` 时 `session` 取 `parentSession`，`subagent` 取自己的 id，`parent_agent` 取直接父会话；父链再往上不追，发现阶段不为确定根会话去读每个文件的头。
- 未知事件类型只落原始层，不判坏。会话头缺失 id、assistant 缺会话或时间、payload 不是对象时记 `dsh_session_missing` / `dsh_time_missing` / `dsh_payload_invalid`，游标停在 frame 起点。

### 4. 共用摄入补两个容器钩子

- `SessionAdapter.lineCommit` 默认 `true`；为 `false` 时行偏移不再当游标，摄入用读取层的 `committedOff`。
- `SourceLine.restartOff` 只在容器读取里出现，坏行重读退回它；省略时仍用 `line.offset`。
- 本轮预算改为按“实际推进量”记：`finalCommitted - startOff`。坏行重读没有推进时不再耗预算空转，这条同时修掉追加文件坏行在同轮反复重读的问题。

### 5. 无 schema 变更

`dsh_session` 加进 `SourceKind` 与会话适配器注册表；`src/sources/catalog.ts` 的 DSH 条目从 `local_data` 改为 `implemented`。DSH 与其它本地适配器共用 `raw_session_event`、`request`、`request_evidence` 与 `body`，没有新表或新列。

## Alternatives considered

**按整份指纹读取，每次追加都全量重读。** 实现最省，但 DSH 会话可持续追加数 MB；每轮都解压全部历史，CPU 与写事务时长都会随会话增长，正是 Codex 封口路径已经付过的代价。

**用解压后偏移做游标。** 下一次读取无法在压缩文件里定位到解压偏移，只能从头解压到该位置再继续，等于每轮重解。合成身份把“行是谁”和“从哪继续”分开，两个问题各自有准确答案。

**用真实压缩 frame 起点做每一行的 offset。** 一个 frame 通常含多行，`raw_session_event` 的主键 `(file_generation, byte_offset)` 会把同 frame 的后续行全部忽略。合成偏移保持每行唯一，`restartOff` 单独承载重读边界。

**把分叉的 assistant 事件也建成调用，交给跨来源去重。** 父会话与子会话的文件代际不同，证据 `ref_key` 也不同，去重层没有足够线索判断是同一笔；只有父会话不在库内时才会误判成子会话自己的调用。

**为子代理追到根会话。** 需要在发现阶段读所有文件头，发现成本随文件和代理数增长；折叠到直接父会话已能满足页面的会话归属，深链以后再补。

**把整份 `.jsonl` 与 `.zstd` 都读一遍。** 同一代会话可能同时留两种形态；按版本与 mtime 只取一份，避免同一事件进两遍原始层。

## Testing

新增 `tests/session-dsh.test.ts`，全部使用合成目录与合成事件：

- 会话目录有 v3 与 v4 两份时只取 v4；低版本即使 mtime 更新也被版本号淘汰；游标存在时剩余按大小差计算。
- 截断在第二个 frame 中间时只提交第一个 frame；补齐后从上一 frame 边界继续，不重复第一段。
- 父会话 + 分叉子会话首轮只建父会话调用；追加 `session/end-seed` 与子会话自己的 assistant 后，下一轮建一笔子会话调用，`session` 归父、`subagent` 归己、证据是 `<parent>/seq:4`。
- 格式 1 的 `seedLength: 2` 只把前两条 assistant 放进窗口，自己那笔调用的 `msg_count` 为 3、用量取自己的 7/3。

`bun test` 1257 pass / 0 fail（109 个文件），`bun run typecheck` 退出 0。真实流量与生产回填读数见[验收记录](../../../../docs/acceptance.md#dsh-会话适配器合成--生产真实流量2026-11-04)，本 note 不复制读数。

## Consequences

- 收益：DSH 会话进入统一的 `request`/`request_evidence`/`body`；追加只读新 frame；分叉不再重复计父会话调用；子代理行有正确的会话归属。
- 代价：每次读取从 `committed_off` 开始逐帧解压，单帧仍整份进内存；一个坏行会让整个 frame 重读，极端情况下同一 frame 每轮都会重复记 issue。
- 长尾：`READ_FRAMES=256` 与 2 MiB 是估算上限；本机实测最大 frame 约 305 KB、最大文件约 1.6 MB，当前阈值不构成容量问题。
- 未覆盖：DSH 的其它事件类型（工具调用、压缩标记等）只落原始层，不进入消息窗口；格式 1 且事件缺少 `seq` 时无法判断 seed 边界，这类文件只能按非 seed 处理。真实数据验收见验收记录。

## Deferred

- 子代理父链追到根会话。
- 工具调用与工具结果进入正文窗口。
- 格式 1 缺 seq 的 seed 边界识别。

## Related

- [覆盖护栏](2026-11-04-coverage-foundation.md) 记录压缩转录分块、双档调度与来源目录骨架。
- [本地 Agent 会话适配器第一版](../../proposed/feature/2026-11-04-agent-session-adapters.md) 定义适配器契约与首批 Agent。
- [多来源同一调用的身份归一与去重](../../proposed/feature/2026-11-04-multi-source-call-identity.md) 约束新来源必须交出的身份字段。
