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

  interface VoiceDesktopBridge {
    getStatus: () => Promise<import('../shared/types/voice').VoiceStatus>
    updateSettings: (settings: import('../shared/types/voice').VoiceSettings) => Promise<void>
    toggle: () => Promise<void>
    cancel: () => Promise<void>
    downloadModel: (modelId: string) => Promise<void>
    cancelDownload: (modelId: string) => Promise<void>
    deleteModel: (modelId: string) => Promise<void>
    requestMicrophoneAccess: () => Promise<import('../shared/types/voice').VoiceMicPermission>
    openMicrophoneSettings: () => Promise<void>
    listHistory: (options: {
      limit: number
      offset?: number
      query?: string
    }) => Promise<import('../shared/types/voice').VoiceHistoryEntry[]>
    countHistory: (query?: string) => Promise<number>
    deleteHistory: (id: string) => Promise<boolean>
    clearHistory: () => Promise<number>
    onStatus: (callback: (status: import('../shared/types/voice').VoiceStatus) => void) => () => void
    onResult: (
      callback: (result: import('../shared/types/voice').VoiceDictationResult) => void
    ) => () => void
  }

  interface VoiceHudBridge {
    ready: () => void
    clickStop: () => void
    clickCancel: () => void
    captureStarted: () => void
    captureError: (message: string) => void
    submitAudio: (payload: {
      samples: Float32Array
      sampleRate: number
      durationMs: number
    }) => Promise<void>
    getSounds: () => Promise<{ start: Uint8Array | null; stop: Uint8Array | null }>
    onState: (callback: (state: import('../shared/types/voice').VoiceHudState) => void) => () => void
    onSound: (callback: (name: 'start' | 'stop') => void) => () => void
    /** Options are only present with test clips on (dev/test); otherwise the mic is used. */
    onCaptureStart: (
      callback: (options?: import('../shared/types/voice').VoiceCaptureStartOptions) => void
    ) => () => void
    /** The test clip finished playing (dev/test only). */
    testClipEnded: () => void
    onCaptureStop: (callback: () => void) => () => void
    onCaptureCancel: (callback: () => void) => () => void
  }

  /** Dev/test only: present when launched with TEDOOO_CODE_VOICE_TEST_CLIPS. */
  interface VoiceTestBridge {
    status: () => Promise<import('../shared/types/voice').VoiceTestClipsStatus>
    listClips: () => Promise<import('../shared/types/voice').VoiceTestClipInfo[]>
    selectClip: (
      name: string | null,
      options?: import('../shared/types/voice').VoiceTestSelectOptions
    ) => Promise<import('../shared/types/voice').VoiceTestClipsStatus>
    /** Select a clip and start a dictation (the hotkey's toggle). */
    start: (
      options: { clip: string } & import('../shared/types/voice').VoiceTestSelectOptions
    ) => Promise<import('../shared/types/voice').VoiceTestClipsStatus>
    /** Stop the running dictation (the hotkey's toggle). */
    stop: () => Promise<import('../shared/types/voice').VoiceTestClipsStatus>
  }

  interface Window {
    desktopBridge: {
      /** Voice dictation (main window side). Undefined outside the Electron shell. */
      voice?: VoiceDesktopBridge
      /** Voice dictation (floating pill window side). */
      voiceHud?: VoiceHudBridge
      /** Voice test clips (dev/test only; see VoiceTestBridge). */
      voiceTest?: VoiceTestBridge
      getLocalEnvironmentBootstrap: () => Promise<LocalEnvironmentBootstrap | null>
      getPathForFile: (file: File) => string
      startHiveEnterpriseLogin: (serverUrl: string) => Promise<{ token: string }>
      /** Linux-only: handlers registered only when process.platform === 'linux'. */
      windowMinimize?: () => Promise<void>
      /** Linux-only: handlers registered only when process.platform === 'linux'. */
      windowMaximize?: () => Promise<void>
      windowClose: () => Promise<void>
      /** Linux-only: handlers registered only when process.platform === 'linux'. */
      windowIsMaximized?: () => Promise<boolean>
      setTitleBarOverlay?: (options: { color: string; symbolColor: string }) => Promise<void>
      onWindowMaximizedChanged: (callback: (isMaximized: boolean) => void) => () => void
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
