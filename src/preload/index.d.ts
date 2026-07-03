export {}

declare global {
  interface LocalEnvironmentBootstrap {
    httpBaseUrl: string
    wsBaseUrl: string
    bootstrapToken: string
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

  type SessionStatusType =
    | 'working'
    | 'planning'
    | 'answering'
    | 'permission'
    | 'command_approval'
    | 'unread'
    | 'completed'
    | 'plan_ready'

  interface DiffComment {
    id: string
    worktree_id: string
    file_path: string
    line_start: number
    line_end: number | null
    anchor_text: string | null
    anchor_context_before: string | null
    anchor_context_after: string | null
    body: string
    is_outdated: boolean
    created_at: string
    updated_at: string
  }

  interface Window {
    desktopBridge: {
      getLocalEnvironmentBootstrap: () => Promise<LocalEnvironmentBootstrap | null>
      getPathForFile: (file: File) => string
      startHiveEnterpriseLogin: (serverUrl: string) => Promise<{ token: string }>
      windowMinimize: () => Promise<void>
      windowMaximize: () => Promise<void>
      windowClose: () => Promise<void>
      windowIsMaximized: () => Promise<boolean>
    }
  }

  // Message part type for prompt API (text + file attachments)
  type MessagePart =
    | { type: 'text'; text: string }
    | { type: 'file'; mime: string; url: string; filename?: string }

  // OpenCode command type (slash commands)
  interface OpenCodeCommand {
    name: string
    description?: string
    template: string
    agent?: string
    model?: string
    source?: 'command' | 'mcp' | 'skill' | 'codex'
    path?: string
    scope?: 'user' | 'repo' | 'system' | 'admin'
    enabled?: boolean
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
}
