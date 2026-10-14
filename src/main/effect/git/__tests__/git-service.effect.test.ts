import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Effect, Either } from 'effect'
import simpleGit from 'simple-git'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GitLive, resolveGitWorktreesDir } from '../layers'
import { Git } from '../service'

const runGit = <A, E>(program: Effect.Effect<A, E, Git>) =>
  Effect.runPromise(Effect.either(Effect.provide(program, GitLive)))

describe('GitLive', () => {
  let repoPath: string
  let homePath: string

  beforeEach(async () => {
    repoPath = mkdtempSync(join(tmpdir(), 'hive-git-effect-'))
    homePath = mkdtempSync(join(tmpdir(), 'hive-home-'))
    vi.stubEnv('HOME', homePath)
    const git = simpleGit(repoPath)
    await git.init()
    await git.addConfig('user.email', 'test@test.com')
    await git.addConfig('user.name', 'Test')
    writeFileSync(join(repoPath, 'a.txt'), 'original\n')
    await git.add('.')
    await git.commit('init')
  })

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true })
    rmSync(homePath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('resolves project worktree directories from the Node home directory', () => {
    expect(resolveGitWorktreesDir('project-a', '/tmp/hive-home-test')).toBe(
      join('/tmp/hive-home-test', '.hive-worktrees', 'project-a')
    )
  })

  it('stages and commits through the Git service', async () => {
    writeFileSync(join(repoPath, 'a.txt'), 'changed\n')
    const result = await runGit(
      Effect.gen(function* () {
        const git = yield* Git
        yield* git.file.stage(repoPath, 'a.txt')
        return yield* git.commit.commit(repoPath, 'change a')
      })
    )

    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.success).toBe(true)
      expect(result.right.commitHash).toMatch(/^[a-f0-9]+$/)
    }
  })

  it('classifies operations against a non-git directory as GitNotARepository', async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'hive-not-git-'))
    try {
      const result = await runGit(Effect.flatMap(Git, (git) => git.repo.getCurrentBranch(nonRepo)))
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe('GitNotARepository')
      }
    } finally {
      rmSync(nonRepo, { recursive: true, force: true })
    }
  })

  it('classifies invalid patch hunks as GitMergeConflict apply failures', async () => {
    const badHunk = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -99,1 +99,1 @@',
      '-missing',
      '+changed'
    ].join('\n')
    const result = await runGit(Effect.flatMap(Git, (git) => git.file.stageHunk(repoPath, badHunk)))
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe('GitMergeConflict')
      if (result.left._tag === 'GitMergeConflict') {
        expect(result.left.operation).toBe('apply')
      }
    }
  })

  it('creates a worktree from a branch that is already checked out without timing out', async () => {
    const currentBranch = (await simpleGit(repoPath).branch()).current

    const result = await runGit(
      Effect.gen(function* () {
        const git = yield* Git
        return yield* git.worktree
          .createFromBranch(repoPath, 'project', currentBranch, 'dogs', undefined, {
            autoPull: false,
            nameHint: 'ticket-session'
          })
          .pipe(Effect.timeout('2 seconds'))
      })
    )

    expect(Either.isRight(result)).toBe(true)
    if (Either.isRight(result)) {
      expect(result.right.success).toBe(true)
      expect(result.right.baseBranch).toBe(currentBranch)
      expect(result.right.branchName).toBe('ticket-session')
      expect(result.right.path).toBeDefined()
      expect(existsSync(result.right.path!)).toBe(true)
    }
  })

  describe('createFromBranch auto-pull', () => {
    const createFromBranch = (branch: string, autoPull?: boolean) =>
      runGit(
        Effect.flatMap(Git, (git) =>
          git.worktree.createFromBranch(repoPath, 'project', branch, 'dogs', undefined, {
            nameHint: 'ticket',
            ...(autoPull === undefined ? {} : { autoPull })
          })
        )
      )

    const headOf = async (path: string) => (await simpleGit(path).revparse(['HEAD'])).trim()

    /**
     * A bare origin the project pushes its current branch to, plus a way to
     * land commits on origin from a second clone so origin/<branch> moves
     * ahead of the project's local branch (another machine or teammate).
     */
    const setUpOrigin = async () => {
      const originPath = join(homePath, 'origin.git')
      mkdirSync(originPath)
      await simpleGit(originPath).init(true)
      const git = simpleGit(repoPath)
      const branch = (await git.branch()).current
      await simpleGit(originPath).raw(['symbolic-ref', 'HEAD', `refs/heads/${branch}`])
      await git.addRemote('origin', originPath)
      await git.push(['-u', 'origin', branch])

      const pushFromClone = async (file: string): Promise<string> => {
        const clonePath = join(homePath, `clone-${file}`)
        await simpleGit().clone(originPath, clonePath)
        const clone = simpleGit(clonePath)
        await clone.addConfig('user.email', 'other@test.com')
        await clone.addConfig('user.name', 'Other')
        writeFileSync(join(clonePath, file), `${file}\n`)
        await clone.add('.')
        await clone.commit(`add ${file}`)
        await clone.push('origin', branch)
        return headOf(clonePath)
      }
      return { originPath, branch, pushFromClone }
    }

    it('fast-forwards the base branch checked out in the project folder before duplicating it', async () => {
      const { branch, pushFromClone } = await setUpOrigin()
      const upstreamSha = await pushFromClone('b.txt')

      const result = await createFromBranch(branch)

      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.success).toBe(true)
        expect(result.right.pullInfo).toEqual({ pulled: true, updated: true })
        expect(await headOf(result.right.path!)).toBe(upstreamSha)
        expect(existsSync(join(result.right.path!, 'b.txt'))).toBe(true)
      }
      expect(await headOf(repoPath)).toBe(upstreamSha)
    })

    it('pulls inside the linked worktree that holds the base branch, leaving the project checkout alone', async () => {
      const { branch, pushFromClone } = await setUpOrigin()
      const git = simpleGit(repoPath)
      const initialSha = await headOf(repoPath)
      await git.checkoutLocalBranch('dev')
      const baseCheckout = join(homePath, 'base-checkout')
      await git.raw(['worktree', 'add', baseCheckout, branch])
      const upstreamSha = await pushFromClone('b.txt')

      const result = await createFromBranch(branch)

      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.success).toBe(true)
        expect(result.right.pullInfo).toEqual({ pulled: true, updated: true })
        expect(await headOf(result.right.path!)).toBe(upstreamSha)
      }
      expect(await headOf(baseCheckout)).toBe(upstreamSha)
      expect((await git.branch()).current).toBe('dev')
      expect(await headOf(repoPath)).toBe(initialSha)
    })

    it('fast-forwards a base branch that is checked out nowhere', async () => {
      const { branch, pushFromClone } = await setUpOrigin()
      const git = simpleGit(repoPath)
      const initialSha = await headOf(repoPath)
      await git.checkoutLocalBranch('dev')
      const upstreamSha = await pushFromClone('b.txt')

      const result = await createFromBranch(branch)

      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.success).toBe(true)
        expect(result.right.pullInfo).toEqual({ pulled: true, updated: true })
        expect(await headOf(result.right.path!)).toBe(upstreamSha)
      }
      expect((await git.revparse([branch])).trim()).toBe(upstreamSha)
      expect((await git.branch()).current).toBe('dev')
      expect(await headOf(repoPath)).toBe(initialSha)
    })

    it('still creates the worktree from the local branch and reports the failed pull when origin is unreachable', async () => {
      const { branch, pushFromClone } = await setUpOrigin()
      await pushFromClone('b.txt')
      const localSha = await headOf(repoPath)
      await simpleGit(repoPath).remote(['set-url', 'origin', join(homePath, 'missing.git')])

      const result = await createFromBranch(branch)

      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.success).toBe(true)
        expect(result.right.pullInfo).toEqual({ pulled: false, updated: false })
        expect(await headOf(result.right.path!)).toBe(localSha)
      }
    })

    it('leaves a branch with no remote-tracking ref alone and reports it as in sync', async () => {
      const { branch } = await setUpOrigin()
      await simpleGit(repoPath).branch(['local-only', branch])

      const result = await createFromBranch('local-only')

      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.success).toBe(true)
        expect(result.right.pullInfo).toEqual({ pulled: true, updated: false })
      }
    })

    it('does not touch origin when auto-pull is off', async () => {
      const { branch, pushFromClone } = await setUpOrigin()
      await pushFromClone('b.txt')
      const localSha = await headOf(repoPath)

      const result = await createFromBranch(branch, false)

      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.success).toBe(true)
        expect(result.right.pullInfo).toEqual({ pulled: false, updated: false })
        expect(await headOf(result.right.path!)).toBe(localSha)
      }
      expect(await headOf(repoPath)).toBe(localSha)
    })
  })

  describe('worktree removal safety', () => {
    const removeViaService = (targetPath: string) =>
      runGit(Effect.flatMap(Git, (git) => git.worktree.remove(repoPath, targetPath)))

    const addManagedWorktree = async (name: string): Promise<string> => {
      const projectDir = join(homePath, '.hive-worktrees', 'project')
      mkdirSync(projectDir, { recursive: true })
      const worktreePath = join(projectDir, name)
      await simpleGit(repoPath).raw(['worktree', 'add', worktreePath, '-b', `${name}-branch`])
      return worktreePath
    }

    it('refuses to remove the main working tree and leaves it untouched', async () => {
      const result = await removeViaService(repoPath)

      expect(Either.isLeft(result)).toBe(true)
      expect(existsSync(join(repoPath, 'a.txt'))).toBe(true)
      expect(existsSync(join(repoPath, '.git'))).toBe(true)
    })

    it('refuses to remove the home directory and leaves it untouched', async () => {
      const sentinel = join(homePath, 'precious.txt')
      writeFileSync(sentinel, 'do not delete\n')

      const result = await removeViaService(homePath)

      expect(Either.isLeft(result)).toBe(true)
      expect(existsSync(sentinel)).toBe(true)
    })

    it('refuses to remove a directory that is not a registered worktree', async () => {
      const strayDir = mkdtempSync(join(tmpdir(), 'hive-stray-'))
      const sentinel = join(strayDir, 'data.txt')
      writeFileSync(sentinel, 'user data\n')
      try {
        const result = await removeViaService(strayDir)

        expect(Either.isLeft(result)).toBe(true)
        expect(existsSync(sentinel)).toBe(true)
      } finally {
        rmSync(strayDir, { recursive: true, force: true })
      }
    })

    it('archive also refuses to remove the main working tree', async () => {
      const result = await runGit(
        Effect.flatMap(Git, (git) => git.worktree.archive(repoPath, repoPath, 'some-branch'))
      )

      expect(Either.isLeft(result)).toBe(true)
      expect(existsSync(join(repoPath, 'a.txt'))).toBe(true)
    })

    it('still removes a healthy managed linked worktree', async () => {
      const worktreePath = await addManagedWorktree('wt-healthy')
      expect(existsSync(worktreePath)).toBe(true)

      const result = await removeViaService(worktreePath)

      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) expect(result.right.success).toBe(true)
      expect(existsSync(worktreePath)).toBe(false)
    })

    it('prunes a stale registration whose directory is already gone', async () => {
      const worktreePath = await addManagedWorktree('wt-stale')
      rmSync(worktreePath, { recursive: true, force: true })

      const result = await removeViaService(worktreePath)

      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) expect(result.right.success).toBe(true)
      const list = await simpleGit(repoPath).raw(['worktree', 'list', '--porcelain'])
      expect(list).not.toContain('wt-stale')
    })

    it('deletes a corrupted managed worktree via the guarded fallback', async () => {
      const worktreePath = await addManagedWorktree('wt-corrupt')
      // Breaking the .git link makes `git worktree remove` fail validation,
      // which exercises the rmSync fallback path.
      unlinkSync(join(worktreePath, '.git'))

      const result = await removeViaService(worktreePath)

      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) expect(result.right.success).toBe(true)
      expect(existsSync(worktreePath)).toBe(false)
    })

    it('deletes a leftover directory that git already deregistered (partial remove)', async () => {
      const worktreePath = await addManagedWorktree('wt-leftover')
      // Incident shape: `git worktree remove --force` deleted the .git link and
      // the registration but failed with "Directory not empty" because a
      // session was still writing into the checkout.
      unlinkSync(join(worktreePath, '.git'))
      await simpleGit(repoPath).raw(['worktree', 'prune'])
      writeFileSync(join(worktreePath, 'late-output.txt'), 'written after removal\n')

      const result = await removeViaService(worktreePath)

      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) expect(result.right.success).toBe(true)
      expect(existsSync(worktreePath)).toBe(false)
    })

    it('still refuses a deregistered directory that became a working tree of its own', async () => {
      const worktreePath = await addManagedWorktree('wt-foreign')
      unlinkSync(join(worktreePath, '.git'))
      await simpleGit(repoPath).raw(['worktree', 'prune'])
      await simpleGit(worktreePath).init()
      const sentinel = join(worktreePath, 'a.txt')
      expect(existsSync(sentinel)).toBe(true)

      const result = await removeViaService(worktreePath)

      expect(Either.isLeft(result)).toBe(true)
      expect(existsSync(sentinel)).toBe(true)
    })
  })
})
