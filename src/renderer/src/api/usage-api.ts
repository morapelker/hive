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
import { getRendererRpcClient } from './rpc-client'

export const usageApi = {
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
