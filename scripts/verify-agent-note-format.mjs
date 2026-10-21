/**
 * 强制 Agent Note 的头部、生命周期专属小节与 Alternatives considered。
 * 分类与文件名属于同目录的目录树闸门。确切格式见 .agents/notes/README.md。
 * 移植自 dsh scripts/verify-agent-note-format.ts（MIT）；pre-format 豁免与 legacy 标记检查按
 * kit 决策删除（kit 无历史包袱），见 LINEAGE.md。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { agentNoteRoot, walkAgentNoteTree } from './agent-note-tree.mjs'

/** 各生命周期目录的 Status 行文法。 */
const STATUS = {
  proposed: /^Status: proposed$/,
  implemented: /^Status: implemented$/,
  rejected: /^Status: rejected — .+$/,
}

/** 每个生命周期除通用 `## Problem` 开头外必备的 `##` 小节。 */
const REQUIRED = {
  proposed: ['## Proposal', '## Acceptance criteria', '## Risks'],
  implemented: ['## Decision', '## Consequences'],
  rejected: ['## Proposal'],
}

/** implemented/ 中禁用的小节——提案时代的 spec 腔。 */
const BANNED_IMPLEMENTED = /^## (?:Proposal\b|Plan\b|Migration plan\b|Acceptance criteria\b)/i

const { notes, errors } = walkAgentNoteTree()

for (const note of notes) {
  const fail = (msg) => {
    errors.push(`format: ${note.rel} — ${msg}`)
  }
  const lines = readFileSync(resolve(agentNoteRoot, note.rel), 'utf8').split('\n')
  // 围栏示例里的格式 token 不是文档结构。
  let inFence = false
  const prose = lines.filter((l) => {
    if (l.startsWith('```')) {
      inFence = !inFence
      return false
    }
    return !inFence
  })

  if (!/^# Agent Note: \S/.test(lines[0] ?? '')) fail('第 1 行必须是 `# Agent Note: <标题>`')
  if (lines[1] !== '') fail('第 2 行必须是空行')
  const status = STATUS[note.lifecycle]
  if (status !== undefined && !status.test(lines[2] ?? '')) {
    fail(`第 3 行必须匹配 ${note.lifecycle} 的 Status 文法（${String(status)}）`)
  }
  if (lines[3] !== '') fail('第 4 行必须是空行')
  const statusLines = prose.filter((l) => l.startsWith('Status:') && l !== lines[2])
  if (statusLines.length > 0 || prose.filter((l) => l === lines[2]).length > 1) {
    fail('第 3 行的 `Status:` 行必须是全文件唯一一处')
  }

  const h2s = prose.filter((l) => l.startsWith('## ')).map((l) => l.trimEnd())
  if (h2s[0] !== '## Problem') fail(`第一个小节必须是 \`## Problem\`（得到 ${JSON.stringify(h2s[0] ?? '<none>')}）`)
  for (const required of REQUIRED[note.lifecycle] ?? []) {
    if (!h2s.includes(required)) fail(`缺少必备小节 \`${required}\``)
  }
  if (note.lifecycle === 'implemented') {
    for (const h2 of h2s.filter((h) => BANNED_IMPLEMENTED.test(h))) {
      fail(`\`${h2}\` 是提案时代的小节；implemented Agent Note 陈述现状（折进 Decision/Consequences/Testing）`)
    }
  }

  if (!h2s.includes('## Alternatives considered')) {
    fail('缺少 `## Alternatives considered`（记录决策而不记录它打败了谁，等于邀请重新翻案）')
  }
}

if (errors.length === 0) {
  console.log(`verify-agent-note-format: 已检查 ${notes.length} 篇 Agent Note，全部符合 .agents/notes/README.md 的文件格式。`)
  process.exit(0)
}

console.error('verify-agent-note-format: 发现违规：')
for (const e of errors) console.error(`  ${e}`)
process.exit(1)
