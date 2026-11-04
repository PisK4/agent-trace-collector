# Agent Note: 覆盖护栏：压缩转录、双档调度、原始层容量、多根与来源目录

Status: proposed

开源项目要先让更多 Agent 能接进来，覆盖广度是入口。接得越多，现有写路径的四个容量问题越先暴露：Codex 的归档压缩转录看不见、同名 plain/zst twin 会重复、单家轮转把活跃会话拖到 N 分钟、`raw_session_event` 没有容量闸门。OMP/Pi 的 profile、XDG 与自定义 sessionDir 也只有一个根。本文先落这四件护栏，再加一份 19 家 Agent 的目录骨架。它们不新增适配器，也不改变 request/evidence 的语义。

## Problem

### 压缩转录完全不可见

`src/sources/session/read.ts` 的 `discoverJsonl` 只认 `.jsonl`。Codex 归档的 `.jsonl.zst` 因此不会被发现；本机只读扫描看到约 390 个这类文件，约 200 MB。只补扩展名不够：压缩文件不能按字节偏移续读，需要按整份内容识别代际。

### 同名 plain/zst twin 会重复

Codex 会把旧 rollout 压缩成同名 `.jsonl.zst`。只加扩展名会把 293 个同名 twin（约 102.5 MB）读两遍；只按文件名去重会丢掉内容分叉的副本。

### 单家轮转随 Agent 数量线性变慢

`src/main.ts` 的 `sessionsTick` 每 60 秒只轮一家。五家时每 5 分钟轮到一次；十九家时每 19 分钟。活跃会话的页面延迟会随覆盖广度一起变差。历史回填与实时会话还共用同一个 2 MiB 预算，容易互相挤占。

### 多根会话看不见

OMP 的 profile 会话在 `<configRoot>/profiles/<name>/agent/sessions`，XDG 数据根下另有 `profiles/<name>/sessions`；Pi 的 `sessionDir` 可以写在 `settings.json` 或 `PI_CODING_AGENT_SESSION_DIR`。当前适配器只返回一个根，profile 与自定义目录里的会话永远进不来。

### 原始层没有容量闸门

`src/retention.ts` 的 `pruneRaw` 只处理 ledger、route、hook 与 OTLP；`raw_session_event` 不在容量统计与清理里。每多接一家 JSONL 来源，原始层就多一份随会话增长的载荷。Zcode 已经用 `storesRaw:false` 证明物化来源可以省掉这份重复，但追加文件仍然需要原始层重放。

### 覆盖状态没有单一目录

Magpie 的 `internal/sessions/sessions.go` 列了 19 个本地 Agent。仓库里没有一张表说明哪些已有适配器、哪些本机有数据、哪些只是格式已知。新增 adapter 时容易出现「代码里有、文档里没有」或「目录里有、实际没数据」的漂移。

## Proposal

### 1. 封口 `.jsonl.zst` 按整份指纹读取

- `discoverJsonl` 增加 `extensions` 选项；Codex 适配器同时发现 `.jsonl` 与 `.jsonl.zst`。
- 新增 `sealedJsonlRead`：压缩后字节的 SHA-256 作为 `generation` 与 `fingerprint`。同指纹返回 `unchanged`，不重复解压；指纹变化则整份解压并按解压后字节偏移切行。
- 解压失败记 `codex_zstd_invalid`，超过 256 MiB 记 `codex_zstd_limit`；游标不推进，下一轮同指纹重试。
- 压缩文件按单个 zstd frame 处理。多 frame 归档需要逐帧解压，当前不猜。
- 同名 plain 与 `.jsonl.zst` 先比较解压内容：相等或 zst 是 plain 前缀时只读 plain；plain 是 zst 前缀时只读 zst；内容分叉时两份都保留，交给共用写路径去重。比较结果按大小与 mtime 缓存。
- 没有同名 twin 时，发现阶段用压缩后大小判断是否值得再读；发现后的 `select` 只对同名 twin 读两份比较内容。同大小原地替换不会被发现；归档文件假定写入后不再改。

### 2. 调度拆成 live 与 backfill 两档

- 把 `ingestSessionBatch` 拆成 `discoverSessionFiles` 与 `ingestSessionFiles`；原入口保留为两者的组合，现有调用方不变。
- 新增 `runSessionScheduler`。每轮先对全部适配器做一次只读发现：
  - live：mtime 在 10 分钟内的文件，最多取 4 家，每家 2 个文件 / 256 KiB；
  - backfill：从轮转游标开始选一家仍有剩余的来源，重新发现后按该适配器自己的预算摄入；空来源跳过。
- droid 继续使用独立定时器与 8 MiB 预算，不进入这张调度表。
- live 上限 4 家意味着第 5 家活跃来源要等下一轮；backfill 仍会覆盖它的历史积压。这个取舍先接受，等有真实延迟数据再调。

### 3. OMP/Pi 收集多根

- OMP 收集：`PI_CONFIG_DIR` 或默认 `~/.omp` 下的 `agent/sessions` 与 `profiles/*/agent/sessions`；`PI_CODING_AGENT_DIR/sessions`；`PI_CODING_AGENT_SESSION_DIR`；`OMP_HOME/agent/sessions`；`XDG_DATA_HOME/omp/sessions` 与 `XDG_DATA_HOME/omp/profiles/*/sessions`。
- Pi 收集：`PI_CODING_AGENT_DIR` 或默认 `~/.pi/agent` 下的 `sessions`；`PI_CODING_AGENT_SESSION_DIR`；全局 `settings.json` 的 `sessionDir`；`PI_HOME/agent/sessions`。
- 共享 `discoverSessionFiles` 按 `source_name` 去重（文件是绝对路径，Zcode 是 `<db>#<session>`），重叠根只摄入一次。
- 只读全局 settings；项目级 `.pi/settings.json` 没有可枚举的 cwd，不扫。

### 4. 原始层进入容量统计，TTL 只清不可达代际

- `metadataSnapshot` 增加 `raw_session_rows` 与 `raw_session_bytes`；全量 `/api/metrics` 能看到增长，轻量快照不增加全表求和。
- `pruneRaw` 增加 `session` 计数，只删两类代际：
  - 没有任何 `source_cursor` 引用的孤儿代际；
  - `fingerprint IS NOT NULL` 且 `last_ok_ms` 超过 `RAW_TTL_MS` 的封口代际。
- 追加文件当前代际的原始行保留。重放要从本代际第一行开始，按年龄删会让后续批次的请求窗口缺历史；要做追加代际的 TTL，先得设计游标重置与全量重读路径。
- 会话原始层删除不联动 `request_evidence`：证据的正文在 `body` 层，原始层只服务重放。

### 5. 目录骨架与覆盖状态

- 新增 `src/sources/catalog.ts`，列出 Magpie 的 19 个本地 Agent，状态只有 `implemented`、`local_data`、`unimplemented` 三种。
- 未实现来源的 `sourceKind` 保持 null，不先猜库内身份；根路径也等真实核对后再填。
- 新增测试：目录恰好 19 家且无重复；注册表里的每个适配器都有 `implemented` 条目，`sourceKind` 与适配器一致。
- 这张表不宣称真实覆盖。`implemented` 只表示有适配器；真实状态要等 `source-health` 按根、evidence 与 cursor 另算。

## Alternatives considered

**先停两周不新增 Agent，补完现有五家再扩。** 这会把开源项目的覆盖广度挡在门外。护栏本身不需要两周，应该与适配器并行；本文只做不依赖新解析的底座。

**同名 twin 一律保留 plain。** 同名只能证明来源相同，不能证明内容相同。Magpie 也只在解压内容相等或互为前缀时判冗余；内容分叉时两份都读，避免丢段。

**所有新 JSONL 适配器默认 `storesRaw:false`。** 物化 DB 来源可以，追加文件不行。`ingestSessionFile` 靠本代际原始层重建解析状态；关掉后下一批没有历史消息窗口，请求体会从中间开始。

**按年龄直接清追加代际的原始行。** 文件闲置七天后再次追加时，游标仍从旧末尾继续，但重放已经找不到前面的行。要这么做必须先有「清原始层时重置游标、下次从头重读」的路径，本文不混进这个改动。

**照搬 Wake 的 SQLite/FTS 索引。** ATC 已有 trace 库与读取架构；第二套索引会多一份一致性负担。目录、发现与调度可以借，索引不借。

## Risks

- Codex 归档转录第一次可见。首轮真实摄入会增加 request/evidence 行；twin 比较要解压同名 zst，首轮多读约 100 MB。两条都需要 before/after 计数与 issue 检查。
- 每轮对全部适配器做发现，Zcode 这类要开库的来源会比以前更频繁被探测；需要看事件循环 p99 与 single-tick 时长。
- `raw_session_event` 的增长可见，但追加代际仍会随会话增长；真正的 TTL 还缺游标重置设计。
- 多根会把同一会话的多个副本一起发现；当前按 `source_name` 去重。Codex 的 plain/zst twin 已在适配器内比较内容，其它 Agent 的副本仍可能重复。
- 目录只是骨架，`source-health` 与真实覆盖状态还没落地。
- 没有 schema 变更，没有数据回填；旧游标与旧原始行保持原样。

## Acceptance criteria

- `tests/session-codex.test.ts`：`.jsonl.zst` 首次摄入、同指纹不再解压、损坏压缩记固定 issue 且不建调用；同名 twin 内容相等只读 plain，zst 覆盖更长前缀时读 zst。
- `tests/session-roots.test.ts`：OMP/Pi 的默认、profiles、XDG、自定义目录与 `settings.sessionDir` 都进根列表；重叠根只发现一次文件。
- `tests/session-scheduler.test.ts`：同一轮 live 与 backfill 各摄入一家；第二轮按轮转跳过已读完来源。
- `tests/retention.test.ts`：孤儿代际与过期封口代际被清，追加代际保留；第二次清理不写库。
- `tests/catalog.test.ts`：19 家目录无重复；注册表适配器都有 `implemented` 条目。
- `tests/session-claude.test.ts`、`session-codex.test.ts`、`session-omp.test.ts`、`session-zcode.test.ts`、`main.test.ts` 等窄测试与 `bun run typecheck` 通过。
- 未运行全量套件；未做真实流量验收。`source-health` 与项目级 Pi `sessionDir` 不在本次改动内。

## Deferred

- `source-health` 与真实覆盖状态，等目录与契约稳定后再接。
- 追加代际的原始层 TTL，需要先设计「清原始层时重置游标、下次全量重读」。
- Pi 的项目级 `.pi/settings.json` 里如果单独写了 `sessionDir`，没有可枚举的 cwd，当前不扫。
- 新 Agent 适配器（DSH、Qoder、Grok、WorkBuddy 等）单独分批，不在本文混入。

## Related

- [本地 Agent 会话适配器第一版](2026-11-04-agent-session-adapters.md) 定义适配器范围与目录检测的目标。
- [多来源同一调用的身份归一与去重](2026-11-04-multi-source-call-identity.md) 约束新来源必须交出的身份字段。
- [数据源契约漂移检测](2026-11-04-source-contract-drift.md) 是目录与 source-health 的下一步。
- [droid 会话摄入并入共用写路径](../../implemented/architecture/2026-11-04-droid-shared-session-ingest.md) 保留 droid 独立调度的原因。
