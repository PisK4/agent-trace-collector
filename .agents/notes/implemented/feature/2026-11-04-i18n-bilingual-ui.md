# Agent Note: 界面中英双语（i18n）

Status: implemented

## Problem

界面文案只有中文。英文使用者打开 Tracery 读到的是纯中文 chrome；而轨迹正文本身中英混杂，界面语言写死造成阅读断差。文案总量约 580 条（分布 21 个 web 模块），全部在客户端；服务端只发静态 `index.html` 与 JSON。文案与数据边界清楚：正文、工具名、模型名、路径是数据，不翻译；翻译面只有 UI chrome。

## Decision

- **翻译单元以中文原文为 key**：模块里写 `t('正文未到')`，`web/i18n-en.js` 做 zh→en 映射。缺 key 回退原文，zh 侧不需要字典文件，默认语言下现有中文测试断言原样通过。改中文文案必须同步改字典 key——覆盖闸门按「t() 直接 key 或字典 key」放行，key 改了字典没改会在 en 侧回退中文（可观察、不崩）。
- **`web/i18n.js`** 持有语言状态与 `t(key, params)`：`{name}` 占位替换，params 语义与模板插值一致（null 输出 'null'）；字典值允许是函数（英文单复数与词序重排），不做 HTML 转义，转义归调用点的 esc。不引依赖。
- **语言偏好** `localStorage('tc.lang')`，缺省跟随 `navigator.language`；顶栏切换钮（theme 旁 icon-btn）图形用目标语言自称（EN/中文），title/aria 走 t。切换即时生效：静态 chrome 改写、`resetReading()` 清投影与准备结论缓存（步骤短语存着上一语言的文案，必须重投影）、`renderAll()` 全量重绘，不整页 reload。
- **静态 `index.html` 文案**在 boot 与每次切换由 `applyStaticTexts()` 按当前语言改写；`<html lang>` 随动为 `zh-CN`/`en`。选择器带 `.pulse` 防止误改渲染出来的同款空态段。
- **服务端零改动协商**：只加 `/i18n.js` 与 `/i18n-en.js` 两条静态路由。两处服务端中文数据在客户端翻译：`EXEC_MS_HINT` 常量在使用点包 t；prompt reading 的 `note`（readings.ts 三条已知中文句）在使用点包 t，未知值回退中文——服务端不进字典业务。
- **日期格式化**随当前语言（`zh-CN`/`en-US`），说明短句列表的分隔符（`；`/`; `）与成员列表 join 同样随语言。
- **覆盖闸门**（`tests/i18n-coverage.test.ts`）：web 模块里中文引号字符串必须是 t() 直接 key、en 字典 key（key-map 经 t 间接消费）或白名单（语言钮的目标语言自称）。反引号模板不扫描——模板内中文要么是 t 的 key 要么是插值组合，行级静态分析分不清，写在测试头注。
- **英文定名**以 [GLOSSARY](../../../../GLOSSARY.md)「界面英文定名」节为准（callback、totals/summary、reasoning、attribution、index、fragment 六项是本次拍板）；英文文案遵守与中文相同的落笔风格。
- 叶子模块（tool-summary、row-summary、body-model）引入 i18n 是记录在头的唯一例外：纯数据映射，无 DOM。

## Alternatives considered

- **key 用英文标识符 + zh/en 两份字典**：多一层查表，580 条 key 命名是纯新增负担，且 zh 断言全部要改。中文原文为 key 让 zh 侧零字典、零断言改动。
- **语言切换整页 reload**：实现最短，但丢选中、滚动与折叠状态；renderAll 是现成的全量重绘入口。
- **引 i18n 库（ICU/plural-rules）**：需要的能力只有占位替换与单复数函数，40 行内自足；这里没有真轮子。
- **服务端 Accept-Language + 双份页面**：单机工具，偏好存客户端足够；服务端渲染不存在，协商没有落点。
- **翻译服务端 note 字符串**（改 readings.ts 输出英文）：note 是入库数据，改输出要动派生与存量行的对应关系；客户端按已知值定名代价最小。

## Consequences

- 缺 key 的渐进交付成立：没抽到的界面显示中文，不会显示 key 名或 undefined。
- 改中文文案是 breaking key 变更：必须同步 `i18n-en.js`，en 侧漏改表现为该句回退中文。
- 反引号模板绕过闸门的边界留着：新增模板文案靠走查兜底。
- web 改动合入即对生产生效（页面现读）；`src/http.ts` 加了静态路由，需要 `bun run service restart`。
- 切语言会触发一次重投影与全量重绘，重绘期间在途读取不变；切换偏好进 localStorage，跟随浏览器语言只是缺省。

## Testing

- `tests/i18n.test.ts`：t() 的 zh 恒等、en 查表与回退、占位替换、字典函数值单复数、htmlLang。
- `tests/i18n-coverage.test.ts`：覆盖闸门，逐文件断言无绕过 t() 的中文文案。
- 全量 `bun test`（1163 例）与 `bun run typecheck` 通过；默认语言 zh 下既有前端断言未改一个字。
- 浏览器双语走查（8399 临时实例，合成会话 + 真实上游采集）：zh→en→zh 往返、`<html lang>`、持久化、chrome 全翻、数据不翻、三栏布局无破碎；截图目视核对。走查抓出并修复四处：复制钮缺词条、「已是最新记录」key 前导空格错位、服务端 prompt note 未翻、说明句 `；` 分隔符未随语言。
