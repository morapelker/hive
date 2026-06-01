import { isMenuActionChannel, type MenuActionChannel } from '../../shared/menu-events'
import { publishDesktopBackendEvent } from '../desktop/backend-manager'

export const emitMenuAction = (channel: MenuActionChannel, ...args: unknown[]): void => {
  void publishDesktopBackendEvent(channel, args.length === 0 ? {} : args)
}

export const emitMenuActionIfKnown = (channel: string, ...args: unknown[]): boolean => {
  if (!isMenuActionChannel(channel)) return false
  emitMenuAction(channel, ...args)
  return true
}
