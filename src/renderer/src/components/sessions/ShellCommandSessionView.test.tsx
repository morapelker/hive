import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShellCommandSessionView } from './ShellCommandSessionView'
import { useSessionStore } from '@/stores/useSessionStore'
import { useShellCommandRunStore } from '@/stores/useShellCommandRunStore'
import { toast } from '@/lib/toast'
import type { SessionShellCommand } from '@shared/lib/shell-commands'

type AttachTerminal = (terminalId: string, cwd: string) => Promise<unknown>

const terminalViewMocks = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
  mounts: 0,
  unmounts: 0
}))

// The mock mirrors what the real view does with createTerminal: call it once per mount.
vi.mock('@/components/terminal/TerminalView', async () => {
  const React = await import('react')
  return {
    TerminalView: React.forwardRef(function MockTerminalView(
      props: Record<string, unknown>,
      _ref: unknown
    ) {
      terminalViewMocks.props.push(props)
      React.useEffect(() => {
        terminalViewMocks.mounts += 1
        void (props.createTerminal as AttachTerminal)(
          props.terminalId as string,
          props.cwd as string
        )
        return () => {
          terminalViewMocks.unmounts += 1
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])
      return <div data-testid="mock-terminal-view" />
    })
  }
})

const terminalApiMocks = vi.hoisted(() => ({
  attachShellCommand: vi.fn(),
  runShellCommand: vi.fn(),
  create: vi.fn(),
  destroy: vi.fn(),
  write: vi.fn()
}))

vi.mock('@/api/terminal-api', () => ({
  terminalApi: terminalApiMocks
}))

const launchMocks = vi.hoisted(() => ({
  rerunShellCommand: vi.fn()
}))

vi.mock('@/lib/shell-command-launch', () => launchMocks)

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn()
  }
}))

const SESSION_ID = 'session-1'

const initialSessionState = useSessionStore.getState()
const initialRunState = useShellCommandRunStore.getState()

function makeRun(overrides: Partial<SessionShellCommand> = {}): SessionShellCommand {
  return {
    commandId: 'cmd-1',
    name: 'Build',
    script: 'make',
    detached: false,
    state: 'running',
    runId: 'run-1',
    exitCode: null,
    signal: null,
    reason: null,
    error: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
    ...overrides
  }
}

function setRun(run: SessionShellCommand | null): void {
  useShellCommandRunStore.setState({ runsBySession: run ? { [SESSION_ID]: run } : {} })
}

function strip(): HTMLElement {
  return screen.getByTestId('shell-command-status-strip')
}

function label(): string {
  return screen.getByTestId('shell-command-status-label').textContent ?? ''
}

describe('ShellCommandSessionView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    terminalViewMocks.props = []
    terminalViewMocks.mounts = 0
    terminalViewMocks.unmounts = 0
    terminalApiMocks.attachShellCommand.mockResolvedValue({
      success: true,
      value: { success: true, cols: 80, rows: 24, state: 'running', exitCode: null, runId: 'run-1' }
    })
    terminalApiMocks.destroy.mockResolvedValue({ success: true, value: undefined })
    launchMocks.rerunShellCommand.mockResolvedValue({ success: true })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    useSessionStore.setState(initialSessionState, true)
    useShellCommandRunStore.setState(initialRunState, true)
  })

  it('attaches exactly once on mount and never starts a run or creates a terminal', async () => {
    setRun(makeRun())

    render(<ShellCommandSessionView sessionId={SESSION_ID} />)

    await waitFor(() => expect(terminalApiMocks.attachShellCommand).toHaveBeenCalledTimes(1))
    expect(terminalApiMocks.attachShellCommand).toHaveBeenCalledWith(SESSION_ID)
    expect(terminalApiMocks.runShellCommand).not.toHaveBeenCalled()
    expect(terminalApiMocks.create).not.toHaveBeenCalled()
    expect(launchMocks.rerunShellCommand).not.toHaveBeenCalled()
  })

  it('renders an xterm transcript terminal keyed by the session id', () => {
    setRun(makeRun())

    render(<ShellCommandSessionView sessionId={SESSION_ID} isVisible={false} />)

    const props = terminalViewMocks.props[0]
    expect(props.terminalId).toBe(SESSION_ID)
    expect(props.backendTypeOverride).toBe('xterm')
    expect(props.showToolbar).toBe(false)
    expect(props.isVisible).toBe(false)
    expect(props.shiftEnterAsNewline).toBeUndefined()
    expect(screen.getByTestId('shell-command-session-view').dataset.sessionId).toBe(SESSION_ID)
  })

  it('shows Running with Stop and no Run again while the command runs', () => {
    setRun(makeRun())

    render(<ShellCommandSessionView sessionId={SESSION_ID} />)

    expect(strip().dataset.state).toBe('running')
    expect(label()).toBe('Running')
    expect(screen.getByTestId('shell-command-stop')).toBeInTheDocument()
    expect(screen.queryByTestId('shell-command-run-again')).toBeNull()
  })

  it.each<[string, Partial<SessionShellCommand>, string]>([
    ['succeeded', { state: 'succeeded', exitCode: 0 }, 'Succeeded'],
    ['failed', { state: 'failed', exitCode: 3 }, 'Failed (exit 3)'],
    ['cancelled', { state: 'cancelled' }, 'Stopped'],
    ['interrupted', { state: 'interrupted' }, 'Interrupted']
  ])('shows the %s outcome with Run again and no Stop', (state, overrides, text) => {
    setRun(makeRun({ finishedAt: '2026-01-01T00:01:05.000Z', ...overrides }))

    render(<ShellCommandSessionView sessionId={SESSION_ID} />)

    expect(strip().dataset.state).toBe(state)
    expect(label()).toBe(text)
    expect(screen.getByTestId('shell-command-run-again').textContent).toContain('Run again')
    expect(screen.queryByTestId('shell-command-stop')).toBeNull()
    expect(screen.getByTestId('shell-command-status-timing').textContent).toBe('1:05')
  })

  it('carries the failure description as the label tooltip', () => {
    setRun(makeRun({ state: 'failed', reason: 'start-failed', error: 'no such directory' }))

    render(<ShellCommandSessionView sessionId={SESSION_ID} />)

    expect(label()).toBe('Could not start')
    expect(screen.getByTestId('shell-command-status-label').getAttribute('title')).toBe(
      'Command could not start: no such directory'
    )
  })

  it('marks detached runs', () => {
    setRun(makeRun({ detached: true }))

    render(<ShellCommandSessionView sessionId={SESSION_ID} />)

    expect(screen.getByTestId('shell-command-detached-badge').textContent).toBe(
      'Keeps running if the app quits'
    )
  })

  it('Stop destroys the run and never writes to the terminal', async () => {
    setRun(makeRun())

    render(<ShellCommandSessionView sessionId={SESSION_ID} />)
    fireEvent.click(screen.getByTestId('shell-command-stop'))

    await waitFor(() => expect(terminalApiMocks.destroy).toHaveBeenCalledWith(SESSION_ID))
    expect(terminalApiMocks.destroy).toHaveBeenCalledTimes(1)
    expect(terminalApiMocks.write).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('toasts when Stop fails', async () => {
    setRun(makeRun())
    terminalApiMocks.destroy.mockRejectedValue(new Error('boom'))

    render(<ShellCommandSessionView sessionId={SESSION_ID} />)
    fireEvent.click(screen.getByTestId('shell-command-stop'))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to stop the command'))
  })

  it('Run again reruns the same session', async () => {
    setRun(makeRun({ state: 'succeeded', exitCode: 0 }))

    render(<ShellCommandSessionView sessionId={SESSION_ID} />)
    fireEvent.click(screen.getByTestId('shell-command-run-again'))

    await waitFor(() => expect(launchMocks.rerunShellCommand).toHaveBeenCalledWith(SESSION_ID))
    expect(launchMocks.rerunShellCommand).toHaveBeenCalledTimes(1)
    expect(terminalApiMocks.runShellCommand).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('toasts the error when Run again fails', async () => {
    setRun(makeRun({ state: 'failed', exitCode: 1 }))
    launchMocks.rerunShellCommand.mockResolvedValue({ success: false, error: 'Worktree is gone' })

    render(<ShellCommandSessionView sessionId={SESSION_ID} />)
    fireEvent.click(screen.getByTestId('shell-command-run-again'))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Worktree is gone'))
  })

  it('follows run-store updates without remounting the terminal', async () => {
    setRun(makeRun())

    render(<ShellCommandSessionView sessionId={SESSION_ID} />)
    await waitFor(() => expect(terminalApiMocks.attachShellCommand).toHaveBeenCalledTimes(1))
    const attachBefore = terminalViewMocks.props[0].createTerminal

    act(() => {
      useShellCommandRunStore.getState().mergeRun(SESSION_ID, {
        state: 'failed',
        exitCode: 3,
        finishedAt: '2026-01-01T00:00:10.000Z'
      })
    })
    expect(label()).toBe('Failed (exit 3)')

    // Run again: a new run in the same session
    act(() => {
      useShellCommandRunStore.getState().mergeRun(SESSION_ID, {
        state: 'running',
        runId: 'run-2',
        exitCode: null,
        finishedAt: null
      })
    })
    expect(label()).toBe('Running')

    expect(terminalViewMocks.mounts).toBe(1)
    expect(terminalViewMocks.unmounts).toBe(0)
    expect(terminalApiMocks.attachShellCommand).toHaveBeenCalledTimes(1)
    // A stable attach callback: a new identity would make TerminalView set itself up again
    expect(terminalViewMocks.props.at(-1)?.createTerminal).toBe(attachBefore)
  })

  it('falls back to the session row while the run index has no entry, then loads the index', async () => {
    const loadAll = vi.fn(async () => undefined)
    useShellCommandRunStore.setState({ runsBySession: {}, loadAll })
    useSessionStore.setState({
      getSessionById: ((id: string) =>
        id === SESSION_ID
          ? { shell_command: JSON.stringify(makeRun({ state: 'succeeded', exitCode: 0 })) }
          : null) as never
    })

    render(<ShellCommandSessionView sessionId={SESSION_ID} />)

    expect(label()).toBe('Succeeded')
    await waitFor(() => expect(loadAll).toHaveBeenCalledTimes(1))
  })

  it('shows a neutral strip when nothing is known about the run yet', () => {
    useShellCommandRunStore.setState({ runsBySession: {}, loadAll: vi.fn(async () => undefined) })

    render(<ShellCommandSessionView sessionId={SESSION_ID} />)

    expect(strip().dataset.state).toBe('unknown')
    expect(screen.queryByTestId('shell-command-stop')).toBeNull()
    expect(screen.queryByTestId('shell-command-run-again')).toBeNull()
    expect(screen.getByTestId('mock-terminal-view')).toBeInTheDocument()
  })

  it('moves an active run forward from the attach answer', async () => {
    setRun(makeRun())
    terminalApiMocks.attachShellCommand.mockResolvedValue({
      success: true,
      value: { success: true, state: 'failed', exitCode: 2, runId: 'run-1' }
    })

    render(<ShellCommandSessionView sessionId={SESSION_ID} />)

    await waitFor(() => expect(label()).toBe('Failed (exit 2)'))
  })

  it('follows a new run id from the attach answer', async () => {
    setRun(makeRun({ state: 'succeeded', exitCode: 0 }))
    terminalApiMocks.attachShellCommand.mockResolvedValue({
      success: true,
      value: { success: true, state: 'running', exitCode: null, runId: 'run-2' }
    })

    render(<ShellCommandSessionView sessionId={SESSION_ID} />)

    await waitFor(() => expect(label()).toBe('Running'))
    expect(useShellCommandRunStore.getState().runsBySession[SESSION_ID].runId).toBe('run-2')
  })

  it('never regresses a finished run from a stale attach answer', async () => {
    setRun(makeRun({ state: 'succeeded', exitCode: 0 }))
    // Same run, but the answer was computed before the run finished
    terminalApiMocks.attachShellCommand.mockResolvedValue({
      success: true,
      value: { success: true, state: 'running', exitCode: null, runId: 'run-1' }
    })

    render(<ShellCommandSessionView sessionId={SESSION_ID} />)
    await waitFor(() => expect(terminalApiMocks.attachShellCommand).toHaveBeenCalledTimes(1))
    await act(async () => {
      await Promise.resolve()
    })

    expect(label()).toBe('Succeeded')
    expect(useShellCommandRunStore.getState().runsBySession[SESSION_ID].state).toBe('succeeded')
  })

  it('offers Run for a run that stays pending', () => {
    vi.useFakeTimers()
    setRun(makeRun({ state: 'pending', runId: null, startedAt: null }))
    terminalApiMocks.attachShellCommand.mockResolvedValue({
      success: true,
      value: { success: true, state: 'pending', exitCode: null, runId: null }
    })

    render(<ShellCommandSessionView sessionId={SESSION_ID} />)

    expect(strip().dataset.state).toBe('pending')
    expect(screen.queryByTestId('shell-command-run-again')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(3000)
    })

    expect(screen.getByTestId('shell-command-run-again').textContent).toBe('Run')
    expect(screen.queryByTestId('shell-command-stop')).toBeNull()
  })
})
