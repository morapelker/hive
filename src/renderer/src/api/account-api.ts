import type { LoginStatusDTO, SavedAccountDTO, UsageProvider } from '@shared/types/usage'
import {
  SHARED_ACCOUNT_IMPORTED_CHANNEL,
  type SharedAccountImportedPayload
} from '@shared/app-events'
import type { ServerEvent } from '@shared/rpc/protocol'
import { getRendererRpcClient } from './rpc-client'

export interface ExportedAccountShare {
  provider: UsageProvider
  email: string
  encryptedPayload: string
  key: string
}

export interface ImportedAccountShare {
  provider: UsageProvider
  email: string
  /** Rotated Hive Enterprise token from the claim; apply it to the settings store. */
  refreshedAuthToken?: string
}

export const accountApi = {
  getClaudeEmail: async (): Promise<string | null> =>
    getRendererRpcClient().request<string | null>('accountOps.getClaudeEmail', {}),
  getOpenAIEmail: async (): Promise<string | null> =>
    getRendererRpcClient().request<string | null>('accountOps.getOpenAIEmail', {}),
  listSaved: async (provider?: UsageProvider): Promise<SavedAccountDTO[]> =>
    getRendererRpcClient().request<SavedAccountDTO[]>('accountOps.listSaved', { provider }),
  removeSaved: async (accountId: string): Promise<boolean> =>
    getRendererRpcClient().request<boolean>('accountOps.removeSaved', { accountId }),
  switchAccount: async (accountId: string): Promise<{ success: boolean; error?: string }> =>
    getRendererRpcClient().request<{ success: boolean; error?: string }>(
      'accountOps.switchAccount',
      { accountId }
    ),
  loginStart: async (provider: UsageProvider, email?: string): Promise<{ loginId: string }> =>
    getRendererRpcClient().request<{ loginId: string }>('accountOps.loginStart', {
      provider,
      email
    }),
  loginStatus: async (loginId: string): Promise<LoginStatusDTO> =>
    getRendererRpcClient().request<LoginStatusDTO>('accountOps.loginStatus', { loginId }),
  loginCancel: async (loginId: string): Promise<boolean> =>
    getRendererRpcClient().request<boolean>('accountOps.loginCancel', { loginId }),
  exportShare: async (accountId: string): Promise<ExportedAccountShare> =>
    getRendererRpcClient().request<ExportedAccountShare>('accountOps.exportShare', { accountId }),
  importShare: async (url: string): Promise<ImportedAccountShare> =>
    getRendererRpcClient().request<ImportedAccountShare>('accountOps.importShare', { url }),
  onSharedAccountImported: (
    callback: (payload: SharedAccountImportedPayload) => void
  ): (() => void) =>
    getRendererRpcClient().subscribe(SHARED_ACCOUNT_IMPORTED_CHANNEL, (event: ServerEvent) => {
      const data = event.payload as Partial<SharedAccountImportedPayload> | null
      if (data && (data.provider === 'anthropic' || data.provider === 'openai')) {
        callback({ provider: data.provider, email: data.email ?? '' })
      }
    })
}
