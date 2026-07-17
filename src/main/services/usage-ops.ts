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
import { persistRotatedLiveClaudeTokens, readClaudeLiveEmail } from './account-store-claude'
import { listCodexAccounts, persistRotatedLiveCodexTokens } from './account-store-codex'
import { accountLockKey, withAccountLock } from './account-lock'
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

/**
 * The live Claude email (when logged in), used to serialize this live fetch
 * under the SAME per-account lock the saved-account path uses. Without it a
 * left-click live fetch racing a mass refresh/watcher tick for the same
 * account could double-consume the single-use rotating refresh token — the
 * loser getting invalid_grant and marking a healthy account stale.
 */
async function readClaudeLiveLockEmail(): Promise<string | null> {
  try {
    return await readClaudeLiveEmail()
  } catch {
    return null
  }
}

/** Codex equivalent — the managed list's `active` entry's (lowercased) email. */
async function readCodexLiveLockEmail(): Promise<string | null> {
  try {
    const accounts = await listCodexAccounts()
    return accounts.find((account) => account.active)?.email ?? null
  } catch {
    return null
  }
}

export async function fetchUsageOp(): Promise<UsageResult> {
  const liveEmail = await readClaudeLiveLockEmail()

  const fetchAndPersist = async (): Promise<UsageResult> => {
    const result = await fetchClaudeUsage(undefined, { caller: 'usage:fetch' })
    await persistLiveClaudeRotation(result)
    return result
  }

  // Lock only when we know which account is live; logged-out fetches (no live
  // email) can't race a saved-account rotation for a specific account.
  const result = liveEmail
    ? await withAccountLock(accountLockKey('anthropic', liveEmail), fetchAndPersist)
    : await fetchAndPersist()

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
  const liveEmail = await readCodexLiveLockEmail()

  const fetchAndPersist = async (): Promise<OpenAIUsageResult> => {
    const result = await fetchOpenAIUsage()
    await persistLiveCodexRotation(result)
    return result
  }

  const result = liveEmail
    ? await withAccountLock(accountLockKey('openai', liveEmail), fetchAndPersist)
    : await fetchAndPersist()

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

export async function fetchForAccountOp(
  accountId: string,
  userInitiated?: boolean
): Promise<FetchForAccountResult> {
  return fetchForSavedAccount(accountId, { caller: 'usage:fetchForAccount', userInitiated })
}

export async function refreshAllForProviderOp(
  provider: UsageProvider
): Promise<RefreshAllResultItem[]> {
  return refreshAllForProvider(provider)
}
