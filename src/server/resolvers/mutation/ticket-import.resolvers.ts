import type { Resolvers } from '../../__generated__/resolvers-types'
import { getTicketProviderManager } from '../../../main/services/ticket-providers'
import type { TicketProviderId } from '../../../main/services/ticket-providers'

export const ticketImportMutationResolvers: Resolvers = {
  Mutation: {
    ticketImportAuthenticate: async (_parent, { providerId, settings: settingsJson }) => {
      const settings = JSON.parse(settingsJson) as Record<string, string>
      const provider = getTicketProviderManager().getProvider(providerId as TicketProviderId)
      const error = await provider.authenticate(settings)
      return { success: error === null, error }
    },

    ticketImportIssues: async (_parent, { input }, ctx) => {
      const db = ctx.db
      const imported: string[] = []
      const skipped: string[] = []

      for (const issue of input.issues) {
        const existing = db.getKanbanTicketByExternalId(
          input.providerId,
          issue.externalId,
          input.projectId
        )
        if (existing) {
          skipped.push(issue.externalId)
          continue
        }

        const column = issue.state === 'closed' ? 'done' : 'todo'
        db.createKanbanTicket({
          project_id: input.projectId,
          title: issue.title,
          description: issue.body ?? null,
          column,
          external_provider: input.providerId,
          external_id: issue.externalId,
          external_url: issue.url
        })
        imported.push(issue.externalId)
      }

      return { imported, skipped }
    },

    ticketImportUpdateRemoteStatus: async (_parent, { input, settings: settingsJson }) => {
      const settings = JSON.parse(settingsJson) as Record<string, string>
      const provider = getTicketProviderManager().getProvider(input.providerId as TicketProviderId)
      const result = await provider.updateRemoteStatus(
        input.repo,
        input.externalId,
        input.statusId,
        settings
      )
      return { success: result.success, error: result.error ?? null }
    }
  }
}
