import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { TerminalView } from '../../src/renderer/src/components/terminal/TerminalView'
import { useLayoutStore } from '../../src/renderer/src/stores/useLayoutStore'
import { useSettingsStore } from '../../src/renderer/src/stores/useSettingsStore'

const xtermMount = vi.fn()
const xtermSetRedrawOnClear = vi.fn()

const terminalApiMocks = vi.hoisted(() => ({
  getConfig: vi.fn().mockResolvedValue({ success: true, value: {} }),
  create: vi.fn().mockResolvedValue({ success: true }),
  destroy: vi.fn().mockResolvedValue({ success: true, value: undefined }),
  write: vi.fn(),
  resize: vi.fn().mockResolvedValue({ success: true, value: undefined }),
  onData: vi.fn(() => vi.fn()),
  onExit: vi.fn(() => vi.fn()),
  logClientDiagnostics: vi.fn()
}))

vi.mock('@/api/terminal-api', () => ({
  terminalApi: terminalApiMocks
}))

vi.mock('@/components/terminal/backends/GhosttyBackend', () => ({
  GhosttyBackend: class MockGhosttyBackend {
    readonly type = 'ghostty' as const
    readonly supportsSearch = false
    mount = vi.fn()
    resize = vi.fn()
    focus = vi.fn()
    setVisible = vi.fn()
    clear = vi.fn()
    dispose = vi.fn()
  }
}))

vi.mock('@/components/terminal/backends/XtermBackend', () => ({
  XtermBackend: class MockXtermBackend {
    readonly type = 'xterm' as const
    readonly supportsSearch = true
    onSearchToggle?: () => void
    mount = xtermMount
    resize = vi.fn()
    fit = vi.fn()
    focus = vi.fn()
    setVisible = vi.fn()
    clear = vi.fn()
    dispose = vi.fn()
    updateTheme = vi.fn()
    searchNext = vi.fn()
    searchPrevious = vi.fn()
    searchClose = vi.fn()
    setShiftEnterAsNewline = vi.fn()
    setRedrawOnClear = xtermSetRedrawOnClear
  }
}))

const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const mountOptions = (): { redrawOnClear?: boolean } => xtermMount.mock.calls.at(-1)![1]

describe('TerminalView clear-screen configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    act(() => {
      useSettingsStore.setState({ embeddedTerminalBackend: 'xterm' })
      useLayoutStore.setState({ ghosttyOverlaySuppressed: false })
    })
    terminalApiMocks.getConfig.mockResolvedValue({ success: true, value: {} })
    terminalApiMocks.create.mockResolvedValue({ success: true })
    terminalApiMocks.resize.mockResolvedValue({ success: true, value: undefined })
    terminalApiMocks.onData.mockReturnValue(vi.fn())
    terminalApiMocks.onExit.mockReturnValue(vi.fn())
  })

  test('mounts the backend with the redraw-on-clear behavior it was given', async () => {
    render(<TerminalView terminalId="term-1" cwd="/tmp/project" isVisible redrawOnClear />)
    await settle()

    expect(xtermMount).toHaveBeenCalledTimes(1)
    expect(mountOptions().redrawOnClear).toBe(true)
  })

  test('leaves it off by default (shell terminals)', async () => {
    render(<TerminalView terminalId="term-1" cwd="/tmp/project" isVisible />)
    await settle()

    expect(mountOptions().redrawOnClear).toBe(false)
  })

  test('updates the mounted backend when it changes, without remounting', async () => {
    // The session's CLI is read from the store and can arrive after the terminal mounted.
    const { rerender } = render(<TerminalView terminalId="term-1" cwd="/tmp/project" isVisible />)
    await settle()
    xtermSetRedrawOnClear.mockClear()

    rerender(<TerminalView terminalId="term-1" cwd="/tmp/project" isVisible redrawOnClear />)
    await settle()

    expect(xtermMount).toHaveBeenCalledTimes(1)
    expect(xtermSetRedrawOnClear).toHaveBeenCalledWith(true)
  })
})
