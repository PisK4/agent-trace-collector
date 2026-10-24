# AGENTS.md — Implemented Agent Notes

这类 Agent Note 记录已经交付的决策。遵守[根指令](../../../AGENTS.md)与 [Agent Note 格式](../README.md#the-file-format)；`verify-agent-note-format` 门禁强制生命周期专属的结构。

## 保持 implemented Agent Note 与实际交付内容同步

代码改动了路径、符号、默认值或机制时，同一个变更里就更新 note 中对应的事实。过期事实直接在原地改写；变更历史不写进正文。

当一份已交付的 note 不太可能再指导未来工作时，按[归档规则](../README.md#归档与删除)把整篇文件移入归档区，而不是继续维护它。

### 这不是改写决策的许可证

只更新事实层面的内容（路径、符号、默认值这类）。要反转决策或更换决策依据，必须另写一份新 Agent Note 并互相链接；被完全取代的旧记录，只能按 [Agent Note 规则](../README.md#何时需要写一份)的合并条款删除。
