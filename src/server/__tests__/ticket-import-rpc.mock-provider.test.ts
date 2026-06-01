import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { makeEventBus } from '../events/event-bus'
import type { TicketImportRpcService } from '../rpc/domains/ticket-import'
import { makeRpcRouter } from '../rpc/router'

describe('ticket import RPC mocked provider', () => {
  it('routes ticketImport.listProviders to the injected provider service', async () => {
    const providers = [
      { id: 'github' as const, name: 'GitHub', icon: 'github' },
      { id: 'jira' as const, name: 'Jira', icon: 'jira' }
    ]
    const listProviders = vi.fn(() => Effect.succeed(providers))
    const service = { listProviders } as unknown as TicketImportRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      ticketImport: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'ticket-import-list-providers-1',
        method: 'ticketImport.listProviders',
        params: {}
      })
    )

    expect(listProviders).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'ticket-import-list-providers-1',
      ok: true,
      value: providers
    })
  })

  it('validates ticketImport.listProviders params before calling the provider service', async () => {
    const listProviders = vi.fn(() => Effect.succeed([]))
    const service = { listProviders } as unknown as TicketImportRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      ticketImport: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'ticket-import-list-providers-invalid',
        method: 'ticketImport.listProviders',
        params: { providerId: 'github' }
      })
    )

    expect(listProviders).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'ticket-import-list-providers-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes ticketImport.getSettingsSchema to the injected provider service', async () => {
    const fields = [
      {
        key: 'github_pat',
        label: 'Personal Access Token',
        type: 'password' as const,
        required: false,
        placeholder: 'ghp_...'
      }
    ]
    const getSettingsSchema = vi.fn(() => Effect.succeed(fields))
    const service = { getSettingsSchema } as unknown as TicketImportRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      ticketImport: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'ticket-import-get-settings-schema-1',
        method: 'ticketImport.getSettingsSchema',
        params: { providerId: 'github' }
      })
    )

    expect(getSettingsSchema).toHaveBeenCalledWith('github')
    expect(response).toEqual({
      id: 'ticket-import-get-settings-schema-1',
      ok: true,
      value: fields
    })
  })

  it('validates ticketImport.getSettingsSchema params before calling the provider service', async () => {
    const getSettingsSchema = vi.fn(() => Effect.succeed([]))
    const service = { getSettingsSchema } as unknown as TicketImportRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      ticketImport: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'ticket-import-get-settings-schema-invalid',
        method: 'ticketImport.getSettingsSchema',
        params: { providerId: 'linear' }
      })
    )

    expect(getSettingsSchema).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'ticket-import-get-settings-schema-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes ticketImport.authenticate to the injected provider service', async () => {
    const settings = { github_pat: 'ghp_test' }
    const result = { success: true, error: null }
    const authenticate = vi.fn(() => Effect.succeed(result))
    const service = { authenticate } as unknown as TicketImportRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      ticketImport: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'ticket-import-authenticate-1',
        method: 'ticketImport.authenticate',
        params: { providerId: 'github', settings }
      })
    )

    expect(authenticate).toHaveBeenCalledWith('github', settings)
    expect(response).toEqual({
      id: 'ticket-import-authenticate-1',
      ok: true,
      value: result
    })
  })

  it('validates ticketImport.authenticate params before calling the provider service', async () => {
    const authenticate = vi.fn(() => Effect.succeed({ success: false, error: 'bad token' }))
    const service = { authenticate } as unknown as TicketImportRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      ticketImport: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'ticket-import-authenticate-invalid',
        method: 'ticketImport.authenticate',
        params: { providerId: 'github', settings: { github_pat: 123 } }
      })
    )

    expect(authenticate).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'ticket-import-authenticate-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes ticketImport.detectRepo to the injected provider service', async () => {
    const result = { repo: 'owner/repo' }
    const detectRepo = vi.fn(() => Effect.succeed(result))
    const service = { detectRepo } as unknown as TicketImportRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      ticketImport: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'ticket-import-detect-repo-1',
        method: 'ticketImport.detectRepo',
        params: { providerId: 'github', projectPath: '/tmp/hive' }
      })
    )

    expect(detectRepo).toHaveBeenCalledWith('github', '/tmp/hive')
    expect(response).toEqual({
      id: 'ticket-import-detect-repo-1',
      ok: true,
      value: result
    })
  })

  it('validates ticketImport.detectRepo params before calling the provider service', async () => {
    const detectRepo = vi.fn(() => Effect.succeed({ repo: null }))
    const service = { detectRepo } as unknown as TicketImportRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      ticketImport: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'ticket-import-detect-repo-invalid',
        method: 'ticketImport.detectRepo',
        params: { providerId: 'github', projectPath: '' }
      })
    )

    expect(detectRepo).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'ticket-import-detect-repo-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes ticketImport.listIssues to the injected provider service', async () => {
    const options = {
      page: 2,
      perPage: 25,
      state: 'open' as const,
      search: 'bug',
      nextPageToken: 'cursor-1'
    }
    const settings = { github_pat: 'ghp_test' }
    const result = {
      issues: [
        {
          externalId: '42',
          title: 'Fix RPC migration',
          body: 'Body text',
          state: 'open' as const,
          url: 'https://github.com/acme/hive/issues/42',
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-02T00:00:00.000Z'
        }
      ],
      hasNextPage: true,
      totalCount: 7,
      nextPageToken: 'cursor-2'
    }
    const listIssues = vi.fn(() => Effect.succeed(result))
    const service = { listIssues } as unknown as TicketImportRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      ticketImport: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'ticket-import-list-issues-1',
        method: 'ticketImport.listIssues',
        params: {
          providerId: 'github',
          repo: 'acme/hive',
          options,
          settings
        }
      })
    )

    expect(listIssues).toHaveBeenCalledWith('github', 'acme/hive', options, settings)
    expect(response).toEqual({
      id: 'ticket-import-list-issues-1',
      ok: true,
      value: result
    })
  })

  it('validates ticketImport.listIssues params before calling the provider service', async () => {
    const listIssues = vi.fn(() =>
      Effect.succeed({ issues: [], hasNextPage: false, totalCount: 0 })
    )
    const service = { listIssues } as unknown as TicketImportRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      ticketImport: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'ticket-import-list-issues-invalid',
        method: 'ticketImport.listIssues',
        params: {
          providerId: 'github',
          repo: 'acme/hive',
          options: { page: 1, perPage: 25, state: 'triaged' },
          settings: { github_pat: 'ghp_test' }
        }
      })
    )

    expect(listIssues).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'ticket-import-list-issues-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes ticketImport.importIssues to the injected provider service', async () => {
    const issues = [
      {
        externalId: '42',
        title: 'Fix RPC migration',
        body: 'Body text',
        state: 'open',
        url: 'https://github.com/acme/hive/issues/42'
      },
      {
        externalId: '43',
        title: 'Already imported',
        body: null,
        state: 'closed',
        url: 'https://github.com/acme/hive/issues/43'
      }
    ]
    const result = { imported: ['42'], skipped: ['43'] }
    const importIssues = vi.fn(() => Effect.succeed(result))
    const service = { importIssues } as unknown as TicketImportRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      ticketImport: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'ticket-import-import-issues-1',
        method: 'ticketImport.importIssues',
        params: {
          providerId: 'github',
          projectId: 'project-1',
          repo: 'acme/hive',
          issues
        }
      })
    )

    expect(importIssues).toHaveBeenCalledWith('github', 'project-1', 'acme/hive', issues)
    expect(response).toEqual({
      id: 'ticket-import-import-issues-1',
      ok: true,
      value: result
    })
  })

  it('validates ticketImport.importIssues params before calling the provider service', async () => {
    const importIssues = vi.fn(() => Effect.succeed({ imported: [], skipped: [] }))
    const service = { importIssues } as unknown as TicketImportRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      ticketImport: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'ticket-import-import-issues-invalid',
        method: 'ticketImport.importIssues',
        params: {
          providerId: 'github',
          projectId: 'project-1',
          repo: 'acme/hive',
          issues: [
            {
              externalId: '42',
              title: 'Fix RPC migration',
              body: undefined,
              state: 'open',
              url: 'https://github.com/acme/hive/issues/42'
            }
          ]
        }
      })
    )

    expect(importIssues).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'ticket-import-import-issues-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes ticketImport.getAvailableStatuses to the injected provider service', async () => {
    const settings = { github_pat: 'ghp_test' }
    const statuses = [
      { id: 'todo', label: 'Todo' },
      { id: 'done', label: 'Done' }
    ]
    const getAvailableStatuses = vi.fn(() => Effect.succeed(statuses))
    const service = { getAvailableStatuses } as unknown as TicketImportRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      ticketImport: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'ticket-import-get-available-statuses-1',
        method: 'ticketImport.getAvailableStatuses',
        params: {
          providerId: 'github',
          repo: 'acme/hive',
          externalId: '42',
          settings
        }
      })
    )

    expect(getAvailableStatuses).toHaveBeenCalledWith('github', 'acme/hive', '42', settings)
    expect(response).toEqual({
      id: 'ticket-import-get-available-statuses-1',
      ok: true,
      value: statuses
    })
  })

  it('validates ticketImport.getAvailableStatuses params before calling the provider service', async () => {
    const getAvailableStatuses = vi.fn(() => Effect.succeed([]))
    const service = { getAvailableStatuses } as unknown as TicketImportRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      ticketImport: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'ticket-import-get-available-statuses-invalid',
        method: 'ticketImport.getAvailableStatuses',
        params: {
          providerId: 'github',
          repo: 'acme/hive',
          externalId: '',
          settings: { github_pat: 'ghp_test' }
        }
      })
    )

    expect(getAvailableStatuses).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'ticket-import-get-available-statuses-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes ticketImport.updateRemoteStatus to the injected provider service', async () => {
    const settings = { github_pat: 'ghp_test' }
    const result = { success: false, error: 'Transition denied' }
    const updateRemoteStatus = vi.fn(() => Effect.succeed(result))
    const service = { updateRemoteStatus } as unknown as TicketImportRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      ticketImport: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'ticket-import-update-remote-status-1',
        method: 'ticketImport.updateRemoteStatus',
        params: {
          providerId: 'github',
          repo: 'acme/hive',
          externalId: '42',
          statusId: 'done',
          settings
        }
      })
    )

    expect(updateRemoteStatus).toHaveBeenCalledWith('github', 'acme/hive', '42', 'done', settings)
    expect(response).toEqual({
      id: 'ticket-import-update-remote-status-1',
      ok: true,
      value: result
    })
  })

  it('validates ticketImport.updateRemoteStatus params before calling the provider service', async () => {
    const updateRemoteStatus = vi.fn(() => Effect.succeed({ success: true }))
    const service = { updateRemoteStatus } as unknown as TicketImportRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      ticketImport: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'ticket-import-update-remote-status-invalid',
        method: 'ticketImport.updateRemoteStatus',
        params: {
          providerId: 'github',
          repo: 'acme/hive',
          externalId: '42',
          statusId: '',
          settings: { github_pat: 'ghp_test' }
        }
      })
    )

    expect(updateRemoteStatus).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'ticket-import-update-remote-status-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })
})
