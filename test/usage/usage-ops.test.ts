// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetchClaudeUsage: vi.fn(),
  readClaudeCredentialsBlob: vi.fn(),
  fetchOpenAIUsage: vi.fn(),
  readCodexCredentials: vi.fn(),
  persistRotatedLiveClaudeTokens: vi.fn(),
  persistRotatedLiveCodexTokens: vi.fn(),
  captureLiveAccountFromFetch: vi.fn(),
  fetchForSavedAccount: vi.fn(),
  refreshAllForProvider: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

vi.mock('../../src/main/services/usage-service', () => ({
  fetchClaudeUsage: mocks.fetchClaudeUsage,
  readClaudeCredentialsBlob: mocks.readClaudeCredentialsBlob
}))

vi.mock('../../src/main/services/openai-usage-service', () => ({
  fetchOpenAIUsage: mocks.fetchOpenAIUsage,
  readCodexCredentials: mocks.readCodexCredentials
}))

vi.mock('../../src/main/services/account-store-claude', () => ({
  persistRotatedLiveClaudeTokens: mocks.persistRotatedLiveClaudeTokens
}))

vi.mock('../../src/main/services/account-store-codex', () => ({
  persistRotatedLiveCodexTokens: mocks.persistRotatedLiveCodexTokens
}))

vi.mock('../../src/main/services/saved-usage-orchestrator', () => ({
  captureLiveAccountFromFetch: mocks.captureLiveAccountFromFetch,
  fetchForSavedAccount: mocks.fetchForSavedAccount,
  refreshAllForProvider: mocks.refreshAllForProvider
}))

import { fetchOpenAIUsageOp, fetchUsageOp } from '../../src/main/services/usage-ops'

describe('fetchUsageOp', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.captureLiveAccountFromFetch.mockResolvedValue(undefined)
  })

  it('persists rotated live Claude tokens using the token the refresh actually consumed (rotatedFrom), not a pre-read token', async () => {
    // A pre-read (if usage-ops still did one) would see 'stale-pre-read' —
    // fetchClaudeUsage re-reads live credentials internally and may refresh
    // with a newer token (e.g. the CLI rotated concurrently). The persisted
    // race-check must use `rotated.rotatedFrom`, the token the internal
    // refresh actually consumed, not the stale pre-read.
    mocks.readClaudeCredentialsBlob.mockResolvedValue({
      accessToken: 'old-access',
      refreshToken: 'stale-pre-read',
      expiresAt: 1000
    })
    mocks.fetchClaudeUsage.mockResolvedValue({
      success: true,
      data: { five_hour: {}, seven_day: {} },
      rotated: {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: 2000,
        scope: 'a b',
        rotatedFrom: 'internal-refresh-token'
      }
    })
    mocks.persistRotatedLiveClaudeTokens.mockResolvedValue('persisted')

    const result = await fetchUsageOp()

    expect(result.success).toBe(true)
    expect(mocks.persistRotatedLiveClaudeTokens).toHaveBeenCalledWith(
      {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: 2000,
        scope: 'a b',
        rotatedFrom: 'internal-refresh-token'
      },
      'internal-refresh-token',
      'a b'
    )
    expect(mocks.captureLiveAccountFromFetch).toHaveBeenCalledWith('anthropic', result.data)
  })

  it('does not pre-read live Claude credentials at all', async () => {
    mocks.fetchClaudeUsage.mockResolvedValue({ success: true, data: { five_hour: {}, seven_day: {} } })

    await fetchUsageOp()

    expect(mocks.readClaudeCredentialsBlob).not.toHaveBeenCalled()
  })

  it('does not call persist when there is nothing rotated', async () => {
    mocks.fetchClaudeUsage.mockResolvedValue({ success: true, data: { five_hour: {}, seven_day: {} } })

    await fetchUsageOp()

    expect(mocks.persistRotatedLiveClaudeTokens).not.toHaveBeenCalled()
  })

  it('does not throw when persistRotatedLiveClaudeTokens rejects, and still captures the account', async () => {
    mocks.fetchClaudeUsage.mockResolvedValue({
      success: true,
      data: { five_hour: {}, seven_day: {} },
      rotated: {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: 2000,
        rotatedFrom: 'internal-refresh-token'
      }
    })
    mocks.persistRotatedLiveClaudeTokens.mockRejectedValue(new Error('keychain exploded'))

    const result = await fetchUsageOp()

    expect(result.success).toBe(true)
    expect(mocks.captureLiveAccountFromFetch).toHaveBeenCalled()
  })

  it('skips persistence gracefully (without throwing) when the rotated result has no rotatedFrom reference token', async () => {
    mocks.fetchClaudeUsage.mockResolvedValue({
      success: true,
      data: { five_hour: {}, seven_day: {} },
      rotated: { accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: 2000 }
    })

    const result = await fetchUsageOp()

    expect(result.success).toBe(true)
    expect(mocks.persistRotatedLiveClaudeTokens).not.toHaveBeenCalled()
  })
})

describe('fetchOpenAIUsageOp', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.captureLiveAccountFromFetch.mockResolvedValue(undefined)
  })

  it('persists rotated live Codex tokens using the token the refresh actually consumed (rotatedFrom), not a pre-read token', async () => {
    // Same rationale as the Claude test above: fetchOpenAIUsage re-reads
    // live credentials internally, so a pre-read (if usage-ops still did
    // one) could be stale relative to what the internal refresh consumed.
    mocks.readCodexCredentials.mockResolvedValue({ tokens: { refresh_token: 'stale-pre-read' } })
    mocks.fetchOpenAIUsage.mockResolvedValue({
      success: true,
      data: { plan_type: 'plus', rate_limit: { primary_window: null, secondary_window: null } },
      rotated: {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        idToken: 'new-id',
        rotatedFrom: 'internal-refresh-token'
      }
    })
    mocks.persistRotatedLiveCodexTokens.mockResolvedValue('persisted')

    const result = await fetchOpenAIUsageOp()

    expect(result.success).toBe(true)
    expect(mocks.persistRotatedLiveCodexTokens).toHaveBeenCalledWith(
      {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        idToken: 'new-id',
        rotatedFrom: 'internal-refresh-token'
      },
      'internal-refresh-token'
    )
    expect(mocks.captureLiveAccountFromFetch).toHaveBeenCalledWith('openai', result.data)
  })

  it('does not pre-read live Codex credentials at all', async () => {
    mocks.fetchOpenAIUsage.mockResolvedValue({
      success: true,
      data: { plan_type: 'plus', rate_limit: { primary_window: null, secondary_window: null } }
    })

    await fetchOpenAIUsageOp()

    expect(mocks.readCodexCredentials).not.toHaveBeenCalled()
  })

  it('logs but does not throw when persistRotatedLiveCodexTokens resolves skipped-race', async () => {
    mocks.fetchOpenAIUsage.mockResolvedValue({
      success: true,
      data: { plan_type: 'plus', rate_limit: { primary_window: null, secondary_window: null } },
      rotated: { accessToken: 'new-access', refreshToken: 'new-refresh', rotatedFrom: 'internal-refresh-token' }
    })
    mocks.persistRotatedLiveCodexTokens.mockResolvedValue('skipped-race')

    const result = await fetchOpenAIUsageOp()

    expect(result.success).toBe(true)
    expect(mocks.persistRotatedLiveCodexTokens).toHaveBeenCalled()
  })

  it('skips persistence gracefully (without throwing) when the rotated result has no rotatedFrom reference token', async () => {
    mocks.fetchOpenAIUsage.mockResolvedValue({
      success: true,
      data: { plan_type: 'plus', rate_limit: { primary_window: null, secondary_window: null } },
      rotated: { accessToken: 'new-access', refreshToken: 'new-refresh' }
    })

    const result = await fetchOpenAIUsageOp()

    expect(result.success).toBe(true)
    expect(mocks.persistRotatedLiveCodexTokens).not.toHaveBeenCalled()
  })
})
