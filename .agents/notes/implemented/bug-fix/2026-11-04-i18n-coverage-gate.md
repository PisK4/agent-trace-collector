# Agent Note: i18n 覆盖闸门补字典成员与占位符校验

Status: implemented

## Problem

系统巡查（[F14](../../proposed/bug-fix/2026-11-04-open-bug-findings.md)）发现 i18n 覆盖闸门有个洞：`tests/i18n-coverage.test.ts` 对 `t()` 紧贴的字符串直接 `continue`，从不校验它是不是 en 字典成员——而[界面双语 note](../feature/2026-11-04-i18n-bilingual-ui.md) 的 Decision 本就要求「t() 直接 key、en 字典 key（key-map 经 t() 间接消费）或白名单」。洞的后果是实打实的：5 个 `t()` key 字典缺失（`轮次不可用`、`重新结算后这一轮不在列表里；点击轨迹任意行返回请求态。`、`{n} 次失败`、`首个文本`、`req {id}`），英文模式下 4 条可见文案回退中文；`req {id}` 回退后显示 `req 92718` 恰好仍可读，所以走查没抓到——这正是门禁该拦而非靠运气的地方。「占位符集合相等」的断言也不存在，key 里的 `{n}` 译丢了会原样显示给英文用户。

## Decision

- 5 个 key 补进 `web/i18n-en.js`，按 [GLOSSARY](../../../../GLOSSARY.md) 定名：`首个文本` 作 `First text`（与 `首 token` 行标签同款大写）；`轮次不可用` 作 `Turn unavailable`（轮次=turn）；`{n} 次失败` 作 `{n} failed`（与既有 `{n} 失败` 同款 err chip 口径）；`req {id}` 作 `req {id}`——req 是既有拉丁缩写（`call {ord} · result in req {req}` 同款），译文与 key 相同是定名而非占位；重结算空态句作 `After re-settlement this turn is no longer in the list; click any trace row to return to the request view.`（结算=settle 是 GLOSSARY 词条）。
- 覆盖闸门加两条断言：`t()` 的字面量 key（不看是否含中文）必须 `Object.hasOwn(dict, key)`——用 `Object.hasOwn` 而非 `in`，避免 `toString` 这类 key 命中 `Object.prototype` 的函数值；字典字符串译文的占位符集合必须与 key 相等（对称差为空）。

### 扫描边界

行级扫描只认「同一行里 `t(` 紧贴引号」的字面量调用。动态 key（常量如 `EXEC_MS_HINT`、变量、三元、拼接）取不到字面量：其中文成员字符串仍被既有第一层断言的「中文必须在字典」路径拦住，纯 ASCII 的动态 key 两层都到不了，靠走查兜底——与反引号模板边界同款处理，写在测试头注。函数值译文（单复数）的占位符以参数名形态出现，静态取不到集合，不进占位符比对。

## Alternatives considered

- **只补 5 个 key、不加断言**：本次 4 条回退消失，但洞还在，下一个改文案的人原样掉进去。F14 的定性就是门禁缺陷（「覆盖率测试未挡住」），只补 key 等于留着缺陷修症状。落选。
- **断言扩到函数值译文**：函数收 params 自行拼单复数（`n === 1 ? '1 call' : ...`），静态正则取不全，硬取会产出又误报又拦不住真错的假闸门。落选，作为边界记录在测试头注。
- **扫描器上 AST 解析覆盖动态 key**：本仓不引第三方依赖，行级正则是既有闸门的形态；为 2 处 `t(常量)` 引入解析器不成比例，且常量 key 的中文字面量本就在字典校验路径里。落选。

## Consequences

- `t()` key 漏进字典、字符串译文漏占位符，`bun test tests/i18n-coverage.test.ts` 直接红，不用等英文走查或用户报告。
- 成员校验不看中文与否，`req {id}` 从「回退碰巧可读」变成有译文有闸门。
- 两个盲区仍在并已显式声明：纯 ASCII 动态 key、函数值译文占位符；新增这类文案靠走查兜底。
- [界面双语 note](../feature/2026-11-04-i18n-bilingual-ui.md) 的覆盖闸门 Decision 不变，本文补的是它没兑现的成员校验；其闸门行为描述以本文为准。
