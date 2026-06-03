import { EDIT_PASTE_CHANNEL } from '../../shared/edit-events'
import { publishDesktopBackendEvent } from '../desktop/backend-event-publisher'

export const emitEditPaste = (text: string): void => {
  void publishDesktopBackendEvent(EDIT_PASTE_CHANNEL, text)
}
