// A Ghostty terminal has no surface until its pane has a size: one set up while hidden (a tab
// of another worktree after a font size change, a terminal session that was never shown) gets
// its surface when it is first shown. When the project moved to the dev folder in between, the
// surface must start in the folder the project is in now, not in the one it left. The real
// TerminalView over the real GhosttyBackend; only the calls to the native side are recorded.
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const terminalApiMocks = vi.hoisted(() => ({
  getConfig: vi.fn().mockResolvedValue({ success: true, data: {} }),
  logClientDiagnostics: vi.fn(),
  ghosttyInit: vi.fn().mockResolvedValue({ success: true }),
  ghosttyCreateSurface: vi.fn().mockResolvedValue({ success: true, surfaceId: 1 }),
  ghosttySetFocus: vi.fn().mockResolvedValue(undefined),
  ghosttySetFrame: vi.fn().mockResolvedValue(undefined),
  ghosttySetSize: vi.fn().mockResolvedValue(undefined),
  ghosttyDestroySurface: vi.fn().mockResolvedValue(undefined),
  ghosttyPasteText: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('@/api/terminal-api', () => ({ terminalApi: terminalApiMocks }))

import { TerminalView } from '../../src/renderer/src/components/terminal/TerminalView'
import { useLayoutStore } from '../../src/renderer/src/stores/useLayoutStore'
import { useSettingsStore } from '../../src/renderer/src/stores/useSettingsStore'

const OLD = '/Users/me/hive-projects/api'
const NEW = '/Users/me/Dev/api'

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
}

/** Lets a setup that is under way (it waits for the config) reach its mount. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

// The size of every pane: none while hidden, as with `display: none`.
let pane = { left: 0, top: 0, width: 0, height: 0 }
const SHOWN = { left: 10, top: 10, width: 640, height: 360 }
const originalRect = Element.prototype.getBoundingClientRect

/** The folder each surface was started in, in the order they were created. */
const surfaceFolders = (): string[] =>
  terminalApiMocks.ghosttyCreateSurface.mock.calls.map(([, , options]) => options.cwd)

beforeEach(() => {
  vi.clearAllMocks()
  pane = { left: 0, top: 0, width: 0, height: 0 }
  vi.stubGlobal('ResizeObserver', MockResizeObserver)
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return {
      ...pane,
      right: pane.left + pane.width,
      bottom: pane.top + pane.height,
      x: pane.left,
      y: pane.top,
      toJSON: () => ({})
    }
  }
  act(() => {
    useSettingsStore.setState({ embeddedTerminalBackend: 'ghostty', ghosttyFontSize: 14 })
    useLayoutStore.setState({ ghosttyOverlaySuppressed: false })
  })
})

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalRect
  vi.unstubAllGlobals()
})

describe('a Ghostty terminal whose worktree moved', () => {
  test('gets its first surface in the folder the project is in now', async () => {
    const view = render(<TerminalView terminalId="term-1" cwd={OLD} isVisible={false} />)
    await flush()
    expect(surfaceFolders()).toEqual([])

    // The project moves while the pane is hidden.
    view.rerender(<TerminalView terminalId="term-1" cwd={NEW} isVisible={false} />)
    await flush()
    expect(surfaceFolders()).toEqual([])

    pane = SHOWN
    view.rerender(<TerminalView terminalId="term-1" cwd={NEW} isVisible />)
    await flush()

    expect(surfaceFolders()).toEqual([NEW])
    expect(terminalApiMocks.ghosttyDestroySurface).not.toHaveBeenCalled()
  })

  test('keeps the surface it has, hidden and shown again', async () => {
    pane = SHOWN
    const view = render(<TerminalView terminalId="term-1" cwd={OLD} isVisible />)
    await flush()
    expect(surfaceFolders()).toEqual([OLD])

    view.rerender(<TerminalView terminalId="term-1" cwd={NEW} isVisible />)
    await flush()
    view.rerender(<TerminalView terminalId="term-1" cwd={NEW} isVisible={false} />)
    await flush()
    view.rerender(<TerminalView terminalId="term-1" cwd={NEW} isVisible />)
    await flush()

    expect(surfaceFolders()).toEqual([OLD])
    expect(terminalApiMocks.ghosttyDestroySurface).not.toHaveBeenCalled()
  })
})
