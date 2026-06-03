import {
  NOTIFICATION_NAVIGATE_CHANNEL,
  type NotificationNavigatePayload
} from '../../shared/notification-events'
import { publishDesktopBackendEvent } from '../desktop/backend-event-publisher'

export const emitNotificationNavigate = (payload: NotificationNavigatePayload): void => {
  void publishDesktopBackendEvent(NOTIFICATION_NAVIGATE_CHANNEL, payload)
}
