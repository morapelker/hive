import { contextBridge, ipcRenderer } from 'electron'

// Generic API for renderer
const api = {
  invoke: <T = unknown>(channel: string, ...args: unknown[]): Promise<T> => {
    return ipcRenderer.invoke(channel, ...args)
  },
  on: (channel: string, callback: (...args: unknown[]) => void): (() => void) => {
    const subscription = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void => {
      callback(...args)
    }
    ipcRenderer.on(channel, subscription)
    return () => {
      ipcRenderer.removeListener(channel, subscription)
    }
  }
}

// Typed database API for renderer
const db = {
  // Settings
  setting: {
    get: (key: string) => ipcRenderer.invoke('db:setting:get', key),
    set: (key: string, value: string) => ipcRenderer.invoke('db:setting:set', key, value),
    delete: (key: string) => ipcRenderer.invoke('db:setting:delete', key),
    getAll: () => ipcRenderer.invoke('db:setting:getAll')
  },

  // Projects
  project: {
    create: (data: { name: string; path: string; description?: string | null; tags?: string[] | null }) =>
      ipcRenderer.invoke('db:project:create', data),
    get: (id: string) => ipcRenderer.invoke('db:project:get', id),
    getByPath: (path: string) => ipcRenderer.invoke('db:project:getByPath', path),
    getAll: () => ipcRenderer.invoke('db:project:getAll'),
    update: (id: string, data: { name?: string; description?: string | null; tags?: string[] | null; last_accessed_at?: string }) =>
      ipcRenderer.invoke('db:project:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('db:project:delete', id),
    touch: (id: string) => ipcRenderer.invoke('db:project:touch', id)
  },

  // Worktrees
  worktree: {
    create: (data: { project_id: string; name: string; branch_name: string; path: string }) =>
      ipcRenderer.invoke('db:worktree:create', data),
    get: (id: string) => ipcRenderer.invoke('db:worktree:get', id),
    getByProject: (projectId: string) => ipcRenderer.invoke('db:worktree:getByProject', projectId),
    getActiveByProject: (projectId: string) => ipcRenderer.invoke('db:worktree:getActiveByProject', projectId),
    update: (id: string, data: { name?: string; status?: 'active' | 'archived'; last_accessed_at?: string }) =>
      ipcRenderer.invoke('db:worktree:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('db:worktree:delete', id),
    archive: (id: string) => ipcRenderer.invoke('db:worktree:archive', id),
    touch: (id: string) => ipcRenderer.invoke('db:worktree:touch', id)
  },

  // Sessions
  session: {
    create: (data: { worktree_id: string | null; project_id: string; name?: string | null; opencode_session_id?: string | null }) =>
      ipcRenderer.invoke('db:session:create', data),
    get: (id: string) => ipcRenderer.invoke('db:session:get', id),
    getByWorktree: (worktreeId: string) => ipcRenderer.invoke('db:session:getByWorktree', worktreeId),
    getByProject: (projectId: string) => ipcRenderer.invoke('db:session:getByProject', projectId),
    getActiveByWorktree: (worktreeId: string) => ipcRenderer.invoke('db:session:getActiveByWorktree', worktreeId),
    update: (id: string, data: { name?: string | null; status?: 'active' | 'completed' | 'error'; opencode_session_id?: string | null; updated_at?: string; completed_at?: string | null }) =>
      ipcRenderer.invoke('db:session:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('db:session:delete', id),
    search: (options: { keyword?: string; project_id?: string; worktree_id?: string; dateFrom?: string; dateTo?: string; includeArchived?: boolean }) =>
      ipcRenderer.invoke('db:session:search', options)
  },

  // Session Messages
  message: {
    create: (data: { session_id: string; role: 'user' | 'assistant' | 'system'; content: string }) =>
      ipcRenderer.invoke('db:message:create', data),
    getBySession: (sessionId: string) => ipcRenderer.invoke('db:message:getBySession', sessionId),
    delete: (id: string) => ipcRenderer.invoke('db:message:delete', id)
  },

  // Utility
  schemaVersion: () => ipcRenderer.invoke('db:schemaVersion'),
  tableExists: (tableName: string) => ipcRenderer.invoke('db:tableExists', tableName),
  getIndexes: () => ipcRenderer.invoke('db:getIndexes')
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('db', db)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-expect-error (define in dts)
  window.api = api
  // @ts-expect-error (define in dts)
  window.db = db
}
