import { EDIT_PASTE_CHANNEL } from '../../shared/edit-events'
import { publishDesktopBackendEvent } from '../desktop/backend-manager'

export const emitEditPaste = (text: string): void => {
  void publishDesktopBackendEvent(EDIT_PASTE_CHANNEL, text)
}
