# Agent Note: 路由当日文件按游标增量读取

Status: implemented

## Problem

当日 `2026-…jsonl` 是持续追加的活文件，路由入口却按整份字节的 SHA-256 判“未变”：每次追加都让指纹变号，于是一有新字节就整份重新解析、脱敏、upsert `raw_route`、重压 `route_summary`、对已匹配请求重跑投影。

本机实测（当日文件 5.47 MB / 1,070 行，启动后 12.5 分钟）：378 次轮询里 `decoded` 37 次；route 任务累计 19.2 s、单次最大 481 ms；所有任务的最大耗时聚在 440–480 ms，说明同一次同步整份重放阻塞了单线程事件循环。读文件、算哈希与切行共约 15 ms，其余开销落在落库。

当日文件按归档日的规模会涨到 30–37 MB / 5–7 千行（10-21／22／23 三个归档文件解压后的字节与行数）。整份重放的成本随文件线性增长，并按追加次数反复累积；单次解码一旦超过 2 s 轮询间隔，事件循环停顿会让 hook 的 1500 ms 投递预算失效，正文按 best-effort 丢失。

## Decision

`.jsonl` 与 `.gz` 由同一个 `readRouteFiles(dir, cursors)` 用两种游标读取：

- `.jsonl` 走账本同一个行读取器 `readBatch`：文件身份（dev + inode + birthtime）、`committed_off`、冻结的头部基线；每批最多 128 行或 8 MiB，只消费换行结束的完整行，末行没有换行就留到下一轮。身份、epoch、头部基线与截断的判定规则与账本一致，替换或截断则从偏移 0 重读，`route_id` upsert 保证重读幂等。
- `.gz` 保持整份字节的 SHA-256 作 `fingerprint`：摘要没变就跳过，变了整份解压重读。

只有 `decoded` 且 ingest 成功才写游标：`.jsonl` 写身份、偏移、`seen_size`、头部基线与 epoch，`.gz` 写 `fingerprint` 与解压后长度；`unchanged` 与 `error` 不写。

坏行引用键带上本批起始位置（`.jsonl` 用 `身份:startOff`，`.gz` 用指纹），增量批次之间不会互相覆盖。单行超过 64 MiB 的完整行记 `route_line_too_large`，位置照记、游标照推进。

### 与 `.gz` 的关系

`.gz` 的整体重写没有可用的偏移，仍按指纹全量重读，靠 `route_id` upsert 去重。同一天 `.jsonl` 与 `.gz` 都在时两个文件都读，重复 `route_id` 收敛成一份。

## Alternatives considered

**只把轮询降频，保留整份指纹。** 降频把同样的整份重放摊薄，单次成本仍随文件线性增长；当日文件到 30 MB 后，10 s 一次仍是秒级停顿，追赶延迟还更大。

**用 mtime + size 判断“未变”。** 便宜，但替换检测会漏（同秒重写、`.jsonl` 压成 `.gz`），而路由入口最需要看见的正是这些替换；账本入口此前已因同样理由拒绝 mtime 判据。

**把整份解码结果缓存起来，按指纹失效。** 失效判据还是指纹，等于每轮仍要算一遍整份哈希，缓存换不来增量。

**让上游把当日文件切得更碎。** 那要改 magpie 的 history 轮转，超出本仓库边界，也不消掉“整份重放”本身。

## Consequences

- 单轮工作量上界固定为 128 行 / 8 MiB，事件循环不再被整份重放占满；追加只在下一轮消费新增行。
- 一次追加超过 128 行时分多轮追赶，落后期间新请求的路由读数（会话归属、模型、状态）会晚几十秒到位。
- 存量的 `route_file` 游标里 `file_generation` 存的是旧指纹，与新代码的文件身份格式不符；升级后该文件按新代际从偏移 0 完整重读一次，随后转入增量。重读只 upsert 路由证据，不生成请求行。
- `.gz` 的成本特征不变：整份读、整份算哈希、整份解压。
- 坏行引用键多一段批次基址，只影响 `ingest_issue` 的键，不影响计数规则与三态记账。

## Testing

`bun test tests/files.test.ts` 覆盖追加只读新增完整行、半行不提交、原地重写与截断换代重读、空文件不写游标，以及未变 `.gz` 不解压与损坏 `.gz` 保留指纹。`bun test tests/reconcile.test.ts` 覆盖 `.jsonl` 游标按读取器偏移落库、坏行与超长行记账、`.gz` 以指纹作游标。`bun run typecheck` 覆盖 `RouteCursor` 与 `routeTick` 接线。

## Related

[路由文件先按字节哈希，未变就不解压](2026-10-22-atc-route-hash-before-decode.md) 持有 `.gz` 的哈希先行与三态记账；本 note 取代其中“当日 `.jsonl` 追加后整份重解”的部分。