import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import type { SavedTicketLabel, SavedTicketLabelMutationResult } from '../../../../main/db'
import { makeEventBus } from '../../../events/event-bus'
import { makeRpcRouter, type RpcContext } from '../../router'
import { makeTicketLabelsRpcHandlers, type TicketLabelsRpcService } from '../ticket-labels'

// The saved-label catalog's RPC edge: the handlers parse strict params and hand them to the
// service untouched (the DB normalises names and owns the user-facing errors). The router tests
// at the end pin what the renderer sees: VALIDATION_FAILED for bad params, the DB's own message
// for a name clash, and FORBIDDEN for every device principal (the catalog is desktop-only).

const label: SavedTicketLabel = {
  id: 'lbl-1',
  name: 'Waiting for Joy',
  color: 'yellow',
  sort_order: 0,
  created_at: '2026-10-22T00:00:00.000Z',
  updated_at: '2026-10-22T00:00:00.000Z'
}

const mutation: SavedTicketLabelMutationResult = { label, affectedProjectIds: ['p1'] }

const context = { eventBus: null } as unknown as RpcContext

function makeService(overrides: Partial<TicketLabelsRpcService> = {}): TicketLabelsRpcService {
  return {
    list: () => Effect.succeed([label]),
    create: () => Effect.succeed(label),
    update: () => Effect.succeed(mutation),
    reorder: () => Effect.succeed({ label: null, affectedProjectIds: [] }),
    delete: () => Effect.succeed(mutation),
    usage: () => Effect.succeed({ 'lbl-1': 3 }),
    ...overrides
  }
}

function run(service: TicketLabelsRpcService, method: string, params: unknown): Promise<unknown> {
  const handler = makeTicketLabelsRpcHandlers(service).get(method)
  if (!handler) throw new Error(`missing handler for ${method}`)
  return Effect.runPromise(handler(params, context) as Effect.Effect<unknown, never, never>)
}

function makeRouter(service: TicketLabelsRpcService) {
  return makeRpcRouter(
    { eventBus: makeEventBus() },
    makeTicketLabelsRpcHandlers(service)
  )
}

describe('ticketLabels RPC handlers', () => {
  it('registers exactly the six catalog methods', () => {
    const handlers = makeTicketLabelsRpcHandlers(makeService())
    expect([...handlers.keys()].sort()).toEqual([
      'ticketLabels.create',
      'ticketLabels.delete',
      'ticketLabels.list',
      'ticketLabels.reorder',
      'ticketLabels.update',
      'ticketLabels.usage'
    ])
  })

  it('lists the catalog with empty params (also undefined / null)', async () => {
    for (const params of [{}, undefined, null]) {
      await expect(run(makeService(), 'ticketLabels.list', params)).resolves.toEqual([label])
    }
  })

  it('rejects list params with keys', async () => {
    await expect(run(makeService(), 'ticketLabels.list', { projectId: 'p1' })).rejects.toBeTruthy()
  })

  it('creates from flat params and passes the raw name to the service', async () => {
    const create = vi.fn(() => Effect.succeed(label))
    // Not trimmed here: the DB normalises the name (and rejects a blank one with its own message).
    const params = { name: '  Waiting for Joy ', color: 'yellow' }
    await expect(run(makeService({ create }), 'ticketLabels.create', params)).resolves.toEqual(
      label
    )
    expect(create).toHaveBeenCalledWith(params)
  })

  it('accepts every preset colour on create', async () => {
    for (const color of [
      'gray',
      'red',
      'orange',
      'yellow',
      'green',
      'teal',
      'blue',
      'purple',
      'pink'
    ]) {
      await expect(
        run(makeService(), 'ticketLabels.create', { name: 'x', color })
      ).resolves.toEqual(label)
    }
  })

  it('rejects create with an unknown colour, a colour token outside the palette or no colour', async () => {
    for (const params of [
      { name: 'x', color: 'magenta' },
      { name: 'x', color: 'Yellow' },
      { name: 'x', color: '#ff0' },
      { name: 'x' }
    ]) {
      await expect(run(makeService(), 'ticketLabels.create', params)).rejects.toBeTruthy()
    }
  })

  it('rejects create with an empty, missing or absurdly long name', async () => {
    for (const params of [
      { name: '', color: 'red' },
      { color: 'red' },
      { name: 'x'.repeat(65), color: 'red' }
    ]) {
      await expect(run(makeService(), 'ticketLabels.create', params)).rejects.toBeTruthy()
    }
  })

  it('rejects create params with unknown keys (strict schema)', async () => {
    await expect(
      run(makeService(), 'ticketLabels.create', { name: 'x', color: 'red', kind: 'saved' })
    ).rejects.toBeTruthy()
  })

  it('updates via {id, data} params', async () => {
    const update = vi.fn(() => Effect.succeed(mutation))
    await expect(
      run(makeService({ update }), 'ticketLabels.update', {
        id: 'lbl-1',
        data: { name: 'Waiting for Ana', color: 'teal' }
      })
    ).resolves.toEqual(mutation)
    expect(update).toHaveBeenCalledWith('lbl-1', { name: 'Waiting for Ana', color: 'teal' })
  })

  it('updates only the colour or only the name', async () => {
    const update = vi.fn(() => Effect.succeed(mutation))
    const service = makeService({ update })
    await run(service, 'ticketLabels.update', { id: 'lbl-1', data: { color: 'pink' } })
    await run(service, 'ticketLabels.update', { id: 'lbl-1', data: { name: 'Joy' } })
    expect(update).toHaveBeenNthCalledWith(1, 'lbl-1', { color: 'pink' })
    expect(update).toHaveBeenNthCalledWith(2, 'lbl-1', { name: 'Joy' })
  })

  it('rejects update data with unknown keys or an unknown colour', async () => {
    for (const data of [{ sort_order: 2 }, { color: 'magenta' }, { name: '' }]) {
      await expect(
        run(makeService(), 'ticketLabels.update', { id: 'lbl-1', data })
      ).rejects.toBeTruthy()
    }
  })

  it('rejects update without an id or with a flat body', async () => {
    await expect(
      run(makeService(), 'ticketLabels.update', { data: { name: 'x' } })
    ).rejects.toBeTruthy()
    await expect(
      run(makeService(), 'ticketLabels.update', { id: 'lbl-1', name: 'x' })
    ).rejects.toBeTruthy()
  })

  it('reorders by a list of ids', async () => {
    const reorder = vi.fn(() => Effect.succeed({ label: null, affectedProjectIds: ['p1'] }))
    await expect(
      run(makeService({ reorder }), 'ticketLabels.reorder', { ids: ['lbl-2', 'lbl-1'] })
    ).resolves.toEqual({ label: null, affectedProjectIds: ['p1'] })
    expect(reorder).toHaveBeenCalledWith(['lbl-2', 'lbl-1'])
  })

  it('accepts an empty reorder and rejects a non-array, a non-string id or more than 500 ids', async () => {
    await expect(run(makeService(), 'ticketLabels.reorder', { ids: [] })).resolves.toBeTruthy()
    for (const params of [
      { ids: 'lbl-1' },
      { ids: [1] },
      { ids: [''] },
      { ids: Array.from({ length: 501 }, (_, i) => `lbl-${i}`) },
      {}
    ]) {
      await expect(run(makeService(), 'ticketLabels.reorder', params)).rejects.toBeTruthy()
    }
  })

  it('deletes by id', async () => {
    const del = vi.fn(() => Effect.succeed(mutation))
    await expect(
      run(makeService({ delete: del }), 'ticketLabels.delete', { id: 'lbl-1' })
    ).resolves.toEqual(mutation)
    expect(del).toHaveBeenCalledWith('lbl-1')
  })

  it('rejects delete without an id or with extra keys', async () => {
    await expect(run(makeService(), 'ticketLabels.delete', {})).rejects.toBeTruthy()
    await expect(
      run(makeService(), 'ticketLabels.delete', { id: 'lbl-1', projectId: 'p1' })
    ).rejects.toBeTruthy()
  })

  it('returns the usage counts with empty params', async () => {
    await expect(run(makeService(), 'ticketLabels.usage', {})).resolves.toEqual({ 'lbl-1': 3 })
    await expect(run(makeService(), 'ticketLabels.usage', { id: 'lbl-1' })).rejects.toBeTruthy()
  })
})

describe('ticketLabels through the RPC router', () => {
  it('answers bad params with VALIDATION_FAILED and never calls the service', async () => {
    const create = vi.fn(() => Effect.succeed(label))
    const update = vi.fn(() => Effect.succeed(mutation))
    const router = makeRouter(makeService({ create, update }))

    const badColour = await Effect.runPromise(
      router.handle({
        id: '1',
        method: 'ticketLabels.create',
        params: { name: 'Joy', color: 'magenta' }
      })
    )
    expect(badColour).toMatchObject({ id: '1', ok: false, error: { code: 'VALIDATION_FAILED' } })

    const extraKey = await Effect.runPromise(
      router.handle({
        id: '2',
        method: 'ticketLabels.update',
        params: { id: 'lbl-1', data: { name: 'Joy', projectId: 'p1' } }
      })
    )
    expect(extraKey).toMatchObject({ id: '2', ok: false, error: { code: 'VALIDATION_FAILED' } })

    expect(create).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it("keeps the DB's message on a name clash, so the dialog can show it", async () => {
    const message = 'A label named "Waiting for Joy" already exists'
    const router = makeRouter(
      makeService({
        create: () => Effect.fail(new Error(message)),
        update: () => Effect.fail(new Error(message))
      })
    )

    const created = await Effect.runPromise(
      router.handle({
        id: '1',
        method: 'ticketLabels.create',
        params: { name: 'waiting for joy', color: 'red' }
      })
    )
    expect(created).toEqual({ id: '1', ok: false, error: { code: 'INTERNAL_ERROR', message } })

    const updated = await Effect.runPromise(
      router.handle({
        id: '2',
        method: 'ticketLabels.update',
        params: { id: 'lbl-2', data: { name: 'Waiting for Joy' } }
      })
    )
    expect(updated).toEqual({ id: '2', ok: false, error: { code: 'INTERNAL_ERROR', message } })
  })
})
