import { getRendererRpcClient } from './rpc-client'

export const loggingApi = {
  createResponseLog: async (sessionId: string): Promise<string> =>
    getRendererRpcClient().request<string>('loggingOps.createResponseLog', { sessionId }),

  appendResponseLog: async (filePath: string, data: unknown): Promise<void> =>
    getRendererRpcClient().request<void>('loggingOps.appendResponseLog', { filePath, data })
}
