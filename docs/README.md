# agent-trace-collector 文档

这个目录存放 trace 工具的调研与设计文档。另有[可交互的界面原型](../prototypes/README.md)，用于比较阅读结构；采集与查询后端尚未实现，实现依据见[收敛型技术架构设计](architecture-design.md)。

## 索引

| 文档 | 内容 |
| --- | --- |
| [project-overview.md](project-overview.md) | 项目定位：按请求保存、按对话导航，右侧读 Response 参数，三条数据通道、magpie 绑定与第一版范围 |
| [magpie-integration-research.md](magpie-integration-research.md) | magpie 0.1.1294 的 Agent 识别、session 与 conv 两套会话标识、四条可接入面及原采集结果；新增研究补充了部分机制边界，见文首说明 |
| [magpie-mechanisms-research.md](magpie-mechanisms-research.md) | 模型、路由与上下文容量的真实控制流，现成 prompt 分解、classifier、缓存亲和性、尝试与账本、插件形态及直接集成或借鉴的取舍 |
| [architecture-design.md](architecture-design.md) | 技术评审后的收敛型设计方案：技术栈与进程模型、三路证据收敛、SQLite 表结构、内容去重与派生字段、查询接口、10 GB 滚动预算、版本探针、AVA 下线顺序与分步落地判据 |

## 调研文档回答了什么

- magpie 如何把一笔请求归属到某个 Agent，这套归属有多可信，外部能不能读到它的 Agent 表。
- 同一段对话的请求靠什么聚在一起。答案是两套标识：客户端声明的 `session` 和 magpie 对首条用户消息做的哈希 `conv`，两者互斥且覆盖的 Agent 群体互补。
- 外部能调用的接口有哪些，各自的访问控制、分页上限、筛选语义。
- 正文、元数据、路由决策适合从哪些通道取得，通道之间靠什么字段连接，以及缺失、截断和关联歧义的边界。

## 尚未做的事

当前有研究与定位文档、收敛型架构设计，以及采用合成数据的界面原型，尚无生产实现。magpie 与现有 AVA 保持未修改。

架构已给定四步落地顺序，第一步（只读账本与路由、出真实数据页面）不依赖 hook，可以先做。仍在等待确认的问题列在架构文档末尾：超大请求的回调为什么丢失、direct 是否还会新增、分级保留的切分点、推理正文是否入库、多实例标识。