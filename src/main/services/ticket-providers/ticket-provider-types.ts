// src/main/services/ticket-providers/ticket-provider-types.ts

export type TicketProviderId = 'github' | 'jira'

export interface SettingsField {
  key: string
  label: string
  type: 'string' | 'password'
  required: boolean
  placeholder?: string
}

export interface RemoteIssue {
  externalId: string
  title: string
  body: string | null
  state: 'open' | 'closed' | 'in_progress'
  url: string
  createdAt: string
  updatedAt: string
}

export interface RemoteIssueListResult {
  issues: RemoteIssue[]
  hasNextPage: boolean
  totalCount: number
  nextPageToken?: string
}

export interface RemoteStatus {
  id: string
  label: string
}

export interface TicketProvider {
  readonly id: TicketProviderId
  readonly name: string
  readonly icon: string

  getSettingsSchema(): SettingsField[]
  authenticate(settings: Record<string, string>): Promise<string | null>
  detectRepo(projectPath: string): Promise<string | null>
  listIssues(
    repo: string,
    options: {
      page: number
      perPage: number
      state: 'open' | 'closed' | 'all'
      search?: string
      nextPageToken?: string
    },
    settings: Record<string, string>
  ): Promise<RemoteIssueListResult>
  getAvailableStatuses(
    repo: string,
    externalId: string,
    settings: Record<string, string>
  ): Promise<RemoteStatus[]>
  updateRemoteStatus(
    repo: string,
    externalId: string,
    statusId: string,
    settings: Record<string, string>
  ): Promise<{ success: boolean; error?: string }>
}
