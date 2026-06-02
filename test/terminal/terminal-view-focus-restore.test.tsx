import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { TerminalView } from '../../src/renderer/src/components/terminal/TerminalView'
import { useLayoutStore } from '../../src/renderer/src/stores/useLayoutStore'
import { useSettingsStore } from '../../src/renderer/src/stores/useSettingsStore'

const ghosttyMount = vi.fn()
const ghosttyFocus = vi.fn()
const ghosttySetVisible = vi.fn()
const ghosttyClear = vi.fn()
const ghosttyDispose = vi.fn()
const ghosttyUpdateTheme = vi.fn()
const xtermFit = vi.fn()
const xtermFocus = vi.fn()
const xtermSetVisible = vi.fn()
const xtermClear = vi.fn()
const xtermDispose = vi.fn()
const xtermUpdateTheme = vi.fn()

vi.mock('@/components/terminal/backends/GhosttyBackend', () => ({
  GhosttyBackend: class MockGhosttyBackend {
    readonly type = 'ghostty' as const
    readonly supportsSearch = false
    mount = ghosttyMount
    resize = vi.fn()
    focus = ghosttyFocus
    setVisible = ghosttySetVisible
    clear = ghosttyClear
    dispose = ghosttyDispose
    updateTheme = ghosttyUpdateTheme
  },
  isGhosttyAvailable: vi.fn().mockResolvedValue(true)
}))

vi.mock('@/components/terminal/backends/XtermBackend', () => ({
  XtermBackend: class MockXtermBackend {
    readonly type = 'xterm' as const
    readonly supportsSearch = true
    onSearchToggle?: () => void
    mount = vi.fn()
    resize = vi.fn()
    fit = xtermFit
    focus = xtermFocus
    setVisible = xtermSetVisible
    clear = xtermClear
    dispose = xtermDispose
    updateTheme = xtermUpdateTheme
    searchNext = vi.fn()
    searchPrevious = vi.fn()
    searchClose = vi.fn()
  }
}))

describe('TerminalView Ghostty focus restoration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()

    act(() => {
      useSettingsStore.setState({
        embeddedTerminalBackend: 'ghostty',
        ghosttyFontSize: 14
      })
      useLayoutStore.setState({ ghosttyOverlaySuppressed: true })
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('does not auto-focus Ghostty when a web input already owns focus as suppression ends', async () => {
    render(<TerminalView terminalId="term-1" cwd="/tmp/project" isVisible />)

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(ghosttyMount).toHaveBeenCalledTimes(1)
    ghosttyFocus.mockClear()
    ghosttySetVisible.mockClear()

    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    expect(document.activeElement).toBe(input)

    await act(async () => {
      useLayoutStore.setState({ ghosttyOverlaySuppressed: false })
      await Promise.resolve()
      vi.advanceTimersByTime(60)
      await Promise.resolve()
    })

    expect(ghosttySetVisible).toHaveBeenCalledWith(true)
    expect(ghosttyFocus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(input)

    input.remove()
  })

  test('still auto-focuses Ghostty when no editable web element is focused', async () => {
    render(<TerminalView terminalId="term-1" cwd="/tmp/project" isVisible />)

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(ghosttyMount).toHaveBeenCalledTimes(1)

    ghosttyFocus.mockClear()
    ghosttySetVisible.mockClear()

    await act(async () => {
      useLayoutStore.setState({ ghosttyOverlaySuppressed: false })
      await Promise.resolve()
      vi.advanceTimersByTime(60)
      await Promise.resolve()
    })

    expect(ghosttySetVisible).toHaveBeenCalledWith(true)
    expect(ghosttyFocus).toHaveBeenCalledTimes(1)
  })
})
