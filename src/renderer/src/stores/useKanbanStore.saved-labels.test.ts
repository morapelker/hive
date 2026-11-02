import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket, TicketLabel } from '../../../main/db/types'

import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { reloadBoard } from '@/lib/board-reload'
import { useKanbanStore } from './useKanbanStore'
import { usePinnedStore } from './usePinnedStore'
import { useTicketLabelsStore } from './useTicketLabelsStore'

const initialKanbanState = useKanbanStore.getState()
const initialPinnedState = usePinnedStore.getState()

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
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

const JOY: TicketLabel = { id: 'joy', kind: 'saved', name: 'Waiting for Joy', color: 'yellow' }
const QA: TicketLabel = { id: 'qa', kind: 'saved', name: 'Needs QA', color: 'blue' }
const LATER: TicketLabel = { id: 'once-1', kind: 'once', name: 'Until 21/10', color: 'gray' }

const withJoy = makeTicket({ id: 't-joy', labels: [JOY, LATER] })
const withQa = makeTicket({ id: 't-qa', labels: [QA] })
const bare = makeTicket({ id: 't-bare' })
// A row from another Mac's older build: no labels field at all.
const legacy = (() => {
  const ticket = makeTicket({ id: 't-legacy' })
  delete ticket.labels
  return ticket
})()
const otherProjectJoy = makeTicket({ id: 't-joy-2', project_id: 'p2', labels: [QA, JOY] })
const untouchedProject = [makeTicket({ id: 't-p3', project_id: 'p3', labels: [QA] })]

beforeEach(() => {
  useKanbanStore.setState({
    tickets: new Map([
      ['p1', [withJoy, withQa, bare, legacy]],
      ['p2', [otherProjectJoy]],
      ['p3', untouchedProject]
    ])
  })
})

afterEach(() => {
  useKanbanStore.setState(initialKanbanState, true)
})

const ticketsOf = (projectId: string): KanbanTicket[] =>
  useKanbanStore.getState().tickets.get(projectId) ?? []

describe('useKanbanStore.applySavedLabelChange', () => {
  it('renames and recolours the label on every loaded project in one set()', () => {
    let notifications = 0
    const unsubscribe = useKanbanStore.subscribe(() => notifications++)

    useKanbanStore.getState().applySavedLabelChange({
      type: 'update',
      label: { id: 'joy', name: 'Joy', color: 'red' }
    })
    unsubscribe()

    expect(notifications).toBe(1)
    expect(ticketsOf('p1')[0].labels).toEqual([{ ...JOY, name: 'Joy', color: 'red' }, LATER])
    expect(ticketsOf('p2')[0].labels).toEqual([QA, { ...JOY, name: 'Joy', color: 'red' }])
  })

  it('keeps the identity of untouched tickets, labels and project arrays', () => {
    const before = useKanbanStore.getState().tickets

    useKanbanStore.getState().applySavedLabelChange({
      type: 'update',
      label: { id: 'joy', name: 'Joy', color: 'red' }
    })

    const after = useKanbanStore.getState().tickets
    expect(after).not.toBe(before)
    const p1 = ticketsOf('p1')
    expect(p1).not.toBe(before.get('p1'))
    expect(p1[0]).not.toBe(withJoy)
    // The one-off on the rewritten ticket is the same object.
    expect(p1[0].labels?.[1]).toBe(LATER)
    expect(p1[1]).toBe(withQa)
    expect(p1[2]).toBe(bare)
    expect(p1[3]).toBe(legacy)
    expect(ticketsOf('p3')).toBe(untouchedProject)
    // Nothing else about the ticket changes (a catalog edit does not bump updated_at).
    expect({ ...p1[0], labels: withJoy.labels }).toEqual(withJoy)
  })

  it('leaves the state alone when no loaded ticket carries the label', () => {
    const before = useKanbanStore.getState()
    let notifications = 0
    const unsubscribe = useKanbanStore.subscribe(() => notifications++)

    useKanbanStore.getState().applySavedLabelChange({
      type: 'update',
      label: { id: 'nobody', name: 'X', color: 'red' }
    })
    useKanbanStore.getState().applySavedLabelChange({ type: 'delete', id: 'nobody' })
    // Every ticket already lists its saved labels in this order.
    useKanbanStore.getState().applySavedLabelChange({ type: 'reorder', ids: ['qa', 'joy'] })
    unsubscribe()

    expect(notifications).toBe(0)
    expect(useKanbanStore.getState().tickets).toBe(before.tickets)
  })

  it('takes a deleted label off every ticket and keeps the one-offs', () => {
    useKanbanStore.getState().applySavedLabelChange({ type: 'delete', id: 'joy' })

    expect(ticketsOf('p1')[0].labels).toEqual([LATER])
    expect(ticketsOf('p2')[0].labels).toEqual([QA])
    expect(ticketsOf('p1')[1]).toBe(withQa)
  })

  it('re-sorts the saved labels after a reorder, one-offs last', () => {
    useKanbanStore.setState({
      tickets: new Map([['p1', [makeTicket({ id: 't1', labels: [JOY, QA, LATER] })]]])
    })

    useKanbanStore.getState().applySavedLabelChange({ type: 'reorder', ids: ['qa', 'joy'] })

    expect(ticketsOf('p1')[0].labels?.map((l) => l.id)).toEqual(['qa', 'joy', 'once-1'])
  })

  it('does not give a label-less row from an older build a labels field', () => {
    useKanbanStore.getState().applySavedLabelChange({ type: 'delete', id: 'joy' })

    expect('labels' in ticketsOf('p1')[3]).toBe(false)
  })
})

/** Lets every queued promise callback run. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('a ticket load in flight during a catalog edit', () => {
  /** getByProject calls, each answered (with what the test passes) only when the test says. */
  let fetches: Array<{ projectId: string; answer: (tickets: KanbanTicket[]) => void }>
  let request: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetches = []
    request = vi.fn((method: string, params: { projectId?: string }) => {
      if (method === 'kanban.ticket.getByProject') {
        return new Promise((resolve) =>
          fetches.push({ projectId: params.projectId ?? '', answer: resolve })
        )
      }
      return Promise.resolve([])
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })
  })

  afterEach(async () => {
    await flush()
    resetRendererRpcClientForTests()
    usePinnedStore.setState(initialPinnedState, true)
    useTicketLabelsStore.setState({ labels: [], loaded: false, dialog: null })
  })

  const renamed: TicketLabel = { ...JOY, name: 'Joy replied', color: 'red' }

  it('replays a rename onto a reload answered before it (the aggregate loader)', async () => {
    const loading = useKanbanStore.getState().loadTicketsForProjectInAggregate('p1')
    await flush()

    // The DB rewrites the snapshots after the fetch was answered; the patch lands first.
    useKanbanStore.getState().applySavedLabelChange({ type: 'update', label: renamed })
    fetches[0].answer([withJoy, withQa])
    await loading

    expect(ticketsOf('p1')[0].labels).toEqual([renamed, LATER])
    // A ticket without the label is stored as fetched.
    expect(ticketsOf('p1')[1]).toBe(withQa)
  })

  it('replays a delete onto a project load (mount, markdown watcher)', async () => {
    const loading = useKanbanStore.getState().loadTickets('p2')
    await flush()

    useKanbanStore.getState().applySavedLabelChange({ type: 'delete', id: 'joy' })
    fetches[0].answer([otherProjectJoy])
    await loading

    expect(ticketsOf('p2')[0].labels).toEqual([QA])
  })

  it('replays onto every project of a multi-project load, in the order the edits were made', async () => {
    usePinnedStore.setState({ pinnedProjectIds: new Set(['p1', 'p2']), loaded: true })
    const loading = useKanbanStore.getState().loadTicketsForPinnedProjects()
    await flush()

    useKanbanStore.getState().applySavedLabelChange({ type: 'update', label: renamed })
    useKanbanStore.getState().applySavedLabelChange({ type: 'reorder', ids: ['joy', 'qa'] })
    for (const fetch of fetches) {
      fetch.answer(fetch.projectId === 'p1' ? [withJoy] : [otherProjectJoy])
    }
    await loading

    expect(ticketsOf('p1')[0].labels).toEqual([renamed, LATER])
    expect(ticketsOf('p2')[0].labels).toEqual([renamed, QA])
  })

  it('stores the response as is when it began after the edit, or nothing in it carries the label', async () => {
    useKanbanStore.getState().applySavedLabelChange({ type: 'update', label: renamed })

    // Began after the edit: what the DB says now wins (another window may have renamed since).
    const later = useKanbanStore.getState().loadTickets('p1')
    await flush()
    const response = [withJoy, withQa]
    fetches[0].answer(response)
    await later
    expect(ticketsOf('p1')).toBe(response)

    // In flight during an edit of a label none of its tickets carries.
    const unrelated = useKanbanStore.getState().loadTickets('p3')
    await flush()
    useKanbanStore.getState().applySavedLabelChange({ type: 'delete', id: 'nobody' })
    const p3 = [makeTicket({ id: 't-p3', project_id: 'p3', labels: [QA] })]
    fetches[1].answer(p3)
    await unrelated
    expect(ticketsOf('p3')).toBe(p3)
  })

  it('keeps a catalog rename on the card when reloadBoard was in flight', async () => {
    // The real catalog store and reload, as the board runs them.
    useKanbanStore.setState({ tickets: new Map([['p1', [withJoy]]]) })
    useTicketLabelsStore.setState({
      labels: [
        {
          id: 'joy',
          name: JOY.name,
          color: JOY.color,
          sort_order: 0,
          created_at: '2026-10-01T00:00:00.000Z',
          updated_at: '2026-10-01T00:00:00.000Z'
        }
      ],
      loaded: true
    })
    let answerDiagnostics: (value: unknown[]) => void = () => {}
    let answerUpdate: (value: unknown) => void = () => {}
    request.mockImplementation((method: string) => {
      if (method === 'kanban.ticket.getByProject') {
        return new Promise((resolve) => fetches.push({ projectId: 'p1', answer: resolve }))
      }
      if (method === 'kanban.diagnostics.get') {
        return new Promise((resolve) => (answerDiagnostics = resolve))
      }
      if (method === 'ticketLabels.update') {
        return new Promise((resolve) => (answerUpdate = resolve))
      }
      return Promise.resolve([])
    })

    // A foreign ticket event reloads the board; getByProject is answered before the rename.
    const reload = reloadBoard('p1')
    await flush()
    fetches[0].answer([withJoy])
    await flush()

    // The rename commits (rewriting the snapshots) and is patched onto the card...
    const renaming = useTicketLabelsStore.getState().update('joy', { name: 'Joy replied' })
    await flush()
    answerUpdate({
      label: {
        id: 'joy',
        name: 'Joy replied',
        color: JOY.color,
        sort_order: 0,
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-02T00:00:00.000Z'
      },
      affectedProjectIds: ['p1']
    })
    await renaming
    expect(ticketsOf('p1')[0].labels?.[0].name).toBe('Joy replied')

    // ...then the reload stores its pre-rename response.
    answerDiagnostics([])
    await reload

    expect(ticketsOf('p1')[0].labels?.[0].name).toBe('Joy replied')
    expect(fetches).toHaveLength(1)
  })
})
