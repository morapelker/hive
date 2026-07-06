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
import { fetchOpenAIUsage } from './openai-usage-service'
import { fetchClaudeUsage } from './usage-service'
import { persistRotatedLiveClaudeTokens } from './account-store-claude'
import { persistRotatedLiveCodexTokens } from './account-store-codex'
import { createLogger } from './logger'

const log = createLogger({ component: 'UsageOps' })

/**
 * Persist rotated LIVE Claude tokens (the ones the `claude` CLI itself owns).
 * The race guard needs the refresh token the rotation was *actually
 * performed with* (`result.rotated.rotatedFrom`) — not a token pre-read
 * before `fetchClaudeUsage` ran, since `fetchClaudeUsage` re-reads live
 * credentials internally and may refresh with a newer token than whatever
 * was read before it started (e.g. the CLI rotated concurrently). Comparing
 * against a stale pre-read would make the guard mismatch and skip
 * persisting a perfectly valid rotation, leaving a burned refresh token
 * live. This is the only path in this phase that persists to the live
 * Keychain/credentials-file location — the saved-account (SQLite) path is
 * still handled by saved-usage-orchestrator.ts.
 */
async function persistLiveClaudeRotation(result: UsageResult): Promise<void> {
  if (!result.rotated) return
  const usedRefreshToken = result.rotated.rotatedFrom
  if (!usedRefreshToken) {
    log.warn('Skipping live Claude token persistence: rotation result has no reference refresh token')
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
async function persistLiveCodexRotation(result: OpenAIUsageResult): Promise<void> {
  if (!result.rotated) return
  const usedRefreshToken = result.rotated.rotatedFrom
  if (!usedRefreshToken) {
    log.warn('Skipping live Codex token persistence: rotation result has no reference refresh token')
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
  const result = await fetchClaudeUsage(undefined, { caller: 'usage:fetch' })

  await persistLiveClaudeRotation(result)

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
  const result = await fetchOpenAIUsage()

  await persistLiveCodexRotation(result)

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
