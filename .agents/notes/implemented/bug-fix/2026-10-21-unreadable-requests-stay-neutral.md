# Agent Note: 正文不可读的请求保持中性，不标分支

Status: implemented

## Problem

正文没有到达的请求无法参与前缀比较，`prev_relation` 记为 `unknown`，也没有已知父节点。把它算进链森林时，它会成为一个没有后继的根。按主链规则，这个根会被标成 `branch`，即使没有任何证据说明它另起了一支。读者会把「正文缺失」误读成「请求分叉」。

## Decision

对 `prev_relation='unknown'` 的请求不下链归属结论：不补猜测边、缺失不当分支结论、unknown 沿组内向后传播——这三条是本 note 的核心，[不确定闭包](2026-10-27-chain-role-uncertainty-propagation.md)全部沿用。被它部分取代的是编码选择与森林处理：unknown 节点如今以无父节点身份留在森林里，与从它出发的 confirmed 后继一起显式记 `chain_role='unknown'`，不再借用 `main` 的中性编码，也不再因排除出森林而切断 confirmed 后继与链的连接。判定实现见 [src/derive/decision.ts](../../../../src/derive/decision.ts) 的 `chainRolesOf`。

## Alternatives considered

**把 unknown 请求留在森林里。** 它没有后继，会被判成 `branch`，把「正文缺失」显示成「另起一支」；这正是修复前的行为。后续实践证明留森林与保中性可以兼得：trunk 照旧、闭包单独编码——见取代本条编码选择的 2026-10-27 note。

**把 unknown 请求接到最近的主链上。** 没有证据支持这条边；接上去等于用猜测补链，还会把它的后继错误地并入主链。

**在账本里隐藏 unknown 请求。** 正文缺失本身是需要看到的状态；隐藏会让读者以为请求不存在。账本仍显示请求，只是不给它链角色结论。

## Consequences

- 含正文缺失的组可能整组没有分支标记。这是有意放弃的可见性，用来避免误判。
- 请求后来变得不可读时，重算把它的角色连同 confirmed 后继一起落 `unknown`；旧的 `branch` 不会残留。
- 正文缺失仍通过 `body_state` 在账本与详情里显示，链角色不承担这个信息。

## Testing

`tests/derive-chain.test.ts` 的「前驱正文缺失时本轮记为 unknown 且不算增量」断言这些请求的 `prev_relation` 与 `chain_role` 都为 `unknown`（编码随 2026-10-27 note 更新）。
