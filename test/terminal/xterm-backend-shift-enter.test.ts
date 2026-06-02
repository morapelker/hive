import { beforeEach, describe, expect, test, vi } from 'vitest'
import { XtermBackend } from '../../src/renderer/src/components/terminal/backends/XtermBackend'

const mocks = vi.hoisted(() => ({
  customKeyHandler: undefined as ((event: KeyboardEvent) => boolean) | undefined,
  write: vi.fn(),
  input: vi.fn(),
  create: vi.fn(),
  onData: vi.fn(),
  onExit: vi.fn(),
  resize: vi.fn(),
  openPath: vi.fn()
}))

vi.mock('@/api/terminal-api', () => ({
  terminalApi: {
    write: mocks.write,
    create: mocks.create,
    onData: mocks.onData,
    onExit: mocks.onExit,
    resize: mocks.resize
  }
}))

vi.mock('@/api/project-api', () => ({
  projectApi: {
    openPath: mocks.openPath,
    readFromClipboard: vi.fn().mockResolvedValue('')
  }
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class MockTerminal {
    options: Record<string, unknown> = {}

    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
      mocks.customKeyHandler = handler
    }

    loadAddon(): void {}
    open(): void {}
    write(): void {}
    input(data: string, wasUserInput?: boolean): void {
      mocks.input(data, wasUserInput)
    }
    clear(): void {}
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

function mountBackend(opts: { shiftEnterAsNewline?: boolean } = {}): XtermBackend {
  const backend = new XtermBackend()
  const container = document.createElement('div')

  backend.mount(
    container,
    {
      terminalId: 'term-1',
      cwd: '/tmp/project',
      ...opts
    },
    {
      onStatusChange: vi.fn()
    }
  )

  return backend
}

describe('XtermBackend Shift+Enter handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.customKeyHandler = undefined
    mocks.create.mockResolvedValue({ success: true })
    mocks.onData.mockReturnValue(vi.fn())
    mocks.onExit.mockReturnValue(vi.fn())
    mocks.resize.mockResolvedValue({ success: true })
    mocks.openPath.mockResolvedValue({ success: true })

    Object.defineProperty(window, 'ResizeObserver', {
      writable: true,
      configurable: true,
      value: MockResizeObserver
    })
  })

  test('rewrites bare Shift+Enter to ESC+CR through xterm input when opted in', () => {
    mountBackend({ shiftEnterAsNewline: true })
    const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true })
    const preventDefault = vi.spyOn(event, 'preventDefault')

    const handled = mocks.customKeyHandler?.(event)

    expect(handled).toBe(false)
    expect(preventDefault).toHaveBeenCalled()
    expect(mocks.input).toHaveBeenCalledWith('\x1b\r', true)
    expect(mocks.write).not.toHaveBeenCalled()
  })

  test('recognizes Shift+Enter by physical key code when the key value differs', () => {
    mountBackend({ shiftEnterAsNewline: true })

    const handled = mocks.customKeyHandler?.(
      new KeyboardEvent('keydown', { code: 'Enter', key: 'Return', shiftKey: true })
    )

    expect(handled).toBe(false)
    expect(mocks.input).toHaveBeenCalledWith('\x1b\r', true)
    expect(mocks.write).not.toHaveBeenCalled()
  })

  test('leaves Shift+Enter untouched by default', () => {
    mountBackend()

    const handled = mocks.customKeyHandler?.(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true })
    )

    expect(handled).toBe(true)
    expect(mocks.input).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()
  })
})
