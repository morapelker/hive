import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { resolveTeleportTargetBranch, slug } from '../teleport-ops'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

function configRepo(repoPath: string): void {
  git(repoPath, 'config', 'user.email', 'teleport@test')
  git(repoPath, 'config', 'user.name', 'Teleport Test')
  git(repoPath, 'config', 'commit.gpgsign', 'false')
}

function buildUpstream(root: string): { upstream: string; defaultBranch: string; c1: string; c2: string } {
  const upstream = join(root, 'upstream')
  mkdirSync(upstream)
  git(upstream, 'init', '-q')
  configRepo(upstream)
  writeFileSync(join(upstream, 'a.txt'), 'one')
  git(upstream, 'add', '.')
  git(upstream, 'commit', '-q', '-m', 'c1')
  const c1 = git(upstream, 'rev-parse', 'HEAD')
  const defaultBranch = git(upstream, 'rev-parse', '--abbrev-ref', 'HEAD')

  git(upstream, 'checkout', '-q', '-b', 'feature')
  writeFileSync(join(upstream, 'a.txt'), 'two')
  git(upstream, 'add', '.')
  git(upstream, 'commit', '-q', '-m', 'c2')
  const c2 = git(upstream, 'rev-parse', 'HEAD')
  git(upstream, 'checkout', '-q', defaultBranch)
  return { upstream, defaultBranch, c1, c2 }
}

describe('resolveTeleportTargetBranch', () => {
  it('force-moves a stale local branch to the pushed headSha', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-teleport-branch-'))
    tempDirs.push(root)
    const { upstream, c1, c2 } = buildUpstream(root)

    const project = join(root, 'project')
    git(root, 'clone', '-q', upstream, 'project')
    configRepo(project)

    // Simulate a stale local branch left from a previous teleport: feature
    // exists locally at the OLD commit and is NOT checked out.
    git(project, 'branch', 'feature', c1)
    expect(git(project, 'rev-parse', 'refs/heads/feature')).toBe(c1)

    const target = await resolveTeleportTargetBranch(project, 'feature', c2)

    expect(target).toBe('feature')
    // The bug: without the unconditional `branch -f`, this would still be c1.
    expect(git(project, 'rev-parse', 'refs/heads/feature')).toBe(c2)
  })

  it('uses a fresh teleport/<sha> branch when the target branch is checked out', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-teleport-branch-'))
    tempDirs.push(root)
    const { upstream, c1, c2 } = buildUpstream(root)

    const project = join(root, 'project')
    git(root, 'clone', '-q', upstream, 'project')
    configRepo(project)

    // feature is checked out in this repo, so it cannot be reused for a worktree.
    git(project, 'checkout', '-q', '-b', 'feature', 'origin/feature')
    expect(git(project, 'rev-parse', 'HEAD')).toBe(c2)

    const target = await resolveTeleportTargetBranch(project, 'feature', c1)

    expect(target).toBe(`teleport/${c1.slice(0, 8)}`)
    expect(git(project, 'rev-parse', `refs/heads/${target}`)).toBe(c1)
    // The checked-out feature branch is left untouched at c2.
    expect(git(project, 'rev-parse', 'refs/heads/feature')).toBe(c2)
  })
})

describe('slug', () => {
  it('slugifies a normal branch name', () => {
    expect(slug('feature/My Cool Thing')).toBe('feature/my-cool-thing')
  })

  it('falls back to a stable default for separator-only branches', () => {
    expect(slug('---')).toBe('teleport')
    expect(slug('.')).toBe('teleport')
  })
})
