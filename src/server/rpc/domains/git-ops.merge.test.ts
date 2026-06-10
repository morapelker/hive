import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../../main/services/telemetry-service', () => ({
  telemetryService: { track: vi.fn() }
}))

import { makeLiveGitOpsRpcService } from './git-ops'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' })

describe('gitOps merge conflict extraction', () => {
  let repoPath: string
  const service = makeLiveGitOpsRpcService()

  beforeAll(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'hive-merge-test-'))
    git(repoPath, 'init', '-b', 'main')
    git(repoPath, 'config', 'user.email', 'test@test.local')
    git(repoPath, 'config', 'user.name', 'Test')
    git(repoPath, 'config', 'commit.gpgsign', 'false')

    writeFileSync(join(repoPath, 'shared.txt'), 'base\n')
    git(repoPath, 'add', '.')
    git(repoPath, 'commit', '-m', 'base')

    git(repoPath, 'checkout', '-b', 'feature')
    writeFileSync(join(repoPath, 'shared.txt'), 'feature change\n')
    git(repoPath, 'commit', '-am', 'feature change')

    git(repoPath, 'checkout', 'main')
    writeFileSync(join(repoPath, 'shared.txt'), 'main change\n')
    git(repoPath, 'commit', '-am', 'main change')
  })

  afterAll(() => {
    rmSync(repoPath, { recursive: true, force: true })
  })

  it('returns conflicted files when the merge has conflicts', async () => {
    const result = await Effect.runPromise(
      service.merge(repoPath, 'feature').pipe(Effect.orDie)
    )

    expect(result.success).toBe(false)
    expect(result.conflicts).toEqual(['shared.txt'])

    git(repoPath, 'merge', '--abort')
  })

  it('returns a plain error without conflicts for non-conflict failures', async () => {
    const result = await Effect.runPromise(
      service.merge(repoPath, 'no-such-branch').pipe(Effect.orDie)
    )

    expect(result.success).toBe(false)
    expect(result.conflicts).toBeUndefined()
    expect(result.error).toBeTruthy()
  })

  it('returns success on a clean merge', async () => {
    git(repoPath, 'checkout', '-b', 'clean-feature')
    writeFileSync(join(repoPath, 'other.txt'), 'no conflict\n')
    git(repoPath, 'add', '.')
    git(repoPath, 'commit', '-m', 'clean change')
    git(repoPath, 'checkout', 'main')

    const result = await Effect.runPromise(
      service.merge(repoPath, 'clean-feature').pipe(Effect.orDie)
    )

    expect(result).toEqual({ success: true })
  })
})
