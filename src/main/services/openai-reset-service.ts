import { z } from 'zod'
import { getDatabase } from '../db'
import { accountLockKey, withAccountLock } from './account-lock'
import { listCodexAccounts, readCodexEffectiveAuth, updateCodexTokens } from './account-store-codex'
import { refreshAccessTokenInMemory } from './openai-usage-service'
import { jwtExpMs } from './jwt-utils'

const RESET_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'
const creditsSchema = z.object({
  available_count: z.number().int().nonnegative(),
  credits: z.array(
    z.object({
      id: z.string(),
      reset_type: z.string(),
      status: z.string(),
      granted_at: z.string(),
      expires_at: z.string().nullish(),
      title: z.string().nullish(),
      description: z.string().nullish()
    })
  )
})
const resultSchema = z.object({
  code: z.enum(['reset', 'already_redeemed', 'nothing_to_reset', 'no_credit']),
  windows_reset: z.number().int().default(0)
})

// Resolve the selected saved account, never the account that happens to be active.
// Share the usage/maintenance lock so rotating OAuth tokens cannot race.
async function requestResetApi(
  accountId: string,
  body?: { redeem_request_id: string; credit_id?: string }
): Promise<unknown> {
  const row = getDatabase().getSavedUsageAccountById(accountId)
  if (!row || row.provider !== 'openai') throw new Error('Codex account not found')
  return withAccountLock(accountLockKey('openai', row.email), async () => {
    const account = (await listCodexAccounts()).find(
      (a) => a.email.toLowerCase() === row.email.toLowerCase()
    )
    if (!account) throw new Error('Codex account is no longer available. Sign in again.')
    const auth = await readCodexEffectiveAuth(account.accountKey)
    if (!auth?.tokens?.access_token || !auth.tokens.account_id)
      throw new Error('Missing Codex credentials. Sign in again.')
    const refresh = async (): Promise<void> => {
      const rotated = await refreshAccessTokenInMemory(auth)
      await updateCodexTokens(account.accountKey, rotated)
    }
    const expiresAt = jwtExpMs(auth.tokens.access_token)
    if (expiresAt !== null && expiresAt <= Date.now() + 60_000) await refresh()
    const send = async (): Promise<Response> =>
      fetch(body ? `${RESET_URL}/consume` : RESET_URL, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${auth.tokens!.access_token}`,
          'ChatGPT-Account-Id': auth.tokens!.account_id,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000)
      })
    let response = await send()
    if (response.status === 401) {
      await refresh()
      response = await send()
    }
    if (!response.ok)
      throw new Error(
        `Codex reset request failed (${response.status}). ${response.status === 401 || response.status === 403 ? 'Sign in again.' : 'Please try again.'}`
      )
    return response.json()
  })
}

export async function listOpenAIResetCreditsOp(accountId: string) {
  return creditsSchema.parse(await requestResetApi(accountId))
}

export async function consumeOpenAIResetCreditOp(
  accountId: string,
  redeemRequestId: string,
  creditId?: string
) {
  // Retry only authentication failures, always with the same redemption ID.
  // The returned code is authoritative; usage windows can lag behind redemption.
  return resultSchema.parse(
    await requestResetApi(accountId, {
      redeem_request_id: redeemRequestId,
      ...(creditId ? { credit_id: creditId } : {})
    })
  )
}
