import { exec } from 'child_process'
import { promisify } from 'util'
import { Octokit } from '@octokit/rest'
import { createLogger } from './logger'
import type { PRReviewComment } from '../../shared/types/pr-comment'

const execAsync = promisify(exec)
const log = createLogger({ component: 'GitHubService' })

export class GitHubService {
  /** Cached auth token (process-lifetime) */
  private tokenCache: string | null = null

  /** Cached Octokit instances keyed by token */
  private octokitCache = new Map<string, Octokit>()

  /**
   * Get a GitHub auth token via `gh auth token`.
   * Caches the result for the lifetime of the process.
   */
  async getAuthToken(cwd: string): Promise<string> {
    if (this.tokenCache) return this.tokenCache

    try {
      const { stdout } = await execAsync('gh auth token', { cwd })
      const token = stdout.trim()
      if (!token) {
        throw new Error('gh auth token returned empty string')
      }
      this.tokenCache = token
      return token
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error(
        'Failed to get GitHub auth token via gh CLI',
        error instanceof Error ? error : new Error(message)
      )
      throw new Error(
        'Could not get GitHub auth token. Ensure the gh CLI is installed and authenticated.'
      )
    }
  }

  /**
   * Create an authenticated Octokit instance.
   * Caches per token value.
   */
  private async getOctokit(cwd: string): Promise<Octokit> {
    const token = await this.getAuthToken(cwd)
    const cached = this.octokitCache.get(token)
    if (cached) return cached

    const octokit = new Octokit({ auth: token })
    this.octokitCache.set(token, octokit)
    return octokit
  }

  /**
   * Parse owner/repo from a git remote URL (HTTPS or SSH).
   * Returns null if the URL cannot be parsed.
   */
  parseOwnerRepo(remoteUrl: string): { owner: string; repo: string } | null {
    // SSH: git@github.com:owner/repo.git
    const sshMatch = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/)
    if (sshMatch) {
      return { owner: sshMatch[1], repo: sshMatch[2] }
    }

    // HTTPS: https://github.com/owner/repo.git
    const httpsMatch = remoteUrl.match(
      /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/
    )
    if (httpsMatch) {
      return { owner: httpsMatch[1], repo: httpsMatch[2] }
    }

    return null
  }

  /**
   * Fetch all review comments for a PR with pagination.
   * Determines is_outdated by comparing each comment's commit_id to the PR head.
   */
  async fetchPRReviewComments(
    cwd: string,
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<{ success: boolean; data?: PRReviewComment[]; error?: string }> {
    try {
      const octokit = await this.getOctokit(cwd)

      // Get PR head commit to determine outdated status
      const { data: pr } = await octokit.pulls.get({
        owner,
        repo,
        pull_number: prNumber
      })
      const headCommitSha = pr.head.sha

      // Fetch all review comments with pagination
      const rawComments = await octokit.paginate(
        octokit.pulls.listReviewComments,
        {
          owner,
          repo,
          pull_number: prNumber,
          per_page: 100
        }
      )

      const now = new Date().toISOString()

      const comments: PRReviewComment[] = rawComments.map((c) => ({
        id: c.id,
        worktree_id: '', // filled in by caller
        pull_number: prNumber,
        node_id: c.node_id,
        diff_hunk: c.diff_hunk,
        path: c.path,
        position: c.position ?? null,
        line: c.line ?? null,
        original_line: c.original_line ?? null,
        side: (c.side as 'LEFT' | 'RIGHT') || 'RIGHT',
        start_line: c.start_line ?? null,
        start_side: (c.start_side as 'LEFT' | 'RIGHT' | null) ?? null,
        in_reply_to_id: c.in_reply_to_id ?? null,
        body: c.body,
        author_login: c.user?.login ?? 'unknown',
        author_avatar_url: c.user?.avatar_url ?? '',
        commit_id: c.commit_id,
        original_commit_id: c.original_commit_id,
        created_at: c.created_at,
        updated_at: c.updated_at,
        is_outdated: c.commit_id !== headCommitSha,
        fetched_at: now
      }))

      log.info('Fetched PR review comments', {
        owner,
        repo,
        prNumber,
        count: comments.length
      })

      return { success: true, data: comments }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error(
        'Failed to fetch PR review comments',
        error instanceof Error ? error : new Error(message),
        { owner, repo, prNumber }
      )
      return { success: false, error: message }
    }
  }

  /**
   * Get the base branch for a PR (for diff comparison).
   */
  async getPRBaseBranch(
    cwd: string,
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<{ success: boolean; data?: string; error?: string }> {
    try {
      const octokit = await this.getOctokit(cwd)
      const { data: pr } = await octokit.pulls.get({
        owner,
        repo,
        pull_number: prNumber
      })

      return { success: true, data: pr.base.ref }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error(
        'Failed to get PR base branch',
        error instanceof Error ? error : new Error(message),
        { owner, repo, prNumber }
      )
      return { success: false, error: message }
    }
  }
}

/** Singleton instance */
let githubService: GitHubService | null = null

export function getGitHubService(): GitHubService {
  if (!githubService) {
    githubService = new GitHubService()
  }
  return githubService
}
