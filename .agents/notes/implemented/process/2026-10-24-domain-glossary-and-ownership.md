# Agent Note: 仓库词汇表与术语管辖权

Status: implemented

## Problem

运行模型的词汇散在 architecture-design.md 各节、代码注释与 note 里，没有一处把它们并列列出：

- source 一个词形覆盖三个概念：证据通道、物理来源、流量种类
- 七个递增计数各自回答不同的问题
- 认识论五词与销毁动词的区分只存在于散文叙述

同时有一处文档与代码的分歧：architecture-design.md 的 request_evidence DDL 注释写 merge_state 取值含 ambiguous，代码从不写该值，多候选歧义由 pending_hook.candidates 承载。project-overview.md 的名词节只收四个定位级名词，容纳不了这些运行词汇。

## Decision

仓库根新增 [CONTEXT.md](../../../../CONTEXT.md) 作为运行词汇的唯一词汇表，本变更交付首批词条五组：

- 证据的坐标：证据通道、物理来源、流量种类、出生通路 via、关联、请求折叠
- 递增计数家族
- 认识论五词
- 销毁动词
- kind 三族

管辖权分三条：术语定义与边界归 CONTEXT.md；字段清单、值域细节与默认值仍归 [architecture-design.md](../../../../docs/architecture-design.md)；定位级入门名词（请求、session、conv、trace）的定义留在 [project-overview.md](../../../../docs/project-overview.md) 名词节，CONTEXT.md 不重复定义。merge_state 的 ambiguous 从 DDL 注释移除，文档写现状。CONTEXT.md 登记进 [docs/AGENTS.md](../../../../docs/AGENTS.md) 分层表，project-overview.md 名词节补一行指向。

词条准入按场景压测：压测中能逼出边界混淆的词才收进词汇表，不追求全量。

## Alternatives considered

**扩 project-overview.md 的名词节。**落选。该节服务于定位叙述，四条入门词与运行词汇粒度不同，把运行词汇塞进去会把定位层撑成规格，也违反它自己「实现细节、决策 rationale 不放」的约束。

**词汇表放 docs/glossary.md。**落选。词汇表是随工作持续修订的活文档，与根 AGENTS.md、README 同级更可达。docs/AGENTS.md 分层表本就收录根级文件（../AGENTS.md、../README.md），登记一行即可。

**只修 merge_state 注释，不建词汇表。**落选。这样只消掉一处分歧，source 一词三义与计数家族的并列清单仍然缺失，下一个读者只能自己重新拼凑，同一类文档分歧还会再出现。

**同步改代码消除词形冲突（source_kind 两表不同值域、via 混装）。**落选。schema 词形进 API 响应与持久化格式，按破坏式替换政策，这是一次需要先做 backfill 决策的架构动作；当前模型在代码里已经自洽，缺的是定义，不是改名。等真实工作中被这些词形绊住的事件出现，再按当次变更立 note。

## Consequences

词汇表不接门禁，腐化靠评审与场景压测捕捉。与「一个事实一个家」的边界由管辖权三条维持，执行靠的是分层表里的登记行。via 与 merge_state 的词形若继续造成误读，改名是独立决策，走 architecture 或 process 类 note 并带迁移方案。
