# Agent Note: 路由文件先按字节哈希，未变就不解压

Status: implemented

## Problem

路由入口每轮把当日文件整份读进来、gunzip、按行切分，再把每一行 `JSON.parse` 一遍，即使这一轮文件一个字节都没变。在 1 秒轮询下，当日 `.jsonl.gz` 越大，这份重复工作就越贵，而它换来的信息量是零：文件没变，证据集合也不会变。

同时"未变"这件事在指标里根本不存在：`route.unchanged` 恒为 0，`decoded` 把"解压成功"和"这一轮有新内容"混成一个数，看报告的人无法判断路由入口是在做新工作还是在空转。

## Decision

`.gz` 路由文件先读一次字节、算 SHA-256，再决定要不要解压。游标里的 `fingerprint` 命中就返回 `state: 'unchanged'`，不解压、不切行、`lines` 为空；`RouteFile.state` 因此有三态：`decoded`、`unchanged`、`error`。

替换检测以同一次读取的字节哈希为准，不看 mtime、不看大小。指纹命中已提交值时调用方不推进 cursor，`unchanged` 与 `error` 都不进 `ingestRoute`。这条替换检测只覆盖 `.gz`；当日 `.jsonl` 的追加读取改为按游标增量消费，见 [路由当日文件按游标增量读取](2026-10-24-atc-route-jsonl-tail-cursor.md)。

读取失败与解压失败分成两个码：文件消失、非普通文件、读取失败记 `route_file_unreadable`；读取成功但 gunzip 失败记 `route_gzip_invalid`（输出超过 512 MiB 记 `route_gzip_limit`）。三种 `error` 都保留已经算出的指纹，都只写 stderr 与指标、不推进 cursor，下一轮同指纹重试。`routeTick` 每轮只查一次 `source_cursor` 里的路由游标，做成 `Map` 交给 `readRouteFiles`，不再每个文件查一次库。

## Alternatives considered

**每轮照解压，只把结果缓存起来。** 缓存要自己管失效，而失效判据还是指纹；等于把同一件事做两遍。

**拿 mtime 加大小当"未变"判据。** 便宜，但 mtime 粒度与"同秒内重写"会让替换漏检，而路由文件的替换（jsonl 压成 gz、跨午夜换文件）恰恰是本入口最需要看见的变更。SHA-256 对整份字节计算，两种替换都必然变号。

**把损坏 gzip 记成 `route_file_unreadable`。** 读取是成功的，失败发生在解压；合成一个码之后，"文件读不到"与"文件读得到但内容不是 gzip"这两种运维动作就分不开了。

**损坏 gzip 只报一次，之后按已提交处理。** 那等于把坏文件永久静默；错误必须每轮可观测，直到文件被修好。

**游标命中时也返回上一轮的行。** 调用方会拿旧行重新 ingest 一遍，重复计数与幂等开销都回到入口上；未变就该什么都不做。

## Consequences

- `.gz` 每轮仍然要整份读文件并算哈希，省下的是解压与切行，不是 I/O。压缩比越高，这份节省越大；未压缩的小文件上二者差别不大。
- `route.unchanged` 从此可观测，报告里的路由三态计数才有意义（此前这一项在容量基线记录里被注为恒 0）。
- 解压失败的文件每轮都会被重新读、重新算哈希、重新失败一次；这是有意的，错误不能因为"报过一次"而消失。
- 哈希碰撞不作为运行时分支处理：SHA-256 冲突不在本入口的失败模型内。
- 三态与错误码的现状描述在 [docs/architecture-design.md](../../../../docs/architecture-design.md)；本 note 只写为什么这样分。

## Testing

`bun test tests/files.test.ts` 覆盖：未变 gzip 命中已提交指纹时不再解压且 `lines` 为空，同文件被追加后重新压回仍被检出并解出两行；损坏 gzip 报 `route_gzip_invalid` 且保留 64 位指纹，替换成合法文件后恢复 `decoded`；跨午夜只解压新增日期文件（当日 `unchanged`、次日 `decoded`）。`bun run typecheck` 覆盖 `RouteState`、`RouteCursor` 与 `routeTick` 的接线。

## Related

当日 `.jsonl` 的追加不再走整份指纹，改由 [路由当日文件按游标增量读取](2026-10-24-atc-route-jsonl-tail-cursor.md) 持有；本 note 保留 `.gz` 的哈希先行与三态记账。

优化前后的路由三态对照数字在 [baseline record](../../../../docs/superpowers/capacity/2026-10-22-atc-capacity-baseline.md) 的「路由解码对照」一节。