/**
 * Agent Note 目录树的共享结构事实源。生命周期与分类集合封闭，以 .agents/notes/README.md 为准。
 * 移植自 dsh scripts/agent-note-tree.ts（MIT），改动见 kit LINEAGE.md。
 */

import { readdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

export const agentNoteRoot = resolve(import.meta.dirname, '../.agents/notes')

/** 活动生命周期的封闭集（.agents/notes/ 顶层目录）。 */
const AGENT_NOTE_LIFECYCLES = ['proposed', 'implemented', 'rejected']

/**
 * 分类的封闭集（每个生命周期下的二级目录）。新增分类是显式动作：
 * 同时修改本清单与 README 的「分类」一节，闸门拒绝其余目录。
 */
export const AGENT_NOTE_CLASSES = ['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing']

/** 历史 implemented note 存放在活动生命周期树之外。 */
const AGENT_NOTE_ARCHIVE = 'archived'

/** 允许直接放在生命周期根目录的非 note Markdown。 */
const ROOT_ALLOWLIST = new Set(['AGENTS.md', 'CLAUDE.md'])

/** 一篇 Agent Note，由目录遍历发现。lifecycle 是生命周期名；rel 是相对 .agents/notes 的路径；date 是文件名中的 yyyy-mm-dd。 */

function listMarkdownFiles(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...listMarkdownFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.md')) found.push(full)
  }
  return found
}

/**
 * 遍历 Agent Note 树并强制结构规则。返回全部合法 note，外加每条违规一个错误串
 * （未知生命周期或分类目录、深度错误、文件名错误）。调用方把非空错误列表视为致命。
 */
export function walkAgentNoteTree() {
  const notes = []
  const errors = []
  // 缺失的目录按结构违规响亮报错：dsh 的 globSync 对缺失目录静默放行，这里不跟。
  let rootEntries
  try {
    rootEntries = readdirSync(agentNoteRoot, { withFileTypes: true })
  } catch {
    errors.push('structure: .agents/notes — 规则目录缺失')
    return { notes, errors }
  }
  // 生命周期集合同样封闭：未知目录里的 note 否则不会出现在下面的遍历结果里。
  for (const entry of rootEntries) {
    if (entry.name === 'INDEX.md') {
      errors.push('structure: INDEX.md — 禁止集中式 Agent Note 索引；请浏览 lifecycle/class 目录或搜索仓库')
      continue
    }
    if (entry.isDirectory()
      && entry.name !== AGENT_NOTE_ARCHIVE
      && !AGENT_NOTE_LIFECYCLES.includes(entry.name)) {
      errors.push(`structure: ${entry.name}/ — 未知生命周期目录（允许：${AGENT_NOTE_LIFECYCLES.join(', ')}，外加 ${AGENT_NOTE_ARCHIVE}/）`)
    }
  }
  for (const lifecycle of AGENT_NOTE_LIFECYCLES) {
    let files
    try {
      files = listMarkdownFiles(join(agentNoteRoot, lifecycle))
    } catch {
      errors.push(`structure: ${lifecycle}/ — 生命周期目录缺失`)
      continue
    }
    for (const full of files.sort()) {
      const rel = full.slice(agentNoteRoot.length + 1).split(sep).join('/')
      const segs = rel.split('/')
      // 生命周期根目录的白名单文件（如 implemented/AGENTS.md）。
      if (segs.length === 2 && ROOT_ALLOWLIST.has(segs[1])) continue
      const cls = segs[1]
      const base = segs[2]
      if (segs.length !== 3) {
        errors.push(`structure: ${rel} — 应为 {lifecycle}/{class}/file.md（当前 ${segs.length} 层）`)
        continue
      }
      if (!AGENT_NOTE_CLASSES.includes(cls)) {
        errors.push(`structure: ${rel} — 未知分类目录 "${cls}"（允许：${AGENT_NOTE_CLASSES.join(', ')}）`)
        continue
      }
      if (!/^\d{4}-\d{2}-\d{2}-.+\.md$/.test(base)) {
        errors.push(`structure: ${rel} — 文件名必须是 yyyy-mm-dd-topic.md`)
        continue
      }
      notes.push({ lifecycle, rel, date: base.slice(0, 10) })
    }
  }
  return { notes, errors }
}
