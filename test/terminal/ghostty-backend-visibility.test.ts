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

const observers: MockResizeObserver[] = []

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  private callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    observers.push(this)
  }

  trigger(target: Element): void {
    this.callback(
      [
        {
          target,
          contentRect: target.getBoundingClientRect()
        } as ResizeObserverEntry
      ],
      this as unknown as ResizeObserver
    )
  }
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('GhosttyBackend visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    observers.length = 0

    Object.defineProperty(window, 'terminalOps', {
      value: mockTerminalOps,
      writable: true,
      configurable: true
    })

    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    vi.stubGlobal(
      'requestAnimationFrame',
      ((callback: FrameRequestCallback) => setTimeout(() => callback(0), 0)) as typeof requestAnimationFrame
    )
    vi.stubGlobal('cancelAnimationFrame', ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame)
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
        terminalId: 'wt-1',
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
    expect(hiddenFrame.w).toBe(640)
    expect(hiddenFrame.h).toBe(360)
    expect(mockTerminalOps.ghosttyDestroySurface).not.toHaveBeenCalled()

    mockTerminalOps.ghosttySetFocus.mockClear()

    visibilityBackend.setVisible(true)

    const visibleFrame = mockTerminalOps.ghosttySetFrame.mock.calls.at(-1)?.[1]
    expect(visibleFrame).toEqual({ x: 100, y: 80, w: 640, h: 360 })
    expect(mockTerminalOps.ghosttyDestroySurface).not.toHaveBeenCalled()

    // Focus must be restored when becoming visible again so that
    // focusedSurfaceId() returns this surface for the menu paste handler.
    expect(mockTerminalOps.ghosttySetFocus).toHaveBeenCalledWith('wt-1', true)

    backend.dispose()
  })

  test('restores the surface frame without stealing focus from an active web input', async () => {
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
        terminalId: 'wt-1',
        cwd: '/tmp/wt-1'
      },
      {
        onStatusChange: vi.fn()
      }
    )

    await flushPromises()

    const visibilityBackend = backend as unknown as { setVisible: (visible: boolean) => void }
    visibilityBackend.setVisible(false)
    mockTerminalOps.ghosttySetFocus.mockClear()
    mockTerminalOps.ghosttySetFrame.mockClear()

    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    expect(document.activeElement).toBe(input)

    visibilityBackend.setVisible(true)

    const visibleFrame = mockTerminalOps.ghosttySetFrame.mock.calls.at(-1)?.[1]
    expect(visibleFrame).toEqual({ x: 100, y: 80, w: 640, h: 360 })
    expect(mockTerminalOps.ghosttySetFocus).not.toHaveBeenCalledWith('wt-1', true)
    expect(document.activeElement).toBe(input)

    input.remove()
    backend.dispose()
  })

  test('waits for a measurable container instead of failing on initial zero-size mount', async () => {
    const backend = new GhosttyBackend()
    const onStatusChange = vi.fn()
    const container = document.createElement('div')
    let rect = {
      left: 100,
      top: 80,
      width: 0,
      height: 0,
      right: 100,
      bottom: 80,
      x: 100,
      y: 80,
      toJSON: () => ({})
    }
    container.getBoundingClientRect = vi.fn(() => rect)

    backend.mount(
      container,
      {
        terminalId: 'wt-1',
        cwd: '/tmp/wt-1'
      },
      {
        onStatusChange
      }
    )

    await flushPromises()

    expect(mockTerminalOps.ghosttyInit).not.toHaveBeenCalled()
    expect(mockTerminalOps.ghosttyCreateSurface).not.toHaveBeenCalled()
    expect(onStatusChange).toHaveBeenNthCalledWith(1, 'creating')
    expect(onStatusChange).not.toHaveBeenCalledWith('exited')

    rect = {
      ...rect,
      width: 640,
      height: 360,
      right: 740,
      bottom: 440
    }
    observers[0].trigger(container)

    await flushPromises()
    await flushPromises()

    expect(mockTerminalOps.ghosttyInit).toHaveBeenCalledTimes(1)
    expect(mockTerminalOps.ghosttyCreateSurface).toHaveBeenCalledTimes(1)
    expect(onStatusChange).toHaveBeenNthCalledWith(2, 'running')
    expect(onStatusChange).not.toHaveBeenCalledWith('exited')

    backend.dispose()
  })

  test('destroys native surface when dispose races with in-flight createSurface', async () => {
    const backend = new GhosttyBackend()
    const container = document.createElement('div')
    container.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      top: 0,
      width: 640,
      height: 360,
      right: 640,
      bottom: 360,
      x: 0,
      y: 0,
      toJSON: () => ({})
    }))

    // Make ghosttyCreateSurface hang so dispose happens before it resolves.
    let resolveCreate!: (value: { success: true; surfaceId: number }) => void
    mockTerminalOps.ghosttyCreateSurface.mockImplementationOnce(
      () =>
        new Promise<{ success: true; surfaceId: number }>((resolve) => {
          resolveCreate = resolve
        })
    )

    backend.mount(
      container,
      {
        terminalId: 'wt-1',
        cwd: '/tmp/wt-1'
      },
      {
        onStatusChange: vi.fn()
      }
    )

    // Let the runtime init finish and createSurface kick off, but not resolve.
    await flushPromises()
    expect(mockTerminalOps.ghosttyCreateSurface).toHaveBeenCalledTimes(1)
    expect(mockTerminalOps.ghosttyDestroySurface).not.toHaveBeenCalled()

    // Unmount while createSurface is still in flight.
    backend.dispose()

    // Now the native side finishes creating the surface AFTER dispose.
    resolveCreate({ success: true, surfaceId: 1 })
    await flushPromises()
    await flushPromises()

    // The orphaned native surface must be destroyed to avoid leaking NSViews.
    expect(mockTerminalOps.ghosttyDestroySurface).toHaveBeenCalledWith('wt-1')
  })

  test('cancels pending rAF when setVisible(false) races an already-scheduled syncFrame', async () => {
    // Regression test for a subtle ordering of the "thin line" bug:
    // When the panel collapses, the browser fires ResizeObserver BEFORE React
    // runs useEffect (RO callbacks run in the pre-paint step, useEffect runs
    // after paint). That schedules a rAF that, if allowed to run, would send
    // an on-screen setFrame IPC with the shrinking-height rect RIGHT BEFORE
    // setVisible(false) sends its off-screen IPC — leaving the NSView on-screen
    // with a tiny height (the "thin line" the user sees). The fix:
    //   - hideSurface() cancels this.syncFrameTimer before sending its IPC
    //   - debouncedSyncFrame() early-returns while hidden as defense-in-depth
    const backend = new GhosttyBackend()
    const container = document.createElement('div')
    let rect = {
      left: 100,
      top: 80,
      width: 640,
      height: 360,
      right: 740,
      bottom: 440,
      x: 100,
      y: 80,
      toJSON: () => ({})
    }
    container.getBoundingClientRect = vi.fn(() => rect)

    backend.mount(
      container,
      {
        terminalId: 'wt-1',
        cwd: '/tmp/wt-1'
      },
      {
        onStatusChange: vi.fn()
      }
    )

    await flushPromises()

    const visibilityBackend = backend as unknown as {
      setVisible: (visible: boolean) => void
    }

    mockTerminalOps.ghosttySetFrame.mockClear()

    // RO fires first with a shrinking rect and schedules an rAF for syncFrame.
    rect = { ...rect, height: 60, bottom: rect.top + 60 }
    observers[0].trigger(container)

    // CRITICAL: do NOT flush the rAF yet — setVisible(false) must race it.
    visibilityBackend.setVisible(false)

    // Now flush the rAF. If hideSurface() didn't cancel it and the guard
    // didn't block syncFrame, an on-screen IPC with the shrinking rect
    // would fire AFTER the off-screen one, leaving a thin line of terminal.
    await flushPromises()
    await flushPromises()

    // The final IPC must be off-screen, and no intermediate on-screen IPC
    // may exist between the hide and the end of the flush.
    const calls = mockTerminalOps.ghosttySetFrame.mock.calls
    expect(calls.length).toBeGreaterThan(0)
    const lastFrame = calls.at(-1)?.[1] as { x: number; y: number }
    expect(lastFrame.x).toBeLessThan(0)
    expect(lastFrame.y).toBeLessThan(0)

    // Stronger claim: no on-screen frame ever made it through while hidden.
    for (const call of calls) {
      const frame = call[1] as { x: number; y: number }
      expect(frame.x).toBeLessThan(0)
      expect(frame.y).toBeLessThan(0)
    }

    backend.dispose()
  })

  test('ignores ResizeObserver triggers after setVisible(false) during a collapse transition', async () => {
    // Regression test for the "thin line" bug: when the bottom panel is
    // collapsed with a CSS `height` transition, ResizeObserver fires
    // repeatedly with shrinking-height on-screen rects. Those firings must
    // NOT re-position the native NSView back on-screen after setVisible(false)
    // has moved it off-screen via hideSurface().
    const backend = new GhosttyBackend()
    const container = document.createElement('div')
    let rect = {
      left: 100,
      top: 80,
      width: 640,
      height: 360,
      right: 740,
      bottom: 440,
      x: 100,
      y: 80,
      toJSON: () => ({})
    }
    container.getBoundingClientRect = vi.fn(() => rect)

    backend.mount(
      container,
      {
        terminalId: 'wt-1',
        cwd: '/tmp/wt-1'
      },
      {
        onStatusChange: vi.fn()
      }
    )

    await flushPromises()

    const visibilityBackend = backend as unknown as {
      setVisible: (visible: boolean) => void
    }

    // Collapse the panel: setVisible(false) fires hideSurface() → off-screen IPC.
    visibilityBackend.setVisible(false)

    const hiddenFrame = mockTerminalOps.ghosttySetFrame.mock.calls.at(-1)?.[1]
    expect(hiddenFrame.x).toBeLessThan(0)
    expect(hiddenFrame.y).toBeLessThan(0)

    mockTerminalOps.ghosttySetFrame.mockClear()

    // Simulate a CSS height transition firing ResizeObserver repeatedly with
    // shrinking on-screen rects (180 → 60 → 5 pixels tall, still visible).
    for (const height of [180, 60, 5]) {
      rect = {
        ...rect,
        height,
        bottom: rect.top + height
      }
      observers[0].trigger(container)
      // Flush the requestAnimationFrame-scheduled syncFrame.
      await flushPromises()
    }

    // None of those ResizeObserver-driven frames should have updated the
    // native NSView position back to an on-screen rect. Either no call was
    // made, or the call kept the off-screen x/y.
    for (const call of mockTerminalOps.ghosttySetFrame.mock.calls) {
      const frame = call[1] as { x: number; y: number; w: number; h: number }
      expect(frame.x).toBeLessThan(0)
      expect(frame.y).toBeLessThan(0)
    }

    backend.dispose()
  })
})
