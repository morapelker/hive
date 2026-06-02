import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  CLOSE_SESSION_SHORTCUT_CHANNEL,
  FILE_SEARCH_SHORTCUT_CHANNEL,
  NEW_SESSION_SHORTCUT_CHANNEL,
  QUIT_CONFIRMATION_HIDE_CHANNEL,
  QUIT_CONFIRMATION_SHOW_CHANNEL
} from '../../shared/shortcut-events'

const mocks = vi.hoisted(() => ({
  publishDesktopBackendEvent: vi.fn()
}))

vi.mock('../desktop/backend-manager', () => ({
  publishDesktopBackendEvent: mocks.publishDesktopBackendEvent
}))

import {
  emitCloseSessionShortcut,
  emitFileSearchShortcut,
  emitNewSessionShortcut,
  emitQuitConfirmationHide,
  emitQuitConfirmationShow
} from './shortcut-events'

describe('shortcut events', () => {
  beforeEach(() => {
    mocks.publishDesktopBackendEvent.mockClear()
  })

  it('publishes the new-session shortcut event without a window dependency', () => {
    emitNewSessionShortcut()

    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(NEW_SESSION_SHORTCUT_CHANNEL, {})
  })

  it('publishes the close-session shortcut event without a window dependency', () => {
    emitCloseSessionShortcut()

    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
      CLOSE_SESSION_SHORTCUT_CHANNEL,
      {}
    )
  })

  it('publishes the file-search shortcut event without a window dependency', () => {
    emitFileSearchShortcut()

    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(FILE_SEARCH_SHORTCUT_CHANNEL, {})
  })

  it('publishes the quit-confirmation-show event without a window dependency', () => {
    emitQuitConfirmationShow()

    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
      QUIT_CONFIRMATION_SHOW_CHANNEL,
      {}
    )
  })

  it('publishes the quit-confirmation-hide event without a window dependency', () => {
    emitQuitConfirmationHide()

    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
      QUIT_CONFIRMATION_HIDE_CHANNEL,
      {}
    )
  })
})
