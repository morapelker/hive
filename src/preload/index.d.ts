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
  }
}

export {}
