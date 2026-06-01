import {
  UPDATER_AVAILABLE_CHANNEL,
  UPDATER_CHECKING_CHANNEL,
  UPDATER_DOWNLOADED_CHANNEL,
  UPDATER_ERROR_CHANNEL,
  UPDATER_NOT_AVAILABLE_CHANNEL,
  UPDATER_PROGRESS_CHANNEL,
  type UpdaterAvailablePayload,
  type UpdaterDownloadedPayload,
  type UpdaterErrorPayload,
  type UpdaterNotAvailablePayload,
  type UpdaterProgressPayload
} from '@shared/updater-events'
import type { ServerEvent } from '@shared/rpc/protocol'
import { getRendererRpcClient } from './rpc-client'

const isUpdaterAvailablePayload = (value: unknown): value is UpdaterAvailablePayload =>
  typeof value === 'object' &&
  value !== null &&
  'version' in value &&
  typeof value.version === 'string' &&
  (!('releaseDate' in value) ||
    value.releaseDate === undefined ||
    typeof value.releaseDate === 'string') &&
  (!('isManualCheck' in value) ||
    value.isManualCheck === undefined ||
    typeof value.isManualCheck === 'boolean')

const isUpdaterNotAvailablePayload = (value: unknown): value is UpdaterNotAvailablePayload =>
  typeof value === 'object' &&
  value !== null &&
  'version' in value &&
  typeof value.version === 'string' &&
  (!('isManualCheck' in value) ||
    value.isManualCheck === undefined ||
    typeof value.isManualCheck === 'boolean')

const isUpdaterProgressPayload = (value: unknown): value is UpdaterProgressPayload =>
  typeof value === 'object' &&
  value !== null &&
  'percent' in value &&
  typeof value.percent === 'number' &&
  'bytesPerSecond' in value &&
  typeof value.bytesPerSecond === 'number' &&
  'transferred' in value &&
  typeof value.transferred === 'number' &&
  'total' in value &&
  typeof value.total === 'number'

const isUpdaterDownloadedPayload = (value: unknown): value is UpdaterDownloadedPayload =>
  typeof value === 'object' &&
  value !== null &&
  'version' in value &&
  typeof value.version === 'string'

const isUpdaterErrorPayload = (value: unknown): value is UpdaterErrorPayload =>
  typeof value === 'object' &&
  value !== null &&
  'message' in value &&
  typeof value.message === 'string' &&
  (!('isManualCheck' in value) ||
    value.isManualCheck === undefined ||
    typeof value.isManualCheck === 'boolean')

export const updaterApi = {
  getVersion: async (): Promise<string> => {
    return getRendererRpcClient().request<string>('updaterOps.getVersion', {})
  },
  checkForUpdate: async (options?: { manual?: boolean }): Promise<void> => {
    return getRendererRpcClient().request<void>('updaterOps.checkForUpdate', options ?? {})
  },
  setChannel: async (channel: 'stable' | 'canary'): Promise<void> => {
    return getRendererRpcClient().request<void>('updaterOps.setChannel', { channel })
  },
  downloadUpdate: async (): Promise<void> => {
    return getRendererRpcClient().request<void>('updaterOps.downloadUpdate', {})
  },
  installUpdate: async (): Promise<void> => {
    return getRendererRpcClient().request<void>('updaterOps.installUpdate', {})
  },
  onChecking: (callback: () => void): (() => void) => {
    return getRendererRpcClient().subscribe(UPDATER_CHECKING_CHANNEL, () => {
      callback()
    })
  },
  onUpdateAvailable: (callback: (data: UpdaterAvailablePayload) => void): (() => void) => {
    return getRendererRpcClient().subscribe(UPDATER_AVAILABLE_CHANNEL, (event: ServerEvent) => {
      if (isUpdaterAvailablePayload(event.payload)) {
        callback(event.payload)
      }
    })
  },
  onUpdateNotAvailable: (callback: (data: UpdaterNotAvailablePayload) => void): (() => void) => {
    return getRendererRpcClient().subscribe(UPDATER_NOT_AVAILABLE_CHANNEL, (event: ServerEvent) => {
      if (isUpdaterNotAvailablePayload(event.payload)) {
        callback(event.payload)
      }
    })
  },
  onProgress: (callback: (data: UpdaterProgressPayload) => void): (() => void) => {
    return getRendererRpcClient().subscribe(UPDATER_PROGRESS_CHANNEL, (event: ServerEvent) => {
      if (isUpdaterProgressPayload(event.payload)) {
        callback(event.payload)
      }
    })
  },
  onUpdateDownloaded: (callback: (data: UpdaterDownloadedPayload) => void): (() => void) => {
    return getRendererRpcClient().subscribe(UPDATER_DOWNLOADED_CHANNEL, (event: ServerEvent) => {
      if (isUpdaterDownloadedPayload(event.payload)) {
        callback(event.payload)
      }
    })
  },
  onError: (callback: (data: UpdaterErrorPayload) => void): (() => void) => {
    return getRendererRpcClient().subscribe(UPDATER_ERROR_CHANNEL, (event: ServerEvent) => {
      if (isUpdaterErrorPayload(event.payload)) {
        callback(event.payload)
      }
    })
  }
}
