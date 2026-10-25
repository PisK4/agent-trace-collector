# Agent Note: 根 AGENTS.md 只留常备规则与链接

Status: implemented

## Problem

根 AGENTS.md 是每个会话都进上下文的文件，但它把别处已有的规则又写了一遍：Agent Note 的 supersession check、决策不可改写与归档冻结在 [.agents/notes/README.md](../../../../.agents/notes/README.md) 有完整版本；文档写现状、一个事实一个家与文风禁区归 [docs/AGENTS.md](../../../../docs/AGENTS.md)；0600 / 0700 与回环监听在 [architecture-design.md](../../../../docs/architecture-design.md) 的安全边界表和 [operations.md](../../../../docs/operations.md) 的数据目录表各有一份。同一个事实两处维护，改一处就漂移。

命令块还有一处会误导执行：`bun run maintain` 与 `bun run verify-cutover` 裸调用只打印 usage 并退出 2，与 `bun install`、`bun test` 并列成清单时看不出这个差别。

## Decision

根 AGENTS.md 收敛为四块：首版前立场、命令、常备约定、栈特有约定，末尾附目录与上位文档。

规则一条只留一个家。根文件保留判断本身与失效后果，细节改成链接：note 生命周期归 Agent Note 规则，文档分层与文风归文档标准，术语归 [CONTEXT.md](../../../../CONTEXT.md)，架构与存储形状归架构设计，运维步骤归运维手册。「非平凡变更须带 note」只留判断与豁免，判据范围交给 Agent Note 规则，根文件不再列那份清单。

命令块只列日常四条加提交前一条；`maintain` 与 `verify-cutover` 单独一句说明必须带子命令，细节链接运维手册。豁免语法保留在根文件：它是提交前会用到、且不看 note 就会漏的机械要求。

仓库布局不再逐目录罗列：`src/`、`web/`、`tests/`、`docs/` 看一眼目录就懂，只留三处不显然的（`prototypes/` 只提供数据源并加载同一份生产页面、`plugins/` 是给 magpie 的薄插件、`.agents/` 是 note 规则与 kit 版本基线）。

界面降噪那条去掉英文原文：判断标准本身就是完整的，原文对执行没有增量。

## Alternatives considered

**保持原样，只做措辞精简。** 落选。重复的家不会因为措辞更短就停止漂移；问题正是同一规则存在多个版本。

**把栈特有约定整块下放到 docs/AGENTS.md。** 落选。依赖方向、`main.ts` 只做 wiring、回环监听、页面转义与界面降噪是改代码时要当场遵守的约束，放在每次必读的文件里才拦得住；下放后要主动翻文档才会看到。

**删掉仓库布局整节。** 落选。`prototypes/` 不维护第二套界面这条，只看目录名看不出来，误在 `prototypes/` 里改界面就是重复实现。

**把豁免语法也链接出去。** 落选。`Agent-Note: none` 与 `ATC_NOTE_EXEMPT` 是提交前必用的机械字符串，链接一层就要多读一个文件；它只占一行。

## Consequences

根文件从 5,077 字节降到 3,921 字节，规则条数 19 降到 14，语义没有减少，减少的是复述。`bun run maintain` 与 `verify-cutover` 现在与日常命令分开写，裸调用会退出 2 这件事写在文件里，不靠踩一次才发现。

代价是读者要多跳一次链接才能看到 note 生命周期的细则；这些细则只在写 note 时才需要，而写 note 时必然会打开 Agent Note 规则。

今后新增常备规则的准入标准是：只写「改代码时当场要遵守、且别处没有权威」的规则，其余写进所属文档再加一行链接。
