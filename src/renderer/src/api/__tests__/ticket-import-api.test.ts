import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'
import { ticketImportApi } from '../ticket-import-api'

describe('ticketImportApi', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('routes listProviders through the renderer RPC client', async () => {
    const providers = [{ id: 'github', name: 'GitHub', icon: 'github' }]
    const request = vi.fn().mockResolvedValue(providers)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(ticketImportApi.listProviders()).resolves.toEqual({
      success: true,
      value: providers
    })
    expect(request).toHaveBeenCalledWith('ticketImport.listProviders', {})
  })

  it('routes getSettingsSchema through the renderer RPC client', async () => {
    const fields = [
      {
        key: 'github_token',
        label: 'GitHub Token',
        type: 'password',
        required: true,
        placeholder: 'ghp_...'
      }
    ]
    const request = vi.fn().mockResolvedValue(fields)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(ticketImportApi.getSettingsSchema('github')).resolves.toEqual({
      success: true,
      value: fields
    })
    expect(request).toHaveBeenCalledWith('ticketImport.getSettingsSchema', {
      providerId: 'github'
    })
  })

  it('routes authenticate through the renderer RPC client', async () => {
    const result = { success: false, error: 'Invalid token' }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    const settings = { github_token: 'ghp_test' }
    await expect(ticketImportApi.authenticate('github', settings)).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('ticketImport.authenticate', {
      providerId: 'github',
      settings
    })
  })

  it('routes detectRepo through the renderer RPC client', async () => {
    const result = { repo: 'acme/hive' }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(ticketImportApi.detectRepo('github', '/tmp/hive')).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('ticketImport.detectRepo', {
      providerId: 'github',
      projectPath: '/tmp/hive'
    })
  })

  it('routes listIssues through the renderer RPC client', async () => {
    const result = {
      issues: [
        {
          externalId: '42',
          title: 'Fix issue',
          body: 'Details',
          state: 'open' as const,
          url: 'https://github.com/acme/hive/issues/42',
          createdAt: '2026-05-26T00:00:00.000Z',
          updatedAt: '2026-05-27T00:00:00.000Z'
        }
      ],
      hasNextPage: true,
      totalCount: 5,
      nextPageToken: 'next'
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    const options = { page: 2, perPage: 25, state: 'open' as const, search: 'fix' }
    const settings = { github_token: 'ghp_test' }
    await expect(
      ticketImportApi.listIssues('github', 'acme/hive', options, settings)
    ).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('ticketImport.listIssues', {
      providerId: 'github',
      repo: 'acme/hive',
      options,
      settings
    })
  })

  it('routes importIssues through the renderer RPC client', async () => {
    const result = { imported: ['42'], skipped: ['43'] }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    const issues = [
      {
        externalId: '42',
        title: 'Fix issue',
        body: null,
        state: 'open',
        url: 'https://github.com/acme/hive/issues/42'
      }
    ]
    await expect(
      ticketImportApi.importIssues('github', 'project-1', 'acme/hive', issues)
    ).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('ticketImport.importIssues', {
      providerId: 'github',
      projectId: 'project-1',
      repo: 'acme/hive',
      issues
    })
  })

  it('routes getAvailableStatuses through the renderer RPC client', async () => {
    const statuses = [
      { id: 'open', label: 'Open' },
      { id: 'closed', label: 'Closed' }
    ]
    const request = vi.fn().mockResolvedValue(statuses)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    const settings = { github_token: 'ghp_test' }
    await expect(
      ticketImportApi.getAvailableStatuses('github', 'acme/hive', '42', settings)
    ).resolves.toEqual({
      success: true,
      value: statuses
    })
    expect(request).toHaveBeenCalledWith('ticketImport.getAvailableStatuses', {
      providerId: 'github',
      repo: 'acme/hive',
      externalId: '42',
      settings
    })
  })

  it('routes updateRemoteStatus through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    const settings = { github_token: 'ghp_test' }
    await expect(
      ticketImportApi.updateRemoteStatus('github', 'acme/hive', '42', 'closed', settings)
    ).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('ticketImport.updateRemoteStatus', {
      providerId: 'github',
      repo: 'acme/hive',
      externalId: '42',
      statusId: 'closed',
      settings
    })
  })
})
