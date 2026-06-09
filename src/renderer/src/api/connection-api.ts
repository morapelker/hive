import type { ConnectionWithMembers } from '@shared/types/connection'
import { getRendererRpcClient } from './rpc-client'

type ConnectionGetResult = {
  success: boolean
  connection?: ConnectionWithMembers
  error?: string
}

type ConnectionGetAllResult = {
  success: boolean
  connections?: ConnectionWithMembers[]
  error?: string
}

type ConnectionCreateResult = {
  success: boolean
  connection?: ConnectionWithMembers
  error?: string
}

type ConnectionAddMemberResult = {
  success: boolean
  member?: ConnectionWithMembers['members'][0]
  error?: string
}

type ConnectionRemoveMemberResult = {
  success: boolean
  connectionDeleted?: boolean
  error?: string
}

type ConnectionRenameResult = {
  success: boolean
  connection?: ConnectionWithMembers
  error?: string
}

type ConnectionMutationResult = {
  success: boolean
  error?: string
}

export const connectionApi = {
  addMember: async (connectionId: string, worktreeId: string): Promise<ConnectionAddMemberResult> =>
    getRendererRpcClient().request<ConnectionAddMemberResult>('connectionOps.addMember', {
      connectionId,
      worktreeId
    }),
  create: async (worktreeIds: string[]): Promise<ConnectionCreateResult> =>
    getRendererRpcClient().request<ConnectionCreateResult>('connectionOps.create', {
      worktreeIds
    }),
  delete: async (connectionId: string): Promise<{ success: boolean; error?: string }> =>
    getRendererRpcClient().request<{ success: boolean; error?: string }>('connectionOps.delete', {
      connectionId
    }),
  get: async (connectionId: string): Promise<ConnectionGetResult> =>
    getRendererRpcClient().request<ConnectionGetResult>('connectionOps.get', { connectionId }),
  getAll: async (): Promise<ConnectionGetAllResult> =>
    getRendererRpcClient().request<ConnectionGetAllResult>('connectionOps.getAll', {}),
  getPinned: async (): Promise<ConnectionWithMembers[]> =>
    getRendererRpcClient().request<ConnectionWithMembers[]>('connectionOps.getPinned', {}),
  openInEditor: async (connectionPath: string): Promise<ConnectionMutationResult> =>
    getRendererRpcClient().request<ConnectionMutationResult>('connectionOps.openInEditor', {
      connectionPath
    }),
  openInTerminal: async (connectionPath: string): Promise<ConnectionMutationResult> =>
    getRendererRpcClient().request<ConnectionMutationResult>('connectionOps.openInTerminal', {
      connectionPath
    }),
  removeMember: async (
    connectionId: string,
    worktreeId: string
  ): Promise<ConnectionRemoveMemberResult> =>
    getRendererRpcClient().request<ConnectionRemoveMemberResult>('connectionOps.removeMember', {
      connectionId,
      worktreeId
    }),
  removeWorktreeFromAll: async (
    worktreeId: string
  ): Promise<{ success: boolean; error?: string }> =>
    getRendererRpcClient().request<{ success: boolean; error?: string }>(
      'connectionOps.removeWorktreeFromAll',
      { worktreeId }
    ),
  rename: async (
    connectionId: string,
    customName: string | null
  ): Promise<ConnectionRenameResult> =>
    getRendererRpcClient().request<ConnectionRenameResult>('connectionOps.rename', {
      connectionId,
      customName
    }),
  setPinned: async (
    connectionId: string,
    pinned: boolean
  ): Promise<{ success: boolean; error?: string }> =>
    getRendererRpcClient().request<{ success: boolean; error?: string }>(
      'connectionOps.setPinned',
      { connectionId, pinned }
    )
}
