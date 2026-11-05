import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildFixTicket } from '@shared/document-flow/prompts'
import type { DocumentRunItem, DocumentVerifyResult } from '@shared/types/document-flow'
import {
  DocumentFlowRunner,
  MAX_CONTINUE,
  MAX_FIX_ATTEMPTS,
  SETTLE_MS,
  isDocumentRunBusy
} from './runner'
import {
  INTEGRATION_BRANCH,
  INTEGRATION_WORKTREE,
  PROJECT_ID,
  TEST_NOW,
  advance,
  createWorld,
  type RunnerWorld,
  type WorldOptions
} from './runner-fakes'

const PROMPTED_AT = '2026-05-04T09:59:00.000Z'
const VERIFY_COMMAND = 'pnpm typecheck && pnpm test'

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

const failed = (output = 'src/cart.ts(12,3): error TS2304'): DocumentVerifyResult => ({
  skipped: false,
  ok: false,
  exitCode: 2,
  timedOut: false,
  output,
  durationMs: 1200
})

const verifyingWorld = (options: WorldOptions = {}): RunnerWorld =>
  createWorld({ ...options, config: { verifyCommand: VERIFY_COMMAND, ...options.config } })

describe('DocumentFlowRunner: verifying a merge', () => {
  let runner: DocumentFlowRunner | null = null

  const start = (world: RunnerWorld): void => {
    runner = new DocumentFlowRunner(world.ports)
    runner.start()
  }

  const statusWrites = (world: RunnerWorld): string[] =>
    world.ports.updateItem.mock.calls.flatMap(([, , patch]) => (patch.status ? [patch.status] : []))

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(TEST_NOW))
  })

  afterEach(() => {
    runner?.stop()
    runner = null
    vi.useRealTimers()
  })

  it('marks the ticket merged when the checks pass', async () => {
    const world = verifyingWorld({ items: [readyItem('A')] })
    start(world)

    await advance(1000)

    expect(world.api.verify).toHaveBeenCalledTimes(1)
    expect(world.api.verify).toHaveBeenCalledWith('run-1')
    expect(statusWrites(world)).toEqual(['merging', 'verifying', 'merged'])
    expect(world.ports.createTicket).not.toHaveBeenCalled()
  })

  it('has a fix session repair failing checks in the integration worktree, then verifies again', async () => {
    const world = verifyingWorld({
      run: { ticket_id: 'run-ticket' },
      items: [readyItem('A', { title: 'Cart totals' })]
    })
    world.api.verify.mockResolvedValueOnce(failed())
    start(world)

    await advance(1000)

    const fixTicket = buildFixTicket({
      documentTitle: 'Checkout redesign',
      key: 'A',
      title: 'Cart totals',
      integrationBranch: INTEGRATION_BRANCH,
      verifyCommand: VERIFY_COMMAND,
      verifyOutput: 'src/cart.ts(12,3): error TS2304',
      attempt: 1
    })
    // A child of the run's board ticket: its key shows the run's.
    expect(world.ports.createTicket).toHaveBeenCalledWith(PROJECT_ID, {
      parent_ticket_id: 'run-ticket',
      ...fixTicket
    })
    expect(world.launches).toHaveLength(1)
    expect(world.launches[0]).toMatchObject({
      ticketId: 'fix-ticket-1',
      ticketTitle: fixTicket.title,
      worktree: { type: 'existing', worktreeId: INTEGRATION_WORKTREE },
      mode: 'build',
      goalMode: false,
      modelConfig: { model: { modelID: 'app-default' } },
      ticketUpdateExtras: { column: 'in_progress', plan_ready: false, pending_launch_config: null }
    })
    expect(world.launches[0].prompt).toBe(
      `<ticket title="${fixTicket.title}">${fixTicket.description}</ticket>`
    )
    expect(world.item('A')).toMatchObject({
      status: 'fixing',
      status_detail: 'Fixing failed checks (attempt 1)',
      fix_ticket_id: 'fix-ticket-1',
      fix_session_id: 'session-2',
      fix_attempts: 1,
      last_prompt_at: '2026-05-04T10:00:00.100Z'
    })
    expect(world.api.rollbackMerge).not.toHaveBeenCalled()

    world.endTurn('session-2')
    await advance(SETTLE_MS + 1000)

    expect(world.api.commitIntegration).toHaveBeenCalledWith('run-1', 'Fix checks after merging A')
    expect(world.ports.moveTicket).toHaveBeenCalledWith(PROJECT_ID, 'fix-ticket-1', 'done', {
      skipCompletionEffects: true
    })
    expect(world.api.verify).toHaveBeenCalledTimes(2)
    expect(world.api.classify).not.toHaveBeenCalled()
    expect(world.item('A')).toMatchObject({ status: 'merged', status_detail: null })
    expect(statusWrites(world)).toEqual(['merging', 'verifying', 'fixing', 'verifying', 'merged'])
  })

  it('rolls the merge back and flags the ticket when the checks still fail after two fixes', async () => {
    const world = verifyingWorld({ items: [readyItem('A')] })
    world.api.verify.mockResolvedValue(failed(`${'x'.repeat(2000)}\nFAIL cart.test.ts`))
    start(world)

    for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
      await advance(1000)
      expect(world.item('A')).toMatchObject({ status: 'fixing', fix_attempts: attempt })
      expect(world.api.rollbackMerge).not.toHaveBeenCalled()
      world.endTurn(world.item('A').fix_session_id as string)
      await advance(SETTLE_MS + 200)
    }
    await advance(1000)

    expect(world.api.verify).toHaveBeenCalledTimes(MAX_FIX_ATTEMPTS + 1)
    expect(world.ports.createTicket).toHaveBeenCalledTimes(MAX_FIX_ATTEMPTS)
    expect(world.launches[1].prompt).toContain('This is attempt 2')
    expect(world.api.rollbackMerge).toHaveBeenCalledTimes(1)
    expect(world.api.rollbackMerge).toHaveBeenCalledWith('run-1', 'item-A')

    const item = world.item('A')
    const detail = item.status_detail as string
    expect(item.status).toBe('needs_attention')
    expect(detail.split('\n')[0]).toBe(
      'Checks still fail after 2 fix attempts; the merge was rolled back.'
    )
    // Only the tail of the output is kept: the end of a log is where the failure is.
    expect(detail.endsWith('FAIL cart.test.ts')).toBe(true)
    expect(detail.length).toBeLessThan(800)
    expect(world.notices.at(-1)).toEqual({
      level: 'warning',
      message:
        'A needs attention: Checks still fail after 2 fix attempts; the merge was rolled back.'
    })
  })

  it('says so when the rollback itself fails', async () => {
    const world = verifyingWorld({ items: [readyItem('A', { fix_attempts: MAX_FIX_ATTEMPTS })] })
    world.api.verify.mockResolvedValue(failed())
    world.api.rollbackMerge.mockResolvedValue({ success: false, error: 'worktree is dirty' })
    start(world)

    await advance(1000)

    expect(world.item('A').status_detail).toContain(
      'Checks still fail after 2 fix attempts; and the merge could not be rolled back (worktree is dirty).'
    )
  })

  it('waits for the integration worktree’s setup script before running the checks', async () => {
    const world = verifyingWorld({ items: [readyItem('A')] })
    world.setupRunning.add(INTEGRATION_WORKTREE)
    start(world)

    await advance(25_000)

    expect(world.api.verify).not.toHaveBeenCalled()
    expect(world.item('A')).toMatchObject({
      status: 'verifying',
      status_detail: 'Waiting for the setup script to finish in the integration worktree.'
    })

    world.setupRunning.delete(INTEGRATION_WORKTREE)
    await advance(11_000)

    expect(world.api.verify).toHaveBeenCalledTimes(1)
    expect(world.item('A')).toMatchObject({ status: 'merged', status_detail: null })
  })

  it('rolls back and flags the ticket when the fix session cannot be started', async () => {
    const world = verifyingWorld({ items: [readyItem('A')] })
    world.api.verify.mockResolvedValue(failed())
    world.ports.launchTicket.mockResolvedValueOnce({
      success: false,
      error: 'Could not create session',
      sessionId: 'orphan-fix'
    })
    start(world)

    await advance(1000)

    expect(world.ports.completeOrphanSession).toHaveBeenCalledWith('orphan-fix')
    expect(world.ports.resetTicketToTodo).toHaveBeenCalledWith(PROJECT_ID, 'fix-ticket-1')
    expect(world.api.rollbackMerge).toHaveBeenCalledWith('run-1', 'item-A')
    expect(world.item('A')).toMatchObject({
      status: 'needs_attention',
      status_detail:
        'Could not start a fix session: Could not create session. The merge was rolled back.'
    })
  })

  it('rolls back when the fix ticket cannot be created', async () => {
    const world = verifyingWorld({ items: [readyItem('A')] })
    world.api.verify.mockResolvedValue(failed())
    world.ports.createTicket.mockRejectedValueOnce(new Error('board is read-only'))
    start(world)

    await advance(1000)

    expect(world.api.rollbackMerge).toHaveBeenCalledTimes(1)
    expect(world.item('A')).toMatchObject({
      status: 'needs_attention',
      status_detail:
        'Could not create the fix ticket: board is read-only. The merge was rolled back.'
    })
    expect(world.ports.launchTicket).not.toHaveBeenCalled()
  })

  it('rolls back when the verify call itself fails on the server', async () => {
    const world = verifyingWorld({ items: [readyItem('A')] })
    world.api.verify.mockRejectedValue(new Error('The integration worktree is missing'))
    start(world)

    await advance(1000)

    expect(world.api.rollbackMerge).toHaveBeenCalledTimes(1)
    expect(world.item('A')).toMatchObject({
      status: 'needs_attention',
      status_detail: 'The integration worktree is missing. The merge was rolled back.'
    })
  })

  it('keeps the integration worktree to the ticket being fixed', async () => {
    const world = verifyingWorld({ items: [readyItem('A'), readyItem('B')] })
    world.api.verify.mockResolvedValueOnce(failed())
    start(world)

    await advance(30_000)

    expect(world.statuses()).toEqual({ A: 'fixing', B: 'ready' })
    expect(world.api.merge).toHaveBeenCalledTimes(1)

    world.endTurn(world.item('A').fix_session_id as string)
    await advance(SETTLE_MS + 2000)

    expect(world.statuses()).toEqual({ A: 'merged', B: 'merged' })
  })

  it('keeps fixing while the fix session waits on the user', async () => {
    const world = verifyingWorld({
      items: [
        readyItem('A', {
          status: 'fixing',
          status_detail: 'Fixing failed checks (attempt 1)',
          fix_ticket_id: 'fix-ticket-9',
          fix_session_id: 's-fix',
          fix_attempts: 1,
          merge_sha: 'merge-A'
        })
      ]
    })
    world.setSignal('s-fix', { kind: 'blocked', reason: 'permission', detail: null })
    start(world)

    await advance(30_000)

    expect(world.item('A')).toMatchObject({
      status: 'fixing',
      status_detail: 'Waiting for you: a permission request'
    })
    expect(world.notices).toHaveLength(1)

    world.setSignal('s-fix', { kind: 'working' })
    await advance(500)

    expect(world.item('A').status_detail).toBe('Fixing failed checks (attempt 1)')
  })

  it('waits on the user after they interrupted the fix session, without offering a Retry', async () => {
    const world = verifyingWorld({
      items: [
        readyItem('A', {
          status: 'fixing',
          status_detail: 'Fixing failed checks (attempt 1)',
          fix_ticket_id: 'fix-ticket-9',
          fix_session_id: 's-fix',
          fix_attempts: 1,
          merge_sha: 'merge-A'
        })
      ]
    })
    start(world)

    world.endTurn('s-fix', { completion: 'none', reason: 'user_interrupt' })
    await advance(SETTLE_MS + 500)

    expect(world.item('A')).toMatchObject({
      status: 'fixing',
      status_detail:
        'Waiting for you: you interrupted the fix session. Send it a message to continue.'
    })
    expect(world.followups).toEqual([])
    expect(isDocumentRunBusy(world.detail())).toBe(false)

    world.setSignal('s-fix', { kind: 'working' })
    await advance(500)
    expect(world.item('A').status_detail).toBe('Fixing failed checks (attempt 1)')
  })

  it('prompts the fix session, not the ticket session, when the fix turn fails', async () => {
    const world = verifyingWorld({
      items: [
        readyItem('A', {
          status: 'fixing',
          fix_ticket_id: 'fix-ticket-9',
          fix_session_id: 's-fix',
          fix_attempts: 1,
          merge_sha: 'merge-A'
        })
      ]
    })
    start(world)

    world.endTurn('s-fix', { completion: 'none', reason: 'pty_exit' })
    await advance(SETTLE_MS + 500)

    expect(world.followups).toHaveLength(1)
    expect(world.followups[0]).toMatchObject({ sessionId: 's-fix', ticketId: 'fix-ticket-9' })
  })

  it('rolls the merge back when it gives up on a fix session', async () => {
    const world = verifyingWorld({
      items: [
        readyItem('A', {
          status: 'fixing',
          fix_ticket_id: 'fix-ticket-9',
          fix_session_id: 's-fix',
          fix_attempts: 1,
          merge_sha: 'merge-A',
          continue_attempts: MAX_CONTINUE
        })
      ]
    })
    start(world)

    world.endTurn('s-fix', { completion: 'none', apiError: 'overloaded' })
    await advance(SETTLE_MS + 500)

    expect(world.api.rollbackMerge).toHaveBeenCalledWith('run-1', 'item-A')
    expect(world.item('A')).toMatchObject({
      status: 'needs_attention',
      status_detail:
        'The session keeps failing with an API error (overloaded). The merge was rolled back.'
    })
  })

  describe('after a reload', () => {
    it('runs the checks again for an item left verifying', async () => {
      const world = verifyingWorld({
        items: [readyItem('A', { status: 'verifying', merge_sha: 'merge-A' })]
      })
      start(world)

      await advance(1000)

      expect(world.api.prepareMerge).not.toHaveBeenCalled()
      expect(world.api.merge).not.toHaveBeenCalled()
      expect(world.api.verify).toHaveBeenCalledTimes(1)
      expect(world.item('A').status).toBe('merged')
    })

    it('adopts a fix session that had started before its id was recorded', async () => {
      const world = verifyingWorld({
        items: [
          readyItem('A', {
            status: 'fixing',
            fix_ticket_id: 'fix-ticket-9',
            fix_session_id: null,
            fix_attempts: 1,
            merge_sha: 'merge-A'
          })
        ]
      })
      world.tickets.set('fix-ticket-9', {
        id: 'fix-ticket-9',
        project_id: PROJECT_ID,
        title: 'Fix checks after merging A',
        description: '',
        attachments: [],
        column: 'in_progress',
        current_session_id: 's-fix',
        worktree_id: INTEGRATION_WORKTREE,
        archived_at: null
      })
      start(world)

      await advance(1000)

      expect(world.item('A')).toMatchObject({ status: 'fixing', fix_session_id: 's-fix' })
      expect(world.ports.launchTicket).not.toHaveBeenCalled()
    })

    it('verifies again when a reload cut the fix launch off before its session was started', async () => {
      const world = verifyingWorld({
        items: [
          readyItem('A', {
            status: 'fixing',
            fix_ticket_id: 'fix-ticket-9',
            fix_session_id: null,
            fix_attempts: 1,
            merge_sha: 'merge-A'
          })
        ]
      })
      world.tickets.set('fix-ticket-9', {
        id: 'fix-ticket-9',
        project_id: PROJECT_ID,
        title: 'Fix checks after merging A',
        description: '',
        attachments: [],
        column: 'in_progress',
        current_session_id: 's-fix-never-prompted',
        worktree_id: INTEGRATION_WORKTREE,
        archived_at: null
      })
      world.unstartedSessions.add('s-fix-never-prompted')
      start(world)

      await advance(1000)

      expect(world.ports.completeOrphanSession).toHaveBeenCalledWith('s-fix-never-prompted')
      expect(world.ports.resetTicketToTodo).toHaveBeenCalledWith(PROJECT_ID, 'fix-ticket-9')
      expect(world.events.map((event) => event.type)).toContain('launch_failed')
      // Not adopted: the checks run again, which lands the merge or starts the next attempt.
      expect(statusWrites(world)).toEqual(['verifying', 'merged'])
      expect(world.item('A')).toMatchObject({ status: 'merged', fix_session_id: null })
      expect(world.api.verify).toHaveBeenCalledTimes(1)
    })

    it('verifies again when the fix session never started', async () => {
      const world = verifyingWorld({
        items: [
          readyItem('A', {
            status: 'fixing',
            fix_ticket_id: 'fix-ticket-9',
            fix_session_id: null,
            fix_attempts: 1,
            merge_sha: 'merge-A'
          })
        ]
      })
      start(world)

      await advance(1000)

      expect(world.api.verify).toHaveBeenCalledTimes(1)
      expect(world.item('A').status).toBe('merged')
    })
  })
})
