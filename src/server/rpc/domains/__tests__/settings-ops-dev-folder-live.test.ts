// The live settingsOps service for the dev folder, and the step that finishes an interrupted
// move while the server starts. The dev folder modules are mocked: what is checked here is
// what this layer adds on top of them (the state it composes, the answers when a part of it
// fails, one call at a time, and that nothing is loaded while it is not needed).
import { Cause, Effect, Exit, Option } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEV_FOLDER_PENDING_MOVE_KEY } from '../../../../main/services/dev-folder/types'
import { APP_SETTINGS_DB_KEY } from '../../../../shared/types/settings'
import type {
  DevFolderMovePlan,
  DevFolderMoveResult,
  DevFolderState
} from '../../../../shared/types/dev-folder'

type StateWithoutCount = Omit<DevFolderState, 'leftBehind'>

const mocks = vi.hoisted(() => {
  /** Which of the mocked dev folder modules were loaded, in order. */
  const loaded: string[] = []
  const fns = {
    getDatabase: vi.fn(),
    readDevFolderState: vi.fn(),
    setDevFolder: vi.fn(),
    createLiveSetDevFolderDeps: vi.fn(),
    countLeftBehind: vi.fn(),
    planDevFolderMove: vi.fn(),
    moveProjectToDevFolder: vi.fn(),
    resumePendingDevFolderMove: vi.fn(),
    createLiveMoveProjectsDeps: vi.fn(),
    createLiveMoveQueryDeps: vi.fn()
  }
  return {
    loaded,
    fns,
    /** The module factories: each notes that its module was loaded. */
    modules: {
      settings: () => {
        loaded.push('dev-folder-settings')
        return {
          readDevFolderState: fns.readDevFolderState,
          setDevFolder: fns.setDevFolder,
          createLiveSetDevFolderDeps: fns.createLiveSetDevFolderDeps
        }
      },
      moves: () => {
        loaded.push('move-projects')
        return {
          countLeftBehind: fns.countLeftBehind,
          planDevFolderMove: fns.planDevFolderMove,
          moveProjectToDevFolder: fns.moveProjectToDevFolder,
          resumePendingDevFolderMove: fns.resumePendingDevFolderMove
        }
      },
      liveDeps: () => {
        loaded.push('live-deps')
        return { createLiveMoveProjectsDeps: fns.createLiveMoveProjectsDeps }
      },
      liveQueryDeps: () => {
        loaded.push('live-query-deps')
        return { createLiveMoveQueryDeps: fns.createLiveMoveQueryDeps }
      }
    }
  }
})

vi.mock('../../../../main/db', () => ({
  getDatabase: () => mocks.fns.getDatabase()
}))
vi.mock('../../../../main/services/dev-folder/dev-folder-settings', mocks.modules.settings)
vi.mock('../../../../main/services/dev-folder/move-projects', mocks.modules.moves)
vi.mock('../../../../main/services/dev-folder/live-deps', mocks.modules.liveDeps)
vi.mock('../../../../main/services/dev-folder/live-query-deps', mocks.modules.liveQueryDeps)

/**
 * Start again with none of the dev folder modules loaded, so a test can tell which of them
 * the code under test asks for. Registering a mock again drops the loaded copy of it.
 */
const forgetLoadedDevFolderModules = (): void => {
  vi.doMock('../../../../main/services/dev-folder/dev-folder-settings', mocks.modules.settings)
  vi.doMock('../../../../main/services/dev-folder/move-projects', mocks.modules.moves)
  vi.doMock('../../../../main/services/dev-folder/live-deps', mocks.modules.liveDeps)
  vi.doMock('../../../../main/services/dev-folder/live-query-deps', mocks.modules.liveQueryDeps)
  vi.resetModules()
  mocks.loaded.length = 0
}

const stateBefore: StateWithoutCount = {
  path: '/Users/someone/hive-projects',
  isDefault: true,
  defaultPath: '/Users/someone/hive-projects',
  exists: true,
  previousPaths: []
}

const stateAfter: StateWithoutCount = {
  path: '/Users/someone/Dev',
  isDefault: false,
  defaultPath: '/Users/someone/hive-projects',
  exists: true,
  previousPaths: ['/Users/someone/hive-projects']
}

const leftBehind = { count: 3, folders: ['/Users/someone/hive-projects'] }

const plan: DevFolderMovePlan = {
  devFolder: '/Users/someone/Dev',
  sources: ['/Users/someone/hive-projects'],
  candidates: []
}

const movedResult = (projectId: string): DevFolderMoveResult => ({
  projectId,
  projectName: projectId,
  action: 'moved',
  fromPath: `/Users/someone/hive-projects/${projectId}`,
  toPath: `/Users/someone/Dev/${projectId}`,
  skipReason: null,
  detail: null,
  warnings: [],
  movedPaths: [
    {
      from: `/Users/someone/hive-projects/${projectId}`,
      to: `/Users/someone/Dev/${projectId}`
    }
  ]
})

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Long enough for everything that is not waiting on a test's own promise to have run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25))

const failureOf = async (effect: Effect.Effect<unknown, unknown, never>): Promise<unknown> => {
  const exit = await Effect.runPromiseExit(effect)
  return Exit.isFailure(exit) ? Option.getOrNull(Cause.failureOption(exit.cause)) : null
}

/** The settings rows and project rows the fake database answers from. */
let settings: Map<string, string>
let projects: Map<string, { id: string; name: string; path: string }>
let db: {
  getSetting: (key: string) => string | null
  setSetting: (key: string, value: string) => void
  getProject: (id: string) => { id: string; name: string; path: string } | null
}
/** What `readDevFolderState` answers; the `setDevFolder` mock changes it, as the real one would. */
let currentState: StateWithoutCount
const setDeps = { marker: 'set deps' }
const queryDeps = { marker: 'query deps' }
const moveDeps = { marker: 'move deps' }

const { fns } = mocks

let warn: ReturnType<typeof vi.spyOn>

const loadSettingsOps = () => import('../settings-ops')

beforeEach(() => {
  // Each test loads the module under test afresh, and with it the queue that keeps dev folder
  // changes one at a time: a test that fails with a call still waiting holds up no other test.
  vi.resetModules()
  settings = new Map()
  projects = new Map([
    ['api', { id: 'api', name: 'API', path: '/Users/someone/hive-projects/api' }]
  ])
  db = {
    getSetting: (key) => settings.get(key) ?? null,
    setSetting: (key, value) => {
      settings.set(key, value)
    },
    getProject: (id) => projects.get(id) ?? null
  }
  currentState = stateBefore
  for (const mock of Object.values(fns)) mock.mockReset()
  fns.getDatabase.mockImplementation(() => db)
  fns.readDevFolderState.mockImplementation(() => currentState)
  fns.createLiveSetDevFolderDeps.mockReturnValue(setDeps)
  fns.setDevFolder.mockImplementation(() => {
    currentState = stateAfter
    return { success: true }
  })
  fns.createLiveMoveQueryDeps.mockReturnValue(queryDeps)
  fns.countLeftBehind.mockReturnValue(leftBehind)
  fns.createLiveMoveProjectsDeps.mockResolvedValue(moveDeps)
  fns.planDevFolderMove.mockResolvedValue(plan)
  fns.moveProjectToDevFolder.mockImplementation(async (params: { projectId: string }) =>
    movedResult(params.projectId)
  )
  fns.resumePendingDevFolderMove.mockResolvedValue(undefined)
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  warn.mockRestore()
  vi.unstubAllEnvs()
})

describe('live settingsOps: getDevFolder', () => {
  it('answers the state of the setting with the count of projects left behind', async () => {
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()
    const answer = await Effect.runPromise(makeLiveSettingsOpsRpcService().getDevFolder())

    expect(answer).toEqual({ ...stateBefore, leftBehind })
    expect(fns.readDevFolderState).toHaveBeenCalledWith(db)
    expect(fns.createLiveMoveQueryDeps).toHaveBeenCalledWith(db)
    expect(fns.countLeftBehind).toHaveBeenCalledWith(queryDeps)
  })

  it('needs no reading of what is running: the full move bindings are not made', async () => {
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()
    await Effect.runPromise(makeLiveSettingsOpsRpcService().getDevFolder())
    expect(fns.createLiveMoveProjectsDeps).not.toHaveBeenCalled()
  })

  it('still answers the folder when the count throws', async () => {
    fns.countLeftBehind.mockImplementation(() => {
      throw new Error('the projects table could not be read')
    })
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()
    const answer = await Effect.runPromise(makeLiveSettingsOpsRpcService().getDevFolder())

    expect(answer).toEqual({ ...stateBefore, leftBehind: { count: 0, folders: [] } })
    expect(warn).toHaveBeenCalledWith(
      '[dev-folder] could not count the projects left behind',
      expect.any(Error)
    )
  })

  it('still answers the folder when the bindings of the count cannot be made', async () => {
    fns.createLiveMoveQueryDeps.mockImplementation(() => {
      throw new Error('no file system here')
    })
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()
    const answer = await Effect.runPromise(makeLiveSettingsOpsRpcService().getDevFolder())

    expect(answer).toEqual({ ...stateBefore, leftBehind: { count: 0, folders: [] } })
    expect(fns.countLeftBehind).not.toHaveBeenCalled()
  })

  it('does not share the empty count between answers', async () => {
    fns.countLeftBehind.mockImplementation(() => {
      throw new Error('unreadable')
    })
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()
    const service = makeLiveSettingsOpsRpcService()
    const first = await Effect.runPromise(service.getDevFolder())
    first.leftBehind.folders.push('/changed/by/a/caller')
    first.leftBehind.count = 9
    const second = await Effect.runPromise(service.getDevFolder())
    expect(second.leftBehind).toEqual({ count: 0, folders: [] })
  })

  it('fails when the database cannot be opened: there is no folder to answer', async () => {
    const failure = new Error('the database is closed')
    fns.getDatabase.mockImplementation(() => {
      throw failure
    })
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()
    expect(await failureOf(makeLiveSettingsOpsRpcService().getDevFolder())).toBe(failure)
  })
})

describe('live settingsOps: setDevFolder', () => {
  it('changes the folder and answers the state as it is afterwards', async () => {
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()
    const answer = await Effect.runPromise(
      makeLiveSettingsOpsRpcService().setDevFolder({ path: '~/Dev' })
    )

    expect(fns.setDevFolder).toHaveBeenCalledTimes(1)
    expect(fns.setDevFolder).toHaveBeenCalledWith('~/Dev', setDeps)
    // Read after the change, never the state from before it.
    expect(answer).toEqual({ success: true, state: { ...stateAfter, leftBehind } })
    expect(fns.readDevFolderState.mock.invocationCallOrder[0]).toBeGreaterThan(
      fns.setDevFolder.mock.invocationCallOrder[0]
    )
    expect(fns.countLeftBehind.mock.invocationCallOrder[0]).toBeGreaterThan(
      fns.setDevFolder.mock.invocationCallOrder[0]
    )
  })

  it('hands null on: back to the default folder', async () => {
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()
    await Effect.runPromise(makeLiveSettingsOpsRpcService().setDevFolder({ path: null }))
    expect(fns.setDevFolder).toHaveBeenCalledWith(null, setDeps)
  })

  it("reserves the Claude config folder of the app's own environment variables too", async () => {
    vi.stubEnv('HIVE_DEV_FOLDER_TEST_MARKER', 'from the process')
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/from/the/process')
    settings.set(
      APP_SETTINGS_DB_KEY,
      JSON.stringify({
        environmentVariables: [{ key: 'CLAUDE_CONFIG_DIR', value: '/Volumes/Work/claude-config' }]
      })
    )
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()
    await Effect.runPromise(makeLiveSettingsOpsRpcService().setDevFolder({ path: '~/Dev' }))

    expect(fns.createLiveSetDevFolderDeps).toHaveBeenCalledTimes(1)
    const [handle, options] = fns.createLiveSetDevFolderDeps.mock.calls[0]
    expect(handle).toBe(db)
    // The app's variable wins over the process's, as it does for the agents the app starts.
    expect(options.env.CLAUDE_CONFIG_DIR).toBe('/Volumes/Work/claude-config')
    expect(options.env.HIVE_DEV_FOLDER_TEST_MARKER).toBe('from the process')
  })

  it('answers a refusal as it is and reads no state', async () => {
    fns.setDevFolder.mockReturnValue({
      success: false,
      error: 'The dev folder cannot be the top of a disk (/).'
    })
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()
    const answer = await Effect.runPromise(
      makeLiveSettingsOpsRpcService().setDevFolder({ path: '/' })
    )

    expect(answer).toEqual({
      success: false,
      error: 'The dev folder cannot be the top of a disk (/).'
    })
    expect(fns.readDevFolderState).not.toHaveBeenCalled()
    expect(fns.countLeftBehind).not.toHaveBeenCalled()
  })

  it('answers a sentence, not a failure, when the change could not be started', async () => {
    fns.createLiveSetDevFolderDeps.mockImplementation(() => {
      throw new Error('the projects could not be listed.')
    })
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()
    const answer = await Effect.runPromise(
      makeLiveSettingsOpsRpcService().setDevFolder({ path: '~/Dev' })
    )

    expect(answer).toEqual({
      success: false,
      error: 'The dev folder could not be changed: the projects could not be listed.'
    })
    expect(fns.setDevFolder).not.toHaveBeenCalled()
  })

  it('answers a sentence when the database cannot be opened', async () => {
    fns.getDatabase.mockImplementation(() => {
      throw new Error('the database is closed')
    })
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()
    const answer = await Effect.runPromise(
      makeLiveSettingsOpsRpcService().setDevFolder({ path: '~/Dev' })
    )
    expect(answer).toEqual({
      success: false,
      error: 'The dev folder could not be changed: the database is closed.'
    })
  })

  it('answers the changed folder with an empty count when the count fails', async () => {
    fns.countLeftBehind.mockImplementation(() => {
      throw new Error('unreadable')
    })
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()
    const answer = await Effect.runPromise(
      makeLiveSettingsOpsRpcService().setDevFolder({ path: '~/Dev' })
    )
    expect(answer).toEqual({
      success: true,
      state: { ...stateAfter, leftBehind: { count: 0, folders: [] } }
    })
  })
})

describe('live settingsOps: planDevFolderMove', () => {
  it('plans with the bindings made from what the window reports as running', async () => {
    const activity = { runningSessionIds: () => ['session-1'] }
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()
    const answer = await Effect.runPromise(
      makeLiveSettingsOpsRpcService({ activity }).planDevFolderMove()
    )

    expect(answer).toBe(plan)
    expect(fns.createLiveMoveProjectsDeps).toHaveBeenCalledTimes(1)
    expect(fns.createLiveMoveProjectsDeps.mock.calls[0][0].activity).toBe(activity)
    expect(fns.planDevFolderMove).toHaveBeenCalledWith(moveDeps)
  })

  it('says that nothing was reported when the service was made without a tracker', async () => {
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()
    await Effect.runPromise(makeLiveSettingsOpsRpcService().planDevFolderMove())
    expect(fns.createLiveMoveProjectsDeps).toHaveBeenCalledWith({ activity: null })
  })

  it('makes its bindings anew for every plan', async () => {
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()
    const service = makeLiveSettingsOpsRpcService()
    await Effect.runPromise(service.planDevFolderMove())
    await Effect.runPromise(service.planDevFolderMove())
    expect(fns.createLiveMoveProjectsDeps).toHaveBeenCalledTimes(2)
  })

  it('fails when the plan cannot be made', async () => {
    const failure = new Error('the projects could not be read')
    fns.planDevFolderMove.mockRejectedValue(failure)
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()
    expect(await failureOf(makeLiveSettingsOpsRpcService().planDevFolderMove())).toBe(failure)
  })

  /** The note a move leaves from its commit until its last step. */
  const owedNote = JSON.stringify({
    projectId: 'api',
    fromPath: '/Users/someone/hive-projects/api',
    fromRealPath: '/Users/someone/hive-projects/api',
    toPath: '/Users/someone/Dev/api',
    relocations: []
  })

  it('asks for no unfinished move to be finished when none is owed', async () => {
    const getSetting = vi.fn((_key: string): string | null => null)
    db.getSetting = getSetting
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()

    await Effect.runPromise(makeLiveSettingsOpsRpcService().planDevFolderMove())

    expect(getSetting).toHaveBeenCalledWith(DEV_FOLDER_PENDING_MOVE_KEY)
    expect(fns.resumePendingDevFolderMove).not.toHaveBeenCalled()
    expect(fns.planDevFolderMove).toHaveBeenCalledTimes(1)
  })

  it('finishes a move that did not get to its end before it makes the plan', async () => {
    settings.set(DEV_FOLDER_PENDING_MOVE_KEY, owedNote)
    const events: string[] = []
    const resume = deferred<void>()
    fns.resumePendingDevFolderMove.mockImplementation(async () => {
      events.push('unfinished move taken up')
      await resume.promise
      events.push('unfinished move dealt with')
    })
    fns.planDevFolderMove.mockImplementation(async () => {
      events.push('plan made')
      return plan
    })
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()

    const planning = Effect.runPromise(makeLiveSettingsOpsRpcService().planDevFolderMove())
    await settle()
    expect(events).toEqual(['unfinished move taken up'])
    expect(fns.resumePendingDevFolderMove).toHaveBeenCalledWith(moveDeps)

    resume.resolve()
    await expect(planning).resolves.toBe(plan)
    expect(events).toEqual(['unfinished move taken up', 'unfinished move dealt with', 'plan made'])
    expect(fns.planDevFolderMove).toHaveBeenCalledWith(moveDeps)
  })

  it('takes that up in its turn: never while the move that left the note is still running', async () => {
    const events: string[] = []
    const gate = deferred<void>()
    fns.moveProjectToDevFolder.mockImplementation(async (params: { projectId: string }) => {
      events.push('move started')
      // As the move's commit does, and as its last step does.
      settings.set(DEV_FOLDER_PENDING_MOVE_KEY, owedNote)
      await gate.promise
      settings.delete(DEV_FOLDER_PENDING_MOVE_KEY)
      events.push('move finished')
      return movedResult(params.projectId)
    })
    fns.resumePendingDevFolderMove.mockImplementation(async () => {
      events.push('unfinished move looked for')
    })
    fns.planDevFolderMove.mockImplementation(async () => {
      events.push('plan made')
      return plan
    })
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()
    const service = makeLiveSettingsOpsRpcService()

    const move = Effect.runPromise(
      service.moveProjectToDevFolder({ projectId: 'api', expectedToPath: '/Users/someone/Dev/api' })
    )
    await settle()
    const planning = Effect.runPromise(service.planDevFolderMove())
    await settle()
    // The steps of the running move are not started a second time next to it.
    expect(events).toEqual(['move started'])

    gate.resolve()
    await move
    await expect(planning).resolves.toBe(plan)
    expect(events).toEqual([
      'move started',
      'move finished',
      'unfinished move looked for',
      'plan made'
    ])
  })

  it('lets a change of the folder that was asked for first go first', async () => {
    settings.set(DEV_FOLDER_PENDING_MOVE_KEY, owedNote)
    const events: string[] = []
    fns.setDevFolder.mockImplementation(() => {
      events.push('folder changed')
      currentState = stateAfter
      return { success: true }
    })
    fns.resumePendingDevFolderMove.mockImplementation(async () => {
      events.push('unfinished move taken up')
    })
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()
    const service = makeLiveSettingsOpsRpcService()

    const change = Effect.runPromise(service.setDevFolder({ path: '~/Dev' }))
    const planning = Effect.runPromise(service.planDevFolderMove())
    await Promise.all([change, planning])

    expect(events).toEqual(['folder changed', 'unfinished move taken up'])
  })

  it('makes the plan all the same when the settings row cannot be read', async () => {
    db.getSetting = () => {
      throw new Error('the settings table is locked')
    }
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()

    await expect(
      Effect.runPromise(makeLiveSettingsOpsRpcService().planDevFolderMove())
    ).resolves.toBe(plan)
    expect(fns.resumePendingDevFolderMove).not.toHaveBeenCalled()
  })
})

describe('live settingsOps: moveProjectToDevFolder', () => {
  const params = { projectId: 'api', expectedToPath: '/Users/someone/Dev/api' }

  it('moves the project with the live bindings and answers the result', async () => {
    const activity = { runningSessionIds: () => [] }
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()
    const answer = await Effect.runPromise(
      makeLiveSettingsOpsRpcService({ activity }).moveProjectToDevFolder(params)
    )

    expect(answer).toEqual(movedResult('api'))
    expect(fns.createLiveMoveProjectsDeps.mock.calls[0][0].activity).toBe(activity)
    expect(fns.moveProjectToDevFolder).toHaveBeenCalledTimes(1)
    expect(fns.moveProjectToDevFolder).toHaveBeenCalledWith(params, moveDeps)
  })

  it('answers "not moved" when the move could not be started at all', async () => {
    fns.createLiveMoveProjectsDeps.mockRejectedValue(new Error('git is not installed.'))
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()
    const answer = await Effect.runPromise(
      makeLiveSettingsOpsRpcService().moveProjectToDevFolder(params)
    )

    expect(answer).toEqual({
      projectId: 'api',
      projectName: 'API',
      action: 'failed',
      fromPath: '/Users/someone/hive-projects/api',
      toPath: null,
      skipReason: null,
      detail: 'This project was not moved: git is not installed. It is still in its old folder.',
      warnings: [],
      movedPaths: []
    })
    expect(fns.moveProjectToDevFolder).not.toHaveBeenCalled()
  })

  it('answers "not moved" for a project it cannot name', async () => {
    fns.createLiveMoveProjectsDeps.mockRejectedValue(new Error('git is not installed'))
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()
    const answer = await Effect.runPromise(
      makeLiveSettingsOpsRpcService().moveProjectToDevFolder({
        projectId: 'gone',
        expectedToPath: '/Users/someone/Dev/gone'
      })
    )
    expect(answer).toMatchObject({
      projectId: 'gone',
      projectName: '',
      action: 'failed',
      fromPath: '',
      movedPaths: []
    })
  })

  it('does not call a move that broke part-way "not moved"', async () => {
    // The move service answers for itself once it has started. If it ever rejected, the folder
    // may already be in its new place, and the call must fail instead of saying where it is.
    const failure = new Error('broke after the folder was renamed')
    fns.moveProjectToDevFolder.mockRejectedValue(failure)
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()
    expect(await failureOf(makeLiveSettingsOpsRpcService().moveProjectToDevFolder(params))).toBe(
      failure
    )
  })
})

describe('live settingsOps: one dev folder change at a time', () => {
  it('runs a move, a change of the folder and another move in the order they were asked for', async () => {
    const events: string[] = []
    const firstMove = deferred<DevFolderMoveResult>()
    fns.createLiveMoveProjectsDeps.mockImplementation(async () => {
      events.push('bindings made')
      return moveDeps
    })
    fns.moveProjectToDevFolder.mockImplementation(async (params: { projectId: string }) => {
      events.push(`move ${params.projectId} started`)
      const result =
        params.projectId === 'api' ? await firstMove.promise : movedResult(params.projectId)
      events.push(`move ${params.projectId} finished`)
      return result
    })
    fns.setDevFolder.mockImplementation(() => {
      events.push('folder changed')
      currentState = stateAfter
      return { success: true }
    })
    fns.readDevFolderState.mockImplementation(() => {
      events.push('state read')
      return currentState
    })
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()
    const service = makeLiveSettingsOpsRpcService()

    const first = Effect.runPromise(
      service.moveProjectToDevFolder({ projectId: 'api', expectedToPath: '/Users/someone/Dev/api' })
    )
    const change = Effect.runPromise(service.setDevFolder({ path: '~/Dev' }))
    const second = Effect.runPromise(
      service.moveProjectToDevFolder({ projectId: 'web', expectedToPath: '/Users/someone/Dev/web' })
    )

    await settle()
    // The first move is under way; nothing of the two calls behind it has run.
    expect(events).toEqual(['bindings made', 'move api started'])
    expect(fns.createLiveSetDevFolderDeps).not.toHaveBeenCalled()

    firstMove.resolve(movedResult('api'))
    await expect(first).resolves.toEqual(movedResult('api'))
    await expect(change).resolves.toEqual({
      success: true,
      state: { ...stateAfter, leftBehind }
    })
    await expect(second).resolves.toEqual(movedResult('web'))
    expect(events).toEqual([
      'bindings made',
      'move api started',
      'move api finished',
      'folder changed',
      'state read',
      'bindings made',
      'move web started',
      'move web finished'
    ])
  })

  it('keeps two overlapping moves apart', async () => {
    const running: string[] = []
    let mostAtOnce = 0
    const gates = new Map<string, Deferred<void>>([
      ['api', deferred<void>()],
      ['web', deferred<void>()]
    ])
    fns.moveProjectToDevFolder.mockImplementation(async (params: { projectId: string }) => {
      running.push(params.projectId)
      mostAtOnce = Math.max(mostAtOnce, running.length)
      await gates.get(params.projectId)?.promise
      running.splice(running.indexOf(params.projectId), 1)
      return movedResult(params.projectId)
    })
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()
    const service = makeLiveSettingsOpsRpcService()

    const first = Effect.runPromise(
      service.moveProjectToDevFolder({ projectId: 'api', expectedToPath: '/Users/someone/Dev/api' })
    )
    const second = Effect.runPromise(
      service.moveProjectToDevFolder({ projectId: 'web', expectedToPath: '/Users/someone/Dev/web' })
    )
    await settle()
    expect(running).toEqual(['api'])

    // Letting the second one go changes nothing while the first is still running.
    gates.get('web')?.resolve()
    await settle()
    expect(running).toEqual(['api'])

    gates.get('api')?.resolve()
    await Promise.all([first, second])
    expect(mostAtOnce).toBe(1)
    expect(fns.moveProjectToDevFolder.mock.calls.map(([params]) => params.projectId)).toEqual([
      'api',
      'web'
    ])
  })

  it('goes on with the next call after one that failed', async () => {
    fns.moveProjectToDevFolder.mockRejectedValueOnce(new Error('broke'))
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()
    const service = makeLiveSettingsOpsRpcService()

    const first = failureOf(
      service.moveProjectToDevFolder({ projectId: 'api', expectedToPath: '/Users/someone/Dev/api' })
    )
    const change = Effect.runPromise(service.setDevFolder({ path: '~/Dev' }))

    expect(await first).toBeInstanceOf(Error)
    await expect(change).resolves.toMatchObject({ success: true })
  })

  it('does not make a plan or a reading of the folder wait for a move', async () => {
    const gate = deferred<void>()
    fns.moveProjectToDevFolder.mockImplementation(async (params: { projectId: string }) => {
      await gate.promise
      return movedResult(params.projectId)
    })
    const { makeLiveSettingsOpsRpcService } = await loadSettingsOps()
    const service = makeLiveSettingsOpsRpcService()

    const move = Effect.runPromise(
      service.moveProjectToDevFolder({ projectId: 'api', expectedToPath: '/Users/someone/Dev/api' })
    )
    await settle()
    // Both only read: the window may ask for them while a move is running. (A plan waits its
    // turn only when it finds the note that a move's follow-up steps are owed.)
    await expect(Effect.runPromise(service.getDevFolder())).resolves.toMatchObject({
      path: stateBefore.path
    })
    await expect(Effect.runPromise(service.planDevFolderMove())).resolves.toBe(plan)

    gate.resolve()
    await move
  })
})

describe('finishInterruptedDevFolderMove (server start)', () => {
  const pending = JSON.stringify({
    projectId: 'api',
    fromPath: '/Users/someone/hive-projects/api',
    fromRealPath: '/Users/someone/hive-projects/api',
    toPath: '/Users/someone/Dev/api',
    relocations: []
  })

  it('reads one settings row and loads nothing when no move is owed', async () => {
    forgetLoadedDevFolderModules()
    const getSetting = vi.fn((_key: string): string | null => null)
    db.getSetting = getSetting
    const { finishInterruptedDevFolderMove } = await loadSettingsOps()

    await finishInterruptedDevFolderMove({ activity: { runningSessionIds: () => [] } })

    expect(getSetting).toHaveBeenCalledTimes(1)
    expect(getSetting).toHaveBeenCalledWith(DEV_FOLDER_PENDING_MOVE_KEY)
    expect(mocks.loaded).toEqual([])
    expect(fns.createLiveMoveProjectsDeps).not.toHaveBeenCalled()
    expect(fns.resumePendingDevFolderMove).not.toHaveBeenCalled()
  })

  it('loads the move service only once a move is owed', async () => {
    forgetLoadedDevFolderModules()
    settings.set(DEV_FOLDER_PENDING_MOVE_KEY, pending)
    const { finishInterruptedDevFolderMove } = await loadSettingsOps()
    expect(mocks.loaded).toEqual([])

    await finishInterruptedDevFolderMove()

    expect([...mocks.loaded].sort()).toEqual(['live-deps', 'move-projects'])
  })

  it('finishes the move with the live bindings before it resolves', async () => {
    settings.set(DEV_FOLDER_PENDING_MOVE_KEY, pending)
    const activity = { runningSessionIds: () => ['session-1'] }
    const resume = deferred<void>()
    fns.resumePendingDevFolderMove.mockReturnValue(resume.promise)
    const { finishInterruptedDevFolderMove } = await loadSettingsOps()

    let resolved = false
    const finishing = finishInterruptedDevFolderMove({ activity }).then(() => {
      resolved = true
    })
    await settle()
    expect(fns.resumePendingDevFolderMove).toHaveBeenCalledTimes(1)
    expect(fns.resumePendingDevFolderMove).toHaveBeenCalledWith(moveDeps)
    expect(fns.createLiveMoveProjectsDeps.mock.calls[0][0].activity).toBe(activity)
    // The server is not serving yet.
    expect(resolved).toBe(false)

    resume.resolve()
    await finishing
    expect(resolved).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  it('makes a change of the folder wait until the move is finished', async () => {
    settings.set(DEV_FOLDER_PENDING_MOVE_KEY, pending)
    const resume = deferred<void>()
    fns.resumePendingDevFolderMove.mockReturnValue(resume.promise)
    const { finishInterruptedDevFolderMove, makeLiveSettingsOpsRpcService } =
      await loadSettingsOps()

    const finishing = finishInterruptedDevFolderMove()
    const change = Effect.runPromise(
      makeLiveSettingsOpsRpcService().setDevFolder({ path: '~/Dev' })
    )
    await settle()
    expect(fns.resumePendingDevFolderMove).toHaveBeenCalledTimes(1)
    expect(fns.setDevFolder).not.toHaveBeenCalled()

    resume.resolve()
    await finishing
    await expect(change).resolves.toMatchObject({ success: true })
    expect(fns.setDevFolder).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'the move service rejects',
      () => fns.resumePendingDevFolderMove.mockRejectedValue(new Error('git failed'))
    ],
    [
      'the live bindings cannot be made',
      () => fns.createLiveMoveProjectsDeps.mockRejectedValue(new Error('no terminals'))
    ]
  ])('logs and lets the server start when %s', async (_name, arrange) => {
    settings.set(DEV_FOLDER_PENDING_MOVE_KEY, pending)
    arrange()
    const { finishInterruptedDevFolderMove } = await loadSettingsOps()

    await expect(finishInterruptedDevFolderMove()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(
      '[dev-folder] could not finish the move that a quit interrupted',
      expect.any(Error)
    )
  })

  it.each([
    [
      'the settings row cannot be read',
      () => {
        db.getSetting = () => {
          throw new Error('the settings table is locked')
        }
      }
    ],
    [
      'the database cannot be opened',
      () =>
        fns.getDatabase.mockImplementation(() => {
          throw new Error('the database is closed')
        })
    ]
  ])('logs and lets the server start when %s', async (_name, arrange) => {
    arrange()
    const { finishInterruptedDevFolderMove } = await loadSettingsOps()

    await expect(finishInterruptedDevFolderMove()).resolves.toBeUndefined()
    expect(fns.resumePendingDevFolderMove).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      '[dev-folder] could not check for a move that a quit interrupted',
      expect.any(Error)
    )
  })

  it('stops waiting for a move that takes too long, and the move still finishes first in line', async () => {
    settings.set(DEV_FOLDER_PENDING_MOVE_KEY, pending)
    const resume = deferred<void>()
    fns.resumePendingDevFolderMove.mockReturnValue(resume.promise)
    const { finishInterruptedDevFolderMove, makeLiveSettingsOpsRpcService } =
      await loadSettingsOps()

    await finishInterruptedDevFolderMove({}, { waitMs: 20 })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('the server starts without waiting for it')
    )
    expect(fns.resumePendingDevFolderMove).toHaveBeenCalledTimes(1)

    // The server is serving now. A change of the folder still waits for the move.
    const change = Effect.runPromise(
      makeLiveSettingsOpsRpcService().setDevFolder({ path: '~/Dev' })
    )
    await settle()
    expect(fns.setDevFolder).not.toHaveBeenCalled()

    resume.resolve()
    await expect(change).resolves.toMatchObject({ success: true })
  })

  // A Node timer cannot hold a delay of 2^31 ms or more: it fires after 1 ms instead.
  it.each([[Infinity], [2 ** 31]])(
    'waits for as long as it takes when the wait is %d ms',
    async (waitMs) => {
      settings.set(DEV_FOLDER_PENDING_MOVE_KEY, pending)
      const resume = deferred<void>()
      fns.resumePendingDevFolderMove.mockReturnValue(resume.promise)
      const { finishInterruptedDevFolderMove } = await loadSettingsOps()

      let resolved = false
      const finishing = finishInterruptedDevFolderMove({}, { waitMs }).then(() => {
        resolved = true
      })
      await settle()
      expect(resolved).toBe(false)

      resume.resolve()
      await finishing
      expect(warn).not.toHaveBeenCalled()
    }
  )

  it('leaves no timer behind when the move finishes in time', async () => {
    vi.useFakeTimers()
    try {
      settings.set(DEV_FOLDER_PENDING_MOVE_KEY, pending)
      const { finishInterruptedDevFolderMove } = await loadSettingsOps()
      await finishInterruptedDevFolderMove()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
