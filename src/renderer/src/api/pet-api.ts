import {
  PET_JUMP_TO_WORKTREE_CHANNEL,
  PET_SETTINGS_UPDATED_CHANNEL,
  PET_STATUS_CHANNEL
} from '@shared/pet-events'
import type { ServerEvent } from '@shared/rpc/protocol'
import type { PetManifest, PetPosition, PetSettings, PetStatusPayload } from '@shared/types/pet'
import { getRendererRpcClient } from './rpc-client'

export interface PetConfig {
  readonly settings: PetSettings
  readonly position: PetPosition
  readonly manifest: PetManifest
}

const isPetStatusPayload = (value: unknown): value is PetStatusPayload =>
  typeof value === 'object' &&
  value !== null &&
  'state' in value &&
  typeof value.state === 'string' &&
  ['idle', 'working', 'question', 'permission', 'plan_ready'].includes(value.state) &&
  'sourceWorktreeId' in value &&
  (typeof value.sourceWorktreeId === 'string' || value.sourceWorktreeId === null)

const isPetSettings = (value: unknown): value is PetSettings =>
  typeof value === 'object' &&
  value !== null &&
  'enabled' in value &&
  typeof value.enabled === 'boolean' &&
  'petId' in value &&
  typeof value.petId === 'string' &&
  'size' in value &&
  (value.size === 'S' || value.size === 'M' || value.size === 'L') &&
  'opacity' in value &&
  typeof value.opacity === 'number' &&
  Number.isFinite(value.opacity) &&
  'hasHatched' in value &&
  typeof value.hasHatched === 'boolean'

const isPetJumpToWorktreePayload = (value: unknown): value is { worktreeId: string } =>
  typeof value === 'object' &&
  value !== null &&
  'worktreeId' in value &&
  typeof value.worktreeId === 'string'

export const petApi = {
  show: async (): Promise<void> => getRendererRpcClient().request<void>('petOps.show', {}),
  hide: async (): Promise<void> => getRendererRpcClient().request<void>('petOps.hide', {}),
  focusMain: async (payload: { worktreeId: string | null }): Promise<void> =>
    getRendererRpcClient().request<void>('petOps.focusMain', payload),
  setIgnoreMouse: (ignore: boolean): void => {
    void getRendererRpcClient().request<void>('petOps.setIgnoreMouse', { ignore })
  },
  beginPointerInteraction: (): void => {
    void getRendererRpcClient().request<void>('petOps.beginPointerInteraction', {})
  },
  endPointerInteraction: (): void => {
    void getRendererRpcClient().request<void>('petOps.endPointerInteraction', {})
  },
  move: (position: PetPosition): void => {
    void getRendererRpcClient().request<void>('petOps.move', position)
  },
  publishStatus: (payload: PetStatusPayload): void => {
    void getRendererRpcClient().request<void>('petOps.publishStatus', payload)
  },
  getConfig: async (): Promise<PetConfig> =>
    getRendererRpcClient().request<PetConfig>('petOps.getConfig', {}),
  getCurrentStatus: async (): Promise<PetStatusPayload> =>
    getRendererRpcClient().request<PetStatusPayload>('petOps.getCurrentStatus', {}),
  onStatus: (callback: (payload: PetStatusPayload) => void): (() => void) =>
    getRendererRpcClient().subscribe(PET_STATUS_CHANNEL, (event: ServerEvent) => {
      if (isPetStatusPayload(event.payload)) {
        callback(event.payload)
      }
    }),
  onSettingsUpdated: (callback: (settings: PetSettings) => void): (() => void) =>
    getRendererRpcClient().subscribe(PET_SETTINGS_UPDATED_CHANNEL, (event: ServerEvent) => {
      if (isPetSettings(event.payload)) {
        callback(event.payload)
      }
    }),
  onJumpToWorktree: (callback: (payload: { worktreeId: string }) => void): (() => void) =>
    getRendererRpcClient().subscribe(PET_JUMP_TO_WORKTREE_CHANNEL, (event: ServerEvent) => {
      if (isPetJumpToWorktreePayload(event.payload)) {
        callback(event.payload)
      }
    }),
  markHatched: (): void => {
    void getRendererRpcClient().request<void>('petOps.markHatched', {})
  },
  updateSettings: (partial: Partial<PetSettings>): void => {
    void getRendererRpcClient().request<void>('petOps.updateSettings', partial)
  }
}
