import {
  CLOSE_SESSION_SHORTCUT_CHANNEL,
  FILE_SEARCH_SHORTCUT_CHANNEL,
  NEW_SESSION_SHORTCUT_CHANNEL,
  QUIT_CONFIRMATION_HIDE_CHANNEL,
  QUIT_CONFIRMATION_SHOW_CHANNEL
} from '../../shared/shortcut-events'
import { publishDesktopBackendEvent } from '../desktop/backend-manager'

export const emitNewSessionShortcut = (): void => {
  void publishDesktopBackendEvent(NEW_SESSION_SHORTCUT_CHANNEL, {})
}

export const emitCloseSessionShortcut = (): void => {
  void publishDesktopBackendEvent(CLOSE_SESSION_SHORTCUT_CHANNEL, {})
}

export const emitFileSearchShortcut = (): void => {
  void publishDesktopBackendEvent(FILE_SEARCH_SHORTCUT_CHANNEL, {})
}

export const emitQuitConfirmationShow = (): void => {
  void publishDesktopBackendEvent(QUIT_CONFIRMATION_SHOW_CHANNEL, {})
}

export const emitQuitConfirmationHide = (): void => {
  void publishDesktopBackendEvent(QUIT_CONFIRMATION_HIDE_CHANNEL, {})
}
