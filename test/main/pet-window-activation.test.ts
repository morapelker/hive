// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronMock = vi.hoisted(() => {
  const windows: Array<Record<string, unknown>> = []
  const BrowserWindow = vi.fn((options: Record<string, unknown>) => {
    const window = {
      options,
      isDestroyed: vi.fn(() => false),
      getPosition: vi.fn(() => [options.x ?? 0, options.y ?? 0]),
      getBounds: vi.fn(() => ({ width: options.width ?? 0, height: options.height ?? 0 })),
      setVisibleOnAllWorkspaces: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      setFullScreenable: vi.fn(),
      setIgnoreMouseEvents: vi.fn(),
      on: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn(),
      showInactive: vi.fn(),
      destroy: vi.fn(),
      webContents: {
        send: vi.fn()
      }
    }
    windows.push(window)
    return window
  })
  Object.assign(BrowserWindow, {
    getAllWindows: vi.fn(() => windows)
  })

  return {
    windows,
    BrowserWindow,
    app: {
      getPath: vi.fn(() => '/tmp/hive-pet-window-test'),
      setActivationPolicy: vi.fn(),
      dock: {
        show: vi.fn().mockResolvedValue(undefined)
      }
    }
  }
})

vi.mock('electron', () => ({
  app: electronMock.app,
  BrowserWindow: electronMock.BrowserWindow,
  screen: {
    getAllDisplays: vi.fn(() => [
      { workArea: { x: 0, y: 0, width: 1440, height: 900 } }
    ]),
    getDisplayNearestPoint: vi.fn(() => ({
      workArea: { x: 0, y: 0, width: 1440, height: 900 }
    })),
    getPrimaryDisplay: vi.fn(() => ({
      workArea: { x: 0, y: 0, width: 1440, height: 900 }
    }))
  }
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: false }
}))

vi.mock('../../src/main/db', () => ({
  getDatabase: vi.fn()
}))

import {
  beginPetPointerInteraction,
  configurePetWindow,
  createPetWindow,
  destroyPetWindow,
  endPetPointerInteraction,
  focusMainWindowFromPet,
  shouldSuppressMainWindowActivationFromPet
} from '../../src/main/services/pet-window'

describe('pet window activation suppression', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    destroyPetWindow()
    endPetPointerInteraction()
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    electronMock.windows.length = 0
    electronMock.BrowserWindow.mockClear()
  })

  it('suppresses main-window activation during pet pointer interaction until the grace period ends', () => {
    expect(shouldSuppressMainWindowActivationFromPet()).toBe(false)

    beginPetPointerInteraction()
    expect(shouldSuppressMainWindowActivationFromPet()).toBe(true)

    endPetPointerInteraction()
    expect(shouldSuppressMainWindowActivationFromPet()).toBe(true)

    vi.advanceTimersByTime(249)
    expect(shouldSuppressMainWindowActivationFromPet()).toBe(true)

    vi.advanceTimersByTime(1)
    expect(shouldSuppressMainWindowActivationFromPet()).toBe(false)
  })

  it('clears suppression when an explicit pet click focuses the main window', () => {
    const mainWindow = {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: {
        send: vi.fn()
      }
    }

    configurePetWindow({ getMainWindow: () => mainWindow as never })

    beginPetPointerInteraction()
    expect(shouldSuppressMainWindowActivationFromPet()).toBe(true)

    focusMainWindowFromPet(null)

    expect(shouldSuppressMainWindowActivationFromPet()).toBe(false)
    expect(mainWindow.show).toHaveBeenCalledTimes(1)
    expect(mainWindow.focus).toHaveBeenCalledTimes(1)
  })

  it('creates the pet as a non-activating macOS panel', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })

    createPetWindow()

    expect(electronMock.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'panel',
        focusable: false,
        alwaysOnTop: true,
        skipTaskbar: true
      })
    )
  })
})
