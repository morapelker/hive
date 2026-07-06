import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'

import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GITHUB_CLONE_PROGRESS_CHANNEL } from '../../../../shared/github-events'
import type { ServerEvent } from '../../../../shared/rpc/protocol'
import { makeEventBus } from '../../../events/event-bus'
import { makeLiveGithubOpsRpcService, parseCloneProgress } from '../github-ops'

class FakeCloneProcess extends EventEmitter {
  readonly stderr = new EventEmitter()
  readonly killedSignals: string[] = []

  kill(signal?: string): boolean {
    this.killedSignals.push(signal ?? 'SIGTERM')
    return true
  }
}

const tempDirs: string[] = []
const unsubscribes: Array<() => void> = []

const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-github-ops-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  vi.useRealTimers()
  for (const unsubscribe of unsubscribes.splice(0)) {
    unsubscribe()
  }
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

const collectCloneEvents = async (
  eventBus: ReturnType<typeof makeEventBus>
): Promise<ServerEvent[]> => {
  const events: ServerEvent[] = []
  const unsubscribe = await Effect.runPromise(
    eventBus.subscribe(GITHUB_CLONE_PROGRESS_CHANNEL, (event) => {
      events.push(event)
    })
  )
  unsubscribes.push(unsubscribe)
  return events
}

const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('githubOps.listRepositories', () => {
  it('parses NDJSON output from gh api into repos', async () => {
    const runCommand = vi.fn().mockResolvedValue({
      stdout:
        '{"nameWithOwner":"me/repo-a","description":"first","isPrivate":false,"updatedAt":"2026-01-01T00:00:00Z"}\n' +
        '{"nameWithOwner":"org/repo-b","description":null,"isPrivate":true,"updatedAt":"2026-02-01T00:00:00Z"}\n',
      stderr: ''
    })
    const service = makeLiveGithubOpsRpcService({ runCommand })

    const result = await Effect.runPromise(service.listRepositories())

    expect(result.success).toBe(true)
    expect(result.repos).toEqual([
      {
        nameWithOwner: 'me/repo-a',
        description: 'first',
        isPrivate: false,
        updatedAt: '2026-01-01T00:00:00Z'
      },
      {
        nameWithOwner: 'org/repo-b',
        description: null,
        isPrivate: true,
        updatedAt: '2026-02-01T00:00:00Z'
      }
    ])
    expect(runCommand).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['api', '--paginate']),
      expect.objectContaining({ maxBuffer: expect.any(Number) })
    )
  })

  it('reports a friendly error when gh is not installed', async () => {
    const runCommand = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }))
    const service = makeLiveGithubOpsRpcService({ runCommand })

    const result = await Effect.runPromise(service.listRepositories())

    expect(result).toEqual({
      success: false,
      repos: [],
      error: 'GitHub CLI (gh) is not installed'
    })
  })

  it('surfaces stderr when gh fails (e.g. not authenticated)', async () => {
    const runCommand = vi.fn().mockRejectedValue(
      Object.assign(new Error('gh exited with code 1'), {
        stderr: 'To get started with GitHub CLI, please run: gh auth login'
      })
    )
    const service = makeLiveGithubOpsRpcService({ runCommand })

    const result = await Effect.runPromise(service.listRepositories())

    expect(result.success).toBe(false)
    expect(result.error).toContain('gh auth login')
  })
})

describe('githubOps.cloneRepository', () => {
  it('rejects invalid repository names', async () => {
    const service = makeLiveGithubOpsRpcService({})

    const result = await Effect.runPromise(
      service.cloneRepository({
        nameWithOwner: '--flag/injection',
        parentPath: makeTempDir(),
        operationId: 'op-1'
      })
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid repository name')
  })

  it('rejects a destination folder that already exists', async () => {
    const parent = makeTempDir()
    const service = makeLiveGithubOpsRpcService({})

    // parent/<something> where <something> exists: clone into the parent of the temp dir
    const parentOfParent = join(parent, '..')
    const existingName = parent.split('/').pop() as string

    const result = await Effect.runPromise(
      service.cloneRepository({
        nameWithOwner: `owner/${existingName}`,
        parentPath: parentOfParent,
        operationId: 'op-2'
      })
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('already exists')
  })

  it('spawns gh repo clone and publishes progress, then done on success', async () => {
    const parent = makeTempDir()
    const eventBus = makeEventBus()
    const events = await collectCloneEvents(eventBus)
    const child = new FakeCloneProcess()
    const spawnCommand = vi.fn().mockReturnValue(child as unknown as ChildProcess)
    const service = makeLiveGithubOpsRpcService({ eventBus, spawnCommand })

    const result = await Effect.runPromise(
      service.cloneRepository({
        nameWithOwner: 'me/repo-a',
        parentPath: parent,
        operationId: 'op-3'
      })
    )

    expect(result.success).toBe(true)
    expect(result.path).toBe(join(parent, 'repo-a'))
    expect(spawnCommand).toHaveBeenCalledWith(
      'gh',
      ['repo', 'clone', 'me/repo-a', join(parent, 'repo-a'), '--', '--progress'],
      { cwd: parent }
    )

    child.stderr.emit('data', Buffer.from('Receiving objects:  50% (10/20)\r'))
    child.emit('close', 0)
    await flushMicrotasks()

    expect(events.map((event) => event.payload)).toEqual([
      { operationId: 'op-3', type: 'progress', stage: 'Receiving objects', percent: 50 },
      { operationId: 'op-3', type: 'done', path: join(parent, 'repo-a') }
    ])
  })

  it('publishes an error event when the clone exits non-zero', async () => {
    const parent = makeTempDir()
    const eventBus = makeEventBus()
    const events = await collectCloneEvents(eventBus)
    const child = new FakeCloneProcess()
    const spawnCommand = vi.fn().mockReturnValue(child as unknown as ChildProcess)
    const service = makeLiveGithubOpsRpcService({ eventBus, spawnCommand })

    await Effect.runPromise(
      service.cloneRepository({
        nameWithOwner: 'me/repo-a',
        parentPath: parent,
        operationId: 'op-4'
      })
    )

    child.stderr.emit('data', Buffer.from('fatal: repository not found\n'))
    child.emit('close', 128)
    await flushMicrotasks()

    expect(events).toHaveLength(1)
    expect(events[0].payload).toMatchObject({
      operationId: 'op-4',
      type: 'error',
      error: expect.stringContaining('repository not found')
    })
  })

  it('publishes a friendly error when gh is missing at spawn time', async () => {
    const parent = makeTempDir()
    const eventBus = makeEventBus()
    const events = await collectCloneEvents(eventBus)
    const child = new FakeCloneProcess()
    const spawnCommand = vi.fn().mockReturnValue(child as unknown as ChildProcess)
    const service = makeLiveGithubOpsRpcService({ eventBus, spawnCommand })

    await Effect.runPromise(
      service.cloneRepository({
        nameWithOwner: 'me/repo-a',
        parentPath: parent,
        operationId: 'op-5'
      })
    )

    child.emit('error', Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }))
    child.emit('close', 1)
    await flushMicrotasks()

    expect(events).toHaveLength(1)
    expect(events[0].payload).toMatchObject({
      operationId: 'op-5',
      type: 'error',
      error: 'GitHub CLI (gh) is not installed'
    })
  })

  it('cancelClone kills the child and suppresses further events', async () => {
    const parent = makeTempDir()
    const eventBus = makeEventBus()
    const events = await collectCloneEvents(eventBus)
    const child = new FakeCloneProcess()
    const spawnCommand = vi.fn().mockReturnValue(child as unknown as ChildProcess)
    const service = makeLiveGithubOpsRpcService({ eventBus, spawnCommand })

    await Effect.runPromise(
      service.cloneRepository({
        nameWithOwner: 'me/repo-a',
        parentPath: parent,
        operationId: 'op-6'
      })
    )

    const cancelResult = await Effect.runPromise(service.cancelClone('op-6'))
    expect(cancelResult.success).toBe(true)
    expect(child.killedSignals).toEqual(['SIGTERM'])

    // Events after cancellation are suppressed.
    child.emit('close', 1)
    await flushMicrotasks()
    expect(events).toHaveLength(0)

    const secondCancel = await Effect.runPromise(service.cancelClone('op-6'))
    expect(secondCancel.success).toBe(false)
  })
})

describe('parseCloneProgress', () => {
  it('maps stages onto the overall progress range', () => {
    expect(parseCloneProgress('remote: Counting objects: 100% (10/10), done.')).toEqual({
      stage: 'Counting objects',
      percent: 5
    })
    expect(parseCloneProgress('Receiving objects:   0% (1/100)')).toEqual({
      stage: 'Receiving objects',
      percent: 10
    })
    expect(parseCloneProgress('Receiving objects: 100% (100/100), done.')).toEqual({
      stage: 'Receiving objects',
      percent: 90
    })
    expect(parseCloneProgress('Resolving deltas: 100% (50/50), done.')).toEqual({
      stage: 'Resolving deltas',
      percent: 100
    })
  })

  it('uses the last progress line in a chunk and ignores noise', () => {
    const chunk =
      "Cloning into 'repo'...\rReceiving objects:  10% (1/10)\rReceiving objects:  80% (8/10)\r"
    expect(parseCloneProgress(chunk)).toEqual({ stage: 'Receiving objects', percent: 74 })
    expect(parseCloneProgress('Some unrelated output')).toBeNull()
  })
})
