import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'
import { gitApi } from '../git-api'

describe('gitApi', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('routes addToGitignore through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.addToGitignore('/tmp/hive', 'dist/')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.addToGitignore', {
      worktreePath: '/tmp/hive',
      pattern: 'dist/'
    })
  })

  it('routes commit through the renderer RPC client', async () => {
    const result = { success: true, commitHash: 'abc123' }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.commit('/tmp/hive', 'commit message')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.commit', {
      worktreePath: '/tmp/hive',
      message: 'commit message'
    })
  })

  it('routes createPR through the renderer RPC client', async () => {
    const result = {
      success: true,
      url: 'https://github.com/acme/hive/pull/42',
      number: 42
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.createPR('/tmp/hive', 'origin/main', 'Add RPC', 'Body text')).resolves.toBe(
      result
    )
    expect(request).toHaveBeenCalledWith('gitOps.createPR', {
      worktreePath: '/tmp/hive',
      baseBranch: 'origin/main',
      title: 'Add RPC',
      body: 'Body text'
    })
  })

  it('routes branchDiffShortStat through the renderer RPC client', async () => {
    const result = {
      success: true,
      filesChanged: 2,
      insertions: 10,
      deletions: 4,
      commitsAhead: 1
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.branchDiffShortStat('/tmp/hive', 'main')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.branchDiffShortStat', {
      worktreePath: '/tmp/hive',
      baseBranch: 'main'
    })
  })

  it('routes discardChanges through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(null)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.discardChanges('/tmp/hive', 'src/App.tsx')).resolves.toBeNull()
    expect(request).toHaveBeenCalledWith('gitOps.discardChanges', {
      worktreePath: '/tmp/hive',
      filePath: 'src/App.tsx'
    })
  })

  it('routes getBranchInfo through the renderer RPC client', async () => {
    const result = {
      success: true,
      branch: {
        name: 'main',
        tracking: 'origin/main',
        ahead: 1,
        behind: 0
      }
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.getBranchInfo('/tmp/hive')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.getBranchInfo', {
      worktreePath: '/tmp/hive'
    })
  })

  it('routes getFileStatuses through the renderer RPC client', async () => {
    const result = {
      success: true,
      files: [
        {
          path: '/tmp/hive/src/App.tsx',
          relativePath: 'src/App.tsx',
          status: 'M' as const,
          staged: false
        }
      ]
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.getFileStatuses('/tmp/hive')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.getFileStatuses', {
      worktreePath: '/tmp/hive'
    })
  })

  it('routes status changes through the renderer event subscription', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const subscribe = vi.fn().mockReturnValue(unsubscribe)
    const callback = vi.fn()

    setRendererRpcClient({ request, subscribe })

    const returned = gitApi.onStatusChanged(callback)

    expect(returned).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith('git:statusChanged', expect.any(Function))

    const listener = subscribe.mock.calls[0]?.[1]
    listener?.({ channel: 'git:statusChanged', payload: { worktreePath: '/tmp/hive' } })
    listener?.({ channel: 'git:statusChanged', payload: { worktreePath: 42 } })
    listener?.({ channel: 'git:statusChanged', payload: null })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith({ worktreePath: '/tmp/hive' })
  })

  it('routes branch changes through the renderer event subscription', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const subscribe = vi.fn().mockReturnValue(unsubscribe)
    const callback = vi.fn()

    setRendererRpcClient({ request, subscribe })

    const returned = gitApi.onBranchChanged(callback)

    expect(returned).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith('git:branchChanged', expect.any(Function))

    const listener = subscribe.mock.calls[0]?.[1]
    listener?.({ channel: 'git:branchChanged', payload: { worktreePath: '/tmp/hive' } })
    listener?.({ channel: 'git:branchChanged', payload: { worktreePath: 42 } })
    listener?.({ channel: 'git:branchChanged', payload: null })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith({ worktreePath: '/tmp/hive' })
  })

  it('routes watchWorktree through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.watchWorktree('/tmp/hive')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.watchWorktree', {
      worktreePath: '/tmp/hive'
    })
  })

  it('routes watchBranch through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.watchBranch('/tmp/hive')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.watchBranch', {
      worktreePath: '/tmp/hive'
    })
  })

  it('routes unwatchWorktree through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.unwatchWorktree('/tmp/hive')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.unwatchWorktree', {
      worktreePath: '/tmp/hive'
    })
  })

  it('routes unwatchBranch through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.unwatchBranch('/tmp/hive')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.unwatchBranch', {
      worktreePath: '/tmp/hive'
    })
  })

  it('routes getFileContent through the renderer RPC client', async () => {
    const result = {
      success: true,
      content: 'export function App() {}'
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.getFileContent('/tmp/hive', 'src/App.tsx')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.getFileContent', {
      worktreePath: '/tmp/hive',
      filePath: 'src/App.tsx'
    })
  })

  it('routes getRefContent through the renderer RPC client', async () => {
    const result = {
      success: true,
      content: '<svg viewBox="0 0 1 1" />'
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.getRefContent('/tmp/hive', 'HEAD', 'assets/icon.svg')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.getRefContent', {
      worktreePath: '/tmp/hive',
      ref: 'HEAD',
      filePath: 'assets/icon.svg'
    })
  })

  it('routes getRefContentBase64 through the renderer RPC client', async () => {
    const result = {
      success: true,
      data: 'iVBORw0KGgo=',
      mimeType: 'image/png'
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.getRefContentBase64('/tmp/hive', 'HEAD', 'assets/icon.png')).resolves.toBe(
      result
    )
    expect(request).toHaveBeenCalledWith('gitOps.getRefContentBase64', {
      worktreePath: '/tmp/hive',
      ref: 'HEAD',
      filePath: 'assets/icon.png'
    })
  })

  it('routes getFileContentBase64 through the renderer RPC client', async () => {
    const result = {
      success: true,
      data: 'iVBORw0KGgo=',
      mimeType: 'image/png'
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.getFileContentBase64('/tmp/hive', 'assets/icon.png')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.getFileContentBase64', {
      worktreePath: '/tmp/hive',
      filePath: 'assets/icon.png'
    })
  })

  it('routes getBranchBaseContent through the renderer RPC client', async () => {
    const result = {
      success: true,
      content: '<svg viewBox="0 0 1 1" />'
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(
      gitApi.getBranchBaseContent('/tmp/hive', 'feature', 'assets/icon.svg')
    ).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.getBranchBaseContent', {
      worktreePath: '/tmp/hive',
      branch: 'feature',
      filePath: 'assets/icon.svg'
    })
  })

  it('routes getBranchBaseContentBase64 through the renderer RPC client', async () => {
    const result = {
      success: true,
      data: 'iVBORw0KGgo=',
      mimeType: 'image/png'
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(
      gitApi.getBranchBaseContentBase64('/tmp/hive', 'feature', 'assets/icon.png')
    ).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.getBranchBaseContentBase64', {
      worktreePath: '/tmp/hive',
      branch: 'feature',
      filePath: 'assets/icon.png'
    })
  })

  it('routes generatePRContent through the renderer RPC client', async () => {
    const result = {
      success: true,
      title: 'Add RPC',
      body: '## Summary\n- Added RPC'
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.generatePRContent('/tmp/hive', 'origin/main', 'codex')).resolves.toBe(
      result
    )
    expect(request).toHaveBeenCalledWith('gitOps.generatePRContent', {
      worktreePath: '/tmp/hive',
      baseBranch: 'origin/main',
      provider: 'codex'
    })
  })

  it('routes getDiff through the renderer RPC client', async () => {
    const result = {
      success: true,
      diff: 'diff --git a/src/App.tsx b/src/App.tsx',
      fileName: 'App.tsx'
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.getDiff('/tmp/hive', 'src/App.tsx', false, false, 5)).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.getDiff', {
      worktreePath: '/tmp/hive',
      filePath: 'src/App.tsx',
      staged: false,
      isUntracked: false,
      contextLines: 5
    })
  })

  it('routes getBranchFileDiff through the renderer RPC client', async () => {
    const result = {
      success: true,
      diff: 'diff --git a/src/App.tsx b/src/App.tsx'
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.getBranchFileDiff('/tmp/hive', 'main', 'src/App.tsx')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.getBranchFileDiff', {
      worktreePath: '/tmp/hive',
      branch: 'main',
      filePath: 'src/App.tsx'
    })
  })

  it('routes getDiffStat through the renderer RPC client', async () => {
    const result = {
      success: true,
      files: [
        {
          path: 'src/App.tsx',
          additions: 12,
          deletions: 3,
          binary: false
        }
      ]
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.getDiffStat('/tmp/hive')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.getDiffStat', {
      worktreePath: '/tmp/hive'
    })
  })

  it('routes getRemoteUrl through the renderer RPC client', async () => {
    const result = {
      success: true,
      url: 'git@github.com:hive/hive.git',
      remote: 'origin'
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.getRemoteUrl('/tmp/hive', 'upstream')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.getRemoteUrl', {
      worktreePath: '/tmp/hive',
      remote: 'upstream'
    })
  })

  it('routes hasUncommittedChanges through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.hasUncommittedChanges('/tmp/hive')).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('gitOps.hasUncommittedChanges', {
      worktreePath: '/tmp/hive'
    })
  })

  it('routes merge through the renderer RPC client', async () => {
    const result = { success: false, conflicts: ['src/App.tsx'] }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.merge('/tmp/hive', 'feature')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.merge', {
      worktreePath: '/tmp/hive',
      sourceBranch: 'feature'
    })
  })

  it('routes mergeAbort through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.mergeAbort('/tmp/hive')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.mergeAbort', {
      worktreePath: '/tmp/hive'
    })
  })

  it('routes needsPush through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.needsPush('/tmp/hive')).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('gitOps.needsPush', {
      worktreePath: '/tmp/hive'
    })
  })

  it('routes prMerge through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.prMerge('/tmp/hive', 123)).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.prMerge', {
      worktreePath: '/tmp/hive',
      prNumber: 123
    })
  })

  it('routes isBranchMerged through the renderer RPC client', async () => {
    const result = { success: true, isMerged: false }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.isBranchMerged('/tmp/hive', 'feature/rpc')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.isBranchMerged', {
      worktreePath: '/tmp/hive',
      branch: 'feature/rpc'
    })
  })

  it('routes deleteBranch through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.deleteBranch('/tmp/hive', 'feature/rpc')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.deleteBranch', {
      worktreePath: '/tmp/hive',
      branchName: 'feature/rpc'
    })
  })

  it('routes listBranchesWithStatus through the renderer RPC client', async () => {
    const result = {
      success: true,
      branches: [
        { name: 'main', isRemote: false, isCheckedOut: true, worktreePath: '/tmp/hive' },
        { name: 'origin/main', isRemote: true, isCheckedOut: false }
      ]
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.listBranchesWithStatus('/tmp/hive')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.listBranchesWithStatus', {
      projectPath: '/tmp/hive'
    })
  })

  it('routes getBranchDiffFiles through the renderer RPC client', async () => {
    const result = {
      success: true,
      files: [
        {
          relativePath: 'src/App.tsx',
          status: 'M',
          additions: 12,
          deletions: 3,
          binary: false
        }
      ]
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.getBranchDiffFiles('/tmp/hive', 'main')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.getBranchDiffFiles', {
      worktreePath: '/tmp/hive',
      branch: 'main'
    })
  })

  it('routes getRangeDiff through the renderer RPC client', async () => {
    const result = {
      commitSummary: 'abc123 Add feature',
      diffSummary: '2 files changed',
      diffPatch: 'diff --git a/file.ts b/file.ts',
      commitCount: 1
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.getRangeDiff('/tmp/hive', 'main')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.getRangeDiff', {
      worktreePath: '/tmp/hive',
      baseBranch: 'main'
    })
  })

  it('routes getPRState through the renderer RPC client', async () => {
    const result = { success: true, state: 'OPEN', title: 'Add RPC' }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.getPRState('/tmp/hive', 123)).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.getPRState', {
      projectPath: '/tmp/hive',
      prNumber: 123
    })
  })

  it('routes getPRReviewComments through the renderer RPC client', async () => {
    const result = {
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
        }
      ]
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.getPRReviewComments('/tmp/hive', 123)).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.getPRReviewComments', {
      projectPath: '/tmp/hive',
      prNumber: 123
    })
  })

  it('routes listPRs through the renderer RPC client', async () => {
    const result = {
      success: true,
      prs: [{ number: 123, title: 'Add RPC', author: 'mor', headRefName: 'feature/rpc' }]
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.listPRs('/tmp/hive')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.listPRs', {
      projectPath: '/tmp/hive'
    })
  })

  it('routes openInEditor through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.openInEditor('/tmp/hive/src/App.tsx')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.openInEditor', {
      filePath: '/tmp/hive/src/App.tsx'
    })
  })

  it('routes showInFinder through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.showInFinder('/tmp/hive/src/App.tsx')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.showInFinder', {
      filePath: '/tmp/hive/src/App.tsx'
    })
  })

  it('routes push through the renderer RPC client', async () => {
    const result = { success: true, pushed: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.push('/tmp/hive', 'upstream', 'feature', true)).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.push', {
      worktreePath: '/tmp/hive',
      remote: 'upstream',
      branch: 'feature',
      force: true
    })
  })

  it('routes pull through the renderer RPC client', async () => {
    const result = { success: true, updated: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.pull('/tmp/hive', 'upstream', 'feature', true)).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.pull', {
      worktreePath: '/tmp/hive',
      remote: 'upstream',
      branch: 'feature',
      rebase: true
    })
  })

  it('routes stageFile through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.stageFile('/tmp/hive', 'src/App.tsx')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.stageFile', {
      worktreePath: '/tmp/hive',
      filePath: 'src/App.tsx'
    })
  })

  it('routes stageAll through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.stageAll('/tmp/hive')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.stageAll', {
      worktreePath: '/tmp/hive'
    })
  })

  it('routes stageHunk through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.stageHunk('/tmp/hive', 'diff --git a/file.ts b/file.ts')).resolves.toBe(
      result
    )
    expect(request).toHaveBeenCalledWith('gitOps.stageHunk', {
      worktreePath: '/tmp/hive',
      patch: 'diff --git a/file.ts b/file.ts'
    })
  })

  it('routes unstageFile through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.unstageFile('/tmp/hive', 'src/App.tsx')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.unstageFile', {
      worktreePath: '/tmp/hive',
      filePath: 'src/App.tsx'
    })
  })

  it('routes unstageHunk through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.unstageHunk('/tmp/hive', 'diff --git a/file.ts b/file.ts')).resolves.toBe(
      result
    )
    expect(request).toHaveBeenCalledWith('gitOps.unstageHunk', {
      worktreePath: '/tmp/hive',
      patch: 'diff --git a/file.ts b/file.ts'
    })
  })

  it('routes revertHunk through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.revertHunk('/tmp/hive', 'diff --git a/file.ts b/file.ts')).resolves.toBe(
      result
    )
    expect(request).toHaveBeenCalledWith('gitOps.revertHunk', {
      worktreePath: '/tmp/hive',
      patch: 'diff --git a/file.ts b/file.ts'
    })
  })

  it('routes unstageAll through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(gitApi.unstageAll('/tmp/hive')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('gitOps.unstageAll', {
      worktreePath: '/tmp/hive'
    })
  })
})
