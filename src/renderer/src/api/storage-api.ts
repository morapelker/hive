import { getRendererRpcClient } from './rpc-client'

export interface StorageStats {
  dbFileBytes: number
  walFileBytes: number
  shmFileBytes: number
  totalFileBytes: number
  freeBytes: number
  pageSize: number
  pageCount: number
}

export interface CompactionPreview {
  storage: StorageStats
  reclaimableFreeBytes: number
  reclaimableWalBytes: number
  orphaned: {
    rows: {
      messages: number
      activities: number
    }
    bytes: number
  }
  estimatedSavedBytes: number
}

export interface CompactionResult {
  beforeBytes: number
  afterBytes: number
  savedBytes: number
  deletedCounts: {
    orphanedMessages: number
    orphanedActivities: number
  }
}

export const storageApi = {
  getStats: async (): Promise<StorageStats> =>
    getRendererRpcClient().request<StorageStats>('storageOps.getStats', {}),
  previewCompaction: async (): Promise<CompactionPreview> =>
    getRendererRpcClient().request<CompactionPreview>('storageOps.previewCompaction', {}),
  compact: async (): Promise<CompactionResult> =>
    getRendererRpcClient().request<CompactionResult>('storageOps.compact', {})
}
