import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SavedTicketLabel } from '@shared/lib/ticket-labels'
import { setRendererRpcClient, resetRendererRpcClientForTests } from '@/api/rpc-client'
import { useKanbanStore } from '../useKanbanStore'
import { useTicketLabelsStore } from '../useTicketLabelsStore'

const label = (overrides: Partial<SavedTicketLabel> = {}): SavedTicketLabel => ({
  id: 'l1',
  name: 'Waiting for Joy',
  color: 'yellow',
  sort_order: 0,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
  ...overrides
})

const JOY = label()
const BLOCKED = label({ id: 'l2', name: 'Blocked', color: 'red', sort_order: 1 })
const QA = label({ id: 'l3', name: 'Needs QA', color: 'blue', sort_order: 2 })

const noChange = { label: null, affectedProjectIds: [] }

/** A promise the test settles by hand, to hold an RPC in flight. */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: Error) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Lets every queued promise callback run. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

let request: ReturnType<typeof vi.fn>
let applySavedLabelChange: ReturnType<typeof vi.fn>
const initialKanbanState = useKanbanStore.getState()

const ids = (): string[] => useTicketLabelsStore.getState().labels.map((l) => l.id)
const callsTo = (method: string): unknown[][] =>
  request.mock.calls.filter(([name]) => name === method)

beforeEach(() => {
  request = vi.fn()
  setRendererRpcClient({ request, subscribe: vi.fn() })
  applySavedLabelChange = vi.fn()
  useKanbanStore.setState({ applySavedLabelChange })
  useTicketLabelsStore.setState({ labels: [], loaded: false, dialog: null })
})

afterEach(async () => {
  await flush()
  resetRendererRpcClientForTests()
  useKanbanStore.setState(initialKanbanState, true)
  vi.restoreAllMocks()
})

describe('load', () => {
  it('loads the catalog via ticketLabels.list', async () => {
    request.mockResolvedValueOnce([JOY, BLOCKED])

    await useTicketLabelsStore.getState().load()

    expect(request).toHaveBeenCalledWith('ticketLabels.list', {})
    expect(useTicketLabelsStore.getState().labels).toEqual([JOY, BLOCKED])
    expect(useTicketLabelsStore.getState().loaded).toBe(true)
  })

  it('keeps the current list and stays unloaded when the fetch fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    request.mockRejectedValueOnce(new Error('server down'))

    await expect(useTicketLabelsStore.getState().load()).resolves.toBeUndefined()

    expect(useTicketLabelsStore.getState().loaded).toBe(false)
    expect(useTicketLabelsStore.getState().labels).toEqual([])
    expect(consoleError).toHaveBeenCalled()

    request.mockResolvedValueOnce([JOY])
    await useTicketLabelsStore.getState().ensureLoaded()
    expect(useTicketLabelsStore.getState().loaded).toBe(true)
  })

  it('ensureLoaded fetches once, sharing an in-flight fetch', async () => {
    const list = deferred<SavedTicketLabel[]>()
    request.mockReturnValueOnce(list.promise)

    const first = useTicketLabelsStore.getState().ensureLoaded()
    const second = useTicketLabelsStore.getState().ensureLoaded()
    list.resolve([JOY])
    await Promise.all([first, second])
    await useTicketLabelsStore.getState().ensureLoaded()

    expect(callsTo('ticketLabels.list')).toHaveLength(1)
    expect(ids()).toEqual(['l1'])
  })

  it('fetches again when load is called while a fetch is in flight', async () => {
    // A db:changed event arrives while the first response is on its way: it may predate it.
    const first = deferred<SavedTicketLabel[]>()
    request.mockReturnValueOnce(first.promise).mockResolvedValueOnce([JOY, BLOCKED])

    const loading = useTicketLabelsStore.getState().load()
    const again = useTicketLabelsStore.getState().load()
    first.resolve([JOY])
    await Promise.all([loading, again])

    expect(callsTo('ticketLabels.list')).toHaveLength(2)
    expect(ids()).toEqual(['l1', 'l2'])
  })

  it('refetches instead of applying a list that predates a write that landed mid-load', async () => {
    useTicketLabelsStore.setState({ labels: [JOY], loaded: true })
    const staleList = deferred<SavedTicketLabel[]>()
    const renamed = { ...JOY, name: 'Joy', updated_at: '2026-10-02T00:00:00.000Z' }
    request.mockImplementation((method: string) => {
      if (method === 'ticketLabels.list') {
        return callsTo('ticketLabels.list').length === 1
          ? staleList.promise
          : Promise.resolve([renamed])
      }
      if (method === 'ticketLabels.update') {
        return Promise.resolve({ label: renamed, affectedProjectIds: ['p1'] })
      }
      return Promise.resolve(null)
    })

    const loading = useTicketLabelsStore.getState().load()
    await useTicketLabelsStore.getState().update('l1', { name: 'Joy' })
    // The first response predates the rename: it must not bring the old name back.
    staleList.resolve([JOY])
    await loading

    expect(callsTo('ticketLabels.list')).toHaveLength(2)
    expect(useTicketLabelsStore.getState().labels).toEqual([renamed])
  })

  it('never applies a list while a write is in flight, and refetches once it settles', async () => {
    useTicketLabelsStore.setState({ labels: [JOY, BLOCKED], loaded: true })
    const remove = deferred<unknown>()
    request.mockImplementation((method: string) => {
      if (method === 'ticketLabels.delete') return remove.promise
      if (method === 'ticketLabels.list') {
        // The first fetch still sees the label; the one after the delete does not.
        return Promise.resolve(
          callsTo('ticketLabels.list').length === 1 ? [JOY, BLOCKED] : [BLOCKED]
        )
      }
      return Promise.resolve(null)
    })

    const removing = useTicketLabelsStore.getState().remove('l1')
    expect(ids()).toEqual(['l2'])

    await useTicketLabelsStore.getState().load()
    // Dropped: applying it would bring the label being deleted back on screen.
    expect(ids()).toEqual(['l2'])
    expect(callsTo('ticketLabels.list')).toHaveLength(1)

    remove.resolve({ label: JOY, affectedProjectIds: [] })
    await removing
    await flush()

    expect(callsTo('ticketLabels.list')).toHaveLength(2)
    expect(ids()).toEqual(['l2'])
  })
})

describe('create', () => {
  it('creates with the normalised name and appends the returned row', async () => {
    useTicketLabelsStore.setState({ labels: [JOY], loaded: true })
    const created = label({ id: 'l9', name: 'Ping Dana', color: 'green', sort_order: 1 })
    request.mockResolvedValueOnce(created)

    const result = await useTicketLabelsStore
      .getState()
      .create({ name: '  Ping   Dana ', color: 'green' })

    expect(request).toHaveBeenCalledWith('ticketLabels.create', {
      name: 'Ping Dana',
      color: 'green'
    })
    expect(result).toEqual(created)
    expect(ids()).toEqual(['l1', 'l9'])
  })

  it('rejects a name clash locally (case- and space-insensitive) without calling the server', async () => {
    useTicketLabelsStore.setState({ labels: [JOY], loaded: true })

    await expect(
      useTicketLabelsStore.getState().create({ name: ' WAITING  for joy', color: 'red' })
    ).rejects.toThrow('A label named "WAITING for joy" already exists')
    expect(request).not.toHaveBeenCalled()
    expect(ids()).toEqual(['l1'])
  })

  it('rejects an empty name without calling the server', async () => {
    await expect(
      useTicketLabelsStore.getState().create({ name: '   ', color: 'red' })
    ).rejects.toThrow('Label name is required')
    expect(request).not.toHaveBeenCalled()
  })

  it('passes the server’s message through (a clash with another window’s label)', async () => {
    request.mockRejectedValueOnce(new Error('A label named "Joy" already exists'))

    await expect(
      useTicketLabelsStore.getState().create({ name: 'Joy', color: 'red' })
    ).rejects.toThrow('A label named "Joy" already exists')
    expect(useTicketLabelsStore.getState().labels).toEqual([])
  })
})

describe('update', () => {
  it('applies the rename at once, then the server row, and patches the loaded tickets', async () => {
    useTicketLabelsStore.setState({ labels: [JOY, BLOCKED], loaded: true })
    const pending = deferred<unknown>()
    request.mockReturnValueOnce(pending.promise)

    const updating = useTicketLabelsStore.getState().update('l1', { name: ' Joy ', color: 'red' })

    expect(request).toHaveBeenCalledWith('ticketLabels.update', {
      id: 'l1',
      data: { name: 'Joy', color: 'red' }
    })
    expect(useTicketLabelsStore.getState().labels[0]).toMatchObject({ name: 'Joy', color: 'red' })
    expect(applySavedLabelChange).not.toHaveBeenCalled()

    const fromServer = { ...JOY, name: 'Joy', color: 'red', updated_at: '2026-10-02T00:00:00.000Z' }
    pending.resolve({ label: fromServer, affectedProjectIds: ['p1'] })
    await updating

    expect(useTicketLabelsStore.getState().labels).toEqual([fromServer, BLOCKED])
    expect(applySavedLabelChange).toHaveBeenCalledTimes(1)
    expect(applySavedLabelChange).toHaveBeenCalledWith({
      type: 'update',
      label: { id: 'l1', name: 'Joy', color: 'red' }
    })
  })

  it('rolls back and rethrows when the server refuses', async () => {
    useTicketLabelsStore.setState({ labels: [JOY, BLOCKED], loaded: true })
    request.mockRejectedValueOnce(new Error('A label named "Joy" already exists'))

    await expect(useTicketLabelsStore.getState().update('l1', { name: 'Joy' })).rejects.toThrow(
      'A label named "Joy" already exists'
    )

    expect(useTicketLabelsStore.getState().labels).toEqual([JOY, BLOCKED])
    expect(useTicketLabelsStore.getState().labels[0]).toBe(JOY)
    expect(applySavedLabelChange).not.toHaveBeenCalled()
  })

  it('rejects a rename onto another label’s name locally', async () => {
    useTicketLabelsStore.setState({ labels: [JOY, BLOCKED], loaded: true })

    await expect(useTicketLabelsStore.getState().update('l1', { name: 'BLOCKED' })).rejects.toThrow(
      'A label named "BLOCKED" already exists'
    )
    expect(request).not.toHaveBeenCalled()
    expect(useTicketLabelsStore.getState().labels[0]).toBe(JOY)
  })

  it('allows changing only the case of a label’s own name', async () => {
    useTicketLabelsStore.setState({ labels: [JOY], loaded: true })
    const fromServer = { ...JOY, name: 'WAITING FOR JOY' }
    request.mockResolvedValueOnce({ label: fromServer, affectedProjectIds: [] })

    await useTicketLabelsStore.getState().update('l1', { name: 'WAITING FOR JOY' })

    expect(useTicketLabelsStore.getState().labels).toEqual([fromServer])
  })

  it('skips the server when nothing changes', async () => {
    useTicketLabelsStore.setState({ labels: [JOY], loaded: true })

    await useTicketLabelsStore
      .getState()
      .update('l1', { name: ' Waiting for Joy ', color: 'yellow' })

    expect(request).not.toHaveBeenCalled()
    expect(applySavedLabelChange).not.toHaveBeenCalled()
  })

  it('drops the row when the server no longer knows it', async () => {
    useTicketLabelsStore.setState({ labels: [JOY, BLOCKED], loaded: true })
    request.mockResolvedValueOnce(noChange)

    await useTicketLabelsStore.getState().update('l1', { color: 'red' })

    expect(ids()).toEqual(['l2'])
    expect(applySavedLabelChange).not.toHaveBeenCalled()
  })
})

describe('remove', () => {
  it('removes at once and takes the label off the loaded tickets on success', async () => {
    useTicketLabelsStore.setState({ labels: [JOY, BLOCKED], loaded: true })
    const pending = deferred<unknown>()
    request.mockReturnValueOnce(pending.promise)

    const removing = useTicketLabelsStore.getState().remove('l1')

    expect(request).toHaveBeenCalledWith('ticketLabels.delete', { id: 'l1' })
    expect(ids()).toEqual(['l2'])
    expect(applySavedLabelChange).not.toHaveBeenCalled()

    pending.resolve({ label: JOY, affectedProjectIds: ['p1', 'p2'] })
    await removing

    expect(applySavedLabelChange).toHaveBeenCalledTimes(1)
    expect(applySavedLabelChange).toHaveBeenCalledWith({ type: 'delete', id: 'l1' })
  })

  it('puts the label back in its place and rethrows on failure', async () => {
    useTicketLabelsStore.setState({ labels: [JOY, BLOCKED, QA], loaded: true })
    request.mockRejectedValueOnce(new Error('disk full'))

    await expect(useTicketLabelsStore.getState().remove('l2')).rejects.toThrow('disk full')

    expect(ids()).toEqual(['l1', 'l2', 'l3'])
    expect(useTicketLabelsStore.getState().labels[1]).toBe(BLOCKED)
    expect(applySavedLabelChange).not.toHaveBeenCalled()
  })
})

describe('reorder', () => {
  it('reorders at once, sends the full order and re-sorts the loaded tickets on success', async () => {
    useTicketLabelsStore.setState({ labels: [JOY, BLOCKED, QA], loaded: true })
    const pending = deferred<unknown>()
    request.mockReturnValueOnce(pending.promise)

    // Unknown ids are ignored; unlisted ones keep their relative order after the listed ones.
    const reordering = useTicketLabelsStore.getState().reorder(['l3', 'ghost', 'l3'])

    expect(request).toHaveBeenCalledWith('ticketLabels.reorder', { ids: ['l3', 'l1', 'l2'] })
    expect(ids()).toEqual(['l3', 'l1', 'l2'])
    expect(useTicketLabelsStore.getState().labels.map((l) => l.sort_order)).toEqual([0, 1, 2])
    expect(applySavedLabelChange).not.toHaveBeenCalled()

    pending.resolve(noChange)
    await reordering

    expect(applySavedLabelChange).toHaveBeenCalledTimes(1)
    expect(applySavedLabelChange).toHaveBeenCalledWith({ type: 'reorder', ids: ['l3', 'l1', 'l2'] })
  })

  it('restores the previous order and rethrows on failure', async () => {
    useTicketLabelsStore.setState({ labels: [JOY, BLOCKED, QA], loaded: true })
    request.mockRejectedValueOnce(new Error('disk full'))

    await expect(useTicketLabelsStore.getState().reorder(['l2', 'l1', 'l3'])).rejects.toThrow(
      'disk full'
    )

    expect(ids()).toEqual(['l1', 'l2', 'l3'])
    expect(useTicketLabelsStore.getState().labels).toEqual([JOY, BLOCKED, QA])
    expect(applySavedLabelChange).not.toHaveBeenCalled()
  })

  it('skips the server when the order does not change', async () => {
    useTicketLabelsStore.setState({ labels: [JOY, BLOCKED], loaded: true })

    await useTicketLabelsStore.getState().reorder(['l1'])

    expect(request).not.toHaveBeenCalled()
    expect(applySavedLabelChange).not.toHaveBeenCalled()
  })
})

describe('usage and dialogs', () => {
  it('reads the usage counts via ticketLabels.usage', async () => {
    request.mockResolvedValueOnce({ l1: 3 })

    await expect(useTicketLabelsStore.getState().usage()).resolves.toEqual({ l1: 3 })
    expect(request).toHaveBeenCalledWith('ticketLabels.usage', {})
  })

  it('opens and closes the board-level dialog', () => {
    const dialog = { kind: 'create', projectId: 'p1', ticketId: 't1', mode: 'once' } as const
    useTicketLabelsStore.getState().openDialog(dialog)
    expect(useTicketLabelsStore.getState().dialog).toEqual(dialog)

    useTicketLabelsStore.getState().openDialog({ kind: 'manage' })
    expect(useTicketLabelsStore.getState().dialog).toEqual({ kind: 'manage' })

    useTicketLabelsStore.getState().closeDialog()
    expect(useTicketLabelsStore.getState().dialog).toBeNull()
  })
})
