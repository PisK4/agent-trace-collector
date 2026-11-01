# Agent Note: 方向 A 第 1 步——token 值替换（Geist 中性 + Apple 蓝）

Status: implemented

## Problem

[前端方向 A 重制提案](../../proposed/feature/2026-11-02-frontend-direction-a-restyle.md)的六步落地中，第 1 步是把 `web/app.css` 三段 token（浅色 `:root`、深色 `@media`、深色 `[data-theme="dark"]`）从蓝灰倾向的旧配色换成 Geist 中性灰阶加 Apple 系统蓝。样张附录的映射表只列了主 token，生产 token 集里还有若干相邻变量需要补全决策。

## Decision

三段 token 按样张映射表一次改齐，纯值变更，行为与选择器不动：

- 表面：`--page #F7F7F6/#0F0F0F`、`--canvas #FAFAFA/#0A0A0A`、`--surface #FFFFFF/#111111`、`--inset #F5F5F4/#181818`；线 `--line #ECECEA/#232323`、`--line-strong #DEDEDB/#2F2F2F`。
- 字色三档 `--text/--text-2/--muted`：浅 `#171717/#52525B/#A1A1AA`，深 `#EDEDED/#A1A1AA/#6B6B74`。
- accent 换系统蓝 `#007AFF/#0A84FF`，`--accent-soft` 取样张值 `rgba(0,122,255,.07)/rgba(10,132,255,.10)`。
- 角色 k-* 按四档重映射色值：user 蓝 `#0066CC/#409CFF`、assistant 紫 `#8E44AD/#C77FEA`、tool 橙 `#B45309/#FFB340`、system 与 field 并入灰（字色取 text-2 档，底 `rgba(161,161,170,.16/.14)`）。`--k-field` 的变量删除与消费点核对是第 2 步动作，本步只把值并入灰档，视觉先行、结构不动。
- `--missing` 中性化为 `#A1A1AA/#6B6B74`（与 muted 同档），`--shadow` 浅色改中性 `rgba(0,0,0,.06)`。

对样张映射表的四处补全，均为映射表未列的生产 token：

1. **`--page` 与 `--canvas` 的分配**：映射表把 `#FAFAFA/#0A0A0A` 写在 `--page` 名下，但生产里 body 与中栏用的是 `--canvas`，`--page` 是会话栏底。按消费点语义分配：主画布（`--canvas`）取 `#FAFAFA/#0A0A0A`，会话栏（`--page`）取偏半档的 `#F7F7F6/#0F0F0F`，保留两栏的既有明度差结构。
2. **`--hover`**：样张 `#F7F7F6/#1D1D1D` 在其单层画布上成立；生产悬停发生在会话栏与中栏两种底上，浅色取 `#EFEFEE` 保证在 `#FAFAFA` 与 `#F7F7F6` 上都可见，深色沿用样张 `#1D1D1D`。
3. **`--good/--warn/--bad` 及各自 soft**：映射表明示「保留，收敛使用点」，本步值不动；收敛使用点是后续步骤的事。
4. **`--tool-*` 七组与 `--p1..p7` 槽位**：分别属第 2、6 步动作，本步原值保留。

`--accent-strong` 在全仓（web/、src/、prototypes/、plugins/）只有定义无消费，属于死 token，随本步删除。

## Alternatives considered

- **`--page`/`--canvas` 都取 `#FAFAFA`**：侧栏与主区明度差消失，现结构的分层靠边框硬撑，与「表面层级靠明度差」的方向相反。保留半档差。
- **`--k-field` 本步直接删变量**：并入需逐消费点核对语义（提案 Risk 已列），混进纯值变更会让第 1 步失去「行为不变」的验收基线。值先行、结构留给第 2 步。

## Testing

- 全仓 grep 旧色值与 `accent-strong` 无残留。
- 合成服务器目测浅深两主题（`/tmp/atc-restyle/step1-light.png`、`step1-dark.png`）：中性灰阶与系统蓝生效，treemap 彩色与 pending 米黄按计划保留给后续步骤；深色跟随系统与 `data-theme` 强制两条路径都验证。
- 纯 CSS 值变更，无测试可钉色值；行为不变的验收即上两条。

## Consequences

- **四档角色色已生效但徽章形状未动**：现徽章仍是旧底块形态配新色，第 2 步 pill 化后才是提案的最终形态；中间态可上生产，不算回归。
- **`--hover` 浅色偏离样张值**：`#EFEFEE` 是按生产两种悬停底推的适配值；若第 3 步改会话栏底色，需回头复核悬停可见度。
- **`--k-field` 值与 `--k-system` 相同**：变量仍在，第 2 步并入时删变量并核对消费点，届时若有 field 语义不当并入灰的反例，在该步 note 里改判。
