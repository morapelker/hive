// The four dev folder calls of the settingsOps domain, with an injected service: method
// names, parameter validation and results handed through unchanged; and the window's report
// of its running sessions. The live service has its own file
// (settings-ops-dev-folder-live.test.ts), because it needs the dev folder modules mocked.
import { Cause, Effect, Exit, Option } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  DEV_FOLDER_RPC,
  type DevFolderMovePlan,
  type DevFolderMoveResult,
  type DevFolderState,
  type SetDevFolderResult
} from '../../../../shared/types/dev-folder'
import { RUNNING_SESSIONS_REPORT_RPC } from '../../../../shared/session-running-state'
import { makeEventBus } from '../../../events/event-bus'
import { makeRpcRouter, type RpcCallInfo, type RpcContext } from '../../router'
import { runWithRpcRequestContext, type AuthPrincipal } from '../../request-context'
import { RpcRouteError } from '../../../../shared/rpc/errors'
import { makeSettingsOpsRpcHandlers, type SettingsOpsRpcService } from '../settings-ops'

const state: DevFolderState = {
  path: '/Users/someone/Dev',
  isDefault: false,
  defaultPath: '/Users/someone/hive-projects',
  exists: true,
  previousPaths: ['/Users/someone/hive-projects'],
  leftBehind: { count: 2, folders: ['/Users/someone/hive-projects'] }
}

const plan: DevFolderMovePlan = {
  devFolder: '/Users/someone/Dev',
  sources: ['/Users/someone/hive-projects'],
  candidates: [
    {
      projectId: 'project-1',
      projectName: 'api',
      source: '/Users/someone/hive-projects',
      fromPath: '/Users/someone/hive-projects/api',
      toPath: '/Users/someone/Dev/api',
      skipReason: null,
      detail: null
    },
    {
      projectId: 'project-2',
      projectName: 'web',
      source: '/Users/someone/hive-projects',
      fromPath: '/Users/someone/hive-projects/web',
      toPath: '/Users/someone/Dev/web',
      skipReason: 'exists',
      detail: 'The dev folder already has a folder named web.'
    }
  ]
}

const moved: DevFolderMoveResult = {
  projectId: 'project-1',
  projectName: 'api',
  action: 'moved',
  fromPath: '/Users/someone/hive-projects/api',
  toPath: '/Users/someone/Dev/api',
  skipReason: null,
  detail: null,
  warnings: ['The worktree "fix" could not be re-linked.'],
  movedPaths: [{ from: '/Users/someone/hive-projects/api', to: '/Users/someone/Dev/api' }]
}

const skipped: DevFolderMoveResult = {
  projectId: 'project-2',
  projectName: 'web',
  action: 'skipped',
  fromPath: '/Users/someone/hive-projects/web',
  toPath: '/Users/someone/Dev/web',
  skipReason: 'busy',
  detail: 'A terminal in this project is running a command. Stop it, then check again.',
  warnings: [],
  movedPaths: []
}

const moveParams = { projectId: 'project-1', expectedToPath: '/Users/someone/Dev/api' }

/** A service with the four dev folder calls only: the handlers under test use nothing else. */
const makeFakeService = (
  answers: {
    readonly set?: SetDevFolderResult
    readonly move?: DevFolderMoveResult
  } = {}
) => {
  const getDevFolder = vi.fn(() => Effect.succeed(state))
  const setDevFolder = vi.fn((_params: { readonly path: string | null }) =>
    Effect.succeed<SetDevFolderResult>(answers.set ?? { success: true, state })
  )
  const planDevFolderMove = vi.fn(() => Effect.succeed(plan))
  const moveProjectToDevFolder = vi.fn(
    (_params: { readonly projectId: string; readonly expectedToPath: string }) =>
      Effect.succeed(answers.move ?? moved)
  )
  const reportRunningSessions = vi.fn(
    (_params: { readonly sessionIds: readonly string[] }, _socketId: string | null) =>
      Effect.succeed({ ok: true as const })
  )
  const service = {
    getDevFolder,
    setDevFolder,
    planDevFolderMove,
    moveProjectToDevFolder,
    reportRunningSessions
  } as unknown as SettingsOpsRpcService
  return {
    service,
    getDevFolder,
    setDevFolder,
    planDevFolderMove,
    moveProjectToDevFolder,
    reportRunningSessions
  }
}

type FakeService = ReturnType<typeof makeFakeService>

const context: RpcContext = { eventBus: makeEventBus() }

const call = (fake: FakeService, method: string, params: unknown, info?: RpcCallInfo) => {
  const handler = makeSettingsOpsRpcHandlers(fake.service).get(method)
  if (!handler) throw new Error(`No handler is registered for ${method}`)
  return handler(params, context, info)
}

/** What a handler failed with, or null when it answered. */
const failureOf = async (effect: Effect.Effect<unknown, unknown, never>): Promise<unknown> => {
  const exit = await Effect.runPromiseExit(effect)
  return Exit.isFailure(exit) ? Option.getOrNull(Cause.failureOption(exit.cause)) : null
}

const calledTimes = (fake: FakeService): number =>
  fake.getDevFolder.mock.calls.length +
  fake.setDevFolder.mock.calls.length +
  fake.planDevFolderMove.mock.calls.length +
  fake.moveProjectToDevFolder.mock.calls.length

/** Each call with parameters its handler accepts. */
const validCalls: readonly (readonly [string, unknown])[] = [
  [DEV_FOLDER_RPC.get, {}],
  [DEV_FOLDER_RPC.set, { path: '/Users/someone/Dev' }],
  [DEV_FOLDER_RPC.planMove, {}],
  [DEV_FOLDER_RPC.moveProject, moveParams]
]

describe('settingsOps dev folder handlers', () => {
  it('registers the four calls under the names the window uses', () => {
    const handlers = makeSettingsOpsRpcHandlers(makeFakeService().service)
    expect(DEV_FOLDER_RPC).toEqual({
      get: 'settingsOps.getDevFolder',
      set: 'settingsOps.setDevFolder',
      planMove: 'settingsOps.planDevFolderMove',
      moveProject: 'settingsOps.moveProjectToDevFolder'
    })
    for (const method of Object.values(DEV_FOLDER_RPC)) {
      expect(handlers.has(method), method).toBe(true)
    }
    // Nothing else about the dev folder is callable.
    expect([...handlers.keys()].filter((method) => /devfolder/i.test(method)).sort()).toEqual(
      Object.values(DEV_FOLDER_RPC).sort()
    )
  })

  describe('getDevFolder', () => {
    it.each([[{}], [undefined], [null]])('answers the state for params %j', async (params) => {
      const fake = makeFakeService()
      await expect(Effect.runPromise(call(fake, DEV_FOLDER_RPC.get, params))).resolves.toBe(state)
      expect(fake.getDevFolder).toHaveBeenCalledTimes(1)
      expect(fake.getDevFolder).toHaveBeenCalledWith()
    })

    it.each([[{ unexpected: true }], [{ path: '/x' }], ['text'], [[]], [0]])(
      'refuses params %j without asking the service',
      async (params) => {
        const fake = makeFakeService()
        expect(await failureOf(call(fake, DEV_FOLDER_RPC.get, params))).toBeInstanceOf(z.ZodError)
        expect(calledTimes(fake)).toBe(0)
      }
    )
  })

  describe('setDevFolder', () => {
    it('hands a folder to the service and answers its result', async () => {
      const fake = makeFakeService()
      const answer = await Effect.runPromise(
        call(fake, DEV_FOLDER_RPC.set, { path: '~/Dev Folder' })
      )
      expect(answer).toEqual({ success: true, state })
      expect(fake.setDevFolder).toHaveBeenCalledTimes(1)
      expect(fake.setDevFolder).toHaveBeenCalledWith({ path: '~/Dev Folder' })
    })

    it('hands null to the service: back to the default folder', async () => {
      const fake = makeFakeService()
      await Effect.runPromise(call(fake, DEV_FOLDER_RPC.set, { path: null }))
      expect(fake.setDevFolder).toHaveBeenCalledWith({ path: null })
    })

    it('answers a refusal as it is', async () => {
      const refusal: SetDevFolderResult = {
        success: false,
        error:
          'The dev folder cannot be your home folder: choose a folder inside it, such as ~/Dev.'
      }
      const fake = makeFakeService({ set: refusal })
      await expect(Effect.runPromise(call(fake, DEV_FOLDER_RPC.set, { path: '~' }))).resolves.toBe(
        refusal
      )
    })

    it('does not trim or otherwise change the path: a folder name may end in a space', async () => {
      const fake = makeFakeService()
      await Effect.runPromise(call(fake, DEV_FOLDER_RPC.set, { path: ' /Volumes/Work/Dev ' }))
      expect(fake.setDevFolder).toHaveBeenCalledWith({ path: ' /Volumes/Work/Dev ' })
    })

    it('accepts a path of 4096 characters and refuses one of 4097', async () => {
      const fake = makeFakeService()
      const longest = `/${'a'.repeat(4095)}`
      await Effect.runPromise(call(fake, DEV_FOLDER_RPC.set, { path: longest }))
      expect(fake.setDevFolder).toHaveBeenCalledWith({ path: longest })
      expect(
        await failureOf(call(fake, DEV_FOLDER_RPC.set, { path: `${longest}a` }))
      ).toBeInstanceOf(z.ZodError)
      expect(fake.setDevFolder).toHaveBeenCalledTimes(1)
    })

    it.each([
      ['no path', {}],
      ['an empty path', { path: '' }],
      ['a number', { path: 5 }],
      ['a list', { path: ['/x'] }],
      ['an undefined path', { path: undefined }],
      ['an extra key', { path: '/x', force: true }],
      ['an extra key beside null', { path: null, previousPaths: [] }],
      ['a bare string', '/x'],
      ['no params', undefined],
      ['null params', null]
    ])('refuses %s without asking the service', async (_name, params) => {
      const fake = makeFakeService()
      expect(await failureOf(call(fake, DEV_FOLDER_RPC.set, params))).toBeInstanceOf(z.ZodError)
      expect(calledTimes(fake)).toBe(0)
    })
  })

  describe('planDevFolderMove', () => {
    it.each([[{}], [undefined], [null]])('answers the plan for params %j', async (params) => {
      const fake = makeFakeService()
      await expect(Effect.runPromise(call(fake, DEV_FOLDER_RPC.planMove, params))).resolves.toBe(
        plan
      )
      expect(fake.planDevFolderMove).toHaveBeenCalledTimes(1)
      expect(fake.planDevFolderMove).toHaveBeenCalledWith()
    })

    it.each([[{ unexpected: true }], [{ projectId: 'project-1' }], ['text'], [[]]])(
      'refuses params %j without asking the service',
      async (params) => {
        const fake = makeFakeService()
        expect(await failureOf(call(fake, DEV_FOLDER_RPC.planMove, params))).toBeInstanceOf(
          z.ZodError
        )
        expect(calledTimes(fake)).toBe(0)
      }
    )
  })

  describe('moveProjectToDevFolder', () => {
    it('hands the project and the confirmed destination to the service', async () => {
      const fake = makeFakeService()
      const answer = await Effect.runPromise(call(fake, DEV_FOLDER_RPC.moveProject, moveParams))
      expect(answer).toBe(moved)
      expect(fake.moveProjectToDevFolder).toHaveBeenCalledTimes(1)
      expect(fake.moveProjectToDevFolder).toHaveBeenCalledWith(moveParams)
    })

    it('answers a project that stayed as it is', async () => {
      const fake = makeFakeService({ move: skipped })
      await expect(
        Effect.runPromise(
          call(fake, DEV_FOLDER_RPC.moveProject, {
            projectId: 'project-2',
            expectedToPath: '/Users/someone/Dev/web'
          })
        )
      ).resolves.toBe(skipped)
    })

    it.each([
      ['no project', { expectedToPath: '/Users/someone/Dev/api' }],
      ['no destination', { projectId: 'project-1' }],
      ['an empty project id', { projectId: '', expectedToPath: '/Users/someone/Dev/api' }],
      ['an empty destination', { projectId: 'project-1', expectedToPath: '' }],
      ['a null destination', { projectId: 'project-1', expectedToPath: null }],
      ['a numeric project id', { projectId: 1, expectedToPath: '/Users/someone/Dev/api' }],
      ['an extra key', { ...moveParams, force: true }],
      ['a destination under another name', { projectId: 'project-1', toPath: '/x' }],
      ['an empty object', {}],
      ['no params', undefined],
      ['null params', null]
    ])('refuses %s without asking the service', async (_name, params) => {
      const fake = makeFakeService()
      expect(await failureOf(call(fake, DEV_FOLDER_RPC.moveProject, params))).toBeInstanceOf(
        z.ZodError
      )
      expect(calledTimes(fake)).toBe(0)
    })
  })

  it('passes a failure of the service on', async () => {
    const failure = new Error('the database is closed')
    const fake = makeFakeService()
    fake.getDevFolder.mockReturnValueOnce(Effect.fail(failure) as never)
    expect(await failureOf(call(fake, DEV_FOLDER_RPC.get, {}))).toBe(failure)
  })
})

describe('settingsOps dev folder calls are for this Mac only', () => {
  // The check reads the request context the socket server sets for each call, not the
  // `ctx` argument of `router.handle`.
  const asPrincipal = <T>(principal: AuthPrincipal | null, run: () => T): T =>
    runWithRpcRequestContext({ clientId: 'client-1', principal }, run)
  const device: AuthPrincipal = { kind: 'device', deviceId: 'd1', name: 'Phone', scope: 'viewer' }

  it.each(validCalls)('refuses %s from a device', async (method, params) => {
    const fake = makeFakeService()
    const failure = await asPrincipal(device, () => failureOf(call(fake, method, params)))
    expect(failure).toBeInstanceOf(RpcRouteError)
    expect(failure).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Not available from a remote device'
    })
    expect(calledTimes(fake)).toBe(0)
  })

  it.each(validCalls)('answers %s for the desktop window and with no request context', async (method, params) => {
    const fake = makeFakeService()
    await asPrincipal({ kind: 'desktop' }, () => Effect.runPromise(call(fake, method, params)))
    await Effect.runPromise(call(fake, method, params))
    expect(calledTimes(fake)).toBe(2)
  })
})

describe('settingsOps dev folder calls through the router', () => {
  const makeRouter = (fake: FakeService) =>
    makeRpcRouter({
      eventBus: makeEventBus(),
      settingsOps: fake.service
    })

  it('answers each call with what the service answered', async () => {
    const fake = makeFakeService()
    const router = makeRouter(fake)
    const answers = [state, { success: true, state }, plan, moved]
    for (const [index, [method, params]] of validCalls.entries()) {
      const response = await Effect.runPromise(
        router.handle({ id: `call-${index}`, method, params })
      )
      expect(response, method).toEqual({ id: `call-${index}`, ok: true, value: answers[index] })
    }
    expect(calledTimes(fake)).toBe(4)
  })

  it.each([
    [DEV_FOLDER_RPC.get, { unexpected: true }],
    [DEV_FOLDER_RPC.set, { path: '' }],
    [DEV_FOLDER_RPC.set, { path: '/x', extra: 1 }],
    [DEV_FOLDER_RPC.planMove, { unexpected: true }],
    [DEV_FOLDER_RPC.moveProject, { projectId: 'project-1' }],
    [DEV_FOLDER_RPC.moveProject, { ...moveParams, extra: 1 }]
  ])('answers VALIDATION_FAILED for %s with %j', async (method, params) => {
    const fake = makeFakeService()
    const response = await Effect.runPromise(
      makeRouter(fake).handle({ id: 'call-1', method, params })
    )
    expect(response).toMatchObject({
      id: 'call-1',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
    expect(calledTimes(fake)).toBe(0)
  })
})

describe('settingsOps.reportRunningSessions', () => {
  it('is registered under the name the window uses', () => {
    expect(RUNNING_SESSIONS_REPORT_RPC).toBe('settingsOps.reportRunningSessions')
    expect(
      makeSettingsOpsRpcHandlers(makeFakeService().service).has(RUNNING_SESSIONS_REPORT_RPC)
    ).toBe(true)
  })

  it('hands the set to the service with the socket it came through', async () => {
    const fake = makeFakeService()
    const answer = await Effect.runPromise(
      call(
        fake,
        RUNNING_SESSIONS_REPORT_RPC,
        { sessionIds: ['s1', 's2'] },
        { socketId: 'socket-1' }
      )
    )
    expect(answer).toEqual({ ok: true })
    expect(fake.reportRunningSessions).toHaveBeenCalledTimes(1)
    expect(fake.reportRunningSessions).toHaveBeenCalledWith(
      { sessionIds: ['s1', 's2'] },
      'socket-1'
    )
  })

  it('takes an empty set, and a call that came through no socket', async () => {
    const fake = makeFakeService()
    await Effect.runPromise(call(fake, RUNNING_SESSIONS_REPORT_RPC, { sessionIds: [] }))
    expect(fake.reportRunningSessions).toHaveBeenCalledWith({ sessionIds: [] }, null)
  })

  it('accepts 500 sessions and refuses 501', async () => {
    const fake = makeFakeService()
    const ids = Array.from({ length: 501 }, (_, index) => `s${index}`)
    await Effect.runPromise(
      call(fake, RUNNING_SESSIONS_REPORT_RPC, { sessionIds: ids.slice(0, 500) })
    )
    expect(fake.reportRunningSessions).toHaveBeenCalledTimes(1)
    expect(
      await failureOf(call(fake, RUNNING_SESSIONS_REPORT_RPC, { sessionIds: ids }))
    ).toBeInstanceOf(z.ZodError)
    expect(fake.reportRunningSessions).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['no set', {}],
    ['a set that is not a list', { sessionIds: 's1' }],
    ['an empty id', { sessionIds: [''] }],
    ['a numeric id', { sessionIds: [1] }],
    ['an extra key', { sessionIds: [], waiting: true }],
    ['no params', undefined],
    ['null params', null]
  ])('refuses %s without asking the service', async (_name, params) => {
    const fake = makeFakeService()
    expect(await failureOf(call(fake, RUNNING_SESSIONS_REPORT_RPC, params))).toBeInstanceOf(
      z.ZodError
    )
    expect(fake.reportRunningSessions).not.toHaveBeenCalled()
  })

  it('reaches the handler through the router with the socket of the call', async () => {
    const fake = makeFakeService()
    const router = makeRpcRouter({ eventBus: makeEventBus(), settingsOps: fake.service })
    const response = await Effect.runPromise(
      router.handle(
        { id: 'call-1', method: RUNNING_SESSIONS_REPORT_RPC, params: { sessionIds: ['s1'] } },
        { socketId: 'socket-9' }
      )
    )
    expect(response).toEqual({ id: 'call-1', ok: true, value: { ok: true } })
    expect(fake.reportRunningSessions).toHaveBeenCalledWith({ sessionIds: ['s1'] }, 'socket-9')
  })
})
