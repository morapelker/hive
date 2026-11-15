import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getOrphanedWorktreeDirReason,
  getWorktreeImportRefusalReason,
  isScratchDetachedWorktree
} from '../worktree-ops'

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

describe('getOrphanedWorktreeDirReason', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hive-orphan-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('keeps a linked worktree checkout (.git file)', () => {
    const path = join(root, 'linked')
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, '.git'), 'gitdir: /somewhere/.git/worktrees/linked\n')
    expect(getOrphanedWorktreeDirReason(path)).toBeNull()
  })

  it('flags a directory left behind without any .git entry (partial git worktree remove)', () => {
    const path = join(root, 'leftover')
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'DECISIONS.md'), 'written after removal\n')
    expect(getOrphanedWorktreeDirReason(path)).toContain('no .git entry')
  })

  it('flags a main working tree of another repository (.git directory)', () => {
    const path = join(root, 'other-repo')
    mkdirSync(join(path, '.git'), { recursive: true })
    expect(getOrphanedWorktreeDirReason(path)).toContain('main working tree')
  })
})

describe('isScratchDetachedWorktree', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hive-scratch-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('flags a detached worktree under the OS temp directory', () => {
    const path = join(root, 'baseline')
    mkdirSync(path)
    expect(isScratchDetachedWorktree('', path)).toBe(true)
  })

  it('flags one that is already gone from disk', () => {
    expect(isScratchDetachedWorktree('', join(root, 'removed', 'baseline'))).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('flags a detached worktree under /tmp', () => {
    // What git reports on macOS, where /tmp is a link into /private.
    expect(isScratchDetachedWorktree('', '/private/tmp/review-commit-41641')).toBe(true)
    expect(isScratchDetachedWorktree('', '/tmp/b34-spec/integ')).toBe(true)
  })

  it('keeps a temp worktree that is on a branch', () => {
    const path = join(root, 'feature')
    mkdirSync(path)
    expect(isScratchDetachedWorktree('feature', path)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'keeps a detached worktree someone placed outside the temp directories',
    () => {
      expect(isScratchDetachedWorktree('', '/Users/someone/dev/my-app-deploy')).toBe(false)
      expect(isScratchDetachedWorktree('', '/Users/someone/tmp-notes/my-app')).toBe(false)
    }
  )

  it('does not treat a temp directory itself as a scratch worktree', () => {
    expect(isScratchDetachedWorktree('', tmpdir())).toBe(false)
  })
})
