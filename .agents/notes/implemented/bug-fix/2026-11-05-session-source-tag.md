# Agent Note: 会话文件来源标签按 agent 取名

Status: implemented

## Problem

右栏身份行与路由页把 `via = 'session'` 的来源一律写成「droid 会话文件」，证据折叠区的账本缺失结论句也统一写成「回调没有携带可核验的 response ID」。droid 是第一个走会话文件接入的 agent，这两处文案从那时起没有按来源区分。Hermes 接入后，本地行由 `hermes_session_call` 重建正文，页面却标成 droid 的文件，并给出回调路径的解释，与实际的本地会话对齐失败不符。

## Decision

会话文件来源的标签按行上的 `agent` 取名（`Hermes 会话文件`、`Droid 会话文件`），agent 为空时退回通用「会话文件」；悬停说明同步换成「请求体由 {agent} 会话文件重建……」。证据折叠区在 `via = 'session'` 时改用「本地会话行没有与网关行唯一对齐」，网关路径保持原文。中英文案一起改。

## Alternatives considered

**继续写「droid 会话文件」，只在 Hermes 行上覆盖。** 等于给每个新来源加一条特例，下一家接会话文件时还会错；按 agent 取名一条规则就够。

**不显示来源标签。** 「请求体由会话文件重建，不含 system prompt 与工具定义」是读者判断正文完整性的依据，删标签会把这条信息一起删掉。

## Consequences

旧的两条 droid 键删除，新增通用与带 agent 的键各两条。agent 未登记时标签回退原始 id，与左栏的 `agentLabel` 保持一致。页面显示与实际来源一致，不再把一家 agent 的文件名按到所有会话来源上。