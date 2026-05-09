export interface TelegramConfig {
  botToken: string
  chatId: number
  chatName: string
  contextSize: number
}

export interface TelegramDiscoveredChat {
  chatId: number
  firstName: string
  type: 'private' | 'group' | 'supergroup'
}

export type TelegramMode = 'questions' | 'all'

export interface TelegramForwardingStatus {
  active: boolean
  sessionId: string | null
  worktreeId: string | null
  connectionId: string | null
  mode: TelegramMode | null
  health: 'ok' | 'error'
  lastError: string | null
}

export interface TelegramStartForwardingRequest {
  sessionId: string
  worktreeId: string | null
  connectionId: string | null
  mode: TelegramMode
}

export type TelegramConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error'
