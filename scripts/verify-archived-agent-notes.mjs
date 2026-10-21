/**
 * 校验并追加封印冻结的 Agent Note 归档区。
 * 移植自 dsh scripts/verify-archived-agent-notes.ts（MIT）；单文件化、仓库无提交时跳过
 * baseline 对比（项目首日无已封印内容），改动见 kit LINEAGE.md。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AGENT_NOTE_CLASSES, agentNoteRoot } from './agent-note-tree.mjs'
import {
  extendArchiveManifest,
  parseArchiveManifest,
  renderArchiveManifest,
  validateArchiveArtifacts,
  validateArchiveManifestExtension,
} from './archived-agent-notes.mjs'

const args = process.argv.slice(2)
const writeMode = args.length === 1 && args[0] === '--write'
if (args.length > 0 && !writeMode) {
  console.error('verify-archived-agent-notes: 用法：node scripts/verify-archived-agent-notes.mjs [--write]')
  process.exit(1)
}

const archiveRoot = resolve(agentNoteRoot, 'archived')
const manifestPath = resolve(archiveRoot, 'manifest.json')
const repoRoot = resolve(agentNoteRoot, '../..')
const manifestRepoPath = '.agents/notes/archived/manifest.json'
const errors = []
const allowedRootFiles = new Set(['AGENTS.md', 'manifest.json'])
const kinds = new Set()

if (!existsSync(resolve(archiveRoot, 'AGENTS.md'))) errors.push('archived/AGENTS.md 必须存在')
const artifacts = new Map()
// 归档目录缺失与其它违规同构报错，不让 readdirSync 抛 ENOENT 堆栈。
let archiveEntries
try {
  archiveEntries = readdirSync(archiveRoot, { withFileTypes: true })
} catch {
  archiveEntries = []
  errors.push('archived/ — 归档目录缺失')
}
for (const entry of archiveEntries) {
  if (entry.isFile()) {
    if (!allowedRootFiles.has(entry.name)) errors.push(`archived/${entry.name}: 意外的归档区根级文件`)
    continue
  }
  if (!entry.isDirectory()) {
    errors.push(`archived/${entry.name}: 归档区只允许普通文件与分类目录`)
    continue
  }
  if (!AGENT_NOTE_CLASSES.includes(entry.name)) {
    errors.push(`archived/${entry.name}/: 未知 Agent Note 分类`)
    continue
  }
  kinds.add(entry.name)
  for (const child of readdirSync(resolve(archiveRoot, entry.name), { withFileTypes: true })) {
    if (child.name === '.gitkeep') continue
    const rel = `${entry.name}/${child.name}`
    if (!child.isFile()) {
      errors.push(`${rel}: 归档分类目录内只允许普通文件`)
      continue
    }
    artifacts.set(rel, readFileSync(resolve(archiveRoot, rel)))
  }
}
for (const kind of AGENT_NOTE_CLASSES) {
  if (!kinds.has(kind)) errors.push(`archived/${kind}/: 缺少必需的分类目录`)
}
errors.push(...validateArchiveArtifacts(artifacts))

function runGit(gitArgs) {
  const result = spawnSync('git', gitArgs, { cwd: repoRoot, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git exited with status ${result.status}`)
  return result.stdout
}

function readBaselineManifest(ref) {
  runGit(['cat-file', '-e', `${ref}^{commit}`])
  const manifestEntry = runGit(['ls-tree', '--name-only', ref, '--', manifestRepoPath]).trim()
  if (manifestEntry === '') return { version: 1, files: {} }
  return parseArchiveManifest(runGit(['show', `${ref}:${manifestRepoPath}`]))
}

let manifest = { version: 1, files: {} }
if (existsSync(manifestPath)) {
  try {
    manifest = parseArchiveManifest(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    errors.push(`archived/manifest.json: ${error instanceof Error ? error.message : String(error)}`)
  }
} else if (!writeMode) {
  errors.push('archived/manifest.json 必须存在；用 `node scripts/verify-archived-agent-notes.mjs --write` 封印新产物')
}

// 仓库还没有任何提交时（项目首日）跳过 baseline 对比：此时没有已封印内容需要保护。
let hasCommits = false
try {
  runGit(['rev-parse', '--verify', 'HEAD'])
  hasCommits = true
} catch {}

if (hasCommits) {
  // CI 提供受信任的变更前提交；本地写入与已提交的 HEAD 比较。
  const baselineRef = process.env.KIT_ARCHIVE_BASE_REF ?? 'HEAD'
  try {
    const baseline = readBaselineManifest(baselineRef)
    errors.push(...validateArchiveManifestExtension(baseline, manifest))
  } catch (error) {
    errors.push(`archived/manifest.json: 无法读取 baseline ${JSON.stringify(baselineRef)}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const extended = extendArchiveManifest(manifest, artifacts)
errors.push(...extended.errors)
if (!writeMode) {
  for (const path of extended.added) errors.push(`${path}: 归档产物尚未封印进 manifest.json`)
}

if (errors.length > 0) {
  console.error('verify-archived-agent-notes: 违反归档规则：')
  for (const error of errors) console.error(`  ${error}`)
  process.exit(1)
}

if (writeMode) {
  const rendered = renderArchiveManifest(extended.files)
  if (!existsSync(manifestPath) || readFileSync(manifestPath, 'utf8') !== rendered) {
    writeFileSync(manifestPath, rendered)
  }
  console.log(`verify-archived-agent-notes: 已封印 ${extended.added.length} 个新产物；既有封印未动。`)
} else {
  console.log(`verify-archived-agent-notes: 已检查 ${artifacts.size} 个冻结产物，覆盖 ${kinds.size} 个分类。`)
}
