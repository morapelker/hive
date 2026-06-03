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
} from '../../shared/updater-events'
import { publishDesktopBackendEvent } from '../desktop/backend-event-publisher'

export const emitUpdaterChecking = (): void => {
  void publishDesktopBackendEvent(UPDATER_CHECKING_CHANNEL, {})
}

export const emitUpdaterAvailable = (payload: UpdaterAvailablePayload): void => {
  void publishDesktopBackendEvent(UPDATER_AVAILABLE_CHANNEL, payload)
}

export const emitUpdaterNotAvailable = (payload: UpdaterNotAvailablePayload): void => {
  void publishDesktopBackendEvent(UPDATER_NOT_AVAILABLE_CHANNEL, payload)
}

export const emitUpdaterProgress = (payload: UpdaterProgressPayload): void => {
  void publishDesktopBackendEvent(UPDATER_PROGRESS_CHANNEL, payload)
}

export const emitUpdaterDownloaded = (payload: UpdaterDownloadedPayload): void => {
  void publishDesktopBackendEvent(UPDATER_DOWNLOADED_CHANNEL, payload)
}

export const emitUpdaterError = (payload: UpdaterErrorPayload): void => {
  void publishDesktopBackendEvent(UPDATER_ERROR_CHANNEL, payload)
}
