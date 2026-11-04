# Plugin 机制首版实施计划

日期：2026-11-04。决策依据见 [页面 Plugin 机制与首个 Todo 插件](../../../.agents/notes/proposed/architecture/2026-11-04-plugin-system-and-todo-feature.md)。方案评审稿在 `.archify/plugin-todo-review-20261104-210000/plugin-todo-review.html`，不进仓库。

实现走仓库上级目录 `.codex-worktrees/atc-plugin-system` 的 `feat/plugin-system` 分支。文档与 Agent Note 留在主检出，合并前不动主检出的 `src/` 与 `web/`。

## 步骤

### 0. 收口社区轨范围

2026-11-05 拍板，结论写进 Agent Note 的「社区轨首版范围」：

- [x] 外部代码加载形态：Bun Worker，复用 `src/derive/worker.ts:51` 的 `new Worker(ENTRY)`。超时与崩溃用 terminate 隔离，社区包出错只隐藏该页签、其余四栏照常工作。Worker 与采集器同进程，外部代码拥有宿主权限，安装入口写清只装可信代码。
- [x] 首版市场范围：只装本地包。用户把可信包放进本机目录，清单登记，`api` 字段比对后不兼容就拒绝加载，内置轨照常工作。不联网、不做自动更新、签名校验与安装失败回滚。

`src/plugins/runtime/` 首版就写，承载 Worker host 与消息协议；`market.ts` 不写，本地包清单加载器另起名。

### 1. 目录改名

- [ ] `plugins/collector.hooks.ts` 移到 `integrations/magpie-hook/collector.hooks.ts`
- [ ] `tests/hook.test.ts` 两处 import 改路径
- [ ] `tsconfig.json:13` 的 include 加 `integrations/**/*.ts`
- [ ] `scripts/verify-change-notes.mjs:20` 的 `TRIGGER_PREFIXES` 同步
- [ ] `scripts/service.ts:34`、`docs/operations.md:470` 的路径注释
- [ ] `README.md:36`、`README.zh-CN.md:36`、根 `AGENTS.md:50`
- [ ] implemented note 里 3 处 `plugins/collector.hooks.ts` 相对链接、2 处目录描述改为新路径，只改事实
- [ ] 生产 `~/.config/magpie/plugins.json` 第 37 行 spec 改新绝对路径，重启 magpie 宿主
- [ ] `bun run typecheck`、`tests/hook.test.ts`、`bun run verify:notes:staged`

### 2. 登记层与边界

- [ ] `src/plugins/registry.ts` 写一份静态登记数组：插件 id、页签槽位、Parser、DTO 校验入口、是否启用
- [ ] 登记次序即页签次序；分派与结算不写品牌分支，沿用 `src/harness/purpose.ts` 的形状
- [ ] `tests/plugin-boundaries.test.ts` AST 检查 Parser 不 import 核心、不 fetch、不产出 HTML
- [ ] 插件返回畸形 DTO 时核心不崩，只隐藏该页签内容

### 3. 读取契约与查询

- [ ] 按 [读取功能接入规则](../../read-feature-rules.md) 先核对 `todoByTurn` 的输入、返回事实与一致性要求，再定走新 HTTP 路由还是复用批端点
- [ ] `src/read-contract.ts` 加 `todoByTurn` 一项
- [ ] `src/queries/todo-by-turn.ts` 按会话、actor 与轮号查 `tool_call` 与 `request_block` 的 tool_use 参数
- [ ] `web/read-http.js`、`web/reader-store.js` 按 `bgJobs` 模板接入具名读取
- [ ] 迟到响应不写回：切会话后旧会话结果不污染新会话
- [ ] 新增前端文件登记进 `src/http.ts` 的 `STATIC_FILES`，`tests/read-boundaries.test.ts` 与 `tests/http.test.ts` 双向覆盖

### 4. 页面注册能力

- [ ] `web/rail-tabs.js` 把五处页签硬编码收成一份登记数组
- [ ] 页签行上提到 `state.turn !== null` 的分岔之前，请求态与轮次态都能点第五栏
- [ ] `web/app.js` / `web/url-route.js` / `web/selection.js` 改消费登记数组，`TAB_ORDER` 与滚动保持键同步
- [ ] `web/todo-tab.js` 只渲染 DTO，全部文本经过 `esc()`
- [ ] `web/i18n.js` 与 `web/i18n-en.js` 同步，正常态不加装饰性说明文字
- [ ] 合成页面验证四栏在轮次态不误读请求作用域

### 5. 第一批 Parser：全量快照

- [ ] zcode `TodoWrite` Parser，覆盖 194 次未配对 `pending`
- [ ] droid `TodoWrite` Parser，`todos` 是 JSON 字符串
- [ ] 一轮内多次更新先 apply 完再显示，回退轮号能还原
- [ ] 合成数据覆盖命中、形状相似但不命中、参数缺失、正文已回收四类反例

### 6. 社区轨

- [ ] 按步骤 0 的结论写清单加载、`api` 协商、失败隔离、安装与卸载
- [ ] `api` 不兼容时拒绝加载，内置轨照常工作
- [ ] 社区包超时或抛错时只隐藏该页签内容，其余四栏不受影响
- [ ] 安装入口写清外部代码拥有宿主权限，只装可信代码

### 7. 第二批 Parser：增量命令

- [ ] pi `todo` Parser
- [ ] omp `todo` Parser
- [ ] 重放状态机按序 apply，跨 actor 不互相关闭
- [ ] 6 个跨 actor 会话的合成对账

### 8. 收尾

- [ ] `CONTRIBUTING.md` 加内置 Parser 与社区包两套 PR 模板，`GLOSSARY.md` 与双 README 各归各家
- [ ] `bun run typecheck`、最窄测试、`bun run verify:notes:staged`
- [ ] 合成验收与真实流量验收分开写进 `docs/acceptance.md`
- [ ] `git merge --no-ff feat/plugin-system`，合并后移除 worktree 目录，分支名保留
- [ ] 改动触及 `src/` 时 `bun run service restart`

## 首批 Plugin 与旧功能搬迁

| 概念 | 首版数量 | 内容 |
| --- | --- | --- |
| Feature | 1 | Todo |
| Parser | 4 | zcode、droid、pi、omp |
| Agent | 4 家 | 125 个含 Todo 会话，2026-11-04 复核口径 |

Todo 跑通之前不立第二个 Plugin。Plan、Subagent、Skill 调用只排序，不开工。

旧功能是否搬迁按三条判据：能整体隐藏而核心照常工作；有独立读取契约与 DTO；有独立页签槽位或能明确划出一个。只在既有页签里多渲染一种行或卡片的留在原模块。摄入、derive、schema、三路证据收敛、HTTP 身份认证、读取架构的调度与缓存留在核心。

会话汇总组清单是最像插件的一处，仍不首版搬迁：`web/app.js:1409` 的 `summaryList` 把右栏整块替换，优先于轮次态与请求态，没有独立页签槽位。工具往返配对页 `web/trace-pair.js:19-179` 自包含，但仍持有 `toolOrd` / `toolOwner` / `toolPage` 状态，要搬得先改宿主状态模型。两者留到 Todo 闭环之后单独评估。

`src/harness/purpose.ts:35-44` 的 `PURPOSE_RULES` 与 `src/sources/session/registry.ts:22-31` 的 `SESSION_ADAPTERS` 是现成范式：生产数组加注入数组共用同一编排，前者有 `tests/harness-purpose.test.ts` 的注入式测试 seam，后者注入空数组即可整路关闭。Plugin 登记数组照这个形状写，两个模块本身分别属于 derive 期与摄入期，原地保留。

## 验收口径

| 类型 | 做法 |
| --- | --- |
| 合成验收 | 四家 Parser 反例、轮次递增与回退、跨 actor 对账、畸形 DTO、迟到响应、页签行两种阅读态 |
| 真实流量验收 | 目录改名后 hook 不丢请求、生产 `plugins.json` 生效、第五页签能读到真实 Todo |
| 报告 | 两类分开写；未跑的检查不写成通过 |
