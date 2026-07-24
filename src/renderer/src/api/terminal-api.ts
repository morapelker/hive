import { getRendererRpcClient } from './rpc-client'
import type {
  TerminalGhosttyAvailabilityResult,
  TerminalGhosttyCreateSurfaceOptions,
  TerminalGhosttyCreateSurfaceResult,
  TerminalGhosttyFocusDiagnosticsResult,
  TerminalGhosttyInitResult,
  TerminalGhosttyKeyEvent,
  TerminalGhosttyRect
} from '@shared/desktop-command'
import type { ServerEvent } from '@shared/rpc/protocol'
import type { Envelope } from '@shared/types/ipc-envelope'
import type { GhosttyTerminalConfig } from '@shared/types/terminal'
import {
  CLAUDE_CLI_BACKGROUND_WORK_CHANNEL,
  isClaudeCliBackgroundWorkPayload,
  type ClaudeCliBackgroundWorkPayload
} from '@shared/types/claude-cli-background-work'

export type { ClaudeCliBackgroundWorkPayload }

export type ClaudeCliSessionStatusType =
  | 'working'
  | 'planning'
  | 'answering'
  | 'permission'
  | 'command_approval'
  | 'unread'
  | 'completed'
  | 'plan_ready'

export interface ClaudeCliStatusPayload {
  readonly sessionId: string
  readonly status: ClaudeCliSessionStatusType
  readonly metadata?: {
    readonly reason?: string
    readonly hookEventName?: string
    readonly hookPath?: string
    readonly toolName?: string
    readonly plan?: string
    readonly taskNotification?: boolean
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isClaudeCliStatusPayload = (value: unknown): value is ClaudeCliStatusPayload => {
  if (!isRecord(value)) return false
  if (typeof value.sessionId !== 'string') return false
  if (
    ![
      'working',
      'planning',
      'answering',
      'permission',
      'command_approval',
      'unread',
      'completed',
      'plan_ready'
    ].includes(typeof value.status === 'string' ? value.status : '')
  ) {
    return false
  }

  return value.metadata === undefined || isRecord(value.metadata)
}

export const terminalApi = {
  create: async (
    terminalId: string,
    cwd: string,
    shell?: string
  ): Promise<Envelope<{ success: boolean; cols?: number; rows?: number; error?: string }>> => {
    const result = await getRendererRpcClient().request<{
      success: boolean
      cols?: number
      rows?: number
      error?: string
    }>('terminalOps.create', { terminalId, cwd, shell })
    return { success: true, value: result }
  },
  createClaudeCli: async (
    sessionId: string,
    opts?: { pendingPrompt?: string | null }
  ): Promise<Envelope<{ success: boolean; cols?: number; rows?: number; error?: string }>> => {
    const result = await getRendererRpcClient().request<{
      success: boolean
      cols?: number
      rows?: number
      error?: string
    }>('terminalOps.createClaudeCli', { sessionId, opts })
    return { success: true, value: result }
  },
  setClaudeCliPlanAutoApprove: async (
    sessionId: string,
    enabled: boolean
  ): Promise<Envelope<{ success: boolean; error?: string }>> => {
    const result = await getRendererRpcClient().request<{
      success: boolean
      error?: string
    }>('terminalOps.setClaudeCliPlanAutoApprove', { sessionId, enabled })
    return { success: true, value: result }
  },
  sendClaudeCliPrompt: async (
    sessionId: string,
    prompt: string
  ): Promise<Envelope<{ delivered: boolean }>> => {
    try {
      await getRendererRpcClient().request<void>('terminalOps.write', {
        terminalId: sessionId,
        data: `\x1b[200~${prompt}\x1b[201~\r`
      })
      return { success: true, value: { delivered: true } }
    } catch {
      return { success: true, value: { delivered: false } }
    }
  },
  destroy: async (terminalId: string): Promise<Envelope<void>> => {
    await getRendererRpcClient().request<void>('terminalOps.destroy', { terminalId })
    return { success: true, value: undefined }
  },
  write: (terminalId: string, data: string): void => {
    void getRendererRpcClient()
      .request<void>('terminalOps.write', { terminalId, data })
      .catch(() => undefined)
  },
  resize: async (terminalId: string, cols: number, rows: number): Promise<Envelope<void>> => {
    await getRendererRpcClient().request<void>('terminalOps.resize', { terminalId, cols, rows })
    return { success: true, value: undefined }
  },
  onData: (terminalId: string, callback: (data: string) => void): (() => void) => {
    return getRendererRpcClient().subscribe(`terminal:data:${terminalId}`, (event: ServerEvent) => {
      if (typeof event.payload === 'string') callback(event.payload)
    })
  },
  onExit: (terminalId: string, callback: (code: number) => void): (() => void) => {
    return getRendererRpcClient().subscribe(`terminal:exit:${terminalId}`, (event: ServerEvent) => {
      if (typeof event.payload === 'number') callback(event.payload)
    })
  },
  onClaudeSessionId: (
    sessionId: string,
    callback: (claudeSessionId: string) => void
  ): (() => void) => {
    return getRendererRpcClient().subscribe(
      `terminal:claude-session-id:${sessionId}`,
      (event: ServerEvent) => {
        if (typeof event.payload === 'string') callback(event.payload)
      }
    )
  },
  onClaudeCliStatus: (callback: (payload: ClaudeCliStatusPayload) => void): (() => void) => {
    return getRendererRpcClient().subscribe('claude-cli:status', (event: ServerEvent) => {
      if (isClaudeCliStatusPayload(event.payload)) callback(event.payload)
    })
  },
  onClaudeCliBackgroundWork: (
    callback: (payload: ClaudeCliBackgroundWorkPayload) => void
  ): (() => void) => {
    return getRendererRpcClient().subscribe(
      CLAUDE_CLI_BACKGROUND_WORK_CHANNEL,
      (event: ServerEvent) => {
        if (isClaudeCliBackgroundWorkPayload(event.payload)) callback(event.payload)
      }
    )
  },
  ghosttyPasteText: async (terminalId: string, text: string): Promise<Envelope<void>> => {
    await getRendererRpcClient().request<void>('terminalOps.ghosttyPasteText', { terminalId, text })
    return { success: true, value: undefined }
  },
  ghosttyFocusDiagnostics: async (): Promise<TerminalGhosttyFocusDiagnosticsResult> => {
    return getRendererRpcClient().request<TerminalGhosttyFocusDiagnosticsResult>(
      'terminalOps.ghosttyFocusDiagnostics',
      {}
    )
  },
  getConfig: async (): Promise<Envelope<GhosttyTerminalConfig>> => {
    const config = await getRendererRpcClient().request<GhosttyTerminalConfig>(
      'terminalOps.getConfig',
      {}
    )
    return { success: true, value: config }
  },
  /** Force a fresh read of the Ghostty config (used by the settings "Sync from Ghostty" toggle). */
  resyncGhosttyConfig: async (): Promise<Envelope<GhosttyTerminalConfig>> => {
    const config = await getRendererRpcClient().request<GhosttyTerminalConfig>(
      'terminalOps.resyncGhosttyConfig',
      {}
    )
    return { success: true, value: config }
  },
  /**
   * Fire-and-forget: persist renderer-side terminal diagnostics (font
   * resolution, renderer fallback, fitted dimensions) into the main-process
   * log so support reports from affected machines include them.
   */
  logClientDiagnostics: (event: string, data: Record<string, unknown>): void => {
    void getRendererRpcClient()
      .request<void>('terminalOps.logDiagnostics', { event, data })
      .catch(() => {})
  },
  ghosttyIsAvailable: async (): Promise<TerminalGhosttyAvailabilityResult> => {
    return getRendererRpcClient().request<TerminalGhosttyAvailabilityResult>(
      'terminalOps.ghosttyIsAvailable',
      {}
    )
  },
  ghosttyInit: async (): Promise<TerminalGhosttyInitResult> => {
    return getRendererRpcClient().request<TerminalGhosttyInitResult>('terminalOps.ghosttyInit', {})
  },
  ghosttyCreateSurface: async (
    terminalId: string,
    rect: TerminalGhosttyRect,
    opts?: TerminalGhosttyCreateSurfaceOptions
  ): Promise<TerminalGhosttyCreateSurfaceResult> => {
    return getRendererRpcClient().request<TerminalGhosttyCreateSurfaceResult>(
      'terminalOps.ghosttyCreateSurface',
      {
        terminalId,
        rect,
        opts
      }
    )
  },
  ghosttyDestroySurface: async (terminalId: string): Promise<void> => {
    return getRendererRpcClient().request<void>('terminalOps.ghosttyDestroySurface', {
      terminalId
    })
  },
  ghosttyShutdown: async (): Promise<void> => {
    return getRendererRpcClient().request<void>('terminalOps.ghosttyShutdown', {})
  },
  ghosttySetFocus: async (terminalId: string, focused: boolean): Promise<void> => {
    return getRendererRpcClient().request<void>('terminalOps.ghosttySetFocus', {
      terminalId,
      focused
    })
  },
  ghosttySetFrame: async (terminalId: string, rect: TerminalGhosttyRect): Promise<void> => {
    return getRendererRpcClient().request<void>('terminalOps.ghosttySetFrame', {
      terminalId,
      rect
    })
  },
  ghosttySetSize: async (terminalId: string, width: number, height: number): Promise<void> => {
    return getRendererRpcClient().request<void>('terminalOps.ghosttySetSize', {
      terminalId,
      width,
      height
    })
  },
  ghosttyKeyEvent: async (terminalId: string, event: TerminalGhosttyKeyEvent): Promise<boolean> => {
    return getRendererRpcClient().request<boolean>('terminalOps.ghosttyKeyEvent', {
      terminalId,
      event
    })
  },
  ghosttyMouseButton: async (
    terminalId: string,
    state: number,
    button: number,
    mods: number
  ): Promise<void> => {
    return getRendererRpcClient().request<void>('terminalOps.ghosttyMouseButton', {
      terminalId,
      state,
      button,
      mods
    })
  },
  ghosttyMousePos: async (
    terminalId: string,
    x: number,
    y: number,
    mods: number
  ): Promise<void> => {
    return getRendererRpcClient().request<void>('terminalOps.ghosttyMousePos', {
      terminalId,
      x,
      y,
      mods
    })
  },
  ghosttyMouseScroll: async (
    terminalId: string,
    dx: number,
    dy: number,
    mods: number
  ): Promise<void> => {
    return getRendererRpcClient().request<void>('terminalOps.ghosttyMouseScroll', {
      terminalId,
      dx,
      dy,
      mods
    })
  }
}
