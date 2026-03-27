import { describe, test, expect, beforeEach, vi } from 'vitest'
import { act } from '@testing-library/react'
import type { KanbanTicket } from '../../../src/main/db/types'

// ── Mock window.kanban before importing stores ──────────────────────────
const mockKanban = {
  ticket: {
    create: vi.fn(),
    get: vi.fn(),
    getByProject: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    move: vi.fn(),
    reorder: vi.fn(),
    getBySession: vi.fn()
  },
  simpleMode: {
    toggle: vi.fn()
  }
}

Object.defineProperty(window, 'kanban', {
  writable: true,
  configurable: true,
  value: mockKanban
})

// Import store-coordination first so we can inspect registrations
import {
  registerKanbanSessionSync,
  notifyKanbanSessionSync,
  type KanbanSessionEvent
} from '@/stores/store-coordination'

// Import the kanban store (which auto-registers its callback on import)
import { useKanbanStore } from '@/stores/useKanbanStore'

// ── Helpers ────────────────────────────────────────────────────────────
function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: overrides.id ?? 'ticket-1',
    project_id: overrides.project_id ?? 'proj-1',
    title: overrides.title ?? 'Test Ticket',
    description: overrides.description ?? null,
    attachments: overrides.attachments ?? [],
    column: overrides.column ?? 'in_progress',
    sort_order: overrides.sort_order ?? 0,
    current_session_id: overrides.current_session_id ?? null,
    worktree_id: overrides.worktree_id ?? null,
    mode: overrides.mode ?? null,
    plan_ready: overrides.plan_ready ?? false,
    created_at: overrides.created_at ?? '2026-01-01T00:00:00Z',
    updated_at: overrides.updated_at ?? '2026-01-01T00:00:00Z'
  }
}

// ── Setup ──────────────────────────────────────────────────────────────
describe('Session 10: Session ↔ Kanban Store Coordination', () => {
  beforeEach(() => {
    // Reset store state
    act(() => {
      useKanbanStore.setState({
        tickets: new Map(),
        isLoading: false,
        isBoardViewActive: false,
        simpleModeByProject: {}
      })
    })

    // Reset all mocks — resolve by default so optimistic updates succeed
    vi.clearAllMocks()
    mockKanban.ticket.update.mockResolvedValue(undefined)
    mockKanban.ticket.move.mockResolvedValue(undefined)
  })

  // ────────────────────────────────────────────────────────────────────
  // Build session completing moves ticket to review column
  // ────────────────────────────────────────────────────────────────────
  test('build session completing moves ticket to review column', async () => {
    const ticket = makeTicket({
      id: 't1',
      column: 'in_progress',
      current_session_id: 'session-1',
      mode: 'build'
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-1', {
        type: 'session_completed',
        sessionMode: 'build'
      })
      // Allow microtasks (optimistic update + IPC) to settle
      await new Promise((r) => setTimeout(r, 0))
    })

    const tickets = useKanbanStore.getState().tickets.get('proj-1')
    const moved = tickets!.find((t) => t.id === 't1')
    expect(moved!.column).toBe('review')
    expect(mockKanban.ticket.move).toHaveBeenCalledWith('t1', 'review', 0)
  })

  // ────────────────────────────────────────────────────────────────────
  // Plan session completing sets plan_ready to true
  // ────────────────────────────────────────────────────────────────────
  test('plan session completing sets plan_ready and moves to review', async () => {
    const ticket = makeTicket({
      id: 't1',
      column: 'in_progress',
      current_session_id: 'session-2',
      mode: 'plan'
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-2', {
        type: 'session_completed',
        sessionMode: 'plan'
      })
      await new Promise((r) => setTimeout(r, 0))
    })

    const tickets = useKanbanStore.getState().tickets.get('proj-1')
    const updated = tickets!.find((t) => t.id === 't1')
    expect(updated!.plan_ready).toBe(true)
    expect(updated!.column).toBe('review')
    expect(mockKanban.ticket.update).toHaveBeenCalledWith('t1', { plan_ready: true })
    expect(mockKanban.ticket.move).toHaveBeenCalledWith('t1', 'review', 0)
  })

  // ────────────────────────────────────────────────────────────────────
  // Plan session completing does NOT move ticket to review
  // ────────────────────────────────────────────────────────────────────
  test('plan session completing moves ticket to review', async () => {
    const ticket = makeTicket({
      id: 't1',
      column: 'in_progress',
      current_session_id: 'session-3',
      mode: 'plan'
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-3', {
        type: 'session_completed',
        sessionMode: 'plan'
      })
      await new Promise((r) => setTimeout(r, 0))
    })

    const tickets = useKanbanStore.getState().tickets.get('proj-1')
    const updated = tickets!.find((t) => t.id === 't1')
    expect(updated!.column).toBe('review')
    expect(mockKanban.ticket.move).toHaveBeenCalledWith('t1', 'review', 0)
  })

  // ────────────────────────────────────────────────────────────────────
  // Session error does not change ticket column
  // ────────────────────────────────────────────────────────────────────
  test('session error moves in_progress ticket to review', async () => {
    const ticket = makeTicket({
      id: 't1',
      column: 'in_progress',
      current_session_id: 'session-4',
      mode: 'build'
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-4', {
        type: 'session_error'
      })
      await new Promise((r) => setTimeout(r, 0))
    })

    const tickets = useKanbanStore.getState().tickets.get('proj-1')
    const moved = tickets!.find((t) => t.id === 't1')
    expect(moved!.column).toBe('review')
    expect(mockKanban.ticket.move).toHaveBeenCalledWith('t1', 'review', 0)
    expect(mockKanban.ticket.update).not.toHaveBeenCalled()
  })

  // ────────────────────────────────────────────────────────────────────
  // Supercharge updates ticket current_session_id to new session
  // ────────────────────────────────────────────────────────────────────
  test('supercharge updates ticket current_session_id to new session', async () => {
    const ticket = makeTicket({
      id: 't1',
      column: 'in_progress',
      current_session_id: 'session-old',
      mode: 'plan',
      plan_ready: true
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-old', {
        type: 'supercharge',
        newSessionId: 'session-new'
      })
      await new Promise((r) => setTimeout(r, 0))
    })

    const tickets = useKanbanStore.getState().tickets.get('proj-1')
    const updated = tickets!.find((t) => t.id === 't1')
    expect(updated!.current_session_id).toBe('session-new')
    expect(mockKanban.ticket.update).toHaveBeenCalledWith('t1', {
      current_session_id: 'session-new',
      plan_ready: false,
      mode: 'build'
    })
  })

  // ────────────────────────────────────────────────────────────────────
  // Supercharge resets plan_ready to false
  // ────────────────────────────────────────────────────────────────────
  test('supercharge resets plan_ready to false', async () => {
    const ticket = makeTicket({
      id: 't1',
      column: 'in_progress',
      current_session_id: 'session-old',
      mode: 'plan',
      plan_ready: true
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-old', {
        type: 'supercharge',
        newSessionId: 'session-new'
      })
      await new Promise((r) => setTimeout(r, 0))
    })

    const tickets = useKanbanStore.getState().tickets.get('proj-1')
    const updated = tickets!.find((t) => t.id === 't1')
    expect(updated!.plan_ready).toBe(false)
  })

  // ────────────────────────────────────────────────────────────────────
  // Auto-advance persists column change via IPC
  // ────────────────────────────────────────────────────────────────────
  test('auto-advance persists column change via IPC', async () => {
    const ticket = makeTicket({
      id: 't1',
      column: 'in_progress',
      sort_order: 3,
      current_session_id: 'session-5',
      mode: 'build'
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-5', {
        type: 'session_completed',
        sessionMode: 'build'
      })
      await new Promise((r) => setTimeout(r, 0))
    })

    // The move action calls window.kanban.ticket.move which persists to DB
    expect(mockKanban.ticket.move).toHaveBeenCalledWith('t1', 'review', 3)
  })

  // ────────────────────────────────────────────────────────────────────
  // plan_ready change persists via IPC
  // ────────────────────────────────────────────────────────────────────
  test('plan_ready change persists via IPC and moves to review', async () => {
    const ticket = makeTicket({
      id: 't1',
      column: 'in_progress',
      current_session_id: 'session-6',
      mode: 'plan'
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-6', {
        type: 'session_completed',
        sessionMode: 'plan'
      })
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(mockKanban.ticket.update).toHaveBeenCalledWith('t1', { plan_ready: true })
    expect(mockKanban.ticket.move).toHaveBeenCalledWith('t1', 'review', 0)
  })

  // ────────────────────────────────────────────────────────────────────
  // Tickets with no session are not affected by session changes
  // ────────────────────────────────────────────────────────────────────
  test('tickets with no session are not affected by session changes', async () => {
    const ticket = makeTicket({
      id: 't1',
      column: 'in_progress',
      current_session_id: null, // no session attached
      mode: 'build'
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-unrelated', {
        type: 'session_completed',
        sessionMode: 'build'
      })
      await new Promise((r) => setTimeout(r, 0))
    })

    const tickets = useKanbanStore.getState().tickets.get('proj-1')
    const unchanged = tickets!.find((t) => t.id === 't1')
    expect(unchanged!.column).toBe('in_progress')
    expect(mockKanban.ticket.move).not.toHaveBeenCalled()
    expect(mockKanban.ticket.update).not.toHaveBeenCalled()
  })

  // ────────────────────────────────────────────────────────────────────
  // Multiple tickets can reference different sessions independently
  // ────────────────────────────────────────────────────────────────────
  test('multiple tickets can reference different sessions independently', async () => {
    const ticketA = makeTicket({
      id: 'tA',
      column: 'in_progress',
      current_session_id: 'session-A',
      mode: 'build',
      sort_order: 0
    })
    const ticketB = makeTicket({
      id: 'tB',
      column: 'in_progress',
      current_session_id: 'session-B',
      mode: 'plan',
      sort_order: 1
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticketA, ticketB]]])
      })
    })

    // Complete session-A (build) — only ticketA should move to review
    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-A', {
        type: 'session_completed',
        sessionMode: 'build'
      })
      await new Promise((r) => setTimeout(r, 0))
    })

    const ticketsAfterA = useKanbanStore.getState().tickets.get('proj-1')!
    expect(ticketsAfterA.find((t) => t.id === 'tA')!.column).toBe('review')
    expect(ticketsAfterA.find((t) => t.id === 'tB')!.column).toBe('in_progress')
    expect(ticketsAfterA.find((t) => t.id === 'tB')!.plan_ready).toBe(false)

    // Complete session-B (plan) — only ticketB should get plan_ready
    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-B', {
        type: 'session_completed',
        sessionMode: 'plan'
      })
      await new Promise((r) => setTimeout(r, 0))
    })

    const ticketsAfterB = useKanbanStore.getState().tickets.get('proj-1')!
    expect(ticketsAfterB.find((t) => t.id === 'tB')!.plan_ready).toBe(true)
    expect(ticketsAfterB.find((t) => t.id === 'tB')!.column).toBe('review')
  })

  // ────────────────────────────────────────────────────────────────────
  // notifyKanbanSessionSync dispatches to registered callback
  // ────────────────────────────────────────────────────────────────────
  test('notifyKanbanSessionSync dispatches to registered callback', async () => {
    const spy = vi.fn()
    registerKanbanSessionSync(spy)

    const event: KanbanSessionEvent = {
      type: 'session_completed',
      sessionMode: 'build'
    }

    notifyKanbanSessionSync('session-99', event)

    expect(spy).toHaveBeenCalledOnce()
    expect(spy).toHaveBeenCalledWith('session-99', event)

    // Re-register the real callback so subsequent tests aren't affected
    registerKanbanSessionSync((sid, ev) => {
      useKanbanStore.getState().syncTicketWithSession(sid, ev)
    })
  })

  // ────────────────────────────────────────────────────────────────────
  // plan_ready event sets flag on plan-mode ticket
  // ────────────────────────────────────────────────────────────────────
  test('plan_ready event sets flag and moves to review', async () => {
    const ticket = makeTicket({
      id: 't1',
      column: 'in_progress',
      current_session_id: 'session-7',
      mode: 'plan'
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-7', {
        type: 'plan_ready'
      })
      await new Promise((r) => setTimeout(r, 0))
    })

    const tickets = useKanbanStore.getState().tickets.get('proj-1')
    const updated = tickets!.find((t) => t.id === 't1')
    expect(updated!.plan_ready).toBe(true)
    expect(updated!.column).toBe('review')
    expect(mockKanban.ticket.move).toHaveBeenCalledWith('t1', 'review', 0)
  })

  // ────────────────────────────────────────────────────────────────────
  // Tickets across different projects are handled independently
  // ────────────────────────────────────────────────────────────────────
  test('tickets across different projects are handled independently', async () => {
    const ticketProj1 = makeTicket({
      id: 't-p1',
      project_id: 'proj-1',
      column: 'in_progress',
      current_session_id: 'session-shared',
      mode: 'build',
      sort_order: 0
    })
    const ticketProj2 = makeTicket({
      id: 't-p2',
      project_id: 'proj-2',
      column: 'in_progress',
      current_session_id: 'session-other',
      mode: 'build',
      sort_order: 0
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([
          ['proj-1', [ticketProj1]],
          ['proj-2', [ticketProj2]]
        ])
      })
    })

    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-shared', {
        type: 'session_completed',
        sessionMode: 'build'
      })
      await new Promise((r) => setTimeout(r, 0))
    })

    // proj-1 ticket should move to review
    const proj1Tickets = useKanbanStore.getState().tickets.get('proj-1')!
    expect(proj1Tickets.find((t) => t.id === 't-p1')!.column).toBe('review')

    // proj-2 ticket should stay unchanged (different session)
    const proj2Tickets = useKanbanStore.getState().tickets.get('proj-2')!
    expect(proj2Tickets.find((t) => t.id === 't-p2')!.column).toBe('in_progress')
  })

  // ────────────────────────────────────────────────────────────────────
  // Idempotency: duplicate session_completed is a no-op for build ticket already in review
  // ────────────────────────────────────────────────────────────────────
  test('duplicate session_completed is a no-op for build ticket already in review', async () => {
    const ticket = makeTicket({
      id: 't1',
      column: 'review', // already in review
      current_session_id: 'session-dup',
      mode: 'build'
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-dup', {
        type: 'session_completed',
        sessionMode: 'build'
      })
      await new Promise((r) => setTimeout(r, 0))
    })

    // Should NOT call move again — ticket is already in review
    expect(mockKanban.ticket.move).not.toHaveBeenCalled()
  })

  // ────────────────────────────────────────────────────────────────────
  // Idempotency: duplicate plan_ready is a no-op when already set
  // ────────────────────────────────────────────────────────────────────
  test('duplicate plan_ready is a no-op when already set', async () => {
    const ticket = makeTicket({
      id: 't1',
      column: 'in_progress',
      current_session_id: 'session-dup2',
      mode: 'plan',
      plan_ready: true // already set
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    await act(async () => {
      useKanbanStore.getState().syncTicketWithSession('session-dup2', {
        type: 'session_completed',
        sessionMode: 'plan'
      })
      await new Promise((r) => setTimeout(r, 0))
    })

    // Should NOT call update again — plan_ready is already true
    expect(mockKanban.ticket.update).not.toHaveBeenCalled()
  })

  // ────────────────────────────────────────────────────────────────────
  // Idempotency: duplicate supercharge is a no-op when session already updated
  // ────────────────────────────────────────────────────────────────────
  test('duplicate supercharge is a no-op when session already updated', async () => {
    const ticket = makeTicket({
      id: 't1',
      column: 'in_progress',
      current_session_id: 'session-new', // already pointing to new session
      mode: 'plan',
      plan_ready: false
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    await act(async () => {
      // Notify with same newSessionId that's already set
      useKanbanStore.getState().syncTicketWithSession('session-new', {
        type: 'supercharge',
        newSessionId: 'session-new'
      })
      await new Promise((r) => setTimeout(r, 0))
    })

    // current_session_id already matches — should be a no-op
    // (note: won't match because current_session_id === sessionId check
    //  looks at the OLD sessionId. This ticket has session-new as current_session_id,
    //  and the event comes for session-new too, so the lookup matches but
    //  the guard `ticket.current_session_id !== event.newSessionId` prevents the update)
    expect(mockKanban.ticket.update).not.toHaveBeenCalled()
  })
})
