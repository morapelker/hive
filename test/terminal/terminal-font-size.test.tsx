import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { TerminalView } from '../../src/renderer/src/components/terminal/TerminalView'
import {
  resetRendererRpcClientForTests,
  setRendererRpcClient
} from '../../src/renderer/src/api/rpc-client'
import { useSettingsStore } from '../../src/renderer/src/stores/useSettingsStore'

const xtermMount = vi.fn()
const xtermSetFontSize = vi.fn()

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
    updateTheme = vi.fn()
  },
  isGhosttyAvailable: vi.fn().mockResolvedValue(false)
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
    setFontSize = xtermSetFontSize
    searchNext = vi.fn()
    searchPrevious = vi.fn()
    searchClose = vi.fn()
  }
}))

vi.mock('@/components/terminal/backends/terminal-fonts', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../src/renderer/src/components/terminal/backends/terminal-fonts')
    >()
  return {
    ...actual,
    ensureTerminalFontsLoaded: vi.fn().mockResolvedValue(undefined),
    resolveTerminalFontFamily: vi.fn(() => ({
      fontFamily: actual.DEFAULT_XTERM_FONT_STACK,
      primary: undefined,
      primaryResolved: false,
      dropped: []
    }))
  }
})

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

describe('TerminalView xterm font size (Claude/Codex CLI sessions force xterm)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setRendererRpcClient({
      request: vi.fn(async (method: string) =>
        method === 'terminalOps.getConfig' ? { fontFamily: 'JetBrains Mono', fontSize: 11 } : {}
      ),
      subscribe: vi.fn().mockReturnValue(() => {})
    })
    act(() => {
      useSettingsStore.setState({ embeddedTerminalBackend: 'xterm', ghosttyFontSize: 18 })
    })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  test('mounts xterm with the Settings font size, not the Ghostty config file font-size', async () => {
    render(<TerminalView terminalId="cli-1" cwd="/" isVisible backendTypeOverride="xterm" />)
    await flush()

    expect(xtermMount).toHaveBeenCalledTimes(1)
    const opts = xtermMount.mock.calls[0][1]
    expect(opts.fontSize).toBe(18)
    expect(opts.fontFamily).toContain('JetBrains Mono')
  })

  test('falls back to the Ghostty config font-size when the setting is unset', async () => {
    act(() => {
      useSettingsStore.setState({ ghosttyFontSize: 0 })
    })
    render(<TerminalView terminalId="cli-2" cwd="/" isVisible backendTypeOverride="xterm" />)
    await flush()

    expect(xtermMount).toHaveBeenCalledTimes(1)
    expect(xtermMount.mock.calls[0][1].fontSize).toBe(11)
  })

  test('applies a font size change in place without remounting xterm', async () => {
    render(<TerminalView terminalId="cli-3" cwd="/" isVisible backendTypeOverride="xterm" />)
    await flush()
    expect(xtermMount).toHaveBeenCalledTimes(1)

    act(() => {
      useSettingsStore.setState({ ghosttyFontSize: 22 })
    })
    await flush()

    expect(xtermSetFontSize).toHaveBeenCalledWith(22)
    expect(xtermMount).toHaveBeenCalledTimes(1)
  })
})
