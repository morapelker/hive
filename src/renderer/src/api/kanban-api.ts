import { getRendererRpcClient } from './rpc-client'
import { MARKDOWN_KANBAN_CHANGED_CHANNEL } from '@shared/kanban-events'
import type { ServerEvent } from '@shared/rpc/protocol'

export interface MarkdownKanbanChangedEvent {
  projectId: string
  paths: string[]
  eventTypes: Array<'add' | 'change' | 'unlink'>
}

const isMarkdownKanbanChangedEvent = (value: unknown): value is MarkdownKanbanChangedEvent => {
  if (!value || typeof value !== 'object') return false
  const event = value as Record<string, unknown>
  return (
    typeof event.projectId === 'string' &&
    Array.isArray(event.paths) &&
    event.paths.every((path) => typeof path === 'string') &&
    Array.isArray(event.eventTypes) &&
    event.eventTypes.every((type) => type === 'add' || type === 'change' || type === 'unlink')
  )
}

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
    create: async <TResult, TData extends object>(
      _projectId: string,
      data: TData
    ): Promise<TResult> =>
      getRendererRpcClient().request<TResult>('kanban.ticket.create', data),
    createBatch: async <TResult, TData extends object>(
      projectId: string,
      data: TData
    ): Promise<TResult> =>
      getRendererRpcClient().request<TResult>('kanban.ticket.createBatch', { projectId, data }),
    get: async <TResult>(projectId: string, id: string): Promise<TResult> =>
      getRendererRpcClient().request<TResult>('kanban.ticket.get', { projectId, id }),
    update: async <TResult, TData extends object>(
      projectId: string,
      id: string,
      data: TData
    ): Promise<TResult> =>
      getRendererRpcClient().request<TResult>('kanban.ticket.update', { projectId, id, data }),
    delete: async (projectId: string, id: string): Promise<boolean> =>
      getRendererRpcClient().request<boolean>('kanban.ticket.delete', { projectId, id }),
    archive: async <TResult>(projectId: string, id: string): Promise<TResult> =>
      getRendererRpcClient().request<TResult>('kanban.ticket.archive', { projectId, id }),
    archiveAllDone: async (projectId: string): Promise<number> =>
      getRendererRpcClient().request<number>('kanban.ticket.archiveAllDone', { projectId }),
    unarchive: async <TResult>(projectId: string, id: string): Promise<TResult> =>
      getRendererRpcClient().request<TResult>('kanban.ticket.unarchive', { projectId, id }),
    detachWorktree: async (worktreeId: string): Promise<number> =>
      getRendererRpcClient().request<number>('kanban.ticket.detachWorktree', { worktreeId }),
    move: async <TResult>(
      projectId: string,
      id: string,
      column: string,
      sortOrder: number
    ): Promise<TResult> =>
      getRendererRpcClient().request<TResult>('kanban.ticket.move', {
        projectId,
        id,
        column,
        sortOrder
      }),
    moveToProject: async <TResult>(
      projectId: string,
      id: string,
      targetProjectId: string
    ): Promise<TResult> =>
      getRendererRpcClient().request<TResult>('kanban.ticket.moveToProject', {
        projectId,
        id,
        targetProjectId
      }),
    reorder: async (projectId: string, id: string, sortOrder: number): Promise<void> =>
      getRendererRpcClient().request<void>('kanban.ticket.reorder', { projectId, id, sortOrder }),
    addTokens: async <TResult>(projectId: string, id: string, tokens: number): Promise<TResult> =>
      getRendererRpcClient().request<TResult>('kanban.ticket.addTokens', {
        projectId,
        id,
        tokens
      }),
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
      projectId: string,
      dependentId: string,
      blockerId: string
    ): Promise<{ success: boolean; error?: string }> =>
      getRendererRpcClient().request<{ success: boolean; error?: string }>(
        'kanban.dependency.add',
        { projectId, dependentId, blockerId }
      ),
    getForProject: async <TResult>(projectId: string): Promise<TResult[]> =>
      getRendererRpcClient().request<TResult[]>('kanban.dependency.getForProject', { projectId }),
    getBlockers: async <TResult>(projectId: string, ticketId: string): Promise<TResult[]> =>
      getRendererRpcClient().request<TResult[]>('kanban.dependency.getBlockers', {
        projectId,
        id: ticketId
      }),
    getDependents: async <TResult>(projectId: string, ticketId: string): Promise<TResult[]> =>
      getRendererRpcClient().request<TResult[]>('kanban.dependency.getDependents', {
        projectId,
        id: ticketId
      }),
    remove: async (projectId: string, dependentId: string, blockerId: string): Promise<boolean> =>
      getRendererRpcClient().request<boolean>('kanban.dependency.remove', {
        projectId,
        dependentId,
        blockerId
      }),
    removeAll: async (projectId: string, ticketId: string): Promise<number> =>
      getRendererRpcClient().request<number>('kanban.dependency.removeAll', {
        projectId,
        id: ticketId
      })
  },
  simpleMode: {
    toggle: async (projectId: string, enabled: boolean): Promise<void> =>
      getRendererRpcClient().request<void>('kanban.simpleMode.toggle', { projectId, enabled })
  },
  config: {
    get: async <TResult>(projectId: string): Promise<TResult> =>
      getRendererRpcClient().request<TResult>('kanban.config.get', { projectId }),
    update: async <TResult, TConfig extends object>(
      projectId: string,
      config: TConfig
    ): Promise<TResult> =>
      getRendererRpcClient().request<TResult>('kanban.config.update', { projectId, config }),
    setMode: async (
      projectId: string,
      mode: 'internal' | 'markdown'
    ): Promise<{ success: boolean; error?: string }> =>
      getRendererRpcClient().request<{ success: boolean; error?: string }>(
        'kanban.config.setMode',
        { projectId, mode }
      ),
    createFolders: async <TConfig extends object>(
      projectId: string,
      config?: TConfig
    ): Promise<{ success: boolean; error?: string }> =>
      getRendererRpcClient().request<{ success: boolean; error?: string }>(
        'kanban.config.createFolders',
        {
          projectId,
          ...(config === undefined ? {} : { config })
        }
      ),
    pickMarkdownFolder: async (): Promise<string | null> =>
      getRendererRpcClient().request<string | null>('kanban.config.pickMarkdownFolder', {})
  },
  diagnostics: {
    get: async <TResult>(projectId: string): Promise<TResult[]> =>
      getRendererRpcClient().request<TResult[]>('kanban.diagnostics.get', { projectId })
  },
  watch: {
    start: async (projectId: string): Promise<{ success: boolean; error?: string }> =>
      getRendererRpcClient().request<{ success: boolean; error?: string }>('kanban.watch.start', {
        projectId
      }),
    stop: async (projectId: string): Promise<{ success: boolean; error?: string }> =>
      getRendererRpcClient().request<{ success: boolean; error?: string }>('kanban.watch.stop', {
        projectId
      }),
    onChanged: (callback: (event: MarkdownKanbanChangedEvent) => void): (() => void) =>
      getRendererRpcClient().subscribe(MARKDOWN_KANBAN_CHANGED_CHANNEL, (event: ServerEvent) => {
        if (isMarkdownKanbanChangedEvent(event.payload)) {
          callback(event.payload)
        }
      })
  }
}
