// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import {
  listOpenAIResetCreditsOp,
  consumeOpenAIResetCreditOp
} from '../../src/main/services/openai-reset-service'
const mocks = vi.hoisted(() => ({
  row: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  update: vi.fn(),
  refresh: vi.fn()
}))
vi.mock('../../src/main/db', () => ({
  getDatabase: () => ({ getSavedUsageAccountById: mocks.row })
}))
vi.mock('../../src/main/services/account-store-codex', () => ({
  listCodexAccounts: mocks.list,
  readCodexEffectiveAuth: mocks.read,
  updateCodexTokens: mocks.update
}))
vi.mock('../../src/main/services/openai-usage-service', () => ({
  refreshAccessTokenInMemory: mocks.refresh
}))
const fetchMock = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  mocks.row.mockReturnValue({ provider: 'openai', email: 'selected@example.com' })
  mocks.list.mockResolvedValue([
    { email: 'active@example.com', accountKey: 'active' },
    { email: 'selected@example.com', accountKey: 'selected' }
  ])
  mocks.read.mockResolvedValue({
    tokens: { access_token: 'selected-token', account_id: 'selected-id', refresh_token: 'refresh' }
  })
})
afterEach(() => vi.unstubAllGlobals())
describe('Codex reset API', () => {
  it('lists credits with the selected account credentials and preserves expiry details', async () => {
    const data = {
      available_count: 1,
      credits: [
        {
          id: 'credit',
          reset_type: 'full',
          status: 'available',
          granted_at: '2026-01-01',
          expires_at: '2026-12-01T00:00:00Z'
        }
      ]
    }
    fetchMock.mockResolvedValueOnce(Response.json(data))
    expect(await listOpenAIResetCreditsOp('saved-id')).toEqual(data)
    expect(mocks.read).toHaveBeenCalledWith('selected')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer selected-token',
          'ChatGPT-Account-Id': 'selected-id'
        })
      })
    )
  })
  it.each(['reset', 'already_redeemed', 'nothing_to_reset', 'no_credit'])(
    'returns %s without checking usage windows',
    async (code) => {
      fetchMock.mockResolvedValueOnce(Response.json({ code }))
      expect(await consumeOpenAIResetCreditOp('saved-id', 'same-request', 'credit')).toEqual({
        code,
        windows_reset: 0
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        redeem_request_id: 'same-request',
        credit_id: 'credit'
      })
    }
  )
  it('persists rotated credentials and reuses the redemption ID on a 401 retry', async () => {
    mocks.refresh.mockImplementation(async (auth) => {
      auth.tokens.access_token = 'new-token'
      return { accessToken: 'new-token', refreshToken: 'new-refresh', rotatedFrom: 'refresh' }
    })
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(Response.json({ code: 'already_redeemed' }))
    await consumeOpenAIResetCreditOp('saved-id', 'request-id')
    expect(mocks.update).toHaveBeenCalledWith(
      'selected',
      expect.objectContaining({ accessToken: 'new-token' })
    )
    expect(fetchMock.mock.calls[0][1].body).toBe(fetchMock.mock.calls[1][1].body)
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer new-token')
  })
  it('does not automatically retry uncertain network failures', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connection lost'))
    await expect(consumeOpenAIResetCreditOp('saved-id', 'request-id')).rejects.toThrow(
      'connection lost'
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('rejects non-Codex accounts before making a request', async () => {
    mocks.row.mockReturnValue({ provider: 'anthropic', email: 'other@example.com' })
    await expect(listOpenAIResetCreditsOp('wrong')).rejects.toThrow('Codex account not found')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
