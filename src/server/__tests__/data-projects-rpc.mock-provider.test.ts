// `dataProjects.*` through the real router with the live service over fakes: an in-memory
// repository, the real secrets vault on a fake desktop requester, a fake engine. Covers strict
// validation (DATA_INVALID_INPUT), the desktop-only guard (DATA_FORBIDDEN for device
// principals, on every method), the CRUD/secrets semantics, delegation to the engine with the
// caller's clientId, sanitized errors, files.*, and that every renderer API method has a handler.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Cause, Effect, Exit, Option } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import type { DesktopCommandRequest } from '../../shared/desktop-command'
import type { DataHistoryEntry, DataSavedQuery } from '../../shared/data-projects/types'
import {
  isChannelAllowedForDevice,
  isMethodAllowedForScope
} from '../../shared/remote-access/policy'
import { RpcRouteError } from '../../shared/rpc/errors'
import type { RpcResponse } from '../../shared/rpc/protocol'
import {
  DataDriverError,
  type DataEngineService,
  type DataProjectRecord,
  type DataProjectsRepository
} from '../../main/services/data-projects/contracts'
import type { DataDesktopCommandRequester } from '../../main/services/data-projects/desktop-requester'
import { createDataSecretsStore } from '../../main/services/data-projects/secrets'
import { makeEventBus } from '../events/event-bus'
import type { DataAssistantRpcService } from '../rpc/domains/data-assistant'
import {
  makeDataProjectsRpcHandlers,
  makeLiveDataProjectsRpcService,
  redactDataText,
  toDataRpcError,
  type DataProjectsRpcDeps
} from '../rpc/domains/data-projects'
import { runWithRpcRequestContext, type AuthPrincipal } from '../rpc/request-context'
import { handleRpcWithRequestContext, makeRpcRouter } from '../rpc/router'

// ---- fakes ----------------------------------------------------------------------------------

const makeRepository = () => {
  const rows = new Map<string, DataProjectRecord>()
  const history: DataHistoryEntry[] = []
  const saved: DataSavedQuery[] = []
  const reorders: unknown[] = []
  let clock = 0
  const now = () => new Date(Date.UTC(2026, 9, 23, 0, 0, clock++)).toISOString()
  const repo: DataProjectsRepository = {
    getDataProjects: () => [...rows.values()].sort((a, b) => a.sortOrder - b.sortOrder),
    getDataProject: (id) => (rows.has(id) ? structuredClone(rows.get(id)!) : null),
    createDataProject: (data) => {
      for (const row of rows.values()) row.sortOrder += 1
      const at = now()
      const record: DataProjectRecord = {
        ...structuredClone(data),
        id: data.id ?? `gen-${rows.size}`,
        sortOrder: 0,
        createdAt: at,
        lastAccessedAt: at
      }
      rows.set(record.id, record)
      return structuredClone(record)
    },
    updateDataProject: (id, patch) => {
      const row = rows.get(id)
      if (!row) return null
      Object.assign(row, structuredClone(patch))
      return structuredClone(row)
    },
    deleteDataProject: (id) => rows.delete(id),
    touchDataProject: (id) => {
      const row = rows.get(id)
      if (row) row.lastAccessedAt = now()
    },
    reorderSidebar: (entries) => {
      reorders.push(entries)
    },
    addDataQueryHistory: (entry) => {
      const stored = { ...entry, id: `h-${history.length}` }
      history.push(stored)
      return stored
    },
    listDataQueryHistory: (id, options) =>
      history
        .filter((h) => h.dataProjectId === id)
        .filter((h) => !options?.search || h.text.includes(options.search))
        .slice(0, options?.limit ?? 200),
    clearDataQueryHistory: (id) => {
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].dataProjectId === id) history.splice(i, 1)
      }
    },
    listDataSavedQueries: (id) => saved.filter((q) => q.dataProjectId === id),
    saveDataSavedQuery: (dataProjectId, query) => {
      const at = now()
      const stored: DataSavedQuery = {
        id: query.id ?? `s-${saved.length}`,
        dataProjectId,
        name: query.name,
        text: query.text,
        database: query.database ?? null,
        createdAt: at,
        updatedAt: at
      }
      saved.push(stored)
      return stored
    },
    deleteDataSavedQuery: (dataProjectId, savedId) => {
      const index = saved.findIndex((q) => q.id === savedId && q.dataProjectId === dataProjectId)
      if (index >= 0) saved.splice(index, 1)
    }
  }
  return { repo, rows, history, saved, reorders }
}

const makeVaultRequester = (available = true): DataDesktopCommandRequester => ({
  available: () => available,
  request: async (makeRequest: (id: string) => DesktopCommandRequest) => {
    const request = makeRequest('r')
    if (request.command === 'dataSecretEncrypt') {
      return { ciphertext: `v1:${Buffer.from(request.payload.plaintext).toString('base64')}` }
    }
    if (request.command === 'dataSecretDecrypt') {
      return { plaintext: Buffer.from(request.payload.ciphertext.slice(3), 'base64').toString() }
    }
    return { available }
  }
})

const makeEngine = () => {
  const status = (id: string) => ({ dataProjectId: id, state: 'connected' as const })
  const engine = {
    testConnection: vi.fn(async () => ({ ok: true, serverVersion: '8.4.0', latencyMs: 3 })),
    connect: vi.fn(async (id: string) => status(id)),
    disconnect: vi.fn(async (id: string) => ({
      dataProjectId: id,
      state: 'disconnected' as const
    })),
    status: vi.fn(status),
    invalidate: vi.fn(async () => undefined),
    databases: vi.fn(async () => [{ name: 'shop' }]),
    objects: vi.fn(async () => ({ objects: [] })),
    describe: vi.fn(async () => {
      throw new DataDriverError(
        "Access denied for user 'app' (password 'app pw!@#') via mysql://app:app%20pw@h",
        {
          code: 'ER_ACCESS_DENIED_ERROR'
        }
      )
    }),
    ddl: vi.fn(async () => 'CREATE TABLE users (id int)'),
    completionSchema: vi.fn(async () => ({ databases: ['shop'], tables: [] })),
    execute: vi.fn(async () => ({ status: 'ok' as const, statements: [], durationMs: 1 })),
    cancel: vi.fn(async () => ({ cancelled: true })),
    tableRows: vi.fn(async () => ({})),
    previewEdits: vi.fn(async () => ["UPDATE users SET name = 'x' WHERE id = 1"]),
    applyEdits: vi.fn(async () => ({
      status: 'ok' as const,
      statements: [],
      affectedRows: 1,
      durationMs: 1
    })),
    processes: vi.fn(async () => []),
    kill: vi.fn(async () => undefined),
    exportStart: vi.fn(async () => ({ status: 'cancelled' as const })),
    exportCancel: vi.fn(async () => ({ cancelled: true })),
    mongo: {
      find: vi.fn(async () => ({ documents: [], truncated: false, count: null, durationMs: 1 })),
      aggregate: vi.fn(async () => ({ status: 'cancelled' as const })),
      write: vi.fn(async () => ({ status: 'ok' as const, durationMs: 1 })),
      indexes: vi.fn(async () => []),
      createIndex: vi.fn(async () => ({ status: 'ok' as const, durationMs: 1 })),
      dropIndex: vi.fn(async () => ({ status: 'ok' as const, durationMs: 1 })),
      schema: vi.fn(async () => ({ fields: [], sampleSize: 0, count: null })),
      explain: vi.fn(async () => ({ summary: { stages: [] }, raw: {} })),
      collection: vi.fn(async () => ({ status: 'ok' as const, durationMs: 1 }))
    },
    sampleRows: vi.fn(async () => ({ kind: 'value' as const, value: null })),
    releaseClient: vi.fn(),
    shutdown: vi.fn(async () => undefined)
  }
  return engine
}

const setup = (overrides: Partial<DataProjectsRpcDeps> & { vaultAvailable?: boolean } = {}) => {
  const { repo, rows, history, saved, reorders } = makeRepository()
  const vault = createDataSecretsStore({
    requester: makeVaultRequester(overrides.vaultAvailable ?? true),
    getRecord: (id) => repo.getDataProject(id)
  })
  const engine = makeEngine()
  const loadEngine = vi.fn(async () => engine as unknown as DataEngineService)
  const icons = {
    remove: vi.fn(async () => undefined),
    copy: vi.fn(async (_fileName: string, to: string) => `${to}.png`)
  }
  const showSaveDialog = vi.fn(async () => '/Users/me/Downloads/orders.csv' as string | null)
  const showOpenDialog = vi.fn(async () => '/Users/me/shop.sqlite' as string | null)
  const writeTextFile = vi.fn(async () => undefined)
  const service = makeLiveDataProjectsRpcService({
    repository: () => repo,
    secrets: () => vault,
    loadEngine,
    icons,
    showSaveDialog,
    showOpenDialog,
    writeTextFile,
    parseConnectionUrl: (url) => ({
      ok: true,
      value: {
        engine: 'mysql',
        config: { host: url.includes('db') ? 'db' : 'x' },
        secrets: {},
        suggestedName: 'x',
        warnings: []
      }
    }),
    ...overrides
  })
  const router = makeRpcRouter({
    eventBus: makeEventBus(),
    dataProjects: service,
    dataAssistant: {} as DataAssistantRpcService
  })
  let seq = 0
  const call = async (
    method: string,
    params: unknown,
    principal: AuthPrincipal | null = { kind: 'desktop' },
    clientId: string | null = 'client-1'
  ): Promise<RpcResponse> =>
    handleRpcWithRequestContext(
      router,
      { id: `r${seq++}`, method, params },
      { clientId, principal }
    )
  const ok = async <T = unknown>(method: string, params: unknown): Promise<T> => {
    const response = await call(method, params)
    if (!response.ok) throw new Error(`${method}: ${response.error.code} ${response.error.message}`)
    return response.value as T
  }
  const fail = async (method: string, params: unknown, principal?: AuthPrincipal | null) => {
    const response = await call(method, params, principal)
    if (response.ok) throw new Error(`${method} unexpectedly succeeded`)
    return response.error
  }
  return {
    service,
    rows,
    history,
    saved,
    reorders,
    vault,
    engine,
    loadEngine,
    icons,
    showSaveDialog,
    showOpenDialog,
    writeTextFile,
    call,
    ok,
    fail
  }
}

const mysqlInput = {
  name: 'shop',
  engine: 'mysql',
  config: { host: '127.0.0.1', port: 13306, user: 'app', database: 'shop' },
  secrets: { password: 'app pw!@#' }
}

// ---- tests ----------------------------------------------------------------------------------

describe('dataProjects RPC: CRUD and secrets', () => {
  it('creates with encrypted secrets, local defaults and a DTO without the ciphertext', async () => {
    const t = setup()
    const created = await t.ok<Record<string, unknown>>('dataProjects.create', {
      input: mysqlInput
    })
    expect(created).toMatchObject({
      name: 'shop',
      engine: 'mysql',
      environment: 'local',
      safeMode: 'off',
      defaultLimit: 1000,
      allowAiDataAccess: false,
      pinned: false,
      secretState: 'stored'
    })
    expect(created).not.toHaveProperty('secretCiphertext')
    expect(JSON.stringify(created)).not.toContain('app pw!@#')
    const row = t.rows.get(created.id as string)!
    expect(row.secretCiphertext).toMatch(/^v1:/)
    expect(JSON.stringify(row)).not.toContain('app pw!@#')
    expect(await t.vault.resolve(row.id)).toEqual({ password: 'app pw!@#' })

    const remote = await t.ok<Record<string, unknown>>('dataProjects.create', {
      input: { name: 'prod', engine: 'postgres', config: { host: 'db.example.com' } }
    })
    expect(remote).toMatchObject({
      environment: 'development',
      safeMode: 'off',
      secretState: 'none'
    })
    const prod = await t.ok<Record<string, unknown>>('dataProjects.create', {
      input: {
        name: 'prod',
        engine: 'postgres',
        environment: 'production',
        config: { host: 'db.example.com' }
      }
    })
    expect(prod).toMatchObject({ environment: 'production', safeMode: 'half-safe' })

    expect(await t.ok<unknown[]>('dataProjects.list', {})).toHaveLength(3)
    expect(await t.ok('dataProjects.get', { id: created.id })).toMatchObject({ id: created.id })
    expect(await t.ok('dataProjects.get', { id: 'missing' })).toBeNull()
  })

  it('keeps secrets in session memory when no vault is reachable', async () => {
    const t = setup({ vaultAvailable: false })
    const created = await t.ok<{ id: string; secretState: string }>('dataProjects.create', {
      input: mysqlInput
    })
    expect(created.secretState).toBe('session')
    expect(t.rows.get(created.id)!.secretCiphertext).toBeNull()
    expect(t.rows.get(created.id)!.secretState).toBe('session')
  })

  it('validates strictly and drops secret-looking options', async () => {
    const t = setup()
    for (const input of [
      { ...mysqlInput, extra: true },
      { ...mysqlInput, engine: 'oracle' },
      { ...mysqlInput, name: '' },
      { ...mysqlInput, name: 'x'.repeat(201) },
      { ...mysqlInput, config: { ...mysqlInput.config, port: 70000 } },
      { ...mysqlInput, config: { ...mysqlInput.config, unknown: 1 } },
      { ...mysqlInput, config: {} },
      { name: 'file', engine: 'sqlite', config: {} },
      { ...mysqlInput, iconColor: 'red' },
      { ...mysqlInput, icon: { kind: 'image', fileName: '../../etc/passwd' } },
      { ...mysqlInput, safeMode: 'yolo' },
      { ...mysqlInput, secrets: { password: 'x', token: 'y' } }
    ]) {
      const error = await t.fail('dataProjects.create', { input })
      expect(error.code).toBe('DATA_INVALID_INPUT')
      expect(error).not.toHaveProperty('details')
      expect(error.message).not.toContain('app pw!@#')
    }
    const created = await t.ok<{ config: { options?: Record<string, string> } }>(
      'dataProjects.create',
      {
        input: {
          ...mysqlInput,
          config: { ...mysqlInput.config, options: { charset: 'utf8mb4', password: 'leak' } }
        }
      }
    )
    expect(created.config.options).toEqual({ charset: 'utf8mb4' })
    expect((await t.fail('dataProjects.get', { id: 1 })).code).toBe('DATA_INVALID_INPUT')
    expect((await t.fail('dataProjects.list', { x: 1 })).code).toBe('DATA_INVALID_INPUT')
  })

  it('updates fields, merges secret patches and invalidates the engine only when needed', async () => {
    const t = setup()
    const created = await t.ok<{ id: string }>('dataProjects.create', {
      input: { ...mysqlInput, secrets: { password: 'pw1', sshPassphrase: 'pass-phrase' } }
    })
    // Load the engine (a connect) so invalidation has something to act on.
    await t.ok('dataProjects.connect', { id: created.id })

    await t.ok('dataProjects.update', {
      id: created.id,
      patch: { name: '  renamed ', pinned: true }
    })
    expect(t.engine.invalidate).not.toHaveBeenCalled()
    expect(t.rows.get(created.id)).toMatchObject({ name: 'renamed', pinned: true })

    await t.ok('dataProjects.update', { id: created.id, patch: { secrets: { password: 'pw2' } } })
    expect(t.engine.invalidate).toHaveBeenCalledTimes(1)
    t.vault.invalidate(created.id)
    expect(await t.vault.resolve(created.id)).toEqual({
      password: 'pw2',
      sshPassphrase: 'pass-phrase'
    })

    await t.ok('dataProjects.update', {
      id: created.id,
      patch: { config: { ...mysqlInput.config, port: 3307 } }
    })
    expect(t.engine.invalidate).toHaveBeenCalledTimes(2)
    // The same config again is not a change.
    await t.ok('dataProjects.update', {
      id: created.id,
      patch: { config: { ...mysqlInput.config, port: 3307 } }
    })
    expect(t.engine.invalidate).toHaveBeenCalledTimes(2)

    const cleared = await t.ok<{ secretState: string }>('dataProjects.update', {
      id: created.id,
      patch: { secrets: { password: null, sshPassphrase: null } }
    })
    expect(cleared.secretState).toBe('none')
    expect(t.rows.get(created.id)).toMatchObject({ secretCiphertext: null, secretState: 'none' })

    expect(
      (await t.fail('dataProjects.update', { id: 'missing', patch: { name: 'x' } })).code
    ).toBe('DATA_NOT_FOUND')
    expect(
      (await t.fail('dataProjects.update', { id: created.id, patch: { engine: 'postgres' } })).code
    ).toBe('DATA_INVALID_INPUT')
  })

  it('removes an uploaded icon file when the icon changes away from it', async () => {
    const t = setup()
    const created = await t.ok<{ id: string }>('dataProjects.create', {
      input: { ...mysqlInput, icon: { kind: 'image', fileName: 'abc.png' } }
    })
    await t.ok('dataProjects.update', {
      id: created.id,
      patch: { icon: { kind: 'emoji', emoji: '🐬' } }
    })
    expect(t.icons.remove).toHaveBeenCalledWith(created.id)
  })

  it('deletes: invalidate, forget the secret, delete the row and the image icon', async () => {
    const t = setup()
    const created = await t.ok<{ id: string }>('dataProjects.create', {
      input: { ...mysqlInput, icon: { kind: 'image', fileName: 'x.png' } }
    })
    await t.ok('dataProjects.connect', { id: created.id })
    expect(await t.ok('dataProjects.delete', { id: created.id })).toEqual({ success: true })
    expect(t.engine.invalidate).toHaveBeenCalledWith(created.id)
    expect(t.vault.knownSecrets(created.id)).toEqual([])
    expect(t.rows.has(created.id)).toBe(false)
    expect(t.icons.remove).toHaveBeenCalledWith(created.id)
    expect(await t.ok('dataProjects.delete', { id: created.id })).toEqual({ success: false })
  })

  it('duplicates with a new id, "<name> copy", the same ciphertext and a copied icon', async () => {
    const t = setup()
    const created = await t.ok<{ id: string }>('dataProjects.create', {
      input: { ...mysqlInput, pinned: true, icon: { kind: 'image', fileName: 'orig.png' } }
    })
    const copy = await t.ok<{ id: string; name: string; pinned: boolean; icon: unknown }>(
      'dataProjects.duplicate',
      { id: created.id }
    )
    expect(copy.id).not.toBe(created.id)
    expect(copy).toMatchObject({
      name: 'shop copy',
      pinned: false,
      icon: { kind: 'image', fileName: `${copy.id}.png` }
    })
    expect(t.rows.get(copy.id)!.secretCiphertext).toBe(t.rows.get(created.id)!.secretCiphertext)
    expect(await t.vault.resolve(copy.id)).toEqual({ password: 'app pw!@#' })

    const session = setup({ vaultAvailable: false })
    const original = await session.ok<{ id: string }>('dataProjects.create', { input: mysqlInput })
    const sessionCopy = await session.ok<{ id: string; secretState: string }>(
      'dataProjects.duplicate',
      { id: original.id }
    )
    expect(sessionCopy.secretState).toBe('session')
    expect(await session.vault.resolve(sessionCopy.id)).toEqual({ password: 'app pw!@#' })
  })

  it('provides session secrets: remember=true persists, false stays in memory', async () => {
    const t = setup()
    const created = await t.ok<{ id: string }>('dataProjects.create', {
      input: { ...mysqlInput, secrets: undefined }
    })
    const remembered = await t.ok<{ secretState: string }>('dataProjects.provideSessionSecrets', {
      id: created.id,
      secrets: { password: 'typed' },
      remember: true
    })
    expect(remembered.secretState).toBe('stored')
    expect(t.rows.get(created.id)!.secretCiphertext).toMatch(/^v1:/)

    const other = await t.ok<{ id: string }>('dataProjects.create', {
      input: { ...mysqlInput, secrets: undefined }
    })
    const sessionOnly = await t.ok<{ secretState: string }>('dataProjects.provideSessionSecrets', {
      id: other.id,
      secrets: { password: 'typed' },
      remember: false
    })
    expect(sessionOnly.secretState).toBe('session')
    expect(t.rows.get(other.id)).toMatchObject({ secretCiphertext: null, secretState: 'session' })
    expect(await t.vault.resolve(other.id)).toEqual({ password: 'typed' })

    expect(
      (
        await t.fail('dataProjects.provideSessionSecrets', {
          id: other.id,
          secrets: {},
          remember: false
        })
      ).code
    ).toBe('DATA_INVALID_INPUT')
  })

  it('touches, reorders (rejecting duplicates), and serves history / saved queries', async () => {
    const t = setup()
    const created = await t.ok<{ id: string }>('dataProjects.create', { input: mysqlInput })
    await t.ok('dataProjects.touch', { id: created.id })
    expect((await t.fail('dataProjects.touch', { id: 'missing' })).code).toBe('DATA_NOT_FOUND')

    const entries = [
      { kind: 'data', id: created.id },
      { kind: 'project', id: 'p1' }
    ]
    await t.ok('dataProjects.reorderSidebar', { entries })
    expect(t.reorders).toEqual([entries])
    expect(
      (await t.fail('dataProjects.reorderSidebar', { entries: [...entries, entries[0]] })).code
    ).toBe('DATA_INVALID_INPUT')

    t.history.push({
      id: 'h1',
      dataProjectId: created.id,
      database: null,
      text: 'select 1',
      status: 'ok',
      durationMs: 1,
      rowCount: 1,
      error: null,
      executedAt: 'x'
    })
    expect(
      await t.ok('dataProjects.history.list', { id: created.id, search: 'select', limit: 5 })
    ).toHaveLength(1)
    await t.ok('dataProjects.history.clear', { id: created.id })
    expect(t.history).toHaveLength(0)

    const saved = await t.ok<{ id: string }>('dataProjects.saved.save', {
      id: created.id,
      query: { name: ' Revenue ', text: 'select 1', database: null }
    })
    expect(saved).toMatchObject({ name: 'Revenue' })
    expect(await t.ok('dataProjects.saved.list', { id: created.id })).toHaveLength(1)
    await t.ok('dataProjects.saved.delete', { id: created.id, savedId: saved.id })
    expect(t.saved).toHaveLength(0)
    expect(
      (await t.fail('dataProjects.saved.save', { id: 'missing', query: { name: 'x', text: 'y' } }))
        .code
    ).toBe('DATA_NOT_FOUND')
  })

  it('parses URLs through the shared parser and redacts a parser crash', async () => {
    const t = setup()
    expect(await t.ok('dataProjects.parseUrl', { url: 'mysql://db' })).toMatchObject({ ok: true })
    const crashing = setup({
      parseConnectionUrl: () => {
        throw new Error('bad url mysql://root:hunter22@db')
      }
    })
    const result = await crashing.ok<{ ok: boolean; error: string }>('dataProjects.parseUrl', {
      url: 'mysql://root:hunter22@db'
    })
    expect(result.ok).toBe(false)
    expect(result.error).not.toContain('hunter22')
  })
})

describe('dataProjects RPC: engine delegation', () => {
  it('passes requests and the caller clientId to the engine, loading it once', async () => {
    const t = setup()
    const created = await t.ok<{ id: string }>('dataProjects.create', { input: mysqlInput })
    const request = {
      dataProjectId: created.id,
      queryId: 'q-1',
      text: 'select * from users',
      database: 'shop',
      limit: 100,
      source: 'editor'
    }
    await t.ok('dataProjects.query.execute', request)
    expect(t.engine.execute).toHaveBeenCalledWith(request, { clientId: 'client-1' })
    await t.ok('dataProjects.mongo.find', {
      dataProjectId: created.id,
      queryId: 'q-2',
      database: 'shop',
      collection: 'users',
      filter: '{ age: { $gt: 3 } }',
      limit: 20
    })
    expect(t.engine.mongo.find).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'users' }),
      { clientId: 'client-1' }
    )
    expect(
      await t.ok('dataProjects.processes.kill', { id: created.id, processId: '42', scope: 'query' })
    ).toEqual({
      success: true
    })
    expect(t.engine.kill).toHaveBeenCalledWith(created.id, '42', 'query')
    await t.ok('dataProjects.schema.objects', { id: created.id, database: 'shop' })
    expect(t.engine.objects).toHaveBeenCalledWith(created.id, 'shop', undefined)
    expect(t.loadEngine).toHaveBeenCalledTimes(1)
  })

  it('cancels / releases / shuts down as no-ops until the engine was loaded', async () => {
    const t = setup()
    const created = await t.ok<{ id: string }>('dataProjects.create', { input: mysqlInput })
    expect(await t.ok('dataProjects.query.cancel', { queryId: 'q' })).toEqual({ cancelled: false })
    expect(await t.ok('dataProjects.export.cancel', { exportId: 'e' })).toEqual({
      cancelled: false
    })
    t.service.releaseClient('client-1')
    await t.service.shutdown()
    expect(t.loadEngine).not.toHaveBeenCalled()
    expect((await t.fail('dataProjects.status', { id: 'missing' })).code).toBe('DATA_NOT_FOUND')
    expect(t.loadEngine).not.toHaveBeenCalled()

    // status / disconnect go through the engine (it may have been connected elsewhere).
    expect(await t.ok('dataProjects.status', { id: created.id })).toMatchObject({
      state: 'connected'
    })
    expect(await t.ok('dataProjects.disconnect', { id: created.id })).toMatchObject({
      state: 'disconnected'
    })
    expect(await t.ok('dataProjects.query.cancel', { queryId: 'q' })).toEqual({ cancelled: true })
    t.service.releaseClient('client-1')
    expect(t.engine.releaseClient).toHaveBeenCalledWith('client-1')
    await t.service.shutdown()
    expect(t.engine.shutdown).toHaveBeenCalledTimes(1)
    expect(t.loadEngine).toHaveBeenCalledTimes(1)
  })

  it('validates engine requests before delegating', async () => {
    const t = setup()
    const base = {
      dataProjectId: 'dp',
      queryId: 'q',
      text: 'select 1',
      limit: 10,
      source: 'editor'
    }
    for (const params of [
      { ...base, source: 'shell' },
      { ...base, limit: -1 },
      { ...base, limit: 1_000_000 },
      { ...base, extra: 1 },
      { dataProjectId: 'dp', queryId: 'q', text: 'select 1', source: 'editor' }
    ]) {
      expect((await t.fail('dataProjects.query.execute', params)).code).toBe('DATA_INVALID_INPUT')
    }
    expect(
      (
        await t.fail('dataProjects.export.start', {
          dataProjectId: 'dp',
          exportId: 'e',
          source: { kind: 'query', text: 'select 1' },
          format: 'csv',
          filePath: 'relative/out.csv'
        })
      ).code
    ).toBe('DATA_INVALID_INPUT')
    expect(
      (
        await t.fail('dataProjects.table.applyEdits', {
          dataProjectId: 'dp',
          ref: { name: 'users' },
          edits: [{ kind: 'update', key: { id: 1 }, changes: { blob: { $t: 'hex' } } }]
        })
      ).code
    ).toBe('DATA_INVALID_INPUT')
    expect(
      (
        await t.fail('dataProjects.testConnection', {
          input: { engine: 'sqlite', config: {} }
        })
      ).code
    ).toBe('DATA_INVALID_INPUT')
    expect(t.engine.execute).not.toHaveBeenCalled()
  })

  it('sanitizes engine errors: known and request secrets, URL credentials, coded errors', async () => {
    const t = setup()
    const created = await t.ok<{ id: string }>('dataProjects.create', { input: mysqlInput })
    const error = await t.fail('dataProjects.schema.describe', {
      id: created.id,
      ref: { name: 'users' }
    })
    expect(error.code).toBe('INTERNAL_ERROR')
    expect(error.message).not.toContain('app pw!@#')
    expect(error.message).not.toContain('app%20pw')
    expect(error.details).toMatchObject({ driverCode: 'ER_ACCESS_DENIED_ERROR' })

    t.engine.connect.mockRejectedValueOnce(
      Object.assign(new Error('Enter the password'), { code: 'DATA_CREDENTIALS_REQUIRED' })
    )
    expect((await t.fail('dataProjects.connect', { id: created.id })).code).toBe(
      'DATA_CREDENTIALS_REQUIRED'
    )

    t.engine.testConnection.mockRejectedValueOnce(new Error('failed with typed-secret-1 in it'))
    const testError = await t.fail('dataProjects.testConnection', {
      input: { engine: 'mysql', config: { host: 'h' }, secrets: { password: 'typed-secret-1' } }
    })
    expect(testError.message).not.toContain('typed-secret-1')
  })
})

describe('dataProjects RPC: files', () => {
  it('saves renderer text through the dialog with an atomic write', async () => {
    const t = setup()
    expect(
      await t.ok('dataProjects.files.saveText', {
        defaultName: 'orders.csv',
        content: 'id,name\n1,a\n',
        extensions: ['csv']
      })
    ).toEqual({ filePath: '/Users/me/Downloads/orders.csv' })
    expect(t.showSaveDialog).toHaveBeenCalledWith({
      defaultName: 'orders.csv',
      extensions: ['csv']
    })
    expect(t.writeTextFile).toHaveBeenCalledWith('/Users/me/Downloads/orders.csv', 'id,name\n1,a\n')

    t.showSaveDialog.mockResolvedValueOnce(null)
    expect(
      await t.ok('dataProjects.files.saveText', {
        defaultName: 'x.csv',
        content: 'x',
        extensions: []
      })
    ).toEqual({ filePath: null })
    expect(t.writeTextFile).toHaveBeenCalledTimes(1)
  })

  it('opens the picker for a purpose', async () => {
    const t = setup()
    expect(await t.ok('dataProjects.files.pick', { purpose: 'sqlite', allowCreate: true })).toEqual(
      {
        filePath: '/Users/me/shop.sqlite'
      }
    )
    expect(t.showOpenDialog).toHaveBeenCalledWith({ purpose: 'sqlite', allowCreate: true })
    expect((await t.fail('dataProjects.files.pick', { purpose: 'anything' })).code).toBe(
      'DATA_INVALID_INPUT'
    )
  })
})

describe('dataProjects RPC: desktop only', () => {
  const apiMethods = (): string[] => {
    const source = readFileSync(
      join(__dirname, '../../renderer/src/api/data-projects-api.ts'),
      'utf8'
    )
    return [...source.matchAll(/request\('(dataProjects\.[A-Za-z.]+)'/g)].map((m) => m[1])
  }

  it('has a handler for every method of the renderer API', () => {
    const handlers = makeDataProjectsRpcHandlers(setup().service)
    const methods = apiMethods()
    expect(methods.length).toBeGreaterThan(40)
    for (const method of methods) expect(handlers.has(method), method).toBe(true)
    expect([...handlers.keys()].sort()).toEqual([...new Set(methods)].sort())
  })

  it('refuses every method for a device principal and never touches the service', async () => {
    const t = setup()
    const device: AuthPrincipal = {
      kind: 'device',
      deviceId: 'phone',
      name: 'Phone',
      scope: 'operator'
    }
    for (const method of apiMethods()) {
      const response = await t.call(method, {}, device)
      expect(response.ok, method).toBe(false)
      if (!response.ok) {
        // The router's remote policy refuses first; the domain guard is the second line.
        expect(['DATA_FORBIDDEN', 'REMOTE_FORBIDDEN', 'FORBIDDEN']).toContain(response.error.code)
      }
    }
    expect(t.loadEngine).not.toHaveBeenCalled()
  })

  it('refuses a device principal in the domain itself, even if a policy slipped', async () => {
    const t = setup()
    const handlers = makeDataProjectsRpcHandlers(t.service)
    const device: AuthPrincipal = { kind: 'device', deviceId: 'd', name: 'n', scope: 'operator' }
    // Straight to the handlers, bypassing the router's policy: only the domain guard is left.
    for (const [method, handler] of handlers) {
      const exit = await runWithRpcRequestContext({ clientId: 'c', principal: device }, () =>
        Effect.runPromiseExit(handler({ id: 'x' }, { eventBus: makeEventBus() }))
      )
      expect(Exit.isFailure(exit), method).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        expect(Option.isSome(failure) && (failure.value as RpcRouteError).code, method).toBe(
          'DATA_FORBIDDEN'
        )
      }
    }
    expect(t.loadEngine).not.toHaveBeenCalled()
  })

  it('is absent from the remote-access policy and channel allowlist', () => {
    for (const method of apiMethods()) {
      for (const scope of ['viewer', 'operator', 'peer'] as const) {
        expect(isMethodAllowedForScope(method, scope), `${method} ${scope}`).toBe(false)
      }
    }
    for (const channel of ['dataProjects:status', 'dataProjects:export', 'dataAssistant:event']) {
      expect(isChannelAllowedForDevice(channel, 'operator')).toBe(false)
    }
  })

  it('accepts context-less loopback calls (auth disabled) and desktop principals', async () => {
    const t = setup()
    expect((await t.call('dataProjects.list', {}, null, null)).ok).toBe(true)
    expect((await t.call('dataProjects.list', {}, { kind: 'desktop' })).ok).toBe(true)
  })
})

describe('data error helpers', () => {
  it('redacts URL userinfo, password params and known secrets, and caps the length', () => {
    const text = redactDataText(
      'connect postgres://u:s3cr3t-pw@h:5432/db?password=abc123 failed for s3cr3t-pw',
      ['s3cr3t-pw']
    )
    expect(text).not.toContain('s3cr3t-pw')
    expect(text).not.toContain('abc123')
    expect(redactDataText('x'.repeat(10_000)).length).toBeLessThanOrEqual(4001)
  })

  it('keeps only flat primitive details', () => {
    const error = toDataRpcError(
      new RpcRouteError('DATA_BUSY', 'busy', { dataProjectId: 'dp', config: { password: 'x' } })
    )
    expect(error.code).toBe('DATA_BUSY')
    expect(error.details).toEqual({ dataProjectId: 'dp' })
    expect(toDataRpcError({ weird: true }).details).toBeUndefined()
  })
})
