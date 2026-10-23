# Agent Note: 容量决策由比值做主因，切片必须挂在同步派生成本上

Status: implemented

## Problem

门槛能判出 12 项越界，但"这一版能不能发布、要不要动同步派生"没有落点：判据散在人的解读里，两个人都读同一份报告可以得出相反结论。反过来也有风险 —— 若把"有失败就切片"写进脚本，任何一次红门都会自动触发一次架构重写，等于把产品决定交给了闸门。

## Decision

`scripts/capacity-decision.ts` 把门槛的失败项收敛成一个决策，取值只有 `keep-sync`、`slice`、`stop-non-long` 三种。严重度按比值算：上限类 `actual / max(1, limit)`，下限类 `limit / max(1, actual)`；主因是比值最高的那项所在的场景。进入 `slice` 要同时满足三条：主因场景是 `long-10000`；该场景至少一项失败属于 `max_write_tx_ms`、`event_loop_p99_ms`、`drain_ms`、`backlog_max_age_ms`；其它场景没有 `code-constant` 或 `product-target` 失败。其余有失败的情形一律 `stop-non-long`：保留同步入口，如实列出失败项，不创建 v6 文件。

空失败项有两种来源，脚本只认其中一种为通过：被测场景列表为空时抛 `capacity_decision_no_scenarios` 并退出 2，不生成决策文件。"没有场景被测量"不能读成"全部通过"。

决策文件（`docs/superpowers/capacity/2026-10-22-atc-capacity-decision.json`）记报告与预算两侧的 sha256、失败项全量、主因、严重度、`decided_at` 与可重放的命令，权限 0600。判定不读 `notes`，也不为产品目标代签：产品目标未达成是产品决定，写进 note 与记录，不写进这个文件的 `decision`。

## Alternatives considered

**有失败就进切片。** 任何一次红门都会自动触发架构重写，脚本变成产品决定的代理；`stop-non-long` 这一档存在的意义就是不让它这么做。

**严重度按差值算。** 100 ms 与 1 ms 两个量纲混在一张表里，差值没有共同单位，主因会被"量级最大的指标"决定而不是"最该修的地方"。

**让脚本在决策文件里写"产品目标未达成"。** 脚本读得到指标，读不到"5 rps 是必须达成的产品目标"这句话；把产品意图塞进脚本，等于以后改目标要改代码。

**用 `scenarios` 参数参与判定。** 它唯一需要回答的是"有没有场景被测量"，其余信息已经在失败项里；让它参与判据会造出第二条判定路径。

## Consequences

- 冻结预算的实测决策是 `stop-non-long`，主因 `baseline-5rps`，严重度 969。
- 这个 969 是退化值：`ticks_dropped` 的上限是 0，比值按 `max(1, limit)` 算，于是严重度退化成"丢了 969 个刻度"这个绝对数，而不是"比别处严重 969 倍"。把 `primary` 读成"最该修的那一处"时要看这一条。规则不改 —— 零上限指标都带 `product-target` 或 `code-constant`，它们自己就会让 `otherAbsolute` 成立，所以这个退化只在"主因怎么称呼"上生效，不会把 `stop-non-long` 翻成 `slice`。
- `stop-non-long` 不是完成路径，也不是"暂停"。它表示当前同步设计不能按现状发布。
- Part V（v6 代际与切片派生）按产品决定触发，不由这份决策触发：5 rps 是必须达成的产品目标，本轮只投递 3.39 rps，主因是 `drainDeriveTx` 每个脏组整组重算。这个触发理由写在这里，与决策文件的 `decision` 分开，脚本不代签。
- 决策只在预算与报告同时存在且形状合法时生成；两侧任一缺失由加载器退出 2，不产生半份决策。

## Testing

`bun test tests/capacity-gate.test.ts` 覆盖：长组主因且别处无绝对失败时 `slice`；无失败时有场景则 `keep-sync`；主因在速率基线或别处存在 `product-target` 失败时 `stop-non-long`；下限类的比值取 `limit / actual` 且长组只有时延类失败时不切片；失败项为空且场景列表为空时抛 `capacity_decision_no_scenarios`；`buildDecisionFile` 写入两侧 sha256、失败项、`decided_at` 与命令，且 JSON 可原样读回。