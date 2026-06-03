import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EDIT_PASTE_CHANNEL } from '../../shared/edit-events'

const mocks = vi.hoisted(() => ({
  publishDesktopBackendEvent: vi.fn()
}))

vi.mock('../desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: mocks.publishDesktopBackendEvent
}))

import { emitEditPaste } from './edit-events'

describe('edit events', () => {
  beforeEach(() => {
    mocks.publishDesktopBackendEvent.mockClear()
  })

  it('publishes the edit paste event without a window dependency', () => {
    emitEditPaste('hello from clipboard')

    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
      EDIT_PASTE_CHANNEL,
      'hello from clipboard'
    )
  })
})
