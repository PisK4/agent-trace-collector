/**
 * 归档格式、单文件完整性与追加式 manifest 的纯函数助手。
 * 移植自 dsh scripts/archived-agent-notes.ts（MIT）；三件套校验改为单文件，改动见 kit LINEAGE.md。
 */

import { createHash } from 'node:crypto'
import { AGENT_NOTE_CLASSES } from './agent-note-tree.mjs'

/** 冻结内容 manifest 的版本化字段。 */
// { version: 1, files: Record<path, 'sha256:…'> }

function archiveContentHash(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 解析归档 manifest，拒绝封闭 schema 之外的字段或哈希。 */
export function parseArchiveManifest(content) {
  const value = JSON.parse(content)
  if (!isRecord(value)) throw new Error('expected a JSON object')
  const fields = Object.keys(value).sort()
  if (fields.join(',') !== 'files,version') throw new Error('expected exactly the fields `version` and `files`')
  if (value.version !== 1) throw new Error('unsupported manifest version (expected 1)')
  if (!isRecord(value.files)) throw new Error('`files` must be an object')
  const files = {}
  for (const [path, hash] of Object.entries(value.files)) {
    if (typeof hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`invalid content hash for ${path}`)
    }
    files[path] = hash
  }
  return { version: 1, files }
}

/** 以确定的路径顺序渲染归档 manifest。 */
export function renderArchiveManifest(files) {
  return `${JSON.stringify({
    version: 1,
    files: Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))),
  }, null, 2)}\n`
}

/** 拒绝对先前 manifest 已封印条目的改动或删除。 */
export function validateArchiveManifestExtension(baseline, current) {
  const errors = []
  for (const [path, expected] of Object.entries(baseline.files)) {
    const actual = current.files[path]
    if (actual === undefined) errors.push(`${path}: sealed manifest entry is missing`)
    else if (actual !== expected) errors.push(`${path}: sealed manifest hash changed`)
  }
  return errors
}

function validDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function validateHeader(path, content, sourceBase) {
  const errors = []
  const lines = content.toString('utf8').split('\n')
  if (!/^# Agent Note: \S/.test(lines[0] ?? '')) errors.push(`${path}: 第 1 行必须是 \`# Agent Note: <标题>\``)
  if (lines[1] !== '') errors.push(`${path}: 第 2 行必须是空行`)
  if (lines[2] !== 'Status: implemented') errors.push(`${path}: 第 3 行必须是 \`Status: implemented\``)
  const archived = /^Archived: (\d{4}-\d{2}-\d{2})$/.exec(lines[3] ?? '')?.[1]
  if (archived === undefined || !validDate(archived)) {
    errors.push(`${path}: 第 4 行必须是 \`Archived: YYYY-MM-DD\`（有效日期）`)
  } else if (archived < sourceBase.slice(0, 10)) {
    errors.push(`${path}: 归档日期 ${archived} 早于 note 文件名日期`)
  }
  if (lines[4] !== '') errors.push(`${path}: 第 5 行必须是空行`)
  return errors
}

/** 校验封闭分类树、归档头部与单文件完整性。 */
export function validateArchiveArtifacts(artifacts) {
  const errors = []
  for (const [path, content] of [...artifacts].sort(([left], [right]) => left.localeCompare(right))) {
    const match = /^([^/]+)\/(\d{4}-\d{2}-\d{2}-.+)\.md$/.exec(path)
    if (match?.[1] === undefined || match?.[2] === undefined) {
      errors.push(`${path}: 应为 {kind}/yyyy-mm-dd-topic.md`)
      continue
    }
    if (!AGENT_NOTE_CLASSES.includes(match[1])) {
      errors.push(`${path}: 未知 Agent Note 分类 ${JSON.stringify(match[1])}`)
      continue
    }
    errors.push(...validateHeader(path, content, match[2]))
  }
  return errors
}

/** 保全每一条已封印的路径/哈希，并为新归档产物追加哈希。 */
export function extendArchiveManifest(existing, artifacts) {
  const errors = []
  const files = { ...existing.files }
  for (const [path, expected] of Object.entries(existing.files)) {
    const content = artifacts.get(path)
    if (content === undefined) errors.push(`${path}: sealed artifact is missing`)
    else if (archiveContentHash(content) !== expected) errors.push(`${path}: sealed content hash changed`)
  }
  const added = []
  for (const [path, content] of [...artifacts].sort(([left], [right]) => left.localeCompare(right))) {
    if (files[path] !== undefined) continue
    files[path] = archiveContentHash(content)
    added.push(path)
  }
  return { files, added, errors }
}
