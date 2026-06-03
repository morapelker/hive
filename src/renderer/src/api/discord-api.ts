import {
  DISCORD_PROVISION_PROGRESS_CHANNEL,
  DISCORD_STATUS_CHANGED_CHANNEL
} from '@shared/discord-events'
import type { ServerEvent } from '@shared/rpc/protocol'
import type {
  DiscordConfig,
  DiscordProvisionProgress,
  DiscordProvisionSummary,
  DiscordStatusChangedPayload,
  DiscordVerifyResult
} from '@shared/types/discord'
import { getRendererRpcClient } from './rpc-client'

type DiscordSetConfigResult = {
  ok: boolean
  error?: string
}

type DiscordDisableResult = {
  ok: boolean
  error?: string
}

const isDiscordProvisionProgress = (value: unknown): value is DiscordProvisionProgress =>
  typeof value === 'object' &&
  value !== null &&
  'current' in value &&
  typeof value.current === 'number' &&
  'total' in value &&
  typeof value.total === 'number' &&
  'label' in value &&
  typeof value.label === 'string' &&
  'phase' in value &&
  (value.phase === 'create' || value.phase === 'delete')

const isDiscordStatusChangedPayload = (value: unknown): value is DiscordStatusChangedPayload =>
  typeof value === 'object' &&
  value !== null &&
  'enabled' in value &&
  typeof value.enabled === 'boolean' &&
  'configured' in value &&
  typeof value.configured === 'boolean'

export const discordApi = {
  getConfig: async (): Promise<DiscordConfig | null> =>
    getRendererRpcClient().request<DiscordConfig | null>('discordOps.getConfig', {}),
  setConfig: async (config: DiscordConfig | null): Promise<DiscordSetConfigResult> =>
    getRendererRpcClient().request<DiscordSetConfigResult>('discordOps.setConfig', { config }),
  verifyToken: async (botToken: string): Promise<DiscordVerifyResult> =>
    getRendererRpcClient().request<DiscordVerifyResult>('discordOps.verifyToken', {
      botToken
    }),
  provision: async (selectedProjectIds: string[]): Promise<DiscordProvisionSummary> =>
    getRendererRpcClient().request<DiscordProvisionSummary>('discordOps.provision', {
      selectedProjectIds
    }),
  disable: async (): Promise<DiscordDisableResult> =>
    getRendererRpcClient().request<DiscordDisableResult>('discordOps.disable', {}),
  onProvisionProgress: (callback: (progress: DiscordProvisionProgress) => void): (() => void) =>
    getRendererRpcClient().subscribe(
      DISCORD_PROVISION_PROGRESS_CHANNEL,
      (event: ServerEvent) => {
        if (isDiscordProvisionProgress(event.payload)) {
          callback(event.payload)
        }
      }
    ),
  onStatusChanged: (callback: (status: DiscordStatusChangedPayload) => void): (() => void) =>
    getRendererRpcClient().subscribe(DISCORD_STATUS_CHANGED_CHANNEL, (event: ServerEvent) => {
      if (isDiscordStatusChangedPayload(event.payload)) {
        callback(event.payload)
      }
    })
}
