import { graphqlQuery } from '../client'

export function createTicketImportAdapter() {
  return {
    async listProviders() {
      const result = await graphqlQuery<{
        ticketImportProviders: Array<{ id: string; name: string; icon: string }>
      }>(`query { ticketImportProviders { id name icon } }`)
      return result.ticketImportProviders
    },

    async getSettingsSchema(providerId: string) {
      const result = await graphqlQuery<{
        ticketImportSettingsSchema: Array<{
          key: string
          label: string
          type: string
          required: boolean
          placeholder: string | null
        }>
      }>(
        `query ($providerId: String!) {
          ticketImportSettingsSchema(providerId: $providerId) { key label type required placeholder }
        }`,
        { providerId }
      )
      return result.ticketImportSettingsSchema
    },

    async authenticate(providerId: string, settings: Record<string, string>) {
      const result = await graphqlQuery<{
        ticketImportAuthenticate: { success: boolean; error: string | null }
      }>(
        `mutation ($providerId: String!, $settings: String!) {
          ticketImportAuthenticate(providerId: $providerId, settings: $settings) { success error }
        }`,
        { providerId, settings: JSON.stringify(settings) }
      )
      return result.ticketImportAuthenticate
    },

    async detectRepo(providerId: string, projectPath: string) {
      const result = await graphqlQuery<{
        ticketImportDetectRepo: { repo: string | null }
      }>(
        `query ($providerId: String!, $projectPath: String!) {
          ticketImportDetectRepo(providerId: $providerId, projectPath: $projectPath) { repo }
        }`,
        { providerId, projectPath }
      )
      return result.ticketImportDetectRepo
    },

    async listIssues(
      providerId: string,
      repo: string,
      options: { page: number; perPage: number; state: 'open' | 'closed' | 'all'; search?: string; nextPageToken?: string },
      settings: Record<string, string>
    ) {
      const result = await graphqlQuery<{
        ticketImportListIssues: {
          issues: Array<{
            externalId: string
            title: string
            body: string | null
            state: 'open' | 'closed' | 'in_progress'
            url: string
            createdAt: string
            updatedAt: string
          }>
          hasNextPage: boolean
          totalCount: number
          nextPageToken?: string
        }
      }>(
        `query ($input: ListIssuesInput!, $settings: String!) {
          ticketImportListIssues(input: $input, settings: $settings) {
            issues { externalId title body state url createdAt updatedAt }
            hasNextPage totalCount nextPageToken
          }
        }`,
        {
          input: { providerId, repo, ...options },
          settings: JSON.stringify(settings)
        }
      )
      return result.ticketImportListIssues
    },

    async importIssues(
      providerId: string,
      projectId: string,
      repo: string,
      issues: Array<{
        externalId: string
        title: string
        body: string | null
        state: string
        url: string
      }>
    ) {
      const result = await graphqlQuery<{
        ticketImportIssues: { imported: string[]; skipped: string[] }
      }>(
        `mutation ($input: ImportIssuesInput!) {
          ticketImportIssues(input: $input) { imported skipped }
        }`,
        { input: { providerId, projectId, repo, issues } }
      )
      return result.ticketImportIssues
    },

    async getAvailableStatuses(
      providerId: string,
      repo: string,
      externalId: string,
      settings: Record<string, string>
    ) {
      const result = await graphqlQuery<{
        ticketImportAvailableStatuses: Array<{ id: string; label: string }>
      }>(
        `query ($providerId: String!, $repo: String!, $externalId: String!, $settings: String!) {
          ticketImportAvailableStatuses(
            providerId: $providerId, repo: $repo, externalId: $externalId, settings: $settings
          ) { id label }
        }`,
        { providerId, repo, externalId, settings: JSON.stringify(settings) }
      )
      return result.ticketImportAvailableStatuses
    },

    async updateRemoteStatus(
      providerId: string,
      repo: string,
      externalId: string,
      statusId: string,
      settings: Record<string, string>
    ) {
      const result = await graphqlQuery<{
        ticketImportUpdateRemoteStatus: { success: boolean; error: string | null }
      }>(
        `mutation ($input: UpdateRemoteStatusInput!, $settings: String!) {
          ticketImportUpdateRemoteStatus(input: $input, settings: $settings) { success error }
        }`,
        {
          input: { providerId, repo, externalId, statusId },
          settings: JSON.stringify(settings)
        }
      )
      return result.ticketImportUpdateRemoteStatus
    }
  }
}
