import { getRendererRpcClient } from './rpc-client'

export const kanbanApi = {
  board: {
    openImportFile: async <TResult>(): Promise<TResult | null> =>
      getRendererRpcClient().request<TResult | null>('kanban.board.openImportFile', {}),
    export: async <TResult>(projectId: string, projectName: string): Promise<TResult> =>
      getRendererRpcClient().request<TResult>('kanban.board.export', { projectId, projectName }),
    importTickets: async <TResult, TTicket extends object, TDependency extends object>(
      projectId: string,
      tickets: TTicket[],
      dependencies?: TDependency[]
    ): Promise<TResult> =>
      getRendererRpcClient().request<TResult>('kanban.board.importTickets', {
        projectId,
        tickets,
        ...(dependencies === undefined ? {} : { dependencies })
      })
  },
  ticket: {
    create: async <TResult, TData extends object>(data: TData): Promise<TResult> =>
      getRendererRpcClient().request<TResult>('kanban.ticket.create', data),
    createBatch: async <TResult, TData extends object>(data: TData): Promise<TResult> =>
      getRendererRpcClient().request<TResult>('kanban.ticket.createBatch', data),
    update: async <TResult, TData extends object>(id: string, data: TData): Promise<TResult> =>
      getRendererRpcClient().request<TResult>('kanban.ticket.update', { id, data }),
    delete: async (id: string): Promise<boolean> =>
      getRendererRpcClient().request<boolean>('kanban.ticket.delete', { id }),
    archive: async <TResult>(id: string): Promise<TResult> =>
      getRendererRpcClient().request<TResult>('kanban.ticket.archive', { id }),
    archiveAllDone: async (projectId: string): Promise<number> =>
      getRendererRpcClient().request<number>('kanban.ticket.archiveAllDone', { projectId }),
    unarchive: async <TResult>(id: string): Promise<TResult> =>
      getRendererRpcClient().request<TResult>('kanban.ticket.unarchive', { id }),
    detachWorktree: async (worktreeId: string): Promise<number> =>
      getRendererRpcClient().request<number>('kanban.ticket.detachWorktree', { worktreeId }),
    move: async <TResult>(id: string, column: string, sortOrder: number): Promise<TResult> =>
      getRendererRpcClient().request<TResult>('kanban.ticket.move', { id, column, sortOrder }),
    reorder: async (id: string, sortOrder: number): Promise<void> =>
      getRendererRpcClient().request<void>('kanban.ticket.reorder', { id, sortOrder }),
    addTokens: async <TResult>(id: string, tokens: number): Promise<TResult> =>
      getRendererRpcClient().request<TResult>('kanban.ticket.addTokens', { id, tokens }),
    getByProject: async <TResult>(
      projectId: string,
      includeArchived: boolean
    ): Promise<TResult[]> =>
      getRendererRpcClient().request<TResult[]>('kanban.ticket.getByProject', {
        projectId,
        includeArchived
      }),
    getBySession: async <TResult>(sessionId: string): Promise<TResult[]> =>
      getRendererRpcClient().request<TResult[]>('kanban.ticket.getBySession', { sessionId }),
    attachPR: async (
      ticketId: string,
      projectId: string,
      prNumber: number,
      prUrl: string
    ): Promise<void> =>
      getRendererRpcClient().request<void>('kanban.ticket.attachPR', {
        ticketId,
        projectId,
        prNumber,
        prUrl
      }),
    detachPR: async (ticketId: string, projectId: string): Promise<void> =>
      getRendererRpcClient().request<void>('kanban.ticket.detachPR', { ticketId, projectId }),
    syncPR: async (worktreeId: string, prNumber: number, prUrl: string): Promise<void> =>
      getRendererRpcClient().request<void>('kanban.ticket.syncPR', {
        worktreeId,
        prNumber,
        prUrl
      }),
    clearPR: async (worktreeId: string): Promise<void> =>
      getRendererRpcClient().request<void>('kanban.ticket.clearPR', { worktreeId })
  },
  dependency: {
    add: async (
      dependentId: string,
      blockerId: string
    ): Promise<{ success: boolean; error?: string }> =>
      getRendererRpcClient().request<{ success: boolean; error?: string }>(
        'kanban.dependency.add',
        { dependentId, blockerId }
      ),
    getForProject: async <TResult>(projectId: string): Promise<TResult[]> =>
      getRendererRpcClient().request<TResult[]>('kanban.dependency.getForProject', { projectId }),
    remove: async (dependentId: string, blockerId: string): Promise<boolean> =>
      getRendererRpcClient().request<boolean>('kanban.dependency.remove', {
        dependentId,
        blockerId
      }),
    removeAll: async (ticketId: string): Promise<number> =>
      getRendererRpcClient().request<number>('kanban.dependency.removeAll', { id: ticketId })
  },
  simpleMode: {
    toggle: async (projectId: string, enabled: boolean): Promise<void> =>
      getRendererRpcClient().request<void>('kanban.simpleMode.toggle', { projectId, enabled })
  }
}
