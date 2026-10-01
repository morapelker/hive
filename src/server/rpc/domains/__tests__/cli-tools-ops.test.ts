import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import type { CliToolActionResult, CliToolsListing } from '../../../../shared/types/cli-tools'
import { makeEventBus } from '../../../events/event-bus'
import { makeRpcRouter } from '../../router'
import {
  makeCliToolsOpsRpcHandlers,
  makeLiveCliToolsOpsRpcService,
  type CliToolsOpsRpcService
} from '../cli-tools-ops'

const installerMocks = vi.hoisted(() => ({
  listCliTools: vi.fn(),
  installCliTool: vi.fn(),
  installCliSkill: vi.fn()
}))

vi.mock('../../../../main/services/cli-tools/tool-installers', () => installerMocks)

const listing: CliToolsListing = { tools: [] }
const actionResult: CliToolActionResult = { success: true }

const makeService = (): CliToolsOpsRpcService & {
  list: ReturnType<typeof vi.fn>
  install: ReturnType<typeof vi.fn>
  installSkill: ReturnType<typeof vi.fn>
} => ({
  list: vi.fn(() => Effect.succeed(listing)),
  install: vi.fn(() => Effect.succeed(actionResult)),
  installSkill: vi.fn(() => Effect.succeed(actionResult))
})

describe('cliToolsOps RPC handlers', () => {
  it('registers the three methods', () => {
    const handlers = makeCliToolsOpsRpcHandlers(makeService())
    expect([...handlers.keys()].sort()).toEqual([
      'cliToolsOps.install',
      'cliToolsOps.installSkill',
      'cliToolsOps.list'
    ])
  })

  it('routes cliToolsOps.list to the service', async () => {
    const service = makeService()
    const router = makeRpcRouter({ eventBus: makeEventBus(), cliToolsOps: service })

    const response = await Effect.runPromise(
      router.handle({ id: '1', method: 'cliToolsOps.list', params: { path: '/repo' } })
    )

    expect(service.list).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({ id: '1', ok: true, value: listing })
  })

  it('routes install and installSkill with the tool id and project path', async () => {
    const service = makeService()
    const router = makeRpcRouter({ eventBus: makeEventBus(), cliToolsOps: service })

    await Effect.runPromise(
      router.handle({
        id: '2',
        method: 'cliToolsOps.install',
        params: { toolId: 'playwright-cli', path: '/repo' }
      })
    )
    await Effect.runPromise(
      router.handle({
        id: '3',
        method: 'cliToolsOps.installSkill',
        params: { toolId: 'tcu', path: '/repo' }
      })
    )

    expect(service.install).toHaveBeenCalledWith('playwright-cli', '/repo')
    expect(service.installSkill).toHaveBeenCalledWith('tcu', '/repo')
  })

  it.each([
    ['unknown tool id', 'cliToolsOps.install', { toolId: 'nope', path: '/repo' }],
    ['missing path', 'cliToolsOps.installSkill', { toolId: 'tcu' }],
    ['extra key', 'cliToolsOps.list', { path: '/repo', extra: true }],
    ['empty path', 'cliToolsOps.list', { path: '' }]
  ])('rejects %s before calling the service', async (_label, method, params) => {
    const service = makeService()
    const router = makeRpcRouter({ eventBus: makeEventBus(), cliToolsOps: service })

    const response = await Effect.runPromise(router.handle({ id: 'bad', method, params }))

    expect(response).toMatchObject({ id: 'bad', ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(service.list).not.toHaveBeenCalled()
    expect(service.install).not.toHaveBeenCalled()
    expect(service.installSkill).not.toHaveBeenCalled()
  })
})

describe('makeLiveCliToolsOpsRpcService', () => {
  it('delegates to the installers and streams their output on the tool channel', async () => {
    const eventBus = makeEventBus()
    const received: unknown[] = []
    await Effect.runPromise(
      eventBus.subscribe('cli-tools:tcu', (event) => {
        received.push(event.payload)
      })
    )
    installerMocks.installCliTool.mockImplementation(
      async (_id: string, _path: string, publish: (event: unknown) => void) => {
        publish({ type: 'output', data: 'hello' })
        publish({ type: 'done' })
        return { success: true }
      }
    )
    installerMocks.listCliTools.mockResolvedValue(listing)
    installerMocks.installCliSkill.mockResolvedValue({ success: false, error: 'nope' })

    const service = makeLiveCliToolsOpsRpcService(eventBus)
    const installed = await Effect.runPromise(service.install('tcu', '/repo'))
    const listed = await Effect.runPromise(service.list('/repo'))
    const skill = await Effect.runPromise(service.installSkill('tcu', '/repo'))

    expect(installed).toEqual({ success: true })
    expect(listed).toBe(listing)
    expect(skill).toEqual({ success: false, error: 'nope' })
    expect(installerMocks.installCliTool).toHaveBeenCalledWith('tcu', '/repo', expect.any(Function))
    expect(installerMocks.installCliSkill).toHaveBeenCalledWith(
      'tcu',
      '/repo',
      expect.any(Function)
    )
    expect(received).toEqual([{ type: 'output', data: 'hello' }, { type: 'done' }])
  })
})
