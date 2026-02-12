// Database types for renderer
interface Project {
  id: string
  name: string
  path: string
  description: string | null
  tags: string | null
  language: string | null
  custom_icon: string | null
  setup_script: string | null
  run_script: string | null
  archive_script: string | null
  sort_order: number
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
  is_default: boolean
  branch_renamed: number // 0 = auto-named (city), 1 = user/auto renamed
  last_message_at: number | null // epoch ms of last AI message activity
  session_titles: string // JSON array of session title strings
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
  mode: 'build' | 'plan'
  model_provider_id: string | null
  model_id: string | null
  model_variant: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
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
  interface Space {
    id: string
    name: string
    icon_type: string
    icon_value: string
    sort_order: number
    created_at: string
  }

  interface ProjectSpaceAssignment {
    project_id: string
    space_id: string
  }

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
            language?: string | null
            custom_icon?: string | null
            setup_script?: string | null
            run_script?: string | null
            archive_script?: string | null
            last_accessed_at?: string
          }
        ) => Promise<Project | null>
        delete: (id: string) => Promise<boolean>
        touch: (id: string) => Promise<boolean>
        reorder: (orderedIds: string[]) => Promise<boolean>
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
            last_message_at?: number | null
            last_accessed_at?: string
          }
        ) => Promise<Worktree | null>
        delete: (id: string) => Promise<boolean>
        archive: (id: string) => Promise<Worktree | null>
        touch: (id: string) => Promise<boolean>
        appendSessionTitle: (
          worktreeId: string,
          title: string
        ) => Promise<{ success: boolean; error?: string }>
      }
      session: {
        create: (data: {
          worktree_id: string | null
          project_id: string
          name?: string | null
          opencode_session_id?: string | null
          model_provider_id?: string | null
          model_id?: string | null
          model_variant?: string | null
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
            mode?: 'build' | 'plan'
            model_provider_id?: string | null
            model_id?: string | null
            model_variant?: string | null
            updated_at?: string
            completed_at?: string | null
          }
        ) => Promise<Session | null>
        delete: (id: string) => Promise<boolean>
        search: (options: SessionSearchOptions) => Promise<SessionWithWorktree[]>
        getDraft: (sessionId: string) => Promise<string | null>
        updateDraft: (sessionId: string, draft: string | null) => Promise<void>
      }
      space: {
        list: () => Promise<Space[]>
        create: (data: { name: string; icon_type?: string; icon_value?: string }) => Promise<Space>
        update: (
          id: string,
          data: {
            name?: string
            icon_type?: string
            icon_value?: string
            sort_order?: number
          }
        ) => Promise<Space | null>
        delete: (id: string) => Promise<boolean>
        assignProject: (projectId: string, spaceId: string) => Promise<boolean>
        removeProject: (projectId: string, spaceId: string) => Promise<boolean>
        getProjectIds: (spaceId: string) => Promise<string[]>
        getAllAssignments: () => Promise<ProjectSpaceAssignment[]>
        reorder: (orderedIds: string[]) => Promise<boolean>
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
      detectLanguage: (projectPath: string) => Promise<string | null>
      loadLanguageIcons: () => Promise<Record<string, string>>
      initRepository: (path: string) => Promise<{ success: boolean; error?: string }>
      pickProjectIcon: (projectId: string) => Promise<{
        success: boolean
        filename?: string
        error?: string
      }>
      removeProjectIcon: (projectId: string) => Promise<{
        success: boolean
        error?: string
      }>
      getProjectIconPath: (filename: string) => Promise<string | null>
    }
    worktreeOps: {
      create: (params: { projectId: string; projectPath: string; projectName: string }) => Promise<{
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
      sync: (params: { projectId: string; projectPath: string }) => Promise<{
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
      duplicate: (params: {
        projectId: string
        projectPath: string
        projectName: string
        sourceBranch: string
        sourceWorktreePath: string
      }) => Promise<{
        success: boolean
        worktree?: Worktree
        error?: string
      }>
      renameBranch: (
        worktreeId: string,
        worktreePath: string,
        oldBranch: string,
        newBranch: string
      ) => Promise<{ success: boolean; error?: string }>
      createFromBranch: (
        projectId: string,
        projectPath: string,
        projectName: string,
        branchName: string
      ) => Promise<{
        success: boolean
        worktree?: Worktree
        error?: string
      }>
      // Subscribe to branch-renamed events (auto-rename from main process)
      onBranchRenamed: (
        callback: (data: { worktreeId: string; newBranch: string }) => void
      ) => () => void
    }
    systemOps: {
      getLogDir: () => Promise<string>
      getAppVersion: () => Promise<string>
      getAppPaths: () => Promise<{
        userData: string
        home: string
        logs: string
      }>
      isLogMode: () => Promise<boolean>
      openInApp: (appName: string, path: string) => Promise<{ success: boolean; error?: string }>
      openInChrome: (
        url: string,
        customCommand?: string
      ) => Promise<{ success: boolean; error?: string }>
      onNewSessionShortcut: (callback: () => void) => () => void
      onCloseSessionShortcut: (callback: () => void) => () => void
      onFileSearchShortcut: (callback: () => void) => () => void
      onNotificationNavigate: (
        callback: (data: { projectId: string; worktreeId: string; sessionId: string }) => void
      ) => () => void
      onWindowFocused: (callback: () => void) => () => void
    }
    loggingOps: {
      createResponseLog: (sessionId: string) => Promise<string>
      appendResponseLog: (filePath: string, data: unknown) => Promise<void>
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
      ) => Promise<{
        success: boolean
        sessionStatus?: 'idle' | 'busy' | 'retry'
        revertMessageID?: string | null
      }>
      // Send a prompt (response streams via onStream)
      // Accepts either a string message or a MessagePart[] array for rich content (text + file attachments)
      prompt: (
        worktreePath: string,
        opencodeSessionId: string,
        messageOrParts: string | MessagePart[],
        model?: { providerID: string; modelID: string; variant?: string }
      ) => Promise<{ success: boolean; error?: string }>
      // Abort a streaming session
      abort: (
        worktreePath: string,
        opencodeSessionId: string
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
      // List available models from all configured providers
      listModels: () => Promise<{
        success: boolean
        providers: Record<string, unknown>
        error?: string
      }>
      // Set the selected model for prompts
      setModel: (model: {
        providerID: string
        modelID: string
        variant?: string
      }) => Promise<{ success: boolean; error?: string }>
      // Get model info (name, context limit)
      modelInfo: (
        worktreePath: string,
        modelId: string
      ) => Promise<{
        success: boolean
        model?: { id: string; name: string; limit: { context: number } }
        error?: string
      }>
      // Reply to a pending question from the AI
      questionReply: (
        requestId: string,
        answers: string[][],
        worktreePath?: string
      ) => Promise<{ success: boolean; error?: string }>
      // Reject/dismiss a pending question from the AI
      questionReject: (
        requestId: string,
        worktreePath?: string
      ) => Promise<{ success: boolean; error?: string }>
      // Reply to a pending permission request (allow once, allow always, or reject)
      permissionReply: (
        requestId: string,
        reply: 'once' | 'always' | 'reject',
        worktreePath?: string,
        message?: string
      ) => Promise<{ success: boolean; error?: string }>
      // List all pending permission requests
      permissionList: (
        worktreePath?: string
      ) => Promise<{ success: boolean; permissions: PermissionRequest[]; error?: string }>
      // Get session info (revert state)
      sessionInfo: (
        worktreePath: string,
        opencodeSessionId: string
      ) => Promise<{
        success: boolean
        revertMessageID?: string | null
        revertDiff?: string | null
        error?: string
      }>
      // Undo the last assistant turn/message range
      undo: (
        worktreePath: string,
        opencodeSessionId: string
      ) => Promise<{
        success: boolean
        revertMessageID?: string
        restoredPrompt?: string
        revertDiff?: string | null
        error?: string
      }>
      // Redo the last undone message range
      redo: (
        worktreePath: string,
        opencodeSessionId: string
      ) => Promise<{ success: boolean; revertMessageID?: string | null; error?: string }>
      // Send a slash command to a session via the SDK command endpoint
      command: (
        worktreePath: string,
        opencodeSessionId: string,
        command: string,
        args: string,
        model?: { providerID: string; modelID: string; variant?: string }
      ) => Promise<{ success: boolean; error?: string }>
      // List available slash commands from the SDK
      commands: (
        worktreePath: string
      ) => Promise<{ success: boolean; commands: OpenCodeCommand[]; error?: string }>
      // Rename a session's title via the OpenCode PATCH API
      renameSession: (
        opencodeSessionId: string,
        title: string,
        worktreePath?: string
      ) => Promise<{ success: boolean; error?: string }>
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
      loadChildren: (
        dirPath: string,
        rootPath: string
      ) => Promise<{
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
    fileOps: {
      readFile: (filePath: string) => Promise<{
        success: boolean
        content?: string
        error?: string
      }>
      readPrompt: (promptName: string) => Promise<{
        success: boolean
        content?: string
        error?: string
      }>
    }
    settingsOps: {
      detectEditors: () => Promise<DetectedApp[]>
      detectTerminals: () => Promise<DetectedApp[]>
      openWithEditor: (
        worktreePath: string,
        editorId: string,
        customCommand?: string
      ) => Promise<{
        success: boolean
        error?: string
      }>
      openWithTerminal: (
        worktreePath: string,
        terminalId: string,
        customCommand?: string
      ) => Promise<{
        success: boolean
        error?: string
      }>
    }
    scriptOps: {
      runSetup: (
        commands: string[],
        cwd: string,
        worktreeId: string
      ) => Promise<{
        success: boolean
        error?: string
      }>
      runProject: (
        commands: string[],
        cwd: string,
        worktreeId: string
      ) => Promise<{
        success: boolean
        pid?: number
        error?: string
      }>
      kill: (worktreeId: string) => Promise<{
        success: boolean
        error?: string
      }>
      runArchive: (
        commands: string[],
        cwd: string
      ) => Promise<{
        success: boolean
        output: string
        error?: string
      }>
      onOutput: (channel: string, callback: (event: ScriptOutputEvent) => void) => () => void
      offOutput: (channel: string) => void
    }
    gitOps: {
      // Get file statuses for a worktree
      getFileStatuses: (worktreePath: string) => Promise<{
        success: boolean
        files?: GitFileStatus[]
        error?: string
      }>
      // Stage a file
      stageFile: (
        worktreePath: string,
        filePath: string
      ) => Promise<{
        success: boolean
        error?: string
      }>
      // Unstage a file
      unstageFile: (
        worktreePath: string,
        filePath: string
      ) => Promise<{
        success: boolean
        error?: string
      }>
      // Discard changes in a file
      discardChanges: (
        worktreePath: string,
        filePath: string
      ) => Promise<{
        success: boolean
        error?: string
      }>
      // Add to .gitignore
      addToGitignore: (
        worktreePath: string,
        pattern: string
      ) => Promise<{
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
      commit: (
        worktreePath: string,
        message: string
      ) => Promise<{
        success: boolean
        commitHash?: string
        error?: string
      }>
      // Push to remote
      push: (
        worktreePath: string,
        remote?: string,
        branch?: string,
        force?: boolean
      ) => Promise<{
        success: boolean
        pushed?: boolean
        error?: string
      }>
      // Pull from remote
      pull: (
        worktreePath: string,
        remote?: string,
        branch?: string,
        rebase?: boolean
      ) => Promise<{
        success: boolean
        updated?: boolean
        error?: string
      }>
      // Get diff for a file
      getDiff: (
        worktreePath: string,
        filePath: string,
        staged: boolean,
        isUntracked: boolean,
        contextLines?: number
      ) => Promise<{
        success: boolean
        diff?: string
        fileName?: string
        error?: string
      }>
      // List all branches with their worktree checkout status
      listBranchesWithStatus: (projectPath: string) => Promise<{
        success: boolean
        branches: Array<{
          name: string
          isRemote: boolean
          isCheckedOut: boolean
          worktreePath?: string
        }>
        error?: string
      }>
      // Merge a branch into the current branch
      merge: (
        worktreePath: string,
        sourceBranch: string
      ) => Promise<{
        success: boolean
        error?: string
        conflicts?: string[]
      }>
    }
  }

  // Message part type for prompt API (text + file attachments)
  type MessagePart =
    | { type: 'text'; text: string }
    | { type: 'file'; mime: string; url: string; filename?: string }

  // Script output event type
  interface ScriptOutputEvent {
    type: 'command-start' | 'output' | 'error' | 'done'
    command?: string
    data?: string
    exitCode?: number
  }

  // OpenCode command type (slash commands)
  interface OpenCodeCommand {
    name: string
    description?: string
    template: string
    agent?: string
    model?: string
    source?: 'command' | 'mcp' | 'skill'
    subtask?: boolean
    hints?: string[]
  }

  // OpenCode permission request type
  interface PermissionRequest {
    id: string
    sessionID: string
    permission: string
    patterns: string[]
    metadata: Record<string, unknown>
    always: string[]
    tool?: {
      messageID: string
      callID: string
    }
  }

  // OpenCode stream event type
  interface OpenCodeStreamEvent {
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
}

export {}
