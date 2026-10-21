#!/usr/bin/env node
/**
 * 变更闸门：触及代码或工具路径的提交必须同时带一篇 Agent Note。
 *
 * 用法：
 *   node scripts/verify-change-notes.mjs --staged
 *   node scripts/verify-change-notes.mjs --range origin/master..HEAD
 *
 * 触发路径是保守近似，不是语义判断：src/、web/、plugins/、scripts/、tests/、
 * package.json、bun.lock、tsconfig.json、AGENTS.md。纯机械或局部改动在提交
 * 信息里写 `Agent-Note: none — <reason>` 豁免；--staged 还没有提交信息，用
 * ATC_NOTE_EXEMPT=<reason> 放行，并把同样的理由写进提交信息供 range 模式核对。
 *
 * --range 逐提交检查，并跳过本脚本首次进入历史之前的提交：迁移基线。
 */
import { execFileSync } from 'node:child_process'

const TRIGGER_PREFIXES = ['src/', 'web/', 'plugins/', 'scripts/', 'tests/']
const TRIGGER_FILES = new Set(['package.json', 'bun.lock', 'tsconfig.json', 'AGENTS.md'])
const NOTE_FILE = /^\.agents\/notes\/(?:proposed|implemented|rejected|archived)\/[^/]+\/\d{4}-\d{2}-\d{2}-.+\.md$/
const EXEMPT = /^Agent-Note:\s*none\s+[—–-]\s+\S+/m

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' })
}

function gitQuiet(args) {
  try {
    return git(args)
  } catch {
    return null
  }
}

function splitNul(output) {
  return output.split('\0').filter(file => file.length > 0)
}

function stagedFiles() {
  return splitNul(git(['diff', '--cached', '--name-only', '-z']))
}

function stagedNotes() {
  const output = git(['diff', '--cached', '--diff-filter=ACMR', '--name-only', '-z'])
  return splitNul(output).filter(file => NOTE_FILE.test(file))
}

function commitFiles(commit, extra = []) {
  const output = git(['diff-tree', '--root', '--no-commit-id', '-r', ...extra, '--name-only', '-z', commit])
  return splitNul(output)
}

function triggers(files) {
  return files.filter(file => TRIGGER_FILES.has(file)
    || TRIGGER_PREFIXES.some(prefix => file.startsWith(prefix)))
}

function printTriggers(files) {
  for (const file of triggers(files).sort()) console.error(`  ${file}`)
}

function failStaged(files) {
  console.error('verify-change-notes: 暂存区触及需要 note 的路径，但没有新增或更新 Agent Note：')
  printTriggers(files)
  console.error('写一篇 .agents/notes/.../yyyy-mm-dd-topic.md，或设置 ATC_NOTE_EXEMPT=<reason> 后重跑；')
  console.error('同时把 `Agent-Note: none — <reason>` 写进提交信息，range 模式会核对。')
  process.exit(1)
}

const args = process.argv.slice(2)
const staged = args.includes('--staged')
const rangeIndex = args.indexOf('--range')
const range = rangeIndex === -1 ? null : args[rangeIndex + 1] ?? null

if (staged === (range !== null)) {
  console.error('verify-change-notes: 必须且只能指定 --staged 或 --range <rev>。')
  process.exit(2)
}

if (staged) {
  const files = stagedFiles()
  if (triggers(files).length === 0) process.exit(0)
  if (stagedNotes().length > 0) process.exit(0)
  const reason = (process.env.ATC_NOTE_EXEMPT ?? '').trim()
  if (reason.length > 0) {
    console.error(`verify-change-notes: 已按 ATC_NOTE_EXEMPT 放行：${reason}`)
    process.exit(0)
  }
  failStaged(files)
}

let commitList
try {
  commitList = git(['log', '--format=%H', range]).trim().split('\n').filter(Boolean)
} catch {
  console.error(`verify-change-notes: 无法读取范围 ${range}；检查分支名或用 --range 指定。`)
  process.exit(2)
}
if (commitList.length === 0) {
  console.log(`verify-change-notes: ${range} 没有提交。`)
  process.exit(0)
}

// 迁移基线：脚本首次进入历史之前的提交不追溯检查。
const intro = (gitQuiet(['log', '--diff-filter=A', '--format=%H', '--', 'scripts/verify-change-notes.mjs']) ?? '')
  .trim().split('\n').filter(Boolean).pop()
const afterIntro = commit => {
  if (intro === undefined) return true
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', intro, commit], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

let violations = 0
for (const commit of commitList.reverse()) {
  if (!afterIntro(commit)) continue
  const files = commitFiles(commit)
  if (triggers(files).length === 0) continue
  if (commitFiles(commit, ['--diff-filter=ACMR']).some(file => NOTE_FILE.test(file))) continue
  if (EXEMPT.test(git(['log', '-1', '--format=%B', commit]))) continue
  console.error(`verify-change-notes: ${commit} 触及需要 note 的路径，但没有 Agent Note：`)
  printTriggers(files)
  violations += 1
}

if (violations > 0) {
  console.error('写 note，或在提交信息里加 `Agent-Note: none — <为什么这是纯机械改动>`。')
  process.exit(1)
}
console.log(`verify-change-notes: ${range} 的提交均带 note 或显式豁免。`)
