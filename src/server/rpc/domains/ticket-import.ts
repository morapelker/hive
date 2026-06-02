import { Effect } from 'effect'
import { z } from 'zod'
import {
  getTicketProviderManager,
  type RemoteIssueListResult,
  type RemoteStatus,
  type SettingsField,
  type TicketProviderId
} from '../../../main/services/ticket-providers'
import { getDatabase } from '../../../main/db'
import type { RpcHandler } from '../router'

export interface TicketImportProviderSummary {
  readonly id: TicketProviderId
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

export interface TicketImportUpdateRemoteStatusResult {
  readonly success: boolean
  readonly error?: string
}

export interface TicketImportRpcService {
  readonly listProviders: () => Effect.Effect<TicketImportProviderSummary[], unknown, never>
  readonly getSettingsSchema: (
    providerId: TicketProviderId
  ) => Effect.Effect<SettingsField[], unknown, never>
  readonly authenticate: (
    providerId: TicketProviderId,
    settings: Record<string, string>
  ) => Effect.Effect<TicketImportAuthenticateResult, unknown, never>
  readonly detectRepo: (
    providerId: TicketProviderId,
    projectPath: string
  ) => Effect.Effect<TicketImportDetectRepoResult, unknown, never>
  readonly listIssues: (
    providerId: TicketProviderId,
    repo: string,
    options: TicketImportListIssuesOptions,
    settings: Record<string, string>
  ) => Effect.Effect<RemoteIssueListResult, unknown, never>
  readonly importIssues: (
    providerId: TicketProviderId,
    projectId: string,
    repo: string,
    issues: TicketImportIssueToImport[]
  ) => Effect.Effect<TicketImportImportIssuesResult, unknown, never>
  readonly getAvailableStatuses: (
    providerId: TicketProviderId,
    repo: string,
    externalId: string,
    settings: Record<string, string>
  ) => Effect.Effect<RemoteStatus[], unknown, never>
  readonly updateRemoteStatus: (
    providerId: TicketProviderId,
    repo: string,
    externalId: string,
    statusId: string,
    settings: Record<string, string>
  ) => Effect.Effect<TicketImportUpdateRemoteStatusResult, unknown, never>
}

const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])
const providerIdSchema = z.enum(['github', 'jira']) satisfies z.ZodType<TicketProviderId>
const settingsSchema = z.record(z.string(), z.string())
const listIssuesOptionsSchema = z.object({
  page: z.number(),
  perPage: z.number(),
  state: z.enum(['open', 'closed', 'all']),
  search: z.string().optional(),
  nextPageToken: z.string().optional()
})
type TicketImportListIssuesOptions = z.infer<typeof listIssuesOptionsSchema>
const getSettingsSchemaParamsSchema = z
  .object({
    providerId: providerIdSchema
  })
  .strict()
const authenticateParamsSchema = z
  .object({
    providerId: providerIdSchema,
    settings: settingsSchema
  })
  .strict()
const detectRepoParamsSchema = z
  .object({
    providerId: providerIdSchema,
    projectPath: z.string().min(1)
  })
  .strict()
const listIssuesParamsSchema = z
  .object({
    providerId: providerIdSchema,
    repo: z.string(),
    options: listIssuesOptionsSchema,
    settings: settingsSchema
  })
  .strict()
const importIssueSchema = z.object({
  externalId: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  url: z.string()
})
const importIssuesParamsSchema = z
  .object({
    providerId: providerIdSchema,
    projectId: z.string().min(1),
    repo: z.string(),
    issues: z.array(importIssueSchema)
  })
  .strict()
const getAvailableStatusesParamsSchema = z
  .object({
    providerId: providerIdSchema,
    repo: z.string(),
    externalId: z.string().min(1),
    settings: settingsSchema
  })
  .strict()
const updateRemoteStatusParamsSchema = z
  .object({
    providerId: providerIdSchema,
    repo: z.string(),
    externalId: z.string().min(1),
    statusId: z.string().min(1),
    settings: settingsSchema
  })
  .strict()

export const makeLiveTicketImportRpcService = (): TicketImportRpcService => ({
  listProviders: () =>
    Effect.try({
      try: () =>
        getTicketProviderManager()
          .listProviders()
          .map((provider) => ({
            id: provider.id,
            name: provider.name,
            icon: provider.icon
          })),
      catch: (cause) => cause
    }),
  getSettingsSchema: (providerId) =>
    Effect.try({
      try: () => getTicketProviderManager().getProvider(providerId).getSettingsSchema(),
      catch: (cause) => cause
    }),
  authenticate: (providerId, settings) =>
    Effect.tryPromise({
      try: async () => {
        const provider = getTicketProviderManager().getProvider(providerId)
        const error = await provider.authenticate(settings)
        return { success: error === null, error }
      },
      catch: (cause) => cause
    }),
  detectRepo: (providerId, projectPath) =>
    Effect.tryPromise({
      try: async () => {
        const provider = getTicketProviderManager().getProvider(providerId)
        const repo = await provider.detectRepo(projectPath)
        return { repo }
      },
      catch: (cause) => cause
    }),
  listIssues: (providerId, repo, options, settings) =>
    Effect.tryPromise({
      try: () => {
        const provider = getTicketProviderManager().getProvider(providerId)
        return provider.listIssues(repo, options, settings)
      },
      catch: (cause) => cause
    }),
  importIssues: (providerId, projectId, _repo, issues) =>
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
      catch: (cause) => cause
    }),
  getAvailableStatuses: (providerId, repo, externalId, settings) =>
    Effect.tryPromise({
      try: () => {
        const provider = getTicketProviderManager().getProvider(providerId)
        return provider.getAvailableStatuses(repo, externalId, settings)
      },
      catch: (cause) => cause
    }),
  updateRemoteStatus: (providerId, repo, externalId, statusId, settings) =>
    Effect.tryPromise({
      try: () => {
        const provider = getTicketProviderManager().getProvider(providerId)
        return provider.updateRemoteStatus(repo, externalId, statusId, settings)
      },
      catch: (cause) => cause
    })
})

export const makeTicketImportRpcHandlers = (
  service: TicketImportRpcService = makeLiveTicketImportRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'ticketImport.listProviders',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.listProviders()
        })
    ],
    [
      'ticketImport.getSettingsSchema',
      (params) =>
        Effect.gen(function* () {
          const { providerId } = yield* Effect.try({
            try: () => getSettingsSchemaParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getSettingsSchema(providerId)
        })
    ],
    [
      'ticketImport.authenticate',
      (params) =>
        Effect.gen(function* () {
          const { providerId, settings } = yield* Effect.try({
            try: () => authenticateParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.authenticate(providerId, settings)
        })
    ],
    [
      'ticketImport.detectRepo',
      (params) =>
        Effect.gen(function* () {
          const { providerId, projectPath } = yield* Effect.try({
            try: () => detectRepoParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.detectRepo(providerId, projectPath)
        })
    ],
    [
      'ticketImport.listIssues',
      (params) =>
        Effect.gen(function* () {
          const { providerId, repo, options, settings } = yield* Effect.try({
            try: () => listIssuesParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.listIssues(providerId, repo, options, settings)
        })
    ],
    [
      'ticketImport.importIssues',
      (params) =>
        Effect.gen(function* () {
          const { providerId, projectId, repo, issues } = yield* Effect.try({
            try: () => importIssuesParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.importIssues(providerId, projectId, repo, issues)
        })
    ],
    [
      'ticketImport.getAvailableStatuses',
      (params) =>
        Effect.gen(function* () {
          const { providerId, repo, externalId, settings } = yield* Effect.try({
            try: () => getAvailableStatusesParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getAvailableStatuses(providerId, repo, externalId, settings)
        })
    ],
    [
      'ticketImport.updateRemoteStatus',
      (params) =>
        Effect.gen(function* () {
          const { providerId, repo, externalId, statusId, settings } = yield* Effect.try({
            try: () => updateRemoteStatusParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.updateRemoteStatus(providerId, repo, externalId, statusId, settings)
        })
    ]
  ])
