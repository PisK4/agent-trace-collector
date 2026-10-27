# Agent Note: Hermes 用途识别

Status: implemented

## Problem

本机经 magpie 网关发出的 Hermes Agent 流量里有两类旁路请求混在主链中。命令安全审查器的 system 是 `You are a security reviewer for an AI coding agent. You assess whether shell commands are safe to execute.`，每次执行 shell 命令前发一笔短判定，回复可为 `ESCALATE`；会话标题生成器的 system 含 `You name chat sessions.`，回复是单键 JSON 或 `<title>`。

现有规则只覆盖了回复侧形状。审查器没有专属指纹，落 `unrecognized` + `chat` + `participate`，占据 `chain_role='main'` 并进入后续请求的祖先集合。标题生成器在回复可读时由共享的 `title.reply.v1` 认出；缺回复的请求拿不到 response ID，只能以 `via='hook'` 独立成行，用途仍是 `unrecognized`，既不进派生队列，也不作祖先候选。

只读统计见[验收记录](../../../../docs/acceptance.md#hermes-用途识别)：1,242 笔 Hermes 请求分布在 159 个会话键上，其中 56 笔落在 `['session','']` 空桶；已识别标题 3 笔，其余标题孤儿与审查器请求都在主链里。

## Decision

新建 [src/harness/hermes.ts](../../../../src/harness/hermes.ts)，在 [PURPOSE_RULES](../../../../src/harness/purpose.ts) 登记 `{ agent: 'hermes', decide: hermesDecision }`。标签选取在登记处完成，adapter 不自查 agent，不读数据库，只消费 [PurposeView](../../../../src/semantics.ts) 的 `systemTexts` 与 `replyText`。

两条指纹用 system 文本小写包含比较：

| 规则 | 指纹 | 结论 |
| --- | --- | --- |
| `hermes.command-review.v1` | `security reviewer for an ai coding agent` | `kind='command-review'`、`chain='exclude'`、`modelTitle=null` |
| `hermes.session-title.v1` | `you name chat sessions` | `kind='title'`、`chain='exclude'`、标题取严格回复解析 |

审查器先判，标题后判，两条同时出现时审查器取胜。判定词只写 signals（`escalate`、`allow`、`deny`、`block`、`pass`、`other`、`unknown`），回复缺失不改变结论。标题复用共享的 `parseTitleReply`，单键 JSON 与 `<title>` 两种形状都提取；缺回复仍排除链，从未提取过标题时 `model_title` 为 null，已存正式标题的行保留旧值。

用途结果改变链参与，[PURPOSE_VERSION](../../../../src/semantics.ts) 从 4 升到 5。页面标签在 [session-view.js](../../../../web/session-view.js) 补 `hermes: 'Hermes'`。共享文件 [semantics.ts](../../../../src/semantics.ts) 与 [request-purpose.ts](../../../../src/request-purpose.ts) 不出现 Harness 名称，结构化测试按整词扫描。

### 存量行

版本升级不自动重算已结算的行。本机 Hermes 存量由项目所有人决定直接删除，不执行用途重建；新采集的请求按 v5 结算。保留历史的环境用[显式会话重建](../../../../docs/operations.md#rebuild)按 `conv_key` 逐个升级，作用域是整个键：空桶里可能混有其他 agent 的行，执行前要报告各 agent 的候选数量。

### 边界

本次只交付用途识别。hook 投递诊断见[分层验证 hook 投递](2026-10-27-hermes-hook-delivery-diagnostics.md)，空 session 修复与身份迁移见[空 session 身份修复](2026-10-27-empty-session-identity-migration.md)。工具名称、参数与失败语义的额外适配未做；协议兼容不等于工具展示已覆盖。

## Alternatives considered

**为 Hermes 建 Profile 或动态插件接口。** 两条指纹已有静态登记入口，额外框架不能解决会话身份或投递缺失，增加的接口没有当前消费者。

**只靠标题回复形状。** 回复可读时共享规则已经够用，缺回复的标题请求只有请求侧 system 指纹可用，而这批请求正是需要修的那批。

**把 ESCALATE 一类判定词作为门槛。** 回复可能缺失、措辞可能变化；请求侧指纹识别用途，判定词只保留为信号，避免上游改形时审查器重新回到主链。

**在共享文件里加 Hermes 分支。** 专属知识归 adapter，分派、结算与共享解释继续复用，不新增品牌判断。

**重建所有 Hermes 会话。** 存量数据可删除，重建 159 个会话键换来的只是一批很快会被清掉的行；保留历史的环境仍可用现有显式入口。

## Consequences

指纹依赖上游 system 措辞与 agent 标签。措辞变化会退回未识别并继续参与链，规则失效会重新影响主链，不能描述为无害。system 文本也可能含引用材料，包含比较存在误判风险；user 引用不命中的测试不能证明所有 system 引用都安全。

版本从 4 升到 5 意味着已结算的历史行在下次显式重建前保持 v4 结论。`retained` 行说明它按哪一版算出来，不冒充新规则已确认。

标题生成器的 `model_title` 只在回复可读时更新；缺回复的孤儿请求排除链但不提供标题，会话标题继续由用户首句或旧标题承担。

## Testing

`tests/semantics.test.ts` 锁定两条指纹的结论、规则 ID、信号与双指纹次序，并覆盖 user 内容、非 hermes agent、未知与空标签的反例。

`tests/request-purpose.test.ts` 用真实 Chat messages 的 system 块经 `readPurposeViewTx` 结算，分别验证审查器与缺回复标题孤儿；未知 actor 行结算用途后仍是 `actor_state='unknown'`。

`tests/hermes-purpose.test.ts` 构造主请求 A、审查器 R、续写 B：R 得到 `prev_relation='aux'`、`chain_role='aux'`、`delta_ordinals=null`、`title_source='model_time'`，B 仍以 A 为前驱；已确认标题不因后续缺回复被撤销。

`tests/harness-purpose.test.ts` 的生产登记与品牌回流结构断言同步覆盖 hermes。`tests/web.test.ts` 锁定页面标签。`tests/derive-purpose.test.ts`、`tests/derive-chain.test.ts`、`tests/derive-tool-pairing.test.ts` 确认共享派生路径未回归。这 8 个文件共 112 项通过，`tsc --noEmit` 通过。
