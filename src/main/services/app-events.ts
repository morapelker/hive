import { WINDOW_FOCUSED_CHANNEL } from '../../shared/app-events'
import { publishDesktopBackendEvent } from '../desktop/backend-manager'

export const emitWindowFocused = (): void => {
  void publishDesktopBackendEvent(WINDOW_FOCUSED_CHANNEL, {})
}
