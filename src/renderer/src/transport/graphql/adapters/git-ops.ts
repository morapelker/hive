import { graphqlQuery, graphqlSubscribe } from '../client'
import { notAvailableInWeb } from '../../stubs/electron-only'
import type { GitOpsApi } from '../../types'

export function createGitOpsAdapter(): GitOpsApi {
  return {
    // ─── File statuses ──────────────────────────────────────────
    async getFileStatuses(worktreePath: string): Promise<{
      success: boolean
      files?: GitFileStatus[]
      error?: string
    }> {
      const data = await graphqlQuery<{
        gitFileStatuses: {
          success: boolean
          files?: Array<{ path: string; relativePath: string; status: string; staged: boolean }>
          error?: string
        }
      }>(
        `query ($worktreePath: String!) {
          gitFileStatuses(worktreePath: $worktreePath) {
            success error
            files { path relativePath status staged }
          }
        }`,
        { worktreePath }
      )
      return data.gitFileStatuses as {
        success: boolean
        files?: GitFileStatus[]
        error?: string
      }
    },

    // ─── Stage / Unstage ────────────────────────────────────────
    async stageFile(
      worktreePath: string,
      filePath: string
    ): Promise<{ success: boolean; error?: string }> {
      const data = await graphqlQuery<{
        gitStageFile: { success: boolean; error?: string }
      }>(
        `mutation ($worktreePath: String!, $filePath: String!) {
          gitStageFile(worktreePath: $worktreePath, filePath: $filePath) { success error }
        }`,
        { worktreePath, filePath }
      )
      return data.gitStageFile
    },

    async unstageFile(
      worktreePath: string,
      filePath: string
    ): Promise<{ success: boolean; error?: string }> {
      const data = await graphqlQuery<{
        gitUnstageFile: { success: boolean; error?: string }
      }>(
        `mutation ($worktreePath: String!, $filePath: String!) {
          gitUnstageFile(worktreePath: $worktreePath, filePath: $filePath) { success error }
        }`,
        { worktreePath, filePath }
      )
      return data.gitUnstageFile
    },

    async stageAll(worktreePath: string): Promise<{ success: boolean; error?: string }> {
      const data = await graphqlQuery<{
        gitStageAll: { success: boolean; error?: string }
      }>(
        `mutation ($worktreePath: String!) {
          gitStageAll(worktreePath: $worktreePath) { success error }
        }`,
        { worktreePath }
      )
      return data.gitStageAll
    },

    async unstageAll(worktreePath: string): Promise<{ success: boolean; error?: string }> {
      const data = await graphqlQuery<{
        gitUnstageAll: { success: boolean; error?: string }
      }>(
        `mutation ($worktreePath: String!) {
          gitUnstageAll(worktreePath: $worktreePath) { success error }
        }`,
        { worktreePath }
      )
      return data.gitUnstageAll
    },

    // ─── Commit / Push / Pull / Merge ───────────────────────────
    async commit(
      worktreePath: string,
      message: string
    ): Promise<{ success: boolean; commitHash?: string; error?: string }> {
      const data = await graphqlQuery<{
        gitCommit: { success: boolean; commitHash?: string; error?: string }
      }>(
        `mutation ($worktreePath: String!, $message: String!) {
          gitCommit(worktreePath: $worktreePath, message: $message) { success commitHash error }
        }`,
        { worktreePath, message }
      )
      return data.gitCommit
    },

    async push(
      worktreePath: string,
      remote?: string,
      branch?: string,
      force?: boolean
    ): Promise<{ success: boolean; pushed?: boolean; error?: string }> {
      const data = await graphqlQuery<{
        gitPush: { success: boolean; error?: string }
      }>(
        `mutation ($input: GitPushInput!) {
          gitPush(input: $input) { success error }
        }`,
        { input: { worktreePath, remote, branch, force } }
      )
      return { ...data.gitPush, pushed: data.gitPush.success }
    },

    async pull(
      worktreePath: string,
      remote?: string,
      branch?: string,
      rebase?: boolean
    ): Promise<{ success: boolean; updated?: boolean; error?: string }> {
      const data = await graphqlQuery<{
        gitPull: { success: boolean; error?: string }
      }>(
        `mutation ($input: GitPullInput!) {
          gitPull(input: $input) { success error }
        }`,
        { input: { worktreePath, remote, branch, rebase } }
      )
      return { ...data.gitPull, updated: data.gitPull.success }
    },

    async merge(
      worktreePath: string,
      sourceBranch: string
    ): Promise<{ success: boolean; error?: string; conflicts?: string[] }> {
      const data = await graphqlQuery<{
        gitMerge: { success: boolean; error?: string; conflicts?: string[] }
      }>(
        `mutation ($worktreePath: String!, $sourceBranch: String!) {
          gitMerge(worktreePath: $worktreePath, sourceBranch: $sourceBranch) {
            success error conflicts
          }
        }`,
        { worktreePath, sourceBranch }
      )
      return data.gitMerge
    },

    async deleteBranch(
      worktreePath: string,
      branchName: string
    ): Promise<{ success: boolean; error?: string }> {
      const data = await graphqlQuery<{
        gitDeleteBranch: { success: boolean; error?: string }
      }>(
        `mutation ($worktreePath: String!, $branchName: String!) {
          gitDeleteBranch(worktreePath: $worktreePath, branchName: $branchName) { success error }
        }`,
        { worktreePath, branchName }
      )
      return data.gitDeleteBranch
    },

    async prMerge(
      worktreePath: string,
      prNumber: number
    ): Promise<{ success: boolean; error?: string }> {
      const data = await graphqlQuery<{
        gitPrMerge: { success: boolean; error?: string }
      }>(
        `mutation ($worktreePath: String!, $prNumber: Int!) {
          gitPrMerge(worktreePath: $worktreePath, prNumber: $prNumber) { success error }
        }`,
        { worktreePath, prNumber }
      )
      return data.gitPrMerge
    },

    // ─── Diff / Content queries ─────────────────────────────────
    async getDiff(
      worktreePath: string,
      filePath: string,
      staged: boolean,
      isUntracked: boolean,
      contextLines?: number
    ): Promise<{ success: boolean; diff?: string; fileName?: string; error?: string }> {
      const data = await graphqlQuery<{
        gitDiff: { success: boolean; diff?: string; fileName?: string; error?: string }
      }>(
        `query ($input: GitDiffInput!) {
          gitDiff(input: $input) { success diff fileName error }
        }`,
        { input: { worktreePath, filePath, staged, isUntracked, contextLines } }
      )
      return data.gitDiff
    },

    async getDiffStat(worktreePath: string): Promise<{
      success: boolean
      files?: GitDiffStatFile[]
      error?: string
    }> {
      const data = await graphqlQuery<{
        gitDiffStat: {
          success: boolean
          files?: Array<{ path: string; additions: number; deletions: number; binary: boolean }>
          error?: string
        }
      }>(
        `query ($worktreePath: String!) {
          gitDiffStat(worktreePath: $worktreePath) {
            success error
            files { path additions deletions binary }
          }
        }`,
        { worktreePath }
      )
      return data.gitDiffStat as {
        success: boolean
        files?: GitDiffStatFile[]
        error?: string
      }
    },

    async getFileContent(
      worktreePath: string,
      filePath: string
    ): Promise<{ success: boolean; content: string | null; error?: string }> {
      const data = await graphqlQuery<{
        gitFileContent: { success: boolean; content?: string; error?: string }
      }>(
        `query ($worktreePath: String!, $filePath: String!) {
          gitFileContent(worktreePath: $worktreePath, filePath: $filePath) {
            success content error
          }
        }`,
        { worktreePath, filePath }
      )
      return {
        success: data.gitFileContent.success,
        content: data.gitFileContent.content ?? null,
        error: data.gitFileContent.error ?? undefined
      }
    },

    async getFileContentBase64(
      worktreePath: string,
      filePath: string
    ): Promise<{ success: boolean; data?: string; mimeType?: string; error?: string }> {
      const result = await graphqlQuery<{
        gitFileContentBase64: { success: boolean; content?: string; mimeType?: string; error?: string }
      }>(
        `query ($worktreePath: String!, $filePath: String!) {
          gitFileContentBase64(worktreePath: $worktreePath, filePath: $filePath) {
            success content mimeType error
          }
        }`,
        { worktreePath, filePath }
      )
      const r = result.gitFileContentBase64
      return { success: r.success, data: r.content ?? undefined, mimeType: r.mimeType ?? undefined, error: r.error ?? undefined }
    },

    async getRefContent(
      worktreePath: string,
      ref: string,
      filePath: string
    ): Promise<{ success: boolean; content?: string; error?: string }> {
      const data = await graphqlQuery<{
        gitRefContent: { success: boolean; content?: string; error?: string }
      }>(
        `query ($worktreePath: String!, $ref: String!, $filePath: String!) {
          gitRefContent(worktreePath: $worktreePath, ref: $ref, filePath: $filePath) {
            success content error
          }
        }`,
        { worktreePath, ref, filePath }
      )
      return data.gitRefContent
    },

    async getRefContentBase64(
      worktreePath: string,
      ref: string,
      filePath: string
    ): Promise<{ success: boolean; data?: string; mimeType?: string; error?: string }> {
      const result = await graphqlQuery<{
        gitRefContentBase64: { success: boolean; content?: string; mimeType?: string; error?: string }
      }>(
        `query ($worktreePath: String!, $ref: String!, $filePath: String!) {
          gitRefContentBase64(worktreePath: $worktreePath, ref: $ref, filePath: $filePath) {
            success content mimeType error
          }
        }`,
        { worktreePath, ref, filePath }
      )
      const r = result.gitRefContentBase64
      return { success: r.success, data: r.content ?? undefined, mimeType: r.mimeType ?? undefined, error: r.error ?? undefined }
    },

    // ─── Branch queries ─────────────────────────────────────────
    async getBranchInfo(worktreePath: string): Promise<{
      success: boolean
      branch?: GitBranchInfo
      error?: string
    }> {
      const data = await graphqlQuery<{
        gitBranchInfo: {
          success: boolean
          branch?: { name: string; tracking: string | null; ahead: number; behind: number }
          error?: string
        }
      }>(
        `query ($worktreePath: String!) {
          gitBranchInfo(worktreePath: $worktreePath) {
            success error
            branch { name tracking ahead behind }
          }
        }`,
        { worktreePath }
      )
      return data.gitBranchInfo as {
        success: boolean
        branch?: GitBranchInfo
        error?: string
      }
    },

    async listBranchesWithStatus(projectPath: string): Promise<{
      success: boolean
      branches: Array<{
        name: string
        isRemote: boolean
        isCheckedOut: boolean
        worktreePath?: string
      }>
      error?: string
    }> {
      const data = await graphqlQuery<{
        gitBranchesWithStatus: {
          success: boolean
          branches?: Array<{
            name: string
            isRemote: boolean
            isCheckedOut: boolean
            worktreePath?: string
          }>
          error?: string
        }
      }>(
        `query ($projectPath: String!) {
          gitBranchesWithStatus(projectPath: $projectPath) {
            success error
            branches { name isRemote isCheckedOut worktreePath }
          }
        }`,
        { projectPath }
      )
      return {
        success: data.gitBranchesWithStatus.success,
        branches: data.gitBranchesWithStatus.branches || [],
        error: data.gitBranchesWithStatus.error ?? undefined
      }
    },

    async isBranchMerged(
      worktreePath: string,
      branch: string
    ): Promise<{ success: boolean; isMerged: boolean }> {
      const data = await graphqlQuery<{
        gitIsBranchMerged: { success: boolean; isMerged: boolean }
      }>(
        `query ($worktreePath: String!, $branch: String!) {
          gitIsBranchMerged(worktreePath: $worktreePath, branch: $branch) { success isMerged }
        }`,
        { worktreePath, branch }
      )
      return data.gitIsBranchMerged
    },

    async getRemoteUrl(
      worktreePath: string,
      remote?: string
    ): Promise<{ success: boolean; url: string | null; remote: string | null; error?: string }> {
      const data = await graphqlQuery<{
        gitRemoteUrl: { success: boolean; url?: string; remote?: string; error?: string }
      }>(
        `query ($worktreePath: String!, $remote: String) {
          gitRemoteUrl(worktreePath: $worktreePath, remote: $remote) {
            success url remote error
          }
        }`,
        { worktreePath, remote }
      )
      const r = data.gitRemoteUrl
      return {
        success: r.success,
        url: r.url ?? null,
        remote: r.remote ?? null,
        error: r.error ?? undefined
      }
    },

    async listPRs(projectPath: string): Promise<{
      success: boolean
      prs: Array<{ number: number; title: string; author: string; headRefName: string }>
      error?: string
    }> {
      const data = await graphqlQuery<{
        gitListPRs: {
          success: boolean
          prs?: Array<{ number: number; title: string; author: string; headRefName: string }>
          error?: string
        }
      }>(
        `query ($projectPath: String!) {
          gitListPRs(projectPath: $projectPath) {
            success error
            prs { number title author headRefName }
          }
        }`,
        { projectPath }
      )
      return {
        success: data.gitListPRs.success,
        prs: data.gitListPRs.prs || [],
        error: data.gitListPRs.error ?? undefined
      }
    },

    async getPRState(
      projectPath: string,
      prNumber: number
    ): Promise<{ success: boolean; state?: string; title?: string; error?: string }> {
      const data = await graphqlQuery<{
        gitPRState: { success: boolean; state?: string; error?: string }
      }>(
        `query ($worktreePath: String!, $prNumber: Int!) {
          gitPRState(worktreePath: $worktreePath, prNumber: $prNumber) { success state error }
        }`,
        { worktreePath: projectPath, prNumber }
      )
      return data.gitPRState
    },

    async getPRReviewComments(
      projectPath: string,
      prNumber: number
    ): Promise<{
      success: boolean
      comments?: Array<{
        id: number
        body: string
        bodyHTML: string
        path: string
        line: number | null
        originalLine: number | null
        side: 'LEFT' | 'RIGHT'
        diffHunk: string
        user: { login: string; avatarUrl: string }
        createdAt: string
        updatedAt: string
        inReplyToId: number | null
        pullRequestReviewId: number | null
        subjectType: 'line' | 'file'
      }>
      baseBranch?: string
      error?: string
    }> {
      const data = await graphqlQuery<{
        gitPRReviewComments: {
          success: boolean
          comments?: Array<{
            id: number
            path: string
            line: number | null
            body: string
            user: { login: string }
            createdAt: string
          }>
          error?: string
        }
      }>(
        `query ($worktreePath: String!, $prNumber: Int!) {
          gitPRReviewComments(worktreePath: $worktreePath, prNumber: $prNumber) {
            success error
            comments { id path line body user { login } createdAt }
          }
        }`,
        { worktreePath: projectPath, prNumber }
      )
      const r = data.gitPRReviewComments
      // Map the simplified GraphQL response to the full interface expected by renderer
      const comments = (r.comments || []).map((c) => ({
        id: c.id,
        body: c.body,
        bodyHTML: c.body,
        path: c.path || '',
        line: c.line,
        originalLine: c.line,
        side: 'RIGHT' as const,
        diffHunk: '',
        user: { login: c.user.login, avatarUrl: '' },
        createdAt: c.createdAt,
        updatedAt: c.createdAt,
        inReplyToId: null,
        pullRequestReviewId: null,
        subjectType: 'line' as const
      }))
      return { success: r.success, comments, error: r.error ?? undefined }
    },

    // ─── PR creation / range diff ────────────────────────────────
    async createPR(
      worktreePath: string,
      baseBranch: string,
      title: string,
      body: string
    ): Promise<{ success: boolean; url?: string; number?: number; error?: string }> {
      const data = await graphqlQuery<{
        gitCreatePR: { success: boolean; url?: string; number?: number; error?: string }
      }>(
        `mutation ($worktreePath: String!, $baseBranch: String!, $title: String!, $body: String!) {
          gitCreatePR(worktreePath: $worktreePath, baseBranch: $baseBranch, title: $title, body: $body) {
            success url number error
          }
        }`,
        { worktreePath, baseBranch, title, body }
      )
      return data.gitCreatePR
    },

    async generatePRContent(
      worktreePath: string,
      baseBranch: string,
      provider: string
    ): Promise<{ success: boolean; title?: string; body?: string; error?: string }> {
      const data = await graphqlQuery<{
        gitGeneratePRContent: { success: boolean; title?: string; body?: string; error?: string }
      }>(
        `mutation ($worktreePath: String!, $baseBranch: String!, $provider: String!) {
          gitGeneratePRContent(worktreePath: $worktreePath, baseBranch: $baseBranch, provider: $provider) {
            success title body error
          }
        }`,
        { worktreePath, baseBranch, provider }
      )
      return data.gitGeneratePRContent
    },

    async getRangeDiff(
      worktreePath: string,
      baseBranch: string
    ): Promise<{ commitSummary: string; diffSummary: string; diffPatch: string; commitCount: number }> {
      const data = await graphqlQuery<{
        gitRangeDiff: { commitSummary: string; diffSummary: string; diffPatch: string; commitCount: number }
      }>(
        `query ($worktreePath: String!, $baseBranch: String!) {
          gitRangeDiff(worktreePath: $worktreePath, baseBranch: $baseBranch) {
            commitSummary diffSummary diffPatch commitCount
          }
        }`,
        { worktreePath, baseBranch }
      )
      return data.gitRangeDiff
    },

    async needsPush(worktreePath: string): Promise<boolean> {
      const data = await graphqlQuery<{ gitNeedsPush: boolean }>(
        `query ($worktreePath: String!) {
          gitNeedsPush(worktreePath: $worktreePath)
        }`,
        { worktreePath }
      )
      return data.gitNeedsPush
    },

    // ─── Branch diff queries ────────────────────────────────────
    async getBranchDiffFiles(
      worktreePath: string,
      branch: string
    ): Promise<{
      success: boolean
      files?: Array<{
        relativePath: string
        status: string
        additions: number
        deletions: number
        binary: boolean
      }>
      error?: string
    }> {
      const data = await graphqlQuery<{
        gitBranchDiffFiles: {
          success: boolean
          files?: Array<{
            path: string
            status: string
            additions: number
            deletions: number
            binary: boolean
          }>
          error?: string
        }
      }>(
        `query ($worktreePath: String!, $baseBranch: String!) {
          gitBranchDiffFiles(worktreePath: $worktreePath, baseBranch: $baseBranch) {
            success error
            files { path status additions deletions binary }
          }
        }`,
        { worktreePath, baseBranch: branch }
      )
      const r = data.gitBranchDiffFiles
      return {
        success: r.success,
        files: r.files?.map((f) => ({
          relativePath: f.path,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          binary: f.binary
        })),
        error: r.error ?? undefined
      }
    },

    async getBranchFileDiff(
      worktreePath: string,
      branch: string,
      filePath: string
    ): Promise<{ success: boolean; diff?: string; error?: string }> {
      const data = await graphqlQuery<{
        gitBranchFileDiff: { success: boolean; diff?: string; error?: string }
      }>(
        `query ($worktreePath: String!, $baseBranch: String!, $filePath: String!) {
          gitBranchFileDiff(worktreePath: $worktreePath, baseBranch: $baseBranch, filePath: $filePath) {
            success diff error
          }
        }`,
        { worktreePath, baseBranch: branch, filePath }
      )
      return data.gitBranchFileDiff
    },

    // ─── Hunk operations ────────────────────────────────────────
    async stageHunk(
      worktreePath: string,
      patch: string
    ): Promise<{ success: boolean; error?: string }> {
      const data = await graphqlQuery<{
        gitStageHunk: { success: boolean; error?: string }
      }>(
        `mutation ($worktreePath: String!, $patch: String!) {
          gitStageHunk(worktreePath: $worktreePath, patch: $patch) { success error }
        }`,
        { worktreePath, patch }
      )
      return data.gitStageHunk
    },

    async unstageHunk(
      worktreePath: string,
      patch: string
    ): Promise<{ success: boolean; error?: string }> {
      const data = await graphqlQuery<{
        gitUnstageHunk: { success: boolean; error?: string }
      }>(
        `mutation ($worktreePath: String!, $patch: String!) {
          gitUnstageHunk(worktreePath: $worktreePath, patch: $patch) { success error }
        }`,
        { worktreePath, patch }
      )
      return data.gitUnstageHunk
    },

    async revertHunk(
      worktreePath: string,
      patch: string
    ): Promise<{ success: boolean; error?: string }> {
      const data = await graphqlQuery<{
        gitRevertHunk: { success: boolean; error?: string }
      }>(
        `mutation ($worktreePath: String!, $patch: String!) {
          gitRevertHunk(worktreePath: $worktreePath, patch: $patch) { success error }
        }`,
        { worktreePath, patch }
      )
      return data.gitRevertHunk
    },

    async discardChanges(
      worktreePath: string,
      filePath: string
    ): Promise<{ success: boolean; error?: string }> {
      const data = await graphqlQuery<{
        gitDiscardChanges: { success: boolean; error?: string }
      }>(
        `mutation ($worktreePath: String!, $filePath: String!) {
          gitDiscardChanges(worktreePath: $worktreePath, filePath: $filePath) { success error }
        }`,
        { worktreePath, filePath }
      )
      return data.gitDiscardChanges
    },

    async addToGitignore(
      worktreePath: string,
      pattern: string
    ): Promise<{ success: boolean; error?: string }> {
      const data = await graphqlQuery<{
        gitAddToGitignore: { success: boolean; error?: string }
      }>(
        `mutation ($worktreePath: String!, $pattern: String!) {
          gitAddToGitignore(worktreePath: $worktreePath, pattern: $pattern) { success error }
        }`,
        { worktreePath, pattern }
      )
      return data.gitAddToGitignore
    },

    // ─── Watch / Unwatch ────────────────────────────────────────
    async watchWorktree(worktreePath: string): Promise<{ success: boolean; error?: string }> {
      const data = await graphqlQuery<{
        gitWatchWorktree: { success: boolean; error?: string }
      }>(
        `mutation ($worktreePath: String!) {
          gitWatchWorktree(worktreePath: $worktreePath) { success error }
        }`,
        { worktreePath }
      )
      return data.gitWatchWorktree
    },

    async unwatchWorktree(worktreePath: string): Promise<{ success: boolean; error?: string }> {
      const data = await graphqlQuery<{
        gitUnwatchWorktree: { success: boolean; error?: string }
      }>(
        `mutation ($worktreePath: String!) {
          gitUnwatchWorktree(worktreePath: $worktreePath) { success error }
        }`,
        { worktreePath }
      )
      return data.gitUnwatchWorktree
    },

    async watchBranch(worktreePath: string): Promise<{ success: boolean; error?: string }> {
      const data = await graphqlQuery<{
        gitWatchBranch: { success: boolean; error?: string }
      }>(
        `mutation ($worktreePath: String!) {
          gitWatchBranch(worktreePath: $worktreePath) { success error }
        }`,
        { worktreePath }
      )
      return data.gitWatchBranch
    },

    async unwatchBranch(worktreePath: string): Promise<{ success: boolean; error?: string }> {
      const data = await graphqlQuery<{
        gitUnwatchBranch: { success: boolean; error?: string }
      }>(
        `mutation ($worktreePath: String!) {
          gitUnwatchBranch(worktreePath: $worktreePath) { success error }
        }`,
        { worktreePath }
      )
      return data.gitUnwatchBranch
    },

    // ─── Subscriptions ──────────────────────────────────────────
    onStatusChanged(callback: (event: GitStatusChangedEvent) => void): () => void {
      return graphqlSubscribe<{ gitStatusChanged: GitStatusChangedEvent }>(
        `subscription ($worktreePath: String) {
          gitStatusChanged(worktreePath: $worktreePath) { worktreePath }
        }`,
        undefined,
        (data) => {
          callback(data.gitStatusChanged)
        }
      )
    },

    onBranchChanged(callback: (event: { worktreePath: string }) => void): () => void {
      return graphqlSubscribe<{ gitBranchChanged: { worktreePath: string } }>(
        `subscription ($worktreePath: String) {
          gitBranchChanged(worktreePath: $worktreePath) { worktreePath }
        }`,
        undefined,
        (data) => {
          callback(data.gitBranchChanged)
        }
      )
    },

    // ─── Electron-only stubs ────────────────────────────────────
    openInEditor: notAvailableInWeb('gitOps.openInEditor') as unknown as (
      filePath: string
    ) => Promise<{ success: boolean; error?: string }>,

    showInFinder: notAvailableInWeb('gitOps.showInFinder') as unknown as (
      filePath: string
    ) => Promise<{ success: boolean; error?: string }>
  }
}
