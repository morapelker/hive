import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ALREADY_IMPLEMENTED_DETAIL } from '@shared/document-flow/planning'
import type { DocumentMergeCheckResult, DocumentRunItem } from '@shared/types/document-flow'
import { DocumentFlowRunner, SETTLE_MS } from './runner'
import {
  FakeTransportError,
  RUN_ID,
  TEST_NOW,
  advance,
  createWorld,
  makeVerdict,
  type RunnerWorld
} from './runner-fakes'

// Once the run is finished with a ticket (merged or closed as already implemented, its
// document update over, sitting in Merged), the ticket's worktree is cleaned of what git does
// not track. Once per ticket, whatever its session is doing, and only while the setting is on.

const PROMPTED_AT = '2026-05-04T09:59:00.000Z'

const readyItem = (
  key: string,
  overrides: Partial<DocumentRunItem> = {}
): Partial<DocumentRunItem> => ({
  key,
  status: 'ready',
  session_id: `s-${key}`,
  worktree_id: `wt-${key}`,
  branch_name: `${key.toLowerCase()}-task`,
  started_at: PROMPTED_AT,
  last_prompt_at: PROMPTED_AT,
  ...overrides
})

/** Merged before the runner started, its document update over. */
const finishedItem = (
  key: string,
  overrides: Partial<DocumentRunItem> = {}
): Partial<DocumentRunItem> => ({
  ...readyItem(key),
  status: 'merged',
  merge_sha: `merge-${key}`,
  finished_at: PROMPTED_AT,
  document_update_status: 'done',
  document_update_queued_at: PROMPTED_AT,
  document_update_finished_at: PROMPTED_AT,
  ...overrides
})

const noChanges: DocumentMergeCheckResult = {
  state: 'no_changes',
  conflictedFiles: [],
  committed: false,
  commitsAhead: 0
}

const moveTicket = (
  world: RunnerWorld,
  ticketId: string,
  column: 'merged' | 'in_progress'
): void => {
  const ticket = world.tickets.get(ticketId)
  if (!ticket) throw new Error(`no ticket ${ticketId}`)
  world.tickets.set(ticketId, { ...ticket, column })
}

describe('DocumentFlowRunner: cleaning the worktree of a finished ticket', () => {
  let runner: DocumentFlowRunner | null = null

  const start = (world: RunnerWorld): void => {
    runner = new DocumentFlowRunner(world.ports)
    runner.start()
  }

  /** The agent edits the document and ends its turn; the end settles. */
  const editAndEnd = async (world: RunnerWorld, sessionId: string): Promise<void> => {
    world.editDocument()
    world.endTurn(sessionId)
    await advance(SETTLE_MS + 1000)
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

  describe('a run made from a document', () => {
    it('cleans once the document update is done, not when the ticket merges', async () => {
      const world = createWorld({ items: [readyItem('A'), { key: 'B', depends_on: ['A'] }] })
      world.putDocument()
      start(world)
      await advance(1000)

      // Merged and in Merged, but its session still has the document to update.
      expect(world.item('A')).toMatchObject({
        status: 'merged',
        document_update_status: 'updating'
      })
      expect(world.tickets.get('ticket-A')?.column).toBe('merged')
      await advance(60_000)
      expect(world.api.cleanItemWorktree).not.toHaveBeenCalled()

      await editAndEnd(world, 's-A')

      expect(world.item('A').document_update_status).toBe('done')
      expect(world.api.cleanItemWorktree).toHaveBeenCalledTimes(1)
      expect(world.api.cleanItemWorktree).toHaveBeenCalledWith(RUN_ID, 'item-A')
      expect(world.item('A').worktree_cleaned_at).toEqual(expect.any(String))

      // Never a second time, however long the run goes on.
      await advance(120_000)
      expect(world.api.cleanItemWorktree).toHaveBeenCalledTimes(1)
    })

    it('cleans after putting a ticket the edit pulled out of Merged back there', async () => {
      const world = createWorld({ items: [readyItem('A'), { key: 'B', depends_on: ['A'] }] })
      world.putDocument()
      start(world)
      await advance(1000)
      // The prompt read as the user's: the board reopened the ticket.
      moveTicket(world, 'ticket-A', 'in_progress')

      await editAndEnd(world, 's-A')

      expect(world.tickets.get('ticket-A')?.column).toBe('merged')
      expect(world.api.cleanItemWorktree).toHaveBeenCalledTimes(1)
    })

    it('cleans when the update failed: the run is finished with the ticket all the same', async () => {
      const world = createWorld({ items: [readyItem('A'), { key: 'B', depends_on: ['A'] }] })
      world.putDocument()
      start(world)
      await advance(1000)

      // Two turns that leave the document as it was: reminded once, then failed.
      world.endTurn('s-A')
      await advance(SETTLE_MS + 1000)
      expect(world.api.cleanItemWorktree).not.toHaveBeenCalled()
      world.endTurn('s-A')
      await advance(SETTLE_MS + 1000)

      expect(world.item('A').document_update_status).toBe('failed')
      expect(world.api.cleanItemWorktree).toHaveBeenCalledWith(RUN_ID, 'item-A')
    })

    it('cleans when the update was skipped for want of a document', async () => {
      // No document on the fake disk: the update is skipped before any prompt.
      const world = createWorld({ items: [readyItem('A'), { key: 'B', depends_on: ['A'] }] })
      start(world)
      await advance(1000)

      expect(world.item('A').document_update_status).toBe('skipped')
      expect(world.api.cleanItemWorktree).toHaveBeenCalledWith(RUN_ID, 'item-A')
    })

    it('cleans an update the user skipped from the dashboard, while its session is still at the edit', async () => {
      const world = createWorld({ items: [readyItem('A'), { key: 'B', depends_on: ['A'] }] })
      world.putDocument()
      start(world)
      await advance(1000)
      expect(world.item('A').document_update_status).toBe('updating')

      world.setItem('A', {
        document_update_status: 'skipped',
        document_update_detail: 'Skipped by you.',
        document_update_finished_at: new Date(Date.now()).toISOString()
      })
      await advance(1000)

      // The session is still working: it is not closed, and the worktree is cleaned anyway.
      expect(world.ports.closeTicketSession).not.toHaveBeenCalled()
      expect(world.api.cleanItemWorktree).toHaveBeenCalledWith(RUN_ID, 'item-A')
    })

    it('cleans a ticket closed as already implemented once the document knows', async () => {
      const world = createWorld({
        items: [readyItem('A', { verdict: makeVerdict() }), { key: 'B', depends_on: ['A'] }],
        config: { interactive: false }
      })
      world.putDocument()
      world.api.prepareMerge.mockResolvedValue(noChanges)
      start(world)
      await advance(1000)

      expect(world.item('A')).toMatchObject({
        status: 'skipped',
        status_detail: ALREADY_IMPLEMENTED_DETAIL,
        document_update_status: 'updating'
      })
      expect(world.api.cleanItemWorktree).not.toHaveBeenCalled()

      await editAndEnd(world, 's-A')

      expect(world.api.cleanItemWorktree).toHaveBeenCalledWith(RUN_ID, 'item-A')
    })

    it('never cleans a ticket the user skipped: its branch may hold work that never landed', async () => {
      const world = createWorld({
        items: [
          readyItem('A', { status: 'skipped', status_detail: 'Skipped by you.' }),
          { key: 'B', status: 'running', session_id: 's-B', started_at: PROMPTED_AT }
        ]
      })
      world.putDocument()
      world.setSignal('s-B', { kind: 'working' })
      start(world)

      await advance(60_000)

      expect(world.api.cleanItemWorktree).not.toHaveBeenCalled()
    })

    it('cleans the tickets that were finished with before this runner started, once', async () => {
      const world = createWorld({
        items: [
          finishedItem('A'),
          finishedItem('B', { worktree_cleaned_at: PROMPTED_AT }),
          { key: 'C', status: 'running', session_id: 's-C', started_at: PROMPTED_AT }
        ]
      })
      moveTicket(world, 'ticket-A', 'merged')
      moveTicket(world, 'ticket-B', 'merged')
      world.setSignal('s-C', { kind: 'working' })
      start(world)

      await advance(30_000)

      // B was cleaned by an earlier runner: never again.
      expect(world.api.cleanItemWorktree).toHaveBeenCalledTimes(1)
      expect(world.api.cleanItemWorktree).toHaveBeenCalledWith(RUN_ID, 'item-A')
    })

    it('leaves a merged ticket the user took back up until it is in Merged again', async () => {
      const world = createWorld({
        items: [
          finishedItem('A'),
          { key: 'B', status: 'running', session_id: 's-B', started_at: PROMPTED_AT }
        ]
      })
      moveTicket(world, 'ticket-A', 'in_progress')
      world.setSignal('s-B', { kind: 'working' })
      start(world)

      await advance(30_000)
      expect(world.api.cleanItemWorktree).not.toHaveBeenCalled()

      moveTicket(world, 'ticket-A', 'merged')
      await advance(30_000)
      expect(world.api.cleanItemWorktree).toHaveBeenCalledTimes(1)
      expect(world.api.cleanItemWorktree).toHaveBeenCalledWith(RUN_ID, 'item-A')
    })

    it('cleans the tickets whose updates the end of the run skipped', async () => {
      const world = createWorld({ items: [readyItem('A'), readyItem('B')] })
      world.putDocument()
      start(world)
      await advance(1000)
      expect(world.documentUpdates()).toEqual({ A: 'updating', B: 'queued' })
      expect(world.api.cleanItemWorktree).not.toHaveBeenCalled()

      // The server's cancel: the run ends, and every update still in the lane is skipped.
      const finishedAt = new Date(Date.now()).toISOString()
      for (const key of ['A', 'B']) {
        world.setItem(key, {
          document_update_status: 'skipped',
          document_update_detail: 'The run was cancelled before this task updated the document.',
          document_update_finished_at: finishedAt
        })
      }
      world.setRun({ status: 'cancelled' })
      await advance(1000)

      expect(world.api.cleanItemWorktree.mock.calls.map(([, itemId]) => itemId).sort()).toEqual([
        'item-A',
        'item-B'
      ])
      await advance(30_000)
      expect(world.api.cleanItemWorktree).toHaveBeenCalledTimes(2)
    })
  })

  describe('a run made from board tickets', () => {
    it('cleans as soon as the ticket is merged: there is no document to update', async () => {
      const world = createWorld({
        tickets: true,
        items: [readyItem('A'), { key: 'B', depends_on: ['A'] }]
      })
      start(world)

      await advance(1000)

      expect(world.item('A')).toMatchObject({ status: 'merged', document_update_status: null })
      expect(world.tickets.get('ticket-A')?.column).toBe('merged')
      expect(world.api.cleanItemWorktree).toHaveBeenCalledTimes(1)
      expect(world.api.cleanItemWorktree).toHaveBeenCalledWith(RUN_ID, 'item-A')
    })

    it('cleans a ticket closed as already implemented', async () => {
      const world = createWorld({
        tickets: true,
        items: [readyItem('A', { verdict: makeVerdict() }), { key: 'B', depends_on: ['A'] }],
        config: { interactive: false }
      })
      world.api.prepareMerge.mockResolvedValue(noChanges)
      start(world)

      await advance(1000)

      expect(world.item('A')).toMatchObject({
        status: 'skipped',
        status_detail: ALREADY_IMPLEMENTED_DETAIL
      })
      expect(world.api.cleanItemWorktree).toHaveBeenCalledWith(RUN_ID, 'item-A')
    })

    it('never cleans a ticket the user skipped', async () => {
      const world = createWorld({
        tickets: true,
        items: [
          readyItem('A', { status: 'skipped', status_detail: 'Skipped by you.' }),
          { key: 'B', status: 'running', session_id: 's-B', started_at: PROMPTED_AT }
        ]
      })
      world.setSignal('s-B', { kind: 'working' })
      start(world)

      await advance(60_000)

      expect(world.api.cleanItemWorktree).not.toHaveBeenCalled()
    })
  })

  describe('the setting', () => {
    it('cleans nothing while it is off, and catches up once it is turned on', async () => {
      const world = createWorld({
        tickets: true,
        items: [
          readyItem('A'),
          { key: 'B', status: 'running', session_id: 's-B', started_at: PROMPTED_AT }
        ]
      })
      world.ports.cleansFinishedWorktrees.mockReturnValue(false)
      world.setSignal('s-B', { kind: 'working' })
      start(world)

      await advance(60_000)
      expect(world.item('A').status).toBe('merged')
      expect(world.api.cleanItemWorktree).not.toHaveBeenCalled()

      world.ports.cleansFinishedWorktrees.mockReturnValue(true)
      await advance(30_000)
      expect(world.api.cleanItemWorktree).toHaveBeenCalledTimes(1)
      expect(world.api.cleanItemWorktree).toHaveBeenCalledWith(RUN_ID, 'item-A')
    })
  })

  describe('a run found with many tickets to clean', () => {
    // What an update that brings the cleaning meets: a run long under way, most of it merged.
    const KEYS = ['A', 'B', 'C', 'D']
    const backlog = (): RunnerWorld => {
      const world = createWorld({
        items: [
          ...KEYS.map((key) => finishedItem(key)),
          { key: 'Z', status: 'running', session_id: 's-Z', started_at: PROMPTED_AT }
        ]
      })
      for (const key of KEYS) moveTicket(world, `ticket-${key}`, 'merged')
      world.setSignal('s-Z', { kind: 'working' })
      return world
    }
    /** Cleans that stay under way on the server until answered, one at a time, oldest first. */
    const holdCleans = (world: RunnerWorld) => {
      const answers: (() => void)[] = []
      world.api.cleanItemWorktree.mockImplementation(async (runId, itemId) => {
        await new Promise<void>((answer) => answers.push(answer))
        const key = world.detail(runId).items.find((item) => item.id === itemId)!.key
        world.setItem(key, { worktree_cleaned_at: new Date(Date.now()).toISOString() }, runId)
        return { state: 'cleaned' }
      })
      return async (): Promise<void> => {
        answers.shift()?.()
        await advance(1000)
      }
    }
    const asked = (world: RunnerWorld): string[] =>
      world.api.cleanItemWorktree.mock.calls.map(([, itemId]) => itemId)

    it('asks for one clean at a time, the next once the server has answered', async () => {
      const world = backlog()
      const answer = holdCleans(world)
      start(world)

      await advance(60_000)
      expect(asked(world)).toEqual(['item-A'])

      await answer()
      expect(asked(world)).toEqual(['item-A', 'item-B'])
      await advance(60_000)
      expect(asked(world)).toEqual(['item-A', 'item-B'])

      await answer()
      await answer()
      await answer()
      expect(asked(world)).toEqual(['item-A', 'item-B', 'item-C', 'item-D'])
      await advance(60_000)
      expect(world.api.cleanItemWorktree).toHaveBeenCalledTimes(4)
    })

    it('leaves a waiting ticket the user took back up meanwhile, until it is in Merged again', async () => {
      const world = backlog()
      const answer = holdCleans(world)
      start(world)
      await advance(1000)
      moveTicket(world, 'ticket-B', 'in_progress')

      await answer()
      await answer()
      await answer()

      expect(asked(world)).toEqual(['item-A', 'item-C', 'item-D'])
      expect(world.item('B').worktree_cleaned_at).toBeNull()

      moveTicket(world, 'ticket-B', 'merged')
      await advance(30_000)
      expect(asked(world)).toEqual(['item-A', 'item-C', 'item-D', 'item-B'])
    })

    it('stops at the clean under way when the setting is turned off', async () => {
      const world = backlog()
      const answer = holdCleans(world)
      start(world)
      await advance(1000)
      world.ports.cleansFinishedWorktrees.mockReturnValue(false)

      await answer()
      await advance(60_000)
      expect(asked(world)).toEqual(['item-A'])

      world.ports.cleansFinishedWorktrees.mockReturnValue(true)
      await advance(30_000)
      expect(asked(world)).toEqual(['item-A', 'item-B'])
    })

    it('goes on to the next ticket when a clean fails', async () => {
      const world = backlog()
      world.api.cleanItemWorktree.mockRejectedValueOnce(new Error('The run is not finished with A'))
      start(world)

      await advance(30_000)

      expect(asked(world)).toEqual(['item-A', 'item-B', 'item-C', 'item-D'])
    })
  })

  describe('when the clean does not go through', () => {
    const stillRunning = (world: RunnerWorld): void => {
      world.setSignal('s-B', { kind: 'working' })
    }
    const items = [
      readyItem('A'),
      { key: 'B', status: 'running' as const, session_id: 's-B', started_at: PROMPTED_AT }
    ]

    it('asks again when the server could not be reached', async () => {
      const world = createWorld({ tickets: true, items })
      stillRunning(world)
      world.api.cleanItemWorktree.mockRejectedValueOnce(new FakeTransportError('socket closed'))
      start(world)

      await advance(30_000)

      expect(world.api.cleanItemWorktree).toHaveBeenCalledTimes(2)
      expect(world.item('A').worktree_cleaned_at).toEqual(expect.any(String))
    })

    it('does not ask again for a clean the server refused', async () => {
      const world = createWorld({ tickets: true, items })
      stillRunning(world)
      world.api.cleanItemWorktree.mockRejectedValue(new Error('The run is not finished with A'))
      start(world)

      await advance(60_000)

      expect(world.api.cleanItemWorktree).toHaveBeenCalledTimes(1)
      expect(world.ports.warn).toHaveBeenCalledWith(
        'could not clean the worktree of A',
        expect.any(Error)
      )
    })

    it('does not ask again for a clean git failed at: the server recorded it as done', async () => {
      const world = createWorld({ tickets: true, items })
      stillRunning(world)
      world.api.cleanItemWorktree.mockResolvedValue({ state: 'failed', error: 'permission denied' })
      start(world)

      await advance(60_000)

      expect(world.api.cleanItemWorktree).toHaveBeenCalledTimes(1)
      expect(world.ports.warn).toHaveBeenCalledWith(
        'could not clean the worktree of A: permission denied'
      )
    })
  })
})
