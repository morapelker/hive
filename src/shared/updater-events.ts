export const UPDATER_CHECKING_CHANNEL = 'updater:checking'
export const UPDATER_AVAILABLE_CHANNEL = 'updater:available'
export const UPDATER_NOT_AVAILABLE_CHANNEL = 'updater:not-available'
export const UPDATER_PROGRESS_CHANNEL = 'updater:progress'
export const UPDATER_DOWNLOADED_CHANNEL = 'updater:downloaded'
export const UPDATER_ERROR_CHANNEL = 'updater:error'

export interface UpdaterAvailablePayload {
  readonly version: string
  readonly releaseNotes?: unknown
  readonly releaseDate?: string
  readonly isManualCheck?: boolean
}

export interface UpdaterNotAvailablePayload {
  readonly version: string
  readonly isManualCheck?: boolean
}

export interface UpdaterProgressPayload {
  readonly percent: number
  readonly bytesPerSecond: number
  readonly transferred: number
  readonly total: number
}

export interface UpdaterDownloadedPayload {
  readonly version: string
  readonly releaseNotes?: unknown
}

export interface UpdaterErrorPayload {
  readonly message: string
  readonly isManualCheck?: boolean
}
