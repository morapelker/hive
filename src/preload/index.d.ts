// Database types for renderer
interface Project {
  id: string
  name: string
  path: string
  description: string | null
  tags: string | null
  created_at: string
  last_accessed_at: string
}

interface Worktree {
  id: string
  project_id: string
  name: string
  branch_name: string
  path: string
  status: 'active' | 'archived'
  created_at: string
  last_accessed_at: string
}

interface Session {
  id: string
  worktree_id: string | null
  project_id: string
  name: string | null
  status: 'active' | 'completed' | 'error'
  opencode_session_id: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

interface SessionMessage {
  id: string
  session_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  created_at: string
}

interface Setting {
  key: string
  value: string
}

interface SessionWithWorktree extends Session {
  worktree_name?: string
  worktree_branch_name?: string
  project_name?: string
}

interface SessionSearchOptions {
  keyword?: string
  project_id?: string
  worktree_id?: string
  dateFrom?: string
  dateTo?: string
  includeArchived?: boolean
}

declare global {
  interface Window {
    api: {
      invoke: <T = unknown>(channel: string, ...args: unknown[]) => Promise<T>
      on: (channel: string, callback: (...args: unknown[]) => void) => () => void
    }
    db: {
      setting: {
        get: (key: string) => Promise<string | null>
        set: (key: string, value: string) => Promise<boolean>
        delete: (key: string) => Promise<boolean>
        getAll: () => Promise<Setting[]>
      }
      project: {
        create: (data: {
          name: string
          path: string
          description?: string | null
          tags?: string[] | null
        }) => Promise<Project>
        get: (id: string) => Promise<Project | null>
        getByPath: (path: string) => Promise<Project | null>
        getAll: () => Promise<Project[]>
        update: (
          id: string,
          data: {
            name?: string
            description?: string | null
            tags?: string[] | null
            last_accessed_at?: string
          }
        ) => Promise<Project | null>
        delete: (id: string) => Promise<boolean>
        touch: (id: string) => Promise<boolean>
      }
      worktree: {
        create: (data: {
          project_id: string
          name: string
          branch_name: string
          path: string
        }) => Promise<Worktree>
        get: (id: string) => Promise<Worktree | null>
        getByProject: (projectId: string) => Promise<Worktree[]>
        getActiveByProject: (projectId: string) => Promise<Worktree[]>
        update: (
          id: string,
          data: {
            name?: string
            status?: 'active' | 'archived'
            last_accessed_at?: string
          }
        ) => Promise<Worktree | null>
        delete: (id: string) => Promise<boolean>
        archive: (id: string) => Promise<Worktree | null>
        touch: (id: string) => Promise<boolean>
      }
      session: {
        create: (data: {
          worktree_id: string | null
          project_id: string
          name?: string | null
          opencode_session_id?: string | null
        }) => Promise<Session>
        get: (id: string) => Promise<Session | null>
        getByWorktree: (worktreeId: string) => Promise<Session[]>
        getByProject: (projectId: string) => Promise<Session[]>
        getActiveByWorktree: (worktreeId: string) => Promise<Session[]>
        update: (
          id: string,
          data: {
            name?: string | null
            status?: 'active' | 'completed' | 'error'
            opencode_session_id?: string | null
            updated_at?: string
            completed_at?: string | null
          }
        ) => Promise<Session | null>
        delete: (id: string) => Promise<boolean>
        search: (options: SessionSearchOptions) => Promise<SessionWithWorktree[]>
      }
      message: {
        create: (data: {
          session_id: string
          role: 'user' | 'assistant' | 'system'
          content: string
        }) => Promise<SessionMessage>
        getBySession: (sessionId: string) => Promise<SessionMessage[]>
        delete: (id: string) => Promise<boolean>
      }
      schemaVersion: () => Promise<number>
      tableExists: (tableName: string) => Promise<boolean>
      getIndexes: () => Promise<{ name: string; tbl_name: string }[]>
    }
    projectOps: {
      openDirectoryDialog: () => Promise<string | null>
      isGitRepository: (path: string) => Promise<boolean>
      validateProject: (path: string) => Promise<{
        success: boolean
        path?: string
        name?: string
        error?: string
      }>
      showInFolder: (path: string) => Promise<void>
      openPath: (path: string) => Promise<string>
      copyToClipboard: (text: string) => Promise<void>
      readFromClipboard: () => Promise<string>
    }
    worktreeOps: {
      create: (params: {
        projectId: string
        projectPath: string
        projectName: string
      }) => Promise<{
        success: boolean
        worktree?: Worktree
        error?: string
      }>
      delete: (params: {
        worktreeId: string
        worktreePath: string
        branchName: string
        projectPath: string
        archive: boolean
      }) => Promise<{
        success: boolean
        error?: string
      }>
      sync: (params: {
        projectId: string
        projectPath: string
      }) => Promise<{
        success: boolean
        error?: string
      }>
      exists: (worktreePath: string) => Promise<boolean>
      openInTerminal: (worktreePath: string) => Promise<{
        success: boolean
        error?: string
      }>
      openInEditor: (worktreePath: string) => Promise<{
        success: boolean
        error?: string
      }>
      getBranches: (projectPath: string) => Promise<{
        success: boolean
        branches?: string[]
        currentBranch?: string
        error?: string
      }>
      branchExists: (projectPath: string, branchName: string) => Promise<boolean>
    }
    systemOps: {
      getLogDir: () => Promise<string>
      getAppVersion: () => Promise<string>
      getAppPaths: () => Promise<{
        userData: string
        home: string
        logs: string
      }>
    }
    opencodeOps: {
      // Connect to OpenCode for a worktree (lazy starts server if needed)
      connect: (
        worktreePath: string,
        hiveSessionId: string
      ) => Promise<{ success: boolean; sessionId?: string; error?: string }>
      // Reconnect to existing OpenCode session
      reconnect: (
        worktreePath: string,
        opencodeSessionId: string,
        hiveSessionId: string
      ) => Promise<{ success: boolean }>
      // Send a prompt (response streams via onStream)
      prompt: (
        worktreePath: string,
        opencodeSessionId: string,
        message: string
      ) => Promise<{ success: boolean; error?: string }>
      // Disconnect session (may kill server if last session for worktree)
      disconnect: (
        worktreePath: string,
        opencodeSessionId: string
      ) => Promise<{ success: boolean; error?: string }>
      // Get messages from an OpenCode session
      getMessages: (
        worktreePath: string,
        opencodeSessionId: string
      ) => Promise<{ success: boolean; messages: unknown[]; error?: string }>
      // Subscribe to streaming events
      onStream: (callback: (event: OpenCodeStreamEvent) => void) => () => void
    }
    fileTreeOps: {
      // Scan a directory and return the file tree
      scan: (dirPath: string) => Promise<{
        success: boolean
        tree?: FileTreeNode[]
        error?: string
      }>
      // Lazy load children for a directory
      loadChildren: (dirPath: string, rootPath: string) => Promise<{
        success: boolean
        children?: FileTreeNode[]
        error?: string
      }>
      // Start watching a directory for changes
      watch: (worktreePath: string) => Promise<{
        success: boolean
        error?: string
      }>
      // Stop watching a directory
      unwatch: (worktreePath: string) => Promise<{
        success: boolean
        error?: string
      }>
      // Subscribe to file tree change events
      onChange: (callback: (event: FileTreeChangeEvent) => void) => () => void
    }
    settingsOps: {
      detectEditors: () => Promise<DetectedApp[]>
      detectTerminals: () => Promise<DetectedApp[]>
      openWithEditor: (worktreePath: string, editorId: string, customCommand?: string) => Promise<{
        success: boolean
        error?: string
      }>
      openWithTerminal: (worktreePath: string, terminalId: string, customCommand?: string) => Promise<{
        success: boolean
        error?: string
      }>
    }
    gitOps: {
      // Get file statuses for a worktree
      getFileStatuses: (worktreePath: string) => Promise<{
        success: boolean
        files?: GitFileStatus[]
        error?: string
      }>
      // Stage a file
      stageFile: (worktreePath: string, filePath: string) => Promise<{
        success: boolean
        error?: string
      }>
      // Unstage a file
      unstageFile: (worktreePath: string, filePath: string) => Promise<{
        success: boolean
        error?: string
      }>
      // Discard changes in a file
      discardChanges: (worktreePath: string, filePath: string) => Promise<{
        success: boolean
        error?: string
      }>
      // Add to .gitignore
      addToGitignore: (worktreePath: string, pattern: string) => Promise<{
        success: boolean
        error?: string
      }>
      // Open file in default editor
      openInEditor: (filePath: string) => Promise<{
        success: boolean
        error?: string
      }>
      // Show file in Finder
      showInFinder: (filePath: string) => Promise<{
        success: boolean
        error?: string
      }>
      // Subscribe to git status change events
      onStatusChanged: (callback: (event: GitStatusChangedEvent) => void) => () => void
      // Get branch info (name, tracking, ahead/behind)
      getBranchInfo: (worktreePath: string) => Promise<{
        success: boolean
        branch?: GitBranchInfo
        error?: string
      }>
      // Stage all modified and untracked files
      stageAll: (worktreePath: string) => Promise<{
        success: boolean
        error?: string
      }>
      // Unstage all staged files
      unstageAll: (worktreePath: string) => Promise<{
        success: boolean
        error?: string
      }>
      // Commit staged changes
      commit: (worktreePath: string, message: string) => Promise<{
        success: boolean
        commitHash?: string
        error?: string
      }>
      // Push to remote
      push: (worktreePath: string, remote?: string, branch?: string, force?: boolean) => Promise<{
        success: boolean
        pushed?: boolean
        error?: string
      }>
      // Pull from remote
      pull: (worktreePath: string, remote?: string, branch?: string, rebase?: boolean) => Promise<{
        success: boolean
        updated?: boolean
        error?: string
      }>
      // Get diff for a file
      getDiff: (worktreePath: string, filePath: string, staged: boolean, isUntracked: boolean) => Promise<{
        success: boolean
        diff?: string
        fileName?: string
        error?: string
      }>
    }
  }
}

// OpenCode stream event type
interface OpenCodeStreamEvent {
  type: string
  sessionId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
}

// File tree node type
interface FileTreeNode {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
  extension: string | null
  children?: FileTreeNode[]
}

// File tree change event type
interface FileTreeChangeEvent {
  worktreePath: string
  eventType: 'add' | 'addDir' | 'unlink' | 'unlinkDir' | 'change'
  changedPath: string
  relativePath: string
}

// Git status types
type GitStatusCode = 'M' | 'A' | 'D' | '?' | 'C' | ''

interface GitFileStatus {
  path: string
  relativePath: string
  status: GitStatusCode
  staged: boolean
}

interface GitStatusChangedEvent {
  worktreePath: string
}

interface GitBranchInfo {
  name: string
  tracking: string | null
  ahead: number
  behind: number
}

interface DetectedApp {
  id: string
  name: string
  command: string
  available: boolean
}

export {}
