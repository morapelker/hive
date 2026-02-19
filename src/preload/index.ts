import { contextBridge, ipcRenderer } from 'electron'

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
    create: (data: {
      name: string
      path: string
      description?: string | null
      tags?: string[] | null
    }) => ipcRenderer.invoke('db:project:create', data),
    get: (id: string) => ipcRenderer.invoke('db:project:get', id),
    getByPath: (path: string) => ipcRenderer.invoke('db:project:getByPath', path),
    getAll: () => ipcRenderer.invoke('db:project:getAll'),
    update: (
      id: string,
      data: {
        name?: string
        description?: string | null
        tags?: string[] | null
        language?: string | null
        custom_icon?: string | null
        setup_script?: string | null
        run_script?: string | null
        archive_script?: string | null
        auto_assign_port?: boolean
        last_accessed_at?: string
      }
    ) => ipcRenderer.invoke('db:project:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('db:project:delete', id),
    touch: (id: string) => ipcRenderer.invoke('db:project:touch', id),
    reorder: (orderedIds: string[]) => ipcRenderer.invoke('db:project:reorder', orderedIds),
    sortByLastMessage: () => ipcRenderer.invoke('db:project:sortByLastMessage')
  },

  // Worktrees
  worktree: {
    create: (data: { project_id: string; name: string; branch_name: string; path: string }) =>
      ipcRenderer.invoke('db:worktree:create', data),
    get: (id: string) => ipcRenderer.invoke('db:worktree:get', id),
    getByProject: (projectId: string) => ipcRenderer.invoke('db:worktree:getByProject', projectId),
    getActiveByProject: (projectId: string) =>
      ipcRenderer.invoke('db:worktree:getActiveByProject', projectId),
    update: (
      id: string,
      data: { name?: string; status?: 'active' | 'archived'; last_accessed_at?: string }
    ) => ipcRenderer.invoke('db:worktree:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('db:worktree:delete', id),
    archive: (id: string) => ipcRenderer.invoke('db:worktree:archive', id),
    touch: (id: string) => ipcRenderer.invoke('db:worktree:touch', id),
    appendSessionTitle: (worktreeId: string, title: string) =>
      ipcRenderer.invoke('db:worktree:appendSessionTitle', { worktreeId, title }),
    updateModel: (params: {
      worktreeId: string
      modelProviderId: string
      modelId: string
      modelVariant: string | null
    }) => ipcRenderer.invoke('db:worktree:updateModel', params)
  },

  // Sessions
  session: {
    create: (data: {
      worktree_id: string | null
      project_id: string
      connection_id?: string | null
      name?: string | null
      opencode_session_id?: string | null
      agent_sdk?: 'opencode' | 'claude-code'
      model_provider_id?: string | null
      model_id?: string | null
      model_variant?: string | null
    }) => ipcRenderer.invoke('db:session:create', data),
    get: (id: string) => ipcRenderer.invoke('db:session:get', id),
    getByWorktree: (worktreeId: string) =>
      ipcRenderer.invoke('db:session:getByWorktree', worktreeId),
    getByProject: (projectId: string) => ipcRenderer.invoke('db:session:getByProject', projectId),
    getActiveByWorktree: (worktreeId: string) =>
      ipcRenderer.invoke('db:session:getActiveByWorktree', worktreeId),
    update: (
      id: string,
      data: {
        name?: string | null
        status?: 'active' | 'completed' | 'error'
        opencode_session_id?: string | null
        agent_sdk?: 'opencode' | 'claude-code'
        mode?: 'build' | 'plan'
        model_provider_id?: string | null
        model_id?: string | null
        model_variant?: string | null
        updated_at?: string
        completed_at?: string | null
      }
    ) => ipcRenderer.invoke('db:session:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('db:session:delete', id),
    search: (options: {
      keyword?: string
      project_id?: string
      worktree_id?: string
      dateFrom?: string
      dateTo?: string
      includeArchived?: boolean
    }) => ipcRenderer.invoke('db:session:search', options),
    getDraft: (sessionId: string) => ipcRenderer.invoke('db:session:getDraft', sessionId),
    updateDraft: (sessionId: string, draft: string | null) =>
      ipcRenderer.invoke('db:session:updateDraft', sessionId, draft),
    getByConnection: (connectionId: string) =>
      ipcRenderer.invoke('db:session:getByConnection', connectionId),
    getActiveByConnection: (connectionId: string) =>
      ipcRenderer.invoke('db:session:getActiveByConnection', connectionId)
  },

  // Spaces
  space: {
    list: () => ipcRenderer.invoke('db:space:list'),
    create: (data: { name: string; icon_type?: string; icon_value?: string }) =>
      ipcRenderer.invoke('db:space:create', data),
    update: (
      id: string,
      data: { name?: string; icon_type?: string; icon_value?: string; sort_order?: number }
    ) => ipcRenderer.invoke('db:space:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('db:space:delete', id),
    assignProject: (projectId: string, spaceId: string) =>
      ipcRenderer.invoke('db:space:assignProject', projectId, spaceId),
    removeProject: (projectId: string, spaceId: string) =>
      ipcRenderer.invoke('db:space:removeProject', projectId, spaceId),
    getProjectIds: (spaceId: string) => ipcRenderer.invoke('db:space:getProjectIds', spaceId),
    getAllAssignments: () => ipcRenderer.invoke('db:space:getAllAssignments'),
    reorder: (orderedIds: string[]) => ipcRenderer.invoke('db:space:reorder', orderedIds)
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
  readFromClipboard: (): Promise<string> => ipcRenderer.invoke('clipboard:readText'),

  // Detect the primary programming language of a project
  detectLanguage: (projectPath: string): Promise<string | null> =>
    ipcRenderer.invoke('project:detectLanguage', projectPath),

  // Load custom language icons as data URLs
  loadLanguageIcons: (): Promise<Record<string, string>> =>
    ipcRenderer.invoke('project:loadLanguageIcons'),

  // Initialize a new git repository in a directory
  initRepository: (path: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('git:init', path),

  // Pick a custom project icon via native file dialog
  pickProjectIcon: (
    projectId: string
  ): Promise<{ success: boolean; filename?: string; error?: string }> =>
    ipcRenderer.invoke('project:pickIcon', projectId),

  // Remove a custom project icon
  removeProjectIcon: (projectId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('project:removeIcon', projectId),

  // Resolve an icon filename to a full file path
  getProjectIconPath: (filename: string): Promise<string | null> =>
    ipcRenderer.invoke('project:getIconPath', filename)
}

// Worktree operations API
const worktreeOps = {
  // Check if a repository has any commits
  hasCommits: (projectPath: string): Promise<boolean> =>
    ipcRenderer.invoke('worktree:hasCommits', projectPath),

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
  exists: (worktreePath: string): Promise<boolean> =>
    ipcRenderer.invoke('worktree:exists', worktreePath),

  // Open worktree in terminal
  openInTerminal: (
    worktreePath: string
  ): Promise<{
    success: boolean
    error?: string
  }> => ipcRenderer.invoke('worktree:openInTerminal', worktreePath),

  // Open worktree in editor (VS Code)
  openInEditor: (
    worktreePath: string
  ): Promise<{
    success: boolean
    error?: string
  }> => ipcRenderer.invoke('worktree:openInEditor', worktreePath),

  // Get git branches for a project
  getBranches: (
    projectPath: string
  ): Promise<{
    success: boolean
    branches?: string[]
    currentBranch?: string
    error?: string
  }> => ipcRenderer.invoke('git:branches', projectPath),

  // Check if a branch exists
  branchExists: (projectPath: string, branchName: string): Promise<boolean> =>
    ipcRenderer.invoke('git:branchExists', projectPath, branchName),

  // Duplicate a worktree (clone branch with uncommitted state)
  duplicate: (params: {
    projectId: string
    projectPath: string
    projectName: string
    sourceBranch: string
    sourceWorktreePath: string
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
  }> => ipcRenderer.invoke('worktree:duplicate', params),

  // Rename a branch in a worktree
  renameBranch: (
    worktreeId: string,
    worktreePath: string,
    oldBranch: string,
    newBranch: string
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('worktree:renameBranch', { worktreeId, worktreePath, oldBranch, newBranch }),

  // Create a worktree from a specific existing branch
  createFromBranch: (
    projectId: string,
    projectPath: string,
    projectName: string,
    branchName: string
  ): Promise<{
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
  }> =>
    ipcRenderer.invoke('worktree:createFromBranch', {
      projectId,
      projectPath,
      projectName,
      branchName
    }),

  // Subscribe to branch-renamed events (auto-rename from main process)
  onBranchRenamed: (
    callback: (data: { worktreeId: string; newBranch: string }) => void
  ): (() => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      data: { worktreeId: string; newBranch: string }
    ): void => {
      callback(data)
    }
    ipcRenderer.on('worktree:branchRenamed', handler)
    return () => {
      ipcRenderer.removeListener('worktree:branchRenamed', handler)
    }
  }
}

// System operations API
const systemOps = {
  // Get log directory path
  getLogDir: (): Promise<string> => ipcRenderer.invoke('system:getLogDir'),

  // Get app version
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('system:getAppVersion'),

  // Get app paths
  getAppPaths: (): Promise<{
    userData: string
    home: string
    logs: string
  }> => ipcRenderer.invoke('system:getAppPaths'),

  // Check if response logging is enabled (--log flag)
  isLogMode: (): Promise<boolean> => ipcRenderer.invoke('system:isLogMode'),

  // Detect which agent SDKs (opencode, claude) are installed on the system
  detectAgentSdks: (): Promise<{ opencode: boolean; claude: boolean }> =>
    ipcRenderer.invoke('system:detectAgentSdks'),

  // Quit the app (needed for macOS where window.close() doesn't quit)
  quitApp: (): Promise<void> => ipcRenderer.invoke('system:quitApp'),

  // Open a path in an external app (Cursor, Ghostty) or copy to clipboard
  openInApp: (appName: string, path: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('system:openInApp', appName, path),

  // Subscribe to Cmd+T / Ctrl+T new session shortcut from main process
  onNewSessionShortcut: (callback: () => void): (() => void) => {
    const handler = (): void => {
      callback()
    }
    ipcRenderer.on('shortcut:new-session', handler)
    return () => {
      ipcRenderer.removeListener('shortcut:new-session', handler)
    }
  },

  // Subscribe to Cmd+W / Ctrl+W close session shortcut from main process
  onCloseSessionShortcut: (callback: () => void): (() => void) => {
    const handler = (): void => {
      callback()
    }
    ipcRenderer.on('shortcut:close-session', handler)
    return () => {
      ipcRenderer.removeListener('shortcut:close-session', handler)
    }
  },

  // Subscribe to Cmd+D / Ctrl+D file search shortcut from main process
  onFileSearchShortcut: (callback: () => void): (() => void) => {
    const handler = (): void => {
      callback()
    }
    ipcRenderer.on('shortcut:file-search', handler)
    return () => {
      ipcRenderer.removeListener('shortcut:file-search', handler)
    }
  },

  // Open a URL in Chrome (or default browser) with optional custom command
  openInChrome: (url: string, customCommand?: string) =>
    ipcRenderer.invoke('system:openInChrome', { url, customCommand }),

  // Subscribe to notification navigation events (from native notifications)
  onNotificationNavigate: (
    callback: (data: { projectId: string; worktreeId: string; sessionId: string }) => void
  ): (() => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      data: { projectId: string; worktreeId: string; sessionId: string }
    ): void => {
      callback(data)
    }
    ipcRenderer.on('notification:navigate', handler)
    return () => {
      ipcRenderer.removeListener('notification:navigate', handler)
    }
  },

  // Subscribe to window focus events (for git refresh on app focus)
  onWindowFocused: (callback: () => void): (() => void) => {
    const handler = (): void => {
      callback()
    }
    ipcRenderer.on('app:windowFocused', handler)
    return () => {
      ipcRenderer.removeListener('app:windowFocused', handler)
    }
  },

  // Update menu item enabled/disabled state (renderer -> main)
  updateMenuState: (state: {
    hasActiveSession: boolean
    hasActiveWorktree: boolean
    canUndo?: boolean
    canRedo?: boolean
  }): Promise<void> => ipcRenderer.invoke('menu:updateState', state),

  // Subscribe to menu action events from the application menu (main -> renderer)
  onMenuAction: (channel: string, callback: () => void): (() => void) => {
    const handler = (): void => {
      callback()
    }
    ipcRenderer.on(channel, handler)
    return () => {
      ipcRenderer.removeListener(channel, handler)
    }
  }
}

// Response logging operations API (only functional when --log is active)
const loggingOps = {
  // Create a new response log file for a session
  createResponseLog: (sessionId: string): Promise<string> =>
    ipcRenderer.invoke('logging:createResponseLog', sessionId),

  // Append a JSON line to the response log
  appendResponseLog: (filePath: string, data: unknown): Promise<void> =>
    ipcRenderer.invoke('logging:appendResponseLog', filePath, data)
}

// OpenCode SDK operations API
export interface OpenCodeStreamEvent {
  type: string
  sessionId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
  childSessionId?: string
  /** session.status event payload -- only present when type === 'session.status' */
  statusPayload?: {
    type: 'idle' | 'busy' | 'retry'
    attempt?: number
    message?: string
    next?: number
  }
}

// File tree node type
export interface FileTreeNode {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
  isSymlink?: boolean
  extension: string | null
  children?: FileTreeNode[]
}

// Flat file entry for search index (no tree structure)
export interface FlatFile {
  name: string
  path: string
  relativePath: string
  extension: string | null
}

// File tree change event type
export interface FileTreeChangeEvent {
  worktreePath: string
  eventType: 'add' | 'addDir' | 'unlink' | 'unlinkDir' | 'change'
  changedPath: string
  relativePath: string
}

// Git status types
export type GitStatusCode = 'M' | 'A' | 'D' | '?' | 'C' | ''

export interface GitFileStatus {
  path: string
  relativePath: string
  status: GitStatusCode
  staged: boolean
}

export interface GitStatusChangedEvent {
  worktreePath: string
}

export interface GitBranchInfo {
  name: string
  tracking: string | null
  ahead: number
  behind: number
}

// File tree operations API
const fileTreeOps = {
  // Scan a directory and return the file tree
  scan: (
    dirPath: string
  ): Promise<{
    success: boolean
    tree?: FileTreeNode[]
    error?: string
  }> => ipcRenderer.invoke('file-tree:scan', dirPath),

  // Scan a directory and return a flat list of all files (via git ls-files)
  scanFlat: (
    dirPath: string
  ): Promise<{
    success: boolean
    files?: FlatFile[]
    error?: string
  }> => ipcRenderer.invoke('file-tree:scan-flat', dirPath),

  // Lazy load children for a directory
  loadChildren: (
    dirPath: string,
    rootPath: string
  ): Promise<{
    success: boolean
    children?: FileTreeNode[]
    error?: string
  }> => ipcRenderer.invoke('file-tree:loadChildren', dirPath, rootPath),

  // Start watching a directory for changes
  watch: (
    worktreePath: string
  ): Promise<{
    success: boolean
    error?: string
  }> => ipcRenderer.invoke('file-tree:watch', worktreePath),

  // Stop watching a directory
  unwatch: (
    worktreePath: string
  ): Promise<{
    success: boolean
    error?: string
  }> => ipcRenderer.invoke('file-tree:unwatch', worktreePath),

  // Subscribe to file tree change events
  onChange: (callback: (event: FileTreeChangeEvent) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: FileTreeChangeEvent): void => {
      callback(event)
    }
    ipcRenderer.on('file-tree:change', handler)
    return () => {
      ipcRenderer.removeListener('file-tree:change', handler)
    }
  }
}

// Git file operations API
const gitOps = {
  // Get file statuses for a worktree
  getFileStatuses: (
    worktreePath: string
  ): Promise<{
    success: boolean
    files?: GitFileStatus[]
    error?: string
  }> => ipcRenderer.invoke('git:fileStatuses', worktreePath),

  // Stage a file
  stageFile: (
    worktreePath: string,
    filePath: string
  ): Promise<{
    success: boolean
    error?: string
  }> => ipcRenderer.invoke('git:stageFile', worktreePath, filePath),

  // Unstage a file
  unstageFile: (
    worktreePath: string,
    filePath: string
  ): Promise<{
    success: boolean
    error?: string
  }> => ipcRenderer.invoke('git:unstageFile', worktreePath, filePath),

  // Discard changes in a file
  discardChanges: (
    worktreePath: string,
    filePath: string
  ): Promise<{
    success: boolean
    error?: string
  }> => ipcRenderer.invoke('git:discardChanges', worktreePath, filePath),

  // Add to .gitignore
  addToGitignore: (
    worktreePath: string,
    pattern: string
  ): Promise<{
    success: boolean
    error?: string
  }> => ipcRenderer.invoke('git:addToGitignore', worktreePath, pattern),

  // Open file in default editor
  openInEditor: (
    filePath: string
  ): Promise<{
    success: boolean
    error?: string
  }> => ipcRenderer.invoke('git:openInEditor', filePath),

  // Show file in Finder
  showInFinder: (
    filePath: string
  ): Promise<{
    success: boolean
    error?: string
  }> => ipcRenderer.invoke('git:showInFinder', filePath),

  // Subscribe to git status change events
  onStatusChanged: (callback: (event: GitStatusChangedEvent) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: GitStatusChangedEvent): void => {
      callback(event)
    }
    ipcRenderer.on('git:statusChanged', handler)
    return () => {
      ipcRenderer.removeListener('git:statusChanged', handler)
    }
  },

  // Start watching a worktree for git changes (filesystem + .git metadata)
  watchWorktree: (
    worktreePath: string
  ): Promise<{
    success: boolean
    error?: string
  }> => ipcRenderer.invoke('git:watchWorktree', worktreePath),

  // Stop watching a worktree
  unwatchWorktree: (
    worktreePath: string
  ): Promise<{
    success: boolean
    error?: string
  }> => ipcRenderer.invoke('git:unwatchWorktree', worktreePath),

  // Start watching a worktree's .git/HEAD for branch changes (lightweight, sidebar use)
  watchBranch: (
    worktreePath: string
  ): Promise<{
    success: boolean
    error?: string
  }> => ipcRenderer.invoke('git:watchBranch', worktreePath),

  // Stop watching a worktree's branch
  unwatchBranch: (
    worktreePath: string
  ): Promise<{
    success: boolean
    error?: string
  }> => ipcRenderer.invoke('git:unwatchBranch', worktreePath),

  // Subscribe to branch change events (lightweight, from branch-watcher)
  onBranchChanged: (callback: (event: { worktreePath: string }) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: { worktreePath: string }): void => {
      callback(event)
    }
    ipcRenderer.on('git:branchChanged', handler)
    return () => {
      ipcRenderer.removeListener('git:branchChanged', handler)
    }
  },

  // Get branch info (name, tracking, ahead/behind)
  getBranchInfo: (
    worktreePath: string
  ): Promise<{
    success: boolean
    branch?: GitBranchInfo
    error?: string
  }> => ipcRenderer.invoke('git:branchInfo', worktreePath),

  // Stage all modified and untracked files
  stageAll: (
    worktreePath: string
  ): Promise<{
    success: boolean
    error?: string
  }> => ipcRenderer.invoke('git:stageAll', worktreePath),

  // Unstage all staged files
  unstageAll: (
    worktreePath: string
  ): Promise<{
    success: boolean
    error?: string
  }> => ipcRenderer.invoke('git:unstageAll', worktreePath),

  // Commit staged changes
  commit: (
    worktreePath: string,
    message: string
  ): Promise<{
    success: boolean
    commitHash?: string
    error?: string
  }> => ipcRenderer.invoke('git:commit', worktreePath, message),

  // Push to remote
  push: (
    worktreePath: string,
    remote?: string,
    branch?: string,
    force?: boolean
  ): Promise<{
    success: boolean
    pushed?: boolean
    error?: string
  }> => ipcRenderer.invoke('git:push', worktreePath, remote, branch, force),

  // Pull from remote
  pull: (
    worktreePath: string,
    remote?: string,
    branch?: string,
    rebase?: boolean
  ): Promise<{
    success: boolean
    updated?: boolean
    error?: string
  }> => ipcRenderer.invoke('git:pull', worktreePath, remote, branch, rebase),

  // Get diff for a file
  getDiff: (
    worktreePath: string,
    filePath: string,
    staged: boolean,
    isUntracked: boolean,
    contextLines?: number
  ): Promise<{
    success: boolean
    diff?: string
    fileName?: string
    error?: string
  }> => ipcRenderer.invoke('git:diff', worktreePath, filePath, staged, isUntracked, contextLines),

  // List all branches with their worktree checkout status
  listBranchesWithStatus: (
    projectPath: string
  ): Promise<{
    success: boolean
    branches: Array<{
      name: string
      isRemote: boolean
      isCheckedOut: boolean
      worktreePath?: string
    }>
    error?: string
  }> => ipcRenderer.invoke('git:listBranchesWithStatus', { projectPath }),

  // Merge a branch into the current branch
  merge: (
    worktreePath: string,
    sourceBranch: string
  ): Promise<{
    success: boolean
    error?: string
    conflicts?: string[]
  }> => ipcRenderer.invoke('git:merge', worktreePath, sourceBranch),

  // Get raw file content from disk
  getFileContent: (
    worktreePath: string,
    filePath: string
  ): Promise<{
    success: boolean
    content: string | null
    error?: string
  }> => ipcRenderer.invoke('git:getFileContent', { worktreePath, filePath }),

  // Get remote URL for a worktree
  getRemoteUrl: (
    worktreePath: string,
    remote?: string
  ): Promise<{
    success: boolean
    url: string | null
    remote: string | null
    error?: string
  }> => ipcRenderer.invoke('git:getRemoteUrl', { worktreePath, remote }),

  // Get diff stat (additions/deletions per file) for all uncommitted changes
  getDiffStat: (
    worktreePath: string
  ): Promise<{
    success: boolean
    files?: Array<{
      path: string
      additions: number
      deletions: number
      binary: boolean
    }>
    error?: string
  }> => ipcRenderer.invoke('git:diffStat', worktreePath),

  // Merge a PR on GitHub via gh CLI and sync the local target branch
  prMerge: (
    worktreePath: string,
    prNumber: number
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('git:prMerge', worktreePath, prNumber),

  // Check if a branch has been fully merged into HEAD
  isBranchMerged: (
    worktreePath: string,
    branch: string
  ): Promise<{ success: boolean; isMerged: boolean }> =>
    ipcRenderer.invoke('git:isBranchMerged', worktreePath, branch),

  // Delete a local branch
  deleteBranch: (
    worktreePath: string,
    branchName: string
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('git:deleteBranch', worktreePath, branchName),

  // List open pull requests from GitHub via gh CLI
  listPRs: (
    projectPath: string
  ): Promise<{
    success: boolean
    prs: Array<{
      number: number
      title: string
      author: string
      headRefName: string
    }>
    error?: string
  }> => ipcRenderer.invoke('git:listPRs', { projectPath }),

  // Get file content from a specific git ref (HEAD, index)
  getRefContent: (
    worktreePath: string,
    ref: string,
    filePath: string
  ): Promise<{
    success: boolean
    content?: string
    error?: string
  }> => ipcRenderer.invoke('git:getRefContent', worktreePath, ref, filePath),

  // Stage a single hunk by applying a patch to the index
  stageHunk: (
    worktreePath: string,
    patch: string
  ): Promise<{
    success: boolean
    error?: string
  }> => ipcRenderer.invoke('git:stageHunk', worktreePath, patch),

  // Unstage a single hunk by reverse-applying a patch from the index
  unstageHunk: (
    worktreePath: string,
    patch: string
  ): Promise<{
    success: boolean
    error?: string
  }> => ipcRenderer.invoke('git:unstageHunk', worktreePath, patch),

  // Revert a single hunk in the working tree
  revertHunk: (
    worktreePath: string,
    patch: string
  ): Promise<{
    success: boolean
    error?: string
  }> => ipcRenderer.invoke('git:revertHunk', worktreePath, patch)
}

const opencodeOps = {
  // Connect to OpenCode for a worktree (lazy starts server if needed)
  connect: (
    worktreePath: string,
    hiveSessionId: string
  ): Promise<{ success: boolean; sessionId?: string; error?: string }> =>
    ipcRenderer.invoke('opencode:connect', worktreePath, hiveSessionId),

  // Reconnect to existing OpenCode session
  reconnect: (
    worktreePath: string,
    opencodeSessionId: string,
    hiveSessionId: string
  ): Promise<{
    success: boolean
    sessionStatus?: 'idle' | 'busy' | 'retry'
    revertMessageID?: string | null
  }> => ipcRenderer.invoke('opencode:reconnect', worktreePath, opencodeSessionId, hiveSessionId),

  // Send a prompt (response streams via onStream)
  // Accepts either a string message or a MessagePart[] array for rich content (text + file attachments)
  prompt: (
    worktreePath: string,
    opencodeSessionId: string,
    messageOrParts:
      | string
      | Array<
          | { type: 'text'; text: string }
          | { type: 'file'; mime: string; url: string; filename?: string }
        >,
    model?: { providerID: string; modelID: string; variant?: string }
  ): Promise<{ success: boolean; error?: string }> => {
    const parts =
      typeof messageOrParts === 'string'
        ? [{ type: 'text' as const, text: messageOrParts }]
        : messageOrParts
    return ipcRenderer.invoke('opencode:prompt', {
      worktreePath,
      sessionId: opencodeSessionId,
      parts,
      model
    })
  },

  // Abort a streaming session
  abort: (
    worktreePath: string,
    opencodeSessionId: string
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('opencode:abort', worktreePath, opencodeSessionId),

  // Disconnect session (may kill server if last session for worktree)
  disconnect: (
    worktreePath: string,
    opencodeSessionId: string
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('opencode:disconnect', worktreePath, opencodeSessionId),

  // Get messages from an OpenCode session
  getMessages: (
    worktreePath: string,
    opencodeSessionId: string
  ): Promise<{ success: boolean; messages: unknown[]; error?: string }> =>
    ipcRenderer.invoke('opencode:messages', worktreePath, opencodeSessionId),

  // List available models from all configured providers
  listModels: (opts?: {
    agentSdk?: 'opencode' | 'claude-code'
  }): Promise<{
    success: boolean
    providers: Record<string, unknown>
    error?: string
  }> => ipcRenderer.invoke('opencode:models', opts),

  // Set the selected model for prompts
  setModel: (model: {
    providerID: string
    modelID: string
    variant?: string
    agentSdk?: 'opencode' | 'claude-code'
  }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('opencode:setModel', model),

  // Get model info (name, context limit)
  modelInfo: (
    worktreePath: string,
    modelId: string,
    agentSdk?: 'opencode' | 'claude-code'
  ): Promise<{
    success: boolean
    model?: { id: string; name: string; limit: { context: number } }
    error?: string
  }> => ipcRenderer.invoke('opencode:modelInfo', { worktreePath, modelId, agentSdk }),

  // Reply to a pending question from the AI
  questionReply: (
    requestId: string,
    answers: string[][],
    worktreePath?: string
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('opencode:question:reply', { requestId, answers, worktreePath }),

  // Reject/dismiss a pending question from the AI
  questionReject: (
    requestId: string,
    worktreePath?: string
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('opencode:question:reject', { requestId, worktreePath }),

  // Approve a pending plan (ExitPlanMode) — unblocks the SDK to implement
  planApprove: (
    worktreePath: string,
    hiveSessionId: string,
    requestId?: string
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('opencode:plan:approve', { worktreePath, hiveSessionId, requestId }),

  // Reject a pending plan with user feedback — Claude will revise
  planReject: (
    worktreePath: string,
    hiveSessionId: string,
    feedback: string,
    requestId?: string
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('opencode:plan:reject', {
      worktreePath,
      hiveSessionId,
      feedback,
      requestId
    }),

  // Reply to a pending permission request (allow once, allow always, or reject)
  permissionReply: (
    requestId: string,
    reply: 'once' | 'always' | 'reject',
    worktreePath?: string,
    message?: string
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('opencode:permission:reply', { requestId, reply, worktreePath, message }),

  // List all pending permission requests
  permissionList: (
    worktreePath?: string
  ): Promise<{ success: boolean; permissions: unknown[]; error?: string }> =>
    ipcRenderer.invoke('opencode:permission:list', { worktreePath }),

  // Get session info (revert state)
  sessionInfo: (
    worktreePath: string,
    opencodeSessionId: string
  ): Promise<{
    success: boolean
    revertMessageID?: string | null
    revertDiff?: string | null
    error?: string
  }> => ipcRenderer.invoke('opencode:sessionInfo', { worktreePath, sessionId: opencodeSessionId }),

  // Undo the last assistant turn/message range
  undo: (
    worktreePath: string,
    opencodeSessionId: string
  ): Promise<{
    success: boolean
    revertMessageID?: string
    restoredPrompt?: string
    revertDiff?: string | null
    error?: string
  }> => ipcRenderer.invoke('opencode:undo', { worktreePath, sessionId: opencodeSessionId }),

  // Redo the previously undone message range
  redo: (
    worktreePath: string,
    opencodeSessionId: string
  ): Promise<{ success: boolean; revertMessageID?: string | null; error?: string }> =>
    ipcRenderer.invoke('opencode:redo', { worktreePath, sessionId: opencodeSessionId }),

  // Send a slash command to a session via the SDK command endpoint
  command: (
    worktreePath: string,
    opencodeSessionId: string,
    command: string,
    args: string,
    model?: { providerID: string; modelID: string; variant?: string }
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('opencode:command', {
      worktreePath,
      sessionId: opencodeSessionId,
      command,
      args,
      model
    }),

  // List available slash commands from the SDK
  commands: (
    worktreePath: string,
    sessionId?: string
  ): Promise<{
    success: boolean
    commands: Array<{
      name: string
      description?: string
      template: string
      agent?: string
      model?: string
      source?: string
      subtask?: boolean
      hints?: string[]
    }>
    error?: string
  }> => ipcRenderer.invoke('opencode:commands', { worktreePath, sessionId }),

  // Rename a session's title via the OpenCode PATCH API
  renameSession: (
    opencodeSessionId: string,
    title: string,
    worktreePath?: string
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('opencode:renameSession', { opencodeSessionId, title, worktreePath }),

  // Get SDK capabilities for the current session
  capabilities: (
    opencodeSessionId?: string
  ): Promise<{
    success: boolean
    capabilities?: {
      supportsUndo: boolean
      supportsRedo: boolean
      supportsCommands: boolean
      supportsPermissionRequests: boolean
      supportsQuestionPrompts: boolean
      supportsModelSelection: boolean
      supportsReconnect: boolean
      supportsPartialStreaming: boolean
    }
    error?: string
  }> => ipcRenderer.invoke('opencode:capabilities', { sessionId: opencodeSessionId }),

  // Fork an existing session at an optional message boundary
  fork: (
    worktreePath: string,
    opencodeSessionId: string,
    messageId?: string
  ): Promise<{ success: boolean; sessionId?: string; error?: string }> =>
    ipcRenderer.invoke('opencode:fork', {
      worktreePath,
      sessionId: opencodeSessionId,
      messageId
    }),

  // Subscribe to streaming events
  onStream: (callback: (event: OpenCodeStreamEvent) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: OpenCodeStreamEvent): void => {
      callback(event)
    }
    ipcRenderer.on('opencode:stream', handler)
    return () => {
      ipcRenderer.removeListener('opencode:stream', handler)
    }
  }
}

// Script operations API
interface ScriptOutputEvent {
  type: 'command-start' | 'output' | 'error' | 'done'
  command?: string
  data?: string
  exitCode?: number
}

const scriptOps = {
  // Run setup script (sequential commands, streamed output)
  runSetup: (
    commands: string[],
    cwd: string,
    worktreeId: string
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('script:runSetup', { commands, cwd, worktreeId }),

  // Run project script (persistent long-running process)
  runProject: (
    commands: string[],
    cwd: string,
    worktreeId: string
  ): Promise<{ success: boolean; pid?: number; error?: string }> =>
    ipcRenderer.invoke('script:runProject', { commands, cwd, worktreeId }),

  // Kill a running project script
  kill: (worktreeId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('script:kill', { worktreeId }),

  // Run archive script (non-interactive, captures output)
  runArchive: (
    commands: string[],
    cwd: string
  ): Promise<{ success: boolean; output: string; error?: string }> =>
    ipcRenderer.invoke('script:runArchive', { commands, cwd }),

  // Subscribe to script output events for a channel
  onOutput: (channel: string, callback: (event: ScriptOutputEvent) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: ScriptOutputEvent): void => {
      callback(event)
    }
    ipcRenderer.on(channel, handler)
    return () => {
      ipcRenderer.removeListener(channel, handler)
    }
  },

  // Remove all listeners for a channel
  offOutput: (channel: string): void => {
    ipcRenderer.removeAllListeners(channel)
  },

  // Get assigned port for a worktree path
  getPort: (cwd: string): Promise<{ port: number | null }> =>
    ipcRenderer.invoke('port:get', { cwd })
}

// File operations API (read-only file viewer)
const fileOps = {
  readFile: (filePath: string): Promise<{ success: boolean; content?: string; error?: string }> =>
    ipcRenderer.invoke('file:read', filePath),
  readPrompt: (
    promptName: string
  ): Promise<{ success: boolean; content?: string; error?: string }> =>
    ipcRenderer.invoke('file:readPrompt', promptName)
}

// Settings operations API
export interface DetectedApp {
  id: string
  name: string
  command: string
  available: boolean
}

const settingsOps = {
  // Detect installed editors
  detectEditors: (): Promise<DetectedApp[]> => ipcRenderer.invoke('settings:detectEditors'),

  // Detect installed terminals
  detectTerminals: (): Promise<DetectedApp[]> => ipcRenderer.invoke('settings:detectTerminals'),

  // Open a path with a specific editor
  openWithEditor: (
    worktreePath: string,
    editorId: string,
    customCommand?: string
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('settings:openWithEditor', worktreePath, editorId, customCommand),

  // Open a path with a specific terminal
  openWithTerminal: (
    worktreePath: string,
    terminalId: string,
    customCommand?: string
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('settings:openWithTerminal', worktreePath, terminalId, customCommand)
}

// Terminal operations API (PTY management)
const terminalOps = {
  create: (
    worktreeId: string,
    cwd: string,
    shell?: string
  ): Promise<{ success: boolean; cols?: number; rows?: number; error?: string }> =>
    ipcRenderer.invoke('terminal:create', worktreeId, cwd, shell),

  write: (worktreeId: string, data: string): void =>
    ipcRenderer.send('terminal:write', worktreeId, data),

  resize: (worktreeId: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('terminal:resize', worktreeId, cols, rows),

  destroy: (worktreeId: string): Promise<void> =>
    ipcRenderer.invoke('terminal:destroy', worktreeId),

  onData: (worktreeId: string, callback: (data: string) => void): (() => void) => {
    const channel = `terminal:data:${worktreeId}`
    const handler = (_event: Electron.IpcRendererEvent, data: string): void => {
      callback(data)
    }
    ipcRenderer.on(channel, handler)
    return () => {
      ipcRenderer.removeListener(channel, handler)
    }
  },

  onExit: (worktreeId: string, callback: (code: number) => void): (() => void) => {
    const channel = `terminal:exit:${worktreeId}`
    const handler = (_event: Electron.IpcRendererEvent, code: number): void => {
      callback(code)
    }
    ipcRenderer.on(channel, handler)
    return () => {
      ipcRenderer.removeListener(channel, handler)
    }
  },

  getConfig: (): Promise<{
    fontFamily?: string
    fontSize?: number
    background?: string
    foreground?: string
    cursorStyle?: 'block' | 'bar' | 'underline'
    cursorColor?: string
    shell?: string
    scrollbackLimit?: number
    palette?: Record<number, string>
    selectionBackground?: string
    selectionForeground?: string
  }> => ipcRenderer.invoke('terminal:getConfig'),

  // --- Native Ghostty backend methods ---

  ghosttyInit: (): Promise<{ success: boolean; version?: string; error?: string }> =>
    ipcRenderer.invoke('terminal:ghostty:init'),

  ghosttyIsAvailable: (): Promise<{
    available: boolean
    initialized: boolean
    platform: string
  }> => ipcRenderer.invoke('terminal:ghostty:isAvailable'),

  ghosttyCreateSurface: (
    worktreeId: string,
    rect: { x: number; y: number; w: number; h: number },
    opts?: { cwd?: string; shell?: string; scaleFactor?: number; fontSize?: number }
  ): Promise<{ success: boolean; surfaceId?: number; error?: string }> =>
    ipcRenderer.invoke('terminal:ghostty:createSurface', worktreeId, rect, opts),

  ghosttySetFrame: (
    worktreeId: string,
    rect: { x: number; y: number; w: number; h: number }
  ): Promise<void> => ipcRenderer.invoke('terminal:ghostty:setFrame', worktreeId, rect),

  ghosttySetSize: (worktreeId: string, width: number, height: number): Promise<void> =>
    ipcRenderer.invoke('terminal:ghostty:setSize', worktreeId, width, height),

  ghosttyKeyEvent: (
    worktreeId: string,
    event: {
      action: number
      keycode: number
      mods: number
      consumedMods?: number
      text?: string
      unshiftedCodepoint?: number
      composing?: boolean
    }
  ): Promise<boolean> => ipcRenderer.invoke('terminal:ghostty:keyEvent', worktreeId, event),

  ghosttyMouseButton: (
    worktreeId: string,
    state: number,
    button: number,
    mods: number
  ): Promise<void> =>
    ipcRenderer.invoke('terminal:ghostty:mouseButton', worktreeId, state, button, mods),

  ghosttyMousePos: (worktreeId: string, x: number, y: number, mods: number): Promise<void> =>
    ipcRenderer.invoke('terminal:ghostty:mousePos', worktreeId, x, y, mods),

  ghosttyMouseScroll: (worktreeId: string, dx: number, dy: number, mods: number): Promise<void> =>
    ipcRenderer.invoke('terminal:ghostty:mouseScroll', worktreeId, dx, dy, mods),

  ghosttySetFocus: (worktreeId: string, focused: boolean): Promise<void> =>
    ipcRenderer.invoke('terminal:ghostty:setFocus', worktreeId, focused),

  ghosttyDestroySurface: (worktreeId: string): Promise<void> =>
    ipcRenderer.invoke('terminal:ghostty:destroySurface', worktreeId),

  ghosttyShutdown: (): Promise<void> => ipcRenderer.invoke('terminal:ghostty:shutdown')
}

const updaterOps = {
  checkForUpdate: (): Promise<void> => ipcRenderer.invoke('updater:check'),
  downloadUpdate: (): Promise<void> => ipcRenderer.invoke('updater:download'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('updater:install'),
  setChannel: (channel: string): Promise<void> => ipcRenderer.invoke('updater:setChannel', channel),
  getVersion: (): Promise<string> => ipcRenderer.invoke('updater:getVersion'),

  onChecking: (callback: () => void): (() => void) => {
    const handler = (): void => {
      callback()
    }
    ipcRenderer.on('updater:checking', handler)
    return () => {
      ipcRenderer.removeListener('updater:checking', handler)
    }
  },

  onUpdateAvailable: (
    callback: (data: { version: string; releaseNotes?: string; releaseDate?: string }) => void
  ): (() => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      data: { version: string; releaseNotes?: string; releaseDate?: string }
    ): void => {
      callback(data)
    }
    ipcRenderer.on('updater:available', handler)
    return () => {
      ipcRenderer.removeListener('updater:available', handler)
    }
  },

  onUpdateNotAvailable: (callback: (data: { version: string }) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: { version: string }): void => {
      callback(data)
    }
    ipcRenderer.on('updater:not-available', handler)
    return () => {
      ipcRenderer.removeListener('updater:not-available', handler)
    }
  },

  onProgress: (
    callback: (data: {
      percent: number
      bytesPerSecond: number
      transferred: number
      total: number
    }) => void
  ): (() => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      data: { percent: number; bytesPerSecond: number; transferred: number; total: number }
    ): void => {
      callback(data)
    }
    ipcRenderer.on('updater:progress', handler)
    return () => {
      ipcRenderer.removeListener('updater:progress', handler)
    }
  },

  onUpdateDownloaded: (
    callback: (data: { version: string; releaseNotes?: string }) => void
  ): (() => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      data: { version: string; releaseNotes?: string }
    ): void => {
      callback(data)
    }
    ipcRenderer.on('updater:downloaded', handler)
    return () => {
      ipcRenderer.removeListener('updater:downloaded', handler)
    }
  },

  onError: (callback: (data: { message: string }) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: { message: string }): void => {
      callback(data)
    }
    ipcRenderer.on('updater:error', handler)
    return () => {
      ipcRenderer.removeListener('updater:error', handler)
    }
  }
}

// Connection operations API
const connectionOps = {
  create: (worktreeIds: string[]) => ipcRenderer.invoke('connection:create', { worktreeIds }),
  delete: (connectionId: string) => ipcRenderer.invoke('connection:delete', { connectionId }),
  addMember: (connectionId: string, worktreeId: string) =>
    ipcRenderer.invoke('connection:addMember', { connectionId, worktreeId }),
  removeMember: (connectionId: string, worktreeId: string) =>
    ipcRenderer.invoke('connection:removeMember', { connectionId, worktreeId }),
  getAll: () => ipcRenderer.invoke('connection:getAll'),
  get: (connectionId: string) => ipcRenderer.invoke('connection:get', { connectionId }),
  openInTerminal: (connectionPath: string) =>
    ipcRenderer.invoke('connection:openInTerminal', { connectionPath }),
  openInEditor: (connectionPath: string) =>
    ipcRenderer.invoke('connection:openInEditor', { connectionPath }),
  removeWorktreeFromAll: (worktreeId: string) =>
    ipcRenderer.invoke('connection:removeWorktreeFromAll', { worktreeId })
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('db', db)
    contextBridge.exposeInMainWorld('projectOps', projectOps)
    contextBridge.exposeInMainWorld('worktreeOps', worktreeOps)
    contextBridge.exposeInMainWorld('systemOps', systemOps)
    contextBridge.exposeInMainWorld('opencodeOps', opencodeOps)
    contextBridge.exposeInMainWorld('fileTreeOps', fileTreeOps)
    contextBridge.exposeInMainWorld('gitOps', gitOps)
    contextBridge.exposeInMainWorld('settingsOps', settingsOps)
    contextBridge.exposeInMainWorld('fileOps', fileOps)
    contextBridge.exposeInMainWorld('loggingOps', loggingOps)
    contextBridge.exposeInMainWorld('scriptOps', scriptOps)
    contextBridge.exposeInMainWorld('terminalOps', terminalOps)
    contextBridge.exposeInMainWorld('updaterOps', updaterOps)
    contextBridge.exposeInMainWorld('connectionOps', connectionOps)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-expect-error (define in dts)
  window.db = db
  // @ts-expect-error (define in dts)
  window.projectOps = projectOps
  // @ts-expect-error (define in dts)
  window.worktreeOps = worktreeOps
  // @ts-expect-error (define in dts)
  window.systemOps = systemOps
  // @ts-expect-error (define in dts)
  window.opencodeOps = opencodeOps
  // @ts-expect-error (define in dts)
  window.fileTreeOps = fileTreeOps
  // @ts-expect-error (define in dts)
  window.gitOps = gitOps
  // @ts-expect-error (define in dts)
  window.settingsOps = settingsOps
  // @ts-expect-error (define in dts)
  window.fileOps = fileOps
  // @ts-expect-error (define in dts)
  window.loggingOps = loggingOps
  // @ts-expect-error (define in dts)
  window.scriptOps = scriptOps
  // @ts-expect-error (define in dts)
  window.terminalOps = terminalOps
  // @ts-expect-error (define in dts)
  window.updaterOps = updaterOps
  // @ts-expect-error (define in dts)
  window.connectionOps = connectionOps
}
