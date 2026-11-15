import { beforeEach, describe, expect, test, vi } from 'vitest'
import { XtermBackend } from '../../src/renderer/src/components/terminal/backends/XtermBackend'
import { useSettingsStore } from '../../src/renderer/src/stores/useSettingsStore'

// A link clicked in the terminal. Web addresses used to be handed to `projectApi.openPath`
// (Electron's shell.openPath), which only opens file paths and answers "Failed to open path"
// for a URL, so nothing opened. They go to the browser like every other link in the app.

const mocks = vi.hoisted(() => ({
  linkHandler: undefined as ((event: MouseEvent, uri: string) => void) | undefined,
  openPath: vi.fn(),
  openInChrome: vi.fn(),
  create: vi.fn(),
  onData: vi.fn(),
  onExit: vi.fn(),
  resize: vi.fn()
}))

vi.mock('@/api/terminal-api', () => ({
  terminalApi: {
    write: vi.fn(),
    create: mocks.create,
    onData: mocks.onData,
    onExit: mocks.onExit,
    resize: mocks.resize,
    logClientDiagnostics: vi.fn()
  }
}))

vi.mock('@/api/project-api', () => ({
  projectApi: { openPath: mocks.openPath, readFromClipboard: vi.fn().mockResolvedValue('') }
}))

vi.mock('@/api/system-api', () => ({
  systemApi: { openInChrome: mocks.openInChrome }
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class MockTerminal {
    options: Record<string, unknown> = {}
    attachCustomKeyEventHandler(): void {}
    loadAddon(): void {}
    open(): void {}
    write(): void {}
    clear(): void {}
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
  }
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class MockWebLinksAddon {
    constructor(handler: (event: MouseEvent, uri: string) => void) {
      mocks.linkHandler = handler
    }
  }
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

const click = (uri: string): void => mocks.linkHandler?.(new MouseEvent('click'), uri)

describe('XtermBackend link clicks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.linkHandler = undefined
    mocks.create.mockResolvedValue({ success: true })
    mocks.onData.mockReturnValue(vi.fn())
    mocks.onExit.mockReturnValue(vi.fn())
    mocks.resize.mockResolvedValue({ success: true })
    mocks.openPath.mockResolvedValue('')
    mocks.openInChrome.mockResolvedValue({ success: true })
    useSettingsStore.setState({ customChromeCommand: '' })

    Object.defineProperty(window, 'ResizeObserver', {
      writable: true,
      configurable: true,
      value: MockResizeObserver
    })

    new XtermBackend().mount(
      document.createElement('div'),
      { terminalId: 'term-1', cwd: '/tmp/project' },
      { onStatusChange: vi.fn() }
    )
  })

  test.each(['https://example.com/docs?a=1#top', 'http://localhost:5173/', 'HTTPS://EXAMPLE.COM'])(
    'opens %s in the browser',
    (uri) => {
      click(uri)

      expect(mocks.openInChrome).toHaveBeenCalledWith(uri, undefined)
      expect(mocks.openPath).not.toHaveBeenCalled()
    }
  )

  test("uses the user's own browser command when one is set", () => {
    useSettingsStore.setState({ customChromeCommand: 'open -a Arc {url}' })

    click('https://example.com')

    expect(mocks.openInChrome).toHaveBeenCalledWith('https://example.com', 'open -a Arc {url}')
  })

  test('still opens anything that is not a web address with its default app', () => {
    click('file:///tmp/report.pdf')

    expect(mocks.openPath).toHaveBeenCalledWith('file:///tmp/report.pdf')
    expect(mocks.openInChrome).not.toHaveBeenCalled()
  })

  test('survives an opener that fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.openInChrome.mockRejectedValue(new Error('no browser'))

    expect(() => click('https://example.com')).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()

    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
