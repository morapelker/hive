import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { USER_INTERRUPT_DETAIL } from '@shared/document-flow/planning'
import type { DocumentRunItem, DocumentRunStatus } from '@shared/types/document-flow'
import {
  DocumentFlowRunner,
  SETTLE_MS,
  TICK_INTERVAL_MS,
  hasBusyDocumentRun,
  isDocumentRunBusy
} from './runner'
import {
  FakeTransportError,
  INTEGRATION_WORKTREE,
  PROJECT_ID,
  SERVER_STARTED_AT,
  TEST_NOW,
  advance,
  createWorld,
  makeItem,
  makeRun,
  type RunnerWorld
} from './runner-fakes'

const PROMPTED_AT = '2026-05-04T09:59:00.000Z'

const runningItem = (
  key: string,
  overrides: Partial<DocumentRunItem> = {}
): Partial<DocumentRunItem> => ({
  key,
  status: 'running',
  session_id: `s-${key}`,
  worktree_id: `wt-${key}`,
  branch_name: `${key.toLowerCase()}-task`,
  started_at: PROMPTED_AT,
  last_prompt_at: PROMPTED_AT,
  ...overrides
})

describe('DocumentFlowRunner: driving a run', () => {
  let runner: DocumentFlowRunner | null = null

  const start = (world: RunnerWorld): void => {
    runner = new DocumentFlowRunner(world.ports)
    runner.start()
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(TEST_NOW))
  })

  afterEach(() => {
    runner?.stop()
    runner = null
    vi.useRealTimers()
  })

  describe('lease', () => {
    it('does nothing for a run another window drives', async () => {
      const world = createWorld({ items: [{ key: 'A' }, runningItem('B')] })
      world.api.claimRunner.mockResolvedValue({
        owned: false,
        ownerClientId: 'other-window',
        serverStartedAt: SERVER_STARTED_AT
      })
      world.endTurn('s-B', { at: Date.now() - 60_000 })
      start(world)

      await advance(60_000)

      expect(world.api.claimRunner).toHaveBeenCalledWith('run-1', 'client-1')
      expect(world.ports.loadProject).not.toHaveBeenCalled()
      expect(world.ports.launchTicket).not.toHaveBeenCalled()
      expect(world.ports.updateItem).not.toHaveBeenCalled()
      expect(world.api.classify).not.toHaveBeenCalled()
      expect(world.ports.fireSetupScript).not.toHaveBeenCalled()
    })

    it('takes the run over once the other window lets go of it', async () => {
      const world = createWorld()
      world.api.claimRunner.mockResolvedValueOnce({
        owned: false,
        ownerClientId: 'other-window',
        serverStartedAt: SERVER_STARTED_AT
      })
      start(world)

      await advance(5000)
      expect(world.ports.launchTicket).not.toHaveBeenCalled()

      await advance(TICK_INTERVAL_MS)
      expect(world.item('A').status).toBe('running')
    })

    it('renews the lease on the interval, not on every tick', async () => {
      const world = createWorld({ items: [runningItem('A')] })
      world.setSignal('s-A', { kind: 'working' })
      start(world)
      await advance(500)

      // A streaming session changes the status store many times a second.
      for (let burst = 0; burst < 40; burst++) {
        world.setSignal('s-A', { kind: 'working' })
        await advance(100)
      }
      expect(world.api.claimRunner).toHaveBeenCalledTimes(1)

      await advance(60_000)
      const claims = world.api.claimRunner.mock.calls.length
      expect(claims).toBeGreaterThanOrEqual(6)
      expect(claims).toBeLessThanOrEqual(8)
    })

    it('skips the run while the server cannot be reached, without spinning', async () => {
      const world = createWorld()
      world.api.claimRunner.mockRejectedValue(new FakeTransportError('socket closed'))
      start(world)

      await advance(35_000)

      expect(world.ports.launchTicket).not.toHaveBeenCalled()
      expect(world.api.claimRunner.mock.calls.length).toBeLessThanOrEqual(4)
    })
  })

  describe('which runs are driven', () => {
    it.each(['paused', 'preview', 'extracting', 'completed', 'cancelled'] as DocumentRunStatus[])(
      'never acts on a %s run',
      async (status) => {
        const world = createWorld({ run: { status }, items: [{ key: 'A' }, runningItem('B')] })
        world.endTurn('s-B', { at: Date.now() - 60_000 })
        start(world)

        await advance(30_000)

        expect(world.api.claimRunner).not.toHaveBeenCalled()
        expect(world.ports.launchTicket).not.toHaveBeenCalled()
        expect(world.ports.updateItem).not.toHaveBeenCalled()
        expect(world.api.finalize).not.toHaveBeenCalled()
      }
    )

    it('starts driving a run when it is resumed', async () => {
      const world = createWorld({ run: { status: 'paused' } })
      start(world)
      await advance(5000)
      expect(world.ports.launchTicket).not.toHaveBeenCalled()

      world.setRun({ status: 'running' })
      await advance(1000)

      expect(world.item('A').status).toBe('running')
    })

    it('leaves deselected items alone', async () => {
      const world = createWorld({ items: [{ key: 'A', selected: false }, { key: 'B' }] })
      start(world)

      await advance(5000)

      expect(world.statuses()).toEqual({ A: 'pending', B: 'running' })
    })

    it('stops acting after stop()', async () => {
      const world = createWorld({ items: [runningItem('A')] })
      start(world)
      await advance(500)

      runner?.stop()
      world.endTurn('s-A', { at: Date.now() - 60_000 })
      await advance(60_000)

      expect(world.ports.updateItem).not.toHaveBeenCalled()
    })
  })

  describe('first tick', () => {
    it('loads the project and installs the integration worktree’s dependencies once', async () => {
      const world = createWorld()
      start(world)

      await advance(60_000)

      expect(world.ports.loadProject).toHaveBeenCalledTimes(1)
      expect(world.ports.loadProject).toHaveBeenCalledWith(PROJECT_ID)
      expect(world.ports.fireSetupScript).toHaveBeenCalledTimes(1)
      expect(world.ports.fireSetupScript).toHaveBeenCalledWith(
        PROJECT_ID,
        INTEGRATION_WORKTREE,
        '/worktrees/shop--doc-checkout'
      )
    })

    it('does not run the setup script again when the run was already under way', async () => {
      const world = createWorld({ items: [runningItem('A'), { key: 'B' }] })
      world.setSignal('s-A', { kind: 'working' })
      start(world)

      await advance(5000)

      expect(world.ports.loadProject).toHaveBeenCalledTimes(1)
      expect(world.ports.fireSetupScript).not.toHaveBeenCalled()
    })

    it('does not start a second setup run while one is going', async () => {
      const world = createWorld()
      world.setupRunning.add(INTEGRATION_WORKTREE)
      start(world)

      await advance(5000)

      expect(world.ports.fireSetupScript).not.toHaveBeenCalled()
    })

    it('tries again on the next interval when loading the project fails', async () => {
      const world = createWorld()
      world.ports.loadProject.mockRejectedValueOnce(new FakeTransportError('socket closed'))
      start(world)

      await advance(5000)
      expect(world.ports.launchTicket).not.toHaveBeenCalled()

      await advance(TICK_INTERVAL_MS)
      expect(world.ports.loadProject).toHaveBeenCalledTimes(2)
      expect(world.item('A').status).toBe('running')
    })
  })

  describe('finishing', () => {
    it('finalizes once when every selected item is terminal and reports the result', async () => {
      const world = createWorld({ items: [runningItem('A'), { key: 'B', selected: false }] })
      start(world)

      world.endTurn('s-A')
      await advance(SETTLE_MS - 500)
      expect(world.api.finalize).not.toHaveBeenCalled()

      await advance(60_000)

      expect(world.api.finalize).toHaveBeenCalledTimes(1)
      expect(world.api.finalize).toHaveBeenCalledWith('run-1')
      expect(world.ports.applyDetail).toHaveBeenCalledTimes(1)
      expect(world.detail().run.status).toBe('completed')
      expect(world.notices).toEqual([
        { level: 'success', message: 'Document run finished: 1 merged' }
      ])
    })

    it('reports a run that finished with skipped tickets as finished with issues', async () => {
      const world = createWorld({
        items: [
          { key: 'A', status: 'merged' },
          { key: 'B', status: 'skipped' }
        ]
      })
      start(world)

      await advance(30_000)

      expect(world.api.finalize).toHaveBeenCalledTimes(1)
      expect(world.notices).toEqual([
        { level: 'warning', message: 'Document run finished with issues: 1 of 2 merged' }
      ])
    })

    it('does not finalize while a ticket is flagged or waiting', async () => {
      const world = createWorld({
        items: [
          { key: 'A', status: 'merged' },
          { key: 'B', status: 'needs_attention' }
        ]
      })
      start(world)

      await advance(30_000)

      expect(world.api.finalize).not.toHaveBeenCalled()
    })

    it('backs off when finalizing fails', async () => {
      const world = createWorld({ items: [{ key: 'A', status: 'merged' }] })
      world.api.finalize.mockRejectedValueOnce(new Error('report failed'))
      start(world)

      await advance(55_000)
      expect(world.api.finalize).toHaveBeenCalledTimes(1)
      expect(world.notices).toEqual([])

      await advance(20_000)
      expect(world.api.finalize).toHaveBeenCalledTimes(2)
      expect(world.detail().run.status).toBe('completed')
    })
  })

  describe('failures stay with their item', () => {
    it('keeps driving the other tickets when one step throws', async () => {
      const world = createWorld({ items: [runningItem('A'), runningItem('B')] })
      world.api.classify.mockImplementation(async ({ itemId }) => {
        if (itemId === 'item-A') throw new Error('classifier exploded')
        return (await import('./runner-fakes')).makeVerdict()
      })
      start(world)

      world.endTurn('s-A')
      world.endTurn('s-B')
      await advance(SETTLE_MS + 2000)

      expect(world.item('A')).toMatchObject({
        status: 'needs_attention',
        status_detail: 'classifier exploded'
      })
      expect(world.item('B').status).toBe('merged')
    })

    it('retries a write the server could not take on the interval, not in a loop', async () => {
      const world = createWorld({ items: [runningItem('A')] })
      world.setSignal('s-A', { kind: 'blocked', reason: 'question', detail: null })
      world.ports.updateItem.mockRejectedValue(new FakeTransportError('socket closed'))
      start(world)

      await advance(35_000)

      expect(world.item('A').status).toBe('running')
      expect(world.notices).toEqual([])
      const attempts = world.ports.updateItem.mock.calls.length
      expect(attempts).toBeGreaterThanOrEqual(2)
      expect(attempts).toBeLessThanOrEqual(4)
    })

    it('does not act on a row older than what it just wrote', async () => {
      const world = createWorld()
      start(world)
      await advance(500)
      expect(world.item('A').status).toBe('running')

      // A re-read that left the server before the write lands after it.
      world.setItem('A', { status: 'pending', session_id: null })
      await advance(1000)
      expect(world.ports.launchTicket).toHaveBeenCalledTimes(1)

      world.setItem('A', { status: 'running', session_id: 'session-1' })
      await advance(20_000)
      expect(world.ports.launchTicket).toHaveBeenCalledTimes(1)
    })
  })
})

describe('isDocumentRunBusy', () => {
  const detail = (
    status: DocumentRunStatus,
    items: Partial<DocumentRunItem>[]
  ): Parameters<typeof isDocumentRunBusy>[0] => ({
    run: makeRun({ status }),
    items: items.map((item, position) => makeItem({ position, ...item })),
    events: []
  })

  it('is busy while the orchestrator has something to do without the user', () => {
    expect(isDocumentRunBusy(detail('running', [{ key: 'A', status: 'checking' }]))).toBe(true)
    expect(isDocumentRunBusy(detail('running', [{ key: 'A', status: 'verifying' }]))).toBe(true)
    expect(isDocumentRunBusy(detail('running', [{ key: 'A', status: 'pending' }]))).toBe(true)
  })

  it('is not busy when the run only waits on the user', () => {
    expect(
      isDocumentRunBusy(
        detail('running', [
          { key: 'A', status: 'needs_input' },
          { key: 'B', status: 'needs_attention' },
          { key: 'C', status: 'pending', depends_on: ['A'] }
        ])
      )
    ).toBe(false)
  })

  it('is not busy while a conflict or fix session waits on the user', () => {
    const waiting = 'Waiting for you: Keep both prices?'
    expect(
      isDocumentRunBusy(
        detail('running', [{ key: 'A', status: 'resolving_conflicts', status_detail: waiting }])
      )
    ).toBe(false)
    expect(
      isDocumentRunBusy(
        detail('running', [{ key: 'A', status: 'fixing', status_detail: USER_INTERRUPT_DETAIL }])
      )
    ).toBe(false)
    expect(
      isDocumentRunBusy(
        detail('running', [
          { key: 'A', status: 'resolving_conflicts', status_detail: 'Resolving conflicts' }
        ])
      )
    ).toBe(true)
  })

  it('is not busy when every slot is held by an item waiting on the user', () => {
    const slots = detail('running', [
      { key: 'A', status: 'needs_input' },
      { key: 'B', status: 'pending' }
    ])
    slots.run.config.maxParallel = 1
    expect(isDocumentRunBusy(slots)).toBe(false)
    slots.run.config.maxParallel = 2
    expect(isDocumentRunBusy(slots)).toBe(true)
  })

  it('is not busy when the run is settled, not running, or has nothing selected', () => {
    expect(isDocumentRunBusy(detail('running', [{ key: 'A', status: 'merged' }]))).toBe(false)
    expect(isDocumentRunBusy(detail('paused', [{ key: 'A', status: 'checking' }]))).toBe(false)
    expect(isDocumentRunBusy(detail('completed', [{ key: 'A', status: 'merged' }]))).toBe(false)
    expect(
      isDocumentRunBusy(detail('running', [{ key: 'A', status: 'pending', selected: false }]))
    ).toBe(false)
  })

  it('looks across every loaded run', () => {
    const idle = detail('running', [{ key: 'A', status: 'needs_input' }])
    const busy = detail('running', [{ key: 'A', status: 'merging' }])
    expect(hasBusyDocumentRun({})).toBe(false)
    expect(hasBusyDocumentRun({ idle })).toBe(false)
    expect(hasBusyDocumentRun({ idle, busy })).toBe(true)
  })
})
