import { beforeEach, describe, expect, test, vi } from 'vitest'
import { XtermBackend } from '../../src/renderer/src/components/terminal/backends/XtermBackend'

// Claude Code runs in its fullscreen renderer in the app's terminal: it draws on the alternate
// screen and owns every cell. Wiping xterm's buffer under it (what Cmd+K used to do) leaves a
// blank screen, so with `redrawOnClear` the shortcut asks the program to repaint (Ctrl+L).

const mocks = vi.hoisted(() => ({
  customKeyHandler: undefined as ((event: KeyboardEvent) => boolean) | undefined,
  bufferType: 'normal' as 'normal' | 'alternate',
  terminalClear: vi.fn(),
  write: vi.fn(),
  create: vi.fn(),
  onData: vi.fn(),
  onExit: vi.fn(),
  resize: vi.fn()
}))

vi.mock('@/api/terminal-api', () => ({
  terminalApi: {
    write: mocks.write,
    create: mocks.create,
    onData: mocks.onData,
    onExit: mocks.onExit,
    resize: mocks.resize,
    logClientDiagnostics: vi.fn()
  }
}))

vi.mock('@/api/project-api', () => ({
  projectApi: { openPath: vi.fn(), readFromClipboard: vi.fn().mockResolvedValue('') }
}))

vi.mock('@/api/system-api', () => ({
  systemApi: { openInChrome: vi.fn() }
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class MockTerminal {
    options: Record<string, unknown> = {}
    buffer = {
      get active(): { type: 'normal' | 'alternate' } {
        return { type: mocks.bufferType }
      }
    }

    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
      mocks.customKeyHandler = handler
    }

    loadAddon(): void {}
    open(): void {}
    write(): void {}
    input(): void {}
    clear(): void {
      mocks.terminalClear()
    }
    hasSelection(): boolean {
      return false
    }
    getSelection(): string {
      return ''
    }
    clearSelection(): void {}
    focus(): void {}
    dispose(): void {}
    onData(): { dispose: () => void } {
      return { dispose: vi.fn() }
    }
  }
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class MockFitAddon {
    fit(): void {}
    proposeDimensions(): { cols: number; rows: number } {
      return { cols: 80, rows: 24 }
    }
  }
}))

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class MockSearchAddon {
    clearDecorations(): void {}
    findNext(): void {}
    findPrevious(): void {}
  }
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class MockWebLinksAddon {}
}))

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class MockWebglAddon {
    onContextLoss(): void {}
    dispose(): void {}
  }
}))

class MockResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

function mountBackend(opts: { redrawOnClear?: boolean } = {}): XtermBackend {
  const backend = new XtermBackend()
  backend.mount(
    document.createElement('div'),
    { terminalId: 'term-1', cwd: '/tmp/project', ...opts },
    { onStatusChange: vi.fn() }
  )
  return backend
}

const pressCmdK = (): boolean | undefined =>
  mocks.customKeyHandler?.(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))

/** What was written to the PTY, without the resize that follows the mount. */
const written = (): unknown[][] => mocks.write.mock.calls

describe('XtermBackend clear-screen shortcut', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.customKeyHandler = undefined
    mocks.bufferType = 'normal'
    mocks.create.mockResolvedValue({ success: true })
    mocks.onData.mockReturnValue(vi.fn())
    mocks.onExit.mockReturnValue(vi.fn())
    mocks.resize.mockResolvedValue({ success: true })

    Object.defineProperty(window, 'ResizeObserver', {
      writable: true,
      configurable: true,
      value: MockResizeObserver
    })
  })

  test('asks a fullscreen program to repaint instead of wiping its screen', () => {
    mountBackend({ redrawOnClear: true })
    mocks.bufferType = 'alternate'

    const handled = pressCmdK()

    expect(handled).toBe(false)
    // Ctrl+L (form feed) goes to the program; xterm's buffer is left as the program drew it.
    expect(written()).toEqual([['term-1', '\x0c']])
    expect(mocks.terminalClear).not.toHaveBeenCalled()
  })

  test('still clears the scrollback of a program on the normal screen', () => {
    mountBackend({ redrawOnClear: true })
    mocks.bufferType = 'normal'

    const handled = pressCmdK()

    expect(handled).toBe(false)
    expect(mocks.terminalClear).toHaveBeenCalledTimes(1)
    expect(written()).toEqual([])
  })

  test('keeps the plain clear for terminals that did not opt in, whatever screen they are on', () => {
    // Shell terminals and Codex CLI sessions: unchanged.
    mountBackend()
    mocks.bufferType = 'alternate'

    pressCmdK()

    expect(mocks.terminalClear).toHaveBeenCalledTimes(1)
    expect(written()).toEqual([])
  })

  test('applies the same rule to clear() (the toolbar and the imperative handle)', () => {
    const backend = mountBackend({ redrawOnClear: true })

    mocks.bufferType = 'alternate'
    backend.clear()
    expect(written()).toEqual([['term-1', '\x0c']])
    expect(mocks.terminalClear).not.toHaveBeenCalled()

    mocks.bufferType = 'normal'
    backend.clear()
    expect(mocks.terminalClear).toHaveBeenCalledTimes(1)
  })

  test('can be switched after the mount', () => {
    const backend = mountBackend()
    mocks.bufferType = 'alternate'

    backend.setRedrawOnClear(true)
    pressCmdK()
    expect(written()).toEqual([['term-1', '\x0c']])
    expect(mocks.terminalClear).not.toHaveBeenCalled()

    backend.setRedrawOnClear(false)
    pressCmdK()
    expect(mocks.terminalClear).toHaveBeenCalledTimes(1)
  })

  test('ignores the key-up of the shortcut', () => {
    mountBackend({ redrawOnClear: true })
    mocks.bufferType = 'alternate'

    mocks.customKeyHandler?.(new KeyboardEvent('keyup', { key: 'k', metaKey: true }))

    expect(written()).toEqual([])
    expect(mocks.terminalClear).not.toHaveBeenCalled()
  })

  test('does nothing once the terminal is disposed', () => {
    const backend = mountBackend({ redrawOnClear: true })
    backend.dispose()

    expect(() => backend.clear()).not.toThrow()
    expect(written()).toEqual([])
  })
})
