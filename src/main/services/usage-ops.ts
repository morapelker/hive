import type {
  FetchForAccountResult,
  OpenAIUsageResult,
  RefreshAllResultItem,
  UsageProvider,
  UsageResult
} from '@shared/types/usage'
import {
  captureLiveAccountFromFetch,
  fetchForSavedAccount,
  refreshAllForProvider
} from './saved-usage-orchestrator'
import { fetchOpenAIUsage, readCodexCredentials } from './openai-usage-service'
import { fetchClaudeUsage, readClaudeCredentialsBlob } from './usage-service'
import { persistRotatedLiveClaudeTokens } from './account-store-claude'
import { persistRotatedLiveCodexTokens } from './account-store-codex'
import { createLogger } from './logger'

const log = createLogger({ component: 'UsageOps' })

/**
 * Persist rotated LIVE Claude tokens (the ones the `claude` CLI itself owns).
 * `usedRefreshToken` is captured *before* `fetchClaudeUsage` runs so the
 * store's race guard can tell whether the CLI rotated the same token
 * concurrently. This is the only path in this phase that persists to the
 * live Keychain/credentials-file location — the saved-account (SQLite) path
 * is still handled by saved-usage-orchestrator.ts.
 */
async function persistLiveClaudeRotation(result: UsageResult, usedRefreshToken: string | undefined): Promise<void> {
  if (!result.rotated) return
  if (!usedRefreshToken) {
    log.warn('Skipping live Claude token persistence: no prior refresh token to race-check against')
    return
  }

  try {
    const outcome = await persistRotatedLiveClaudeTokens(result.rotated, usedRefreshToken, result.rotated.scope)
    if (outcome === 'skipped-race') {
      log.warn('Rotated live Claude tokens were not persisted (race with another process)', { outcome })
    } else {
      log.info('Persisted rotated live Claude tokens', { outcome })
    }
  } catch (error) {
    log.warn('Failed to persist rotated live Claude tokens', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

/** OpenAI/Codex equivalent of `persistLiveClaudeRotation` — see its doc comment. */
async function persistLiveCodexRotation(
  result: OpenAIUsageResult,
  usedRefreshToken: string | undefined
): Promise<void> {
  if (!result.rotated) return
  if (!usedRefreshToken) {
    log.warn('Skipping live Codex token persistence: no prior refresh token to race-check against')
    return
  }

  try {
    const outcome = await persistRotatedLiveCodexTokens(result.rotated, usedRefreshToken)
    if (outcome === 'skipped-race') {
      log.warn('Rotated live Codex tokens were not persisted (race with another process)', { outcome })
    } else {
      log.info('Persisted rotated live Codex tokens', { outcome })
    }
  } catch (error) {
    log.warn('Failed to persist rotated live Codex tokens', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

export async function fetchUsageOp(): Promise<UsageResult> {
  const usedRefreshToken = (await readClaudeCredentialsBlob())?.refreshToken
  const result = await fetchClaudeUsage(undefined, { caller: 'usage:fetch' })

  await persistLiveClaudeRotation(result, usedRefreshToken)

  if (result.success && result.data) {
    try {
      await captureLiveAccountFromFetch('anthropic', result.data)
    } catch (error) {
      log.warn('Failed to capture Claude saved usage account', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return result
}

export async function fetchOpenAIUsageOp(): Promise<OpenAIUsageResult> {
  const usedRefreshToken = (await readCodexCredentials())?.tokens?.refresh_token
  const result = await fetchOpenAIUsage()

  await persistLiveCodexRotation(result, usedRefreshToken)

  if (result.success && result.data) {
    try {
      await captureLiveAccountFromFetch('openai', result.data)
    } catch (error) {
      log.warn('Failed to capture OpenAI saved usage account', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return result
}

export async function fetchForAccountOp(accountId: string): Promise<FetchForAccountResult> {
  return fetchForSavedAccount(accountId, { caller: 'usage:fetchForAccount' })
}

export async function refreshAllForProviderOp(
  provider: UsageProvider
): Promise<RefreshAllResultItem[]> {
  return refreshAllForProvider(provider)
}
