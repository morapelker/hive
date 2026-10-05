import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildConflictPrompt } from '@shared/document-flow/prompts'
import type {
  DocumentMergeCheckResult,
  DocumentMergeResult,
  DocumentRunItem,
  SessionFinalMessage
} from '@shared/types/document-flow'
import { DocumentFlowRunner, SETTLE_MS } from './runner'
import {
  FakeTransportError,
  INTEGRATION_BRANCH,
  PROJECT_ID,
  RUN_ID,
  TEST_NOW,
  advance,
  createWorld,
  makeVerdict,
  type RunnerWorld
} from './runner-fakes'

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

const conflict = (...files: string[]): DocumentMergeCheckResult => ({
  state: 'conflict',
  conflictedFiles: files,
  integrationHead: 'verified-tip',
  committed: false,
  commitsAhead: 2
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('DocumentFlowRunner: merging', () => {
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

  it('merges a clean ticket and moves its board ticket to merged without completion effects', async () => {
    const world = createWorld({ items: [readyItem('A')] })
    start(world)

    await advance(1000)

    expect(world.api.prepareMerge).toHaveBeenCalledWith('run-1', 'item-A')
    expect(world.api.merge).toHaveBeenCalledWith('run-1', 'item-A')
    expect(world.api.verify).not.toHaveBeenCalled()
    expect(world.item('A')).toMatchObject({
      status: 'merged',
      status_detail: null,
      finished_at: '2026-05-04T10:00:00.100Z'
    })
    expect(world.ports.moveTicket).toHaveBeenCalledWith(PROJECT_ID, 'ticket-A', 'merged', {
      skipCompletionEffects: true
    })
    expect(world.tickets.get('ticket-A')?.column).toBe('merged')
    expect(world.events.map((event) => event.type)).toContain('merged')
  })

  it('keeps the ticket merged when only the board move fails', async () => {
    const world = createWorld({ items: [readyItem('A')] })
    world.ports.moveTicket.mockRejectedValueOnce(new Error('board is read-only'))
    start(world)

    await advance(1000)

    expect(world.item('A').status).toBe('merged')
  })

  it('flags a branch with nothing to merge', async () => {
    const world = createWorld({ items: [readyItem('A')] })
    world.api.prepareMerge.mockResolvedValue({
      state: 'no_changes',
      conflictedFiles: [],
      committed: false,
      commitsAhead: 0
    })
    start(world)

    await advance(1000)

    expect(world.item('A')).toMatchObject({
      status: 'needs_attention',
      status_detail: 'The agent reported done, but its branch has no commits to merge.'
    })
    expect(world.api.merge).not.toHaveBeenCalled()
  })

  it('carries on when the branch turns out to be merged already', async () => {
    const world = createWorld({ items: [readyItem('A')] })
    world.api.prepareMerge.mockResolvedValue({
      state: 'no_changes',
      conflictedFiles: [],
      committed: false,
      commitsAhead: 0,
      alreadyMerged: true
    })
    start(world)

    await advance(1000)

    expect(world.api.merge).toHaveBeenCalledTimes(1)
    expect(world.item('A').status).toBe('merged')
  })

  it('flags a merge that cannot be prepared, with the server’s reason', async () => {
    const world = createWorld({ items: [readyItem('A')] })
    world.api.prepareMerge.mockResolvedValue({
      state: 'error',
      conflictedFiles: [],
      committed: false,
      commitsAhead: 0,
      error: 'The ticket worktree no longer exists.'
    })
    start(world)

    await advance(1000)

    expect(world.item('A')).toMatchObject({
      status: 'needs_attention',
      status_detail: 'The ticket worktree no longer exists.'
    })
  })

  it('flags a merge that fails for another reason than conflicts', async () => {
    const world = createWorld({ items: [readyItem('A')] })
    world.api.merge.mockResolvedValue({ success: false, error: 'index.lock exists' })
    start(world)

    await advance(1000)

    expect(world.item('A')).toMatchObject({
      status: 'needs_attention',
      status_detail: 'index.lock exists'
    })
  })

  describe('conflicts', () => {
    it('asks the ticket’s own session to resolve them, then merges after its turn', async () => {
      const world = createWorld({
        items: [readyItem('A'), { key: 'B', status: 'merged' }]
      })
      world.api.prepareMerge.mockResolvedValueOnce(conflict('src/cart.ts', 'pnpm-lock.yaml'))
      start(world)

      await advance(1000)

      expect(world.followups).toEqual([
        {
          sessionId: 's-A',
          ticketId: 'ticket-A',
          prompt: buildConflictPrompt({
            integrationBranch: INTEGRATION_BRANCH,
            integrationCommit: 'verified-tip',
            conflictedFiles: ['src/cart.ts', 'pnpm-lock.yaml'],
            mergedTickets: [{ key: 'B', title: 'Task B' }],
            attempt: 1
          })
        }
      ])
      expect(world.item('A')).toMatchObject({
        status: 'resolving_conflicts',
        status_detail: 'Resolving conflicts in 2 file(s)',
        conflict_attempts: 1,
        last_prompt_at: '2026-05-04T10:00:00.100Z'
      })
      expect(world.api.merge).not.toHaveBeenCalled()

      world.endTurn('s-A')
      await advance(SETTLE_MS + 1000)

      // The resolution's final message is judged like any turn end, then the dry run decides.
      expect(world.api.classify).toHaveBeenCalledTimes(1)
      expect(world.api.classify).toHaveBeenCalledWith({ runId: RUN_ID, itemId: world.item('A').id })
      expect(world.api.prepareMerge).toHaveBeenCalledTimes(2)
      expect(world.item('A').status).toBe('merged')
    })

    it('waits for the user when the resolution ends on a question instead of merging', async () => {
      const world = createWorld({
        items: [readyItem('A'), { key: 'B', status: 'merged' }]
      })
      world.api.prepareMerge.mockResolvedValueOnce(conflict('src/cart.ts'))
      start(world)
      await advance(1000)
      world.api.classify.mockResolvedValueOnce(
        makeVerdict({
          status: 'needs_input',
          reason: 'Both sides rename the same field.',
          question: 'Keep `total` or `sum`?'
        })
      )

      world.endTurn('s-A')
      await advance(SETTLE_MS + 1000)

      expect(world.item('A')).toMatchObject({
        status: 'needs_input',
        status_detail: 'Keep `total` or `sum`?'
      })
      expect(world.api.prepareMerge).toHaveBeenCalledTimes(1)
      expect(world.api.merge).not.toHaveBeenCalled()
    })

    it('names only the tickets merged after the branch was cut, and the commit to merge', async () => {
      const world = createWorld({
        items: [
          { key: 'A1', status: 'merged', finished_at: '2026-05-04T09:30:00.000Z' },
          { key: 'A2', status: 'merged', finished_at: null },
          readyItem('B1', { started_at: '2026-05-04T09:40:00.000Z' }),
          { key: 'B2', status: 'merged', finished_at: '2026-05-04T09:50:00.000Z' }
        ]
      })
      world.api.prepareMerge.mockResolvedValueOnce(conflict('src/cart.ts'))
      start(world)

      await advance(1000)

      // A2 has no merge time on record, so it is listed rather than left out.
      const prompt = world.followups[0].prompt
      expect(prompt).toContain('Merged into it so far: A2 (Task A2), B2 (Task B2).')
      expect(prompt).not.toContain('A1 (Task A1)')
      expect(prompt).toContain('git merge verified-tip')
    })

    it('passes the commit the dry run was made against when the merge itself conflicts', async () => {
      const world = createWorld({ items: [readyItem('A')] })
      world.api.prepareMerge.mockResolvedValueOnce({
        state: 'clean',
        conflictedFiles: [],
        integrationHead: 'verified-tip',
        committed: false,
        commitsAhead: 1
      })
      world.api.merge.mockResolvedValueOnce({ success: false, conflictedFiles: ['src/cart.ts'] })
      start(world)

      await advance(1000)

      expect(world.followups[0].prompt).toContain('git merge verified-tip')
    })

    it('gives up when the branch still conflicts after two resolutions', async () => {
      const world = createWorld({ items: [readyItem('A')] })
      world.api.prepareMerge.mockResolvedValue(conflict('src/cart.ts'))
      start(world)

      for (let attempt = 1; attempt <= 2; attempt++) {
        await advance(1000)
        expect(world.followups).toHaveLength(attempt)
        expect(world.item('A')).toMatchObject({
          status: 'resolving_conflicts',
          conflict_attempts: attempt
        })
        world.endTurn('s-A')
        await advance(SETTLE_MS + 200)
      }

      await advance(1000)
      expect(world.followups).toHaveLength(2)
      expect(world.followups[1].prompt).toContain('This is attempt 2')
      expect(world.item('A')).toMatchObject({
        status: 'needs_attention',
        status_detail: `Still conflicts with ${INTEGRATION_BRANCH} after 2 attempts: src/cart.ts`
      })
    })

    it('does not count a resolution that another merge overtook', async () => {
      const world = createWorld({ items: [readyItem('A')] })
      // Each time A finishes resolving, another ticket has moved the integration branch on.
      for (const tip of ['tip-1', 'tip-2', 'tip-3', 'tip-4']) {
        world.api.prepareMerge.mockResolvedValueOnce({
          ...conflict('lib/calc.test.ts'),
          integrationHead: tip
        })
      }
      start(world)

      for (let lap = 1; lap <= 4; lap++) {
        await advance(1000)
        expect(world.followups).toHaveLength(lap)
        expect(world.followups[lap - 1].prompt).toContain(`git merge tip-${lap}`)
        expect(world.followups[lap - 1].prompt).not.toContain('This is attempt')
        expect(world.item('A')).toMatchObject({
          status: 'resolving_conflicts',
          conflict_attempts: 1,
          conflict_head: `tip-${lap}`
        })
        world.endTurn('s-A')
        await advance(SETTLE_MS + 200)
      }

      await advance(1000)
      expect(world.item('A').status).toBe('merged')
    })

    it('treats conflicts reported by the merge itself like a failed dry run', async () => {
      const world = createWorld({ items: [readyItem('A')] })
      const merge: DocumentMergeResult = { success: false, conflictedFiles: ['src/cart.ts'] }
      world.api.merge.mockResolvedValueOnce(merge)
      start(world)

      await advance(1000)

      expect(world.item('A')).toMatchObject({
        status: 'resolving_conflicts',
        status_detail: 'Resolving conflicts in 1 file(s)'
      })
      expect(world.followups).toHaveLength(1)
    })

    it('flags the item when the conflict prompt cannot be delivered', async () => {
      const world = createWorld({ items: [readyItem('A')] })
      world.api.prepareMerge.mockResolvedValue(conflict('src/cart.ts'))
      world.ports.sendFollowup.mockRejectedValueOnce(new Error('Failed to start CLI session'))
      start(world)

      await advance(1000)

      expect(world.item('A')).toMatchObject({
        status: 'needs_attention',
        status_detail: 'Could not send a message to the session: Failed to start CLI session'
      })
      expect(world.api.rollbackMerge).not.toHaveBeenCalled()
    })

    it('keeps resolving while the session waits on the user, and says so once', async () => {
      const world = createWorld({
        items: [
          readyItem('A', {
            status: 'resolving_conflicts',
            status_detail: 'Resolving conflicts in 2 file(s)',
            conflict_attempts: 1
          })
        ]
      })
      world.setSignal('s-A', { kind: 'blocked', reason: 'question', detail: 'Keep both prices?' })
      start(world)

      await advance(30_000)

      expect(world.item('A')).toMatchObject({
        status: 'resolving_conflicts',
        status_detail: 'Waiting for you: Keep both prices?'
      })
      expect(world.notices).toHaveLength(1)

      world.setSignal('s-A', { kind: 'working' })
      await advance(500)

      expect(world.item('A')).toMatchObject({
        status: 'resolving_conflicts',
        status_detail: 'Resolving conflicts'
      })
    })

    it('resumes a resolving session that the app restart cut off', async () => {
      const world = createWorld({
        items: [
          readyItem('A', {
            status: 'resolving_conflicts',
            conflict_attempts: 1,
            last_prompt_at: '2026-05-04T08:00:00.000Z'
          })
        ]
      })
      start(world)

      await advance(1000)

      expect(world.followups).toHaveLength(1)
      expect(world.item('A')).toMatchObject({
        status: 'resolving_conflicts',
        continue_attempts: 1
      })
    })
  })

  describe('one merge at a time', () => {
    it('never merges two ready tickets concurrently, and merges migrations last', async () => {
      const world = createWorld({
        items: [readyItem('A', { has_migration: true }), readyItem('B')]
      })
      const first = deferred<DocumentMergeResult>()
      world.api.merge.mockReturnValueOnce(first.promise)
      start(world)

      await advance(20_000)

      expect(world.api.merge).toHaveBeenCalledTimes(1)
      expect(world.api.merge).toHaveBeenCalledWith('run-1', 'item-B')
      expect(world.api.prepareMerge).toHaveBeenCalledTimes(1)
      expect(world.statuses()).toEqual({ A: 'ready', B: 'merging' })

      first.resolve({ success: true, mergeSha: 'merge-B' })
      await advance(1000)

      expect(world.statuses()).toEqual({ A: 'merged', B: 'merged' })
      expect(world.api.merge.mock.calls.map(([, itemId]) => itemId)).toEqual(['item-B', 'item-A'])
    })

    it('merges another ticket while one is resolving its conflicts', async () => {
      const world = createWorld({ items: [readyItem('A'), readyItem('B')] })
      world.api.prepareMerge.mockResolvedValueOnce(conflict('src/cart.ts'))
      start(world)

      await advance(1000)

      expect(world.statuses()).toEqual({ A: 'resolving_conflicts', B: 'merged' })
    })

    it('does not start a merge while a ticket is being launched from the integration tip', async () => {
      const world = createWorld({
        config: { maxParallel: 2 },
        items: [readyItem('A'), { key: 'B' }]
      })
      world.ports.launchTicket.mockImplementation(async (spec) => {
        world.launches.push(spec)
        await new Promise((resolve) => setTimeout(resolve, 2000))
        return world.launchOk(spec)
      })
      start(world)

      await advance(1500)
      expect(world.statuses()).toEqual({ A: 'ready', B: 'launching' })
      expect(world.api.prepareMerge).not.toHaveBeenCalled()

      await advance(2000)
      expect(world.statuses()).toEqual({ A: 'merged', B: 'running' })
      expect(world.launches[0].worktree).toMatchObject({ baseRef: INTEGRATION_BRANCH })
    })
  })

  describe('a ready ticket whose session moved on', () => {
    it('follows a session that works again instead of merging a snapshot of it', async () => {
      const world = createWorld({ items: [readyItem('A')] })
      world.setSignal('s-A', { kind: 'working' })
      start(world)

      await advance(1000)

      expect(world.api.prepareMerge).not.toHaveBeenCalled()
      expect(world.item('A')).toMatchObject({ status: 'running', status_detail: null })

      world.endTurn('s-A')
      await advance(SETTLE_MS + 2000)

      expect(world.api.classify).toHaveBeenCalledTimes(1)
      expect(world.item('A').status).toBe('merged')
    })

    it('waits on the user when the session stopped for them', async () => {
      const world = createWorld({ items: [readyItem('A')] })
      world.setSignal('s-A', { kind: 'blocked', reason: 'question', detail: 'Keep both?' })
      start(world)

      await advance(1000)

      expect(world.api.prepareMerge).not.toHaveBeenCalled()
      expect(world.item('A')).toMatchObject({
        status: 'needs_input',
        status_detail: 'Waiting for you: Keep both?'
      })
    })

    it('merges a session the user closed mid-turn and then marked done', async () => {
      const world = createWorld({
        items: [readyItem('A', { status_detail: 'Marked done by you.' })]
      })
      // The last hook before the tab was closed said the agent was working.
      const recorded: SessionFinalMessage = {
        session_id: 's-A',
        state: 'working',
        text: '',
        completion: null,
        api_error: null,
        hook_event: 'Working',
        detail: null,
        updated_at: '2026-05-04T09:59:30.000Z'
      }
      world.turns.set('s-A', recorded)
      world.closedSessions.add('s-A')
      start(world)

      await advance(1000)

      expect(world.api.prepareMerge).toHaveBeenCalledTimes(1)
      const writes = world.ports.updateItem.mock.calls.map(([, , patch]) => patch.status)
      expect(writes.filter(Boolean)).toEqual(['merging', 'merged'])
      expect(world.item('A').status).toBe('merged')
    })
  })

  describe('after a reload', () => {
    it('goes straight to the next step when the merge commit was already recorded', async () => {
      const world = createWorld({
        items: [readyItem('A', { status: 'merging', merge_sha: 'merge-A', pre_merge_sha: 'pre' })]
      })
      start(world)

      await advance(1000)

      expect(world.api.prepareMerge).not.toHaveBeenCalled()
      expect(world.api.merge).not.toHaveBeenCalled()
      expect(world.item('A').status).toBe('merged')
    })

    it('runs the merge again when it had not happened yet', async () => {
      const world = createWorld({ items: [readyItem('A', { status: 'merging' })] })
      start(world)

      await advance(1000)

      expect(world.api.prepareMerge).toHaveBeenCalledTimes(1)
      expect(world.api.merge).toHaveBeenCalledTimes(1)
      expect(world.item('A').status).toBe('merged')
    })

    it('does not trust a merge commit left on a ticket that comes back from ready', async () => {
      const world = createWorld({ items: [readyItem('A', { merge_sha: 'stale-sha' })] })
      start(world)

      await advance(1000)

      expect(world.api.prepareMerge).toHaveBeenCalledTimes(1)
      expect(world.api.merge).toHaveBeenCalledTimes(1)
    })
  })

  it('stops between steps when the run is paused, and picks the merge up on resume', async () => {
    const world = createWorld({ items: [readyItem('A')] })
    const check = deferred<DocumentMergeCheckResult>()
    world.api.prepareMerge.mockReturnValueOnce(check.promise)
    start(world)
    await advance(500)
    expect(world.item('A').status).toBe('merging')

    world.setRun({ status: 'paused' })
    check.resolve({ state: 'clean', conflictedFiles: [], committed: false, commitsAhead: 1 })
    await advance(30_000)

    expect(world.api.merge).not.toHaveBeenCalled()
    expect(world.item('A').status).toBe('merging')

    world.setRun({ status: 'running' })
    await advance(1000)

    expect(world.item('A').status).toBe('merged')
  })

  it('leaves a merging item alone while the server is unreachable', async () => {
    const world = createWorld({ items: [readyItem('A')] })
    world.api.prepareMerge.mockRejectedValueOnce(new FakeTransportError('socket closed'))
    start(world)

    await advance(5000)
    expect(world.item('A').status).toBe('merging')
    expect(world.notices).toEqual([])

    await advance(10_000)
    expect(world.item('A').status).toBe('merged')
  })
})
