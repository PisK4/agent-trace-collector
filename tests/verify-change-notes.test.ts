import { describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const script = resolve(import.meta.dir, '../scripts/verify-change-notes.mjs')

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atc-note-range-'))
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.name', 'Test'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  writeFileSync(join(dir, 'README.md'), 'base\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'base'])
  return dir
}

function writeNote(dir: string): void {
  mkdirSync(join(dir, '.agents/notes/implemented/process'), { recursive: true })
  writeFileSync(join(dir, '.agents/notes/implemented/process/2026-11-03-test.md'), [
    '# Agent Note: test',
    '',
    'Status: implemented',
    '',
    '## Problem',
    '',
    'x',
    '',
    '## Decision',
    '',
    'y',
    '',
    '## Alternatives considered',
    '',
    'z',
    '',
    '## Consequences',
    '',
    'w',
    '',
  ].join('\n'))
}

function commitChange(dir: string, withNote: boolean): void {
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src/foo.ts'), 'export const x = 1\n')
  if (withNote) writeNote(dir)
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', withNote ? 'change with note' : 'change without note'])
}

function runRange(dir: string, range: string): number | null {
  return spawnSync(process.execPath, [script, '--range', range], { cwd: dir, encoding: 'utf8' }).status
}

describe('verify-change-notes --range', () => {
  test('a linear branch with a note passes', () => {
    const dir = initRepo()
    try {
      const base = git(dir, ['rev-parse', 'HEAD']).trim()
      commitChange(dir, true)
      expect(runRange(dir, `${base}..HEAD`)).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a linear branch without a note fails', () => {
    const dir = initRepo()
    try {
      const base = git(dir, ['rev-parse', 'HEAD']).trim()
      commitChange(dir, false)
      expect(runRange(dir, `${base}..HEAD`)).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a merge batch with a note passes', () => {
    const dir = initRepo()
    try {
      const base = git(dir, ['rev-parse', 'HEAD']).trim()
      git(dir, ['checkout', '-q', '-b', 'feat'])
      commitChange(dir, true)
      git(dir, ['checkout', '-q', 'main'])
      git(dir, ['merge', '--no-ff', 'feat', '-m', 'merge feat'])
      expect(runRange(dir, `${base}..HEAD`)).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a merge batch without a note fails', () => {
    const dir = initRepo()
    try {
      const base = git(dir, ['rev-parse', 'HEAD']).trim()
      git(dir, ['checkout', '-q', '-b', 'feat'])
      commitChange(dir, false)
      git(dir, ['checkout', '-q', 'main'])
      git(dir, ['merge', '--no-ff', 'feat', '-m', 'merge feat'])
      expect(runRange(dir, `${base}..HEAD`)).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a merge batch with a note on the mainline before it passes', () => {
    const dir = initRepo()
    try {
      const base = git(dir, ['rev-parse', 'HEAD']).trim()
      git(dir, ['checkout', '-q', '-b', 'feat'])
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src/foo.ts'), 'export const x = 1\n')
      git(dir, ['add', '.'])
      git(dir, ['commit', '-q', '-m', 'change without note'])
      git(dir, ['checkout', '-q', 'main'])
      writeNote(dir)
      git(dir, ['add', '.'])
      git(dir, ['commit', '-q', '-m', 'note'])
      git(dir, ['merge', '--no-ff', 'feat', '-m', 'merge feat'])
      expect(runRange(dir, `${base}..HEAD`)).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})