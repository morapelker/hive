import type {
  ClaudeTokenTally,
  FetchForAccountResult,
  OpenAIUsageResult,
  OpenAIResetCredits,
  OpenAIResetResult,
  RefreshAllResultItem,
  UsageResult,
  UsageProvider
} from '@shared/types/usage'
import {
  CLAUDE_LIVE_USAGE_CHANNEL,
  isClaudeLiveUsagePayload,
  type ClaudeLiveUsagePayload
} from '@shared/types/claude-live-usage'
import type { ServerEvent } from '@shared/rpc/protocol'
import { getRendererRpcClient } from './rpc-client'

export const usageApi = {
  /**
   * Real-time Claude usage from the local API proxy: one event per observed
   * API response, already attributed to the account that made the request.
   */
  onClaudeLiveUsage: (callback: (payload: ClaudeLiveUsagePayload) => void): (() => void) =>
    getRendererRpcClient().subscribe(CLAUDE_LIVE_USAGE_CHANNEL, (event: ServerEvent) => {
      if (isClaudeLiveUsagePayload(event.payload)) callback(event.payload)
    }),
  listOpenaiResets: (accountId: string): Promise<OpenAIResetCredits> =>
    getRendererRpcClient().request('usageOps.listOpenaiResets', { accountId }),
  consumeOpenaiReset: (
    accountId: string,
    redeemRequestId: string,
    creditId?: string
  ): Promise<OpenAIResetResult> =>
    getRendererRpcClient().request('usageOps.consumeOpenaiReset', {
      accountId,
      redeemRequestId,
      ...(creditId ? { creditId } : {})
    }),
  fetch: async (): Promise<UsageResult> =>
    getRendererRpcClient().request<UsageResult>('usageOps.fetch', {}),
  fetchOpenai: async (): Promise<OpenAIUsageResult> =>
    getRendererRpcClient().request<OpenAIUsageResult>('usageOps.fetchOpenai', {}),
  refreshAllForProvider: async (
    provider: UsageProvider,
    excludeAccountIds?: string[],
    maxAgeMs?: number
  ): Promise<RefreshAllResultItem[]> =>
    getRendererRpcClient().request<RefreshAllResultItem[]>('usageOps.refreshAllForProvider', {
      provider,
      ...(excludeAccountIds ? { excludeAccountIds } : {}),
      ...(maxAgeMs !== undefined ? { maxAgeMs } : {})
    }),
  getClaudeTokenTally: async (): Promise<ClaudeTokenTally> =>
    getRendererRpcClient().request<ClaudeTokenTally>('usageOps.getClaudeTokenTally', {}),
  fetchForAccount: async (
    accountId: string,
    userInitiated?: boolean
  ): Promise<FetchForAccountResult> =>
    getRendererRpcClient().request<FetchForAccountResult>('usageOps.fetchForAccount', {
      accountId,
      userInitiated
    })
}
