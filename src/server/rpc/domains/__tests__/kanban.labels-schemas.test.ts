import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import type { KanbanTicket, TicketLabel } from '../../../../main/db'
import type { RpcContext } from '../../router'
import { makeKanbanRpcHandlers, type KanbanRpcService } from '../kanban'

// A ticket's labels (shared/lib/ticket-labels.ts) ride on kanban.ticket.create / update /
// createBatch. The ticket schemas are `.strict()` and end in `satisfies z.ZodType<…>`, which
// does not flag a missing OPTIONAL key, so a forgotten `labels` entry would type-check and then
// fail every label write at runtime with VALIDATION_FAILED. These tests pin the schemas with a
// stub service: the full list is accepted and passed through untouched, and a malformed list is
// refused before it reaches the service.

const context = { eventBus: null } as unknown as RpcContext

const ticket = { id: 't1', project_id: 'p1', title: 'x', labels: [] } as unknown as KanbanTicket

function makeService(overrides: Partial<KanbanRpcService> = {}): KanbanRpcService {
  return {
    createTicket: vi.fn(() => Effect.succeed(ticket)),
    createTicketBatch: vi.fn(() => Effect.succeed({ tickets: [], dependencies: [] } as never)),
    getTicket: () => Effect.die('unused'),
    getTicketsByProject: () => Effect.die('unused'),
    updateTicket: vi.fn(() => Effect.succeed(ticket)),
    deleteTicket: () => Effect.die('unused'),
    archiveTicket: () => Effect.die('unused'),
    archiveAllDoneTickets: () => Effect.die('unused'),
    unarchiveTicket: () => Effect.die('unused'),
    moveTicket: () => Effect.die('unused'),
    ...overrides
  }
}

function run(service: KanbanRpcService, method: string, params: unknown): Promise<unknown> {
  const handler = makeKanbanRpcHandlers(service).get(method)
  if (!handler) throw new Error(`missing handler for ${method}`)
  return Effect.runPromise(handler(params, context) as Effect.Effect<unknown, never, never>)
}

const saved: TicketLabel = { id: 'lbl-1', kind: 'saved', name: 'Waiting for Joy', color: 'yellow' }
const once: TicketLabel = { id: 'once-1', kind: 'once', name: 'Waiting until 21/10', color: 'red' }

const update = (labels: unknown): Record<string, unknown> => ({
  projectId: 'p1',
  id: 't1',
  data: { labels }
})

const create = (labels: unknown): Record<string, unknown> => ({
  project_id: 'p1',
  title: 'Ship it',
  labels
})

const manyLabels = (count: number): TicketLabel[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `once-${i}`,
    kind: 'once' as const,
    name: `Label ${i}`,
    color: 'gray'
  }))

/** Labels the schemas must refuse, each with what is wrong with it. */
const malformed: Array<[string, unknown]> = [
  ['an extra key inside a label', [{ ...saved, sort_order: 0 }]],
  ['an unknown kind', [{ ...saved, kind: 'pinned' }]],
  ['a missing id', [{ kind: 'once', name: 'x', color: 'red' }]],
  ['an empty id', [{ ...saved, id: '' }]],
  ['an id over 64 characters', [{ ...saved, id: 'x'.repeat(65) }]],
  ['an empty name', [{ ...once, name: '' }]],
  ['a blank name', [{ ...once, name: '   ' }]],
  ['a name over 64 characters', [{ ...once, name: 'x'.repeat(65) }]],
  ['a hex colour', [{ ...once, color: '#ff0000' }]],
  ['an upper-case colour token', [{ ...once, color: 'Red' }]],
  ['a colour token over 24 characters', [{ ...once, color: `a${'b'.repeat(24)}` }]],
  ['a missing colour', [{ id: 'once-1', kind: 'once', name: 'x' }]],
  ['more than 20 labels', manyLabels(21)],
  ['a non-array', saved],
  ['null', null]
]

describe('kanban.ticket.update labels', () => {
  it('accepts the full list and passes it through untouched', async () => {
    const updateTicket = vi.fn(() => Effect.succeed(ticket))
    await expect(
      run(makeService({ updateTicket }), 'kanban.ticket.update', update([saved, once]))
    ).resolves.toEqual(ticket)
    expect(updateTicket).toHaveBeenCalledWith('p1', 't1', { labels: [saved, once] })
  })

  it('accepts an empty list (the last label removed) and exactly 20 labels', async () => {
    const updateTicket = vi.fn(() => Effect.succeed(ticket))
    const service = makeService({ updateTicket })
    await run(service, 'kanban.ticket.update', update([]))
    await run(service, 'kanban.ticket.update', update(manyLabels(20)))
    expect(updateTicket).toHaveBeenNthCalledWith(1, 'p1', 't1', { labels: [] })
    expect(updateTicket).toHaveBeenNthCalledWith(2, 'p1', 't1', { labels: manyLabels(20) })
  })

  it('keeps a colour token from a newer build that is not in this palette', async () => {
    const updateTicket = vi.fn(() => Effect.succeed(ticket))
    const fromNewerBuild = { ...saved, color: 'lime-2' }
    await run(makeService({ updateTicket }), 'kanban.ticket.update', update([fromNewerBuild]))
    expect(updateTicket).toHaveBeenCalledWith('p1', 't1', { labels: [fromNewerBuild] })
  })

  it('accepts labels next to other fields', async () => {
    const updateTicket = vi.fn(() => Effect.succeed(ticket))
    await run(makeService({ updateTicket }), 'kanban.ticket.update', {
      projectId: 'p1',
      id: 't1',
      data: { note: 'private', labels: [once] }
    })
    expect(updateTicket).toHaveBeenCalledWith('p1', 't1', { note: 'private', labels: [once] })
  })

  it.each(malformed)('rejects %s', async (_what, labels) => {
    const updateTicket = vi.fn(() => Effect.succeed(ticket))
    await expect(
      run(makeService({ updateTicket }), 'kanban.ticket.update', update(labels))
    ).rejects.toBeTruthy()
    expect(updateTicket).not.toHaveBeenCalled()
  })
})

describe('kanban.ticket.create labels', () => {
  it('accepts labels and passes them through untouched', async () => {
    const createTicket = vi.fn(() => Effect.succeed(ticket))
    await expect(
      run(makeService({ createTicket }), 'kanban.ticket.create', create([saved, once]))
    ).resolves.toEqual(ticket)
    expect(createTicket).toHaveBeenCalledWith('p1', create([saved, once]))
  })

  it('still creates a ticket without labels', async () => {
    const createTicket = vi.fn(() => Effect.succeed(ticket))
    await run(makeService({ createTicket }), 'kanban.ticket.create', {
      project_id: 'p1',
      title: 'Ship it'
    })
    expect(createTicket).toHaveBeenCalledWith('p1', { project_id: 'p1', title: 'Ship it' })
  })

  it.each(malformed)('rejects %s', async (_what, labels) => {
    const createTicket = vi.fn(() => Effect.succeed(ticket))
    await expect(
      run(makeService({ createTicket }), 'kanban.ticket.create', create(labels))
    ).rejects.toBeTruthy()
    expect(createTicket).not.toHaveBeenCalled()
  })
})

describe('kanban.ticket.createBatch labels', () => {
  // The batch item schema is derived from the create schema (.extend().omit()), so it must
  // inherit `labels` and the same strictness.
  const batch = (labels: unknown): Record<string, unknown> => ({
    projectId: 'p1',
    data: { drafts: [{ draft_key: 'd1', project_id: 'p1', title: 'Ship it', labels }] }
  })

  it('accepts labels on a draft', async () => {
    const createTicketBatch = vi.fn(() => Effect.succeed({} as never))
    await run(makeService({ createTicketBatch }), 'kanban.ticket.createBatch', batch([saved]))
    expect(createTicketBatch).toHaveBeenCalledWith('p1', {
      drafts: [{ draft_key: 'd1', project_id: 'p1', title: 'Ship it', labels: [saved] }]
    })
  })

  it('rejects a malformed label on a draft', async () => {
    const createTicketBatch = vi.fn(() => Effect.succeed({} as never))
    await expect(
      run(
        makeService({ createTicketBatch }),
        'kanban.ticket.createBatch',
        batch([{ ...saved, extra: true }])
      )
    ).rejects.toBeTruthy()
    expect(createTicketBatch).not.toHaveBeenCalled()
  })
})
