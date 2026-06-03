import { WINDOW_FOCUSED_CHANNEL } from '../../shared/app-events'
import { publishDesktopBackendEvent } from '../desktop/backend-event-publisher'

export const emitWindowFocused = (): void => {
  void publishDesktopBackendEvent(WINDOW_FOCUSED_CHANNEL, {})
}
