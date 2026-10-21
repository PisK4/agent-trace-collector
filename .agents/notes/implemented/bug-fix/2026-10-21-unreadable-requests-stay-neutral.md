# Agent Note: 正文不可读的请求保持中性，不标分支

Status: implemented

## Problem

正文没有到达的请求无法参与前缀比较，`prev_relation` 记为 `unknown`，也没有已知父节点。把它算进链森林时，它会成为一个没有后继的根；按主链规则，这个根会被标成 `branch`，即使没有任何证据说明它另起了一支。读者会把「正文缺失」误读成「请求分叉」。

## Decision

链角色重算时排除 `prev_relation='unknown'` 的请求。它们保持中性的 `chain_role='main'`，不参与主链竞争，也不显示「分支」；只有正文可读、确实无法与任何更早请求前缀相接的请求才标 `branch`。实现见 [src/derive.ts](../../../../src/derive.ts) 的 `assignChainRoles`。

`unknown` 会沿组内时间向后传播：一笔正文缺失之后，后续请求也无法确认是否续自它，因此同样保持中性。该组可能整组没有分支标记，这是缺少证据时的保守结果。

## Alternatives considered

**把 unknown 请求留在森林里。** 它没有后继，会被判成 `branch`，把「正文缺失」显示成「另起一支」；这正是修复前的行为。

**把 unknown 请求接到最近的主链上。** 没有证据支持这条边；接上去等于用猜测补链，还会把它的后继错误地并入主链。

**在账本里隐藏 unknown 请求。** 正文缺失本身是需要看到的状态；隐藏会让读者以为请求不存在。账本仍显示请求，只是不给它链角色结论。

## Consequences

- 含正文缺失的组可能整体没有分支标记；这是有意放弃的可见性，换掉误判。
- 每批派生先按现有规则把所有非标题请求重置为 `main`，再由 `assignChainRoles` 覆盖可判定的部分；因此请求后来变得不可读时，旧的 `branch` 会回到中性。
- 正文缺失仍通过 `body_state` 在账本与详情里显示，链角色不承担这个信息。

## Testing

`tests/derive.test.ts` 的「前驱正文缺失时本轮记为 unknown 且不算增量」断言这些请求的 `prev_relation` 为 `unknown`、`chain_role` 仍为 `main`。
