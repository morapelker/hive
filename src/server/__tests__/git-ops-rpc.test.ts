import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeDesktopCommandResult, type DesktopCommandRequest } from '@shared/desktop-command'
import { cleanupBranchWatchers } from '../../main/services/branch-watcher'
import { cleanupWorktreeWatchers } from '../../main/services/worktree-watcher'
import { makeLiveGitOpsRpcService } from '../rpc/domains/git-ops'

vi.mock('electron', () => ({
  app: {
    getPath: (name: string): string => {
      if (name === 'home') return '/tmp/hive-test-mock-home'
      return `/tmp/hive-test-mock-${name}`
    },
    getVersion: (): string => '1.1.10',
    quit: (): void => {}
  },
  shell: {
    showItemInFolder: vi.fn()
  }
}))

const originalProcessSend = process.send
const originalProcessOn = process.on
const originalProcessOff = process.off

describe('git ops RPC domain', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await cleanupWorktreeWatchers()
    await cleanupBranchWatchers()
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
    if (originalProcessSend) process.send = originalProcessSend
    else delete process.send
  })

  const makeTempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-git-ops-rpc-'))
    tempDirs.push(dir)
    return dir
  }

  const git = (cwd: string, args: string[]): void => {
    execFileSync('git', args, { cwd, stdio: 'ignore' })
  }

  it('returns an empty successful status for non-git directories', async () => {
    const dir = makeTempDir()
    const service = makeLiveGitOpsRpcService()

    const result = await Effect.runPromise(service.getFileStatuses(dir))

    expect(result).toEqual({ success: true, files: [] })
  })

  it('returns staged, unstaged, and untracked file statuses from a git worktree', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'original\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'initial'])

    writeFileSync(join(dir, 'tracked.txt'), 'changed\n')
    writeFileSync(join(dir, 'staged.txt'), 'staged\n')
    git(dir, ['add', 'staged.txt'])
    writeFileSync(join(dir, 'untracked.txt'), 'untracked\n')

    const service = makeLiveGitOpsRpcService()
    const result = await Effect.runPromise(service.getFileStatuses(dir))

    expect(result.success).toBe(true)
    expect(result.files).toEqual(
      expect.arrayContaining([
        {
          path: join(dir, 'tracked.txt'),
          relativePath: 'tracked.txt',
          status: 'M',
          staged: false
        },
        {
          path: join(dir, 'staged.txt'),
          relativePath: 'staged.txt',
          status: 'A',
          staged: true
        },
        {
          path: join(dir, 'untracked.txt'),
          relativePath: 'untracked.txt',
          status: '?',
          staged: false
        }
      ])
    )
  })

  it('returns branch info from a git worktree', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'original\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'initial'])
    git(dir, ['branch', '-M', 'main'])

    const service = makeLiveGitOpsRpcService()
    const result = await Effect.runPromise(service.getBranchInfo(dir))

    expect(result).toEqual({
      success: true,
      branch: {
        name: 'main',
        tracking: null,
        ahead: 0,
        behind: 0
      }
    })
  })

  it('stages a file in a git worktree', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'original\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'initial'])
    writeFileSync(join(dir, 'tracked.txt'), 'changed\n')

    const service = makeLiveGitOpsRpcService()
    const result = await Effect.runPromise(service.stageFile(dir, 'tracked.txt'))
    const status = await Effect.runPromise(service.getFileStatuses(dir))

    expect(result).toEqual({ success: true })
    expect(status.files).toEqual(
      expect.arrayContaining([
        {
          path: join(dir, 'tracked.txt'),
          relativePath: 'tracked.txt',
          status: 'M',
          staged: true
        }
      ])
    )
  })

  it('stages all changes in a git worktree', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'original\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'initial'])
    writeFileSync(join(dir, 'tracked.txt'), 'changed\n')
    writeFileSync(join(dir, 'new.txt'), 'new\n')

    const service = makeLiveGitOpsRpcService()
    const result = await Effect.runPromise(service.stageAll(dir))
    const status = await Effect.runPromise(service.getFileStatuses(dir))

    expect(result).toEqual({ success: true })
    expect(status.files).toEqual(
      expect.arrayContaining([
        {
          path: join(dir, 'tracked.txt'),
          relativePath: 'tracked.txt',
          status: 'M',
          staged: true
        },
        {
          path: join(dir, 'new.txt'),
          relativePath: 'new.txt',
          status: 'A',
          staged: true
        }
      ])
    )
  })

  it('unstages all staged changes in a git worktree', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'original\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'initial'])
    writeFileSync(join(dir, 'tracked.txt'), 'changed\n')
    writeFileSync(join(dir, 'new.txt'), 'new\n')
    git(dir, ['add', '-A'])

    const service = makeLiveGitOpsRpcService()
    const result = await Effect.runPromise(service.unstageAll(dir))
    const status = await Effect.runPromise(service.getFileStatuses(dir))

    expect(result).toEqual({ success: true })
    expect(status.files).toEqual(
      expect.arrayContaining([
        {
          path: join(dir, 'tracked.txt'),
          relativePath: 'tracked.txt',
          status: 'M',
          staged: false
        },
        {
          path: join(dir, 'new.txt'),
          relativePath: 'new.txt',
          status: '?',
          staged: false
        }
      ])
    )
  })

  it('stages a single hunk patch in a git worktree', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'original\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'initial'])
    writeFileSync(join(dir, 'tracked.txt'), 'changed\n')
    const patch = execFileSync('git', ['diff', '--unified=0', '--', 'tracked.txt'], {
      cwd: dir,
      encoding: 'utf8'
    })

    const service = makeLiveGitOpsRpcService()
    const result = await Effect.runPromise(service.stageHunk(dir, patch))
    const cachedDiff = execFileSync('git', ['diff', '--cached', '--', 'tracked.txt'], {
      cwd: dir,
      encoding: 'utf8'
    })

    expect(result).toEqual({ success: true })
    expect(cachedDiff).toContain('-original')
    expect(cachedDiff).toContain('+changed')
    await expect(Effect.runPromise(service.stageHunk(dir, 'not a patch'))).resolves.toEqual(
      expect.objectContaining({
        success: false,
        error: expect.any(String)
      })
    )
  })

  it('unstages a single hunk patch in a git worktree', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'original\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'initial'])
    writeFileSync(join(dir, 'tracked.txt'), 'changed\n')
    git(dir, ['add', 'tracked.txt'])
    const patch = execFileSync('git', ['diff', '--cached', '--unified=0', '--', 'tracked.txt'], {
      cwd: dir,
      encoding: 'utf8'
    })

    const service = makeLiveGitOpsRpcService()
    const result = await Effect.runPromise(service.unstageHunk(dir, patch))
    const cachedDiff = execFileSync('git', ['diff', '--cached', '--', 'tracked.txt'], {
      cwd: dir,
      encoding: 'utf8'
    })
    const worktreeDiff = execFileSync('git', ['diff', '--', 'tracked.txt'], {
      cwd: dir,
      encoding: 'utf8'
    })

    expect(result).toEqual({ success: true })
    expect(cachedDiff).toBe('')
    expect(worktreeDiff).toContain('-original')
    expect(worktreeDiff).toContain('+changed')
    await expect(Effect.runPromise(service.unstageHunk(dir, 'not a patch'))).resolves.toEqual(
      expect.objectContaining({
        success: false,
        error: expect.any(String)
      })
    )
  })

  it('reverts a single hunk patch in a git worktree', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'original\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'initial'])
    writeFileSync(join(dir, 'tracked.txt'), 'changed\n')
    const patch = execFileSync('git', ['diff', '--unified=0', '--', 'tracked.txt'], {
      cwd: dir,
      encoding: 'utf8'
    })

    const service = makeLiveGitOpsRpcService()
    const result = await Effect.runPromise(service.revertHunk(dir, patch))
    const content = readFileSync(join(dir, 'tracked.txt'), 'utf8')
    const worktreeDiff = execFileSync('git', ['diff', '--', 'tracked.txt'], {
      cwd: dir,
      encoding: 'utf8'
    })

    expect(result).toEqual({ success: true })
    expect(content).toBe('original\n')
    expect(worktreeDiff).toBe('')
    await expect(Effect.runPromise(service.revertHunk(dir, 'not a patch'))).resolves.toEqual(
      expect.objectContaining({
        success: false,
        error: expect.any(String)
      })
    )
  })

  it('commits staged changes in a git worktree', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'original\n')
    git(dir, ['add', 'tracked.txt'])

    const track = vi.fn()
    const service = makeLiveGitOpsRpcService({ track })
    const result = await Effect.runPromise(service.commit(dir, 'initial commit'))
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8'
    }).trim()

    expect(result).toEqual({ success: true, commitHash: head })
    expect(track).toHaveBeenCalledWith('git_commit_made')
  })

  it('returns the legacy commit validation error for an empty commit message', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'original\n')
    git(dir, ['add', 'tracked.txt'])

    const service = makeLiveGitOpsRpcService()
    const result = await Effect.runPromise(service.commit(dir, '   '))

    expect(result).toEqual({ success: false, error: 'Commit message is required' })
  })

  it('pushes committed changes to the default remote and current branch', async () => {
    const dir = makeTempDir()
    const remoteDir = makeTempDir()
    git(remoteDir, ['init', '--bare'])
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'original\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'initial'])
    git(dir, ['branch', '-M', 'main'])
    git(dir, ['remote', 'add', 'origin', remoteDir])
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8'
    }).trim()

    const track = vi.fn()
    const service = makeLiveGitOpsRpcService({ track })
    const result = await Effect.runPromise(service.push(dir))
    const remoteHead = execFileSync('git', ['rev-parse', 'main'], {
      cwd: remoteDir,
      encoding: 'utf8'
    }).trim()

    expect(result).toEqual({ success: true, pushed: true })
    expect(remoteHead).toBe(head)
    expect(track).toHaveBeenCalledWith('git_push_made')
  })

  it('pulls committed changes from the default remote and current branch', async () => {
    const remoteDir = makeTempDir()
    const seedDir = makeTempDir()
    const dir = makeTempDir()
    git(remoteDir, ['init', '--bare'])
    git(seedDir, ['init'])
    git(seedDir, ['config', 'user.email', 'hive@example.test'])
    git(seedDir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(seedDir, 'tracked.txt'), 'original\n')
    git(seedDir, ['add', 'tracked.txt'])
    git(seedDir, ['commit', '-m', 'initial'])
    git(seedDir, ['branch', '-M', 'main'])
    git(seedDir, ['remote', 'add', 'origin', remoteDir])
    git(seedDir, ['push', '-u', 'origin', 'main'])
    git(remoteDir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    rmSync(dir, { recursive: true, force: true })
    execFileSync('git', ['clone', remoteDir, dir], { stdio: 'ignore' })

    writeFileSync(join(seedDir, 'tracked.txt'), 'updated\n')
    git(seedDir, ['add', 'tracked.txt'])
    git(seedDir, ['commit', '-m', 'update tracked'])
    git(seedDir, ['push', 'origin', 'main'])

    const service = makeLiveGitOpsRpcService()
    const result = await Effect.runPromise(service.pull(dir))

    expect(result).toEqual({ success: true, updated: true })
    expect(readFileSync(join(dir, 'tracked.txt'), 'utf8')).toBe('updated\n')
  })

  it('merges a branch into the current git worktree branch', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'original\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'initial'])
    git(dir, ['branch', '-M', 'main'])
    git(dir, ['checkout', '-b', 'feature'])
    writeFileSync(join(dir, 'feature.txt'), 'feature\n')
    git(dir, ['add', 'feature.txt'])
    git(dir, ['commit', '-m', 'add feature'])
    git(dir, ['checkout', 'main'])

    const service = makeLiveGitOpsRpcService()
    const result = await Effect.runPromise(service.merge(dir, 'feature'))

    expect(result).toEqual({ success: true })
    expect(readFileSync(join(dir, 'feature.txt'), 'utf8')).toBe('feature\n')
  })

  it('aborts an in-progress merge in a git worktree', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'conflict.txt'), 'original\n')
    git(dir, ['add', 'conflict.txt'])
    git(dir, ['commit', '-m', 'initial'])
    git(dir, ['branch', '-M', 'main'])
    git(dir, ['checkout', '-b', 'feature'])
    writeFileSync(join(dir, 'conflict.txt'), 'feature\n')
    git(dir, ['add', 'conflict.txt'])
    git(dir, ['commit', '-m', 'feature change'])
    git(dir, ['checkout', 'main'])
    writeFileSync(join(dir, 'conflict.txt'), 'main\n')
    git(dir, ['add', 'conflict.txt'])
    git(dir, ['commit', '-m', 'main change'])

    try {
      execFileSync('git', ['merge', 'feature'], { cwd: dir, stdio: 'ignore' })
    } catch {
      // Expected: the branches modify the same line and leave an in-progress merge.
    }
    expect(existsSync(join(dir, '.git', 'MERGE_HEAD'))).toBe(true)

    const service = makeLiveGitOpsRpcService()
    const result = await Effect.runPromise(service.mergeAbort(dir))

    expect(result).toEqual({ success: true })
    expect(existsSync(join(dir, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(readFileSync(join(dir, 'conflict.txt'), 'utf8')).toBe('main\n')
  })

  it('detects uncommitted changes in a git worktree', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'original\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'initial'])

    const service = makeLiveGitOpsRpcService()
    await expect(Effect.runPromise(service.hasUncommittedChanges(dir))).resolves.toBe(false)

    writeFileSync(join(dir, 'tracked.txt'), 'changed\n')

    await expect(Effect.runPromise(service.hasUncommittedChanges(dir))).resolves.toBe(true)
    await expect(
      Effect.runPromise(service.hasUncommittedChanges(join(dir, 'missing')))
    ).resolves.toBe(false)
  })

  it('returns branch diff short stats for commits ahead of a base branch', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'original\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'initial'])
    git(dir, ['branch', '-M', 'main'])
    git(dir, ['checkout', '-b', 'feature'])
    writeFileSync(join(dir, 'feature.txt'), 'feature\n')
    git(dir, ['add', 'feature.txt'])
    git(dir, ['commit', '-m', 'add feature'])

    const service = makeLiveGitOpsRpcService()
    const result = await Effect.runPromise(service.branchDiffShortStat(dir, 'main'))

    expect(result).toEqual({
      success: true,
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
      commitsAhead: 1
    })
  })

  it('returns tracked and untracked file diffs from a git worktree', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'original\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'initial'])

    writeFileSync(join(dir, 'tracked.txt'), 'changed\n')
    writeFileSync(join(dir, 'new.txt'), 'created\n')

    const service = makeLiveGitOpsRpcService()

    const tracked = await Effect.runPromise(service.getDiff(dir, 'tracked.txt', false, false, 1))
    expect(tracked).toEqual(
      expect.objectContaining({
        success: true,
        fileName: 'tracked.txt'
      })
    )
    expect(tracked.diff).toContain('diff --git a/tracked.txt b/tracked.txt')
    expect(tracked.diff).toContain('-original')
    expect(tracked.diff).toContain('+changed')

    const untracked = await Effect.runPromise(service.getDiff(dir, 'new.txt', false, true))
    expect(untracked).toEqual(
      expect.objectContaining({
        success: true,
        fileName: 'new.txt'
      })
    )
    expect(untracked.diff).toContain('new file mode 100644')
    expect(untracked.diff).toContain('+++ b/new.txt')
    expect(untracked.diff).toContain('+created')
  })

  it('lists local and remote branches with checkout status', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'original\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'initial'])
    git(dir, ['branch', '-M', 'main'])
    git(dir, ['branch', 'feature'])
    git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])

    const service = makeLiveGitOpsRpcService()
    const result = await Effect.runPromise(service.listBranchesWithStatus(dir))

    expect(result).toEqual({
      success: true,
      branches: expect.arrayContaining([
        {
          name: 'main',
          isRemote: false,
          isCheckedOut: true,
          worktreePath: dir
        },
        {
          name: 'feature',
          isRemote: false,
          isCheckedOut: false,
          worktreePath: undefined
        },
        {
          name: 'origin/main',
          isRemote: true,
          isCheckedOut: false,
          worktreePath: undefined
        }
      ])
    })
  })

  it('reads file content from a worktree path', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'plain.txt'), 'hello\n')

    const service = makeLiveGitOpsRpcService()
    const result = await Effect.runPromise(service.getFileContent(dir, 'plain.txt'))

    expect(result).toEqual({
      success: true,
      content: 'hello\n'
    })
    await expect(Effect.runPromise(service.getFileContent(dir, 'missing.txt'))).resolves.toEqual(
      expect.objectContaining({
        success: false,
        content: null,
        error: expect.any(String)
      })
    )
  })

  it('reads file content from a git ref', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'committed\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'initial'])
    writeFileSync(join(dir, 'tracked.txt'), 'indexed\n')
    git(dir, ['add', 'tracked.txt'])
    writeFileSync(join(dir, 'tracked.txt'), 'working\n')

    const service = makeLiveGitOpsRpcService()

    await expect(
      Effect.runPromise(service.getRefContent(dir, 'HEAD', 'tracked.txt'))
    ).resolves.toEqual({
      success: true,
      content: 'committed\n'
    })
    await expect(Effect.runPromise(service.getRefContent(dir, '', 'tracked.txt'))).resolves.toEqual(
      {
        success: true,
        content: 'indexed\n'
      }
    )
    await expect(
      Effect.runPromise(service.getRefContent(dir, 'HEAD', 'missing.txt'))
    ).resolves.toEqual(
      expect.objectContaining({
        success: false,
        error: expect.any(String)
      })
    )
  })

  it('reads file content from a branch merge base', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'base\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'initial'])
    git(dir, ['branch', '-M', 'main'])
    git(dir, ['checkout', '-b', 'feature'])
    writeFileSync(join(dir, 'tracked.txt'), 'feature\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'feature changes'])

    const service = makeLiveGitOpsRpcService()

    await expect(
      Effect.runPromise(service.getBranchBaseContent(dir, 'main', 'tracked.txt'))
    ).resolves.toEqual({
      success: true,
      content: 'base\n'
    })
    await expect(
      Effect.runPromise(service.getBranchBaseContent(dir, '-bad', 'tracked.txt'))
    ).resolves.toEqual({
      success: false,
      error: 'Invalid branch name'
    })
  })

  it('reads file content as base64 from a branch merge base', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'image.png'), Buffer.from('base-binary'))
    git(dir, ['add', 'image.png'])
    git(dir, ['commit', '-m', 'initial'])
    git(dir, ['branch', '-M', 'main'])
    git(dir, ['checkout', '-b', 'feature'])
    writeFileSync(join(dir, 'image.png'), Buffer.from('feature-binary'))
    git(dir, ['add', 'image.png'])
    git(dir, ['commit', '-m', 'feature changes'])

    const service = makeLiveGitOpsRpcService()

    await expect(
      Effect.runPromise(service.getBranchBaseContentBase64(dir, 'main', 'image.png'))
    ).resolves.toEqual({
      success: true,
      data: Buffer.from('base-binary').toString('base64'),
      mimeType: 'image/png'
    })
    await expect(
      Effect.runPromise(service.getBranchBaseContentBase64(dir, '-bad', 'image.png'))
    ).resolves.toEqual({
      success: false,
      error: 'Invalid branch name'
    })
  })

  it('reads file content as base64 from a git ref', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'image.png'), Buffer.from('committed-binary'))
    git(dir, ['add', 'image.png'])
    git(dir, ['commit', '-m', 'initial'])
    writeFileSync(join(dir, 'image.png'), Buffer.from('indexed-binary'))
    git(dir, ['add', 'image.png'])
    writeFileSync(join(dir, 'image.png'), Buffer.from('working-binary'))

    const service = makeLiveGitOpsRpcService()

    await expect(
      Effect.runPromise(service.getRefContentBase64(dir, 'HEAD', 'image.png'))
    ).resolves.toEqual({
      success: true,
      data: Buffer.from('committed-binary').toString('base64'),
      mimeType: 'image/png'
    })
    await expect(
      Effect.runPromise(service.getRefContentBase64(dir, '', 'image.png'))
    ).resolves.toEqual({
      success: true,
      data: Buffer.from('indexed-binary').toString('base64'),
      mimeType: 'image/png'
    })
    await expect(
      Effect.runPromise(service.getRefContentBase64(dir, 'HEAD', 'missing.png'))
    ).resolves.toEqual(
      expect.objectContaining({
        success: false,
        error: expect.any(String)
      })
    )
  })

  it('reads file content as base64 from a worktree path', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'image.png'), Buffer.from('hello'))

    const service = makeLiveGitOpsRpcService()
    const result = await Effect.runPromise(service.getFileContentBase64(dir, 'image.png'))

    expect(result).toEqual({
      success: true,
      data: 'aGVsbG8=',
      mimeType: 'image/png'
    })
    await expect(
      Effect.runPromise(service.getFileContentBase64(dir, 'missing.png'))
    ).resolves.toEqual(
      expect.objectContaining({
        success: false,
        error: 'File does not exist'
      })
    )
  })

  it('returns the configured remote URL for a git worktree', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['remote', 'add', 'origin', 'https://github.com/example/hive.git'])

    const service = makeLiveGitOpsRpcService()

    await expect(Effect.runPromise(service.getRemoteUrl(dir))).resolves.toEqual({
      success: true,
      url: 'https://github.com/example/hive.git',
      remote: 'origin'
    })
    await expect(Effect.runPromise(service.getRemoteUrl(dir, 'upstream'))).resolves.toEqual({
      success: true,
      url: null,
      remote: null
    })
  })

  it('returns diff stats for staged, unstaged, and untracked files', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'one\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'initial'])
    writeFileSync(join(dir, 'tracked.txt'), 'one\ntwo\n')
    git(dir, ['add', 'tracked.txt'])
    writeFileSync(join(dir, 'tracked.txt'), 'one\ntwo\nthree\n')
    writeFileSync(join(dir, 'untracked.txt'), 'alpha\nbeta')

    const service = makeLiveGitOpsRpcService()
    const result = await Effect.runPromise(service.getDiffStat(dir))

    expect(result).toEqual({
      success: true,
      files: expect.arrayContaining([
        { path: 'tracked.txt', additions: 2, deletions: 0, binary: false },
        { path: 'untracked.txt', additions: 2, deletions: 0, binary: false }
      ])
    })
  })

  it('returns merge-base branch diff files for a git worktree', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'original\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'initial'])
    git(dir, ['branch', '-M', 'main'])
    git(dir, ['checkout', '-b', 'feature'])
    writeFileSync(join(dir, 'tracked.txt'), 'changed\n')
    writeFileSync(join(dir, 'new.txt'), 'created\n')
    git(dir, ['add', 'tracked.txt', 'new.txt'])
    git(dir, ['commit', '-m', 'feature changes'])

    const service = makeLiveGitOpsRpcService()

    await expect(Effect.runPromise(service.getBranchDiffFiles(dir, 'main'))).resolves.toEqual({
      success: true,
      files: expect.arrayContaining([
        {
          relativePath: 'tracked.txt',
          status: 'M',
          additions: 1,
          deletions: 1,
          binary: false
        },
        {
          relativePath: 'new.txt',
          status: 'A',
          additions: 1,
          deletions: 0,
          binary: false
        }
      ])
    })
    await expect(Effect.runPromise(service.getBranchDiffFiles(dir, '-bad'))).resolves.toEqual({
      success: false,
      error: 'Invalid branch name'
    })
  })

  it('returns a merge-base branch file diff for a git worktree', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'original\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'initial'])
    git(dir, ['branch', '-M', 'main'])
    git(dir, ['checkout', '-b', 'feature'])
    writeFileSync(join(dir, 'tracked.txt'), 'changed\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'feature changes'])

    const service = makeLiveGitOpsRpcService()
    const result = await Effect.runPromise(service.getBranchFileDiff(dir, 'main', 'tracked.txt'))

    expect(result).toEqual(
      expect.objectContaining({
        success: true
      })
    )
    expect(result.diff).toContain('diff --git a/tracked.txt b/tracked.txt')
    expect(result.diff).toContain('-original')
    expect(result.diff).toContain('+changed')
    await expect(
      Effect.runPromise(service.getBranchFileDiff(dir, '-bad', 'tracked.txt'))
    ).resolves.toEqual({
      success: false,
      error: 'Invalid branch name'
    })
  })

  it('returns commit and diff summaries for a branch range', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'original\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'initial'])
    git(dir, ['branch', '-M', 'main'])
    git(dir, ['checkout', '-b', 'feature'])
    writeFileSync(join(dir, 'tracked.txt'), 'changed\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'feature changes'])

    const service = makeLiveGitOpsRpcService()
    const result = await Effect.runPromise(service.getRangeDiff(dir, 'main'))

    expect(result.commitSummary).toContain('feature changes')
    expect(result.diffSummary).toContain('tracked.txt')
    expect(result.diffPatch).toContain('diff --git a/tracked.txt b/tracked.txt')
    expect(result.diffPatch).toContain('-original')
    expect(result.diffPatch).toContain('+changed')
    expect(result.commitCount).toBe(1)
    await expect(Effect.runPromise(service.getRangeDiff(dir, '-bad'))).resolves.toEqual({
      commitSummary: '',
      diffSummary: '',
      diffPatch: '',
      commitCount: 0
    })
  })

  it('reports whether the current branch needs to be pushed', async () => {
    const remoteDir = makeTempDir()
    git(remoteDir, ['init', '--bare'])

    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'original\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'initial'])
    git(dir, ['branch', '-M', 'main'])
    git(dir, ['remote', 'add', 'origin', remoteDir])
    git(dir, ['push', '-u', 'origin', 'main'])

    const service = makeLiveGitOpsRpcService()
    await expect(Effect.runPromise(service.needsPush(dir))).resolves.toBe(false)

    writeFileSync(join(dir, 'tracked.txt'), 'changed\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'local changes'])

    await expect(Effect.runPromise(service.needsPush(dir))).resolves.toBe(true)
  })

  it('treats missing upstream push state as needing a push', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'original\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'initial'])

    const service = makeLiveGitOpsRpcService()

    await expect(Effect.runPromise(service.needsPush(dir))).resolves.toBe(true)
  })

  it('creates a pull request using the GitHub CLI and a temporary body file', async () => {
    const calls: Array<{ file: string; args: ReadonlyArray<string>; cwd: string }> = []
    let bodyFileContent = ''
    const runCommand = vi.fn(
      async (file: string, args: ReadonlyArray<string>, options: { cwd: string }) => {
        calls.push({ file, args, cwd: options.cwd })
        const bodyFileIndex = args.indexOf('--body-file')
        if (bodyFileIndex >= 0) {
          bodyFileContent = readFileSync(args[bodyFileIndex + 1], 'utf-8')
        }
        return { stdout: 'https://github.com/acme/hive/pull/42\n', stderr: '' }
      }
    )
    const service = makeLiveGitOpsRpcService({ runCommand })

    const result = await Effect.runPromise(
      service.createPR('/tmp/hive', 'origin/main', 'Add RPC', 'Body text')
    )

    expect(result).toEqual({
      success: true,
      url: 'https://github.com/acme/hive/pull/42',
      number: 42
    })
    expect(bodyFileContent).toBe('Body text')
    expect(calls).toEqual([
      {
        file: 'gh',
        args: [
          'pr',
          'create',
          '--base',
          'main',
          '--title',
          'Add RPC',
          '--body-file',
          expect.stringContaining('body.md')
        ],
        cwd: '/tmp/hive'
      }
    ])
  })

  it('returns existing pull request details when gh reports one already exists', async () => {
    const runCommand = vi.fn(async () => {
      throw new Error(
        'a pull request already exists for branch: https://github.com/acme/hive/pull/77'
      )
    })
    const service = makeLiveGitOpsRpcService({ runCommand })

    await expect(
      Effect.runPromise(service.createPR('/tmp/hive', 'main', 'Add RPC', 'Body text'))
    ).resolves.toEqual({
      success: false,
      error: 'a pull request already exists for branch: https://github.com/acme/hive/pull/77',
      url: 'https://github.com/acme/hive/pull/77',
      number: 77
    })
    await expect(
      Effect.runPromise(service.createPR('/tmp/hive', '-bad', 'Add RPC', 'Body text'))
    ).resolves.toEqual({
      success: false,
      error: 'Invalid branch name'
    })
  })

  it('generates pull request content with git range context', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'original\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'initial'])
    git(dir, ['branch', '-M', 'main'])
    git(dir, ['checkout', '-b', 'feature/pr-content'])

    const runCommand = vi.fn(
      async (_file: string, args: ReadonlyArray<string>, _options: { cwd: string }) => {
        if (args[0] === 'log') return { stdout: 'abc123 Add RPC\n', stderr: '' }
        if (args.join(' ') === 'diff --stat main...HEAD') {
          return { stdout: ' tracked.txt | 2 +-\n', stderr: '' }
        }
        if (args.join(' ') === 'diff --patch --minimal main...HEAD') {
          return { stdout: 'diff --git a/tracked.txt b/tracked.txt\n', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      }
    )
    const generatePRContent = vi.fn(async () => ({
      title: 'Add RPC',
      body: '## Summary\n- Added RPC\n## Testing\n- Vitest'
    }))
    const service = makeLiveGitOpsRpcService({ runCommand, generatePRContent })

    const result = await Effect.runPromise(service.generatePRContent(dir, 'main', 'codex'))

    expect(result).toEqual({
      success: true,
      title: 'Add RPC',
      body: '## Summary\n- Added RPC\n## Testing\n- Vitest'
    })
    expect(generatePRContent).toHaveBeenCalledWith({
      baseBranch: 'main',
      headBranch: 'feature/pr-content',
      commitSummary: 'abc123 Add RPC\n',
      diffSummary: ' tracked.txt | 2 +-\n',
      diffPatch: 'diff --git a/tracked.txt b/tracked.txt\n',
      provider: 'codex',
      cwd: dir
    })
    expect(runCommand).toHaveBeenCalledWith('git', ['log', '--oneline', 'main..HEAD'], {
      cwd: dir,
      maxBuffer: undefined
    })
    expect(runCommand).toHaveBeenCalledWith('git', ['diff', '--stat', 'main...HEAD'], {
      cwd: dir,
      maxBuffer: undefined
    })
    expect(runCommand).toHaveBeenCalledWith(
      'git',
      ['diff', '--patch', '--minimal', 'main...HEAD'],
      { cwd: dir, maxBuffer: 120 * 1024 }
    )
  })

  it('rejects providers that cannot generate pull request content', async () => {
    const generatePRContent = vi.fn(async () => ({ title: 'unused', body: 'unused' }))
    const service = makeLiveGitOpsRpcService({ generatePRContent })

    await expect(
      Effect.runPromise(service.generatePRContent('/tmp/hive', 'main', 'terminal'))
    ).resolves.toEqual({
      success: false,
      error: "Provider 'terminal' does not support PR content generation"
    })
    await expect(
      Effect.runPromise(service.generatePRContent('/tmp/hive', 'main', 'unknown'))
    ).resolves.toEqual({
      success: false,
      error: 'Invalid provider: unknown'
    })
    expect(generatePRContent).not.toHaveBeenCalled()
  })

  it('merges a pull request and syncs the local target branch', async () => {
    const calls: Array<{ file: string; args: ReadonlyArray<string>; cwd: string }> = []
    const runCommand = vi.fn(
      async (file: string, args: ReadonlyArray<string>, options: { cwd: string }) => {
        calls.push({ file, args, cwd: options.cwd })
        if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return { stdout: 'main\n', stderr: '' }
        }
        if (file === 'git' && args.join(' ') === 'worktree list --porcelain') {
          return {
            stdout: ['worktree /tmp/hive-main', 'HEAD abc123', 'branch refs/heads/main'].join('\n'),
            stderr: ''
          }
        }
        if (file === 'git' && args.join(' ') === 'branch --show-current') {
          return { stdout: 'feature\n', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      }
    )

    const service = makeLiveGitOpsRpcService({ runCommand })
    const result = await Effect.runPromise(service.prMerge('/tmp/hive-feature', 123))

    expect(result).toEqual({ success: true })
    expect(calls).toEqual([
      {
        file: 'gh',
        args: ['pr', 'merge', '123', '--merge'],
        cwd: '/tmp/hive-feature'
      },
      {
        file: 'gh',
        args: ['pr', 'view', '123', '--json', 'baseRefName', '-q', '.baseRefName'],
        cwd: '/tmp/hive-feature'
      },
      {
        file: 'git',
        args: ['worktree', 'list', '--porcelain'],
        cwd: '/tmp/hive-feature'
      },
      {
        file: 'git',
        args: ['branch', '--show-current'],
        cwd: '/tmp/hive-feature'
      },
      {
        file: 'git',
        args: ['merge', 'feature'],
        cwd: '/tmp/hive-main'
      }
    ])
  })

  it('checks whether a branch is merged into HEAD', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'initial\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'initial'])
    git(dir, ['branch', '-M', 'main'])
    git(dir, ['checkout', '-b', 'feature'])
    writeFileSync(join(dir, 'feature.txt'), 'feature\n')
    git(dir, ['add', 'feature.txt'])
    git(dir, ['commit', '-m', 'feature'])
    git(dir, ['checkout', 'main'])

    const service = makeLiveGitOpsRpcService()
    await expect(Effect.runPromise(service.isBranchMerged(dir, 'feature'))).resolves.toEqual({
      success: true,
      isMerged: false
    })

    git(dir, ['merge', 'feature'])

    await expect(Effect.runPromise(service.isBranchMerged(dir, 'feature'))).resolves.toEqual({
      success: true,
      isMerged: true
    })
    await expect(Effect.runPromise(service.isBranchMerged(dir, 'missing'))).resolves.toEqual({
      success: true,
      isMerged: false
    })
  })

  it('deletes a local branch', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'initial\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'initial'])
    git(dir, ['branch', 'feature'])

    const service = makeLiveGitOpsRpcService()
    await expect(Effect.runPromise(service.deleteBranch(dir, 'feature'))).resolves.toEqual({
      success: true
    })

    const branches = execFileSync('git', ['branch', '--list', 'feature'], {
      cwd: dir,
      encoding: 'utf8'
    })
    expect(branches.trim()).toBe('')

    const missing = await Effect.runPromise(service.deleteBranch(dir, 'missing'))
    expect(missing.success).toBe(false)
    expect(missing.error).toEqual(expect.any(String))
  })

  it('lists open pull requests through gh CLI', async () => {
    const calls: Array<{ file: string; args: ReadonlyArray<string>; cwd: string }> = []
    const runCommand = vi.fn(
      async (file: string, args: ReadonlyArray<string>, options: { cwd: string }) => {
        calls.push({ file, args, cwd: options.cwd })
        if (
          file === 'gh' &&
          args.join(' ') ===
            'pr list --json number,title,author,headRefName --state open --limit 100'
        ) {
          return {
            stdout: JSON.stringify([
              {
                number: 123,
                title: 'Add RPC',
                author: { login: 'mor' },
                headRefName: 'feature/rpc'
              }
            ]),
            stderr: ''
          }
        }
        return { stdout: '', stderr: '' }
      }
    )

    const service = makeLiveGitOpsRpcService({ runCommand })
    await expect(Effect.runPromise(service.listPRs('/tmp/hive'))).resolves.toEqual({
      success: true,
      prs: [{ number: 123, title: 'Add RPC', author: 'mor', headRefName: 'feature/rpc' }]
    })
    expect(calls).toEqual([
      { file: 'git', args: ['fetch', 'origin'], cwd: '/tmp/hive' },
      {
        file: 'gh',
        args: [
          'pr',
          'list',
          '--json',
          'number,title,author,headRefName',
          '--state',
          'open',
          '--limit',
          '100'
        ],
        cwd: '/tmp/hive'
      }
    ])
  })

  it('gets pull request state through gh CLI', async () => {
    const calls: Array<{ file: string; args: ReadonlyArray<string>; cwd: string }> = []
    const runCommand = vi.fn(
      async (file: string, args: ReadonlyArray<string>, options: { cwd: string }) => {
        calls.push({ file, args, cwd: options.cwd })
        return { stdout: JSON.stringify({ state: 'OPEN', title: 'Add RPC' }), stderr: '' }
      }
    )

    const service = makeLiveGitOpsRpcService({ runCommand })
    await expect(Effect.runPromise(service.getPRState('/tmp/hive', 123))).resolves.toEqual({
      success: true,
      state: 'OPEN',
      title: 'Add RPC'
    })
    expect(calls).toEqual([
      {
        file: 'gh',
        args: ['pr', 'view', '123', '--json', 'state,title'],
        cwd: '/tmp/hive'
      }
    ])
  })

  it('gets pull request review comments through gh GraphQL', async () => {
    const calls: Array<{
      file: string
      args: ReadonlyArray<string>
      cwd: string
      maxBuffer?: number
    }> = []
    const runCommand = vi.fn(
      async (
        file: string,
        args: ReadonlyArray<string>,
        options: { cwd: string; maxBuffer?: number }
      ) => {
        calls.push({ file, args, cwd: options.cwd, maxBuffer: options.maxBuffer })
        if (
          file === 'gh' &&
          args.join(' ') === 'repo view --json nameWithOwner -q .nameWithOwner'
        ) {
          return { stdout: 'owner/repo\n', stderr: '' }
        }
        if (file === 'gh' && args[0] === 'api' && args[1] === 'graphql') {
          return {
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    baseRefName: 'main',
                    reviewThreads: {
                      nodes: [
                        {
                          isResolved: false,
                          isOutdated: false,
                          diffSide: 'RIGHT',
                          comments: {
                            nodes: [
                              {
                                databaseId: 101,
                                body: 'Looks good',
                                bodyHTML: '<p>Looks good</p>',
                                author: {
                                  login: 'mor',
                                  avatarUrl: 'https://example.com/avatar.png'
                                },
                                path: 'src/App.tsx',
                                line: 10,
                                originalLine: 9,
                                diffHunk: '@@ -1 +1 @@',
                                createdAt: '2026-05-27T00:00:00Z',
                                updatedAt: '2026-05-27T00:00:00Z',
                                subjectType: 'LINE',
                                pullRequestReview: { databaseId: 500 }
                              },
                              {
                                databaseId: 102,
                                body: 'Reply',
                                bodyHTML: '<p>Reply</p>',
                                author: null,
                                path: 'src/App.tsx',
                                line: 11,
                                originalLine: 10,
                                diffHunk: '@@ -1 +1 @@',
                                createdAt: '2026-05-27T00:01:00Z',
                                updatedAt: '2026-05-27T00:01:00Z',
                                subjectType: 'FILE',
                                pullRequestReview: null
                              }
                            ]
                          }
                        }
                      ]
                    }
                  }
                }
              }
            }),
            stderr: ''
          }
        }
        return { stdout: '', stderr: '' }
      }
    )

    const service = makeLiveGitOpsRpcService({ runCommand })
    await expect(Effect.runPromise(service.getPRReviewComments('/tmp/hive', 123))).resolves.toEqual(
      {
        success: true,
        baseBranch: 'main',
        comments: [
          {
            id: 101,
            body: 'Looks good',
            bodyHTML: '<p>Looks good</p>',
            path: 'src/App.tsx',
            line: 10,
            originalLine: 9,
            side: 'RIGHT',
            diffHunk: '@@ -1 +1 @@',
            user: { login: 'mor', avatarUrl: 'https://example.com/avatar.png' },
            createdAt: '2026-05-27T00:00:00Z',
            updatedAt: '2026-05-27T00:00:00Z',
            inReplyToId: null,
            pullRequestReviewId: 500,
            subjectType: 'line'
          },
          {
            id: 102,
            body: 'Reply',
            bodyHTML: '<p>Reply</p>',
            path: 'src/App.tsx',
            line: 11,
            originalLine: 10,
            side: 'RIGHT',
            diffHunk: '@@ -1 +1 @@',
            user: { login: 'ghost', avatarUrl: '' },
            createdAt: '2026-05-27T00:01:00Z',
            updatedAt: '2026-05-27T00:01:00Z',
            inReplyToId: 101,
            pullRequestReviewId: null,
            subjectType: 'file'
          }
        ]
      }
    )
    expect(calls[0]).toEqual({
      file: 'gh',
      args: ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
      cwd: '/tmp/hive',
      maxBuffer: undefined
    })
    expect(calls[1]).toEqual({
      file: 'gh',
      args: expect.arrayContaining([
        'api',
        'graphql',
        '-F',
        'owner=owner',
        '-F',
        'repo=repo',
        '-F',
        'pr=123'
      ]),
      cwd: '/tmp/hive',
      maxBuffer: 10 * 1024 * 1024
    })
  })

  it('unstages a file in a git worktree', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'original\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'initial'])
    writeFileSync(join(dir, 'tracked.txt'), 'changed\n')
    git(dir, ['add', 'tracked.txt'])

    const service = makeLiveGitOpsRpcService()
    const result = await Effect.runPromise(service.unstageFile(dir, 'tracked.txt'))
    const status = await Effect.runPromise(service.getFileStatuses(dir))

    expect(result).toEqual({ success: true })
    expect(status.files).toEqual(
      expect.arrayContaining([
        {
          path: join(dir, 'tracked.txt'),
          relativePath: 'tracked.txt',
          status: 'M',
          staged: false
        }
      ])
    )
  })

  it('discards tracked file changes in a git worktree', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'original\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'initial'])
    writeFileSync(join(dir, 'tracked.txt'), 'changed\n')

    const service = makeLiveGitOpsRpcService()
    const result = await Effect.runPromise(service.discardChanges(dir, 'tracked.txt'))
    const status = await Effect.runPromise(service.getFileStatuses(dir))

    expect(result).toBeNull()
    expect(readFileSync(join(dir, 'tracked.txt'), 'utf8')).toBe('original\n')
    expect(status.files).toEqual([])
  })

  it('deletes untracked files when discarding changes', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    git(dir, ['config', 'user.email', 'hive@example.test'])
    git(dir, ['config', 'user.name', 'Hive Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'original\n')
    git(dir, ['add', 'tracked.txt'])
    git(dir, ['commit', '-m', 'initial'])
    const untrackedPath = join(dir, 'untracked.txt')
    writeFileSync(untrackedPath, 'untracked\n')

    const service = makeLiveGitOpsRpcService()
    const result = await Effect.runPromise(service.discardChanges(dir, 'untracked.txt'))
    const status = await Effect.runPromise(service.getFileStatuses(dir))

    expect(result).toBeNull()
    expect(existsSync(untrackedPath)).toBe(false)
    expect(status.files).toEqual([])
  })

  it('adds a pattern to .gitignore once', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    const service = makeLiveGitOpsRpcService()

    await expect(Effect.runPromise(service.addToGitignore(dir, 'dist/'))).resolves.toEqual({
      success: true
    })
    await expect(Effect.runPromise(service.addToGitignore(dir, 'dist/'))).resolves.toEqual({
      success: true
    })

    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('dist/\n')
  })

  it('appends a pattern to an existing .gitignore', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')

    const service = makeLiveGitOpsRpcService()
    const result = await Effect.runPromise(service.addToGitignore(dir, 'dist/'))

    expect(result).toEqual({ success: true })
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('node_modules/\ndist/\n')
  })

  it('returns an error when opening a missing file in an editor', async () => {
    const dir = makeTempDir()
    const service = makeLiveGitOpsRpcService()

    const result = await Effect.runPromise(service.openInEditor(join(dir, 'missing.txt')))

    expect(result).toEqual({ success: false, error: 'Path does not exist' })
  })

  it('shows a file in the platform file manager', async () => {
    const sentMessages: DesktopCommandRequest[] = []
    const messageListeners: Array<(message: unknown) => void> = []
    const onSpy = vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      if (event === 'message') {
        messageListeners.push(listener as (message: unknown) => void)
        return process
      }
      return originalProcessOn.call(process, event, listener)
    })
    const offSpy = vi.spyOn(process, 'off').mockImplementation((event, listener) => {
      if (event === 'message') {
        const index = messageListeners.indexOf(listener as (message: unknown) => void)
        if (index !== -1) messageListeners.splice(index, 1)
        return process
      }
      return originalProcessOff.call(process, event, listener)
    })
    process.send = vi.fn((message: unknown, callback?: (error: Error | null) => void) => {
      const request = message as DesktopCommandRequest
      sentMessages.push(request)
      setImmediate(() => {
        messageListeners[0]?.(
          makeDesktopCommandResult(request.id, { ok: true, value: { success: true } })
        )
      })
      callback?.(null)
      return true
    }) as typeof process.send
    const service = makeLiveGitOpsRpcService()

    try {
      const result = await Effect.runPromise(service.showInFinder('/tmp/hive/src/App.tsx'))

      expect(result).toEqual({ success: true })
      expect(sentMessages).toEqual([
        expect.objectContaining({
          command: 'gitShowInFinder',
          payload: { filePath: '/tmp/hive/src/App.tsx' }
        })
      ])
    } finally {
      onSpy.mockRestore()
      offSpy.mockRestore()
    }
  })

  it('returns an operation error when showing a file in the platform file manager fails', async () => {
    const messageListeners: Array<(message: unknown) => void> = []
    const onSpy = vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      if (event === 'message') {
        messageListeners.push(listener as (message: unknown) => void)
        return process
      }
      return originalProcessOn.call(process, event, listener)
    })
    const offSpy = vi.spyOn(process, 'off').mockImplementation((event, listener) => {
      if (event === 'message') {
        const index = messageListeners.indexOf(listener as (message: unknown) => void)
        if (index !== -1) messageListeners.splice(index, 1)
        return process
      }
      return originalProcessOff.call(process, event, listener)
    })
    process.send = vi.fn((message: unknown, callback?: (error: Error | null) => void) => {
      const request = message as DesktopCommandRequest
      setImmediate(() => {
        messageListeners[0]?.(
          makeDesktopCommandResult(request.id, {
            ok: true,
            value: { success: false, error: 'cannot reveal path' }
          })
        )
      })
      callback?.(null)
      return true
    }) as typeof process.send
    const service = makeLiveGitOpsRpcService()

    try {
      const result = await Effect.runPromise(service.showInFinder('/tmp/hive/src/App.tsx'))

      expect(result).toEqual({ success: false, error: 'cannot reveal path' })
    } finally {
      onSpy.mockRestore()
      offSpy.mockRestore()
    }
  })

  it('starts git worktree watching in the server runtime instead of the desktop command bridge', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    process.send = vi.fn() as typeof process.send
    const service = makeLiveGitOpsRpcService()

    const result = await Effect.runPromise(service.watchWorktree(dir))

    expect(result).toEqual({ success: true })
    expect(process.send).not.toHaveBeenCalled()
  })

  it('stops git worktree watching in the server runtime instead of the desktop command bridge', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    process.send = vi.fn() as typeof process.send
    const service = makeLiveGitOpsRpcService()

    await Effect.runPromise(service.watchWorktree(dir))
    const result = await Effect.runPromise(service.unwatchWorktree(dir))

    expect(result).toEqual({ success: true })
    expect(process.send).not.toHaveBeenCalled()
  })

  it('starts git branch watching in the server runtime instead of the desktop command bridge', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    process.send = vi.fn() as typeof process.send
    const service = makeLiveGitOpsRpcService()

    const result = await Effect.runPromise(service.watchBranch(dir))

    expect(result).toEqual({ success: true })
    expect(process.send).not.toHaveBeenCalled()
  })

  it('stops git branch watching in the server runtime instead of the desktop command bridge', async () => {
    const dir = makeTempDir()
    git(dir, ['init'])
    process.send = vi.fn() as typeof process.send
    const service = makeLiveGitOpsRpcService()

    await Effect.runPromise(service.watchBranch(dir))
    const result = await Effect.runPromise(service.unwatchBranch(dir))

    expect(result).toEqual({ success: true })
    expect(process.send).not.toHaveBeenCalled()
  })
})
