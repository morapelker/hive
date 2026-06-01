import { FILE_TREE_CHANGE_CHANNEL } from '@shared/file-tree-events'
import type { ServerEvent } from '@shared/rpc/protocol'
import type { FileTreeChangeEvent, FileTreeNode, FlatFile } from '@shared/types/file-tree'
import { getRendererRpcClient } from './rpc-client'

type FileTreeScanResult = {
  success: boolean
  tree?: FileTreeNode[]
  error?: string
}

type FileTreeScanFlatResult = {
  success: boolean
  files?: FlatFile[]
  error?: string
}

type FileTreeLoadChildrenResult = {
  success: boolean
  children?: FileTreeNode[]
  error?: string
}

type FileTreeMutationResult = {
  success: boolean
  error?: string
}

const isFileTreeChangeEvent = (value: unknown): value is FileTreeChangeEvent =>
  typeof value === 'object' &&
  value !== null &&
  'worktreePath' in value &&
  typeof value.worktreePath === 'string' &&
  'events' in value &&
  Array.isArray(value.events) &&
  value.events.every(
    (event) =>
      typeof event === 'object' &&
      event !== null &&
      'eventType' in event &&
      typeof event.eventType === 'string' &&
      ['add', 'addDir', 'unlink', 'unlinkDir', 'change'].includes(event.eventType) &&
      'changedPath' in event &&
      typeof event.changedPath === 'string' &&
      'relativePath' in event &&
      typeof event.relativePath === 'string'
  )

export const fileTreeApi = {
  scan: async (dirPath: string): Promise<FileTreeScanResult> =>
    getRendererRpcClient().request<FileTreeScanResult>('fileTreeOps.scan', { dirPath }),
  scanFlat: async (dirPath: string): Promise<FileTreeScanFlatResult> =>
    getRendererRpcClient().request<FileTreeScanFlatResult>('fileTreeOps.scanFlat', { dirPath }),
  loadChildren: async (dirPath: string, rootPath: string): Promise<FileTreeLoadChildrenResult> =>
    getRendererRpcClient().request<FileTreeLoadChildrenResult>('fileTreeOps.loadChildren', {
      dirPath,
      rootPath
    }),
  watch: async (worktreePath: string): Promise<FileTreeMutationResult> =>
    getRendererRpcClient().request<FileTreeMutationResult>('fileTreeOps.watch', { worktreePath }),
  unwatch: async (worktreePath: string): Promise<FileTreeMutationResult> =>
    getRendererRpcClient().request<FileTreeMutationResult>('fileTreeOps.unwatch', { worktreePath }),
  onChange: (callback: (event: FileTreeChangeEvent) => void): (() => void) =>
    getRendererRpcClient().subscribe(FILE_TREE_CHANGE_CHANNEL, (event: ServerEvent) => {
      if (isFileTreeChangeEvent(event.payload)) {
        callback(event.payload)
      }
    })
}
