import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SETTINGS_UPDATED_CHANNEL } from '../../shared/settings-events'

const mocks = vi.hoisted(() => ({
  publishDesktopBackendEvent: vi.fn()
}))

vi.mock('../desktop/backend-manager', () => ({
  publishDesktopBackendEvent: mocks.publishDesktopBackendEvent
}))

import { emitSettingsUpdated } from './settings-events'

describe('settings events', () => {
  beforeEach(() => {
    mocks.publishDesktopBackendEvent.mockClear()
  })

  it('publishes the settings updated event through the backend event bus', () => {
    const payload = { commandFilter: { enabled: true } }

    emitSettingsUpdated(payload)

    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(SETTINGS_UPDATED_CHANNEL, payload)
  })

  it('publishes the settings updated event without a window dependency', () => {
    const payload = { commandFilter: { enabled: true } }

    emitSettingsUpdated(payload)

    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(SETTINGS_UPDATED_CHANNEL, payload)
  })
})
