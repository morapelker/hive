import type {
  FetchForAccountResult,
  OpenAIUsageResult,
  RefreshAllResultItem,
  UsageResult,
  UsageProvider
} from '@shared/types/usage'
import { getRendererRpcClient } from './rpc-client'

export const usageApi = {
  fetch: async (): Promise<UsageResult> =>
    getRendererRpcClient().request<UsageResult>('usageOps.fetch', {}),
  fetchOpenai: async (): Promise<OpenAIUsageResult> =>
    getRendererRpcClient().request<OpenAIUsageResult>('usageOps.fetchOpenai', {}),
  refreshAllForProvider: async (provider: UsageProvider): Promise<RefreshAllResultItem[]> =>
    getRendererRpcClient().request<RefreshAllResultItem[]>('usageOps.refreshAllForProvider', {
      provider
    }),
  fetchForAccount: async (accountId: string): Promise<FetchForAccountResult> =>
    getRendererRpcClient().request<FetchForAccountResult>('usageOps.fetchForAccount', {
      accountId
    })
}
