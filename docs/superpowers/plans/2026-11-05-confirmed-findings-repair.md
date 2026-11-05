# 已确认缺陷修复实施计划

> 本轮按用户指定的 subAgent 实施、主 Agent 审查和生产验证执行；已确认的修复直接推进，不再重复询问执行方式。

**Goal:** 修复提交复核后仍成立的缺陷，以失败回归、代码审查和生产复测证明结果。

**Architecture:** 主线程仍是唯一 writer。保留层限制单次删除与收缩工作，身份合并采用保守判据，维护操作在停服务和原子发布约束内执行；派生与 OTLP 巡查复用既有队列字段和映射规则。

**Tech Stack:** TypeScript、Bun、bun:sqlite、现有 SQLite WAL 与触发器，无新依赖。

**Spec:** [缺陷提交复核](../../../.agents/notes/proposed/bug-fix/2026-11-04-open-bug-findings.md#2026-11-05-提交复核)。

## 约束

- 所有回归数据由测试构造，不复制生产正文、账号、令牌、盐或用户配置。
- 代码在 `fix/confirmed-*` worktree 中实现，主检出保留生产代码。
- 写事务不含 await；异步批间可以让出，每次同步工作仍需单独量测。
- 不给历史成本表新增 TTL，不调高磁盘上限，不给未知 actor 伪造身份。
- 生产服务只走 `bun run service stop|start|restart`；维护写入先预览、停服和备份。
- F18/F19 保持暂缓；F07 已有其他在途 worktree，不覆盖其未提交改动。

## Task 1: 保留层与磁盘目标

**Files:** `src/retention.ts`、相关 retention/capacity 测试、独立 bug-fix note；主 Agent 核对 `src/main.ts` timer 调用，缺省接口兼容，无需修改。

**Interfaces:** 保留 `evictOldestBodyBatch` 的事务原子性。代际 raw 只删不可达或封口超期数据，仍活跃的追加代际不按逐行年龄删除。

- [x] 写失败回归，证明单代际大量行删除不受 limit 限制、磁盘压力下正文低于预算仍连续淘汰。
- [x] 对候选准备和单事务删除设置真实上限；把物理收缩限制为每轮有限工作。
- [x] 用独立磁盘回收目标替代正文停止条件，验证不可回收占用下不会持续清空正文；主审补测正文预算独立执行。
- [x] 跑窄测试和 typecheck，主 Agent 审查调用方、WAL 与大载荷下最慢同步操作。

## Task 2: 身份和正文一致性

**Files:** `src/owner.ts`、`src/merge.ts`、`src/maintenance/body-consistency.ts`、相关专用测试和 note；`src/hook.ts` 调用保持兼容。

**Interfaces:** `findRequestOwnerTx` 保持强标识优先；结束时间规则不回退到弱开始窗。维护函数默认只预览，由 `src/maintenance/cli.ts` 调用停止服务和维护锁入口后才应用。

- [x] 用合成数据证明无结束时间、唯一候选且模型不同会错并；证明搬正文漏字段和具体不可恢复 pending 形态。
- [x] 收紧弱模型分支，搬运正文同时保持元数据，提供范围明确的历史预览与修正。
- [x] 主 Agent 接线 CLI，验证默认不写、在线应用拒绝、事务失败回滚和重复应用幂等。
- [x] 运行身份、合并、hook 与维护窄测试，核查强标识与模型别名无回归。

## Task 3: 维护冲突与恢复

**Files:** `src/maintenance/response-ids.ts`、`src/maintenance/backup.ts`、maintenance 测试和 note。

**Interfaces:** 规范化在任何写入前拒绝冲突；恢复先在 staging 内验证迁移和关键表，成功才发布。DB-only 备份的成功和可恢复性仍分别表达。

- [x] 合成冲突 ID 回归先失败；修复后整批拒绝且数据库不变。
- [x] 构造真实旧 schema，验证恢复后可被当前代码打开；不是给当前结构改版本号。
- [x] 构造迁移失败包，确认恢复目标不存在、staging 清理、原包不变。
- [x] 验证盐绑定与 0600/0700 权限；整理白名单注释，不改变 DB-only 成功语义。

## Task 4: 派生公平性与 OTLP 统计

**Files:** `src/derive/unit.ts`、`src/sources/otlp/ingest.ts`、`scripts/patrol.ts` 和对应窄测试、note。

**Interfaces:** 失败组继续可诊断和重试，候选选择允许后续健康组执行。`AcceptOtlpTracesResult` 显式提供 skipped 计数，接收成功不伪报 rejectedSpans；巡查只对同一 raw 保留窗的物理 span 核对证据。

- [x] 用失败 a、健康 b/c 证明原调度会饥饿；修复后健康组完成，失败组仍 dirty 且错误可见。
- [x] 用内部 span、过期 raw 的旧证据、合法无正文来源验证旧产出比会误报。
- [x] 修正统计分母和生命周期，实际漏识别的 LLM span 仍应报警；映射规则只保留一个家。
- [x] 跑 derive、OTLP、patrol 窄测试和 typecheck。

## Task 5: 整合与生产验收

**Files:** `docs/architecture-design.md`、`docs/operations.md`、`docs/patrol.md`、`docs/acceptance.md`、缺陷清单、相关 note。

- [x] 主 Agent 审查每组失败证据、实现、异常和回滚路径；同步共享调用方和文档。
- [x] 整合后运行 typecheck、相关测试、note 门禁；串行运行必要的大载荷实验。
- [x] 记录生产只读基线；停服务并制作 bundle；预检、部署和启动均报告实际结果。
- [ ] 对预览的历史范围运行维护修复。自动审批拒绝 F09 的 671 条生产订正，命令未执行；F24 的 29,042 条回填也未执行，需具体范围授权后重新预览。
- [ ] 部署后真实页面交互复验。原浏览器 task space 消失，未完成；已另做 36 次真实 HTTP 采样，不能替代页面验收。
- [x] 记录接口延迟、事件循环、任务最长时间与巡查越界，不把残余问题记为已解决。
- [x] 回写缺陷状态、验收记录和必要教训，保留实现分支名，清理本轮工作树。

执行与生产结果见[验收记录](../../acceptance.md#开放缺陷生产部署真实流量2026-11-06)。F11 自然定时清理与 F39 真实磁盘触顶尚未覆盖；F37 的生产 LLM 证据缺口另留待归因。
