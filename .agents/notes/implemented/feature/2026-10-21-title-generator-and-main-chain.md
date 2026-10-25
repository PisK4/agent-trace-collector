# Agent Note: Title Generator 与主链分离

Status: implemented

## Problem

Claude Code 的 Title Generator 是会话旁路请求，输入是单个 `<session>` 块，回复是 `{"title":…}`。它排在真实对话之前，因此成了同一 `(conv_key, actor)` 组的第一个请求，也是链根。真正的第一笔用户请求反而没有前缀可匹配，被标成 `branch`。同一组里还可能出现几条互不相接的真实请求链，严格前缀只能说明「这一笔是谁的续写」，不能说明「哪条是主线」。

## Decision

标题请求的识别归[请求用途版本化解释](../architecture/2026-10-22-request-purpose-and-chain.md)：分类器强指纹 > 来源 kind > 标题兼容 > 兜底，标题只是这条优先级里的一档，不再是唯一的识别入口。被认作标题的请求记 `req_kind='title'`、`purpose_chain='exclude'` 与 `chain_role='aux'`，不进入祖先集合，也不参与用户标题推导。解析出的正式标题存 `model_title`。会话标题优先取最新一次 `model_title`，没有才退回主链上最早的用户首句，再退回任意用户首句，最后才是时间兜底。

每个 `(conv_key, actor)` 组在派生末尾重算链角色：时间最早的一笔真实请求是主链根，其余互不相接的根及其后继标 `branch`；正文不可读的请求保持中性。字段与现行规则见[架构设计的标题一节](../../../../docs/architecture-design.md#标题)。

清洗名单补了 `<local-command-caveat>` 与插话前缀 `The user sent a new message while you were working:` 及其尾部说明，避免它们进入标题与摘要。清洗名单与包装剥离的现行实现见 [src/input-interpretation.ts](../../../../src/input-interpretation.ts)，链角色重算见 [src/derive.ts](../../../../src/derive.ts)，标题推导见 [src/queries/sessions.ts](../../../../src/queries/sessions.ts)。

## Alternatives considered

**把 Title Generator 当普通对话请求。** 这是修复前的行为。真实会话里标题请求占据了 `first`，第一笔真实请求被标成 `branch`，链和标题都错了。

**按后继子树大小选主链。** 第一版实现按「后续请求最多」选主链。真实会话里第一笔用户请求（req 25627）因为一条后来独立重跑的 148 笔链共享 `conv_key`/`actor` 而被标成 `branch`。主链是会话的第一笔真实请求，不是最忙的那条。该规则在后续修复中被推翻，现在是按时间最早的根选。

**结构变更后删库重建。** 标题与链角色都是派生列，删库再重放来源最省事，实现时也一度按这个方向接受删除。后来改为由回填脚本补列，保住已有正文，见 [schema 升级 note](../../archived/architecture/2026-10-20-schema-v3-rejects-in-place-upgrade.md)。v5 起改回破坏式替换，与本条决定无关。

## Consequences

- 标题请求不再占用链根，也不再提供用户标题。会话标题改由 `model_title` 主导。
- 识别依赖用途阶段的版本化解释，其中标题兼容那一档仍是形状启发式：普通回复若恰好是单键 `{"title":…}` 或整段 `<title>`，会被判成标题请求；`req_kind='title'` 一旦写入不会回退。
- 主链以时间为序。同一个 `conv_key`/`actor` 下若更早存在真正无关的请求，它会成为主链根；`conv_key` 与 `actor` 的归属判定是这条规则的前提。
- 每组派生末尾多一次链角色重算，按组内请求数线性遍历。
- 组内出现正文不可读的请求时，后续请求无法确认归属，整组可能没有分支标记；处理方式见 [正文不可读的请求保持中性](../bug-fix/2026-10-21-unreadable-requests-stay-neutral.md)。
- 请求类别、链角色与模型标题这三列由请求与组阶段写入，不再是需要单独回填的结构变更；结构升级路径见[旧库删除重建](../architecture/2026-10-23-destructive-schema-replacement.md)。

## Testing

`tests/derive.test.ts` 的「标题生成请求不占主链，时间最早的链才是主链」覆盖标题请求、真实首笔、续写与后继更多的次链。回填脚本在真实库副本上重跑后，req 25627 为 `first/main`，其后的独立重跑为 `branch`。
