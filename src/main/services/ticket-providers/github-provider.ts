// src/main/services/ticket-providers/github-provider.ts

import { exec } from 'child_process'
import { promisify } from 'util'
import type {
  TicketProvider,
  SettingsField,
  RemoteIssue,
  RemoteIssueListResult,
  RemoteStatus
} from './ticket-provider-types'
import { createLogger } from '../logger'

const execAsync = promisify(exec)
const log = createLogger({ component: 'GitHubProvider' })

export class GitHubProvider implements TicketProvider {
  readonly id = 'github' as const
  readonly name = 'GitHub Issues'
  readonly icon = 'github'

  getSettingsSchema(): SettingsField[] {
    return [
      {
        key: 'github_pat',
        label: 'Personal Access Token',
        type: 'password',
        required: false,
        placeholder: 'ghp_... (optional if gh CLI is authenticated)'
      }
    ]
  }

  async authenticate(settings: Record<string, string>): Promise<string | null> {
    const token = await this.resolveToken(settings)
    if (!token) {
      return 'No GitHub token found. Install and authenticate the GitHub CLI (`gh auth login`), or provide a Personal Access Token in Settings > Integrations.'
    }

    try {
      const res = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
      })
      if (!res.ok) {
        return `GitHub authentication failed (HTTP ${res.status}). Check your token.`
      }
      return null
    } catch (err) {
      return `GitHub authentication failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  async detectRepo(projectPath: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(
        "gh repo view --json nameWithOwner -q '.nameWithOwner'",
        { cwd: projectPath, timeout: 5000 }
      )
      const trimmed = stdout.trim()
      if (trimmed && trimmed.includes('/')) return trimmed
    } catch {
      // gh CLI not available or not a GitHub repo
    }

    try {
      const { stdout } = await execAsync('git remote get-url origin', {
        cwd: projectPath,
        timeout: 5000
      })
      return this.parseGitHubUrl(stdout.trim())
    } catch {
      return null
    }
  }

  async listIssues(
    repo: string,
    options: { page: number; perPage: number; state: 'open' | 'closed' | 'all'; search?: string },
    settings: Record<string, string>
  ): Promise<RemoteIssueListResult> {
    const token = await this.resolveToken(settings)
    if (!token) {
      return { issues: [], hasNextPage: false, totalCount: 0 }
    }

    const { page, perPage, state, search } = options

    if (search && search.trim()) {
      return this.searchIssues(repo, token, { page, perPage, state, query: search.trim() })
    }

    const url = new URL(`https://api.github.com/repos/${repo}/issues`)
    url.searchParams.set('state', state)
    url.searchParams.set('page', String(page))
    url.searchParams.set('per_page', String(perPage))
    url.searchParams.set('sort', 'updated')
    url.searchParams.set('direction', 'desc')

    const res = await this.ghFetch(url.toString(), token)
    if (!res.ok) {
      log.error('Failed to list issues', { status: res.status, repo })
      return { issues: [], hasNextPage: false, totalCount: 0 }
    }

    const data = (await res.json()) as Array<Record<string, unknown>>
    const issuesOnly = data.filter((item) => !item.pull_request)

    const linkHeader = res.headers.get('link') ?? ''
    const hasNextPage = linkHeader.includes('rel="next"')

    return {
      issues: issuesOnly.map((item) => this.mapIssue(item)),
      hasNextPage,
      totalCount: -1
    }
  }

  async getAvailableStatuses(
    _repo: string,
    _externalId: string,
    _settings: Record<string, string>
  ): Promise<RemoteStatus[]> {
    return [
      { id: 'open', label: 'Open' },
      { id: 'closed', label: 'Closed' }
    ]
  }

  async updateRemoteStatus(
    repo: string,
    externalId: string,
    statusId: string,
    settings: Record<string, string>
  ): Promise<{ success: boolean; error?: string }> {
    const token = await this.resolveToken(settings)
    if (!token) {
      return { success: false, error: 'No GitHub token available.' }
    }

    if (statusId !== 'open' && statusId !== 'closed') {
      return { success: false, error: `Invalid status: "${statusId}". Must be "open" or "closed".` }
    }

    try {
      const res = await this.ghFetch(
        `https://api.github.com/repos/${repo}/issues/${externalId}`,
        token,
        {
          method: 'PATCH',
          body: JSON.stringify({ state: statusId })
        }
      )

      if (!res.ok) {
        const body = await res.text()
        return { success: false, error: `GitHub API error (${res.status}): ${body}` }
      }
      return { success: true }
    } catch (err) {
      return {
        success: false,
        error: `Failed to update status: ${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  private async resolveToken(settings: Record<string, string>): Promise<string | null> {
    if (settings.github_pat?.trim()) {
      return settings.github_pat.trim()
    }

    try {
      const { stdout } = await execAsync('gh auth token', { timeout: 5000 })
      const token = stdout.trim()
      if (token) return token
    } catch {
      // gh CLI not available or not authenticated
    }

    if (process.env.GITHUB_TOKEN?.trim()) {
      return process.env.GITHUB_TOKEN.trim()
    }

    return null
  }

  private async ghFetch(
    url: string,
    token: string,
    init?: RequestInit
  ): Promise<Response> {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...init?.headers
      }
    })

    // Check for rate limit
    if (res.status === 403 || res.status === 429) {
      const resetHeader = res.headers.get('x-ratelimit-reset')
      if (resetHeader) {
        const resetTime = parseInt(resetHeader, 10) * 1000
        const waitMinutes = Math.ceil((resetTime - Date.now()) / 60000)
        log.warn('GitHub API rate limited', { resetTime, waitMinutes })
        throw new Error(
          `Rate limited by GitHub. Try again in ${waitMinutes > 0 ? `${waitMinutes} minute${waitMinutes > 1 ? 's' : ''}` : 'a moment'}.`
        )
      }
    }

    return res
  }

  private async searchIssues(
    repo: string,
    token: string,
    options: { page: number; perPage: number; state: string; query: string }
  ): Promise<RemoteIssueListResult> {
    const stateFilter = options.state === 'all' ? '' : ` state:${options.state}`
    const q = `${options.query} repo:${repo} is:issue${stateFilter}`

    const url = new URL('https://api.github.com/search/issues')
    url.searchParams.set('q', q)
    url.searchParams.set('page', String(options.page))
    url.searchParams.set('per_page', String(options.perPage))
    url.searchParams.set('sort', 'updated')
    url.searchParams.set('order', 'desc')

    const res = await this.ghFetch(url.toString(), token)
    if (!res.ok) {
      log.error('Failed to search issues', { status: res.status, repo })
      return { issues: [], hasNextPage: false, totalCount: 0 }
    }

    const data = (await res.json()) as { total_count: number; items: Array<Record<string, unknown>> }
    const linkHeader = res.headers.get('link') ?? ''
    const hasNextPage = linkHeader.includes('rel="next"')

    return {
      issues: data.items.map((item) => this.mapIssue(item)),
      hasNextPage,
      totalCount: data.total_count
    }
  }

  private mapIssue(item: Record<string, unknown>): RemoteIssue {
    return {
      externalId: String(item.number),
      title: item.title as string,
      body: (item.body as string) ?? null,
      state: (item.state as string) === 'open' ? 'open' : 'closed',
      url: item.html_url as string,
      createdAt: item.created_at as string,
      updatedAt: item.updated_at as string
    }
  }

  private parseGitHubUrl(url: string): string | null {
    const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/)
    if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`

    const sshMatch = url.match(/github\.com:([^/]+)\/([^/.]+)/)
    if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`

    return null
  }
}
