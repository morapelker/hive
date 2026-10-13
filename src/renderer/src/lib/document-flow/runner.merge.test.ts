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

const cleanCheck: DocumentMergeCheckResult = {
  state: 'clean',
  conflictedFiles: [],
  committed: false,
  commitsAhead: 1
}

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

  describe('nothing to merge, in a run whose agents may not ask', () => {
    const noChanges: DocumentMergeCheckResult = {
      state: 'no_changes',
      conflictedFiles: [],
      committed: false,
      commitsAhead: 0
    }

    it('closes a ticket its agent found already done, and launches what depends on it', async () => {
      const world = createWorld({
        config: { interactive: false },
        items: [readyItem('A', { verdict: makeVerdict() }), { key: 'B', depends_on: ['A'] }]
      })
      world.api.prepareMerge.mockResolvedValue(noChanges)
      start(world)

      await advance(2000)

      expect(world.item('A')).toMatchObject({
        status: 'skipped',
        status_detail:
          'Nothing to merge: the agent reported the task done without changing anything.',
        finished_at: expect.any(String)
      })
      expect(world.api.merge).not.toHaveBeenCalled()
      expect(world.notices).toEqual([])
      expect(world.launches.map((spec) => spec.ticketId)).toEqual(['ticket-B'])
    })

    it('still flags a ticket whose agent never reported done', async () => {
      const reason = 'The agent could not reach the package registry.'
      const world = createWorld({
        config: { interactive: false },
        items: [readyItem('A', { verdict: makeVerdict({ status: 'blocked', reason }) })]
      })
      world.api.prepareMerge.mockResolvedValue(noChanges)
      start(world)

      await advance(1000)

      expect(world.item('A')).toMatchObject({
        status: 'needs_attention',
        status_detail: `Its branch has nothing to merge. ${reason}`
      })
    })

    it('still flags a ticket that was never judged', async () => {
      const world = createWorld({ config: { interactive: false }, items: [readyItem('A')] })
      world.api.prepareMerge.mockResolvedValue(noChanges)
      start(world)

      await advance(1000)

      expect(world.item('A')).toMatchObject({
        status: 'needs_attention',
        status_detail: 'The agent reported done, but its branch has no commits to merge.'
      })
    })
  })

  it('notes on a merged ticket that its agent did not report done', async () => {
    const reason = 'The export dialog is listed as still to do.'
    const world = createWorld({
      items: [
        readyItem('A', {
          status_detail: 'Marked done by you.',
          verdict: makeVerdict({ status: 'partial', reason })
        }),
        readyItem('B', { verdict: makeVerdict() })
      ]
    })
    start(world)

    await advance(3000)

    expect(world.item('A')).toMatchObject({
      status: 'merged',
      status_detail: `Merged as it stood. The agent ended on: ${reason}`
    })
    expect(world.item('B')).toMatchObject({ status: 'merged', status_detail: null })
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

    it('merges the tickets that merge clean before resolving one that conflicts', async () => {
      const world = createWorld({ items: [readyItem('A'), readyItem('B'), readyItem('C')] })
      // A conflicts until the others have landed; B and C merge clean.
      let landed = 0
      world.api.prepareMerge.mockImplementation(async (_runId, itemId) =>
        itemId === 'item-A' && landed < 2
          ? { ...conflict('src/cart.ts'), integrationHead: `tip-${landed}` }
          : cleanCheck
      )
      world.api.merge.mockImplementation(async (_runId, itemId) => {
        landed += 1
        return { success: true, mergeSha: `merge-${itemId}` }
      })
      start(world)

      await advance(5000)

      // No resolution was asked for while a clean branch could land: A's session was prompted
      // once, against the tip both merges left, and merges clean on its own after that.
      expect(world.api.merge.mock.calls.map(([, itemId]) => itemId)).toEqual([
        'item-B',
        'item-C',
        'item-A'
      ])
      expect(world.followups).toHaveLength(0)
      expect(world.statuses()).toEqual({ A: 'merged', B: 'merged', C: 'merged' })
      expect(world.events.filter((event) => event.type === 'merged_first')).toEqual([
        {
          itemId: 'item-B',
          type: 'merged_first',
          message: `Merging B before A, which conflicts with ${INTEGRATION_BRANCH}`
        },
        {
          itemId: 'item-C',
          type: 'merged_first',
          message: `Merging C before A, which conflicts with ${INTEGRATION_BRANCH}`
        }
      ])
    })

    it('asks for a resolution only once every ready ticket conflicts, against the final tip', async () => {
      const world = createWorld({ items: [readyItem('A'), readyItem('B')] })
      world.api.prepareMerge.mockImplementation(async (_runId, itemId) =>
        itemId === 'item-A'
          ? { ...conflict('src/cart.ts'), integrationHead: world.item('B').merge_sha ?? 'tip-0' }
          : cleanCheck
      )
      start(world)

      await advance(2000)

      expect(world.statuses()).toEqual({ A: 'resolving_conflicts', B: 'merged' })
      expect(world.followups).toHaveLength(1)
      expect(world.followups[0].prompt).toContain('git merge merge-B')
      expect(world.followups[0].prompt).toContain('Merged into it so far: B (Task B)')
    })

    it('holds the lane while a ticket resolves its conflicts, until it is merged', async () => {
      const world = createWorld({ items: [readyItem('A'), readyItem('B')] })
      // Both conflict at first; a resolved branch merges clean.
      const resolved = new Set<string>()
      world.api.prepareMerge.mockImplementation(async (_runId, itemId) =>
        resolved.has(itemId) ? cleanCheck : conflict('src/cart.ts')
      )
      const judged = deferred<ReturnType<typeof makeVerdict>>()
      world.api.classify.mockReturnValueOnce(judged.promise)
      start(world)

      await advance(1000)

      // A, first in document order, resolves; B is not dry-run again, let alone prompted.
      expect(world.statuses()).toEqual({ A: 'resolving_conflicts', B: 'ready' })
      expect(world.followups.map((followup) => followup.sessionId)).toEqual(['s-A'])
      expect(world.api.prepareMerge).toHaveBeenCalledTimes(2)
      expect(world.item('B').status_detail).toBe(`Waiting to merge: A is resolving conflicts`)

      resolved.add('item-A')
      world.endTurn('s-A')
      await advance(SETTLE_MS + 1000)

      // The lane stays held while the resolution is judged.
      expect(world.statuses()).toEqual({ A: 'checking', B: 'ready' })
      expect(world.api.prepareMerge).toHaveBeenCalledTimes(2)

      judged.resolve(makeVerdict())
      await advance(1000)

      // A lands first; only then is B looked at again, and it conflicts in its turn.
      expect(world.api.merge.mock.calls.map(([, itemId]) => itemId)).toEqual(['item-A'])
      expect(world.statuses()).toEqual({ A: 'merged', B: 'resolving_conflicts' })
      expect(world.followups.map((followup) => followup.sessionId)).toEqual(['s-A', 's-B'])
      expect(world.followups[1].prompt).toContain('Merged into it so far: A (Task A)')

      resolved.add('item-B')
      world.endTurn('s-B')
      await advance(SETTLE_MS + 1000)

      expect(world.statuses()).toEqual({ A: 'merged', B: 'merged' })
      expect(world.followups).toHaveLength(2)
    })

    it('keeps the lane while the resolving session waits on the user', async () => {
      const world = createWorld({
        items: [
          readyItem('A', {
            status: 'resolving_conflicts',
            status_detail: 'Resolving conflicts in 2 file(s)',
            conflict_attempts: 1,
            conflict_head: 'verified-tip'
          }),
          readyItem('B')
        ]
      })
      world.setSignal('s-A', { kind: 'blocked', reason: 'question', detail: 'Keep both prices?' })
      start(world)

      await advance(30_000)

      expect(world.statuses()).toEqual({ A: 'resolving_conflicts', B: 'ready' })
      expect(world.api.prepareMerge).not.toHaveBeenCalled()
      expect(world.item('B').status_detail).toBe(
        'Waiting to merge: A is resolving conflicts and waiting for you'
      )

      world.setSignal('s-A', { kind: 'working' })
      await advance(1000)

      expect(world.item('B').status_detail).toBe('Waiting to merge: A is resolving conflicts')
    })

    it('lets the others merge once the resolving ticket is flagged', async () => {
      const world = createWorld({
        items: [
          readyItem('A', {
            status: 'needs_attention',
            status_detail: 'Still conflicts after 2 attempts',
            conflict_attempts: 2
          }),
          readyItem('B', { status_detail: 'Waiting to merge: A is resolving conflicts' })
        ]
      })
      start(world)

      await advance(1000)

      expect(world.statuses()).toEqual({ A: 'needs_attention', B: 'merged' })
      expect(world.item('B').status_detail).toBeNull()
    })

    it('says what a ready ticket waits for while another lands, and leaves other details be', async () => {
      const world = createWorld({
        items: [
          readyItem('A'),
          readyItem('B'),
          readyItem('C', { status_detail: 'Marked done by you.' })
        ]
      })
      const first = deferred<DocumentMergeResult>()
      world.api.merge.mockReturnValueOnce(first.promise)
      start(world)

      await advance(1000)

      expect(world.statuses()).toEqual({ A: 'merging', B: 'ready', C: 'ready' })
      expect(world.item('B').status_detail).toBe('Waiting to merge: A is merging')
      expect(world.item('C').status_detail).toBe('Marked done by you.')

      first.resolve({ success: true, mergeSha: 'merge-A' })
      await advance(2000)

      expect(world.statuses()).toEqual({ A: 'merged', B: 'merged', C: 'merged' })
      expect(world.item('B').status_detail).toBeNull()
    })

    it('takes over a run the earlier orchestrator left with several tickets resolving at once', async () => {
      // Before the lane existed, every conflicting ticket was prompted at the same time. After
      // a restart the first of them holds the lane; the others finish their turn and wait.
      const legacy = (key: string): Partial<DocumentRunItem> =>
        readyItem(key, {
          status: 'resolving_conflicts',
          status_detail: 'Resolving conflicts in 1 file(s)',
          conflict_attempts: 1,
          conflict_head: 'old-tip'
        })
      const world = createWorld({ items: [legacy('A'), legacy('B'), readyItem('C')] })
      start(world)

      await advance(1000)

      expect(world.statuses()).toEqual({
        A: 'resolving_conflicts',
        B: 'resolving_conflicts',
        C: 'ready'
      })
      expect(world.api.prepareMerge).not.toHaveBeenCalled()
      expect(world.item('C').status_detail).toBe('Waiting to merge: A is resolving conflicts')

      world.endTurn('s-B')
      await advance(SETTLE_MS + 1000)

      expect(world.statuses()).toEqual({ A: 'resolving_conflicts', B: 'ready', C: 'ready' })
      expect(world.api.prepareMerge).not.toHaveBeenCalled()

      world.endTurn('s-A')
      await advance(SETTLE_MS + 2000)

      expect(world.statuses()).toEqual({ A: 'merged', B: 'merged', C: 'merged' })
      expect(world.api.merge.mock.calls.map(([, itemId]) => itemId)).toEqual([
        'item-A',
        'item-B',
        'item-C'
      ])
      expect(world.followups).toHaveLength(0)
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
        background_work: null,
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
    expect(world.item('A').status).toBe('ready')
    expect(world.api.prepareMerge).toHaveBeenCalledTimes(1)

    world.setRun({ status: 'paused' })
    check.resolve(cleanCheck)
    await advance(30_000)

    // The dry run's result is not acted on; the item is still ready for a fresh one on resume.
    expect(world.api.merge).not.toHaveBeenCalled()
    expect(world.item('A').status).toBe('ready')

    world.setRun({ status: 'running' })
    await advance(1000)

    expect(world.api.prepareMerge).toHaveBeenCalledTimes(2)
    expect(world.item('A').status).toBe('merged')
  })

  it('leaves a ready item alone while the server is unreachable for its dry run', async () => {
    const world = createWorld({ items: [readyItem('A')] })
    world.api.prepareMerge.mockRejectedValueOnce(new FakeTransportError('socket closed'))
    start(world)

    await advance(5000)
    expect(world.item('A').status).toBe('ready')
    expect(world.notices).toEqual([])

    await advance(10_000)
    expect(world.item('A').status).toBe('merged')
  })
})
