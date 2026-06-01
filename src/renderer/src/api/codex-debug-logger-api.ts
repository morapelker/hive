import { getRendererRpcClient } from './rpc-client'

export const codexDebugLoggerApi = {
  configure: async (enabled: boolean, resetPerSession: boolean): Promise<void> =>
    getRendererRpcClient().request<void>('codexDebugLoggerOps.configure', {
      enabled,
      resetPerSession
    })
}
