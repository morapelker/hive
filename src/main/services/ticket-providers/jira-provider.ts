// src/main/services/ticket-providers/jira-provider.ts

import type {
  TicketProvider,
  SettingsField,
  RemoteIssue,
  RemoteIssueListResult,
  RemoteStatus
} from './ticket-provider-types'
import { createLogger } from '../logger'
import { adfToMarkdown } from './adf-to-markdown'

const log = createLogger({ component: 'JiraProvider' })

export class JiraProvider implements TicketProvider {
  readonly id = 'jira' as const
  readonly name = 'Jira'
  readonly icon = 'jira'

  getSettingsSchema(): SettingsField[] {
    return [
      {
        key: 'jira_domain',
        label: 'Jira Domain',
        type: 'string',
        required: true,
        placeholder: 'mycompany.atlassian.net'
      },
      {
        key: 'jira_email',
        label: 'Atlassian Account Email',
        type: 'string',
        required: true,
        placeholder: 'you@example.com'
      },
      {
        key: 'jira_api_token',
        label: 'API Token',
        type: 'password',
        required: true,
        placeholder: 'Token from id.atlassian.com/manage-profile/security/api-tokens'
      }
    ]
  }

  async authenticate(settings: Record<string, string>): Promise<string | null> {
    const { domain, email, token } = this.extractCredentials(settings)

    if (!domain || !email || !token) {
      return 'Jira domain, email, and API token are all required.'
    }

    try {
      const res = await this.jiraFetch(
        `https://${domain}/rest/api/3/myself`,
        email,
        token
      )

      if (res.status === 401) {
        return 'Jira authentication failed (401). Check your email and API token.'
      }

      if (!res.ok) {
        return `Jira authentication failed (HTTP ${res.status}). Check your domain and credentials.`
      }

      return null
    } catch (err) {
      return `Jira authentication failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  async detectRepo(_projectPath: string): Promise<string | null> {
    // Jira projects are identified by domain, not by git remote URL.
    // The import UI reads the domain directly from provider settings.
    return null
  }

  async listIssues(
    repo: string,
    options: { page: number; perPage: number; state: 'open' | 'closed' | 'all'; search?: string },
    settings: Record<string, string>
  ): Promise<RemoteIssueListResult> {
    const { domain, email, token } = this.extractCredentials(settings)

    if (!email || !token) {
      log.warn('Missing Jira credentials, skipping request')
      return { issues: [], hasNextPage: false, totalCount: 0 }
    }

    // state is intentionally ignored — JQL handles all filtering directly
    const { page, perPage, search } = options
    const jql = search?.trim() ?? ''

    // User must provide a JQL query; without one, return empty result
    if (!jql) {
      return { issues: [], hasNextPage: false, totalCount: 0 }
    }

    const startAt = (page - 1) * perPage

    try {
      const res = await this.jiraFetch(
        `https://${domain}/rest/api/3/search`,
        email,
        token,
        {
          method: 'POST',
          body: JSON.stringify({
            jql,
            startAt,
            maxResults: perPage,
            fields: ['summary', 'description', 'status', 'created', 'updated']
          })
        }
      )

      if (!res.ok) {
        const body = await res.text().catch(() => '')

        // Surface structured Jira JQL error messages
        try {
          const parsed = JSON.parse(body) as { errorMessages?: string[]; warningMessages?: string[] }
          if (parsed.errorMessages && parsed.errorMessages.length > 0) {
            log.error('Jira JQL error', undefined, { status: res.status, errorMessages: parsed.errorMessages })
            throw new Error(`Jira JQL error: ${parsed.errorMessages.join(' ')}`)
          }
        } catch (parseErr) {
          if (parseErr instanceof Error && parseErr.message.startsWith('Jira JQL error:')) {
            throw parseErr
          }
        }

        log.error('Failed to list Jira issues', undefined, { status: res.status, domain })
        return { issues: [], hasNextPage: false, totalCount: 0 }
      }

      const data = (await res.json()) as {
        issues: Array<Record<string, unknown>>
        startAt: number
        maxResults: number
        total: number
      }

      const hasNextPage = data.startAt + data.maxResults < data.total

      return {
        issues: data.issues.map((issue) => this.mapIssue(issue, domain)),
        hasNextPage,
        totalCount: data.total
      }
    } catch (err) {
      if (err instanceof Error) {
        throw err
      }
      return { issues: [], hasNextPage: false, totalCount: 0 }
    }
  }

  async getAvailableStatuses(
    repo: string,
    externalId: string,
    settings: Record<string, string>
  ): Promise<RemoteStatus[]> {
    const { domain, email, token } = this.extractCredentials(settings)

    if (!email || !token) {
      log.warn('Missing Jira credentials, skipping request')
      return []
    }

    try {
      const res = await this.jiraFetch(
        `https://${domain}/rest/api/3/issue/${externalId}/transitions`,
        email,
        token
      )

      if (!res.ok) {
        log.error('Failed to get Jira transitions', undefined, { status: res.status, domain, externalId })
        return []
      }

      const data = (await res.json()) as {
        transitions: Array<{ id: string; name: string }>
      }

      return data.transitions.map((transition) => ({
        id: transition.id,
        label: transition.name
      }))
    } catch (err) {
      log.error(
        'Error fetching Jira transitions',
        err instanceof Error ? err : undefined,
        { error: err instanceof Error ? err.message : String(err) }
      )
      return []
    }
  }

  async updateRemoteStatus(
    repo: string,
    externalId: string,
    statusId: string,
    settings: Record<string, string>
  ): Promise<{ success: boolean; error?: string }> {
    const { domain, email, token } = this.extractCredentials(settings)

    if (!email || !token) {
      return { success: false, error: 'Jira email and API token are required.' }
    }

    try {
      const res = await this.jiraFetch(
        `https://${domain}/rest/api/3/issue/${externalId}/transitions`,
        email,
        token,
        {
          method: 'POST',
          body: JSON.stringify({ transition: { id: statusId } })
        }
      )

      if (res.status === 204) {
        return { success: true }
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        return { success: false, error: `Jira API error (${res.status}): ${body}` }
      }

      return { success: true }
    } catch (err) {
      return {
        success: false,
        error: `Failed to update Jira status: ${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  private extractCredentials(settings: Record<string, string>): {
    domain: string
    email: string
    token: string
  } {
    return {
      domain: (settings.jira_domain?.trim() ?? '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
      email: settings.jira_email?.trim() ?? '',
      token: settings.jira_api_token?.trim() ?? ''
    }
  }

  private buildAuthHeader(email: string, token: string): string {
    const credentials = Buffer.from(`${email}:${token}`).toString('base64')
    return `Basic ${credentials}`
  }

  private async jiraFetch(
    url: string,
    email: string,
    token: string,
    init?: RequestInit
  ): Promise<Response> {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: this.buildAuthHeader(email, token),
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...init?.headers
      }
    })

    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after')
      const waitSeconds = retryAfter ? parseInt(retryAfter, 10) : null
      const waitMsg = waitSeconds != null ? ` Try again in ${waitSeconds} second${waitSeconds !== 1 ? 's' : ''}.` : ''
      log.warn('Jira API rate limited', { url, retryAfter })
      throw new Error(`Rate limited by Jira.${waitMsg}`)
    }

    return res
  }

  private mapIssue(issue: Record<string, unknown>, domain: string): RemoteIssue {
    const key = issue.key as string
    const fields = issue.fields as Record<string, unknown>

    const statusCategory = (
      (fields.status as Record<string, unknown>)?.statusCategory as Record<string, unknown>
    )?.key as string | undefined

    let state: RemoteIssue['state']
    if (statusCategory === 'done') {
      state = 'closed'
    } else if (statusCategory === 'indeterminate') {
      state = 'in_progress'
    } else {
      state = 'open'
    }

    return {
      externalId: key,
      title: fields.summary as string,
      body: fields.description != null ? adfToMarkdown(fields.description) || null : null,
      state,
      url: `https://${domain}/browse/${key}`,
      createdAt: fields.created as string,
      updatedAt: fields.updated as string
    }
  }
}
