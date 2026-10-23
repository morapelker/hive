// The data-project secrets vault (secrets.ts) against a fake desktop-command requester: what is
// persisted (ciphertext only), the 'session' fallback when no vault answers, lazy decryption
// with one shared in-flight request, the 'unavailable' state after a failed decrypt (and the
// retry after a mere timeout), and the process requester's IPC protocol.
import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { RpcRouteError } from '../../../../shared/rpc/errors'
import type { DesktopCommandRequest } from '../../../../shared/desktop-command'
import type { DataProjectRecord } from '../contracts'
import {
  DataDesktopCommandError,
  createProcessDesktopRequester,
  type DataDesktopCommandRequester,
  type DesktopIpcProcess
} from '../desktop-requester'
import { createDataSecretsStore, normalizeDataSecrets, toDataProjectDto } from '../secrets'
import { showDataOpenDialog, showDataSaveDialog } from '../desktop-dialogs'

/** A fake vault: "encrypts" by base64 of the JSON, like main does, but without safeStorage. */
const makeRequester = (
  options: {
    available?: boolean
    encrypt?: 'ok' | 'fail' | 'timeout'
    decrypt?: 'ok' | 'fail' | 'timeout' | 'garbage'
    delayMs?: number
  } = {}
) => {
  const calls: DesktopCommandRequest[] = []
  const requester: DataDesktopCommandRequester = {
    available: () => options.available ?? true,
    request: vi.fn(async (makeRequest: (id: string) => DesktopCommandRequest) => {
      const request = makeRequest(`req-${calls.length}`)
      calls.push(request)
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      if (request.command === 'dataSecretEncrypt') {
        if (options.encrypt === 'fail') throw new DataDesktopCommandError('failed', 'unavailable')
        if (options.encrypt === 'timeout') throw new DataDesktopCommandError('timeout', 'slow')
        return { ciphertext: `v1:${Buffer.from(request.payload.plaintext).toString('base64')}` }
      }
      if (request.command === 'dataSecretDecrypt') {
        if (options.decrypt === 'fail') throw new DataDesktopCommandError('failed', 'nope')
        if (options.decrypt === 'timeout') throw new DataDesktopCommandError('timeout', 'slow')
        if (options.decrypt === 'garbage') return { plaintext: '[1,2,3]' }
        const body = request.payload.ciphertext.slice(3)
        return { plaintext: Buffer.from(body, 'base64').toString('utf8') }
      }
      if (request.command === 'dataSecretAvailable') return { available: true }
      throw new Error(`unexpected ${request.command}`)
    })
  }
  return { requester, calls }
}

const record = (overrides: Partial<DataProjectRecord> = {}): DataProjectRecord => ({
  id: 'dp-1',
  name: 'shop',
  engine: 'mysql',
  config: { host: '127.0.0.1', port: 13306, user: 'root' },
  icon: null,
  iconColor: null,
  environment: 'local',
  color: null,
  safeMode: 'off',
  defaultLimit: 1000,
  allowAiDataAccess: false,
  pinned: false,
  secretCiphertext: null,
  secretState: 'none',
  sortOrder: 0,
  createdAt: '2026-10-23T00:00:00.000Z',
  lastAccessedAt: '2026-10-23T00:00:00.000Z',
  ...overrides
})

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(RpcRouteError)
    return (error as RpcRouteError).code
  }
  throw new Error('expected a rejection')
}

describe('normalizeDataSecrets', () => {
  it('keeps only non-empty known string secrets', () => {
    expect(
      normalizeDataSecrets({
        password: 'pw',
        sshPassword: '',
        sshPassphrase: undefined,
        // @ts-expect-error unknown keys are dropped
        token: 'x'
      })
    ).toEqual({ password: 'pw' })
    expect(normalizeDataSecrets(undefined)).toEqual({})
  })
})

describe('data secrets store', () => {
  it('stores ciphertext only and serves the plaintext from memory afterwards', async () => {
    const { requester, calls } = makeRequester()
    const store = createDataSecretsStore({ requester, getRecord: () => null })
    const result = await store.store('dp-1', { password: 'app pw!@#', sshPassphrase: 'key' })
    expect(result.state).toBe('stored')
    expect(result.ciphertext).toMatch(/^v1:/)
    expect(result.ciphertext).not.toContain('app pw!@#')
    expect(calls.map((c) => c.command)).toEqual(['dataSecretEncrypt'])

    expect(await store.resolve('dp-1')).toEqual({ password: 'app pw!@#', sshPassphrase: 'key' })
    expect(calls).toHaveLength(1)
    expect(
      store.stateOf(record({ secretCiphertext: result.ciphertext, secretState: 'stored' }))
    ).toBe('stored')
    expect(store.knownSecrets('dp-1').sort()).toEqual(['app pw!@#', 'key'])
  })

  it('falls back to session memory when no vault is reachable, never to plaintext', async () => {
    for (const requester of [
      makeRequester({ available: false }).requester,
      makeRequester({ encrypt: 'fail' }).requester,
      makeRequester({ encrypt: 'timeout' }).requester
    ]) {
      const store = createDataSecretsStore({ requester, getRecord: () => null })
      expect(await store.store('dp-1', { password: 'pw-1' })).toEqual({
        ciphertext: null,
        state: 'session'
      })
      expect(await store.resolve('dp-1')).toEqual({ password: 'pw-1' })
      expect(store.stateOf(record({ secretState: 'session' }))).toBe('session')
      expect(store.sessionSecretsOf('dp-1')).toEqual({ password: 'pw-1' })
    }
  })

  it('stores nothing for empty secrets', async () => {
    const { requester, calls } = makeRequester()
    const store = createDataSecretsStore({ requester, getRecord: () => record() })
    expect(await store.store('dp-1', { password: '' })).toEqual({ ciphertext: null, state: 'none' })
    expect(calls).toHaveLength(0)
    expect(await store.resolve('dp-1')).toEqual({})
    expect(store.stateOf(record())).toBe('none')
  })

  it('decrypts lazily after a restart, once for concurrent callers', async () => {
    const writer = createDataSecretsStore({
      requester: makeRequester().requester,
      getRecord: () => null
    })
    const { ciphertext } = await writer.store('dp-1', { password: 'pw-2' })
    const stored = record({ secretCiphertext: ciphertext, secretState: 'stored' })

    const { requester, calls } = makeRequester({ delayMs: 10 })
    const store = createDataSecretsStore({ requester, getRecord: () => stored })
    expect(store.stateOf(stored)).toBe('stored')
    expect(store.knownSecrets('dp-1')).toEqual([])
    const [a, b] = await Promise.all([store.resolve('dp-1'), store.resolve('dp-1')])
    expect(a).toEqual({ password: 'pw-2' })
    expect(b).toEqual({ password: 'pw-2' })
    expect(calls.map((c) => c.command)).toEqual(['dataSecretDecrypt'])
    await store.resolve('dp-1')
    expect(calls).toHaveLength(1)
    // Callers get copies: mutating one never changes the cache.
    a.password = 'changed'
    expect(await store.resolve('dp-1')).toEqual({ password: 'pw-2' })
  })

  it('marks an undecryptable secret unavailable for this run without retrying the Keychain', async () => {
    const stored = record({ secretCiphertext: 'v1:Zm9v', secretState: 'stored' })
    for (const mode of ['fail', 'garbage'] as const) {
      const { requester, calls } = makeRequester({ decrypt: mode })
      const store = createDataSecretsStore({ requester, getRecord: () => stored })
      expect(await codeOf(store.resolve('dp-1'))).toBe('DATA_CREDENTIALS_REQUIRED')
      expect(store.stateOf(stored)).toBe('unavailable')
      expect(await codeOf(store.resolve('dp-1'))).toBe('DATA_CREDENTIALS_REQUIRED')
      expect(calls).toHaveLength(1)

      // A password typed for this session wins; the row itself is untouched.
      store.remember('dp-1', { password: 'typed' })
      expect(store.stateOf(stored)).toBe('session')
      expect(await store.resolve('dp-1')).toEqual({ password: 'typed' })

      // invalidate keeps session secrets (they exist nowhere else).
      store.invalidate('dp-1')
      expect(await store.resolve('dp-1')).toEqual({ password: 'typed' })
    }
  })

  it('retries after a Keychain prompt timed out', async () => {
    const stored = record({ secretCiphertext: 'v1:e30=', secretState: 'stored' })
    const { requester, calls } = makeRequester({ decrypt: 'timeout' })
    const store = createDataSecretsStore({ requester, getRecord: () => stored })
    expect(await codeOf(store.resolve('dp-1'))).toBe('DATA_CREDENTIALS_REQUIRED')
    expect(store.stateOf(stored)).toBe('stored')
    expect(await codeOf(store.resolve('dp-1'))).toBe('DATA_CREDENTIALS_REQUIRED')
    expect(calls).toHaveLength(2)
  })

  it('reports a lost session secret as unavailable and asks for it', async () => {
    const lost = record({ secretState: 'session' })
    const store = createDataSecretsStore({
      requester: makeRequester().requester,
      getRecord: () => lost
    })
    expect(store.stateOf(lost)).toBe('unavailable')
    expect(await codeOf(store.resolve('dp-1'))).toBe('DATA_CREDENTIALS_REQUIRED')
  })

  it('answers DATA_NOT_FOUND for an unknown project', async () => {
    const store = createDataSecretsStore({
      requester: makeRequester().requester,
      getRecord: () => null
    })
    expect(await codeOf(store.resolve('missing'))).toBe('DATA_NOT_FOUND')
  })

  it('never lets a decrypt that finishes after a store overwrite the newer secrets', async () => {
    const stored = record({
      secretCiphertext: 'v1:eyJwYXNzd29yZCI6Im9sZCJ9',
      secretState: 'stored'
    })
    const { requester } = makeRequester({ delayMs: 20 })
    const store = createDataSecretsStore({ requester, getRecord: () => stored })
    const pending = store.resolve('dp-1')
    store.remember('dp-1', { password: 'new' })
    expect(await pending).toEqual({ password: 'old' })
    expect(await store.resolve('dp-1')).toEqual({ password: 'new' })
  })

  it('forget drops everything; invalidate drops only the decrypted copy', async () => {
    const { requester, calls } = makeRequester()
    const store = createDataSecretsStore({ requester, getRecord: () => null })
    const { ciphertext } = await store.store('dp-1', { password: 'pw' })
    const stored = record({ secretCiphertext: ciphertext, secretState: 'stored' })
    const reader = createDataSecretsStore({ requester, getRecord: () => stored })
    await reader.resolve('dp-1')
    reader.invalidate('dp-1')
    await reader.resolve('dp-1')
    expect(calls.filter((c) => c.command === 'dataSecretDecrypt')).toHaveLength(2)

    store.forget('dp-1')
    expect(store.knownSecrets('dp-1')).toEqual([])
  })

  it('reports vault availability', async () => {
    expect(
      await createDataSecretsStore({ requester: makeRequester().requester }).isVaultAvailable()
    ).toBe(true)
    expect(
      await createDataSecretsStore({
        requester: makeRequester({ available: false }).requester
      }).isVaultAvailable()
    ).toBe(false)
  })

  it('builds the DTO without the ciphertext and with the live state', () => {
    const store = createDataSecretsStore({ requester: makeRequester().requester })
    const dto = toDataProjectDto(
      record({ secretCiphertext: 'v1:abc', secretState: 'stored' }),
      store
    )
    expect(dto).not.toHaveProperty('secretCiphertext')
    expect(JSON.stringify(dto)).not.toContain('v1:abc')
    expect(dto.secretState).toBe('stored')
  })
})

describe('process desktop requester', () => {
  const makeProc = (reply: (request: DesktopCommandRequest, proc: EventEmitter) => void) => {
    const emitter = new EventEmitter()
    const proc = emitter as unknown as DesktopIpcProcess & EventEmitter
    proc.send = vi.fn((message: unknown, callback?: (error: Error | null) => void) => {
      callback?.(null)
      setImmediate(() => reply(message as DesktopCommandRequest, emitter))
      return true
    })
    return proc
  }

  it('sends a request and resolves the matching result only', async () => {
    const proc = makeProc((request, emitter) => {
      emitter.emit('message', {
        type: 'hive-desktop-command-result',
        id: 'other',
        ok: true,
        value: 1
      })
      emitter.emit('message', {
        type: 'hive-desktop-command-result',
        id: request.id,
        ok: true,
        value: { available: true }
      })
    })
    const requester = createProcessDesktopRequester(proc)
    expect(requester.available()).toBe(true)
    await expect(
      requester.request(
        (id) => ({ type: 'hive-desktop-command', id, command: 'dataSecretAvailable' }),
        {
          timeoutMs: 1000
        }
      )
    ).resolves.toEqual({ available: true })
    expect(proc.listenerCount('message')).toBe(0)
  })

  it('rejects with the main error, on timeout, and when no main is reachable', async () => {
    const failing = createProcessDesktopRequester(
      makeProc((request, emitter) =>
        emitter.emit('message', {
          type: 'hive-desktop-command-result',
          id: request.id,
          ok: false,
          error: 'Secure storage is not available'
        })
      )
    )
    await expect(
      failing.request(
        (id) => ({ type: 'hive-desktop-command', id, command: 'dataSecretAvailable' }),
        {
          timeoutMs: 1000
        }
      )
    ).rejects.toMatchObject({ kind: 'failed', message: 'Secure storage is not available' })

    const silentProc = makeProc(() => undefined)
    const silent = createProcessDesktopRequester(silentProc)
    await expect(
      silent.request(
        (id) => ({ type: 'hive-desktop-command', id, command: 'dataSecretAvailable' }),
        {
          timeoutMs: 20
        }
      )
    ).rejects.toMatchObject({ kind: 'timeout' })
    expect(silentProc.listenerCount('message')).toBe(0)

    const detached = createProcessDesktopRequester(
      new EventEmitter() as unknown as DesktopIpcProcess
    )
    expect(detached.available()).toBe(false)
    await expect(
      detached.request(
        (id) => ({ type: 'hive-desktop-command', id, command: 'dataSecretAvailable' }),
        {
          timeoutMs: 20
        }
      )
    ).rejects.toMatchObject({ kind: 'unavailable' })
  })
})

describe('data desktop dialogs', () => {
  const dialogRequester = (value: unknown) => {
    const seen: DesktopCommandRequest[] = []
    const requester: DataDesktopCommandRequester = {
      available: () => true,
      request: vi.fn(async (makeRequest: (id: string) => DesktopCommandRequest, options) => {
        expect(options.timeoutMs).toBeNull()
        seen.push(makeRequest('d-1'))
        return value
      })
    }
    return { requester, seen }
  }

  it('sends sanitized save-dialog payloads and returns the chosen path', async () => {
    const { requester, seen } = dialogRequester({ filePath: '/Users/me/Downloads/orders.csv' })
    await expect(
      showDataSaveDialog(
        { defaultName: '../../etc/orders.csv', extensions: ['.csv', 'CSV', 'bad ext', 'json'] },
        requester
      )
    ).resolves.toBe('/Users/me/Downloads/orders.csv')
    expect(seen[0]).toMatchObject({
      command: 'dataSaveFileDialog',
      payload: { defaultName: '.._.._etc_orders.csv', extensions: ['csv', 'CSV', 'json'] }
    })
  })

  it('returns null when cancelled or when no main process is reachable', async () => {
    await expect(
      showDataOpenDialog({ purpose: 'sqlite' }, dialogRequester({ filePath: null }).requester)
    ).resolves.toBeNull()
    const unavailable: DataDesktopCommandRequester = {
      available: () => false,
      request: vi.fn()
    }
    await expect(showDataOpenDialog({ purpose: 'ssh-key' }, unavailable)).resolves.toBeNull()
    await expect(
      showDataSaveDialog({ defaultName: 'x', extensions: [] }, unavailable)
    ).resolves.toBeNull()
    expect(unavailable.request).not.toHaveBeenCalled()
  })

  it('passes the purpose and allowCreate through', async () => {
    const { requester, seen } = dialogRequester({ filePath: '/tmp/new.sqlite' })
    await expect(
      showDataOpenDialog({ purpose: 'sqlite', allowCreate: true }, requester)
    ).resolves.toBe('/tmp/new.sqlite')
    expect(seen[0]).toMatchObject({
      command: 'dataOpenFileDialog',
      payload: { purpose: 'sqlite', allowCreate: true }
    })
  })
})
