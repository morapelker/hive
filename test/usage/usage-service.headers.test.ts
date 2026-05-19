import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp'
  }
}))

import { fetchClaudeUsage } from '../../src/main/services/usage-service'

describe('fetchClaudeUsage Claude client identification', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('identifies OAuth usage requests as the Claude Code client', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          five_hour: { utilization: 12, resets_at: '2026-05-19T12:00:00.000Z' },
          seven_day: { utilization: 34, resets_at: '2026-05-20T12:00:00.000Z' }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    await fetchClaudeUsage('oauth-token', { caller: 'usage:fetch' })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer oauth-token',
          'User-Agent': 'claude-code/2.1.5',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20'
        })
      })
    )
  })
})
