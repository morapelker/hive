import { ipcMain } from 'electron'
import { getTicketProviderManager } from '../services/ticket-providers'
import { getDatabase } from '../db'
import type { TicketProviderId } from '../services/ticket-providers'
import { createLogger } from '../services/logger'

const log = createLogger({ component: 'ticket-import-handlers' })

export function registerTicketImportHandlers(): void {
  log.info('Registering ticket import handlers')

  ipcMain.handle('ticketImport:listProviders', () => {
    const manager = getTicketProviderManager()
    return manager.listProviders().map((p) => ({
      id: p.id,
      name: p.name,
      icon: p.icon
    }))
  })

  ipcMain.handle('ticketImport:getSettingsSchema', (_event, providerId: TicketProviderId) => {
    const provider = getTicketProviderManager().getProvider(providerId)
    return provider.getSettingsSchema()
  })

  ipcMain.handle(
    'ticketImport:authenticate',
    async (_event, providerId: TicketProviderId, settings: Record<string, string>) => {
      const provider = getTicketProviderManager().getProvider(providerId)
      const error = await provider.authenticate(settings)
      return { success: error === null, error }
    }
  )

  ipcMain.handle(
    'ticketImport:detectRepo',
    async (_event, providerId: TicketProviderId, projectPath: string) => {
      const provider = getTicketProviderManager().getProvider(providerId)
      const repo = await provider.detectRepo(projectPath)
      return { repo }
    }
  )

  ipcMain.handle(
    'ticketImport:listIssues',
    async (
      _event,
      providerId: TicketProviderId,
      repo: string,
      options: { page: number; perPage: number; state: 'open' | 'closed' | 'all'; search?: string },
      settings: Record<string, string>
    ) => {
      const provider = getTicketProviderManager().getProvider(providerId)
      return provider.listIssues(repo, options, settings)
    }
  )

  ipcMain.handle(
    'ticketImport:importIssues',
    async (
      _event,
      providerId: TicketProviderId,
      projectId: string,
      repo: string,
      issues: Array<{ externalId: string; title: string; body: string | null; state: string; url: string }>
    ) => {
      const db = getDatabase()
      const imported: string[] = []
      const skipped: string[] = []

      for (const issue of issues) {
        const existing = db.getKanbanTicketByExternalId(providerId, issue.externalId, projectId)
        if (existing) {
          skipped.push(issue.externalId)
          continue
        }

        const column = issue.state === 'closed' ? 'done'
          : issue.state === 'in_progress' ? 'in_progress'
          : 'todo'
        db.createKanbanTicket({
          project_id: projectId,
          title: issue.title,
          description: issue.body,
          column,
          external_provider: providerId,
          external_id: issue.externalId,
          external_url: issue.url
        })
        imported.push(issue.externalId)
      }

      return { imported, skipped }
    }
  )

  ipcMain.handle(
    'ticketImport:getAvailableStatuses',
    async (
      _event,
      providerId: TicketProviderId,
      repo: string,
      externalId: string,
      settings: Record<string, string>
    ) => {
      const provider = getTicketProviderManager().getProvider(providerId)
      return provider.getAvailableStatuses(repo, externalId, settings)
    }
  )

  ipcMain.handle(
    'ticketImport:updateRemoteStatus',
    async (
      _event,
      providerId: TicketProviderId,
      repo: string,
      externalId: string,
      statusId: string,
      settings: Record<string, string>
    ) => {
      const provider = getTicketProviderManager().getProvider(providerId)
      return provider.updateRemoteStatus(repo, externalId, statusId, settings)
    }
  )
}
