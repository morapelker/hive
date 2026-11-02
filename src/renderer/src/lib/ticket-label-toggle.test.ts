import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { KanbanTicket, SavedTicketLabel, TicketLabel } from '../../../main/db/types'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))

vi.mock('@/lib/toast', () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))

import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { reloadBoard } from '@/lib/board-reload'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useTicketLabelsStore } from '@/stores/useTicketLabelsStore'
import { openTicketLabelSession } from './ticket-label-session'
import { setTicketLabel } from './ticket-label-toggle'

const initialKanbanState = useKanbanStore.getState()

const catalogRow = (id: string, name: string, sortOrder: number): SavedTicketLabel => ({
  id,
  name,
  color: 'yellow',
  sort_order: sortOrder,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z'
})

const A: TicketLabel = { id: 'A', kind: 'saved', name: 'Waiting for Joy', color: 'yellow' }
const B: TicketLabel = { id: 'B', kind: 'saved', name: 'Blocked', color: 'yellow' }
const O1: TicketLabel = { id: 'O1', kind: 'once', name: 'Until 21/10', color: 'gray' }
const O2: TicketLabel = { id: 'O2', kind: 'once', name: 'Ping Dana', color: 'gray' }

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 't1',
    project_id: 'p1',
    title: 'A ticket',
    description: null,
    attachments: [],
    column: 'todo',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: null,
    plan_ready: false,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    column_changed_at: null,
    archived_at: null,
    external_provider: null,
    external_id: null,
    external_url: null,
    github_pr_number: null,
    github_pr_url: null,
    mark: null,
    total_tokens: 0,
    pending_launch_config: null,
    goal_mode: false,
    goal_success_criteria: null,
    note: null,
    labels: [],
    created_from_session: false,
    auto_approve_plan: false,
    unread: false,
    awaiting_completion: false,
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    variant_group_id: null,
    ticket_prefix: null,
    ticket_number: null,
    parent_ticket_id: null,
    parent_ticket_key: null,
    ...overrides
  }
}

interface Deferred {
  resolve: () => void
  reject: (error: Error) => void
}

/** Every kanban.ticket.update the toggles send, held until the test settles it. */
let updates: Array<{ ticketId: string; labels: TicketLabel[] } & Deferred>
let request: ReturnType<typeof vi.fn>
let loadTicketsForProjectInAggregate: ReturnType<typeof vi.fn>
/** What a reload reads back from the "DB". */
let serverTickets: KanbanTicket[]

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const labelsOf = (ticketId: string): string[] =>
  (
    useKanbanStore
      .getState()
      .tickets.get('p1')
      ?.find((t) => t.id === ticketId)?.labels ?? []
  ).map((label) => label.id)

const ref = (ticketId = 't1'): { projectId: string; ticketId: string } => ({
  projectId: 'p1',
  ticketId
})

beforeEach(() => {
  updates = []
  toastError.mockClear()
  request = vi.fn((method: string, params: { id: string; data: { labels: TicketLabel[] } }) => {
    if (method !== 'kanban.ticket.update') return Promise.resolve(null)
    return new Promise<void>((resolve, reject) => {
      updates.push({ ticketId: params.id, labels: params.data.labels, resolve, reject })
    })
  })
  setRendererRpcClient({ request, subscribe: vi.fn() })

  serverTickets = []
  loadTicketsForProjectInAggregate = vi.fn(async (projectId: string) => {
    useKanbanStore.setState((state) => {
      const tickets = new Map(state.tickets)
      tickets.set(projectId, serverTickets)
      return { tickets }
    })
  })
  useKanbanStore.setState({
    tickets: new Map([['p1', [makeTicket()]]]),
    loadTicketsForProjectInAggregate
  })
  useTicketLabelsStore.setState({
    labels: [catalogRow('A', A.name, 0), catalogRow('B', B.name, 1)],
    loaded: true
  })
})

afterEach(async () => {
  // Settle whatever a failed test left in flight, so its queue cannot hold up the next test.
  updates.forEach((u) => u.resolve())
  await flush()
  resetRendererRpcClientForTests()
  useKanbanStore.setState(initialKanbanState, true)
  useTicketLabelsStore.setState({ labels: [], loaded: false, dialog: null })
  vi.restoreAllMocks()
})

describe('setTicketLabel', () => {
  it('applies rapid toggles one at a time, each from the labels the previous one left', async () => {
    const first = setTicketLabel(ref(), A, true, [])
    const second = setTicketLabel(ref(), B, true, [])
    const third = setTicketLabel(ref(), A, false, [])
    await flush()

    // Only the first write is out; the card already shows it.
    expect(updates.map((u) => u.labels.map((l) => l.id))).toEqual([['A']])
    expect(labelsOf('t1')).toEqual(['A'])

    updates[0].resolve()
    await flush()
    expect(updates.map((u) => u.labels.map((l) => l.id))).toEqual([['A'], ['A', 'B']])

    updates[1].resolve()
    await flush()
    expect(updates.map((u) => u.labels.map((l) => l.id))).toEqual([['A'], ['A', 'B'], ['B']])

    updates[2].resolve()
    expect(await Promise.all([first, second, third])).toEqual(['applied', 'applied', 'applied'])
    expect(labelsOf('t1')).toEqual(['B'])
    // The full list is sent, as the label objects themselves.
    expect(updates[1].labels).toEqual([A, B])
    expect(toastError).not.toHaveBeenCalled()
  })

  it('keeps separate tickets independent', async () => {
    useKanbanStore.setState({
      tickets: new Map([['p1', [makeTicket(), makeTicket({ id: 't2' })]]])
    })

    void setTicketLabel(ref('t1'), A, true, [])
    void setTicketLabel(ref('t2'), B, true, [])
    await flush()

    // t2 does not wait for t1's write.
    expect(updates.map((u) => u.ticketId)).toEqual(['t1', 't2'])
    updates.forEach((u) => u.resolve())
    await flush()
  })

  it('does nothing when the label is already in that state', async () => {
    const ticket = makeTicket({ labels: [A] })
    useKanbanStore.setState({ tickets: new Map([['p1', [ticket]]]) })

    expect(await setTicketLabel(ref(), A, true, [])).toBe('unchanged')
    expect(await setTicketLabel(ref(), B, false, [])).toBe('unchanged')

    expect(request).not.toHaveBeenCalled()
    expect(useKanbanStore.getState().tickets.get('p1')?.[0]).toBe(ticket)
  })

  it('does nothing for a ticket that is not loaded', async () => {
    expect(await setTicketLabel({ projectId: 'p1', ticketId: 'gone' }, A, true, [])).toBe(
      'unchanged'
    )
    expect(await setTicketLabel({ projectId: 'elsewhere', ticketId: 't1' }, A, true, [])).toBe(
      'unchanged'
    )

    expect(request).not.toHaveBeenCalled()
  })

  it('treats a label-less row from an older build as having no labels', async () => {
    const legacy = makeTicket()
    delete legacy.labels
    useKanbanStore.setState({ tickets: new Map([['p1', [legacy]]]) })

    const done = setTicketLabel(ref(), A, true, [])
    await flush()
    expect(updates[0].labels).toEqual([A])
    updates[0].resolve()
    await done
  })

  it('puts a re-ticked one-off back in its place', async () => {
    useKanbanStore.setState({ tickets: new Map([['p1', [makeTicket({ labels: [A, O1, O2] })]]]) })
    const session = openTicketLabelSession([A, O1, O2], new Set(['A', 'B']))

    const off = setTicketLabel(ref(), O1, false, session)
    const on = setTicketLabel(ref(), O1, true, session)
    await flush()
    updates[0].resolve()
    await flush()
    updates[1].resolve()
    await Promise.all([off, on])

    expect(updates.map((u) => u.labels.map((l) => l.id))).toEqual([
      ['A', 'O2'],
      ['A', 'O1', 'O2']
    ])
    expect(updates[1].labels[1]).toBe(O1)
  })

  it('resolves as failed, and keeps the queue moving, when a toggle throws unexpectedly', async () => {
    // A malformed catalog makes the first toggle throw before it writes anything.
    useTicketLabelsStore.setState({ labels: null as unknown as SavedTicketLabel[] })
    const broken = setTicketLabel(ref(), A, true, [])
    await expect(broken).resolves.toBe('failed')

    useTicketLabelsStore.setState({
      labels: [catalogRow('A', A.name, 0), catalogRow('B', B.name, 1)]
    })
    const next = setTicketLabel(ref(), B, true, [])
    await flush()
    expect(updates.map((u) => u.labels.map((l) => l.id))).toEqual([['B']])
    updates[0].resolve()
    expect(await next).toBe('applied')
  })

  it('builds a queued toggle on the previous write, not on a store copy a stale reload put back', async () => {
    // The "DB" and the board reload, with the real reloadBoard and loader: getByProject reads
    // the DB when it is called and holds its answer until the test releases it.
    let db: TicketLabel[] = []
    const fetches: Array<{ release: () => void }> = []
    request.mockImplementation(
      (method: string, params: { id: string; data: { labels: TicketLabel[] } }) => {
        if (method === 'kanban.ticket.update') {
          return new Promise<void>((resolve, reject) => {
            updates.push({
              ticketId: params.id,
              labels: params.data.labels,
              resolve: () => {
                db = params.data.labels
                resolve()
              },
              reject
            })
          })
        }
        if (method === 'kanban.ticket.getByProject') {
          const snapshot = [makeTicket({ labels: db })]
          return new Promise((resolve) => fetches.push({ release: () => resolve(snapshot) }))
        }
        return Promise.resolve([])
      }
    )
    useKanbanStore.setState({
      loadTicketsForProjectInAggregate: initialKanbanState.loadTicketsForProjectInAggregate
    })

    // A foreign ticket event reloads the board; its fetch reads the DB before any tick.
    const reload = reloadBoard('p1')
    await flush()
    expect(fetches).toHaveLength(1)

    // Tick A (written, in flight), then tick B (queued behind it).
    const tickA = setTicketLabel(ref(), A, true, [])
    const tickB = setTicketLabel(ref(), B, true, [])
    await flush()
    expect(labelsOf('t1')).toEqual(['A'])

    // The reload lands with the pre-A snapshot and puts the card back to no labels.
    fetches[0].release()
    await flush()
    expect(labelsOf('t1')).toEqual([])

    // A's write succeeds: B builds on what A wrote, not on the reverted store copy.
    updates[0].resolve()
    await flush()
    expect(updates.map((u) => u.labels.map((l) => l.id))).toEqual([['A'], ['A', 'B']])

    // Let the rest settle: every write and every refetch the reload makes.
    for (let i = 0; i < 10; i++) {
      updates.forEach((u) => u.resolve())
      fetches.forEach((f) => f.release())
      await flush()
    }
    await Promise.all([reload, tickA, tickB])

    expect(db.map((l) => l.id)).toEqual(['A', 'B'])
    expect(labelsOf('t1')).toEqual(['A', 'B'])
    expect(toastError).not.toHaveBeenCalled()
  })

  it('builds a queued toggle on the previous write when another update’s rollback reverted it', async () => {
    useKanbanStore.setState({
      tickets: new Map([['p1', [makeTicket(), makeTicket({ id: 't2' })]]])
    })

    // Another ticket's update starts first: on failure it restores the project as it was then.
    const rename = useKanbanStore
      .getState()
      .updateTicket('t2', 'p1', { title: 'Renamed' })
      .catch(() => undefined)
    const tickA = setTicketLabel(ref(), A, true, [])
    const tickB = setTicketLabel(ref(), B, true, [])
    await flush()
    expect(updates.map((u) => u.ticketId)).toEqual(['t2', 't1'])

    updates[0].reject(new Error('disk full'))
    await rename
    expect(labelsOf('t1')).toEqual([])

    updates[1].resolve()
    await flush()
    expect(updates[2].labels.map((l) => l.id)).toEqual(['A', 'B'])
    updates[2].resolve()
    expect(await Promise.all([tickA, tickB])).toEqual(['applied', 'applied'])
    expect(labelsOf('t1')).toEqual(['A', 'B'])
  })

  it('starts from the store again once the queue has drained', async () => {
    const first = setTicketLabel(ref(), A, true, [])
    await flush()
    updates[0].resolve()
    expect(await first).toBe('applied')
    await flush()

    // Another client adds B; the reload brings it in.
    useKanbanStore.setState({ tickets: new Map([['p1', [makeTicket({ labels: [A, B] })]]]) })

    const off = setTicketLabel(ref(), A, false, [])
    await flush()
    expect(updates[1].labels.map((l) => l.id)).toEqual(['B'])
    updates[1].resolve()
    expect(await off).toBe('applied')
  })

  it('toasts and reloads the project after a failed write, before the next toggle runs', async () => {
    // What the DB holds: the failed write never landed.
    serverTickets = [makeTicket({ labels: [] })]

    const failing = setTicketLabel(ref(), A, true, [])
    const next = setTicketLabel(ref(), B, true, [])
    await flush()
    updates[0].reject(new Error('VALIDATION_FAILED'))
    expect(await failing).toBe('failed')

    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError).toHaveBeenCalledWith("Couldn't update labels")
    expect(loadTicketsForProjectInAggregate).toHaveBeenCalledWith('p1')

    await flush()
    // The next toggle starts from the reloaded labels, not the rolled-back optimistic ones.
    expect(updates).toHaveLength(2)
    expect(updates[1].labels.map((l) => l.id)).toEqual(['B'])
    updates[1].resolve()
    expect(await next).toBe('applied')
    expect(labelsOf('t1')).toEqual(['B'])
  })

  it('reload restores another ticket’s toggle that the failed write’s rollback undid', async () => {
    useKanbanStore.setState({
      tickets: new Map([['p1', [makeTicket(), makeTicket({ id: 't2' })]]]),
      loadTicketsForProjectInAggregate
    })
    serverTickets = [makeTicket(), makeTicket({ id: 't2', labels: [B] })]

    const failing = setTicketLabel(ref('t1'), A, true, [])
    const other = setTicketLabel(ref('t2'), B, true, [])
    await flush()
    updates[1].resolve()
    await other
    expect(labelsOf('t2')).toEqual(['B'])

    // updateTicket's rollback restores the whole project as it was when t1's write began.
    updates[0].reject(new Error('disk full'))
    await failing

    expect(loadTicketsForProjectInAggregate).toHaveBeenCalledTimes(1)
    expect(labelsOf('t1')).toEqual([])
    expect(labelsOf('t2')).toEqual(['B'])
  })

  it('never logs the labels', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {})
    )

    const failing = setTicketLabel(ref(), A, true, [])
    await flush()
    updates[0].reject(new Error('disk full'))
    await failing

    for (const spy of spies) {
      for (const args of spy.mock.calls) {
        expect(JSON.stringify(args)).not.toContain(A.name)
      }
    }
  })
})
