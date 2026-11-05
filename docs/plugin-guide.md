# Plugin 开发者指引

Tracery 的页面阅读能力由 Plugin 提供。核心负责取数、校验、转义、缓存、调度与失败隔离；Plugin 只把工具调用折叠成一种可读视图。这份指引写给想加阅读能力的社区开发者、提交内置 Parser 的贡献者，以及评审 Plugin 提案的维护者。

状态说明：第 1 到 4 节是今天可用的契约；第 5 节是本地包声明新 Feature 的完整形态，尚未实现。实现前字段还可能调整，调整会升 `PLUGIN_API`。

## 1. 概念分层

- **核心**：摄入、证据、派生、存储、读取调度、鉴权、保留、页面外壳。任何 Plugin 关闭都不能让这些事实消失。
- **Feature**：一类可解释的阅读能力，占一个页签槽位，有自己的读取契约与视图模型。Todo 是第一个。
- **Parser**：某家 Agent 的工具形状到 Feature 视图的适配。一个 Feature 可以有多个 Parser。
- **Plugin**：Feature 的登记项，给出 id、页签、Parser 与校验入口。内置 Plugin 登记在 `src/plugins/registry.ts`。
- **社区包**：本机目录里的 ESM 包。今天它只含 Parser；完整形态下可以声明新的 Feature。

术语边界以 [GLOSSARY](../GLOSSARY.md) 为准。Plugin 与 magpie 的请求薄 hook 是两回事，后者在 `integrations/magpie-hook/`。

## 2. 哪些能力适合做成 Plugin

### 2.1 七条准入判据

一条能力要进 Plugin，七条全过；缺一条就留在核心，或者先补核心能力再谈 Plugin。

1. **只读**：结果从已保存的事实算出，不写库、不改 schema、不改派生版本、不触发采集。
2. **独立读取契约**：输入能写成一个具名操作，输出是有界、可校验的视图模型；不依赖别的页签的内部状态。
3. **独立槽位**：能占一个页签或同等的注册槽位，关掉它不影响其他页签的基本事实。只在既有页签里多渲染一行或一张卡片的东西，是渲染细节，不是 Plugin。
4. **可整体关闭**：登记数组注入空值或清单删掉一项，能力整路消失，核心照常工作。
5. **核心持有信任**：取数、转义、缓存、并发、取消与外部输入校验在核心；Plugin 只交出数据，不拼 HTML、不发起网络请求、不读写数据库。
6. **不改核心语义**：不改变证据身份、轮次结算、actor 归属、正文回收、鉴权、计费与保留策略。
7. **可合成测试**：能用合成数据覆盖命中、相似但不命中、参数缺失、正文已回收与失败隔离，不依赖真实请求。

### 2.2 直接否决

出现下面任何一项，不做成 Plugin：

- 需要写库、改 schema 或派生算法。
- 需要改变证据身份、轮次结算、actor 归属、正文保留、鉴权或计费。
- 需要在页面执行任意 JavaScript 或插入 HTML 字符串。
- 需要访问数据库、文件系统或网络。
- 需要发请求、触发外部副作用或修改用户数据。
- 需要远程市场、自动更新或签名校验；首版只装本地可信包。

### 2.3 现有能力逐项结论

本机库 2026-11-05 的只读聚合只用于判断规模，数值随采集增长，不是契约。

| 能力 | 今天的位置 | 结论 | 理由 |
| --- | --- | --- | --- |
| Todo | 第五页签，四家 Parser | 适合，已落地 | 轮次作用域、独立读取契约、只读快照；本机 915 次调用、131 个会话 |
| Web 搜索 | 正文与工具结果里的搜索卡 | 下一个候选 | 查询与结果能组成有界列表，各家 Agent 的工具形状差异明显；本机约 425 次搜索调用 |
| Skill 调用 | 读数与工具页里的 chip | 暂不做 | 本机 535 次，但已在既有页签可见；单开页签只证明能搬，证明不了新能力 |
| Plan | 工具调用（ExitPlanMode 等） | 暂不做 | 本机仅 4 次，读取价值未证实；等 harness 稳定产出 plan 工具再评估 |
| Subagent | 轨迹与请求归属 | 核心能力，不做社区 Parser | 15,086 笔子代理请求；结构由请求身份、actor 分组、父子边与轮次结算构成，不是单家工具形状的折叠 |
| 会话汇总组 | 右栏整块替换 | 不做 | 没有独立页签槽位，优先于轮次态与请求态 |
| 工具配对页 | 请求作用域阅读态 | 不做 | 持有 `toolOrd`、`toolOwner`、`toolPage`，是阅读模式而不是页签 |
| 后台作业 | 会话级结算表 | 暂不做 | 已有独立读取契约，但只有 46 行；当前作为轨迹事件消费，没有独立槽位 |
| 上下文图、读数、正文、路由 | 核心证据 | 永远不做 | 关闭任何一项都会让页面缺基础事实 |
| 摄入适配器、derive、schema、鉴权、保留、计费 | 核心 | 永远不做 | 账本与信任边界 |

### 2.4 结论

现有四个页签里的内容不搬。Plugin 机制用于新增独立阅读能力，Todo 证明的是新能力可注册、可关闭，不是旧功能能搬家。

下一步先补 Feature 包契约，让本地包能声明新页签；第一个用来验证的 Feature 选 Web 搜索。搜索有清楚的读取契约（一轮里的查询与结果）、明确的 Agent 形状差异和独立槽位价值，比 Plan 与 Skill 更能证明完整形态。

## 3. 路径 A：内置 Parser（今天可用）

适用于给已登记的 Feature 补一家 Agent 的形状适配，代码进本仓库。

- 在 `src/plugins/<feature>/parsers/<agent>.ts` 新建文件，导出 Parser 对象。
- 在 `src/plugins/registry.ts` 对应 Feature 的 `parsers` 数组加一行，次序即尝试优先级。
- Parser 形状：

```ts
import type { TodoCall, TodoParser } from '../../types';
import type { TodoSnapshot } from '../dto';

export const acmeParser: TodoParser = {
  agent: 'acme',
  parse(call: TodoCall, previous: TodoSnapshot | null): TodoSnapshot | null {
    if (call.toolName !== 'acme_todo') return null; // 弃权
    // 全量快照型直接覆盖；增量命令型在 previous 上 apply。
    return { seq: (previous?.seq ?? 0) + 1, items: [] };
  },
};
```

规则：

- 只 import `src/plugins/` 内的模块；不 fetch、不拼 HTML、不读 DOM。`tests/plugin-boundaries.test.ts` 用 AST 守这条。
- 弃权返回 `null`，让下一个 Parser 或下一次调用继续。参数缺失、形状相似但不命中都返回 `null`。
- 不改 `previous`；返回新快照。
- 正文已回收时，核心不会调用 Parser；Parser 不需要猜空列表。
- 新增文案进 `web/i18n-en.js`，`tests/i18n-coverage.test.ts` 会检查。

测试至少覆盖四类：命中、形状相似但不命中、参数缺失、正文已回收。提交前跑 `bun run typecheck`、该 Feature 的最窄测试、`bun run verify:notes:staged`。

## 4. 路径 B：本地 Parser 包（今天可用）

适用于不想改仓库、只在本机试用的一家 Agent 适配。

目录与清单在数据目录下。macOS 的数据目录是 `~/Library/Application Support/tracery`，其他平台是 `${XDG_DATA_HOME:-~/.local/share}/tracery`。清单是 `plugins/plugins.json`：

```json
{
  "plugins": [
    { "id": "todo", "api": 1, "agent": "acme", "entry": "acme-todo/index.ts" }
  ]
}
```

- `id` 必须是核心已登记的 Feature；今天只有 `todo`。
- `agent` 是采集器写在该 Agent 请求上的值。包按 agent 认领；同 agent 的内置 Parser 让位，避免两套状态机互相覆盖。多家包认领同一 agent 时以清单靠前的一项为准。
- `entry` 相对插件根解析，不能越出根目录；文件必须存在。
- `api` 必须等于 `PLUGIN_API`，今天为 `1`。不匹配的包在 import 之前被拒收。
- 安装与卸载都是改清单加重启采集器，没有热重载。命令与拒绝码见[运维手册](operations.md#本地插件包)。

包是一个 ESM 文件，导出 `parsers`：

```ts
export const parsers = [{
  agent: 'acme',
  parse(call: { toolName: string; input: unknown },
    previous: { seq: number; items: { content: string; status: string }[] } | null) {
    if (call.toolName !== 'acme_todo') return null;
    return { seq: (previous?.seq ?? 0) + 1, items: [] };
  },
}];
```

执行与失败隔离：

- 包在独立 Bun Worker 里执行，首次读取时才 import，不在启动时执行。
- 一个包的一批调用只该是内存操作；超过 1.5 秒视为卡住，线程被 terminate，该包在本进程内记死，不再重试。
- 包内抛错、超时或交回畸形视图时，该轮返回 `failed`，页签显示「读取失败」，其余页签照常工作。
- 线程消息只回固定分类码，包内异常文本不外传。重启采集器后恢复。
- 包不 import 仓库内模块，也不 fetch；只使用运行时与自己的文件。核心无法在运行时阻止绝对路径 import 或网络调用，这条靠评审与只装可信代码守住。
- 包只拿到工具调用参数，不拿到数据库句柄。

安全边界要说清：Bun Worker 与采集器同进程，外部代码拥有宿主权限。Worker 隔离的是崩溃与超时，不是文件与网络权限。只装可信代码；不要安装来路不明的包。

## 5. 完整形态：本地 Feature 包（规划中，尚未实现）

这一节定义本地包声明新 Feature 的目标契约。它不是今天可用的功能；实现顺序与验收条件见 [Plugin 准入边界与本地 Feature 包契约](../.agents/notes/proposed/architecture/2026-11-05-plugin-admission-and-feature-package-api.md)。

目标：社区开发者不改核心代码，也不用在页面执行脚本，就能让一个新的只读阅读能力出现在右栏。核心仍然负责取数、校验、转义、缓存、并发与失败隔离。

### 5.1 清单

```json
{
  "plugins": [
    {
      "api": 2,
      "id": "acme-search",
      "entry": "acme-search/index.ts",
      "feature": { "id": "search", "label": "搜索", "scope": "turn" }
    }
  ]
}
```

- `api: 2` 表示 Feature 包；`api: 1` 的 Parser 包继续可用。
- 包 id 与 Feature id 都做命名空间校验。页面上的页签 key 是 `plugin:<package>:<feature>`，不会和核心页签冲突。
- `label` 是纯文本，核心转义后显示；长度上限由校验器固定。
- `scope` 只支持 `request` 与 `turn`。`request` 页签跟随当前请求，切换时清轮次；`turn` 页签跟随已结算轮，行为与 Todo 一致。会话级槽位不在首版。
- 清单次序即页签次序。重复的包 id 或页签 key 拒收后者；坏包不挡住其他包与核心启动。
- 页签元数据只来自清单，读取 `/api/plugins` 时不执行包代码。

### 5.2 模块形状

包导出 `feature`：

```ts
export const feature = {
  id: 'search',
  read(input: PluginReadInput): PluginView | null {
    const rows = input.calls
      .filter(call => call.toolName === 'acme_search')
      .map(call => ({ content: String(call.input?.query ?? '') }));
    return { kind: 'list', sections: [{ rows }] };
  },
};
```

- `id` 必须与清单里的 Feature 一致。
- 下面这些类型是契约说明；包不 import 核心模块，自己按字段读写，核心在主线程校验。
- `read` 每次读取调用一次，拿到该作用域的全部事实，按需在内部按序处理；核心不保存上一次读取的视图。
- 返回 `null` 表示这个身份下没有内容，页面显示「没有内容」；返回 `{ kind: 'empty', text }` 表示读取成功但列表为空。
- `read` 可以返回 Promise。抛错、超时或返回畸形视图都按 `failed` 处理。
- 包可以在模块里缓存解析器或常量，但不能依赖跨读取的模块状态；采集器重启后模块会重新 import。

### 5.3 读取输入

核心按作用域收集事实，装进一个可序列化信封：

```ts
type PluginReadInput = {
  feature: string;
  scope: 'request' | 'turn';
  key: string;
  actor: string;
  turn: number | null;
  requests: PluginRequestFact[];
  calls: PluginCallFact[];
};

type PluginRequestFact = {
  reqId: number;
  agent: string;
  startedMs: number;
};

type PluginCallFact = {
  reqId: number;
  ord: number;
  agent: string;
  toolName: string;
  input: unknown;
  resultText: string | null;
};
```

- `request` 作用域：只装当前请求的调用。
- `turn` 作用域：用与 Todo 相同的轮次结算与主链 actor，装入该轮内该 actor 的请求，按 `startedMs` 与 `ord` 排序。
- `input` 是 tool_use 的原始参数。`resultText` 是脱敏后的有界结果摘录；正文已回收或结果不可读时为 `null`。
- 核心截断超限事实，并在 `PluginReading` 上给出 `truncated`；包必须能处理空数组、`null` 与截断。
- 包不拿数据库、文件、网络或页面环境；需要别的数据，说明这个 Feature 还没到能做 Plugin 的条件。

### 5.4 视图模型

视图模型是封闭集合，核心按 `kind` 渲染，包不产出 HTML：

```ts
type PluginView =
  | { kind: 'list'; sections: { title?: string; rows: PluginRow[] }[] }
  | { kind: 'tree'; roots: PluginNode[] }
  | { kind: 'facts'; items: { label: string; value: string }[] }
  | { kind: 'empty'; text?: string };

type PluginRow = { status?: string; content: string; detail?: string };
type PluginNode = { label: string; detail?: string; children?: PluginNode[] };
```

上限先按下面执行，实现时由校验器固定：分区 20、每区行 200、总行 500、树节点 500、深度 8、单字符串 2000 字符、序列化视图 256 KiB。超限或字段类型不匹配时整次读取按 `failed` 处理，不截断成看似成功的结果。

所有字符串由核心转义后插入页面。模型里没有 URL、HTML、函数或可执行片段；需要链接时先不加，等有明确的同源链接白名单再说。

### 5.5 页签与选择

- 核心页签在前，Plugin 页签按清单次序排在后面；页签行复用现有 `web/rail-tabs.js` 的登记形状，数据来自启动时的清单元数据。
- `request` 页签点开时保留当前请求，和读数、正文、工具、路由四栏一样清掉轮次态。
- `turn` 页签点开时保留当前轮次，和待办一样；没有选中轮时显示选轮提示。
- URL 的 `tab` 参数使用命名空间 key；未知 key 回退到 `facts`。
- 包加载失败时它的页签不出现；读取失败时该页签显示「读取失败」，其他页签不受影响。
- 页签标签是纯文本；图标、配色和自定义布局不在首版。

### 5.6 Worker 生命周期

- 一个采集器进程一个 Worker，全部包共用，FIFO 单飞；队列满时排队，不直接拒绝读请求。
- 包在第一次读取时按绝对路径 import，之后按路径缓存模块。
- 每次读取有 1.5 秒超时；超时、线程崩溃或包内抛错都 terminate，当前包记死，队列里的下一个任务换新线程继续。
- 迟到回复按任务 id 丢弃，不写回。
- 关闭进程时拒绝在飞与排队任务。
- 错误只回固定分类码；包内异常文本、路径与数据不出线程。

### 5.7 读取契约与客户端

完整形态仍按[读取功能接入规则](read-feature-rules.md)接入，不为 Plugin 另开旁路：

- `src/read-contract.ts` 增加一个具名操作 `pluginRead`，输入是 Feature key、作用域与身份，输出是 `PluginReading`。状态用 `ready`、`absent`、`unavailable`、`failed` 四值，另带 `truncated` 标志；失败不写成空成功。
- HTTP 路由按作用域分开：请求级走 `/api/requests/:id/plugin/:feature`，轮次级走 `/api/sessions/:key/plugin/:feature`。路径拼接、HTTP 状态与响应解析只归 `web/read-http.js`。
- 并发、取消与公平性归 `web/read-scheduler.js`；证据缓存归 `web/reader-store.js`，缓存键包含包路径、Feature id、作用域身份与 `PLUGIN_API`。
- 客户端新增 `web/plugin-tab.js` 渲染封闭视图模型，登记进 `src/http.ts` 的 `STATIC_FILES`；`tests/read-boundaries.test.ts` 与 `tests/http.test.ts` 双向守门。
- 页签元数据由 `/api/plugins` 提供；客户端启动时取一次，失败时只显示核心页签。

### 5.8 版本与兼容

- `PLUGIN_API = 1` 是 Parser 包；`PLUGIN_API = 2` 是 Feature 包。两套清单条目可以并存。
- 事实信封、视图模型或页签语义的破坏性变化升版本；不匹配的包在 import 前拒收。
- 包 id、Feature id 与页签 key 一旦发布不再改名；改名按新 id 发布。
- v1 在 v2 落地后至少保留一个大版本，不做静默迁移。
- 文档与 `PLUGIN_API` 同步改；README 只链接本指引，不复制字段表。

### 5.9 测试与验收

合成测试至少覆盖：

- 清单：缺失目录、坏 JSON、api 不符、重复包 id、重复 Feature id、entry 越出根目录、文件缺失、label 超长。
- 读取：请求作用域与轮次作用域各一条正常路径；空事实、正文回收、结果截断各一条。
- 视图：四种 `kind` 各一条；未知 kind、超限、错误类型各一条，全部落 `failed`。
- 失败隔离：包内抛错、死循环超时、迟到回复、线程崩溃后下一个包继续。
- 页面：页签注册、URL 往返、请求态与轮次态切换、未知 key 回退、失败只影响本页签。
- 边界：客户端不直接 fetch，调度与缓存不旁路，插件文本全部转义。

真实流量验收单独记录；合成验收不写成真实流量通过。

### 5.10 提案模板

新 Feature 先提提案，核心评审后再决定是否给槽位与读取契约。提案写清：

```markdown
## Feature proposal
- Name / id:
- Scope: request | turn
- What question does it answer:
- Data needed (tool names, result excerpts, metadata):
- View model kind: list | tree | facts | empty
- Agents and tool shapes:
- Empty, unavailable and failed states:
- Why not an existing tab or a new core view:
- Synthetic examples:
```

社区包声明新 Feature 需要等 v2 落地。落地前，新 Feature 走提案，由核心先落页签槽位、读取契约与视图校验，Parser 可以由社区按第 3、4 节提交。

### 5.11 实现顺序

1. 清单 v2 与 `/api/plugins` 页签元数据。
2. `pluginRead` 具名操作、事实收集与视图校验。
3. `web/plugin-tab.js` 渲染器与动态页签。
4. Worker 协议从 Todo 折叠泛化成 `read`。
5. 合成测试、边界测试与文档同步。
6. 用 Web 搜索做第一个内部 Feature，验证完整链路后再开放本地 Feature 包。

## 6. 提案与评审

社区开发者想加新想法，按下面顺序走：

1. 先判断是不是新 Feature。只是某家 Agent 的形状适配，走第 3 或第 4 节；要新页签、新读取契约，才走 Feature 提案。
2. 用 5.10 的模板提提案，附合成数据形状与预期视图。不要在提案里附真实请求正文、账号或令牌。
3. 维护者按 2.1 的七条判据评审。任何一条不过，回到核心能力或放弃。
4. 通过后先落核心侧：页签槽位、读取契约、视图校验、失败状态与测试。Parser 可以后补。
5. v2 落地后，本地 Feature 包按第 5 节接入；在那之前，Feature 代码进核心仓库。

评审否决的典型理由：只搬现有页签、没有独立读取契约、需要写库或改派生、需要页面脚本或网络、无法合成测试、失败会拖垮其他页签。

## 7. 常见失败与排查

- **包没加载**：看启动日志的 `plugins.load` 与分类码。`plugin_manifest_invalid` 是清单形状坏了；`plugin_api_mismatch` 是 `api` 不匹配；`plugin_unknown_id` 是 v1 的 `id` 未登记；`plugin_entry_outside_root` 是路径越界；`plugin_entry_missing` 是文件不存在。
- **页签显示读取失败**：包超时、抛错或视图畸形。`plugins.runtime` 会记固定码；该包在本进程内已记死，改代码后重启采集器。
- **页签没有出现**：清单没有合法包，或包被拒收。检查清单路径、`api`、`entry` 与重启。
- **与内置 Parser 抢同一 Agent**：v1 按 agent 认领，清单靠前的包生效，内置 Parser 让位；不要同时装两个认领同一 Agent 的包。
- **正文已回收**：读取返回 `unavailable`，页面显示「正文已回收，待办不可读」这类文案；不要把它当成空列表。
- **版本不匹配**：升级 `PLUGIN_API` 后旧包全部拒收；按新契约改包，不要改清单绕过。

## 8. 参考

- [领域术语表](../GLOSSARY.md)
- [架构设计](architecture-design.md)
- [读取功能接入规则](read-feature-rules.md)
- [运维手册的本地插件包](operations.md#本地插件包)
- [Plugin 登记层与 Todo 页签](../.agents/notes/implemented/architecture/2026-11-05-plugin-registry-and-todo-tab.md)
- [社区轨的本地包加载与 Worker 隔离](../.agents/notes/implemented/architecture/2026-11-05-community-plugin-worker.md)
- [Plugin 准入边界与本地 Feature 包契约](../.agents/notes/proposed/architecture/2026-11-05-plugin-admission-and-feature-package-api.md)
- [参与贡献](../CONTRIBUTING.md)