import {
  TELEGRAM_PLAN_IMPLEMENT_REQUESTED_CHANNEL,
  TELEGRAM_STATUS_CHANGED_CHANNEL,
  type TelegramPlanImplementRequestedPayload
} from '@shared/telegram-events'
import type { ServerEvent } from '@shared/rpc/protocol'
import type {
  TelegramConfig,
  TelegramDiscoveredChat,
  TelegramForwardingStatus,
  TelegramStartForwardingRequest
} from '@shared/types/telegram'
import { getRendererRpcClient } from './rpc-client'

type TelegramStartForwardingResult = {
  ok: boolean
  status: TelegramForwardingStatus
  error?: string
}

type TelegramSetConfigResult = {
  ok: boolean
  error?: string
}

type TelegramVerifyTokenResult = {
  ok: boolean
  botUsername?: string
  error?: string
}

type TelegramStopForwardingResult = {
  status: TelegramForwardingStatus
}

const isTelegramForwardingStatus = (value: unknown): value is TelegramForwardingStatus =>
  typeof value === 'object' &&
  value !== null &&
  'active' in value &&
  typeof value.active === 'boolean' &&
  'sessionId' in value &&
  (typeof value.sessionId === 'string' || value.sessionId === null) &&
  'worktreeId' in value &&
  (typeof value.worktreeId === 'string' || value.worktreeId === null) &&
  'connectionId' in value &&
  (typeof value.connectionId === 'string' || value.connectionId === null) &&
  'mode' in value &&
  (value.mode === 'questions' || value.mode === 'all' || value.mode === null) &&
  'health' in value &&
  (value.health === 'ok' || value.health === 'error') &&
  'lastError' in value &&
  (typeof value.lastError === 'string' || value.lastError === null)

const isTelegramPlanImplementRequestedPayload = (
  value: unknown
): value is TelegramPlanImplementRequestedPayload =>
  typeof value === 'object' &&
  value !== null &&
  'sessionId' in value &&
  typeof value.sessionId === 'string' &&
  'worktreeId' in value &&
  (typeof value.worktreeId === 'string' || value.worktreeId === null) &&
  'connectionId' in value &&
  (typeof value.connectionId === 'string' || value.connectionId === null) &&
  'requestId' in value &&
  typeof value.requestId === 'string' &&
  'plan' in value &&
  typeof value.plan === 'string'

export const telegramApi = {
  getConfig: async (): Promise<TelegramConfig | null> =>
    getRendererRpcClient().request<TelegramConfig | null>('telegramOps.getConfig', {}),
  setConfig: async (config: TelegramConfig | null): Promise<TelegramSetConfigResult> =>
    getRendererRpcClient().request<TelegramSetConfigResult>('telegramOps.setConfig', { config }),
  verifyToken: async (botToken: string): Promise<TelegramVerifyTokenResult> =>
    getRendererRpcClient().request<TelegramVerifyTokenResult>('telegramOps.verifyToken', {
      botToken
    }),
  discoverChats: async (config?: TelegramConfig | null): Promise<TelegramDiscoveredChat[]> =>
    getRendererRpcClient().request<TelegramDiscoveredChat[]>('telegramOps.discoverChats', {
      config
    }),
  sendTestMessage: async (): Promise<TelegramSetConfigResult> =>
    getRendererRpcClient().request<TelegramSetConfigResult>('telegramOps.sendTestMessage', {}),
  getStatus: async (): Promise<TelegramForwardingStatus> =>
    getRendererRpcClient().request<TelegramForwardingStatus>('telegramOps.getStatus', {}),
  startForwarding: async (
    params: TelegramStartForwardingRequest
  ): Promise<TelegramStartForwardingResult> =>
    getRendererRpcClient().request<TelegramStartForwardingResult>('telegramOps.startForwarding', {
      params
    }),
  stopForwarding: async (): Promise<TelegramStopForwardingResult> =>
    getRendererRpcClient().request<TelegramStopForwardingResult>('telegramOps.stopForwarding', {}),
  onStatusChanged: (callback: (status: TelegramForwardingStatus) => void): (() => void) =>
    getRendererRpcClient().subscribe(TELEGRAM_STATUS_CHANGED_CHANNEL, (event: ServerEvent) => {
      if (isTelegramForwardingStatus(event.payload)) {
        callback(event.payload)
      }
    }),
  onPlanImplementRequested: (
    callback: (payload: TelegramPlanImplementRequestedPayload) => void
  ): (() => void) =>
    getRendererRpcClient().subscribe(
      TELEGRAM_PLAN_IMPLEMENT_REQUESTED_CHANNEL,
      (event: ServerEvent) => {
        if (isTelegramPlanImplementRequestedPayload(event.payload)) {
          callback(event.payload)
        }
      }
    )
}
