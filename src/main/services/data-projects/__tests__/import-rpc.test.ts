// `dataProjects.import.*` through the domain's handlers over fakes (in-memory repository and
// secrets, a fake engine; the app DB is never opened): strict validation, delegation with the
// caller's clientId, cancel before the engine loaded, the desktop-only guard, and the renderer
// API naming the same methods.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Cause, Effect, Exit, Option } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import type {
  DataImportPreviewRequest,
  DataImportStartRequest
} from '../../../../shared/data-projects/import-types'
import type { RpcRouteError } from '../../../../shared/rpc/errors'
import { makeEventBus } from '../../../../server/events/event-bus'
import {
  makeDataProjectsRpcHandlers,
  makeLiveDataProjectsRpcService
} from '../../../../server/rpc/domains/data-projects'
import {
  runWithRpcRequestContext,
  type AuthPrincipal
} from '../../../../server/rpc/request-context'
import type { DataEngineService } from '../contracts'
import { createDataSecretsStore } from '../secrets'
import { MemoryRepository, makeRecord } from './engine-fixtures'

const setup = () => {
  const repo = new MemoryRepository([makeRecord({ id: 'dp-1' })])
  const vault = createDataSecretsStore({
    requester: { available: () => false, request: async () => null },
    getRecord: (id) => repo.getDataProject(id)
  })
  const engine = {
    importPreview: vi.fn(async () => ({ fileName: 'a.csv' })),
    importStart: vi.fn(async () => ({ status: 'ok' })),
    importCancel: vi.fn(async () => ({ cancelled: true }))
  }
  let loaded = false
  const service = makeLiveDataProjectsRpcService({
    repository: () => repo,
    secrets: () => vault,
    loadEngine: async () => {
      loaded = true
      return engine as unknown as DataEngineService
    }
  })
  const handlers = makeDataProjectsRpcHandlers(service)
  const call = async (
    method: string,
    params: unknown,
    principal: AuthPrincipal | null = { kind: 'desktop' }
  ): Promise<{ ok: true; value: unknown } | { ok: false; code: string; message: string }> => {
    const handler = handlers.get(method)
    if (!handler) throw new Error(`no handler ${method}`)
    const exit = await runWithRpcRequestContext({ clientId: 'client-7', principal }, () =>
      Effect.runPromiseExit(handler(params, { eventBus: makeEventBus() }))
    )
    if (Exit.isSuccess(exit)) return { ok: true, value: exit.value }
    const failure = Cause.failureOption(exit.cause)
    const error = Option.isSome(failure) ? (failure.value as RpcRouteError) : null
    return { ok: false, code: error?.code ?? 'UNKNOWN', message: error?.message ?? '' }
  }
  return { engine, call, isLoaded: () => loaded }
}

const preview: DataImportPreviewRequest = {
  dataProjectId: 'dp-1',
  filePath: '/Users/me/orders.csv',
  target: { kind: 'table', ref: { name: 'orders', schema: 'public', database: 'shop' } },
  csv: { delimiter: ';' },
  limit: 50
}

const start: DataImportStartRequest = {
  dataProjectId: 'dp-1',
  importId: 'imp-1',
  filePath: '/Users/me/orders.csv',
  target: { kind: 'collection', database: 'shop', collection: 'users' },
  format: 'csv',
  encoding: 'utf-8',
  csv: { delimiter: '\t', quote: '', header: false },
  columns: [{ source: 0, target: 'a.b', type: 'int64' }],
  empty: 'omit',
  onError: 'skip',
  batchSize: 1000,
  confirmToken: 'tok'
}

describe('dataProjects.import.* RPC', () => {
  it('delegates valid requests with the caller’s clientId', async () => {
    const t = setup()
    expect(await t.call('dataProjects.import.preview', preview)).toEqual({
      ok: true,
      value: { fileName: 'a.csv' }
    })
    expect(t.engine.importPreview).toHaveBeenCalledWith(preview)
    expect(await t.call('dataProjects.import.start', start)).toEqual({
      ok: true,
      value: { status: 'ok' }
    })
    expect(t.engine.importStart).toHaveBeenCalledWith(start, { clientId: 'client-7' })
  })

  it('refuses malformed input with DATA_INVALID_INPUT', async () => {
    const t = setup()
    const bad: Array<[string, unknown]> = [
      ['dataProjects.import.preview', { ...preview, filePath: 'relative/orders.csv' }],
      ['dataProjects.import.preview', { ...preview, extra: true }],
      ['dataProjects.import.preview', { ...preview, csv: { delimiter: ',,' } }],
      ['dataProjects.import.preview', { ...preview, format: 'xlsx' }],
      ['dataProjects.import.start', { ...start, onError: 'ignore' }],
      ['dataProjects.import.start', { ...start, empty: 'zero' }],
      ['dataProjects.import.start', { ...start, encoding: 'latin2' }],
      ['dataProjects.import.start', { ...start, batchSize: 0 }],
      ['dataProjects.import.start', { ...start, columns: [{ source: -1, target: 'a' }] }],
      [
        'dataProjects.import.start',
        { ...start, columns: [{ source: 0, target: 'a', type: 'uuid' }] }
      ],
      ['dataProjects.import.start', { ...start, target: { kind: 'table' } }],
      ['dataProjects.import.start', { ...start, importId: '' }],
      ['dataProjects.import.cancel', { importId: 'x', more: 1 }]
    ]
    for (const [method, params] of bad) {
      const res = await t.call(method, params)
      expect(res.ok, JSON.stringify(params)).toBe(false)
      if (!res.ok) expect(res.code).toBe('DATA_INVALID_INPUT')
    }
    expect(t.engine.importPreview).not.toHaveBeenCalled()
    expect(t.engine.importStart).not.toHaveBeenCalled()
  })

  it('cancel answers without loading the engine when nothing can be running', async () => {
    const t = setup()
    expect(await t.call('dataProjects.import.cancel', { importId: 'imp-1' })).toEqual({
      ok: true,
      value: { cancelled: false }
    })
    expect(t.isLoaded()).toBe(false)
    await t.call('dataProjects.import.preview', preview)
    expect(await t.call('dataProjects.import.cancel', { importId: 'imp-1' })).toEqual({
      ok: true,
      value: { cancelled: true }
    })
    expect(t.engine.importCancel).toHaveBeenCalledWith('imp-1')
  })

  it('is desktop-only', async () => {
    const t = setup()
    const device: AuthPrincipal = {
      kind: 'device',
      deviceId: 'phone',
      name: 'Phone',
      scope: 'operator'
    }
    for (const [method, params] of [
      ['dataProjects.import.preview', preview],
      ['dataProjects.import.start', start],
      ['dataProjects.import.cancel', { importId: 'x' }]
    ] as const) {
      const res = await t.call(method, params, device)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.code).toBe('DATA_FORBIDDEN')
    }
    expect(t.engine.importStart).not.toHaveBeenCalled()
  })

  it('the renderer API calls exactly these methods', () => {
    const source = readFileSync(
      join(__dirname, '../../../../renderer/src/api/data-projects-api.ts'),
      'utf8'
    )
    const methods = [...source.matchAll(/request\('(dataProjects\.import\.[A-Za-z.]+)'/g)].map(
      (m) => m[1]
    )
    expect(methods.sort()).toEqual([
      'dataProjects.import.cancel',
      'dataProjects.import.preview',
      'dataProjects.import.start'
    ])
  })
})
