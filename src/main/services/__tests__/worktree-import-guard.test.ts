import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getWorktreeImportRefusalReason } from '../worktree-ops'

describe('getWorktreeImportRefusalReason', () => {
  let homePath: string
  let projectPath: string

  beforeEach(() => {
    homePath = mkdtempSync(join(tmpdir(), 'hive-home-'))
    vi.stubEnv('HOME', homePath)
    projectPath = join(homePath, 'projects', 'my-app')
    mkdirSync(projectPath, { recursive: true })
  })

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  const makeLinkedWorktree = (path: string): void => {
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, '.git'), `gitdir: ${projectPath}/.git/worktrees/x\n`)
  }

  it('refuses the user home directory (the production incident case)', () => {
    // Reproduce the incident shape: a stray .git *directory* in $HOME.
    mkdirSync(join(homePath, '.git'), { recursive: true })
    const reason = getWorktreeImportRefusalReason(homePath, projectPath)
    expect(reason).toContain('home directory')
  })

  it('refuses an ancestor of the home directory', () => {
    const parent = join(homePath, '..')
    const reason = getWorktreeImportRefusalReason(parent, projectPath)
    expect(reason).not.toBeNull()
  })

  it('refuses the project path itself', () => {
    const reason = getWorktreeImportRefusalReason(projectPath, projectPath)
    expect(reason).toContain('project path')
  })

  it('refuses an ancestor of the project path', () => {
    const ancestor = join(homePath, 'projects')
    const reason = getWorktreeImportRefusalReason(ancestor, projectPath)
    expect(reason).toContain('project path or an ancestor')
  })

  it('refuses a main working tree of another repository', () => {
    const otherRepo = join(homePath, 'other-repo')
    mkdirSync(join(otherRepo, '.git'), { recursive: true })
    const reason = getWorktreeImportRefusalReason(otherRepo, projectPath)
    expect(reason).toContain('main working tree')
  })

  it('refuses a directory with no .git entry at all', () => {
    const plainDir = join(homePath, 'plain-dir')
    mkdirSync(plainDir, { recursive: true })
    const reason = getWorktreeImportRefusalReason(plainDir, projectPath)
    expect(reason).toContain('no .git entry')
  })

  it('allows a linked worktree under the managed worktree root', () => {
    const worktreePath = join(homePath, '.hive-worktrees', 'my-app', 'feature-x')
    makeLinkedWorktree(worktreePath)
    expect(getWorktreeImportRefusalReason(worktreePath, projectPath)).toBeNull()
  })

  it('allows a linked worktree in a custom location outside the managed root', () => {
    const worktreePath = join(homePath, 'custom-worktrees', 'feature-y')
    makeLinkedWorktree(worktreePath)
    expect(getWorktreeImportRefusalReason(worktreePath, projectPath)).toBeNull()
  })
})
