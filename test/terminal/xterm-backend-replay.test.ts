import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { XtermBackend } from '../../src/renderer/src/components/terminal/backends/XtermBackend'
import {
  SHELL_COMMAND_REPLAY_END,
  SHELL_COMMAND_REPLAY_OSC,
  SHELL_COMMAND_REPLAY_START
} from '../../src/shared/shell-command-events'

const mocks = vi.hoisted(() => ({
  write: vi.fn(),
  create: vi.fn(),
  onData: vi.fn(),
  onExit: vi.fn(),
  resize: vi.fn(),
  /** Set by the Terminal mock's onData: the backend's user-input listener. */
  inputCallback: undefined as ((data: string) => void) | undefined,
  /** Recorded by the Terminal mock's parser: { ident, handler }. */
  oscHandlers: [] as Array<{ ident: number; handler: (data: string) => boolean }>,
  oscDispose: vi.fn(),
  /** Whether the Terminal mock exposes a parser at all. */
  withParser: true
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
  projectApi: {
    openPath: vi.fn().mockResolvedValue({ success: true }),
    readFromClipboard: vi.fn().mockResolvedValue('')
  }
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class MockTerminal {
    options: Record<string, unknown> = {}
    parser?: { registerOscHandler: (ident: number, handler: (data: string) => boolean) => unknown }

    constructor() {
      if (mocks.withParser) {
        this.parser = {
          registerOscHandler: (ident: number, handler: (data: string) => boolean) => {
            mocks.oscHandlers.push({ ident, handler })
            return { dispose: mocks.oscDispose }
          }
        }
      }
    }

    attachCustomKeyEventHandler(): void {}
    loadAddon(): void {}
    open(): void {}
    write(): void {}
    input(): void {}
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
    onData(cb: (data: string) => void): { dispose: () => void } {
      mocks.inputCallback = cb
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

function mountBackend(): XtermBackend {
  const backend = new XtermBackend()
  const container = document.createElement('div')
  backend.mount(
    container,
    { terminalId: 'session-1', cwd: '/tmp/project' },
    { onStatusChange: vi.fn() }
  )
  return backend
}

function replayHandler(): (data: string) => boolean {
  const entry = mocks.oscHandlers.find((h) => h.ident === SHELL_COMMAND_REPLAY_OSC)
  if (!entry) throw new Error('replay OSC handler was not registered')
  return entry.handler
}

describe('XtermBackend in-band replay handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.inputCallback = undefined
    mocks.oscHandlers = []
    mocks.withParser = true
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

  afterEach(() => {
    vi.useRealTimers()
  })

  test('registers one handler for the replay OSC and forwards input normally', () => {
    const backend = mountBackend()
    expect(mocks.oscHandlers.filter((h) => h.ident === SHELL_COMMAND_REPLAY_OSC)).toHaveLength(1)

    mocks.inputCallback?.('ls\r')
    expect(mocks.write).toHaveBeenCalledWith('session-1', 'ls\r')
    backend.dispose()
  })

  test('drops input between the start and end markers, then forwards again', () => {
    const backend = mountBackend()
    const handler = replayHandler()

    expect(handler(SHELL_COMMAND_REPLAY_START)).toBe(true)
    // xterm's own answer to a replayed cursor-position query
    mocks.inputCallback?.('\x1b[24;1R')
    mocks.inputCallback?.('typed during replay')
    expect(mocks.write).not.toHaveBeenCalled()

    expect(handler(SHELL_COMMAND_REPLAY_END)).toBe(true)
    mocks.inputCallback?.('after')
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith('session-1', 'after')
    backend.dispose()
  })

  test('ignores other payloads on the same OSC', () => {
    const backend = mountBackend()
    const handler = replayHandler()

    expect(handler('something-else')).toBe(true)
    mocks.inputCallback?.('x')
    expect(mocks.write).toHaveBeenCalledWith('session-1', 'x')
    backend.dispose()
  })

  test('the suppression expires on its own after 5 s when no end marker arrives', () => {
    vi.useFakeTimers()
    const backend = mountBackend()
    const handler = replayHandler()

    handler(SHELL_COMMAND_REPLAY_START)
    mocks.inputCallback?.('muted')
    expect(mocks.write).not.toHaveBeenCalled()

    vi.advanceTimersByTime(4999)
    mocks.inputCallback?.('still muted')
    expect(mocks.write).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    mocks.inputCallback?.('unmuted')
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith('session-1', 'unmuted')
    backend.dispose()
  })

  test('a second start marker restarts the expiry timer', () => {
    vi.useFakeTimers()
    const backend = mountBackend()
    const handler = replayHandler()

    handler(SHELL_COMMAND_REPLAY_START)
    vi.advanceTimersByTime(4000)
    handler(SHELL_COMMAND_REPLAY_START)
    vi.advanceTimersByTime(4000)
    mocks.inputCallback?.('muted')
    expect(mocks.write).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1000)
    mocks.inputCallback?.('unmuted')
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith('session-1', 'unmuted')
    backend.dispose()
  })

  test('dispose releases the OSC handler and clears a pending expiry timer', () => {
    vi.useFakeTimers()
    const backend = mountBackend()
    replayHandler()(SHELL_COMMAND_REPLAY_START)

    backend.dispose()
    expect(mocks.oscDispose).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('a Terminal without a parser still mounts and forwards input', () => {
    mocks.withParser = false
    const backend = mountBackend()
    expect(mocks.oscHandlers).toHaveLength(0)

    mocks.inputCallback?.('plain')
    expect(mocks.write).toHaveBeenCalledWith('session-1', 'plain')
    expect(() => backend.dispose()).not.toThrow()
  })
})
