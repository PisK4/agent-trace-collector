# Agent Note: 界面中英双语（i18n）

Status: proposed

## Problem

界面文案只有中文。英文使用者打开 Tracery 读到的是纯中文 chrome;而轨迹正文本身中英混杂,界面语言写死造成阅读断差。后续若把页面分享给非中文读者,或接入英文语境的工作流,没有切换路径。

文案总量约 580 条(分布 21 个 web 模块),全部在客户端;服务端只发静态 `index.html` 与 JSON,没有服务端模板。文案与数据边界清楚:正文、工具名、模型名、路径是数据,不翻译;翻译面只有 UI chrome。

## Proposal

- **翻译单元以中文原文为 key**:模块里写 `t('正文未到')`,`web/i18n-en.js` 做 zh→en 映射。缺 key 自然回退中文,按文件分批抽取可渐进交付;zh 侧不需要字典文件,现有测试的中文断言在默认语言下原样通过。
- **`web/i18n.js`** 持有语言状态与 `t(key, params)`:`{name}` 占位替换;en 字典值允许是函数(处理英文单复数),其余为字符串。不引依赖。
- **语言偏好**:`localStorage('tc.lang')`,缺省跟随 `navigator.language`(zh 开头→zh,否则 en);顶栏在 theme-toggle 旁加一个 icon-btn 文字钮(中文界面显「EN」,英文界面显「中」),点击切换。切换即时生效:静态 chrome 换文案,`renderAll()` 全量重绘,不整页 reload。
- **静态 `index.html` 的十余条文案**在 boot 时由 JS 按 t() 改写;`<html lang>` 随语言更新为 `zh-CN`/`en`。
- **日期格式化**:`session-view.js` 三处硬编码 `zh-CN`/`en-US` 的 `toLocale*` 改随当前语言。
- **服务端**:`src/http.ts` 的 STATIC_FILES 加 `/i18n.js` 与 `/i18n-en.js` 两条路由;其余不动,不做 Accept-Language 协商。
- **抽取按文件分批提交**:rail-facts → app.js → session-view/trace-view → body-view/trace-pair/turn-band/context-* → 其余小文件。每批跑该批最窄测试。
- **覆盖闸门**:全部抽取完成后加一条测试,扫描 `web/*.js` 里未经 t() 的中文引号字面量,白名单只留数据与注释误报;防止后续新文案绕过 i18n。

英文定名已定稿,见 [GLOSSARY](../../../../../repos/agent-trace-collector/GLOSSARY.md)「界面英文定名」节;英文文案遵守与中文相同的落笔风格(短句、陈述事实)。

## Alternatives considered

- **key 用英文标识符 + zh/en 两份字典**:查表中间层多一层,key 命名 580 条是纯新增负担,且 zh 断言全部要改成 key 断言。中文原文为 key 让 zh 侧零字典、零断言改动。
- **语言切换整页 reload**:实现最短,但丢选中、滚动与折叠状态;`renderAll()` 是现成的全量重绘入口,状态保留是既有行为,不额外付代价。
- **引 i18n 库(ICU/plural-rules)**:需要的能力只有占位替换与单复数函数,40 行内自足;按「不引第三方依赖」与 motion vendor 决策的口径,这里没有真轮子。
- **服务端 Accept-Language + 双份页面**:单机工具,偏好存客户端足够;服务端渲染不存在,协商没有落点。

## Acceptance criteria

- 同一页面在 zh/en 两语言下走查:会话列表、轨迹时间线、右栏四页签、上下文矩阵与明细、轮次带、空状态、降级标签无漏翻、无布局破碎;`<html lang>` 正确。
- 切换语言不整页刷新,选中请求与折叠状态保留。
- 缺 en key 的字符串显示中文,不显示 key 名或 undefined。
- 默认语言(zh)下,现有前端测试不改断言全部通过;`bun run typecheck` 通过。
- 覆盖闸门测试通过:web 模块无绕过 t() 的 UI 中文文案。

## Risks

- 抽取是约 580 处机械替换,错漏表现为「该翻的没翻」(回退中文,可接受)而非崩溃;风险集中在插值串改参数化时占位符写错,靠每批最窄测试与走查兜底。
- 英文文案拉长(中文短句译英文常变长),右栏读数条与会话折叠行等紧凑区域可能换行;验收时逐区域看,必要时按文案微调 CSS。
- `t()` 以中文为 key 意味着改中文文案必须同步改 en 字典 key——覆盖闸门抓不到「key 留旧文案」之外的漂移,note 与 GLOSSARY 已写明这个约定。
- 服务端新增两条静态路由,部署需要 `bun run service restart`;遗漏时 en 字典 404,语言切换后界面大范围回退中文(可观察、不损坏数据)。
