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
import { createLogger } from './logger'

const log = createLogger({ component: 'UsageOps' })

export async function fetchUsageOp(): Promise<UsageResult> {
  const result = await fetchClaudeUsage(undefined, { caller: 'usage:fetch' })
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
