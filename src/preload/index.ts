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

// Project operations API (dialog, shell, clipboard)
const projectOps = {
  // Open native folder picker dialog
  openDirectoryDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:openDirectory'),

  // Check if a path is a git repository
  isGitRepository: (path: string): Promise<boolean> => ipcRenderer.invoke('git:isRepository', path),

  // Validate a project path (checks if directory and git repo)
  validateProject: (
    path: string
  ): Promise<{
    success: boolean
    path?: string
    name?: string
    error?: string
  }> => ipcRenderer.invoke('project:validate', path),

  // Open path in Finder/Explorer
  showInFolder: (path: string): Promise<void> => ipcRenderer.invoke('shell:showItemInFolder', path),

  // Open path with default application
  openPath: (path: string): Promise<string> => ipcRenderer.invoke('shell:openPath', path),

  // Clipboard operations
  copyToClipboard: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:writeText', text),
  readFromClipboard: (): Promise<string> => ipcRenderer.invoke('clipboard:readText')
}

// Worktree operations API
const worktreeOps = {
  // Create a new worktree
  create: (params: {
    projectId: string
    projectPath: string
    projectName: string
  }): Promise<{
    success: boolean
    worktree?: {
      id: string
      project_id: string
      name: string
      branch_name: string
      path: string
      status: string
      created_at: string
      last_accessed_at: string
    }
    error?: string
  }> => ipcRenderer.invoke('worktree:create', params),

  // Delete/Archive a worktree
  delete: (params: {
    worktreeId: string
    worktreePath: string
    branchName: string
    projectPath: string
    archive: boolean
  }): Promise<{
    success: boolean
    error?: string
  }> => ipcRenderer.invoke('worktree:delete', params),

  // Sync worktrees with actual git state
  sync: (params: {
    projectId: string
    projectPath: string
  }): Promise<{
    success: boolean
    error?: string
  }> => ipcRenderer.invoke('worktree:sync', params),

  // Check if worktree path exists on disk
  exists: (worktreePath: string): Promise<boolean> => ipcRenderer.invoke('worktree:exists', worktreePath),

  // Open worktree in terminal
  openInTerminal: (worktreePath: string): Promise<{
    success: boolean
    error?: string
  }> => ipcRenderer.invoke('worktree:openInTerminal', worktreePath),

  // Open worktree in editor (VS Code)
  openInEditor: (worktreePath: string): Promise<{
    success: boolean
    error?: string
  }> => ipcRenderer.invoke('worktree:openInEditor', worktreePath),

  // Get git branches for a project
  getBranches: (projectPath: string): Promise<{
    success: boolean
    branches?: string[]
    currentBranch?: string
    error?: string
  }> => ipcRenderer.invoke('git:branches', projectPath),

  // Check if a branch exists
  branchExists: (projectPath: string, branchName: string): Promise<boolean> =>
    ipcRenderer.invoke('git:branchExists', projectPath, branchName)
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('db', db)
    contextBridge.exposeInMainWorld('projectOps', projectOps)
    contextBridge.exposeInMainWorld('worktreeOps', worktreeOps)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-expect-error (define in dts)
  window.api = api
  // @ts-expect-error (define in dts)
  window.db = db
  // @ts-expect-error (define in dts)
  window.projectOps = projectOps
  // @ts-expect-error (define in dts)
  window.worktreeOps = worktreeOps
}
