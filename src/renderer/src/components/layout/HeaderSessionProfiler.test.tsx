// The header session counter (Settings › Advanced › "Session profiler"): off renders nothing and
// asks nothing — no RPC, no timer, no listener; on, it samples on mount and every minute while
// the window is visible, catches up when the window comes back, and shows the count tinted by the
// leftover sessions. Its panel stops one session (the process only: the renderer's view is
// released so the next open respawns it) or clears every leftover one that nothing keeps — the
// tab in front, a ticket modal or tile, a working turn, background work.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type {
  SessionProfilerSession,
  SessionProfilerSnapshot
} from '@shared/types/session-profiler'
import { sessionProfilerApi } from '@/api/session-profiler-api'
import { toast } from '@/lib/toast'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { HeaderSessionProfiler } from './HeaderSessionProfiler'

vi.mock('@/api/session-profiler-api', () => ({
  sessionProfilerApi: { getSnapshot: vi.fn(), kill: vi.fn() }
}))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

// Radix's popper measures the anchor with a ResizeObserver, which jsdom lacks.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub

// floating-ui asks every ancestor `matches(':popover-open')` / `matches(':modal')`, which jsdom's
// selector engine is very slow to reject; answer them outright (as HeaderAchievementsChip.test).
const nativeMatches = Element.prototype.matches
Element.prototype.matches = function matches(this: Element, selector: string): boolean {
  if (selector === ':popover-open' || selector === ':modal') return false
  return nativeMatches.call(this, selector)
}

const getSnapshot = vi.mocked(sessionProfilerApi.getSnapshot)
const kill = vi.mocked(sessionProfilerApi.kill)

function row(over: Partial<SessionProfilerSession> = {}): SessionProfilerSession {
  return {
    sessionId: 's-1',
    pid: 1001,
    startedAt: 'Tue Oct 21 09:00:00 2026',
    agent: 'claude',
    tracked: true,
    name: 'Session one',
    dbStatus: 'active',
    liveStatus: 'completed',
    backgroundWork: 0,
    paused: false,
    stopping: false,
    ticket: null,
    worktreeName: 'wt-one',
    worktreePath: '/tmp/wt-one',
    worktreeArchived: false,
    projectName: 'Project',
    cwd: '/tmp/wt-one',
    processCount: 1,
    rssBytes: 200 * 1024 * 1024,
    cpuPercent: 0.4,
    cpuSeconds: 12,
    elapsedSeconds: 7200,
    idleSeconds: 3600,
    irrelevantReasons: [],
    ...over
  }
}

function snapshot(
  sessions: SessionProfilerSession[],
  over: Partial<SessionProfilerSnapshot> = {}
): SessionProfilerSnapshot {
  return {
    supported: true,
    sampledAt: Date.now(),
    cpuWindowMs: 60_000,
    idleThresholdSeconds: 1800,
    sessions,
    totals: {
      processCount: 40,
      cpuPercent: 25,
      agentCpuPercent: 4,
      rssBytes: 3 * 1024 * 1024 * 1024,
      agentRssBytes: 1024 * 1024 * 1024,
      cpuCount: 10
    },
    ...over
  }
}

let visibility: DocumentVisibilityState = 'visible'
const releaseSessionTerminal = vi.fn()
const initialSettings = useSettingsStore.getState()
const initialSessions = useSessionStore.getState()
const initialStatuses = useWorktreeStatusStore.getState()

function setEnabled(enabled: boolean): void {
  useSettingsStore.setState({ sessionProfilerEnabled: enabled })
}

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next
  document.dispatchEvent(new Event('visibilitychange'))
}

/** Opens the panel the way a click does (it pins it). */
async function openPanel(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByTestId('session-profiler-chip'))
  return screen.findByTestId('session-profiler-menu')
}

beforeEach(() => {
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility
  })
  getSnapshot.mockReset()
  kill.mockReset()
  releaseSessionTerminal.mockReset()
  vi.mocked(toast.success).mockReset()
  vi.mocked(toast.error).mockReset()
  useSettingsStore.setState({ ...initialSettings }, true)
  useSessionStore.setState({
    activeSessionId: null,
    activePinnedSessionId: null,
    inlineConnectionSessionId: null,
    sessionMountRequests: new Map(),
    // Stubbed so the release is observable; restored after each test.
    releaseSessionTerminal
  })
  useWorktreeStatusStore.setState({ ...initialStatuses, sessionStatuses: {} }, true)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useSessionStore.setState({
    activeSessionId: initialSessions.activeSessionId,
    activePinnedSessionId: initialSessions.activePinnedSessionId,
    inlineConnectionSessionId: initialSessions.inlineConnectionSessionId,
    sessionMountRequests: initialSessions.sessionMountRequests,
    releaseSessionTerminal: initialSessions.releaseSessionTerminal
  })
})

describe('HeaderSessionProfiler — off', () => {
  it('renders nothing and starts no RPC, timer or listener', async () => {
    vi.useFakeTimers()
    const addListener = vi.spyOn(document, 'addEventListener')
    const { container } = render(<HeaderSessionProfiler />)

    expect(container).toBeEmptyDOMElement()
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000)
    })
    setVisibility('hidden')
    setVisibility('visible')
    expect(getSnapshot).not.toHaveBeenCalled()
    expect(addListener.mock.calls.some(([type]) => type === 'visibilitychange')).toBe(false)
    addListener.mockRestore()
  })

  it('stops polling when the setting is switched off', async () => {
    vi.useFakeTimers()
    getSnapshot.mockResolvedValue(snapshot([row()]))
    setEnabled(true)
    const { container } = render(<HeaderSessionProfiler />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(getSnapshot).toHaveBeenCalledTimes(1)

    act(() => setEnabled(false))
    expect(container).toBeEmptyDOMElement()
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000)
    })
    expect(getSnapshot).toHaveBeenCalledTimes(1)
  })
})

describe('HeaderSessionProfiler — on', () => {
  beforeEach(() => setEnabled(true))

  it('samples on mount, then every minute, skipping ticks while the window is hidden', async () => {
    vi.useFakeTimers()
    getSnapshot.mockResolvedValue(snapshot([row()]))
    render(<HeaderSessionProfiler />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(getSnapshot).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(getSnapshot).toHaveBeenCalledTimes(2)

    act(() => setVisibility('hidden'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60_000)
    })
    expect(getSnapshot).toHaveBeenCalledTimes(2)

    // Back to the front after more than a minute: sample at once.
    await act(async () => {
      setVisibility('visible')
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(getSnapshot).toHaveBeenCalledTimes(3)

    // Back again within the minute: the last sample is fresh enough.
    act(() => setVisibility('hidden'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
      setVisibility('visible')
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(getSnapshot).toHaveBeenCalledTimes(3)
  })

  it('never overlaps requests', async () => {
    vi.useFakeTimers()
    let resolve: (value: SessionProfilerSnapshot) => void = () => {}
    getSnapshot.mockImplementation(
      () =>
        new Promise<SessionProfilerSnapshot>((r) => {
          resolve = r
        })
    )
    render(<HeaderSessionProfiler />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60_000)
    })
    expect(getSnapshot).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolve(snapshot([row()]))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByTestId('session-profiler-count')).toHaveTextContent('1')
  })

  it('renders nothing on an unsupported platform', async () => {
    getSnapshot.mockResolvedValue(snapshot([], { supported: false }))
    const { container } = render(<HeaderSessionProfiler />)
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(container).toBeEmptyDOMElement()
  })

  it('counts the sessions and tints the icon by the leftover ones', async () => {
    getSnapshot.mockResolvedValue(
      snapshot([row(), row({ sessionId: 's-2', pid: 1002, irrelevantReasons: ['ticket_done'] })])
    )
    render(<HeaderSessionProfiler />)
    const chip = await screen.findByTestId('session-profiler-chip')
    expect(screen.getByTestId('session-profiler-count')).toHaveTextContent('2')
    expect(chip).toHaveAttribute('aria-label', '2 agent sessions running, 1 looks leftover')
    expect(chip.className).toContain('text-amber-500')
  })

  it('shows the totals and one row per session, leftovers first then by memory', async () => {
    getSnapshot.mockResolvedValue(
      snapshot([
        row({ sessionId: 'small', pid: 1, rssBytes: 100 * 1024 * 1024 }),
        row({ sessionId: 'big', pid: 2, rssBytes: 2 * 1024 * 1024 * 1024 }),
        row({
          sessionId: 'left',
          pid: 3,
          rssBytes: 10 * 1024 * 1024,
          ticket: {
            id: 't1',
            title: 'Fix the login',
            column: 'done',
            archived: false,
            projectId: 'p1'
          },
          irrelevantReasons: ['ticket_done', 'idle']
        })
      ])
    )
    render(<HeaderSessionProfiler />)
    const menu = await openPanel()

    expect(within(menu).getByTestId('session-profiler-totals')).toHaveTextContent(
      'Hive CPU: 25% (2.5% of machine)'
    )
    expect(within(menu).getByTestId('session-profiler-totals')).toHaveTextContent(
      'Agents: 4.0% CPU · 1.0 GB'
    )
    const rows = within(menu).getAllByRole('listitem')
    expect(rows.map((item) => item.getAttribute('data-testid'))).toEqual([
      'session-profiler-row-left',
      'session-profiler-row-big',
      'session-profiler-row-small'
    ])
    expect(rows[0]).toHaveTextContent('Fix the login')
    expect(rows[0]).toHaveTextContent('Done')
    expect(rows[0]).toHaveTextContent('idle 1h 0m')
    expect(
      within(rows[0] as HTMLElement)
        .getAllByTestId('session-profiler-reason')
        .map((chip) => chip.textContent)
    ).toEqual(['ticket done', 'idle'])
    expect(rows[1]).toHaveTextContent('2.0 GB')
  })

  it('stops a session: kills the process, releases its view, toasts and samples again', async () => {
    const leftover = row({ sessionId: 's-9', pid: 4242, irrelevantReasons: ['session_completed'] })
    getSnapshot.mockResolvedValueOnce(snapshot([leftover])).mockResolvedValue(snapshot([]))
    kill.mockResolvedValue({ ok: true, method: 'pty' })
    render(<HeaderSessionProfiler />)
    const menu = await openPanel()

    fireEvent.click(within(menu).getByTestId('session-profiler-stop'))
    await waitFor(() => expect(releaseSessionTerminal).toHaveBeenCalledWith('s-9'))
    expect(kill).toHaveBeenCalledWith({
      sessionId: 's-9',
      pid: 4242,
      startedAt: leftover.startedAt
    })
    expect(toast.success).toHaveBeenCalledWith('Stopped Session one', expect.anything())
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.getByTestId('session-profiler-empty')).toHaveTextContent(
        'No agent sessions are running.'
      )
    )
  })

  it('keeps the view of an untracked process that was signalled by pid', async () => {
    getSnapshot.mockResolvedValue(
      snapshot([row({ sessionId: 's-u', tracked: false, irrelevantReasons: ['untracked'] })])
    )
    kill.mockResolvedValue({ ok: true, method: 'signal' })
    render(<HeaderSessionProfiler />)
    const menu = await openPanel()

    fireEvent.click(within(menu).getByTestId('session-profiler-stop'))
    await waitFor(() => expect(kill).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(releaseSessionTerminal).not.toHaveBeenCalled()
  })

  it('toasts a refused stop and leaves the view alone', async () => {
    getSnapshot.mockResolvedValue(snapshot([row({ irrelevantReasons: ['idle'] })]))
    kill.mockResolvedValue({ ok: false, error: 'process changed' })
    render(<HeaderSessionProfiler />)
    const menu = await openPanel()

    fireEvent.click(within(menu).getByTestId('session-profiler-stop'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not stop the session', {
        description: 'process changed'
      })
    )
    expect(releaseSessionTerminal).not.toHaveBeenCalled()
  })

  it('clears only the leftover sessions nothing keeps, after confirming', async () => {
    useSessionStore.setState({
      activeSessionId: 'front',
      sessionMountRequests: new Map([['modal', 1]])
    })
    useWorktreeStatusStore.setState({
      sessionStatuses: { busy: { status: 'working', timestamp: Date.now() } }
    })
    const reasons: SessionProfilerSession['irrelevantReasons'] = ['ticket_done']
    getSnapshot.mockResolvedValue(
      snapshot([
        row({ sessionId: 'front', pid: 1, irrelevantReasons: reasons }),
        row({ sessionId: 'modal', pid: 2, irrelevantReasons: reasons }),
        row({ sessionId: 'busy', pid: 3, irrelevantReasons: reasons }),
        row({ sessionId: 'bg', pid: 4, irrelevantReasons: reasons, backgroundWork: 2 }),
        row({ sessionId: 'gone-1', pid: 5, irrelevantReasons: reasons }),
        row({ sessionId: 'gone-2', pid: 6, irrelevantReasons: ['session_completed'] }),
        row({ sessionId: 'fine', pid: 7 })
      ])
    )
    kill.mockResolvedValue({ ok: true, method: 'pty' })
    render(<HeaderSessionProfiler />)
    const menu = await openPanel()

    // What the user is looking at, or a turn in progress, cannot be stopped from here at all.
    for (const id of ['front', 'modal', 'busy']) {
      const item = within(menu).getByTestId(`session-profiler-row-${id}`)
      expect(item).toHaveAttribute('data-protected', 'true')
      expect(within(item).getByTestId('session-profiler-stop')).toBeDisabled()
    }
    expect(
      within(within(menu).getByTestId('session-profiler-row-front')).getByTestId(
        'session-profiler-stop'
      ).parentElement
    ).toHaveAttribute('title', "Can't stop: active tab")
    // Background work only keeps a session out of the bulk clear.
    expect(
      within(within(menu).getByTestId('session-profiler-row-bg')).getByTestId(
        'session-profiler-stop'
      )
    ).toBeEnabled()

    const clear = within(menu).getByTestId('session-profiler-clear')
    expect(clear).toHaveTextContent('Clear 2 irrelevant')
    fireEvent.click(clear)
    expect(await screen.findByTestId('session-profiler-clear-dialog')).toHaveTextContent(
      'Stop 2 leftover sessions?'
    )
    expect(kill).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('session-profiler-clear-confirm'))
    await waitFor(() => expect(kill).toHaveBeenCalledTimes(2))
    expect(kill.mock.calls.map(([request]) => request.sessionId).sort()).toEqual([
      'gone-1',
      'gone-2'
    ])
    await waitFor(() => expect(releaseSessionTerminal).toHaveBeenCalledTimes(2))
    expect(toast.success).toHaveBeenCalledWith('Stopped 2 sessions', expect.anything())
  })

  it('re-checks protection on confirm: a session that came to the front meanwhile is kept', async () => {
    const reasons: SessionProfilerSession['irrelevantReasons'] = ['idle']
    getSnapshot.mockResolvedValue(
      snapshot([
        row({ sessionId: 'a', pid: 1, irrelevantReasons: reasons }),
        row({ sessionId: 'b', pid: 2, irrelevantReasons: reasons })
      ])
    )
    kill.mockResolvedValue({ ok: true, method: 'pty' })
    render(<HeaderSessionProfiler />)
    const menu = await openPanel()
    fireEvent.click(within(menu).getByTestId('session-profiler-clear'))
    await screen.findByTestId('session-profiler-clear-dialog')

    act(() => useSessionStore.setState({ activeSessionId: 'b' }))
    fireEvent.click(screen.getByTestId('session-profiler-clear-confirm'))
    await waitFor(() => expect(kill).toHaveBeenCalledTimes(1))
    expect(kill.mock.calls[0]?.[0].sessionId).toBe('a')
  })

  it('protects the pinned board session and the inline connection tab like the tab in front', async () => {
    useSessionStore.setState({
      activePinnedSessionId: 'pinned',
      inlineConnectionSessionId: 'inline'
    })
    const reasons: SessionProfilerSession['irrelevantReasons'] = ['idle']
    getSnapshot.mockResolvedValue(
      snapshot([
        row({ sessionId: 'pinned', pid: 1, irrelevantReasons: reasons }),
        row({ sessionId: 'inline', pid: 2, irrelevantReasons: reasons }),
        row({ sessionId: 'gone', pid: 3, irrelevantReasons: reasons })
      ])
    )
    kill.mockResolvedValue({ ok: true, method: 'pty' })
    render(<HeaderSessionProfiler />)
    const menu = await openPanel()

    for (const [id, reason] of [
      ['pinned', 'pinned on the board'],
      ['inline', 'open as a connection tab']
    ] as const) {
      const stop = within(within(menu).getByTestId(`session-profiler-row-${id}`)).getByTestId(
        'session-profiler-stop'
      )
      expect(stop).toBeDisabled()
      expect(stop.parentElement).toHaveAttribute('title', `Can't stop: ${reason}`)
    }
    const clear = within(menu).getByTestId('session-profiler-clear')
    expect(clear).toHaveTextContent('Clear 1 irrelevant')
    fireEvent.click(clear)
    fireEvent.click(await screen.findByTestId('session-profiler-clear-confirm'))
    await waitFor(() => expect(kill).toHaveBeenCalledTimes(1))
    expect(kill.mock.calls[0]?.[0].sessionId).toBe('gone')
  })

  it('keeps a paused turn (a wakeup is pending) out of the bulk clear', async () => {
    useWorktreeStatusStore.setState({
      sessionStatuses: {
        waiting: { status: 'completed', timestamp: Date.now(), completion: 'waiting' }
      }
    })
    const reasons: SessionProfilerSession['irrelevantReasons'] = ['idle']
    getSnapshot.mockResolvedValue(
      snapshot([
        row({ sessionId: 'waiting', pid: 1, irrelevantReasons: reasons }),
        // Main saw the pause before the renderer did.
        row({ sessionId: 'main-paused', pid: 2, irrelevantReasons: reasons, paused: true }),
        row({ sessionId: 'gone', pid: 3, irrelevantReasons: reasons })
      ])
    )
    kill.mockResolvedValue({ ok: true, method: 'pty' })
    render(<HeaderSessionProfiler />)
    const menu = await openPanel()

    // A single Stop is still the user's call.
    expect(
      within(within(menu).getByTestId('session-profiler-row-waiting')).getByTestId(
        'session-profiler-stop'
      )
    ).toBeEnabled()
    const clear = within(menu).getByTestId('session-profiler-clear')
    expect(clear).toHaveTextContent('Clear 1 irrelevant')
    expect(menu).toHaveTextContent('2 kept')
    fireEvent.click(clear)
    fireEvent.click(await screen.findByTestId('session-profiler-clear-confirm'))
    await waitFor(() => expect(kill).toHaveBeenCalledTimes(1))
    expect(kill.mock.calls[0]?.[0].sessionId).toBe('gone')
  })

  it('does not lend the live session protection to an untracked process of the same session', async () => {
    useSessionStore.setState({ activeSessionId: 'live' })
    useWorktreeStatusStore.setState({
      sessionStatuses: { busy: { status: 'working', timestamp: Date.now() } }
    })
    getSnapshot.mockResolvedValue(
      snapshot([
        row({ sessionId: 'live', pid: 10, tracked: true }),
        row({ sessionId: 'live', pid: 11, tracked: false, irrelevantReasons: ['untracked'] }),
        row({ sessionId: 'busy', pid: 12, tracked: false, irrelevantReasons: ['untracked'] })
      ])
    )
    kill.mockResolvedValue({ ok: true, method: 'signal' })
    render(<HeaderSessionProfiler />)
    const menu = await openPanel()

    const items = within(menu).getAllByRole('listitem')
    const orphan = items.find((item) => item.textContent?.includes('pid 11')) as HTMLElement
    const live = items.find((item) => item.textContent?.includes('pid 10')) as HTMLElement
    expect(within(live).getByTestId('session-profiler-stop')).toBeDisabled()
    expect(within(orphan).getByTestId('session-profiler-stop')).toBeEnabled()
    const clear = within(menu).getByTestId('session-profiler-clear')
    expect(clear).toHaveTextContent('Clear 2 irrelevant')
    fireEvent.click(clear)
    fireEvent.click(await screen.findByTestId('session-profiler-clear-confirm'))
    await waitFor(() => expect(kill).toHaveBeenCalledTimes(2))
    expect(kill.mock.calls.map(([request]) => request.pid).sort()).toEqual([11, 12])
    expect(releaseSessionTerminal).not.toHaveBeenCalled()
  })

  it('re-checks each row right before its kill: one brought to the front mid-batch is kept', async () => {
    const reasons: SessionProfilerSession['irrelevantReasons'] = ['idle']
    getSnapshot.mockResolvedValue(
      snapshot(
        ['a', 'b', 'c', 'd'].map((id, i) =>
          row({ sessionId: id, pid: i + 1, irrelevantReasons: reasons })
        )
      )
    )
    const pending: Array<() => void> = []
    kill.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() => resolve({ ok: true, method: 'pty' }))
        })
    )
    render(<HeaderSessionProfiler />)
    const menu = await openPanel()
    fireEvent.click(within(menu).getByTestId('session-profiler-clear'))
    fireEvent.click(await screen.findByTestId('session-profiler-clear-confirm'))
    // Three at once; 'd' waits for a slot.
    await waitFor(() => expect(kill).toHaveBeenCalledTimes(3))

    act(() => useSessionStore.setState({ activeSessionId: 'd' }))
    await act(async () => {
      for (const resolve of pending) resolve()
    })
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(kill).toHaveBeenCalledTimes(3)
    expect(kill.mock.calls.map(([request]) => request.sessionId)).not.toContain('d')
    expect(releaseSessionTerminal).not.toHaveBeenCalledWith('d')
    expect(toast.success).toHaveBeenCalledWith(
      'Stopped 3 sessions, kept 1 (active tab)',
      expect.anything()
    )
  })

  it('does not sample again when a stop settles after the setting was turned off', async () => {
    getSnapshot.mockResolvedValue(snapshot([row({ irrelevantReasons: ['idle'] })]))
    let finishKill: () => void = () => {}
    kill.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishKill = () => resolve({ ok: true, method: 'signal' })
        })
    )
    render(<HeaderSessionProfiler />)
    const menu = await openPanel()
    await waitFor(() => expect(getSnapshot).toHaveBeenCalled())
    fireEvent.click(within(menu).getByTestId('session-profiler-stop'))
    await waitFor(() => expect(kill).toHaveBeenCalledTimes(1))
    await act(async () => {})
    const calls = getSnapshot.mock.calls.length

    act(() => setEnabled(false))
    await act(async () => {
      finishKill()
    })
    await act(async () => {})
    expect(getSnapshot).toHaveBeenCalledTimes(calls)
  })

  it('opens from the keyboard with focus inside the panel, and Escape returns it to the chip', async () => {
    getSnapshot.mockResolvedValue(snapshot([row({ irrelevantReasons: ['idle'] })]))
    render(<HeaderSessionProfiler />)
    const chip = await screen.findByTestId('session-profiler-chip')
    act(() => chip.focus())
    fireEvent.keyDown(chip, { key: 'Enter' })
    fireEvent.click(chip)
    const menu = await screen.findByTestId('session-profiler-menu')
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true))
    expect(within(menu).getByTestId('session-profiler-refresh')).toBe(document.activeElement)
    // The Stop and Clear controls follow in the panel's own order.
    const focusable = within(menu)
      .getAllByRole('button')
      .filter((button) => !button.hasAttribute('disabled'))
    expect(focusable.map((button) => button.getAttribute('data-testid'))).toEqual([
      'session-profiler-refresh',
      'session-profiler-stop',
      'session-profiler-clear'
    ])

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('session-profiler-menu')).toBeNull())
    expect(document.activeElement).toBe(chip)
  })

  it('opens from the keyboard with ArrowDown', async () => {
    getSnapshot.mockResolvedValue(snapshot([row()]))
    render(<HeaderSessionProfiler />)
    const chip = await screen.findByTestId('session-profiler-chip')
    act(() => chip.focus())
    fireEvent.keyDown(chip, { key: 'ArrowDown' })
    const menu = await screen.findByTestId('session-profiler-menu')
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true))
  })

  it('reports partial failures of a bulk clear', async () => {
    const reasons: SessionProfilerSession['irrelevantReasons'] = ['no_session_row']
    getSnapshot.mockResolvedValue(
      snapshot([
        row({ sessionId: 'ok', pid: 1, irrelevantReasons: reasons }),
        row({ sessionId: 'no', pid: 2, name: 'Stubborn', irrelevantReasons: reasons })
      ])
    )
    kill.mockImplementation(async (request) =>
      request.sessionId === 'no' ? { ok: false, error: 'permission denied' } : { ok: true }
    )
    render(<HeaderSessionProfiler />)
    const menu = await openPanel()
    fireEvent.click(within(menu).getByTestId('session-profiler-clear'))
    fireEvent.click(await screen.findByTestId('session-profiler-clear-confirm'))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Stopped 1 of 2 sessions', {
        description: 'Stubborn: permission denied'
      })
    )
  })

  it('shows a failed sample on the chip and in the panel', async () => {
    getSnapshot.mockRejectedValue(new Error('ps timed out'))
    render(<HeaderSessionProfiler />)
    const chip = await screen.findByTestId('session-profiler-chip')
    expect(screen.getByTestId('session-profiler-count')).toHaveTextContent('!')
    expect(chip).toHaveAttribute('aria-label', 'Agent sessions: could not sample')
    const menu = await openPanel()
    expect(within(menu).getByTestId('session-profiler-error')).toHaveTextContent('ps timed out')
  })
})
