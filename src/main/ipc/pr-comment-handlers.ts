import { ipcMain } from 'electron'
import { exec } from 'child_process'
import { promisify } from 'util'
import { getDatabase } from '../db'
import { getGitHubService } from '../services/github-service'
import { createLogger } from '../services/logger'

const execAsync = promisify(exec)
const log = createLogger({ component: 'PRCommentHandlers' })

export function registerPRCommentHandlers(): void {
  log.info('Registering PR comment handlers')

  // Fetch PR review comments from GitHub, upsert in SQLite, return comments + base branch
  ipcMain.handle(
    'pr-comments:fetch',
    async (
      _event,
      {
        worktreeId,
        worktreePath,
        prNumber
      }: {
        worktreeId: string
        worktreePath: string
        prNumber: number
      }
    ): Promise<{
      success: boolean
      comments?: import('../../shared/types/pr-comment').PRReviewComment[]
      baseBranch?: string
      error?: string
      errorCode?: 'gh_not_found' | 'auth_failed' | 'not_github' | 'api_error'
    }> => {
      try {
        // 1. Get the remote URL
        const { stdout: remoteUrl } = await execAsync('git remote get-url origin', {
          cwd: worktreePath
        })

        // 2. Parse owner/repo
        const parsed = getGitHubService().parseOwnerRepo(remoteUrl.trim())
        if (!parsed) {
          return {
            success: false,
            error: 'Not a GitHub repository',
            errorCode: 'not_github'
          }
        }
        const { owner, repo } = parsed

        // 3. Fetch review comments
        const commentsResult = await getGitHubService().fetchPRReviewComments(
          worktreePath,
          owner,
          repo,
          prNumber
        )
        if (!commentsResult.success || !commentsResult.data) {
          return {
            success: false,
            error: commentsResult.error || 'Failed to fetch PR review comments',
            errorCode: 'api_error'
          }
        }

        // 4. Fill in worktree_id on each comment
        const comments = commentsResult.data.map((c) => ({
          ...c,
          worktree_id: worktreeId
        }))

        // 5. Get the base branch
        const baseBranchResult = await getGitHubService().getPRBaseBranch(
          worktreePath,
          owner,
          repo,
          prNumber
        )
        const baseBranch = baseBranchResult.success ? baseBranchResult.data : undefined

        // 6. Upsert comments into SQLite
        getDatabase().upsertPRReviewComments(worktreeId, prNumber, comments)

        log.info('Fetched and cached PR review comments', {
          worktreeId,
          prNumber,
          count: comments.length
        })

        return { success: true, comments, baseBranch }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error(
          'Failed to fetch PR comments',
          error instanceof Error ? error : new Error(message),
          { worktreeId, prNumber }
        )

        // Detect specific error types
        if (
          message.includes('ENOENT') ||
          message.includes('not found') ||
          message.includes('command not found') ||
          message.includes('not recognized')
        ) {
          return {
            success: false,
            error: 'GitHub CLI (gh) not found. Install it from https://cli.github.com',
            errorCode: 'gh_not_found'
          }
        }

        if (
          message.includes('auth') ||
          message.includes('401') ||
          message.includes('403') ||
          message.includes('credential')
        ) {
          return {
            success: false,
            error: 'GitHub authentication failed. Run `gh auth login` to authenticate.',
            errorCode: 'auth_failed'
          }
        }

        return {
          success: false,
          error: message,
          errorCode: 'api_error'
        }
      }
    }
  )

  // Read cached comments from SQLite
  ipcMain.handle(
    'pr-comments:get',
    async (
      _event,
      { worktreeId, prNumber }: { worktreeId: string; prNumber: number }
    ): Promise<{
      success: boolean
      comments?: import('../../shared/types/pr-comment').PRReviewComment[]
    }> => {
      try {
        const comments = getDatabase().getPRReviewComments(worktreeId, prNumber)
        return { success: true, comments }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error(
          'Failed to get cached PR comments',
          error instanceof Error ? error : new Error(message),
          { worktreeId, prNumber }
        )
        return { success: false }
      }
    }
  )

  // Delete cached comments for a worktree
  ipcMain.handle(
    'pr-comments:clear',
    async (_event, { worktreeId }: { worktreeId: string }): Promise<{ success: boolean }> => {
      try {
        getDatabase().deletePRReviewComments(worktreeId)
        log.info('Cleared PR review comments', { worktreeId })
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error(
          'Failed to clear PR comments',
          error instanceof Error ? error : new Error(message),
          { worktreeId }
        )
        return { success: false }
      }
    }
  )
}
