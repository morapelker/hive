import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WINDOW_FOCUSED_CHANNEL } from '../../shared/app-events'

const mocks = vi.hoisted(() => ({
  publishDesktopBackendEvent: vi.fn()
}))

vi.mock('../desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: mocks.publishDesktopBackendEvent
}))

import { emitWindowFocused } from './app-events'

describe('app events', () => {
  beforeEach(() => {
    mocks.publishDesktopBackendEvent.mockClear()
  })

  it('publishes the window focused event without a window dependency', () => {
    emitWindowFocused()

    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(WINDOW_FOCUSED_CHANNEL, {})
  })
})
