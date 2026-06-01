import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { TerminalView } from '../../src/renderer/src/components/terminal/TerminalView'
import { useLayoutStore } from '../../src/renderer/src/stores/useLayoutStore'
import { useSettingsStore } from '../../src/renderer/src/stores/useSettingsStore'

const xtermMount = vi.fn()
const xtermSetShiftEnterAsNewline = vi.fn()

const terminalApiMocks = vi.hoisted(() => ({
  getConfig: vi.fn().mockResolvedValue({ success: true, value: {} }),
  create: vi.fn().mockResolvedValue({ success: true }),
  destroy: vi.fn().mockResolvedValue({ success: true, value: undefined }),
  write: vi.fn(),
  resize: vi.fn().mockResolvedValue({ success: true, value: undefined }),
  onData: vi.fn(() => vi.fn()),
  onExit: vi.fn(() => vi.fn())
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
    setShiftEnterAsNewline = xtermSetShiftEnterAsNewline
  }
}))

describe('TerminalView Shift+Enter configuration', () => {
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

  test('updates the mounted xterm backend when Shift+Enter newline mode changes', async () => {
    const { rerender } = render(<TerminalView terminalId="term-1" cwd="/tmp/project" isVisible />)

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    xtermSetShiftEnterAsNewline.mockClear()

    rerender(
      <TerminalView terminalId="term-1" cwd="/tmp/project" isVisible shiftEnterAsNewline />
    )

    await act(async () => {
      await Promise.resolve()
    })

    expect(xtermMount).toHaveBeenCalledTimes(1)
    expect(xtermSetShiftEnterAsNewline).toHaveBeenCalledWith(true)
  })
})
