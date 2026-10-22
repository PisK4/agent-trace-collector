# Agent Note: 请求用途按版本 2 解释，主链身份只由已存用途决定

Status: implemented

## Problem

用途原来散在派生阶段：标题请求按回复字符串猜，普通请求一律当 chat，页面和查询各自再猜一次。同一条规则在多个消费者里各写一份，改一处不会同步另一处；识别依据也没有持久版本，正文回收后无法说明一行当初为什么被排除出主链。

分类器请求还暴露了另一类风险：只按回复里的 `<block>no` 判定，会把普通对话的同样回复误认成分类器；只看 system 文本又会被同名提示词命中。识别条件必须同时约束 agent、system 与 stop_sequences，形状只作为信号。

## Decision

`src/semantics.ts` 是纯解释模块，只看一笔已读出的请求视图，不读数据库。`PURPOSE_VERSION=2`，规则优先级固定为：分类器强指纹 > 来源 kind > 标题兼容 > 兜底。

分类器必须同时满足 `agent='claude'`、system 文本包含 `security monitor for autonomous ai coding agents`、`stop_sequences` 包含 `</block>`。消息数 2 与工具数 0 只写 `classifier.shape.*` 信号，不作为门槛；回复判定取最后一个 `<block>yes|no`，缺失记 `classifier.verdict.unknown`。

来源 kind 只有精确值 `title` 排除链，其它非空值变成 `source:<value>` 并保持参与；`conflict`、`missing`、`invalid`、`overflow` 不出结论，交给标题兼容兜底。标题兼容先看回复形状（整段 `<title>` 或只含 `title` 键的 JSON），再看已存 `req_kind='title'`；已存 title 在回复不再是标题形状时保留旧 `model_title`。

正文不可读时，有旧解释（`purpose_version` 非空）就整行保留并追加 `purpose.retained`；没有旧解释才落 missing 或 unsupported，并保留旧的 chain/kind。来源 kind 只对没有旧解释的行生效，避免正文回收后一条普通来源覆盖分类器结论。

解释结果只描述结论与依据：`status`、`version`、`rule`、`signals`、`chain`、`kind`、`modelTitle`。信号代码按判定顺序排列，供报告与排查使用，不参与判定。

用途由 `src/request-purpose.ts` 按单笔结算：读完视图后以请求行上的身份、修订、目标与待处理标记为条件写回；条件不命中说明读视图之后输入又变了，返回 stale 并保留 pending，等下一轮重来。错误最多记三次，终态把状态落成 `error` 并消费当前修订，避免一笔永远读不出来的请求把整组卡在 dirty。只有结论改变链归属或标题时才标脏所属组，单纯重算同一条结论不动队列。

用途读取只解骨架与引用索引，不解压消息块。正文读取是共享的一条严格路径：骨架字段、请求行上的消息条数、引用数与连续 ord、块存在，任何一项不一致都返回 null；派生因此把正文当成不可读，用途因此走 retained/missing，而不是把部分正文当完整证据。旧实现里"缺引用就抛错"与"补一个空位"的做法都取消了。

## Alternatives considered

**继续在派生阶段按回复字符串判定。** 规则与链计算绑在一起，查询与页面只能复制或再猜；正文回收后旧的猜测也留不下依据。

**只按回复 `<block>` 判定分类器。** 普通对话恰好回复 `<block>no` 会被排除出主链，而且无法与真正的分类器区分。

**来源 kind 的任意非空值都排除链。** 上游的 `compaction`、`chat` 等值会悄悄改变主链结构；只认精确的 `title` 别名，其它值保留成 `source:<value>`。

**正文不可读时按来源 kind 重新判定。** 正文回收后，一条普通来源会把此前识别出的分类器或标题覆盖掉；旧解释优先才是稳定口径。

**把正文结构损坏当成异常抛出。** 调用方要么各自捕获，要么把半截正文当成完整证据；共享读取器统一返回 null，所有消费者对"不可读"只有一种处理。

## Consequences

- 用途结论可以脱离正文重放：同一版本与信号在查询、报告与重建里含义一致。
- 分类器形状变化不会让请求掉回 chat，只会少两个 shape 信号。
- 已存 title 的请求不会因回复改形重新进入主链，代价是上游真正改变用途时需要显式重建。
- 局部正文损坏一律按不可读处理：宁可 retained/missing，也不把 partial 当完整分类。
- 用途与组共用 `drainDeriveTx` 一个事务：先分批把作用域内的待判请求推到排空，组阶段才发布；`limit` 仍按组计数，`purposeLimit` 只是每批大小。组结果报告同时给出已判与仍待判的请求数。
- 本批交付纯解释与单笔结算；接入查询、页面与维护入口由后续变更补齐，同一时间只有一个用途写入者。

## Testing

`tests/semantics.test.ts` 覆盖规则优先级、agent 门控、普通 `<block>` 回复、两种标题形状、来源别名与冲突、retained/missing/unsupported。`tests/request-purpose.test.ts` 覆盖 CAS stale、三次重试终态、回收后 retained、引用缺失按不可读、来源别名与目标升级；`tests/body.test.ts` 固定末条引用缺失时不可还原。
