import type { SavedAccountDTO, UsageProvider } from '@shared/types/usage'
import { getRendererRpcClient } from './rpc-client'

export const accountApi = {
  getClaudeEmail: async (): Promise<string | null> =>
    getRendererRpcClient().request<string | null>('accountOps.getClaudeEmail', {}),
  getOpenAIEmail: async (): Promise<string | null> =>
    getRendererRpcClient().request<string | null>('accountOps.getOpenAIEmail', {}),
  listSaved: async (provider?: UsageProvider): Promise<SavedAccountDTO[]> =>
    getRendererRpcClient().request<SavedAccountDTO[]>('accountOps.listSaved', { provider }),
  removeSaved: async (accountId: string): Promise<boolean> =>
    getRendererRpcClient().request<boolean>('accountOps.removeSaved', { accountId })
}
