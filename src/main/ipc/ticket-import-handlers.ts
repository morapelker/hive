import { Data, Effect } from 'effect'
import { z } from 'zod'

import { getTicketProviderManager } from '../services/ticket-providers'
import { getDatabase } from '../db'
import type { TicketProviderId } from '../services/ticket-providers'
import { createLogger } from '../services/logger'
import { defineHandler } from './_shared/define-handler'

const log = createLogger({ component: 'ticket-import-handlers' })

class TicketImportHandlerFailed extends Data.TaggedError('TicketImportHandlerFailed')<{
  readonly operation: string
  readonly reason: string
  readonly message: string
}> {}

const ticketImportFailed = (operation: string, cause: unknown): TicketImportHandlerFailed => {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return new TicketImportHandlerFailed({ operation, reason, message: reason })
}

const providerIdSchema = z.enum(['github', 'jira']) satisfies z.ZodType<TicketProviderId>
const settingsSchema = z.record(z.string(), z.string())
const listIssuesOptionsSchema = z.object({
  page: z.number(),
  perPage: z.number(),
  state: z.enum(['open', 'closed', 'all']),
  search: z.string().optional(),
  nextPageToken: z.string().optional()
})
const importIssueSchema = z.object({
  externalId: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  url: z.string()
})

export function registerTicketImportHandlers(): void {
  log.info('Registering ticket import handlers')

  defineHandler('ticketImport:listProviders', z.tuple([]), () =>
    Effect.try({
      try: () => {
        const manager = getTicketProviderManager()
        return manager.listProviders().map((p) => ({
          id: p.id,
          name: p.name,
          icon: p.icon
        }))
      },
      catch: (error) => ticketImportFailed('ticketImport:listProviders', error)
    })
  )

  defineHandler('ticketImport:getSettingsSchema', providerIdSchema, (providerId) =>
    Effect.try({
      try: () => {
        const provider = getTicketProviderManager().getProvider(providerId)
        return provider.getSettingsSchema()
      },
      catch: (error) => ticketImportFailed('ticketImport:getSettingsSchema', error)
    })
  )

  defineHandler(
    'ticketImport:authenticate',
    z.tuple([providerIdSchema, settingsSchema]),
    ([providerId, settings]) =>
      Effect.tryPromise({
        try: async () => {
          const provider = getTicketProviderManager().getProvider(providerId)
          const error = await provider.authenticate(settings)
          return { success: error === null, error }
        },
        catch: (error) => ticketImportFailed('ticketImport:authenticate', error)
      })
  )

  defineHandler(
    'ticketImport:detectRepo',
    z.tuple([providerIdSchema, z.string().min(1)]),
    ([providerId, projectPath]) =>
      Effect.tryPromise({
        try: async () => {
          const provider = getTicketProviderManager().getProvider(providerId)
          const repo = await provider.detectRepo(projectPath)
          return { repo }
        },
        catch: (error) => ticketImportFailed('ticketImport:detectRepo', error)
      })
  )

  defineHandler(
    'ticketImport:listIssues',
    z.tuple([providerIdSchema, z.string(), listIssuesOptionsSchema, settingsSchema]),
    ([providerId, repo, options, settings]) =>
      Effect.tryPromise({
        try: () => {
          const provider = getTicketProviderManager().getProvider(providerId)
          return provider.listIssues(repo, options, settings)
        },
        catch: (error) => ticketImportFailed('ticketImport:listIssues', error)
      })
  )

  defineHandler(
    'ticketImport:importIssues',
    z.tuple([providerIdSchema, z.string().min(1), z.string(), z.array(importIssueSchema)]),
    ([providerId, projectId, _repo, issues]) =>
      Effect.try({
        try: () => {
          const db = getDatabase()
          const imported: string[] = []
          const skipped: string[] = []

          for (const issue of issues) {
            const existing = db.getKanbanTicketByExternalId(providerId, issue.externalId, projectId)
            if (existing) {
              skipped.push(issue.externalId)
              continue
            }

            const column =
              issue.state === 'closed'
                ? 'done'
                : issue.state === 'in_progress'
                  ? 'in_progress'
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
        },
        catch: (error) => ticketImportFailed('ticketImport:importIssues', error)
      })
  )

  defineHandler(
    'ticketImport:getAvailableStatuses',
    z.tuple([providerIdSchema, z.string(), z.string().min(1), settingsSchema]),
    ([providerId, repo, externalId, settings]) =>
      Effect.tryPromise({
        try: () => {
          const provider = getTicketProviderManager().getProvider(providerId)
          return provider.getAvailableStatuses(repo, externalId, settings)
        },
        catch: (error) => ticketImportFailed('ticketImport:getAvailableStatuses', error)
      })
  )

  defineHandler(
    'ticketImport:updateRemoteStatus',
    z.tuple([providerIdSchema, z.string(), z.string().min(1), z.string().min(1), settingsSchema]),
    ([providerId, repo, externalId, statusId, settings]) =>
      Effect.tryPromise({
        try: () => {
          const provider = getTicketProviderManager().getProvider(providerId)
          return provider.updateRemoteStatus(repo, externalId, statusId, settings)
        },
        catch: (error) => ticketImportFailed('ticketImport:updateRemoteStatus', error)
      })
  )
}
