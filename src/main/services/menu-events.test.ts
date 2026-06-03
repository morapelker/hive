import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  publishDesktopBackendEvent: vi.fn()
}))

vi.mock('../desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: mocks.publishDesktopBackendEvent
}))

import { emitMenuAction, emitMenuActionIfKnown } from './menu-events'

describe('menu events', () => {
  beforeEach(() => {
    mocks.publishDesktopBackendEvent.mockClear()
  })

  it('publishes menu actions without a window dependency', () => {
    emitMenuAction('menu:new-worktree')

    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith('menu:new-worktree', {})
  })

  it('publishes menu action arguments for compatibility', () => {
    emitMenuAction('menu:custom', 'a', 1)

    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith('menu:custom', ['a', 1])
  })

  it('ignores non-menu channels in the generic menu sender', () => {
    const emitted = emitMenuActionIfKnown('shortcut:new-session')

    expect(emitted).toBe(false)
    expect(mocks.publishDesktopBackendEvent).not.toHaveBeenCalled()
  })
})
