// A terminal keeps the folder it started in. The folder of its worktree changes while the
// terminal is on screen when the project is moved to the dev folder: the terminal must not be
// set up again for that (the pane would be drawn again empty, and a Ghostty surface would end
// with what runs in it), and one that is started again must start where the project is now.
// The real TerminalView, alone and under the real SessionTerminalView and TerminalManager with
// the real stores; only the two backends are recording doubles.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

type BackendName = 'ghostty' | 'xterm'
type Status = 'creating' | 'running' | 'exited'

interface MountRecord {
  backend: BackendName
  terminalId: string
  cwd: string
  onStatusChange: (status: Status, exitCode?: number) => void
}

const record = vi.hoisted(() => ({
  mounts: [] as MountRecord[],
  disposed: [] as string[]
}))

vi.mock('@/components/terminal/backends/GhosttyBackend', () => ({
  GhosttyBackend: class MockGhosttyBackend {
    readonly type = 'ghostty' as const
    readonly supportsSearch = false
    private terminalId = ''
    mount = (
      _container: unknown,
      opts: { terminalId: string; cwd: string },
      callbacks: { onStatusChange: MountRecord['onStatusChange'] }
    ): void => {
      this.terminalId = opts.terminalId
      record.mounts.push({
        backend: 'ghostty',
        terminalId: opts.terminalId,
        cwd: opts.cwd,
        onStatusChange: callbacks.onStatusChange
      })
    }
    resize = vi.fn()
    focus = vi.fn()
    setVisible = vi.fn()
    clear = vi.fn()
    dispose = (): void => {
      record.disposed.push(`ghostty ${this.terminalId}`)
    }
    updateTheme = vi.fn()
  },
  isGhosttyAvailable: vi.fn().mockResolvedValue(true)
}))

vi.mock('@/components/terminal/backends/XtermBackend', () => ({
  XtermBackend: class MockXtermBackend {
    readonly type = 'xterm' as const
    readonly supportsSearch = true
    onSearchToggle?: () => void
    private terminalId = ''
    mount = (
      _container: unknown,
      opts: { terminalId: string; cwd: string },
      callbacks: { onStatusChange: MountRecord['onStatusChange'] }
    ): void => {
      this.terminalId = opts.terminalId
      record.mounts.push({
        backend: 'xterm',
        terminalId: opts.terminalId,
        cwd: opts.cwd,
        onStatusChange: callbacks.onStatusChange
      })
    }
    resize = vi.fn()
    fit = vi.fn()
    focus = vi.fn()
    setVisible = vi.fn()
    clear = vi.fn()
    dispose = (): void => {
      record.disposed.push(`xterm ${this.terminalId}`)
    }
    updateTheme = vi.fn()
    setFontSize = vi.fn()
    setShiftEnterAsNewline = vi.fn()
    setRedrawOnClear = vi.fn()
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

import {
  resetRendererRpcClientForTests,
  setRendererRpcClient
} from '../../src/renderer/src/api/rpc-client'
import { SessionTerminalView } from '../../src/renderer/src/components/sessions/SessionTerminalView'
import { TerminalManager } from '../../src/renderer/src/components/terminal/TerminalManager'
import { TerminalView } from '../../src/renderer/src/components/terminal/TerminalView'
import { useLayoutStore } from '../../src/renderer/src/stores/useLayoutStore'
import { useSessionStore } from '../../src/renderer/src/stores/useSessionStore'
import { useSettingsStore } from '../../src/renderer/src/stores/useSettingsStore'
import { useTerminalStore } from '../../src/renderer/src/stores/useTerminalStore'
import { useTerminalTabStore } from '../../src/renderer/src/stores/useTerminalTabStore'
import { useWorktreeStore } from '../../src/renderer/src/stores/useWorktreeStore'

const OLD = '/Users/me/hive-projects/api'
const NEW = '/Users/me/Dev/api'
const BACKENDS: BackendName[] = ['ghostty', 'xterm']

/** Lets a setup that is under way (it waits for the config and the fonts) reach its mount. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const mountedCwds = (): string[] => record.mounts.map((mount) => mount.cwd)
const lastMount = (): MountRecord => record.mounts[record.mounts.length - 1]

/** The terminal's process ended: the toolbar now offers Restart. */
const exitTerminal = (): void => {
  act(() => lastMount().onStatusChange('exited', 0))
}

const useBackend = (backend: BackendName): void => {
  act(() => {
    useSettingsStore.setState({ embeddedTerminalBackend: backend, ghosttyFontSize: 14 })
  })
}

const restartTerminal = vi.fn()
const initialTerminalState = useTerminalStore.getState()
const initialSessionState = useSessionStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialTabState = useTerminalTabStore.getState()

beforeEach(() => {
  record.mounts.length = 0
  record.disposed.length = 0
  setRendererRpcClient({
    request: vi.fn(async (method: string) =>
      method === 'terminalOps.getConfig' ? { fontFamily: 'JetBrains Mono', fontSize: 11 } : {}
    ) as never,
    subscribe: vi.fn().mockReturnValue(() => {})
  })
  restartTerminal.mockReset()
  restartTerminal.mockImplementation(initialTerminalState.restartTerminal)
  act(() => {
    useTerminalStore.setState({ restartTerminal })
    useLayoutStore.setState({ ghosttyOverlaySuppressed: false })
  })
})

afterEach(() => {
  act(() => {
    useTerminalStore.setState(initialTerminalState, true)
    useSessionStore.setState(initialSessionState, true)
    useWorktreeStore.setState(initialWorktreeState, true)
    useTerminalTabStore.setState(initialTabState, true)
  })
  resetRendererRpcClientForTests()
})

describe('TerminalView when the folder of its worktree changes', () => {
  test.each(BACKENDS)('keeps the terminal that is on screen (%s)', async (backend) => {
    useBackend(backend)
    const view = render(<TerminalView terminalId="term-1" cwd={OLD} isVisible />)
    await flush()
    expect(record.mounts).toHaveLength(1)
    expect(lastMount()).toMatchObject({ backend, terminalId: 'term-1', cwd: OLD })

    view.rerender(<TerminalView terminalId="term-1" cwd={NEW} isVisible />)
    await flush()

    expect(record.disposed).toEqual([])
    expect(mountedCwds()).toEqual([OLD])
  })

  test.each(BACKENDS)(
    'a restart starts in the folder the project is in now (%s)',
    async (backend) => {
      useBackend(backend)
      const view = render(<TerminalView terminalId="term-1" cwd={OLD} isVisible />)
      await flush()
      view.rerender(<TerminalView terminalId="term-1" cwd={NEW} isVisible />)
      await flush()
      exitTerminal()

      fireEvent.click(screen.getByTestId('terminal-restart'))
      await flush()

      expect(restartTerminal).toHaveBeenCalledTimes(1)
      expect(restartTerminal).toHaveBeenCalledWith('term-1', NEW, undefined)
      expect(record.disposed).toEqual([`${backend} term-1`])
      expect(mountedCwds()).toEqual([OLD, NEW])
    }
  )

  test.each(BACKENDS)(
    'a terminal mounted before its folder was known is set up with it, once (%s)',
    async (backend) => {
      useBackend(backend)
      const view = render(<TerminalView terminalId="term-1" cwd="" isVisible />)
      await flush()

      view.rerender(<TerminalView terminalId="term-1" cwd={OLD} isVisible />)
      await flush()
      expect(mountedCwds().filter((cwd) => cwd === OLD)).toHaveLength(1)
      expect(lastMount().cwd).toBe(OLD)
      const mounts = record.mounts.length
      const disposed = record.disposed.length

      // From here on it has its folder: another one does not set it up again.
      view.rerender(<TerminalView terminalId="term-1" cwd={NEW} isVisible />)
      await flush()
      view.rerender(<TerminalView terminalId="term-1" cwd="" isVisible />)
      await flush()

      expect(record.mounts).toHaveLength(mounts)
      expect(record.disposed).toHaveLength(disposed)
    }
  )

  test.each(BACKENDS)(
    'a folder that arrives while the first setup is under way gives one terminal, in it (%s)',
    async (backend) => {
      useBackend(backend)
      const view = render(<TerminalView terminalId="term-1" cwd="" isVisible />)
      // Not flushed: the setup still waits for the config.
      view.rerender(<TerminalView terminalId="term-1" cwd={OLD} isVisible />)
      await flush()

      expect(mountedCwds()).toEqual([OLD])
      expect(record.disposed).toEqual([])
    }
  )

  test('a Ghostty surface made again for a new font size starts in the new folder', async () => {
    useBackend('ghostty')
    const view = render(<TerminalView terminalId="term-1" cwd={OLD} isVisible />)
    await flush()
    view.rerender(<TerminalView terminalId="term-1" cwd={NEW} isVisible />)
    await flush()
    expect(mountedCwds()).toEqual([OLD])

    act(() => {
      useSettingsStore.setState({ ghosttyFontSize: 18 })
    })
    await flush()

    expect(restartTerminal).toHaveBeenCalledWith('term-1', NEW)
    expect(mountedCwds()).toEqual([OLD, NEW])
  })

  test('a Ghostty surface made again for the Shift+Enter setting starts in the new folder', async () => {
    useBackend('ghostty')
    const view = render(<TerminalView terminalId="term-1" cwd={OLD} isVisible />)
    await flush()
    view.rerender(<TerminalView terminalId="term-1" cwd={NEW} isVisible />)
    await flush()
    expect(mountedCwds()).toEqual([OLD])

    view.rerender(<TerminalView terminalId="term-1" cwd={NEW} isVisible shiftEnterAsNewline />)
    await flush()

    expect(restartTerminal).toHaveBeenCalledWith('term-1', NEW)
    expect(mountedCwds()).toEqual([OLD, NEW])
  })

  test('a terminal made again for another backend starts in the new folder', async () => {
    useBackend('xterm')
    const view = render(<TerminalView terminalId="term-1" cwd={OLD} isVisible />)
    await flush()
    view.rerender(<TerminalView terminalId="term-1" cwd={NEW} isVisible />)
    await flush()
    expect(record.mounts).toHaveLength(1)

    useBackend('ghostty')
    await flush()

    expect(record.mounts).toHaveLength(2)
    expect(lastMount()).toMatchObject({ backend: 'ghostty', terminalId: 'term-1', cwd: NEW })
  })
})

describe('the terminals of a project that was moved', () => {
  const worktreeRow = (id: string, projectId: string, path: string): Record<string, unknown> => ({
    id,
    project_id: projectId,
    name: id,
    branch_name: 'main',
    path,
    status: 'active',
    is_default: true
  })

  /** The worktree rows as the window holds them; `apiPath` is the folder of the moved project. */
  const setWorktreeRows = (apiPath: string): void => {
    useWorktreeStore.setState({
      worktreesByProject: new Map([
        ['p1', [worktreeRow('wt-api', 'p1', apiPath)]],
        ['p2', [worktreeRow('wt-web', 'p2', '/Users/me/hive-projects/web')]]
      ]) as never
    })
  }

  test.each(BACKENDS)(
    'a terminal session tab stays as it is when its worktree gets the new folder (%s)',
    async (backend) => {
      useBackend(backend)
      act(() => {
        setWorktreeRows(OLD)
        useSessionStore.setState({
          sessionsByWorktree: new Map([
            ['wt-api', [{ id: 'term-session', worktree_id: 'wt-api', agent_sdk: 'terminal' }]]
          ]) as never
        })
      })
      render(<SessionTerminalView sessionId="term-session" />)
      await flush()
      expect(record.mounts).toHaveLength(1)
      expect(lastMount()).toMatchObject({ backend, terminalId: 'term-session', cwd: OLD })

      act(() => setWorktreeRows(NEW))
      await flush()

      expect(record.disposed).toEqual([])
      expect(mountedCwds()).toEqual([OLD])

      // Started again, it starts in the folder the project is in now.
      exitTerminal()
      fireEvent.click(screen.getByTestId('terminal-restart'))
      await flush()

      expect(restartTerminal).toHaveBeenCalledWith('term-session', NEW, undefined)
      expect(mountedCwds()).toEqual([OLD, NEW])
    }
  )

  test.each(BACKENDS)(
    'a tab of the terminal panel stays as it is when its worktree gets the new folder (%s)',
    async (backend) => {
      useBackend(backend)
      act(() => {
        setWorktreeRows(OLD)
        useTerminalTabStore.setState({
          tabsByWorktree: new Map(),
          activeTabByWorktree: new Map()
        })
      })
      const view = render(
        <TerminalManager selectedWorktreeId="wt-api" worktreePath={OLD} isVisible portalReady />
      )
      await flush()
      expect(record.mounts).toHaveLength(1)
      expect(lastMount()).toMatchObject({ backend, cwd: OLD })
      const tabId = lastMount().terminalId

      // What the panel is given once the window reloaded the moved project's worktree.
      act(() => setWorktreeRows(NEW))
      view.rerender(
        <TerminalManager selectedWorktreeId="wt-api" worktreePath={NEW} isVisible portalReady />
      )
      await flush()

      expect(record.disposed).toEqual([])
      expect(mountedCwds()).toEqual([OLD])

      // A tab opened after the move starts in the new folder.
      act(() => {
        useTerminalTabStore.getState().createTab('wt-api')
      })
      await flush()

      expect(record.mounts).toHaveLength(2)
      expect(lastMount().terminalId).not.toBe(tabId)
      expect(lastMount().cwd).toBe(NEW)
    }
  )
})
