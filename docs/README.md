# agent-trace-collector 文档

这个目录存放 trace 工具的调研与设计文档。工程本身还没有代码，先有结论。

## 索引

| 文档 | 内容 |
| --- | --- |
| [project-overview.md](project-overview.md) | 项目定位：显示单元是一笔请求、数据来自哪三条通道、与 magpie 的绑定有多深、第一版做什么与不做什么 |
| [magpie-integration-research.md](magpie-integration-research.md) | magpie 0.1.1294 的 Agent 识别、session 与 conv 两套会话标识、四条可接入面（hook / 用量账本 / OTLP / 路由历史）、连接键的实测命中率，以及对新工程的取舍建议 |

## 调研文档回答了什么

- magpie 如何把一笔请求归属到某个 Agent，这套归属有多可信，外部能不能读到它的 Agent 表。
- 同一段对话的请求靠什么聚在一起。答案是两套标识：客户端声明的 `session` 和 magpie 对首条用户消息做的哈希 `conv`，两者互斥且覆盖的 Agent 群体互补。
- 外部能调用的接口有哪些，各自的访问控制、分页上限、筛选语义。
- 正文、元数据、路由决策分别只能从哪条通道拿，通道之间靠什么字段连接。

## 尚未做的事

调研阶段只读，没有写代码，也没有改 magpie 或现有 AVA 仓库。下一步如果开工，最小形态已在调研文档的新工程建议一节给出：hook 收正文，用量账本收权威元数据，按 `response_id` 连接。