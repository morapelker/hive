// The flow behind the "Move projects" dialog: the plan, the list the person confirms, the run
// that asks for one project at a time, and what the window reloads on the way. The server is
// a stand-in RPC client whose answers each test queues; the reloads are recorders, written to
// the same log as the calls so their order can be read.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Every call to the server and every reload, in the order it started. */
const log = vi.hoisted(() => [] as string[])

const refresh = vi.hoisted(() => ({
  refreshAfterProjectMove: vi.fn(),
  refreshAfterDevFolderRun: vi.fn()
}))
vi.mock('../refresh', () => refresh)

import { getRendererRpcClient, setRendererRpcClient } from '@/api/rpc-client'
import {
  DEV_FOLDER_RPC,
  type DevFolderMoveCandidate,
  type DevFolderMovePlan,
  type DevFolderMoveResult
} from '@shared/types/dev-folder'
import {
  cancelRemainingDevFolderMove,
  closeDevFolderMove,
  openDevFolderMove,
  recheckDevFolderMove,
  startDevFolderMove,
  toggleDevFolderMoveRow
} from '../move-projects'
import { CLOSED_DEV_FOLDER_MOVE, useDevFolderMoveStore, type DevFolderMoveRow } from '../store'

const defaultClient = getRendererRpcClient()

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T = unknown>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const candidate = (
  id: string,
  over: Partial<DevFolderMoveCandidate> = {}
): DevFolderMoveCandidate => ({
  projectId: id,
  projectName: `name-${id}`,
  source: '/old',
  fromPath: `/old/${id}`,
  toPath: `/new/${id}`,
  skipReason: null,
  detail: null,
  ...over
})

const planOf = (...candidates: DevFolderMoveCandidate[]): DevFolderMovePlan => ({
  devFolder: '/new',
  sources: Array.from(new Set(candidates.map((entry) => entry.source))),
  candidates
})

const movedResult = (id: string, over: Partial<DevFolderMoveResult> = {}): DevFolderMoveResult => ({
  projectId: id,
  projectName: `name-${id}`,
  action: 'moved',
  fromPath: `/old/${id}`,
  toPath: `/new/${id}`,
  skipReason: null,
  detail: null,
  warnings: [],
  movedPaths: [{ from: `/old/${id}`, to: `/new/${id}` }],
  ...over
})

const skippedResult = (id: string): DevFolderMoveResult =>
  movedResult(id, {
    action: 'skipped',
    skipReason: 'busy',
    detail: 'A terminal is open in this project. Close its terminal tab, then check again.',
    movedPaths: []
  })

const failedResult = (id: string): DevFolderMoveResult =>
  movedResult(id, {
    action: 'failed',
    detail: 'This project was not moved: no space left. It is still in its old folder.',
    movedPaths: []
  })

/** What the stand-in server answers: plans in the order they are asked for, moves by project. */
const server = {
  plans: [] as (() => Promise<unknown>)[],
  move: (async () => undefined) as (params: {
    projectId: string
    expectedToPath: string
  }) => Promise<unknown>
}

const request = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
  if (method === DEV_FOLDER_RPC.planMove) {
    log.push('plan')
    const next = server.plans.shift()
    if (!next) throw new Error('no plan was queued')
    return next()
  }
  if (method === DEV_FOLDER_RPC.moveProject) {
    const asked = params as { projectId: string; expectedToPath: string }
    log.push(`move:${asked.projectId}`)
    return server.move(asked)
  }
  throw new Error(`unexpected method ${method}`)
})

const queuePlan = (...plans: unknown[]): void => {
  for (const plan of plans) server.plans.push(async () => plan)
}

const state = (): ReturnType<typeof useDevFolderMoveStore.getState> =>
  useDevFolderMoveStore.getState()
const row = (id: string): DevFolderMoveRow => {
  const found = state().rows.find((entry) => entry.candidate.projectId === id)
  if (!found) throw new Error(`no row for ${id}`)
  return found
}
const statuses = (): Record<string, string> =>
  Object.fromEntries(state().rows.map((entry) => [entry.candidate.projectId, entry.status]))
const moveCalls = (): unknown[][] =>
  request.mock.calls.filter(([method]) => method === DEV_FOLDER_RPC.moveProject)
const planCalls = (): number =>
  request.mock.calls.filter(([method]) => method === DEV_FOLDER_RPC.planMove).length

/** Lets every promise that is ready run, a few rounds deep. */
const settle = async (): Promise<void> => {
  for (let round = 0; round < 10; round++) await Promise.resolve()
}

/** The dialog open on a plan of these candidates, nothing moved yet. */
const openOn = async (...candidates: DevFolderMoveCandidate[]): Promise<void> => {
  queuePlan(planOf(...candidates))
  await openDevFolderMove()
  expect(state().phase).toBe('confirm')
}

beforeEach(() => {
  log.length = 0
  server.plans = []
  server.move = async ({ projectId }) => movedResult(projectId)
  refresh.refreshAfterProjectMove.mockImplementation(async (result: DevFolderMoveResult) => {
    log.push(`refresh:${result.projectId}`)
  })
  refresh.refreshAfterDevFolderRun.mockImplementation(async () => {
    log.push('refresh:end')
  })
  setRendererRpcClient({ request: request as never, subscribe: vi.fn() })
})

afterEach(() => {
  useDevFolderMoveStore.setState({ ...CLOSED_DEV_FOLDER_MOVE })
  setRendererRpcClient(defaultClient)
  vi.clearAllMocks()
})

describe('opening the dialog', () => {
  it('waits for the plan, then lists every project of it', async () => {
    const plan = planOf(
      candidate('a'),
      candidate('b', {
        skipReason: 'exists',
        detail: 'The dev folder already has a folder named b.'
      }),
      candidate('c', { source: '/older', fromPath: '/older/c' })
    )
    const answer = deferred()
    server.plans.push(() => answer.promise)

    const opening = openDevFolderMove()
    expect(state()).toMatchObject({ phase: 'planning', plan: null, rows: [], error: null })

    answer.resolve(plan)
    await opening

    expect(state()).toMatchObject({ phase: 'confirm', plan, rechecking: false, error: null })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith(DEV_FOLDER_RPC.planMove, {})
    // A project that can move is ticked and waits; one the plan rules out is neither.
    expect(state().rows).toEqual([
      { candidate: plan.candidates[0], selected: true, status: 'pending', result: null },
      { candidate: plan.candidates[1], selected: false, status: 'skipped', result: null },
      { candidate: plan.candidates[2], selected: true, status: 'pending', result: null }
    ])
    expect(moveCalls()).toHaveLength(0)
    expect(refresh.refreshAfterProjectMove).not.toHaveBeenCalled()
    expect(refresh.refreshAfterDevFolderRun).not.toHaveBeenCalled()
  })

  it('does nothing while the dialog is open', async () => {
    await openOn(candidate('a'))

    await openDevFolderMove()
    await openDevFolderMove()

    expect(planCalls()).toBe(1)
    expect(state().phase).toBe('confirm')
  })

  it('shows why there is no list when the plan cannot be had', async () => {
    server.plans.push(async () => {
      throw new Error('Hive WebSocket transport closed.')
    })

    await expect(openDevFolderMove()).resolves.toBeUndefined()

    expect(state()).toMatchObject({
      phase: 'confirm',
      plan: null,
      rows: [],
      error: 'The projects could not be checked: Hive WebSocket transport closed.'
    })
  })

  it.each([
    ['undefined', undefined],
    ['{ ok: true }', { ok: true }],
    ['a plan without candidates', { devFolder: '/new', sources: [] }]
  ])('reads %s as no plan', async (_label, answer) => {
    queuePlan(answer)

    await openDevFolderMove()

    expect(state()).toMatchObject({
      phase: 'confirm',
      plan: null,
      rows: [],
      error: 'The projects could not be checked: the answer could not be read.'
    })
  })

  it('drops a plan that arrives after the dialog was closed', async () => {
    const answer = deferred()
    server.plans.push(() => answer.promise)
    const opening = openDevFolderMove()

    closeDevFolderMove()
    expect(state().phase).toBe('closed')
    answer.resolve(planOf(candidate('a')))
    await opening

    expect(state()).toEqual(CLOSED_DEV_FOLDER_MOVE)
  })

  it('drops the plan of a dialog that was closed and opened again', async () => {
    const first = deferred()
    const second = deferred()
    server.plans.push(() => first.promise)
    server.plans.push(() => second.promise)

    const opening = openDevFolderMove()
    closeDevFolderMove()
    const reopening = openDevFolderMove()
    first.resolve(planOf(candidate('stale')))
    await opening
    expect(state()).toMatchObject({ phase: 'planning', rows: [] })

    second.resolve(planOf(candidate('fresh')))
    await reopening
    expect(Object.keys(statuses())).toEqual(['fresh'])
  })
})

describe('ticking projects', () => {
  it('unticks and ticks a project that can move, and leaves the others alone', async () => {
    await openOn(candidate('a'), candidate('b'))

    toggleDevFolderMoveRow('a')
    expect(row('a').selected).toBe(false)
    expect(row('b').selected).toBe(true)

    toggleDevFolderMoveRow('a')
    expect(row('a').selected).toBe(true)

    toggleDevFolderMoveRow('nobody')
    expect(state().rows.map((entry) => entry.selected)).toEqual([true, true])
  })

  it('never ticks a project the plan rules out', async () => {
    await openOn(candidate('a', { skipReason: 'missing', detail: 'Its folder is not on disk.' }))

    toggleDevFolderMoveRow('a')

    expect(row('a')).toMatchObject({ selected: false, status: 'skipped' })
  })

  it('is only possible in the list the person confirms', async () => {
    await openOn(candidate('a'), candidate('b'))
    const answer = deferred()
    server.move = () => answer.promise

    const run = startDevFolderMove()
    toggleDevFolderMoveRow('b')
    expect(row('b').selected).toBe(true)

    answer.resolve(movedResult('a'))
    server.move = async ({ projectId }) => movedResult(projectId)
    await run
    toggleDevFolderMoveRow('b')
    expect(state().phase).toBe('summary')
    expect(row('b').selected).toBe(true)
  })
})

describe('a run', () => {
  it('moves the ticked projects one at a time and records each answer', async () => {
    await openOn(
      candidate('a'),
      candidate('b'),
      candidate('c'),
      candidate('unticked'),
      candidate('ruled-out', { skipReason: 'exists', detail: 'Already there.' })
    )
    toggleDevFolderMoveRow('unticked')
    const answers = { a: deferred(), b: deferred(), c: deferred() }
    server.move = ({ projectId }) => answers[projectId as 'a' | 'b' | 'c'].promise

    const run = startDevFolderMove()
    expect(state()).toMatchObject({ phase: 'running', cancelRequested: false, error: null })
    await settle()
    // Only the first project was asked for; the others wait.
    expect(log).toEqual(['plan', 'move:a'])
    expect(statuses()).toEqual({
      a: 'running',
      b: 'pending',
      c: 'pending',
      unticked: 'pending',
      'ruled-out': 'skipped'
    })

    const a = movedResult('a', { warnings: ['A worktree link needs a look.'] })
    answers.a.resolve(a)
    await settle()
    expect(row('a')).toMatchObject({ status: 'moved', result: a })
    expect(row('b').status).toBe('running')

    const b = skippedResult('b')
    answers.b.resolve(b)
    await settle()
    expect(row('b')).toMatchObject({ status: 'skipped', result: b })
    expect(row('c').status).toBe('running')
    expect(state().phase).toBe('running')

    const c = failedResult('c')
    answers.c.resolve(c)
    await run

    expect(state()).toMatchObject({ phase: 'summary', cancelRequested: false, error: null })
    expect(statuses()).toEqual({
      a: 'moved',
      b: 'skipped',
      c: 'failed',
      unticked: 'pending',
      'ruled-out': 'skipped'
    })
    expect(row('c').result).toBe(c)
    expect(row('unticked')).toMatchObject({ selected: false, result: null })
    expect(row('ruled-out').result).toBeNull()

    // Each call names the project and where its plan row said it goes, and nothing else.
    expect(moveCalls()).toEqual([
      [DEV_FOLDER_RPC.moveProject, { projectId: 'a', expectedToPath: '/new/a' }],
      [DEV_FOLDER_RPC.moveProject, { projectId: 'b', expectedToPath: '/new/b' }],
      [DEV_FOLDER_RPC.moveProject, { projectId: 'c', expectedToPath: '/new/c' }]
    ])
    // The window is reloaded after the project that moved, before the next one is asked for,
    // and once more when the run is over. A skipped or failed project moved nothing.
    expect(log).toEqual(['plan', 'move:a', 'refresh:a', 'move:b', 'move:c', 'refresh:end'])
    expect(refresh.refreshAfterProjectMove).toHaveBeenCalledTimes(1)
    // Said to be inside a run: what only the end of the run has to show is left to it.
    expect(refresh.refreshAfterProjectMove).toHaveBeenCalledWith(a, { inRun: true })
    expect(refresh.refreshAfterDevFolderRun).toHaveBeenCalledTimes(1)
    // A run that got every answer needs no new plan.
    expect(planCalls()).toBe(1)
  })

  it('does not ask for the next project before the window was reloaded for the one that moved', async () => {
    await openOn(candidate('a'), candidate('b'))
    const reloading = deferred<void>()
    refresh.refreshAfterProjectMove.mockImplementationOnce(async () => {
      log.push('refresh:a')
      await reloading.promise
    })

    const run = startDevFolderMove()
    await settle()
    expect(log).toEqual(['plan', 'move:a', 'refresh:a'])
    expect(row('b').status).toBe('pending')

    reloading.resolve()
    await run
    expect(log).toEqual(['plan', 'move:a', 'refresh:a', 'move:b', 'refresh:b', 'refresh:end'])
  })

  it('reloads the window after every project that moved', async () => {
    await openOn(candidate('a'), candidate('b'), candidate('c'))

    await startDevFolderMove()

    expect(refresh.refreshAfterProjectMove.mock.calls.map(([result]) => result)).toEqual([
      movedResult('a'),
      movedResult('b'),
      movedResult('c')
    ])
    expect(refresh.refreshAfterDevFolderRun).toHaveBeenCalledTimes(1)
    expect(log.at(-1)).toBe('refresh:end')
  })

  it('returns at once when nothing is ticked', async () => {
    await openOn(candidate('a'), candidate('b', { skipReason: 'busy', detail: 'Busy.' }))
    toggleDevFolderMoveRow('a')

    await startDevFolderMove()

    expect(state().phase).toBe('confirm')
    expect(moveCalls()).toHaveLength(0)
    expect(refresh.refreshAfterDevFolderRun).not.toHaveBeenCalled()
  })

  it('returns at once when the dialog is not showing a list to confirm', async () => {
    await startDevFolderMove()
    expect(state().phase).toBe('closed')

    const answer = deferred()
    server.plans.push(() => answer.promise)
    const opening = openDevFolderMove()
    await startDevFolderMove()
    expect(state().phase).toBe('planning')

    answer.resolve(planOf(candidate('a')))
    await opening
    await startDevFolderMove()
    expect(state().phase).toBe('summary')
    await startDevFolderMove()
    expect(moveCalls()).toHaveLength(1)
  })

  it('ignores a second start while the first run is going', async () => {
    await openOn(candidate('a'), candidate('b'))
    const answer = deferred()
    server.move = ({ projectId }) =>
      projectId === 'a' ? answer.promise : Promise.resolve(movedResult(projectId))

    const first = startDevFolderMove()
    await settle()
    let secondDone = false
    const second = startDevFolderMove().then(() => {
      secondDone = true
    })
    await settle()
    // The second start came back while the first run still waits for its first answer.
    expect(secondDone).toBe(true)
    expect(state().phase).toBe('running')
    expect(log).toEqual(['plan', 'move:a'])

    answer.resolve(movedResult('a'))
    await Promise.all([first, second])

    expect(moveCalls().map(([, params]) => (params as { projectId: string }).projectId)).toEqual([
      'a',
      'b'
    ])
    expect(refresh.refreshAfterDevFolderRun).toHaveBeenCalledTimes(1)
  })

  it('cannot be closed while it is going, and can be once it is over', async () => {
    await openOn(candidate('a'))
    const answer = deferred()
    server.move = () => answer.promise

    const run = startDevFolderMove()
    await settle()
    closeDevFolderMove()
    expect(state().phase).toBe('running')
    expect(row('a').status).toBe('running')

    answer.resolve(movedResult('a'))
    await run
    expect(state().phase).toBe('summary')

    closeDevFolderMove()
    expect(state()).toEqual(CLOSED_DEV_FOLDER_MOVE)
  })
})

describe('"Cancel remaining"', () => {
  it('lets the project being moved finish and starts no other one', async () => {
    await openOn(candidate('a'), candidate('b'), candidate('c'))
    const answer = deferred()
    server.move = () => answer.promise

    const run = startDevFolderMove()
    await settle()
    cancelRemainingDevFolderMove()
    expect(state()).toMatchObject({ phase: 'running', cancelRequested: true })
    // The call that is under way is not touched.
    expect(row('a').status).toBe('running')

    answer.resolve(movedResult('a'))
    await run

    expect(log).toEqual(['plan', 'move:a', 'refresh:a', 'refresh:end'])
    expect(statuses()).toEqual({ a: 'moved', b: 'pending', c: 'pending' })
    expect(row('b')).toMatchObject({ selected: true, result: null })
    expect(state()).toMatchObject({ phase: 'summary', cancelRequested: false, error: null })
    // Cancelling is the person's choice, not a lost answer: no new plan is made.
    expect(planCalls()).toBe(1)
  })

  it('does nothing when no run is going', async () => {
    cancelRemainingDevFolderMove()
    expect(state()).toEqual(CLOSED_DEV_FOLDER_MOVE)

    await openOn(candidate('a'))
    cancelRemainingDevFolderMove()
    expect(state().cancelRequested).toBe(false)

    // A cancel from before the run does not stop the run that starts next.
    await startDevFolderMove()
    expect(row('a').status).toBe('moved')
  })
})

describe('a move that does not answer', () => {
  it('marks the project failed, reloads its rows, stops, and makes a new plan', async () => {
    await openOn(candidate('a'), candidate('b'), candidate('c'))
    server.move = async ({ projectId }) => {
      if (projectId === 'b') throw new Error('Hive WebSocket transport closed')
      return movedResult(projectId)
    }
    const fresh = planOf(candidate('b'), candidate('c'))
    queuePlan(fresh)

    await expect(startDevFolderMove()).resolves.toBeUndefined()

    // The project after it is never asked for, and the plan is asked for again at the end.
    expect(log).toEqual([
      'plan',
      'move:a',
      'refresh:a',
      'move:b',
      'refresh:b',
      'refresh:end',
      'plan'
    ])
    expect(statuses()).toEqual({ a: 'moved', b: 'failed', c: 'pending' })
    const lost = row('b').result
    expect(lost).toEqual({
      projectId: 'b',
      projectName: 'name-b',
      action: 'failed',
      fromPath: '/old/b',
      toPath: '/new/b',
      skipReason: null,
      detail:
        'Hive did not get an answer for this move (Hive WebSocket transport closed). The project may have been moved anyway: check again before moving it.',
      warnings: [],
      movedPaths: []
    })
    // Its rows are reloaded with nothing to re-key: where it is now is not known.
    expect(refresh.refreshAfterProjectMove).toHaveBeenLastCalledWith(lost)
    expect(refresh.refreshAfterDevFolderRun).toHaveBeenCalledTimes(1)
    // The run's own account stays; the new plan says what is left.
    expect(state()).toMatchObject({
      phase: 'summary',
      plan: fresh,
      cancelRequested: false,
      error:
        'The run stopped at "name-b": Hive did not get an answer for its move, and the projects after it were not started. 2 projects can still be moved: check again to see them.'
    })
    expect(row('a').result).toEqual(movedResult('a'))
  })

  it('says so when the new plan cannot be had either', async () => {
    const plan = planOf(candidate('a'), candidate('b'))
    queuePlan(plan)
    await openDevFolderMove()
    server.move = async () => {
      throw new Error('connection closed')
    }
    server.plans.push(async () => {
      throw new Error('connection closed')
    })

    await startDevFolderMove()

    expect(statuses()).toEqual({ a: 'failed', b: 'pending' })
    expect(state()).toMatchObject({
      phase: 'summary',
      plan,
      error:
        'The run stopped at "name-a": Hive did not get an answer for its move, and the projects after it were not started. Check again to see what is left.'
    })
  })

  it.each([
    [
      'one project',
      planOf(candidate('a'), candidate('x', { skipReason: 'busy', detail: 'Busy.' })),
      '1 project can still be moved: check again to see it.'
    ],
    [
      'nothing',
      planOf(candidate('x', { skipReason: 'busy', detail: 'Busy.' })),
      'Nothing is left that can be moved.'
    ]
  ])('says what the new plan still lets through: %s', async (_label, fresh, ending) => {
    await openOn(candidate('a'))
    server.move = async () => {
      throw new Error('gone')
    }
    queuePlan(fresh)

    await startDevFolderMove()

    expect(state().error).toBe(
      `The run stopped at "name-a": Hive did not get an answer for its move, and the projects after it were not started. ${ending}`
    )
  })

  it.each([
    ['undefined', () => undefined],
    ['{ ok: true }', () => ({ ok: true })],
    ['a result without its lists', () => ({ projectId: 'a', action: 'moved' })],
    ['the result of another project', () => movedResult('someone-else')]
  ])('treats %s as no answer', async (_label, answer) => {
    await openOn(candidate('a'), candidate('b'))
    server.move = async () => answer()
    queuePlan(planOf(candidate('a'), candidate('b')))

    await startDevFolderMove()

    expect(log).toEqual(['plan', 'move:a', 'refresh:a', 'refresh:end', 'plan'])
    expect(statuses()).toEqual({ a: 'failed', b: 'pending' })
    expect(row('a').result).toMatchObject({
      projectId: 'a',
      action: 'failed',
      movedPaths: [],
      detail:
        'Hive did not get an answer for this move (the answer could not be read). The project may have been moved anyway: check again before moving it.'
    })
    expect(refresh.refreshAfterProjectMove).toHaveBeenCalledTimes(1)
    expect(refresh.refreshAfterProjectMove).toHaveBeenCalledWith(row('a').result)
    expect(state().phase).toBe('summary')
  })

  it('words a rejection that carries no message', async () => {
    await openOn(candidate('a'))
    server.move = () => Promise.reject(undefined)
    queuePlan(planOf(candidate('a')))

    await startDevFolderMove()

    expect(row('a').result?.detail).toBe(
      'Hive did not get an answer for this move. The project may have been moved anyway: check again before moving it.'
    )
  })
})

// The server may finish a move after the window stopped waiting for its answer, and it tells
// the window that asked nothing more about it.
describe('the project a run stopped at', () => {
  /** A run of a, b, c that stops at b; the log starts empty after it. */
  const stopAtB = async (): Promise<void> => {
    await openOn(candidate('a'), candidate('b'), candidate('c'))
    server.move = async ({ projectId }) => {
      if (projectId === 'b') throw new Error('Hive WebSocket transport closed')
      return movedResult(projectId)
    }
    queuePlan(planOf(candidate('b'), candidate('c')))
    await startDevFolderMove()
    expect(state()).toMatchObject({ phase: 'summary', stoppedAt: candidate('b') })
    log.length = 0
    refresh.refreshAfterProjectMove.mockClear()
  }

  const reloadOfB = expect.objectContaining({ projectId: 'b', action: 'failed', movedPaths: [] })

  it('is reloaded on every "Check again", with nothing to re-key', async () => {
    await stopAtB()
    const fresh = planOf(candidate('c'))
    queuePlan(fresh)

    await recheckDevFolderMove()

    expect(log).toEqual(['plan', 'refresh:b'])
    expect(refresh.refreshAfterProjectMove).toHaveBeenCalledTimes(1)
    expect(refresh.refreshAfterProjectMove).toHaveBeenCalledWith(reloadOfB)
    expect(state()).toMatchObject({ phase: 'confirm', plan: fresh, error: null })

    // The server may still have been at it: the next check reads it again.
    queuePlan(fresh)
    await recheckDevFolderMove()
    expect(log).toEqual(['plan', 'refresh:b', 'plan', 'refresh:b'])
  })

  it('is reloaded on "Check again" when the new plan cannot be had, too', async () => {
    await stopAtB()
    server.plans.push(async () => {
      throw new Error('connection closed')
    })

    await recheckDevFolderMove()

    expect(log).toEqual(['plan', 'refresh:b'])
    expect(state()).toMatchObject({
      phase: 'summary',
      rechecking: false,
      error: 'The projects could not be checked: connection closed.'
    })
  })

  it('is reloaded once more when the dialog closes', async () => {
    await stopAtB()

    closeDevFolderMove()

    expect(state()).toEqual(CLOSED_DEV_FOLDER_MOVE)
    expect(refresh.refreshAfterProjectMove).toHaveBeenCalledTimes(1)
    expect(refresh.refreshAfterProjectMove).toHaveBeenCalledWith(reloadOfB)
    await settle()

    // The next dialog knows nothing of it.
    await openOn(candidate('c'))
    queuePlan(planOf(candidate('c')))
    await recheckDevFolderMove()
    closeDevFolderMove()
    expect(refresh.refreshAfterProjectMove).toHaveBeenCalledTimes(1)
  })

  it('is still reloaded on close after a "Check again" brought a new list', async () => {
    await stopAtB()
    queuePlan(planOf(candidate('c')))
    await recheckDevFolderMove()
    refresh.refreshAfterProjectMove.mockClear()

    closeDevFolderMove()

    expect(refresh.refreshAfterProjectMove).toHaveBeenCalledTimes(1)
    expect(refresh.refreshAfterProjectMove).toHaveBeenCalledWith(reloadOfB)
  })

  it('does not hold the dialog when its reload fails', async () => {
    await stopAtB()
    refresh.refreshAfterProjectMove.mockRejectedValue(new Error('reload broke'))
    const fresh = planOf(candidate('c'))
    queuePlan(fresh)

    await expect(recheckDevFolderMove()).resolves.toBeUndefined()
    expect(state()).toMatchObject({ phase: 'confirm', plan: fresh })

    closeDevFolderMove()
    await settle()
    expect(state()).toEqual(CLOSED_DEV_FOLDER_MOVE)
  })

  it('drops the new plan when the dialog was closed while it was being reloaded', async () => {
    await stopAtB()
    const reloading = deferred<void>()
    refresh.refreshAfterProjectMove.mockImplementationOnce(() => reloading.promise)
    queuePlan(planOf(candidate('late')))

    const rechecking = recheckDevFolderMove()
    await settle()
    closeDevFolderMove()
    reloading.resolve()
    await rechecking

    expect(state()).toEqual(CLOSED_DEV_FOLDER_MOVE)
  })

  it('is nobody after a run that got every answer', async () => {
    await openOn(candidate('a'), candidate('b'))
    await startDevFolderMove()
    expect(state()).toMatchObject({ phase: 'summary', stoppedAt: null })
    refresh.refreshAfterProjectMove.mockClear()
    queuePlan(planOf())

    await recheckDevFolderMove()
    closeDevFolderMove()

    expect(refresh.refreshAfterProjectMove).not.toHaveBeenCalled()
  })
})

describe('a run always ends', () => {
  it('leaves the running phase when the reload after a move fails', async () => {
    await openOn(candidate('a'), candidate('b'))
    refresh.refreshAfterProjectMove.mockRejectedValueOnce(new Error('reload broke'))

    await expect(startDevFolderMove()).resolves.toBeUndefined()

    expect(state()).toMatchObject({
      phase: 'summary',
      error: 'The run stopped: reload broke. Check again to see what is left.'
    })
    expect(statuses()).toEqual({ a: 'moved', b: 'pending' })
    expect(refresh.refreshAfterDevFolderRun).toHaveBeenCalledTimes(1)
  })

  it('leaves the running phase when the reload at the end fails', async () => {
    await openOn(candidate('a'))
    refresh.refreshAfterDevFolderRun.mockRejectedValueOnce(new Error('reload broke'))

    await expect(startDevFolderMove()).resolves.toBeUndefined()

    expect(state()).toMatchObject({ phase: 'summary', error: null })
    expect(row('a').status).toBe('moved')
  })
})

describe('"Check again"', () => {
  it('keeps the list on screen until the new plan arrives, then replaces it', async () => {
    await openOn(candidate('a'), candidate('b'), candidate('c'))
    toggleDevFolderMoveRow('b')
    const before = state().rows
    const answer = deferred()
    server.plans.push(() => answer.promise)

    const rechecking = recheckDevFolderMove()
    expect(state()).toMatchObject({ phase: 'confirm', rechecking: true, rows: before })

    const fresh = planOf(
      candidate('a', { skipReason: 'busy', detail: 'A session is running in this project.' }),
      candidate('b'),
      candidate('c'),
      candidate('d')
    )
    answer.resolve(fresh)
    await rechecking

    expect(state()).toMatchObject({ phase: 'confirm', plan: fresh, rechecking: false, error: null })
    expect(state().rows).toEqual([
      // Now ruled out: not ticked any more.
      { candidate: fresh.candidates[0], selected: false, status: 'skipped', result: null },
      // What the person unticked stays unticked.
      { candidate: fresh.candidates[1], selected: false, status: 'pending', result: null },
      { candidate: fresh.candidates[2], selected: true, status: 'pending', result: null },
      // A project the list did not have starts ticked.
      { candidate: fresh.candidates[3], selected: true, status: 'pending', result: null }
    ])
    expect(planCalls()).toBe(2)
  })

  it('after a run, starts over with what is still to be moved', async () => {
    await openOn(candidate('a'), candidate('b'))
    toggleDevFolderMoveRow('b')
    await startDevFolderMove()
    expect(state().phase).toBe('summary')
    const fresh = planOf(candidate('b'))
    queuePlan(fresh)

    await recheckDevFolderMove()

    expect(state()).toMatchObject({ phase: 'confirm', plan: fresh, error: null })
    // What was unticked for the run that is over does not carry into the new list.
    expect(state().rows).toEqual([
      { candidate: fresh.candidates[0], selected: true, status: 'pending', result: null }
    ])
  })

  it('clears the sentence of a run that stopped once the new list is there', async () => {
    await openOn(candidate('a'))
    server.move = async () => {
      throw new Error('gone')
    }
    queuePlan(planOf(candidate('a')))
    await startDevFolderMove()
    expect(state().error).not.toBeNull()
    queuePlan(planOf(candidate('a')))

    await recheckDevFolderMove()

    expect(state()).toMatchObject({ phase: 'confirm', error: null })
    expect(row('a')).toMatchObject({ status: 'pending', result: null, selected: true })
  })

  it('keeps the list and says why when the new plan cannot be had', async () => {
    await openOn(candidate('a'), candidate('b'))
    toggleDevFolderMoveRow('b')
    const before = state()
    server.plans.push(async () => {
      throw new Error('timed out')
    })

    await expect(recheckDevFolderMove()).resolves.toBeUndefined()

    expect(state()).toMatchObject({
      phase: 'confirm',
      plan: before.plan,
      rows: before.rows,
      rechecking: false,
      error: 'The projects could not be checked: timed out.'
    })
  })

  it('asks once while a new plan is on its way, and nothing else starts meanwhile', async () => {
    await openOn(candidate('a'), candidate('b'))
    const answer = deferred()
    server.plans.push(() => answer.promise)

    const first = recheckDevFolderMove()
    await recheckDevFolderMove()
    toggleDevFolderMoveRow('a')
    await startDevFolderMove()

    expect(planCalls()).toBe(2)
    expect(row('a').selected).toBe(true)
    expect(state().phase).toBe('confirm')
    expect(moveCalls()).toHaveLength(0)

    answer.resolve(planOf(candidate('a'), candidate('b')))
    await first
    expect(state().rechecking).toBe(false)
  })

  it('does nothing when there is no list to check again', async () => {
    await recheckDevFolderMove()
    expect(planCalls()).toBe(0)

    const planning = deferred()
    server.plans.push(() => planning.promise)
    const opening = openDevFolderMove()
    await recheckDevFolderMove()
    expect(planCalls()).toBe(1)
    planning.resolve(planOf(candidate('a')))
    await opening

    const moving = deferred()
    server.move = () => moving.promise
    const run = startDevFolderMove()
    await settle()
    await recheckDevFolderMove()
    expect(planCalls()).toBe(1)
    expect(state().phase).toBe('running')

    moving.resolve(movedResult('a'))
    await run
  })

  it('drops a new plan that arrives after the dialog was closed', async () => {
    await openOn(candidate('a'))
    const answer = deferred()
    server.plans.push(() => answer.promise)

    const rechecking = recheckDevFolderMove()
    closeDevFolderMove()
    answer.resolve(planOf(candidate('late')))
    await rechecking

    expect(state()).toEqual(CLOSED_DEV_FOLDER_MOVE)
  })
})

describe('closing the dialog', () => {
  it('forgets the plan, the rows and the sentence', async () => {
    server.plans.push(async () => {
      throw new Error('gone')
    })
    await openDevFolderMove()
    expect(state().error).not.toBeNull()

    closeDevFolderMove()

    expect(state()).toEqual(CLOSED_DEV_FOLDER_MOVE)
    // Closing what is closed changes nothing.
    closeDevFolderMove()
    expect(state()).toEqual(CLOSED_DEV_FOLDER_MOVE)
  })

  it('opens on a new plan the next time', async () => {
    await openOn(candidate('a'))
    toggleDevFolderMoveRow('a')
    closeDevFolderMove()

    await openOn(candidate('a'), candidate('b'))

    expect(state().rows.map((entry) => entry.selected)).toEqual([true, true])
    expect(planCalls()).toBe(2)
  })
})
