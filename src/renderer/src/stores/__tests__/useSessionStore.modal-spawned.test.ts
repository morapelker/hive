/**
 * A ticket modal (or tiled slot) mounting a session whose agent CLI is not
 * running spawns `claude --resume`. While a live ticket rides the session the
 * process is that ticket's, and only entering done or merged ends it. Without
 * one nothing owns the process, so the last release kills it — after a grace
 * window, and only while no tab, work or newer mount took the session over.
 * The row stays active throughout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket, Session } from '../../../../main/db/types'

const { sessionGet, sessionUpdate, terminalDestroy, rpcRequest } = vi.hoisted(() => ({
  sessionGet: vi.fn(),
  sessionUpdate: vi.fn(),
  terminalDestroy: vi.fn(),
  rpcRequest: vi.fn()
}))

vi.mock('@/api/db-api', () => ({
  dbApi: {
    session: {
      get: sessionGet,
      update: sessionUpdate
    }
  }
}))

vi.mock('@/api/terminal-api', () => ({
  terminalApi: {
    destroy: terminalDestroy
  }
}))

vi.mock('@/api/rpc-client', () => ({
  getRendererRpcClient: () => ({ request: rpcRequest, subscribe: () => () => {} })
}))

import { MODAL_SPAWNED_RELEASE_GRACE_MS, useSessionStore } from '../useSessionStore'
import { useWorktreeStatusStore } from '../useWorktreeStatusStore'
import { useKanbanStore } from '../useKanbanStore'

const initialSessionState = useSessionStore.getState()
const initialStatusState = useWorktreeStatusStore.getState()
const initialKanbanState = useKanbanStore.getState()

const SESSION_ID = 'sess-review-1'

function makeDbSession(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION_ID,
    worktree_id: 'worktree-1',
    project_id: 'project-1',
    connection_id: null,
    name: 'Session',
    status: 'active',
    opencode_session_id: null,
    claude_session_id: 'claude-1',
    agent_sdk: 'claude-code-cli',
    mode: 'build',
    session_type: 'default',
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    remote_launch: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    pinned_to_board: false,
    ...overrides
  } as Session
}

/** The tickets the database links to the session (kanban.ticket.getBySession). */
let linkedTickets: Partial<KanbanTicket>[] = []

function liveIds(ids: string[]): void {
  rpcRequest.mockImplementation(async (method: string) => {
    if (method === 'terminalOps.getLiveTerminalIds') return { terminalIds: ids }
    if (method === 'kanban.ticket.getBySession') return linkedTickets
    throw new Error(`unexpected RPC ${method}`)
  })
}

function linkTicket(overrides: Partial<KanbanTicket> = {}): Partial<KanbanTicket> {
  return {
    id: 'ticket-1',
    column: 'review',
    current_session_id: SESSION_ID,
    awaiting_completion: false,
    archived_at: null,
    ...overrides
  }
}

/** Let the provenance probe's RPC answer land. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

/** Open a modal slot on the session: one mount request plus the probe. */
async function openModal(): Promise<void> {
  useSessionStore.getState().requestSessionMount(SESSION_ID)
  await settle()
}

/** Close the modal slot the way ClaudeCliPortalSlot does. */
function closeModal(): Promise<void> {
  useSessionStore.getState().releaseSessionMount(SESSION_ID)
  return useSessionStore.getState().destroyCompletedSessionTerminal(SESSION_ID)
}

async function closeModalAndWaitOutGrace(): Promise<void> {
  const releasing = closeModal()
  await vi.advanceTimersByTimeAsync(MODAL_SPAWNED_RELEASE_GRACE_MS)
  await releasing
}

const isFlagged = (): boolean => useSessionStore.getState().modalSpawnedSessionIds.has(SESSION_ID)

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  sessionGet.mockResolvedValue(makeDbSession())
  terminalDestroy.mockResolvedValue({ success: true, value: undefined })
  sessionUpdate.mockResolvedValue(makeDbSession({ status: 'completed' }))
  linkedTickets = []
  liveIds([])
})

afterEach(() => {
  vi.useRealTimers()
  useSessionStore.setState(initialSessionState, true)
  useWorktreeStatusStore.setState(initialStatusState, true)
  useKanbanStore.setState(initialKanbanState, true)
})

describe('modal-spawned provenance', () => {
  it('marks a session whose process is not alive when the first mount request arrives', async () => {
    await openModal()

    expect(rpcRequest).toHaveBeenCalledWith('terminalOps.getLiveTerminalIds', {})
    expect(isFlagged()).toBe(true)
  })

  it('does not mark a session whose PTY is already live (a background tab owns it)', async () => {
    liveIds([SESSION_ID])

    await openModal()

    expect(isFlagged()).toBe(false)
  })

  it('does not probe a session whose view is already mounted in the keep-alive pool', async () => {
    useSessionStore.getState().setMountedTerminalMirror([SESSION_ID])

    await openModal()

    expect(rpcRequest).not.toHaveBeenCalled()
    expect(isFlagged()).toBe(false)
  })

  it('does not probe the active session', async () => {
    useSessionStore.setState({ activeSessionId: SESSION_ID })

    await openModal()

    expect(rpcRequest).not.toHaveBeenCalled()
    expect(isFlagged()).toBe(false)
  })

  it('does not probe a known session that is not an agent CLI (shell commands never spawn on mount)', async () => {
    useSessionStore.setState({
      sessionsByWorktree: new Map([
        ['worktree-1', [makeDbSession({ agent_sdk: 'terminal', session_type: 'shell-command' })]]
      ])
    })

    await openModal()

    expect(rpcRequest).not.toHaveBeenCalled()
  })

  it('probes only on the first of several mount requests', async () => {
    await openModal()
    await openModal()

    expect(rpcRequest).toHaveBeenCalledTimes(1)
  })

  it('stays unmarked when the liveness lookup fails (fail-safe)', async () => {
    rpcRequest.mockRejectedValue(new Error('rpc down'))

    await openModal()

    expect(isFlagged()).toBe(false)
  })

  it('drops the mark once the session is shown in a tab', async () => {
    await openModal()
    expect(isFlagged()).toBe(true)

    useSessionStore.getState().setActiveSession(SESSION_ID)

    expect(isFlagged()).toBe(false)
  })

  // A ticket launch queues its prompt and flips the status to working before
  // its createClaudeCli lands; a modal open on that ticket meanwhile only
  // re-attaches to the launch's process.
  it('does not mark a session whose launch queued a prompt that is not delivered yet', async () => {
    useSessionStore.setState({ pendingMessages: new Map([[SESSION_ID, 'implement it']]) })

    await openModal()

    expect(rpcRequest).not.toHaveBeenCalled()
    expect(isFlagged()).toBe(false)
  })

  it('does not mark a session with a follow-up queued for it', async () => {
    useSessionStore.getState().enqueueFollowUpMessage(SESSION_ID, 'and then this')

    await openModal()

    expect(isFlagged()).toBe(false)
  })

  it('does not mark a session a launch flipped to working while the probe was in flight', async () => {
    let answer: (value: { terminalIds: string[] }) => void = () => {}
    rpcRequest.mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    useSessionStore.getState().requestSessionMount(SESSION_ID)

    useWorktreeStatusStore.getState().setSessionStatus(SESSION_ID, 'working')
    answer({ terminalIds: [] })
    await settle()

    expect(isFlagged()).toBe(false)
  })

  it('does not mark a session whose launch queued its prompt while the probe was in flight', async () => {
    let answer: (value: { terminalIds: string[] }) => void = () => {}
    rpcRequest.mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    useSessionStore.getState().requestSessionMount(SESSION_ID)

    useSessionStore.setState({ pendingMessages: new Map([[SESSION_ID, 'implement it']]) })
    answer({ terminalIds: [] })
    await settle()

    expect(isFlagged()).toBe(false)
  })

  it('ignores a probe answer that lands after the session was activated', async () => {
    let answer: (value: { terminalIds: string[] }) => void = () => {}
    rpcRequest.mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    useSessionStore.getState().requestSessionMount(SESSION_ID)

    useSessionStore.setState({ activeSessionId: SESSION_ID })
    answer({ terminalIds: [] })
    await settle()

    expect(isFlagged()).toBe(false)
  })
})

describe('destroyCompletedSessionTerminal — modal-spawned release', () => {
  it('kills the modal-spawned process after the grace window, leaving the row and tabs alone', async () => {
    useSessionStore.setState({
      sessionsByWorktree: new Map([['worktree-1', [makeDbSession()]]]),
      tabOrderByWorktree: new Map([['worktree-1', [SESSION_ID]]])
    })
    await openModal()

    const releasing = closeModal()
    await vi.advanceTimersByTimeAsync(MODAL_SPAWNED_RELEASE_GRACE_MS - 1)
    expect(terminalDestroy).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await releasing

    expect(terminalDestroy).toHaveBeenCalledWith(SESSION_ID)
    const state = useSessionStore.getState()
    expect(state.closedTerminalSessionIds.has(SESSION_ID)).toBe(true)
    expect(isFlagged()).toBe(false)
    expect(sessionUpdate).not.toHaveBeenCalled()
    expect(state.sessionsByWorktree.get('worktree-1')?.map((s) => s.id)).toEqual([SESSION_ID])
    expect(state.tabOrderByWorktree.get('worktree-1')).toEqual([SESSION_ID])
  })

  it('leaves a process alone that was already live when the modal opened', async () => {
    liveIds([SESSION_ID])
    await openModal()

    await closeModal()

    expect(terminalDestroy).not.toHaveBeenCalled()
  })

  it('waits for an in-flight probe when the modal closes right after opening', async () => {
    let answer: (value: { terminalIds: string[] }) => void = () => {}
    rpcRequest.mockImplementation((method: string) =>
      method === 'terminalOps.getLiveTerminalIds'
        ? new Promise((resolve) => (answer = resolve))
        : Promise.resolve(linkedTickets)
    )
    useSessionStore.getState().requestSessionMount(SESSION_ID)

    const releasing = closeModal()
    answer({ terminalIds: [] })
    await vi.advanceTimersByTimeAsync(MODAL_SPAWNED_RELEASE_GRACE_MS)
    await releasing

    expect(terminalDestroy).toHaveBeenCalledWith(SESSION_ID)
  })

  it('re-attaches instead of killing when the modal re-opens within the grace window', async () => {
    await openModal()
    const firstRelease = closeModal()
    await vi.advanceTimersByTimeAsync(MODAL_SPAWNED_RELEASE_GRACE_MS / 2)

    await openModal()
    await vi.advanceTimersByTimeAsync(MODAL_SPAWNED_RELEASE_GRACE_MS)
    await firstRelease

    expect(terminalDestroy).not.toHaveBeenCalled()
    // Still marked: the re-opened modal's release owns the cleanup now
    expect(isFlagged()).toBe(true)

    await closeModalAndWaitOutGrace()

    expect(terminalDestroy).toHaveBeenCalledTimes(1)
  })

  it('lets only the newest of overlapping releases act', async () => {
    await openModal()
    const firstRelease = closeModal()
    await vi.advanceTimersByTimeAsync(MODAL_SPAWNED_RELEASE_GRACE_MS / 2)
    await openModal()
    const secondRelease = closeModal()

    // The first window has elapsed, the second has not
    await vi.advanceTimersByTimeAsync(MODAL_SPAWNED_RELEASE_GRACE_MS / 2)
    await firstRelease
    expect(terminalDestroy).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(MODAL_SPAWNED_RELEASE_GRACE_MS / 2)
    await secondRelease
    expect(terminalDestroy).toHaveBeenCalledTimes(1)
  })

  it('keeps the process once the user navigated to the session (tab owns it now)', async () => {
    await openModal()
    useSessionStore.getState().setActiveSession(SESSION_ID)
    // ...and moved on to another tab before closing the modal
    useSessionStore.getState().setActiveSession('another-session')

    await closeModalAndWaitOutGrace()

    expect(terminalDestroy).not.toHaveBeenCalled()
  })

  it('keeps the process when the session is shown on the pinned board view', async () => {
    await openModal()
    const releasing = closeModal()
    useSessionStore.setState({ activePinnedSessionId: SESSION_ID })
    await vi.advanceTimersByTimeAsync(MODAL_SPAWNED_RELEASE_GRACE_MS)
    await releasing

    expect(terminalDestroy).not.toHaveBeenCalled()
  })

  it.each([
    ['working', { status: 'working' as const }],
    ['awaiting a permission answer', { status: 'permission' as const }],
    ['holding a plan for approval', { status: 'plan_ready' as const }],
    [
      'paused on a scheduled wakeup',
      { status: 'completed' as const, completion: 'waiting' as const, pendingWakeups: 1 }
    ],
    [
      'paused (waiting completion)',
      { status: 'completed' as const, completion: 'waiting' as const }
    ],
    ['done but with a wakeup pending', { status: 'unread' as const, pendingWakeups: 2 }]
  ])('keeps the process while the session is %s', async (_label, entry) => {
    await openModal()
    useWorktreeStatusStore.setState({
      sessionStatuses: { [SESSION_ID]: { ...entry, timestamp: Date.now() } }
    })

    await closeModalAndWaitOutGrace()

    expect(terminalDestroy).not.toHaveBeenCalled()
  })

  it.each(['todo', 'in_progress', 'review'] as const)(
    'keeps the process while its ticket is live in %s',
    async (column) => {
      linkedTickets = [linkTicket({ column })]
      useWorktreeStatusStore.setState({
        sessionStatuses: {
          [SESSION_ID]: { status: 'completed', completion: 'completed', timestamp: Date.now() }
        }
      })
      await openModal()

      await closeModalAndWaitOutGrace()

      expect(terminalDestroy).not.toHaveBeenCalled()
      expect(useSessionStore.getState().closedTerminalSessionIds.has(SESSION_ID)).toBe(false)
    }
  )

  it('keeps the process of a ticket dragged out of Done into Review during the grace window', async () => {
    linkedTickets = [linkTicket({ column: 'done' })]
    await openModal()

    const releasing = closeModal()
    await vi.advanceTimersByTimeAsync(MODAL_SPAWNED_RELEASE_GRACE_MS - 1)
    linkedTickets = [linkTicket({ column: 'review' })]
    await vi.advanceTimersByTimeAsync(1)
    await releasing

    expect(terminalDestroy).not.toHaveBeenCalled()
  })

  it('kills the process of a ticket that entered Done during the grace window', async () => {
    linkedTickets = [linkTicket({ column: 'review' })]
    await openModal()

    const releasing = closeModal()
    await vi.advanceTimersByTimeAsync(MODAL_SPAWNED_RELEASE_GRACE_MS - 1)
    linkedTickets = [linkTicket({ column: 'done' })]
    await vi.advanceTimersByTimeAsync(1)
    await releasing

    expect(terminalDestroy).toHaveBeenCalledWith(SESSION_ID)
  })

  it('keeps the process through every later open and close of a Review ticket', async () => {
    linkedTickets = [linkTicket()]
    await openModal()
    await closeModalAndWaitOutGrace()

    await openModal()
    await closeModalAndWaitOutGrace()

    expect(terminalDestroy).not.toHaveBeenCalled()
  })

  it('keeps the process while any one of the tickets riding the session is live', async () => {
    linkedTickets = [
      linkTicket({ id: 'ticket-done', column: 'done' }),
      linkTicket({ id: 'ticket-live', column: 'review' })
    ]
    await openModal()

    await closeModalAndWaitOutGrace()

    expect(terminalDestroy).not.toHaveBeenCalled()
  })

  it('keeps the process when the ticket links cannot be read (fail-safe)', async () => {
    await openModal()
    rpcRequest.mockRejectedValue(new Error('rpc down'))

    await closeModalAndWaitOutGrace()

    expect(terminalDestroy).not.toHaveBeenCalled()
  })

  it.each(['done', 'merged'] as const)(
    'still kills the process once its ticket is settled in %s',
    async (column) => {
      linkedTickets = [linkTicket({ column })]
      await openModal()

      await closeModalAndWaitOutGrace()

      expect(terminalDestroy).toHaveBeenCalledWith(SESSION_ID)
    }
  )

  it('still kills the process of an archived ticket, whatever its column', async () => {
    linkedTickets = [linkTicket({ archived_at: '2026-01-02T00:00:00.000Z' })]
    await openModal()

    await closeModalAndWaitOutGrace()

    expect(terminalDestroy).toHaveBeenCalledWith(SESSION_ID)
  })

  it('keeps the process while background work is running', async () => {
    await openModal()
    useWorktreeStatusStore.getState().setSessionBackgroundWork(SESSION_ID, {
      runningShells: 0,
      runningMonitors: 1,
      runningSubagents: 0
    })

    await closeModalAndWaitOutGrace()

    expect(terminalDestroy).not.toHaveBeenCalled()
  })

  it('keeps the process while a prompt or follow-up is queued for it', async () => {
    await openModal()
    useSessionStore.getState().enqueueFollowUpMessage(SESSION_ID, 'and then this')

    await closeModalAndWaitOutGrace()

    expect(terminalDestroy).not.toHaveBeenCalled()
  })

  it('does not kill a modal-spawned session whose row is gone', async () => {
    await openModal()
    sessionGet.mockResolvedValue(null)

    await closeModalAndWaitOutGrace()

    expect(terminalDestroy).not.toHaveBeenCalled()
  })

  it('still kills a completed (Done ticket) session, after the grace window when the modal spawned it', async () => {
    sessionGet.mockResolvedValue(makeDbSession({ status: 'completed' }))
    await openModal()

    await closeModalAndWaitOutGrace()

    expect(terminalDestroy).toHaveBeenCalledWith(SESSION_ID)
  })
})

describe('closeSession and releaseSessionTerminal clear the mark', () => {
  it('closeSession drops the mark', async () => {
    await openModal()

    await useSessionStore.getState().closeSession(SESSION_ID)

    expect(isFlagged()).toBe(false)
  })

  it('releaseSessionTerminal unmounts the view without touching the row or the tabs', async () => {
    useSessionStore.setState({
      sessionsByWorktree: new Map([['worktree-1', [makeDbSession()]]]),
      tabOrderByWorktree: new Map([['worktree-1', [SESSION_ID]]])
    })
    await openModal()
    useSessionStore.getState().releaseSessionMount(SESSION_ID)

    expect(useSessionStore.getState().releaseSessionTerminal(SESSION_ID)).toBe(true)

    const state = useSessionStore.getState()
    expect(state.closedTerminalSessionIds.has(SESSION_ID)).toBe(true)
    expect(isFlagged()).toBe(false)
    expect(state.sessionsByWorktree.get('worktree-1')?.map((s) => s.id)).toEqual([SESSION_ID])
    expect(state.tabOrderByWorktree.get('worktree-1')).toEqual([SESSION_ID])
    expect(sessionUpdate).not.toHaveBeenCalled()
    expect(terminalDestroy).not.toHaveBeenCalled()
  })

  it('releaseSessionTerminal works for a session the store never loaded', () => {
    useSessionStore.getState().releaseSessionTerminal('unknown-session')

    expect(useSessionStore.getState().closedTerminalSessionIds.has('unknown-session')).toBe(true)
  })

  // Pruning a shown view blanks the pane, and the still-activated session
  // would remount on the next MainPane recompute — respawning the process.
  it.each([
    ['the active tab', { activeSessionId: SESSION_ID }],
    ['the pinned board session', { activePinnedSessionId: SESSION_ID }],
    ['the inline connection tab', { inlineConnectionSessionId: SESSION_ID }],
    ['held by an open modal', { sessionMountRequests: new Map([[SESSION_ID, 1]]) }]
  ])('releaseSessionTerminal keeps a view that is %s mounted', (_label, shown) => {
    useSessionStore.setState({
      ...shown,
      modalSpawnedSessionIds: new Set([SESSION_ID])
    })

    expect(useSessionStore.getState().releaseSessionTerminal(SESSION_ID)).toBe(false)

    const state = useSessionStore.getState()
    expect(state.closedTerminalSessionIds.has(SESSION_ID)).toBe(false)
    // The process is gone either way: no modal release may act on it any more
    expect(isFlagged()).toBe(false)
  })
})
