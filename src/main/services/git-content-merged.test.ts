import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mergeChangesNothing } from './git-content-merged'

describe('mergeChangesNothing', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  const git = (cwd: string, args: string[]): void => {
    execFileSync('git', args, { cwd, stdio: 'ignore' })
  }

  const commitFile = (cwd: string, name: string, content: string, message: string): void => {
    writeFileSync(join(cwd, name), content)
    git(cwd, ['add', name])
    git(cwd, ['commit', '-m', message])
  }

  /** `main` with one commit, and `feature` three commits ahead of it; `main` checked out. */
  const makeRepo = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-content-merged-'))
    tempDirs.push(dir)
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    commitFile(dir, 'shared.txt', 'a\nb\nc\nd\ne\n', 'initial')
    git(dir, ['branch', '-M', 'main'])
    git(dir, ['checkout', '-b', 'feature'])
    commitFile(dir, 'shared.txt', 'a\nB\nc\nd\ne\n', 'edit shared')
    commitFile(dir, 'feature.txt', 'feature\n', 'add feature')
    commitFile(dir, 'more.txt', 'more\n', 'add more')
    git(dir, ['checkout', 'main'])
    return dir
  }

  const squashMerge = (dir: string): void => {
    git(dir, ['merge', '--squash', 'feature'])
    git(dir, ['commit', '-m', 'feature (#1)'])
  }

  it('is false for a branch whose work is not on the target', async () => {
    const dir = makeRepo()

    await expect(mergeChangesNothing(dir, 'main', 'feature')).resolves.toBe(false)
  })

  it('is true once the branch was squash-merged, also after the target moved on', async () => {
    const dir = makeRepo()
    commitFile(dir, 'before.txt', 'before\n', 'unrelated work before the squash')
    squashMerge(dir)

    await expect(mergeChangesNothing(dir, 'main', 'feature')).resolves.toBe(true)

    commitFile(dir, 'after.txt', 'after\n', 'unrelated work after the squash')

    await expect(mergeChangesNothing(dir, 'main', 'feature')).resolves.toBe(true)
  })

  it('reads HEAD as the branch from a checkout of it', async () => {
    const dir = makeRepo()
    squashMerge(dir)
    git(dir, ['checkout', 'feature'])

    await expect(mergeChangesNothing(dir, 'main', 'HEAD')).resolves.toBe(true)
  })

  it('is false when the branch got another commit after the squash', async () => {
    const dir = makeRepo()
    squashMerge(dir)
    git(dir, ['checkout', 'feature'])
    commitFile(dir, 'late.txt', 'late\n', 'one more thing')
    git(dir, ['checkout', 'main'])

    await expect(mergeChangesNothing(dir, 'main', 'feature')).resolves.toBe(false)
  })

  it('is false when the squash was reverted on the target', async () => {
    const dir = makeRepo()
    squashMerge(dir)
    git(dir, ['revert', '--no-edit', 'HEAD'])

    await expect(mergeChangesNothing(dir, 'main', 'feature')).resolves.toBe(false)
  })

  it('is false when the dry-run merge conflicts: the target rewrote the same line since', async () => {
    const dir = makeRepo()
    squashMerge(dir)
    commitFile(dir, 'shared.txt', 'a\nB2\nc\nd\ne\n', 'rewrite the line the branch changed')

    await expect(mergeChangesNothing(dir, 'main', 'feature')).resolves.toBe(false)
  })

  it('is false for a revision that does not exist, and for one that reads as an option', async () => {
    const dir = makeRepo()

    await expect(mergeChangesNothing(dir, 'main', 'missing')).resolves.toBe(false)
    await expect(mergeChangesNothing(dir, 'missing', 'feature')).resolves.toBe(false)
    await expect(mergeChangesNothing(dir, 'main', '--help')).resolves.toBe(false)
    await expect(mergeChangesNothing(join(dir, 'nowhere'), 'main', 'feature')).resolves.toBe(false)
  })

  it('leaves the working tree and the refs alone', async () => {
    const dir = makeRepo()
    squashMerge(dir)
    const snapshot = (): string =>
      execFileSync('git', ['status', '--porcelain=v2', '--branch'], { cwd: dir }).toString() +
      execFileSync('git', ['for-each-ref'], { cwd: dir }).toString()
    const before = snapshot()

    await mergeChangesNothing(dir, 'main', 'feature')

    expect(snapshot()).toBe(before)
  })
})
