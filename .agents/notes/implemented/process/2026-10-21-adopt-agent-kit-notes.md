# Agent Note: 接入 agent-kit 的 Agent Notes 体系

Status: implemented

## Problem

ATC 第一版完成后，决策依据散在 README、架构设计、评审记录与四份实施计划里。文档开始出现漂移：`docs/README.md` 还写着「采集与查询后端尚未实现」，README 开头还停在「已落地的是存储基座」，而代码已经完成 A1–A5、B1–B5 与 C1。没有统一的决策记录，后续 agent 只能从长文档里重建「为什么这样定、否决了什么」，容易把已否决的方案重新提出来。

## Decision

采用 agent-kit M1 的 Agent Notes 体系。`.agents/notes/` 按生命周期与分类存放决策记录；`scripts/verify-agent-note-format.mjs` 与 `scripts/verify-archived-agent-notes.mjs` 机械检查格式与归档封印；根 `AGENTS.md` 规定常备规则，`docs/AGENTS.md` 规定文档分层。闸门接在 `package.json` 的 `verify:notes`，提交前由根 `AGENTS.md` 要求执行，不装本地 git hook。`.agents/KIT-VERSION` 记录安装基线；kit 升级时逐文件对比 `LINEAGE.md` 后重新覆盖规则文件与闸门。

首批 note 回填有真实替代方案的决策：语义指纹与祖先前缀、schema v3 拒绝原地升级、容量三门槛、维护锁与备份探测、隐私与本地访问边界。事实仍以 [docs/architecture-design.md](../../../../docs/architecture-design.md) 与 [docs/operations.md](../../../../docs/operations.md) 为权威，note 只记录 rationale、被否决的方案与代价。

## Alternatives considered

**继续用 README 与架构文档承载所有决策。** 长文档会把现状、历史与 rationale 混在一处，已经出现过期状态；没有机械检查，漂移只能靠人发现。

**引入完整的 M2 技能与 i18n 契约。** kit 目前只有 M1，`ak-` 技能与文档闸门尚未移植；现在引入会把未完成的东西带进项目。

**把四份实施计划改写成 note。** 计划是执行 artifact，带步骤与验收清单；note 记录耐久决策。重写四份长文档会丢失执行上下文，也会把 spec 语体带进 note。

**直接装 pre-push 钩子。** 项目没有 CI，单人开发；钩子配置不进仓库，换机器要重设，收益低于 `package.json` 加根规则。

## Consequences

- 非平凡变更多了一篇 note 的成本；收窄范围后，纯机械与局部编辑豁免，bug-fix note 可以写短。
- 闸门只覆盖 note，不覆盖文档链接与排版；M2 的 `verify-md-links`、`verify-md-wrap` 尚未安装。
- 首批 note 的 Decision 链接到架构文档与运维手册；schema 或流程变更时先改事实权威，再检查 note 的引用是否还有效。
- README 的验收记录与变更史尚未迁移，作为已知例外留在原地；迁移是独立变更。
- kit 升级是显式动作，不会自动跟随；`.agents/KIT-VERSION` 是唯一的基线。

## Related

- [语义指纹与任意祖先共同前缀](../architecture/2026-10-20-semantic-fingerprint-and-ancestor-predecessor.md)
- [schema v3 拒绝原地升级，回填走独立脚本](../architecture/2026-10-20-schema-v3-rejects-in-place-upgrade.md)
- [容量三门槛与正文回收](../architecture/2026-10-20-retention-three-gates.md)
- [维护锁与备份的独占探测](./2026-10-20-maintenance-lock-and-backup-probe.md)
- [隐私边界与本地接口防护](../architecture/2026-10-20-privacy-and-local-access-boundary.md)
