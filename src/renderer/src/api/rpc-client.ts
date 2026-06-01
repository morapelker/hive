import type { HiveClient } from './hive-client'

export type RendererRpcClient = Pick<HiveClient, 'request' | 'subscribe'>

let rendererRpcClient: RendererRpcClient | null = null

export const setRendererRpcClient = (client: RendererRpcClient): void => {
  rendererRpcClient = client
}

export const getRendererRpcClient = (): RendererRpcClient => {
  if (!rendererRpcClient) {
    throw new Error('Renderer RPC client has not been initialized')
  }
  return rendererRpcClient
}

export const resetRendererRpcClientForTests = (): void => {
  rendererRpcClient = null
}
