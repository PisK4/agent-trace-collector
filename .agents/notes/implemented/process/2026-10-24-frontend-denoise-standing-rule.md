# Agent Note: 前端降噪原则进入常备指令

Status: implemented

## Problem

web 界面在时间线角色徽章、右栏折叠行与各正文面板里积累了成批的二级标签与说明文字。2026-10-24 的样式评审确认这些元素不承担额外信息，布局本身（分组、间距、对齐、底色差）足以解释结构；`web/app.js` 的注释里早有「正常态不挂 chip；异常才提示」，但只覆盖工具列表一处，没有约束全部前端改动。

## Decision

根 AGENTS.md 栈特有约定加入一条：界面不加多余的二级标签与说明文字，让布局解释结构；正常态不带装饰性状态，异常才出现标签。原文：Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.

提炼过程与来源印证记在父知识库 `设计参考/主题/布局自解释.md`（creator-intelligence 仓库），本 note 只记录把它立为常备约束这件事。

## Alternatives considered

**写进 architecture-design.md 的布局一节。** 架构文档是版式现状的权威，写数值与结构；约束性规则放在每次改动必读的 AGENTS.md，避免同一规则两处维护、互相漂移。

**只随样式重构的 note 记录。** note 是决策史，规则会在目录树里沉底；常备指令才能约束之后每一次前端改动，包括与本次重构无关的新界面。

## Consequences

新增或改动界面时多一层默认裁判：先问布局能否解释，再考虑加标签或说明文字。数据口径类说明（估计分配、留痕不完整、缺失原因）不受此条影响，照常保留。计划中的样式降噪重构落地时，其 note 从本文交叉链接；与[中栏只呈现内容](../simplification/2026-10-24-trace-content-only-and-wide-rail.md)是相邻决策——那边定中栏与右栏的职责分工，这边定所有界面的表达方式，互不取代。
