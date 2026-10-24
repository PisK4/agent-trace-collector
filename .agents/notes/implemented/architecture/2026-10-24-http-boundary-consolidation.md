# Agent Note: HTTP 边界四件事分项收拢

Status: implemented

## Problem

访问边界、区间校验、骨架读取与协议能力四片逻辑各有一处双写或歧义：

- 读路径的 Host/Origin 检查与 hook 的前两步是同一段规则，却各写一份；写法漂移会让两处的边界语义悄悄分叉。
- 正文区间校验在 HTTP 层与 `parseRange` 各判一遍，两边规则若不同步，会出现「HTTP 放行、内层抛错」的 500。
- 骨架的宽松读取只存在于 body.ts 的 `readSkeletonTx`。protocols.ts 的 `getBodyPage` 遇到损坏骨架会抛给调用方，而 protocols.ts 反向 import body.ts 会成环（body.ts 已依赖 protocols 的 `ADAPTER_VERSION`/`parseProtocol`）。
- 支持协议名单在 protocols.ts 与 capabilities.ts 各有一份字面量。`responseIdOf` 里 gemini 的 `responseId` 字段分支容易被「收拢」误吞。

## Decision

四件事各自独立落地，互不前置：

1. **访问控制**：http.ts 新增 `checkHostOrigin` 共享段（Host 不合法 → 'host'；Origin 存在且非本机同源含 `null` → 'origin'；其余 null）。`checkAccess` 与 `handleHookIngest` 共用；Origin 通过后 hook 仍必须 Bearer，不继承读路径的 same-site 与导航放行。拒绝顺序（Host → 精确 Origin → 常量时间令牌 → 来源）与固定拒绝原因枚举（`host`/`origin` 本就在 `REJECT_REASONS` 内）保持不变。
2. **区间校验**：protocols.ts 导出纯规则 `bodyRangeError(from, to)`；HTTP 层用它映射 400，`parseRange` 用它做直接防御，两层共用同一条规则。
3. **骨架读取**：新建 `src/skeleton.ts`（无仓库内 import 的叶子模块）承载两种读取——`skeletonLike` 宽松（只要求对象，分页容错，损坏展示未知协议）、`validateSkeleton` 严格（format/protocol/has_messages/redact_version 逐项契约，损坏即不可读）。body.ts 的 `readSkeletonTx` 与 protocols.ts 的 `getBodyPage` 共同消费，依赖方向都是 skeleton ← 调用方。
4. **协议能力**：capabilities.ts 集中持有 `CAPABLE_PROTOCOLS` 与谓词 `protocolSupported`；protocols.ts 的 `SUPPORTED_PROTOCOLS` 指向同一份，能力提取与 capabilityView 走谓词。gemini 不在支持名单内，但 `responseIdOf` 的 `responseId` 字段分支保留——不支持解析不等于没有可回显的响应标识。

## Alternatives considered

**让 protocols.ts 复用 body.ts 的 `readSkeletonTx`。** body.ts 已 import protocols（`ADAPTER_VERSION`、`parseProtocol`），反向引用即成环；把骨架读取留在 body.ts 会让中立性依附于调用方向而非模块边界。

**分页也改走严格验证。** 损坏骨架的处理会从展示为未知协议退化成拒绝整页：宽松读取的语义是「结构损坏是展示问题」，严格验证的语义是「恢复与用途判定不可信任」，两者职责不同，共用一份验证会牺牲前者。

**hook 的 Origin 检查并入 `checkAccess`。** 读路径在 Origin 通过后还有 same-site、导航放行与读取令牌三个分支，hook 只要 Bearer；合并后要么给 `checkAccess` 加模式参数（回到双写，只是写在一处），要么放宽 hook（破坏[访问边界](../../implemented/architecture/2026-10-20-privacy-and-local-access-boundary.md)的固定顺序）。共享到 Host/Origin 段为止正好是两条路径真正相同的那一段。

**把 gemini 从 `responseIdOf` 里删掉以收拢协议分支。** gemini 信封的响应标识字段名不同是数据事实，协议适配并没有遗漏。吞掉分支会让 gemini 记录失去 response_id 回显。

## Consequences

边界语义改写有唯一位置。新增入口（第三个消费 Host/Origin 的路径）直接复用共享段。骨架两种读取的宽严语义由两个函数名钉住，混用时测试先红。协议名单增删只改 capabilities.ts 一处，但 `responseIdOf` 的字段分支与名单解耦——新增协议要同时核对两处。区间规则只改 protocols.ts 一处，HTTP 层与内层防御自动同步。

## Testing

- hook：same-origin Origin 无 Bearer → 401，`unauthorized` 计数相应加一；Host/Origin 拒绝仍映射既有固定原因。
- 区间：HTTP 层 `to < from` 与跨度超限均 400；内层 `parseRange` 防御与 HTTP 共用同一规则函数的测试钉住两层一致。
- 骨架：严格验证逐项契约拒绝（format、空协议、has_messages 类型、redact_version 下界、条数一致性）；非对象骨架分页容错返回空字段与未知协议，不拒绝整页。
- 能力：`protocolSupported` 谓词名单内 true、名单外 false。
- `bun test` 599 例全过（39 文件），`bun run typecheck` 通过（2026-10-24）。
