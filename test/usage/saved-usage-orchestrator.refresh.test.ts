// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  db: {
    getSavedUsageAccountById: vi.fn(),
    updateSavedUsageAccountCredentials: vi.fn(),
    updateSavedUsageAccountUsage: vi.fn()
  },
  fetchClaudeUsage: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp'
  }
}))

vi.mock('../../src/main/db', () => ({
  getDatabase: () => mocks.db
}))

vi.mock('../../src/main/services/usage-service', () => ({
  fetchClaudeUsage: mocks.fetchClaudeUsage,
  readAccessToken: vi.fn(),
  readClaudeCredentialsBlob: vi.fn()
}))

vi.mock('../../src/main/services/openai-usage-service', () => ({
  fetchOpenAIUsage: vi.fn(),
  readCodexCredentials: vi.fn()
}))

vi.mock('../../src/main/services/account-service', () => ({
  getClaudeAccountEmail: vi.fn(),
  getOpenAIAccountEmail: vi.fn()
}))

import { fetchForSavedAccount } from '../../src/main/services/saved-usage-orchestrator'
import type { SavedUsageAccount } from '../../src/main/db/types'

function savedClaudeRow(overrides: Partial<SavedUsageAccount> = {}): SavedUsageAccount {
  return {
    id: 'saved-claude-id',
    provider: 'anthropic',
    email: 'saved@example.com',
    credentials_json: JSON.stringify({
      accessToken: 'old-access-token',
      refreshToken: 'old-refresh-token',
      expiresAt: 1_000,
      email: 'saved@example.com'
    }),
    last_usage_json: JSON.stringify({
      five_hour: { utilization: 10, resets_at: '2026-05-19T12:00:00.000Z' },
      seven_day: { utilization: 20, resets_at: '2026-05-20T12:00:00.000Z' }
    }),
    last_fetched_at: null,
    status: 'ok',
    last_error: null,
    created_at: '2026-05-19T00:00:00.000Z',
    updated_at: '2026-05-19T00:00:00.000Z',
    ...overrides
  }
}

function usageData() {
  return {
    five_hour: { utilization: 12, resets_at: '2026-05-19T12:00:00.000Z' },
    seven_day: { utilization: 34, resets_at: '2026-05-20T12:00:00.000Z' }
  }
}

describe('saved Claude usage refresh orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.db.getSavedUsageAccountById.mockReturnValue(savedClaudeRow())
  })

  it('persists rotated Claude credentials after a successful saved-account fetch', async () => {
    mocks.fetchClaudeUsage.mockResolvedValue({
      success: true,
      data: usageData(),
      rotated: {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresAt: 2_000
      }
    })

    const result = await fetchForSavedAccount('saved-claude-id')

    expect(result.success).toBe(true)
    expect(mocks.fetchClaudeUsage).toHaveBeenCalledWith(
      {
        accessToken: 'old-access-token',
        refreshToken: 'old-refresh-token',
        expiresAt: 1_000,
        accountId: 'saved-claude-id'
      },
      {
        caller: 'usage:fetchForAccount',
        accountId: 'saved-claude-id',
        batchId: undefined
      }
    )
    expect(mocks.db.updateSavedUsageAccountCredentials).toHaveBeenCalledWith(
      'saved-claude-id',
      JSON.stringify({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresAt: 2_000,
        email: 'saved@example.com'
      })
    )
    expect(mocks.db.updateSavedUsageAccountUsage).toHaveBeenCalledWith(
      'saved-claude-id',
      expect.objectContaining({ status: 'ok', last_error: null })
    )
  })

  it('marks Claude refresh failures as stale', async () => {
    mocks.fetchClaudeUsage.mockResolvedValue({
      success: false,
      error: 'Token refresh failed (400): invalid refresh'
    })

    const result = await fetchForSavedAccount('saved-claude-id')

    expect(result.success).toBe(false)
    expect(result.status).toBe('stale')
    expect(mocks.db.updateSavedUsageAccountUsage).toHaveBeenCalledWith(
      'saved-claude-id',
      expect.objectContaining({
        status: 'stale',
        last_error: 'Token refresh failed (400): invalid refresh'
      })
    )
  })

  it('keeps bare Claude 403 usage responses as errors', async () => {
    mocks.fetchClaudeUsage.mockResolvedValue({
      success: false,
      error: 'Usage API returned 403: Forbidden'
    })

    const result = await fetchForSavedAccount('saved-claude-id')

    expect(result.success).toBe(false)
    expect(result.status).toBe('error')
    expect(mocks.db.updateSavedUsageAccountUsage).toHaveBeenCalledWith(
      'saved-claude-id',
      expect.objectContaining({
        status: 'error',
        last_error: 'Usage API returned 403: Forbidden'
      })
    )
  })
})
