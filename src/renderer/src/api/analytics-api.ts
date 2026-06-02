import { getRendererRpcClient } from './rpc-client'

export const analyticsApi = {
  track: async (event: string, properties?: Record<string, unknown>): Promise<void> =>
    getRendererRpcClient().request<void>('analyticsOps.track', { event, properties }),

  setEnabled: async (enabled: boolean): Promise<void> =>
    getRendererRpcClient().request<void>('analyticsOps.setEnabled', { enabled }),

  isEnabled: async (): Promise<boolean> =>
    getRendererRpcClient().request<boolean>('analyticsOps.isEnabled', {})
}
