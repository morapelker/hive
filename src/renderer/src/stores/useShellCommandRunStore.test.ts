import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import {
  createSessionShellCommandSnapshot,
  serializeSessionShellCommand,
  type SessionShellCommand
} from '@shared/lib/shell-commands'
import { useShellCommandRunStore, type ShellCommandRunRow } from './useShellCommandRunStore'

function snapshot(overrides: Partial<SessionShellCommand> = {}): SessionShellCommand {
  return {
    ...createSessionShellCommandSnapshot({ id: 'cmd-1', name: 'Build', commands: 'make build' }),
    ...overrides
  }
}

function row(sessionId: string, run: SessionShellCommand | string): ShellCommandRunRow {
  return {
    sessionId,
    projectId: 'project-1',
    worktreeId: 'wt-1',
    shellCommand: typeof run === 'string' ? run : serializeSessionShellCommand(run)
  }
}

/** A request mock whose response is released by the test. */
function deferredRequest(): {
  request: ReturnType<typeof vi.fn>
  resolve: (rows: unknown) => void
  reject: (error: Error) => void
} {
  let resolve!: (rows: unknown) => void
  let reject!: (error: Error) => void
  const request = vi.fn(
    () =>
      new Promise((res, rej) => {
        resolve = res
        reject = rej
      })
  )
  return { request, resolve: (rows) => resolve(rows), reject: (error) => reject(error) }
}

describe('useShellCommandRunStore', () => {
  beforeEach(() => {
    useShellCommandRunStore.setState({ runsBySession: {}, loaded: false })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('loadAll parses rows, skips invalid JSON and marks the store loaded', async () => {
    const running = snapshot({ state: 'running', runId: 'run-1' })
    const request = vi
      .fn()
      .mockResolvedValue([
        row('session-a', running),
        row('session-b', '{not json'),
        row('session-c', JSON.stringify({ commandId: 'cmd', name: 'No script' })),
        { projectId: 'project-1', worktreeId: null, shellCommand: '{}' }
      ])
    setRendererRpcClient({ request, subscribe: vi.fn() })

    await useShellCommandRunStore.getState().loadAll()

    expect(request).toHaveBeenCalledExactlyOnceWith('db.session.getShellCommandRuns', {})
    const state = useShellCommandRunStore.getState()
    expect(state.loaded).toBe(true)
    expect(Object.keys(state.runsBySession)).toEqual(['session-a'])
    expect(state.runsBySession['session-a']).toEqual(running)
  })

  it('concurrent loadAll calls share one request, and a later call starts a new one', async () => {
    const deferred = deferredRequest()
    setRendererRpcClient({ request: deferred.request, subscribe: vi.fn() })

    const first = useShellCommandRunStore.getState().loadAll()
    const second = useShellCommandRunStore.getState().loadAll()
    expect(second).toBe(first)
    // The request is issued on a microtask (the store guards a synchronous throw).
    await Promise.resolve()
    deferred.resolve([row('session-a', snapshot())])
    await first
    expect(deferred.request).toHaveBeenCalledTimes(1)

    const third = useShellCommandRunStore.getState().loadAll()
    await Promise.resolve()
    deferred.resolve([])
    await third
    expect(deferred.request).toHaveBeenCalledTimes(2)
  })

  it('a setRun made while a load is in flight wins over the response', async () => {
    const deferred = deferredRequest()
    setRendererRpcClient({ request: deferred.request, subscribe: vi.fn() })

    const load = useShellCommandRunStore.getState().loadAll()
    await Promise.resolve()
    const local = snapshot({ state: 'running', runId: 'run-2' })
    useShellCommandRunStore.getState().setRun('session-a', local)
    deferred.resolve([row('session-a', snapshot({ state: 'pending' }))])
    await load

    expect(useShellCommandRunStore.getState().runsBySession['session-a']).toEqual(local)
  })

  it('a mergeRun made while a load is in flight wins over the response', async () => {
    useShellCommandRunStore.getState().setRun('session-a', snapshot({ state: 'running' }))
    const deferred = deferredRequest()
    setRendererRpcClient({ request: deferred.request, subscribe: vi.fn() })

    const load = useShellCommandRunStore.getState().loadAll()
    await Promise.resolve()
    expect(
      useShellCommandRunStore.getState().mergeRun('session-a', { state: 'failed', exitCode: 3 })
    ).toBe(true)
    deferred.resolve([row('session-a', snapshot({ state: 'running' }))])
    await load

    const run = useShellCommandRunStore.getState().runsBySession['session-a']
    expect(run.state).toBe('failed')
    expect(run.exitCode).toBe(3)
  })

  it('the response replaces entries that were not written during the load', async () => {
    useShellCommandRunStore.getState().setRun('session-a', snapshot({ state: 'running' }))
    const request = vi
      .fn()
      .mockResolvedValue([row('session-a', snapshot({ state: 'succeeded', exitCode: 0 }))])
    setRendererRpcClient({ request, subscribe: vi.fn() })

    await useShellCommandRunStore.getState().loadAll()

    expect(useShellCommandRunStore.getState().runsBySession['session-a'].state).toBe('succeeded')
  })

  it('keeps a local entry the response does not mention', async () => {
    const local = snapshot({ state: 'pending' })
    useShellCommandRunStore.getState().setRun('session-new', local)
    setRendererRpcClient({ request: vi.fn().mockResolvedValue([]), subscribe: vi.fn() })

    await useShellCommandRunStore.getState().loadAll()

    expect(useShellCommandRunStore.getState().runsBySession['session-new']).toEqual(local)
  })

  it('mergeRun returns false and changes nothing for an unknown session', () => {
    const before = useShellCommandRunStore.getState().runsBySession

    expect(useShellCommandRunStore.getState().mergeRun('unknown', { state: 'failed' })).toBe(false)
    expect(useShellCommandRunStore.getState().runsBySession).toBe(before)
  })

  it('removeRun drops the entry', () => {
    useShellCommandRunStore.getState().setRun('session-a', snapshot())
    useShellCommandRunStore.getState().removeRun('session-a')

    expect(useShellCommandRunStore.getState().runsBySession).toEqual({})
  })

  it('loadAll resolves when the RPC client throws synchronously', async () => {
    resetRendererRpcClientForTests()

    await expect(useShellCommandRunStore.getState().loadAll()).resolves.toBeUndefined()
    expect(useShellCommandRunStore.getState().loaded).toBe(false)
  })

  it('loadAll resolves when the request rejects or returns a non-array', async () => {
    setRendererRpcClient({
      request: vi.fn().mockRejectedValue(new Error('boom')),
      subscribe: vi.fn()
    })
    await expect(useShellCommandRunStore.getState().loadAll()).resolves.toBeUndefined()

    setRendererRpcClient({ request: vi.fn().mockResolvedValue(null), subscribe: vi.fn() })
    await expect(useShellCommandRunStore.getState().loadAll()).resolves.toBeUndefined()
    expect(useShellCommandRunStore.getState().loaded).toBe(false)
  })
})
