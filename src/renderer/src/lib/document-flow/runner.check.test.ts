import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildNudgePrompt } from '@shared/document-flow/prompts'
import type { DocumentRunItem, DocumentRunVerdict } from '@shared/types/document-flow'
import { DocumentFlowRunner, MAX_NUDGES, SETTLE_MS } from './runner'
import {
  FakeTransportError,
  TEST_NOW,
  advance,
  createWorld,
  makeVerdict,
  type RunnerWorld
} from './runner-fakes'

const SESSION = 's-A'
const PROMPTED_AT = '2026-05-04T09:59:00.000Z'

const checkingItem = (overrides: Partial<DocumentRunItem> = {}): Partial<DocumentRunItem> => ({
  key: 'A',
  status: 'checking',
  session_id: SESSION,
  worktree_id: 'wt-A',
  branch_name: 'a-task-a',
  started_at: PROMPTED_AT,
  last_prompt_at: PROMPTED_AT,
  ...overrides
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('DocumentFlowRunner: checking a finished turn', () => {
  let runner: DocumentFlowRunner | null = null

  const start = (world: RunnerWorld): void => {
    runner = new DocumentFlowRunner(world.ports)
    runner.start()
  }

  /** A world whose only item sits in `checking` with a turn that ended half a minute ago. */
  const checkingWorld = (
    verdict: Partial<DocumentRunVerdict>,
    item: Partial<DocumentRunItem> = {}
  ): { world: RunnerWorld; endedAt: number } => {
    const world = createWorld({ items: [checkingItem(item)] })
    const endedAt = Date.now() - 30_000
    world.endTurn(SESSION, { at: endedAt })
    world.api.classify.mockResolvedValue(makeVerdict(verdict))
    return { world, endedAt }
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

  it('queues a ticket judged done for merging and remembers which turn was judged', async () => {
    const { world, endedAt } = checkingWorld({ status: 'done' })
    // Hold the merge so the item can be seen right after the verdict.
    world.api.prepareMerge.mockReturnValue(new Promise(() => {}))
    start(world)

    await advance(1000)

    expect(world.ports.updateItem.mock.calls[0][2]).toEqual({
      last_checked_at: new Date(endedAt).toISOString(),
      status: 'ready',
      status_detail: null
    })
    expect(world.followups).toEqual([])
  })

  it('shows the agent’s question when the final message asks for input', async () => {
    const { world } = checkingWorld({
      status: 'needs_input',
      question: 'Should refunds use the original currency?',
      reason: 'The agent is waiting for an answer.'
    })
    start(world)

    await advance(1000)

    expect(world.item('A')).toMatchObject({
      status: 'needs_input',
      status_detail: 'Should refunds use the original currency?'
    })
    expect(world.notices).toEqual([
      { level: 'info', message: 'A is waiting for you: Should refunds use the original currency?' }
    ])
  })

  it('falls back to the reason when the verdict carries no question', async () => {
    const { world } = checkingWorld({
      status: 'needs_input',
      question: null,
      reason: 'It asks which API version to target.'
    })
    start(world)

    await advance(1000)

    expect(world.item('A').status_detail).toBe('It asks which API version to target.')
  })

  it('nudges a partly done ticket, then gives up after the last nudge', async () => {
    const reason = 'Tests were left failing.'
    const { world } = checkingWorld({ status: 'partial', reason })
    start(world)

    for (let nudge = 1; nudge <= MAX_NUDGES; nudge++) {
      await advance(1000)
      expect(world.followups).toHaveLength(nudge)
      expect(world.followups[nudge - 1]).toEqual({
        sessionId: SESSION,
        ticketId: 'ticket-A',
        prompt: buildNudgePrompt({ reason })
      })
      expect(world.item('A')).toMatchObject({
        status: 'running',
        status_detail: `Asked to finish: ${reason}`,
        nudge_count: nudge
      })

      world.endTurn(SESSION)
      await advance(SETTLE_MS + 200)
    }

    await advance(1000)
    expect(world.followups).toHaveLength(MAX_NUDGES)
    expect(world.item('A')).toMatchObject({ status: 'needs_attention', status_detail: reason })
    expect(world.api.classify).toHaveBeenCalledTimes(MAX_NUDGES + 1)
  })

  it.each(['blocked', 'failed'] as const)('flags a ticket judged %s', async (status) => {
    const { world } = checkingWorld({ status, reason: 'The staging database is unreachable.' })
    start(world)

    await advance(1000)

    expect(world.item('A')).toMatchObject({
      status: 'needs_attention',
      status_detail: 'The staging database is unreachable.'
    })
    expect(world.notices).toEqual([
      { level: 'warning', message: 'A needs attention: The staging database is unreachable.' }
    ])
    expect(world.followups).toEqual([])
  })

  it('passes the last assistant text of an SDK session and leaves CLI sessions to the server', async () => {
    const sdk = checkingWorld({ status: 'needs_input' }).world
    sdk.ports.readFinalMessage.mockResolvedValue('STATUS: NEEDS_INPUT')
    start(sdk)
    await advance(1000)
    runner?.stop()

    const cli = checkingWorld({ status: 'needs_input' }).world
    start(cli)
    await advance(1000)

    expect(sdk.api.classify).toHaveBeenCalledWith({
      runId: 'run-1',
      itemId: 'item-A',
      finalMessage: 'STATUS: NEEDS_INPUT'
    })
    expect(cli.api.classify).toHaveBeenCalledWith({ runId: 'run-1', itemId: 'item-A' })
  })

  it('still classifies when the final message cannot be read', async () => {
    const { world } = checkingWorld({ status: 'needs_input' })
    world.ports.readFinalMessage.mockRejectedValue(new Error('session not found'))
    start(world)

    await advance(1000)

    expect(world.api.classify).toHaveBeenCalledWith({ runId: 'run-1', itemId: 'item-A' })
    expect(world.item('A').status).toBe('needs_input')
  })

  it('resumes a check that a reload interrupted, stamping now when the turn end is unknown', async () => {
    const world = createWorld({ items: [checkingItem()] })
    world.api.classify.mockResolvedValue(makeVerdict({ status: 'needs_input' }))
    start(world)

    await advance(1000)

    expect(world.api.classify).toHaveBeenCalledTimes(1)
    expect(world.item('A')).toMatchObject({
      status: 'needs_input',
      last_checked_at: '2026-05-04T10:00:00.100Z'
    })
  })

  it('hands a session that failed since back to the watcher instead of judging it', async () => {
    const world = createWorld({ items: [checkingItem()] })
    world.endTurn(SESSION, { at: Date.now() - 30_000, completion: 'none', apiError: 'rate_limit' })
    start(world)

    await advance(1000)

    expect(world.api.classify).not.toHaveBeenCalled()
    expect(world.item('A')).toMatchObject({ status: 'running' })
    expect(world.item('A').retry_at).not.toBeNull()
  })

  it('does not judge a session that is working again', async () => {
    const world = createWorld({ items: [checkingItem()] })
    world.setSignal(SESSION, { kind: 'working' })
    start(world)

    await advance(1000)

    expect(world.api.classify).not.toHaveBeenCalled()
    expect(world.item('A').status).toBe('running')
  })

  it('judges the turn the server recorded behind a working status the renderer never saw end', async () => {
    const world = createWorld({ items: [checkingItem()] })
    world.setSignal(SESSION, { kind: 'working', since: Date.parse(PROMPTED_AT) })
    world.turns.set(SESSION, {
      session_id: SESSION,
      state: 'ended',
      text: '',
      completion: null,
      api_error: null,
      hook_event: 'SdkIdle',
      detail: null,
      updated_at: '2026-05-04T09:59:30.000Z'
    })
    world.api.classify.mockResolvedValue(makeVerdict({ status: 'needs_input' }))
    start(world)

    await advance(1000)

    expect(world.api.classify).toHaveBeenCalledTimes(1)
    expect(world.item('A')).toMatchObject({
      status: 'needs_input',
      last_checked_at: '2026-05-04T09:59:30.000Z'
    })
  })

  it('drops a verdict when the session moved on while it was being classified', async () => {
    const { world, endedAt } = checkingWorld({})
    const verdict = deferred<DocumentRunVerdict>()
    world.api.classify.mockReturnValue(verdict.promise)
    start(world)
    await advance(1000)
    expect(world.item('A').status).toBe('checking')

    world.setSignal(SESSION, { kind: 'working' })
    verdict.resolve(makeVerdict({ status: 'done' }))
    await advance(1000)

    expect(world.item('A')).toMatchObject({
      status: 'running',
      last_checked_at: new Date(endedAt).toISOString()
    })
    expect(world.api.prepareMerge).not.toHaveBeenCalled()
  })

  it('does not overwrite an item the user skipped while it was being classified', async () => {
    const { world } = checkingWorld({})
    const verdict = deferred<DocumentRunVerdict>()
    world.api.classify.mockReturnValue(verdict.promise)
    start(world)
    await advance(1000)

    world.setItem('A', { status: 'skipped', status_detail: 'Skipped by you.' })
    verdict.resolve(makeVerdict({ status: 'done' }))
    await advance(10_000)

    expect(world.item('A')).toMatchObject({ status: 'skipped', status_detail: 'Skipped by you.' })
    expect(world.api.prepareMerge).not.toHaveBeenCalled()
  })

  it('flags the item when classification fails on the server', async () => {
    const { world } = checkingWorld({})
    world.api.classify.mockRejectedValue(new Error('No generation provider is available'))
    start(world)

    await advance(1000)

    expect(world.item('A')).toMatchObject({
      status: 'needs_attention',
      status_detail: 'No generation provider is available'
    })
  })

  it('leaves the item alone when the server is unreachable, and retries on the interval', async () => {
    const { world } = checkingWorld({ status: 'needs_input' })
    world.api.classify
      .mockRejectedValueOnce(new FakeTransportError('socket closed'))
      .mockRejectedValueOnce(new FakeTransportError('socket closed'))
    start(world)

    await advance(9000)
    expect(world.api.classify).toHaveBeenCalledTimes(1)
    expect(world.item('A').status).toBe('checking')

    await advance(25_000)
    expect(world.api.classify).toHaveBeenCalledTimes(3)
    expect(world.item('A').status).toBe('needs_input')
  })

  it('flags a checking item that has no session', async () => {
    const world = createWorld({ items: [checkingItem({ session_id: null })] })
    start(world)

    await advance(1000)

    expect(world.item('A')).toMatchObject({
      status: 'needs_attention',
      status_detail: 'It has no session to check.'
    })
  })
})
