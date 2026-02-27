// Database types for renderer
interface Connection {
  id: string
  name: string
  custom_name: string | null
  status: 'active' | 'archived'
  path: string
  color: string | null // JSON-serialised ConnectionColorQuad
  pinned: number // 0 = not pinned, 1 = pinned
  created_at: string
  updated_at: string
}

interface ConnectionMember {
  id: string
  connection_id: string
  worktree_id: string
  project_id: string
  symlink_name: string
  added_at: string
}

interface ConnectionWithMembers extends Connection {
  members: (ConnectionMember & {
    worktree_name: string
    worktree_branch: string
    worktree_path: string
    project_name: string
  })[]
}

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
  auto_assign_port: boolean
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
  last_model_provider_id: string | null
  last_model_id: string | null
  last_model_variant: string | null
  attachments: string // JSON array of Attachment objects
  pinned: number // 0 = not pinned, 1 = pinned
  context: string | null
  created_at: string
  last_accessed_at: string
}

interface Session {
  id: string
  worktree_id: string | null
  project_id: string
  connection_id: string | null
  name: string | null
  status: 'active' | 'completed' | 'error'
  opencode_session_id: string | null
  agent_sdk: 'opencode' | 'claude-code' | 'terminal'
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
  interface GhosttyTerminalConfig {
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
  }

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
            auto_assign_port?: boolean
            last_accessed_at?: string
          }
        ) => Promise<Project | null>
        delete: (id: string) => Promise<boolean>
        touch: (id: string) => Promise<boolean>
        reorder: (orderedIds: string[]) => Promise<boolean>
        sortByLastMessage: () => Promise<string[]>
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
        getRecentlyActive: (cutoffMs: number) => Promise<Worktree[]>
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
        updateModel: (params: {
          worktreeId: string
          modelProviderId: string
          modelId: string
          modelVariant: string | null
        }) => Promise<{ success: boolean; error?: string }>
        addAttachment: (
          worktreeId: string,
          attachment: { type: 'jira' | 'figma'; url: string; label: string }
        ) => Promise<{ success: boolean; error?: string }>
        removeAttachment: (
          worktreeId: string,
          attachmentId: string
        ) => Promise<{ success: boolean; error?: string }>
        setPinned: (
          worktreeId: string,
          pinned: boolean
        ) => Promise<{ success: boolean; error?: string }>
        getPinned: () => Promise<Worktree[]>
      }
      session: {
        create: (data: {
          worktree_id: string | null
          project_id: string
          connection_id?: string | null
          name?: string | null
          opencode_session_id?: string | null
          agent_sdk?: 'opencode' | 'claude-code' | 'terminal'
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
            agent_sdk?: 'opencode' | 'claude-code' | 'terminal'
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
        getByConnection: (connectionId: string) => Promise<Session[]>
        getActiveByConnection: (connectionId: string) => Promise<Session[]>
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
      hasCommits: (projectPath: string) => Promise<boolean>
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
      detectAgentSdks: () => Promise<{ opencode: boolean; claude: boolean }>
      quitApp: () => Promise<void>
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
      updateMenuState: (state: {
        hasActiveSession: boolean
        hasActiveWorktree: boolean
        canUndo?: boolean
        canRedo?: boolean
      }) => Promise<void>
      onMenuAction: (channel: string, callback: () => void) => () => void
      isPackaged: () => Promise<boolean>
      installServerToPath: () => Promise<{ success: boolean; path?: string; error?: string }>
      uninstallServerFromPath: () => Promise<{ success: boolean; error?: string }>
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
      listModels: (opts?: { agentSdk?: 'opencode' | 'claude-code' | 'terminal' }) => Promise<{
        success: boolean
        providers: Record<string, unknown>
        error?: string
      }>
      // Set the selected model for prompts
      setModel: (model: {
        providerID: string
        modelID: string
        variant?: string
        agentSdk?: 'opencode' | 'claude-code' | 'terminal'
      }) => Promise<{ success: boolean; error?: string }>
      // Get model info (name, context limit)
      modelInfo: (
        worktreePath: string,
        modelId: string,
        agentSdk?: 'opencode' | 'claude-code' | 'terminal'
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
      // Approve a pending plan (ExitPlanMode) — unblocks the SDK to implement
      planApprove: (
        worktreePath: string,
        hiveSessionId: string,
        requestId?: string
      ) => Promise<{ success: boolean; error?: string }>
      // Reject a pending plan with user feedback — Claude will revise
      planReject: (
        worktreePath: string,
        hiveSessionId: string,
        feedback: string,
        requestId?: string
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
      // Reply to a pending command approval request (approve or deny, optionally add to allowlist/blocklist)
      commandApprovalReply: (
        requestId: string,
        approved: boolean,
        remember?: 'allow' | 'block',
        pattern?: string,
        worktreePath?: string
      ) => Promise<{ success: boolean; error?: string }>
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
        worktreePath: string,
        sessionId?: string
      ) => Promise<{ success: boolean; commands: OpenCodeCommand[]; error?: string }>
      // Rename a session's title via the OpenCode PATCH API
      renameSession: (
        opencodeSessionId: string,
        title: string,
        worktreePath?: string
      ) => Promise<{ success: boolean; error?: string }>
      // Get SDK capabilities for the current session
      capabilities: (opencodeSessionId?: string) => Promise<{
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
      }>
      // Fork an existing session at an optional message boundary
      fork: (
        worktreePath: string,
        opencodeSessionId: string,
        messageId?: string
      ) => Promise<{ success: boolean; sessionId?: string; error?: string }>
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
      // Scan a directory and return a flat list of all files (via git ls-files)
      scanFlat: (dirPath: string) => Promise<{
        success: boolean
        files?: FlatFile[]
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
      onSettingsUpdated: (callback: (data: unknown) => void) => () => void
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
      getPort: (cwd: string) => Promise<{ port: number | null }>
    }
    terminalOps: {
      create: (
        worktreeId: string,
        cwd: string,
        shell?: string
      ) => Promise<{ success: boolean; cols?: number; rows?: number; error?: string }>
      write: (worktreeId: string, data: string) => void
      resize: (worktreeId: string, cols: number, rows: number) => Promise<void>
      destroy: (worktreeId: string) => Promise<void>
      onData: (worktreeId: string, callback: (data: string) => void) => () => void
      onExit: (worktreeId: string, callback: (code: number) => void) => () => void
      getConfig: () => Promise<GhosttyTerminalConfig>

      // Native Ghostty backend methods
      ghosttyInit: () => Promise<{ success: boolean; version?: string; error?: string }>
      ghosttyIsAvailable: () => Promise<{
        available: boolean
        initialized: boolean
        platform: string
      }>
      ghosttyCreateSurface: (
        worktreeId: string,
        rect: { x: number; y: number; w: number; h: number },
        opts?: { cwd?: string; shell?: string; scaleFactor?: number; fontSize?: number }
      ) => Promise<{ success: boolean; surfaceId?: number; error?: string }>
      ghosttySetFrame: (
        worktreeId: string,
        rect: { x: number; y: number; w: number; h: number }
      ) => Promise<void>
      ghosttySetSize: (worktreeId: string, width: number, height: number) => Promise<void>
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
      ) => Promise<boolean>
      ghosttyMouseButton: (
        worktreeId: string,
        state: number,
        button: number,
        mods: number
      ) => Promise<void>
      ghosttyMousePos: (worktreeId: string, x: number, y: number, mods: number) => Promise<void>
      ghosttyMouseScroll: (
        worktreeId: string,
        dx: number,
        dy: number,
        mods: number
      ) => Promise<void>
      ghosttySetFocus: (worktreeId: string, focused: boolean) => Promise<void>
      ghosttyDestroySurface: (worktreeId: string) => Promise<void>
      ghosttyShutdown: () => Promise<void>
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
      // Start watching a worktree for git changes (filesystem + .git metadata)
      watchWorktree: (worktreePath: string) => Promise<{
        success: boolean
        error?: string
      }>
      // Stop watching a worktree
      unwatchWorktree: (worktreePath: string) => Promise<{
        success: boolean
        error?: string
      }>
      // Start watching a worktree's .git/HEAD for branch changes (lightweight, sidebar use)
      watchBranch: (worktreePath: string) => Promise<{
        success: boolean
        error?: string
      }>
      // Stop watching a worktree's branch
      unwatchBranch: (worktreePath: string) => Promise<{
        success: boolean
        error?: string
      }>
      // Subscribe to branch change events (lightweight, from branch-watcher)
      onBranchChanged: (callback: (event: { worktreePath: string }) => void) => () => void
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
      // Get raw file content from disk
      getFileContent: (
        worktreePath: string,
        filePath: string
      ) => Promise<{
        success: boolean
        content: string | null
        error?: string
      }>
      // Get remote URL for a worktree
      getRemoteUrl: (
        worktreePath: string,
        remote?: string
      ) => Promise<{
        success: boolean
        url: string | null
        remote: string | null
        error?: string
      }>
      // Get diff stat (additions/deletions per file) for all uncommitted changes
      getDiffStat: (worktreePath: string) => Promise<{
        success: boolean
        files?: GitDiffStatFile[]
        error?: string
      }>
      // Merge a PR on GitHub via gh CLI and sync the local target branch
      prMerge: (
        worktreePath: string,
        prNumber: number
      ) => Promise<{ success: boolean; error?: string }>
      // Check if a branch has been fully merged into HEAD
      isBranchMerged: (
        worktreePath: string,
        branch: string
      ) => Promise<{ success: boolean; isMerged: boolean }>
      // Delete a local branch
      deleteBranch: (
        worktreePath: string,
        branchName: string
      ) => Promise<{ success: boolean; error?: string }>
      // List open pull requests from GitHub via gh CLI
      listPRs: (projectPath: string) => Promise<{
        success: boolean
        prs: Array<{
          number: number
          title: string
          author: string
          headRefName: string
        }>
        error?: string
      }>
      // Get file content from a specific git ref (HEAD, index)
      getRefContent: (
        worktreePath: string,
        ref: string,
        filePath: string
      ) => Promise<{
        success: boolean
        content?: string
        error?: string
      }>
      // Stage a single hunk by applying a patch to the index
      stageHunk: (
        worktreePath: string,
        patch: string
      ) => Promise<{
        success: boolean
        error?: string
      }>
      // Unstage a single hunk by reverse-applying a patch from the index
      unstageHunk: (
        worktreePath: string,
        patch: string
      ) => Promise<{
        success: boolean
        error?: string
      }>
      // Revert a single hunk in the working tree
      revertHunk: (
        worktreePath: string,
        patch: string
      ) => Promise<{
        success: boolean
        error?: string
      }>
    }
    updaterOps: {
      checkForUpdate: () => Promise<void>
      downloadUpdate: () => Promise<void>
      installUpdate: () => Promise<void>
      setChannel: (channel: string) => Promise<void>
      getVersion: () => Promise<string>
      onChecking: (callback: () => void) => () => void
      onUpdateAvailable: (
        callback: (data: { version: string; releaseNotes?: string; releaseDate?: string }) => void
      ) => () => void
      onUpdateNotAvailable: (callback: (data: { version: string }) => void) => () => void
      onProgress: (
        callback: (data: {
          percent: number
          bytesPerSecond: number
          transferred: number
          total: number
        }) => void
      ) => () => void
      onUpdateDownloaded: (
        callback: (data: { version: string; releaseNotes?: string }) => void
      ) => () => void
      onError: (callback: (data: { message: string }) => void) => () => void
    }
    connectionOps: {
      create: (
        worktreeIds: string[]
      ) => Promise<{ success: boolean; connection?: ConnectionWithMembers; error?: string }>
      delete: (connectionId: string) => Promise<{ success: boolean; error?: string }>
      addMember: (
        connectionId: string,
        worktreeId: string
      ) => Promise<{ success: boolean; member?: ConnectionMember; error?: string }>
      removeMember: (
        connectionId: string,
        worktreeId: string
      ) => Promise<{ success: boolean; connectionDeleted?: boolean; error?: string }>
      getAll: () => Promise<{
        success: boolean
        connections?: ConnectionWithMembers[]
        error?: string
      }>
      get: (
        connectionId: string
      ) => Promise<{ success: boolean; connection?: ConnectionWithMembers; error?: string }>
      openInTerminal: (connectionPath: string) => Promise<{ success: boolean; error?: string }>
      openInEditor: (connectionPath: string) => Promise<{ success: boolean; error?: string }>
      removeWorktreeFromAll: (worktreeId: string) => Promise<{ success: boolean; error?: string }>
      rename: (
        connectionId: string,
        customName: string | null
      ) => Promise<{ success: boolean; connection?: ConnectionWithMembers; error?: string }>
      setPinned: (
        connectionId: string,
        pinned: boolean
      ) => Promise<{ success: boolean; error?: string }>
      getPinned: () => Promise<ConnectionWithMembers[]>
    }
    analyticsOps: {
      track: (event: string, properties?: Record<string, unknown>) => Promise<void>
      setEnabled: (enabled: boolean) => Promise<void>
      isEnabled: () => Promise<boolean>
    }
  }

  interface GitDiffStatFile {
    path: string
    additions: number
    deletions: number
    binary: boolean
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

  // Command approval request type (for command filter system)
  interface CommandApprovalRequest {
    id: string
    sessionID: string
    toolName: string
    commandStr: string
    input: Record<string, unknown>
    patternSuggestions: string[]
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
    isSymlink?: boolean
    extension: string | null
    children?: FileTreeNode[]
  }

  // Flat file entry for search index (no tree structure)
  interface FlatFile {
    name: string
    path: string
    relativePath: string
    extension: string | null
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
