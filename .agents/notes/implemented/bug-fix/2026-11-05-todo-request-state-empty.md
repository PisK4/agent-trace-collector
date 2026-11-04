# Agent Note: 请求态的待办页签不再停在读取中

Status: implemented

## Problem

[Plugin 登记层与 Todo 页签](../architecture/2026-11-05-plugin-registry-and-todo-tab.md)把第五页签定为轮次作用域，页签行上提到轮次分岔之前，请求态也能点。请求态没有轮号，`read-todo` 不会发出，`todoTabHtml()` 却把 `idle` 与 `loading` 一起渲染成「读取中」。真实流量验收打开 zcode 会话的 `?tab=todo` 时页面永远停在这句，看不出要先选轮次。

## Decision

`todoTabHtml(reading, hasTurn)` 区分 `idle` 与 `loading`：请求态 `idle` 显示「选择轮次后查看待办」，轮次态 `idle` 仍显示「读取中」。页签仍可点，点轮次 chip 后 `select-turn` 发 `read-todo` 的既有路径不变。没有替用户自动选当前请求所在的轮：`listTurns` 只结算主链 actor 的轮，选中的请求可能是子代理或不在任何已结算轮内，自动选轮要另立请求到轮的映射与跨 actor 口径，超出这次修复。

## Alternatives considered

**请求态自动结算并选中所属轮次。** 落选：主链轮与任意 actor 的请求不是一一对应，子代理请求会让归属与读取口径同时变复杂；一句提示把选择权留给人，代价是少一次点击的便利。

**请求态禁用第五页签。** 落选：页签行在两种阅读态都可见，禁用会让轮次态的入口也从请求态消失；提示文案保留入口并说明下一步动作。

## Consequences

请求态点第五页签现在有一句明确的下一步，不再伪装成正在读取。提示不解释轮次怎么选，用户仍要自己找到轨迹上方的轮次带；轮次结算覆盖率低时，多数会话会反复看到这句提示，这是既有轮次结算覆盖面的可见化，不是本页签的新缺陷。

## Testing

`tests/todo-tab.test.ts` 断言请求态 `idle` 出提示、不出「读取中」，轮次态 `loading` 仍「读取中」、`failed` 仍「读取失败」；`tests/i18n-coverage.test.ts` 纳入新增文案。测试只用合成数据。
