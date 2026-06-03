import { SETTINGS_UPDATED_CHANNEL } from '../../shared/settings-events'
import { publishDesktopBackendEvent } from '../desktop/backend-event-publisher'

export const emitSettingsUpdated = (payload: unknown): void => {
  void publishDesktopBackendEvent(SETTINGS_UPDATED_CHANNEL, payload)
}
