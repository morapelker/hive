import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Effect, Either } from 'effect'
import simpleGit from 'simple-git'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { GitLive } from '../layers'
import { Git } from '../service'

const runGit = <A, E>(program: Effect.Effect<A, E, Git>) =>
  Effect.runPromise(Effect.either(Effect.provide(program, GitLive)))

describe('GitLive', () => {
  let repoPath: string

  beforeEach(async () => {
    repoPath = mkdtempSync(join(tmpdir(), 'hive-git-effect-'))
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
})
