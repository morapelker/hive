import type { Envelope } from '@shared/types/ipc-envelope'
import { getRendererRpcClient } from './rpc-client'

export interface TicketImportSettingsField {
  readonly key: string
  readonly label: string
  readonly type: string
  readonly required: boolean
  readonly placeholder?: string
}

export interface TicketImportProviderSummary {
  readonly id: string
  readonly name: string
  readonly icon: string
}

export interface TicketImportAuthenticateResult {
  readonly success: boolean
  readonly error: string | null
}

export interface TicketImportDetectRepoResult {
  readonly repo: string | null
}

export interface TicketImportRemoteIssue {
  readonly externalId: string
  readonly title: string
  readonly body: string | null
  readonly state: 'open' | 'closed' | 'in_progress'
  readonly url: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface TicketImportListIssuesOptions {
  readonly page: number
  readonly perPage: number
  readonly state: 'open' | 'closed' | 'all'
  readonly search?: string
  readonly nextPageToken?: string
}

export interface TicketImportListIssuesResult {
  readonly issues: TicketImportRemoteIssue[]
  readonly hasNextPage: boolean
  readonly totalCount: number
  readonly nextPageToken?: string
}

export interface TicketImportIssueToImport {
  readonly externalId: string
  readonly title: string
  readonly body: string | null
  readonly state: string
  readonly url: string
}

export interface TicketImportImportIssuesResult {
  readonly imported: string[]
  readonly skipped: string[]
}

export interface TicketImportRemoteStatus {
  readonly id: string
  readonly label: string
}

export interface TicketImportUpdateRemoteStatusResult {
  readonly success: boolean
  readonly error?: string
}

const toEnvelope = async <A>(request: Promise<A>): Promise<Envelope<A>> => {
  try {
    return { success: true, value: await request }
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    const maybeDetails = error as Error & { details?: unknown }
    return {
      success: false,
      errorCode: error.name || 'INTERNAL_ERROR',
      error: error.message,
      ...(maybeDetails.details === undefined ? {} : { details: maybeDetails.details })
    }
  }
}

export const ticketImportApi = {
  listProviders: (): Promise<Envelope<TicketImportProviderSummary[]>> =>
    toEnvelope(
      getRendererRpcClient().request<TicketImportProviderSummary[]>(
        'ticketImport.listProviders',
        {}
      )
    ),
  getSettingsSchema: (providerId: string): Promise<Envelope<TicketImportSettingsField[]>> =>
    toEnvelope(
      getRendererRpcClient().request<TicketImportSettingsField[]>(
        'ticketImport.getSettingsSchema',
        {
          providerId
        }
      )
    ),
  authenticate: (
    providerId: string,
    settings: Record<string, string>
  ): Promise<Envelope<TicketImportAuthenticateResult>> =>
    toEnvelope(
      getRendererRpcClient().request<TicketImportAuthenticateResult>('ticketImport.authenticate', {
        providerId,
        settings
      })
    ),
  detectRepo: (
    providerId: string,
    projectPath: string
  ): Promise<Envelope<TicketImportDetectRepoResult>> =>
    toEnvelope(
      getRendererRpcClient().request<TicketImportDetectRepoResult>('ticketImport.detectRepo', {
        providerId,
        projectPath
      })
    ),
  listIssues: (
    providerId: string,
    repo: string,
    options: TicketImportListIssuesOptions,
    settings: Record<string, string>
  ): Promise<Envelope<TicketImportListIssuesResult>> =>
    toEnvelope(
      getRendererRpcClient().request<TicketImportListIssuesResult>('ticketImport.listIssues', {
        providerId,
        repo,
        options,
        settings
      })
    ),
  importIssues: (
    providerId: string,
    projectId: string,
    repo: string,
    issues: TicketImportIssueToImport[]
  ): Promise<Envelope<TicketImportImportIssuesResult>> =>
    toEnvelope(
      getRendererRpcClient().request<TicketImportImportIssuesResult>('ticketImport.importIssues', {
        providerId,
        projectId,
        repo,
        issues
      })
    ),
  getAvailableStatuses: (
    providerId: string,
    repo: string,
    externalId: string,
    settings: Record<string, string>
  ): Promise<Envelope<TicketImportRemoteStatus[]>> =>
    toEnvelope(
      getRendererRpcClient().request<TicketImportRemoteStatus[]>(
        'ticketImport.getAvailableStatuses',
        {
          providerId,
          repo,
          externalId,
          settings
        }
      )
    ),
  updateRemoteStatus: (
    providerId: string,
    repo: string,
    externalId: string,
    statusId: string,
    settings: Record<string, string>
  ): Promise<Envelope<TicketImportUpdateRemoteStatusResult>> =>
    toEnvelope(
      getRendererRpcClient().request<TicketImportUpdateRemoteStatusResult>(
        'ticketImport.updateRemoteStatus',
        {
          providerId,
          repo,
          externalId,
          statusId,
          settings
        }
      )
    )
}
