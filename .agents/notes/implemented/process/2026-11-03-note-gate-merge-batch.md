# Agent Note: Note 闸门按合并批次判定

Status: implemented

## Problem

`verify-change-notes --range origin/master..HEAD` 逐提交检查，要求每个提交自身带一篇 Agent Note。worktree 规则要求每完成一个小改动提交一次，note 通常只在分支的某一笔里写一次；两种规则同时成立时，分支里的中间提交全部被判违规。2026-11-03 的 17 个提交因此失败，尽管每个分支最后都带了覆盖整批改动的 note。

逐提交检查只回答这一笔有没有 note，回答不了一次落地有没有 note。合并到 master 的保障点是整批改动，不是每个中间提交。

## Decision

range 模式改按落地批次判定。一批里至少一篇 Agent Note 即可，不要求每个提交都带。规则只要求合并到 master 之前这一批有 note，不规定写 note 的时机。

- **有 merge 的 range**：从上一个 merge 到当前 merge 之间的全部提交是一批，包含主线上补 note 的提交、第二父分支的提交与 merge 自身。
- **没有 merge 的 range**：整个 range 是一批，典型场景是 worktree 分支合并前的检查。
- **合并之后的尾巴**：最后一个 merge 之后的提交单独成一批；直接落在 master 的改动不会被整批 note 掩盖。
- **`--staged` 不变**：仍检查当前暂存区，作为提交时的自检。

[变更闸门](2026-10-21-change-note-gate.md)的路径判定与豁免语法不变；本记录只改 range 的批次粒度。

## Alternatives considered

**每个小提交都带 note。** 符合逐提交检查，也最容易实现。否决原因是与 worktree 的小步提交冲突：分支上每个 `feat`、`style`、`test` 提交都要重复写或更新 note，提交噪音大，note 会变成逐提交的进度记录。

**显式继承标记。** 中间提交写 `Agent-Note: inherit <note 路径>`，脚本识别后放行。否决原因是每个中间提交都要多写一行，而且标记要维护到合并；需求是一批一篇 note，不需要逐提交声明。

**整个 range 永远只算一批。** 实现最简单，但本地 master 领先远程多个合并时会互相掩盖：一个批次带了 note，另一个没有也会通过。

**去掉 range 检查，只保留 staged。** 否决原因是失去合并前的整批保障；staged 只证明最后一次提交合格。

## Consequences

worktree 分支的中间提交不再要求 note，最后一笔带覆盖整批改动的 note 就能过 range。直接落在 master 的独立提交仍逐个检查。

脚本不能验证 note 的内容覆盖整批改动，只能验证这一批里有一篇 note。内容是否覆盖由写 note 的 Agent 和合并前的 review 保证。

一篇 note 只算它所在的批次。如果一篇 note 覆盖后续多个 merge，后续批次仍要各自带 note；机械闸门不读 note 内容，无法把前一批的 note 借给后一批。

merge 的第二父分支如果跨越脚本引入之前的提交，按迁移基线跳过；批次里剩下的提交仍要找 note。

## Testing

[tests/verify-change-notes.test.ts](../../../../tests/verify-change-notes.test.ts) 用临时 git 仓库覆盖四种情况：线性分支带 note、线性分支不带 note、merge 批次带 note、merge 批次不带 note。当前仓库的 `origin/master..HEAD` 用它自己的历史复验。