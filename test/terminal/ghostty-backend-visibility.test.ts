import { beforeEach, describe, expect, test, vi } from 'vitest'
import { GhosttyBackend } from '../../src/renderer/src/components/terminal/backends/GhosttyBackend'

const mockTerminalOps = {
  ghosttyInit: vi.fn().mockResolvedValue({ success: true }),
  ghosttyCreateSurface: vi.fn().mockResolvedValue({ success: true, surfaceId: 1 }),
  ghosttySetFocus: vi.fn().mockResolvedValue(undefined),
  ghosttySetFrame: vi.fn().mockResolvedValue(undefined),
  ghosttySetSize: vi.fn().mockResolvedValue(undefined),
  ghosttyDestroySurface: vi.fn().mockResolvedValue(undefined)
}

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()

  constructor(_callback: ResizeObserverCallback) {}
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('GhosttyBackend visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    Object.defineProperty(window, 'terminalOps', {
      value: mockTerminalOps,
      writable: true,
      configurable: true
    })

    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  test('hides and restores native surface when visibility changes', async () => {
    const backend = new GhosttyBackend()
    const container = document.createElement('div')
    container.getBoundingClientRect = vi.fn(() => ({
      left: 100,
      top: 80,
      width: 640,
      height: 360,
      right: 740,
      bottom: 440,
      x: 100,
      y: 80,
      toJSON: () => ({})
    }))

    backend.mount(
      container,
      {
        worktreeId: 'wt-1',
        cwd: '/tmp/wt-1'
      },
      {
        onStatusChange: vi.fn()
      }
    )

    await flushPromises()

    const visibilityBackend = backend as unknown as { setVisible: (visible: boolean) => void }

    expect(() => visibilityBackend.setVisible(false)).not.toThrow()
    expect(mockTerminalOps.ghosttySetFocus).toHaveBeenCalledWith('wt-1', false)

    const hiddenFrame = mockTerminalOps.ghosttySetFrame.mock.calls.at(-1)?.[1]
    expect(hiddenFrame.x).toBeLessThan(0)
    expect(hiddenFrame.y).toBeLessThan(0)
    expect(hiddenFrame.w).toBe(1)
    expect(hiddenFrame.h).toBe(1)

    visibilityBackend.setVisible(true)

    const visibleFrame = mockTerminalOps.ghosttySetFrame.mock.calls.at(-1)?.[1]
    expect(visibleFrame).toEqual({ x: 100, y: 80, w: 640, h: 360 })

    backend.dispose()
  })
})
