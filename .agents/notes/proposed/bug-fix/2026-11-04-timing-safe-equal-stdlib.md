# Agent Note: Bearer token 比较换 node:crypto timingSafeEqual

Status: proposed

## Problem

[src/http.ts](../../../../src/http.ts) 手写了 8 行 timing-safe 比较，三个 Bearer 鉴权点（读路径、hook、OTLP）共用。两个问题：

1. `node:crypto` 自带 `timingSafeEqual`，纯 stdlib 重复实现。
2. 手写版长度不等时提前 `return false`，泄漏 token 长度；stdlib 版遇长度不等是 throw。手写版不但重复还比 stdlib 弱。

来源：2026-11-04 依赖审查（用户起因是 Agent 把「不引第三方依赖」过读成「不用内置」，审计全仓后确认真正的手搓轮子只有此处；另一处 OTLP 手搓解码器有提案 note 背书，刻意收窄，不换）。

## Change

本地函数改名 `tokenEquals`：两边先 sha256 定长 32 字节，再交 `crypto.timingSafeEqual`——不 throw、不提前返回，长度信息不泄漏。三个调用点同步改名，签名不变。

## Alternatives considered

**直接 `timingSafeEqual(Buffer.from(a), Buffer.from(b))`。** 长度不等会 throw，调用点要包 try 或先比长度；先比长度就是原来那条泄漏路径。

**保留手写实现。** 与 stdlib 重复且更弱，无保留理由。

## Acceptance

- `bun test tests/http.test.ts` 22 pass：对 token 200，错 token/缺 token/跨站 401，读与 hook 两条路径都盖住。
- `tsc --noEmit` 通过。

行为对所有输入等价（等→true、不等→false），变化只在侧信道轮廓与实现来源；无重建、无 schema 变更。
