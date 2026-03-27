import { describe, test, expect, beforeEach, vi } from 'vitest'
import { act } from '@testing-library/react'
import type { KanbanTicket } from '../../../src/main/db/types'

// ── Mock window.kanban BEFORE importing stores ──────────────────────
const mockKanban = {
  ticket: {
    create: vi.fn(),
    get: vi.fn(),
    getByProject: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    move: vi.fn().mockResolvedValue(undefined),
    reorder: vi.fn().mockResolvedValue(undefined),
    getBySession: vi.fn().mockResolvedValue([])
  },
  simpleMode: {
    toggle: vi.fn().mockResolvedValue(undefined)
  }
}

Object.defineProperty(window, 'kanban', {
  writable: true,
  configurable: true,
  value: mockKanban
})

// ── Import stores AFTER mocking ─────────────────────────────────────
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

// ── (Component rendering tested in S6 — E2E focuses on store integration) ──

// ── Import coordination ─────────────────────────────────────────────
import { notifyKanbanSessionSync } from '@/stores/store-coordination'

// ── Helpers ─────────────────────────────────────────────────────────
function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: overrides.id ?? 'ticket-1',
    project_id: overrides.project_id ?? 'proj-1',
    title: overrides.title ?? 'Test Ticket',
    description: overrides.description ?? null,
    attachments: overrides.attachments ?? [],
    column: overrides.column ?? 'todo',
    sort_order: overrides.sort_order ?? 0,
    current_session_id: overrides.current_session_id ?? null,
    worktree_id: overrides.worktree_id ?? null,
    mode: overrides.mode ?? null,
    plan_ready: overrides.plan_ready ?? false,
    created_at: overrides.created_at ?? '2026-01-01T00:00:00Z',
    updated_at: overrides.updated_at ?? '2026-01-01T00:00:00Z'
  }
}

/** Flush all microtasks so optimistic updates + IPC settle */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

function getTicket(projectId: string, ticketId: string): KanbanTicket | undefined {
  return useKanbanStore
    .getState()
    .tickets.get(projectId)
    ?.find((t) => t.id === ticketId)
}

// ── Setup ───────────────────────────────────────────────────────────
describe('Session 14: E2E Integration', () => {
  beforeEach(() => {
    // Reset kanban store state
    act(() => {
      useKanbanStore.setState({
        tickets: new Map(),
        isLoading: false,
        isBoardViewActive: false,
        simpleModeByProject: {},
        selectedTicketId: null
      })
    })

    // Reset session store
    act(() => {
      useSessionStore.setState({
        activeSessionId: null,
        isLoading: false,
        sessionsByWorktree: new Map(),
        sessionsByConnection: new Map(),
        closedTerminalSessionIds: new Set(),
        inlineConnectionSessionId: null
      })
    })

    // Reset worktree store
    act(() => {
      useWorktreeStore.setState({
        selectedWorktreeId: null,
        worktreesByProject: new Map()
      })
    })

    // Reset all mocks
    vi.clearAllMocks()
    mockKanban.ticket.create.mockImplementation(async (data) => ({
      id: `ticket-${Date.now()}`,
      project_id: data.project_id,
      title: data.title,
      description: data.description ?? null,
      attachments: data.attachments ?? [],
      column: 'todo',
      sort_order: 0,
      current_session_id: null,
      worktree_id: null,
      mode: null,
      plan_ready: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }))
    mockKanban.ticket.update.mockResolvedValue(undefined)
    mockKanban.ticket.move.mockResolvedValue(undefined)
    mockKanban.ticket.delete.mockResolvedValue(undefined)
    mockKanban.ticket.reorder.mockResolvedValue(undefined)
    mockKanban.ticket.getByProject.mockResolvedValue([])
    mockKanban.ticket.getBySession.mockResolvedValue([])
    mockKanban.simpleMode.toggle.mockResolvedValue(undefined)
  })

  // ──────────────────────────────────────────────────────────────────
  // 1. Full build lifecycle: todo → in_progress → review → done
  // ──────────────────────────────────────────────────────────────────
  test('full build lifecycle: todo → in_progress → review → done', async () => {
    // Step 1: Create a ticket in 'todo'
    const ticket = makeTicket({
      id: 't-build-1',
      column: 'todo',
      sort_order: 0
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    // Step 2: Move ticket to 'in_progress' (simulates drag-drop)
    await act(async () => {
      await useKanbanStore.getState().moveTicket('t-build-1', 'proj-1', 'in_progress', 0)
      await flush()
    })

    let t = getTicket('proj-1', 't-build-1')
    expect(t!.column).toBe('in_progress')
    expect(mockKanban.ticket.move).toHaveBeenCalledWith('t-build-1', 'in_progress', 0)

    // Step 3: Attach a session + set mode to build (simulates WorktreePickerModal send)
    await act(async () => {
      await useKanbanStore
        .getState()
        .updateTicket('t-build-1', 'proj-1', {
          current_session_id: 'session-build-1',
          worktree_id: 'wt-1',
          mode: 'build'
        })
      await flush()
    })

    t = getTicket('proj-1', 't-build-1')
    expect(t!.current_session_id).toBe('session-build-1')
    expect(t!.mode).toBe('build')

    // Step 4: Session completes → ticket auto-advances to 'review'
    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-build-1', {
        type: 'session_completed',
        sessionMode: 'build'
      })
      await flush()
    })

    t = getTicket('proj-1', 't-build-1')
    expect(t!.column).toBe('review')

    // Step 5: Send a followup → ticket back to 'in_progress'
    await act(async () => {
      await useKanbanStore.getState().moveTicket('t-build-1', 'proj-1', 'in_progress', 0)
      await flush()
    })

    t = getTicket('proj-1', 't-build-1')
    expect(t!.column).toBe('in_progress')

    // Step 6: Session completes again → auto-advance to 'review'
    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-build-1', {
        type: 'session_completed',
        sessionMode: 'build'
      })
      await flush()
    })

    t = getTicket('proj-1', 't-build-1')
    expect(t!.column).toBe('review')

    // Step 7: Drag ticket to 'done'
    await act(async () => {
      await useKanbanStore.getState().moveTicket('t-build-1', 'proj-1', 'done', 0)
      await flush()
    })

    t = getTicket('proj-1', 't-build-1')
    expect(t!.column).toBe('done')

    // Verify IPC calls were made for each move
    const moveCalls = mockKanban.ticket.move.mock.calls
    expect(moveCalls.length).toBeGreaterThanOrEqual(4)
  })

  // ──────────────────────────────────────────────────────────────────
  // 2. Full plan lifecycle: todo → in_progress → plan_ready →
  //    supercharge → review → done
  // ──────────────────────────────────────────────────────────────────
  test('full plan lifecycle: todo → in_progress → plan_ready → supercharge → review → done', async () => {
    // Step 1: Start with ticket in in_progress with plan mode
    const ticket = makeTicket({
      id: 't-plan-1',
      column: 'in_progress',
      current_session_id: 'session-plan-1',
      worktree_id: 'wt-1',
      mode: 'plan',
      sort_order: 0
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    // Step 2: Plan session completes → plan_ready = true, stays in in_progress
    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-plan-1', {
        type: 'session_completed',
        sessionMode: 'plan'
      })
      await flush()
    })

    let t = getTicket('proj-1', 't-plan-1')
    expect(t!.plan_ready).toBe(true)
    expect(t!.column).toBe('in_progress')
    expect(mockKanban.ticket.update).toHaveBeenCalledWith('t-plan-1', { plan_ready: true })
    // Should NOT have moved
    expect(mockKanban.ticket.move).not.toHaveBeenCalled()

    // Step 3: Supercharge → new session replaces old, plan_ready resets
    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-plan-1', {
        type: 'supercharge',
        newSessionId: 'session-build-2'
      })
      await flush()
    })

    t = getTicket('proj-1', 't-plan-1')
    expect(t!.current_session_id).toBe('session-build-2')
    expect(t!.plan_ready).toBe(false)
    expect(t!.mode).toBe('build')
    expect(mockKanban.ticket.update).toHaveBeenCalledWith('t-plan-1', {
      current_session_id: 'session-build-2',
      plan_ready: false,
      mode: 'build'
    })

    // Step 4: New build session completes → auto-advance to review
    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-build-2', {
        type: 'session_completed',
        sessionMode: 'build'
      })
      await flush()
    })

    t = getTicket('proj-1', 't-plan-1')
    expect(t!.column).toBe('review')

    // Step 5: Drag to done
    await act(async () => {
      await useKanbanStore.getState().moveTicket('t-plan-1', 'proj-1', 'done', 0)
      await flush()
    })

    t = getTicket('proj-1', 't-plan-1')
    expect(t!.column).toBe('done')
  })

  // ──────────────────────────────────────────────────────────────────
  // 3. Simple ticket lifecycle: todo → in_progress (simple) →
  //    assign worktree → flow
  // ──────────────────────────────────────────────────────────────────
  test('simple ticket lifecycle: todo → in_progress (simple) → assign worktree → flow', async () => {
    // Step 1: Enable simple mode
    await act(async () => {
      await useKanbanStore.getState().setSimpleMode('proj-1', true)
    })
    expect(useKanbanStore.getState().simpleModeByProject['proj-1']).toBe(true)
    expect(mockKanban.simpleMode.toggle).toHaveBeenCalledWith('proj-1', true)

    // Step 2: Create ticket in todo
    const ticket = makeTicket({
      id: 't-simple-1',
      column: 'todo',
      sort_order: 0
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    // Step 3: Move to in_progress (simple mode — no worktree picker)
    await act(async () => {
      await useKanbanStore.getState().moveTicket('t-simple-1', 'proj-1', 'in_progress', 0)
      await flush()
    })

    let t = getTicket('proj-1', 't-simple-1')
    expect(t!.column).toBe('in_progress')
    // No session or worktree attached yet (simple mode direct drop)
    expect(t!.current_session_id).toBeNull()
    expect(t!.worktree_id).toBeNull()

    // Step 4: "Assign to worktree" via context menu — update ticket with session
    await act(async () => {
      await useKanbanStore
        .getState()
        .updateTicket('t-simple-1', 'proj-1', {
          current_session_id: 'session-simple-1',
          worktree_id: 'wt-1',
          mode: 'build'
        })
      await flush()
    })

    t = getTicket('proj-1', 't-simple-1')
    expect(t!.current_session_id).toBe('session-simple-1')
    expect(t!.worktree_id).toBe('wt-1')
    expect(t!.mode).toBe('build')

    // Step 5: Session completes → auto-advance to review
    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-simple-1', {
        type: 'session_completed',
        sessionMode: 'build'
      })
      await flush()
    })

    t = getTicket('proj-1', 't-simple-1')
    expect(t!.column).toBe('review')

    // Step 6: Move manually through remaining columns
    await act(async () => {
      await useKanbanStore.getState().moveTicket('t-simple-1', 'proj-1', 'done', 0)
      await flush()
    })

    t = getTicket('proj-1', 't-simple-1')
    expect(t!.column).toBe('done')
  })

  // ──────────────────────────────────────────────────────────────────
  // 4. Multiple tickets on same worktree advance independently
  // ──────────────────────────────────────────────────────────────────
  test('multiple tickets on same worktree advance independently', async () => {
    const ticketA = makeTicket({
      id: 'tA',
      column: 'in_progress',
      current_session_id: 'session-A',
      worktree_id: 'wt-shared',
      mode: 'build',
      sort_order: 0
    })
    const ticketB = makeTicket({
      id: 'tB',
      column: 'in_progress',
      current_session_id: 'session-B',
      worktree_id: 'wt-shared',
      mode: 'build',
      sort_order: 1
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticketA, ticketB]]])
      })
    })

    // Session-A completes first — only ticketA should advance
    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-A', {
        type: 'session_completed',
        sessionMode: 'build'
      })
      await flush()
    })

    expect(getTicket('proj-1', 'tA')!.column).toBe('review')
    expect(getTicket('proj-1', 'tB')!.column).toBe('in_progress')

    // Session-B completes later — only ticketB should advance
    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-B', {
        type: 'session_completed',
        sessionMode: 'build'
      })
      await flush()
    })

    expect(getTicket('proj-1', 'tA')!.column).toBe('review')
    expect(getTicket('proj-1', 'tB')!.column).toBe('review')

    // Both can be moved to done independently
    await act(async () => {
      await useKanbanStore.getState().moveTicket('tA', 'proj-1', 'done', 0)
      await flush()
    })

    expect(getTicket('proj-1', 'tA')!.column).toBe('done')
    expect(getTicket('proj-1', 'tB')!.column).toBe('review')
  })

  // ──────────────────────────────────────────────────────────────────
  // 5. Jump to session sets correct worktree and session selection
  // ──────────────────────────────────────────────────────────────────
  test('jump to session sets correct worktree and session selection', () => {
    const ticket = makeTicket({
      id: 't-jump',
      column: 'in_progress',
      current_session_id: 'session-jump-1',
      worktree_id: 'wt-jump',
      mode: 'build'
    })

    // Set up ticket in store
    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]]),
        isBoardViewActive: true
      })
    })

    // Simulate "Jump to session" action:
    // 1. Disable board view
    // 2. Set active worktree (both UI selection and session store)
    // 3. Set active session
    act(() => {
      useKanbanStore.getState().toggleBoardView()
      useWorktreeStore.getState().selectWorktree('wt-jump')
      useSessionStore.getState().setActiveWorktree('wt-jump')
      useSessionStore.getState().setActiveSession('session-jump-1')
    })

    // Board view should be off
    expect(useKanbanStore.getState().isBoardViewActive).toBe(false)
    // Correct worktree selected
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-jump')
    // Session store worktree must be synced for session to render
    expect(useSessionStore.getState().activeWorktreeId).toBe('wt-jump')
    // Correct session selected
    expect(useSessionStore.getState().activeSessionId).toBe('session-jump-1')
  })

  // ──────────────────────────────────────────────────────────────────
  // 6. Toggling board view preserves ticket state
  // ──────────────────────────────────────────────────────────────────
  test('toggling board view preserves ticket state', () => {
    const tickets = [
      makeTicket({ id: 't1', column: 'todo', sort_order: 0 }),
      makeTicket({ id: 't2', column: 'in_progress', current_session_id: 's1', mode: 'build', sort_order: 0 }),
      makeTicket({ id: 't3', column: 'review', sort_order: 0 }),
      makeTicket({ id: 't4', column: 'done', sort_order: 0 })
    ]

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', tickets]]),
        isBoardViewActive: true
      })
    })

    // Toggle OFF
    act(() => {
      useKanbanStore.getState().toggleBoardView()
    })
    expect(useKanbanStore.getState().isBoardViewActive).toBe(false)

    // Verify all ticket data is intact
    const state = useKanbanStore.getState()
    const stored = state.tickets.get('proj-1')!
    expect(stored).toHaveLength(4)
    expect(stored.find((t) => t.id === 't1')!.column).toBe('todo')
    expect(stored.find((t) => t.id === 't2')!.column).toBe('in_progress')
    expect(stored.find((t) => t.id === 't2')!.current_session_id).toBe('s1')
    expect(stored.find((t) => t.id === 't3')!.column).toBe('review')
    expect(stored.find((t) => t.id === 't4')!.column).toBe('done')

    // Toggle back ON — same state
    act(() => {
      useKanbanStore.getState().toggleBoardView()
    })
    expect(useKanbanStore.getState().isBoardViewActive).toBe(true)

    const storedAgain = useKanbanStore.getState().tickets.get('proj-1')!
    expect(storedAgain).toHaveLength(4)
    expect(storedAgain.find((t) => t.id === 't2')!.current_session_id).toBe('s1')
  })

  // ──────────────────────────────────────────────────────────────────
  // 7. Session error sets error state without moving ticket
  // ──────────────────────────────────────────────────────────────────
  test('session error sets error state without moving ticket', async () => {
    const ticket = makeTicket({
      id: 't-err',
      column: 'in_progress',
      current_session_id: 'session-err-1',
      worktree_id: 'wt-1',
      mode: 'build',
      sort_order: 0
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    // Session errors
    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-err-1', {
        type: 'session_error'
      })
      await flush()
    })

    const t = getTicket('proj-1', 't-err')
    // Ticket stays in in_progress — no column change
    expect(t!.column).toBe('in_progress')
    // No IPC move or update calls
    expect(mockKanban.ticket.move).not.toHaveBeenCalled()
    expect(mockKanban.ticket.update).not.toHaveBeenCalled()
    // Session ID is preserved so error can be displayed
    expect(t!.current_session_id).toBe('session-err-1')
  })

  // ──────────────────────────────────────────────────────────────────
  // 8. Followup from error recovers ticket tracking
  // ──────────────────────────────────────────────────────────────────
  test('followup from error recovers ticket tracking', async () => {
    // Start with errored ticket
    const ticket = makeTicket({
      id: 't-recover',
      column: 'in_progress',
      current_session_id: 'session-recover-1',
      worktree_id: 'wt-1',
      mode: 'build',
      sort_order: 0
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    // Session errored (no state change)
    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-recover-1', {
        type: 'session_error'
      })
      await flush()
    })

    // Verify still in_progress
    expect(getTicket('proj-1', 't-recover')!.column).toBe('in_progress')

    // User sends followup → session recovers and completes
    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-recover-1', {
        type: 'session_completed',
        sessionMode: 'build'
      })
      await flush()
    })

    // Now ticket advances to review
    const t = getTicket('proj-1', 't-recover')
    expect(t!.column).toBe('review')
    expect(mockKanban.ticket.move).toHaveBeenCalledWith('t-recover', 'review', 0)
  })

  // ──────────────────────────────────────────────────────────────────
  // 9. Ticket attachment in normal view does not affect board state
  // ──────────────────────────────────────────────────────────────────
  test('ticket attachment in normal view does not affect board state', async () => {
    const tickets = [
      makeTicket({ id: 't-attach-1', column: 'todo', title: 'Design new feature', sort_order: 0 }),
      makeTicket({
        id: 't-attach-2',
        column: 'in_progress',
        title: 'Build API endpoint',
        current_session_id: 's-1',
        mode: 'build',
        sort_order: 0
      }),
      makeTicket({ id: 't-attach-3', column: 'review', title: 'Review PR', sort_order: 0 })
    ]

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', tickets]])
      })
    })

    // Take a snapshot of current ticket state
    const before = useKanbanStore
      .getState()
      .tickets.get('proj-1')!
      .map((t) => ({ id: t.id, column: t.column, current_session_id: t.current_session_id }))

    // Simulate "attach ticket" from normal view — read ticket data for AI context
    // This is a read-only operation on the kanban store
    const ticketForAttachment = getTicket('proj-1', 't-attach-1')
    expect(ticketForAttachment).toBeDefined()
    expect(ticketForAttachment!.title).toBe('Design new feature')

    // Verify NO kanban state was mutated
    const after = useKanbanStore
      .getState()
      .tickets.get('proj-1')!
      .map((t) => ({ id: t.id, column: t.column, current_session_id: t.current_session_id }))

    expect(after).toEqual(before)

    // No IPC calls were made to kanban APIs
    expect(mockKanban.ticket.move).not.toHaveBeenCalled()
    expect(mockKanban.ticket.update).not.toHaveBeenCalled()
    expect(mockKanban.ticket.delete).not.toHaveBeenCalled()
  })

  // ──────────────────────────────────────────────────────────────────
  // Cross-cutting: notifyKanbanSessionSync dispatches through
  // coordination layer to store
  // ──────────────────────────────────────────────────────────────────
  test('notifyKanbanSessionSync flows through coordination layer end-to-end', async () => {
    const ticket = makeTicket({
      id: 't-coord',
      column: 'in_progress',
      current_session_id: 'session-coord-1',
      worktree_id: 'wt-1',
      mode: 'build',
      sort_order: 0
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    // Use the coordination layer (not direct store call)
    await act(async () => {
      notifyKanbanSessionSync('session-coord-1', {
        type: 'session_completed',
        sessionMode: 'build'
      })
      await flush()
    })

    // Ticket should have advanced to review via the coordination callback
    const t = getTicket('proj-1', 't-coord')
    expect(t!.column).toBe('review')
  })

  // ──────────────────────────────────────────────────────────────────
  // Cross-cutting: getTicketsByColumn returns correct groupings
  // after lifecycle events
  // ──────────────────────────────────────────────────────────────────
  test('board renders tickets in correct columns after lifecycle events', async () => {
    const tickets = [
      makeTicket({ id: 't-todo', column: 'todo', title: 'Not started', sort_order: 0 }),
      makeTicket({
        id: 't-active',
        column: 'in_progress',
        title: 'Active build',
        current_session_id: 's-active',
        mode: 'build',
        sort_order: 0
      }),
      makeTicket({ id: 't-review', column: 'review', title: 'Needs review', sort_order: 0 }),
      makeTicket({ id: 't-done', column: 'done', title: 'Completed', sort_order: 0 })
    ]

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', tickets]])
      })
    })

    // Verify tickets grouped correctly by column
    const store = useKanbanStore.getState()
    expect(store.getTicketsByColumn('proj-1', 'todo')).toHaveLength(1)
    expect(store.getTicketsByColumn('proj-1', 'in_progress')).toHaveLength(1)
    expect(store.getTicketsByColumn('proj-1', 'review')).toHaveLength(1)
    expect(store.getTicketsByColumn('proj-1', 'done')).toHaveLength(1)

    expect(store.getTicketsByColumn('proj-1', 'todo')[0].id).toBe('t-todo')
    expect(store.getTicketsByColumn('proj-1', 'in_progress')[0].id).toBe('t-active')
    expect(store.getTicketsByColumn('proj-1', 'review')[0].id).toBe('t-review')
    expect(store.getTicketsByColumn('proj-1', 'done')[0].id).toBe('t-done')

    // Session completes on the active ticket
    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('s-active', {
        type: 'session_completed',
        sessionMode: 'build'
      })
      await flush()
    })

    // Ticket should have moved from in_progress to review
    const storeAfter = useKanbanStore.getState()
    expect(storeAfter.getTicketsByColumn('proj-1', 'in_progress')).toHaveLength(0)
    expect(storeAfter.getTicketsByColumn('proj-1', 'review')).toHaveLength(2)

    const reviewIds = storeAfter
      .getTicketsByColumn('proj-1', 'review')
      .map((t) => t.id)
    expect(reviewIds).toContain('t-active')
    expect(reviewIds).toContain('t-review')
  })

  // ──────────────────────────────────────────────────────────────────
  // Data integrity: create → update → delete lifecycle
  // ──────────────────────────────────────────────────────────────────
  test('create → update → delete lifecycle maintains data integrity', async () => {
    // Create a ticket
    const createdTicket = makeTicket({
      id: 't-crud',
      title: 'CRUD test',
      column: 'todo',
      sort_order: 0
    })
    mockKanban.ticket.create.mockResolvedValue(createdTicket)

    await act(async () => {
      await useKanbanStore.getState().createTicket('proj-1', {
        project_id: 'proj-1',
        title: 'CRUD test'
      })
      await flush()
    })

    expect(getTicket('proj-1', 't-crud')).toBeDefined()
    expect(getTicket('proj-1', 't-crud')!.title).toBe('CRUD test')

    // Update the ticket
    await act(async () => {
      await useKanbanStore.getState().updateTicket('t-crud', 'proj-1', {
        title: 'Updated CRUD test',
        description: 'Added description'
      })
      await flush()
    })

    expect(getTicket('proj-1', 't-crud')!.title).toBe('Updated CRUD test')
    expect(getTicket('proj-1', 't-crud')!.description).toBe('Added description')

    // Delete the ticket
    await act(async () => {
      await useKanbanStore.getState().deleteTicket('t-crud', 'proj-1')
      await flush()
    })

    expect(getTicket('proj-1', 't-crud')).toBeUndefined()
    const remaining = useKanbanStore.getState().tickets.get('proj-1') ?? []
    expect(remaining).toHaveLength(0)
  })

  // ──────────────────────────────────────────────────────────────────
  // Sort order integrity across moves
  // ──────────────────────────────────────────────────────────────────
  test('sort order is maintained correctly through reorders', async () => {
    const tickets = [
      makeTicket({ id: 't1', column: 'todo', sort_order: 0 }),
      makeTicket({ id: 't2', column: 'todo', sort_order: 1 }),
      makeTicket({ id: 't3', column: 'todo', sort_order: 2 })
    ]

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', tickets]])
      })
    })

    // Compute sort order for inserting at position 1 (between t1 and t2)
    const columnTickets = useKanbanStore.getState().getTicketsByColumn('proj-1', 'todo')
    const newSortOrder = useKanbanStore.getState().computeSortOrder(columnTickets, 1)

    // Should be between 0 and 1
    expect(newSortOrder).toBeGreaterThan(0)
    expect(newSortOrder).toBeLessThan(1)

    // Reorder t3 to that position
    await act(async () => {
      await useKanbanStore.getState().reorderTicket('t3', 'proj-1', newSortOrder)
      await flush()
    })

    const t3 = getTicket('proj-1', 't3')
    expect(t3!.sort_order).toBe(newSortOrder)
    expect(mockKanban.ticket.reorder).toHaveBeenCalledWith('t3', newSortOrder)
  })
})
