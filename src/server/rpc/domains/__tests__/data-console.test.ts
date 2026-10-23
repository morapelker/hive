// `dataProjects.console.*`: the method names the renderer API requests, strict params, the
// desktop-only guard (handlers and remote-access policy, methods and push channel), and that
// the live service publishes the log's entries on DATA_CONSOLE_CHANNEL through the event bus.
import { Effect, Exit } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import {
  DATA_CONSOLE_CHANNEL,
  type DataConsoleEvent
} from '../../../../shared/data-projects/console-types'
import {
  getRemoteMethodTier,
  isChannelAllowedForDevice,
  isMethodAllowedForScope,
  REMOTE_CHANNEL_ALLOWLIST,
  type RemoteDeviceScope
} from '../../../../shared/remote-access/policy'
import type { ServerEvent } from '../../../../shared/rpc/protocol'
import { DataConsoleLog } from '../../../../main/services/data-projects/console-log'
import { makeEventBus } from '../../../events/event-bus'
import { runWithRpcRequestContext } from '../../request-context'
import type { RpcContext } from '../../router'
import {
  makeDataConsoleRpcHandlers,
  makeLiveDataConsoleRpcService,
  type DataConsoleRpcService
} from '../data-console'

const context = { eventBus: null } as unknown as RpcContext
const SCOPES: RemoteDeviceScope[] = ['viewer', 'operator', 'peer']

function fakeService(): DataConsoleRpcService {
  return {
    list: vi.fn(async () => ({ entries: [], epoch: 'e' })),
    clear: vi.fn(async () => ({ success: true }))
  }
}

describe('makeDataConsoleRpcHandlers', () => {
  it('registers dataProjects.console.list / clear only', () => {
    const handlers = makeDataConsoleRpcHandlers(fakeService())
    expect([...handlers.keys()].sort()).toEqual([
      'dataProjects.console.clear',
      'dataProjects.console.list'
    ])
  })

  it('validates and forwards the params', async () => {
    const service = fakeService()
    const handlers = makeDataConsoleRpcHandlers(service)
    const list = handlers.get('dataProjects.console.list')!
    await expect(Effect.runPromise(list({ id: 'dp-1', since: 4 }, context))).resolves.toEqual({
      entries: [],
      epoch: 'e'
    })
    expect(service.list).toHaveBeenCalledWith('dp-1', 4)
    await Effect.runPromise(list({ id: 'dp-1' }, context))
    expect(service.list).toHaveBeenLastCalledWith('dp-1', undefined)
    for (const bad of [
      {},
      { id: '' },
      { id: 'x', since: -1 },
      { id: 'x', since: 1.5 },
      { id: 'x', other: 1 }
    ]) {
      const exit = await Effect.runPromiseExit(list(bad, context))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(JSON.stringify(exit)).toContain('DATA_INVALID_INPUT')
    }
    const clear = handlers.get('dataProjects.console.clear')!
    await expect(Effect.runPromise(clear({ id: 'dp-1' }, context))).resolves.toEqual({
      success: true
    })
    expect(service.clear).toHaveBeenCalledWith('dp-1')
  })

  it('refuses device principals in the handlers themselves', async () => {
    const service = fakeService()
    const handlers = makeDataConsoleRpcHandlers(service)
    for (const method of handlers.keys()) {
      const exit = await runWithRpcRequestContext(
        {
          clientId: 'phone',
          principal: { kind: 'device', deviceId: 'd1', name: 'Phone', scope: 'operator' as never }
        },
        () => Effect.runPromiseExit(handlers.get(method)!({ id: 'dp-1' }, context))
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(JSON.stringify(exit)).toContain('DATA_FORBIDDEN')
    }
    expect(service.list).not.toHaveBeenCalled()
    expect(service.clear).not.toHaveBeenCalled()
    // Desktop principals are fine.
    await runWithRpcRequestContext({ clientId: 'r', principal: { kind: 'desktop' } }, () =>
      Effect.runPromise(handlers.get('dataProjects.console.list')!({ id: 'dp-1' }, context))
    )
    expect(service.list).toHaveBeenCalledTimes(1)
  })

  it('is never reachable from a paired device: no policy entry, no channel', () => {
    for (const method of makeDataConsoleRpcHandlers(fakeService()).keys()) {
      expect(method.startsWith('dataProjects.')).toBe(true)
      expect(getRemoteMethodTier(method)).toBeNull()
      for (const scope of SCOPES) expect(isMethodAllowedForScope(method, scope)).toBe(false)
    }
    expect(DATA_CONSOLE_CHANNEL.startsWith('dataProjects:')).toBe(true)
    expect(isChannelAllowedForDevice(DATA_CONSOLE_CHANNEL)).toBe(false)
    for (const scope of SCOPES)
      expect(isChannelAllowedForDevice(DATA_CONSOLE_CHANNEL, scope)).toBe(false)
    expect(REMOTE_CHANNEL_ALLOWLIST.some((c) => c.startsWith('dataProjects'))).toBe(false)
  })
})

describe('makeLiveDataConsoleRpcService', () => {
  it('lists and clears the log and publishes its entries on the event bus', async () => {
    const eventBus = makeEventBus()
    const events: DataConsoleEvent[] = []
    Effect.runSync(
      eventBus.subscribe(DATA_CONSOLE_CHANNEL, (event: ServerEvent) => {
        events.push(event.payload as DataConsoleEvent)
      })
    )
    const log = new DataConsoleLog({ flushMs: 1 })
    const module = await import('../../../../main/services/data-projects/console-log')
    const service = makeLiveDataConsoleRpcService({
      eventBus,
      load: async () => ({
        ...module,
        getDataConsoleLog: () => log,
        setDataConsolePublisher: (publish) => log.setPublisher(publish)
      })
    })
    expect(await service.list('dp-1')).toEqual({ entries: [], epoch: log.epoch })
    log.record({ dataProjectId: 'dp-1', engine: 'postgres', source: 'query', text: 'SELECT 1' })
    log.flush()
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toMatchObject({ dataProjectId: 'dp-1', kind: 'entries' })
    const listed = await service.list('dp-1')
    expect(listed.entries.map((e) => e.text)).toEqual(['SELECT 1'])
    expect((await service.list('dp-1', listed.entries[0].seq)).entries).toEqual([])
    await expect(service.clear('dp-1')).resolves.toEqual({ success: true })
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ kind: 'cleared' }))
    expect((await service.list('dp-1')).entries).toEqual([])
  })
})
