export interface OpenCodeStreamEvent {
  type: string
  sessionId: string
  data: unknown
  childSessionId?: string
  statusPayload?: {
    type: 'idle' | 'busy' | 'retry'
    attempt?: number
    message?: string
    next?: number
  }
}

export interface OpenCodeCommand {
  name: string
  description?: string
  template: string
  agent?: string
  model?: string
  source?: 'command' | 'mcp' | 'skill'
  subtask?: boolean
  hints?: string[]
}

export interface PermissionRequest {
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

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'file'; mime: string; url: string; filename?: string }
