import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  UPDATER_AVAILABLE_CHANNEL,
  UPDATER_CHECKING_CHANNEL,
  UPDATER_DOWNLOADED_CHANNEL,
  UPDATER_ERROR_CHANNEL,
  UPDATER_NOT_AVAILABLE_CHANNEL,
  UPDATER_PROGRESS_CHANNEL
} from '../../shared/updater-events'

const mocks = vi.hoisted(() => ({
  publishDesktopBackendEvent: vi.fn()
}))

vi.mock('../desktop/backend-manager', () => ({
  publishDesktopBackendEvent: mocks.publishDesktopBackendEvent
}))

import {
  emitUpdaterAvailable,
  emitUpdaterChecking,
  emitUpdaterDownloaded,
  emitUpdaterError,
  emitUpdaterNotAvailable,
  emitUpdaterProgress
} from './updater-events'

describe('updater events', () => {
  beforeEach(() => {
    mocks.publishDesktopBackendEvent.mockClear()
  })

  it('publishes the updater checking event without a window dependency', () => {
    emitUpdaterChecking()

    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(UPDATER_CHECKING_CHANNEL, {})
  })

  it('publishes the updater available event without a window dependency', () => {
    const payload = {
      version: '1.2.3',
      releaseNotes: 'Fixes',
      releaseDate: '2026-05-28T00:00:00.000Z',
      isManualCheck: true
    }

    emitUpdaterAvailable(payload)

    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
      UPDATER_AVAILABLE_CHANNEL,
      payload
    )
  })

  it('publishes the updater not available event without a window dependency', () => {
    const payload = {
      version: '1.2.3',
      isManualCheck: true
    }

    emitUpdaterNotAvailable(payload)

    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
      UPDATER_NOT_AVAILABLE_CHANNEL,
      payload
    )
  })

  it('publishes the updater progress event without a window dependency', () => {
    const payload = {
      percent: 42.5,
      bytesPerSecond: 1024,
      transferred: 2048,
      total: 4096
    }

    emitUpdaterProgress(payload)

    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(UPDATER_PROGRESS_CHANNEL, payload)
  })

  it('publishes the updater downloaded event without a window dependency', () => {
    const payload = {
      version: '1.2.3',
      releaseNotes: 'Fixes'
    }

    emitUpdaterDownloaded(payload)

    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
      UPDATER_DOWNLOADED_CHANNEL,
      payload
    )
  })

  it('publishes the updater error event without a window dependency', () => {
    const payload = {
      message: 'Network unavailable',
      isManualCheck: true
    }

    emitUpdaterError(payload)

    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(UPDATER_ERROR_CHANNEL, payload)
  })
})
