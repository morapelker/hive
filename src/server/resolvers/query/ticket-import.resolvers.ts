import type { Resolvers } from '../../__generated__/resolvers-types'
import { getTicketProviderManager } from '../../../main/services/ticket-providers'
import type { TicketProviderId } from '../../../main/services/ticket-providers'

export const ticketImportQueryResolvers: Resolvers = {
  Query: {
    ticketImportProviders: () => {
      return getTicketProviderManager()
        .listProviders()
        .map((p) => ({ id: p.id, name: p.name, icon: p.icon }))
    },

    ticketImportSettingsSchema: (_parent, { providerId }) => {
      const provider = getTicketProviderManager().getProvider(providerId as TicketProviderId)
      return provider.getSettingsSchema()
    },

    ticketImportDetectRepo: async (_parent, { providerId, projectPath }) => {
      const provider = getTicketProviderManager().getProvider(providerId as TicketProviderId)
      const repo = await provider.detectRepo(projectPath)
      return { repo }
    },

    ticketImportListIssues: async (_parent, { input, settings: settingsJson }) => {
      const settings = JSON.parse(settingsJson) as Record<string, string>
      const provider = getTicketProviderManager().getProvider(input.providerId as TicketProviderId)
      return provider.listIssues(
        input.repo,
        {
          page: input.page,
          perPage: input.perPage,
          state: input.state as 'open' | 'closed' | 'all',
          search: input.search ?? undefined
        },
        settings
      )
    },

    ticketImportAvailableStatuses: async (_parent, { providerId, repo, externalId, settings: settingsJson }) => {
      const settings = JSON.parse(settingsJson) as Record<string, string>
      const provider = getTicketProviderManager().getProvider(providerId as TicketProviderId)
      return provider.getAvailableStatuses(repo, externalId, settings)
    }
  }
}
