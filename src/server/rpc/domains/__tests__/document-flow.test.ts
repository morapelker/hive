import { Cause, Effect, Exit } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { DOCUMENT_FLOW_UPDATED_CHANNEL } from '../../../../shared/document-flow-events'
import type { ServerEvent } from '../../../../shared/rpc/protocol'
import type {
  DocumentRun,
  DocumentRunDetail,
  DocumentRunVerdict
} from '../../../../shared/types/document-flow'
import { makeEventBus } from '../../../events/event-bus'
import type { RpcContext } from '../../router'
import {
  makeDocumentFlowRpcHandlers,
  makeLiveDocumentFlowRpcService,
  type DocumentFlowRpcService
} from '../document-flow'

const run = {
  id: 'run-1',
  project_id: 'project-1',
  title: 'Factory spec',
  status: 'preview'
} as DocumentRun
const detail = { run, items: [], events: [] } as DocumentRunDetail
const verdict: DocumentRunVerdict = {
  status: 'done',
  reason: 'Finished.',
  question: null,
  summary: null,
  migrations: [],
  manualSteps: [],
  confidence: 'high',
  source: 'model',
  classifiedAt: '2026-10-05T10:00:00.000Z'
}

const context = { eventBus: null } as unknown as RpcContext

/** The method names the renderer API (`documentFlowApi`) requests. */
const API_METHODS = [
  'createRun',
  'retryExtraction',
  'get',
  'sourceFile',
  'list',
  'updateRun',
  'updateItem',
  'start',
  'claimRunner',
  'sessionTurn',
  'classify',
  'prepareMerge',
  'merge',
  'verify',
  'commitIntegration',
  'rollbackMerge',
  'finalize',
  'cancel',
  'startMigrations',
  'endMigrations',
  'delete',
  'logEvent',
  'suggestVerifyCommand',
  'addMember'
]

function makeService(overrides: Partial<DocumentFlowRpcService> = {}): DocumentFlowRpcService {
  return {
    createRun: () => Effect.succeed(detail),
    retryExtraction: () => Effect.succeed(detail),
    get: () => Effect.succeed(detail),
    sourceFile: () => Effect.succeed({ path: '/specs/factory.html', exists: true }),
    list: () => Effect.succeed([detail]),
    updateRun: () => Effect.succeed(run),
    updateItem: () => Effect.succeed(detail.items[0]),
    start: () => Effect.succeed(detail),
    addMember: () => Effect.succeed(detail),
    claimRunner: () =>
      Effect.succeed({ owned: true, ownerClientId: 'c1', serverStartedAt: '2026-10-05' }),
    sessionTurn: () => Effect.succeed(null),
    classify: () => Effect.succeed(verdict),
    prepareMerge: () =>
      Effect.succeed({
        state: 'clean' as const,
        conflictedFiles: [],
        committed: false,
        commitsAhead: 1
      }),
    merge: () => Effect.succeed({ success: true }),
    verify: () =>
      Effect.succeed({
        skipped: true,
        ok: true,
        exitCode: null,
        timedOut: false,
        output: '',
        durationMs: 0
      }),
    commitIntegration: () => Effect.succeed({ success: true, committed: false }),
    rollbackMerge: () => Effect.succeed({ success: true }),
    finalize: () => Effect.succeed(detail),
    cancel: () => Effect.succeed(detail),
    startMigrations: () => Effect.succeed(detail),
    endMigrations: () => Effect.succeed(detail),
    delete: () => Effect.succeed(true),
    logEvent: () => Effect.succeed(undefined),
    suggestVerifyCommand: () => Effect.succeed(null),
    ...overrides
  }
}

function call(service: DocumentFlowRpcService, method: string, params: unknown): Promise<unknown> {
  const handler = makeDocumentFlowRpcHandlers(service).get(`documentFlow.${method}`)
  if (!handler) throw new Error(`missing handler for documentFlow.${method}`)
  return Effect.runPromise(handler(params, context) as Effect.Effect<unknown, never, never>)
}

/** The handler fails (not defects) with the ZodError the router turns into VALIDATION_FAILED. */
async function rejectsValidation(service: DocumentFlowRpcService, method: string, params: unknown) {
  const handler = makeDocumentFlowRpcHandlers(service).get(`documentFlow.${method}`)
  if (!handler) throw new Error(`missing handler for documentFlow.${method}`)
  const exit = await Effect.runPromiseExit(handler(params, context))
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    const failure = Cause.failureOption(exit.cause)
    expect(failure._tag).toBe('Some')
    if (failure._tag === 'Some') expect(failure.value).toBeInstanceOf(z.ZodError)
  }
}

describe('documentFlow RPC handlers', () => {
  it('registers exactly the methods the renderer API calls', () => {
    const handlers = makeDocumentFlowRpcHandlers(makeService())
    expect([...handlers.keys()].sort()).toEqual(
      API_METHODS.map((method) => `documentFlow.${method}`).sort()
    )
  })

  it('delegates each method to the service with the parsed params', async () => {
    const createRun = vi.fn(() => Effect.succeed(detail))
    const updateItem = vi.fn(() => Effect.succeed(detail.items[0]))
    const classify = vi.fn(() => Effect.succeed(verdict))
    const list = vi.fn(() => Effect.succeed([detail]))
    const commitIntegration = vi.fn(() => Effect.succeed({ success: true, committed: true }))
    const logEvent = vi.fn(() => Effect.succeed(undefined))
    const service = makeService({
      createRun,
      updateItem,
      classify,
      list,
      commitIntegration,
      logEvent
    })

    const createParams = {
      projectId: 'project-1',
      documentPath: '/specs/factory.html',
      generation: { provider: 'claude-code', model: 'haiku', effort: 'low' }
    }
    await expect(call(service, 'createRun', createParams)).resolves.toEqual(detail)
    expect(createRun).toHaveBeenCalledWith(createParams)

    const patch = {
      status: 'merged',
      status_detail: null,
      verdict,
      nudge_count: 2,
      launch_config: {
        sdk: 'claude-code-cli',
        model: { providerID: 'anthropic', modelID: 'opus', variant: 'ultracode' },
        codexFastMode: false
      }
    }
    await call(service, 'updateItem', { runId: 'run-1', itemId: 'item-1', patch })
    expect(updateItem).toHaveBeenCalledWith('run-1', 'item-1', patch)

    await expect(
      call(service, 'classify', { runId: 'run-1', itemId: 'item-1', finalMessage: 'Done.' })
    ).resolves.toEqual(verdict)
    expect(classify).toHaveBeenCalledWith({
      runId: 'run-1',
      itemId: 'item-1',
      finalMessage: 'Done.'
    })

    await call(service, 'list', {})
    await call(service, 'list', undefined)
    await call(service, 'list', { projectId: 'project-1' })
    expect(list.mock.calls).toEqual([[undefined], [undefined], ['project-1']])

    await call(service, 'commitIntegration', { runId: 'run-1', message: 'Fix checks' })
    expect(commitIntegration).toHaveBeenCalledWith('run-1', 'Fix checks')

    await call(service, 'logEvent', {
      runId: 'run-1',
      type: 'launched',
      message: 'A1 launched',
      data: { sessionId: 's1' }
    })
    expect(logEvent).toHaveBeenCalledWith({
      runId: 'run-1',
      type: 'launched',
      message: 'A1 launched',
      data: { sessionId: 's1' }
    })
  })

  it('passes positional params through for the run and item methods', async () => {
    const calls: Record<string, unknown[]> = {}
    const record =
      <A>(name: string, value: A) =>
      (...args: unknown[]): Effect.Effect<A, never, never> => {
        calls[name] = args
        return Effect.succeed(value)
      }
    const service = makeService({
      get: record('get', detail),
      sourceFile: record('sourceFile', { path: '/specs/factory.html', exists: true }),
      updateRun: record('updateRun', run),
      start: record('start', detail),
      claimRunner: record('claimRunner', {
        owned: true,
        ownerClientId: 'c1',
        serverStartedAt: 'now'
      }),
      sessionTurn: record('sessionTurn', null),
      prepareMerge: record('prepareMerge', {
        state: 'clean' as const,
        conflictedFiles: [],
        committed: false,
        commitsAhead: 0
      }),
      merge: record('merge', { success: true }),
      verify: record('verify', {
        skipped: true,
        ok: true,
        exitCode: null,
        timedOut: false,
        output: '',
        durationMs: 0
      }),
      rollbackMerge: record('rollbackMerge', { success: true }),
      finalize: record('finalize', detail),
      cancel: record('cancel', detail),
      delete: record('delete', true),
      suggestVerifyCommand: record('suggestVerifyCommand', 'pnpm run lint'),
      retryExtraction: record('retryExtraction', detail)
    })

    await call(service, 'get', { runId: 'run-1' })
    await call(service, 'sourceFile', { runId: 'run-1' })
    await call(service, 'updateRun', { runId: 'run-1', patch: { status: 'paused' } })
    await call(service, 'start', { runId: 'run-1' })
    await call(service, 'claimRunner', { runId: 'run-1', clientId: 'client-1' })
    await call(service, 'sessionTurn', { sessionId: 'session-1' })
    await call(service, 'prepareMerge', { runId: 'run-1', itemId: 'item-1' })
    await call(service, 'merge', { runId: 'run-1', itemId: 'item-1' })
    await call(service, 'verify', { runId: 'run-1' })
    await call(service, 'rollbackMerge', { runId: 'run-1', itemId: 'item-1' })
    await call(service, 'finalize', { runId: 'run-1' })
    await call(service, 'cancel', { runId: 'run-1' })
    await call(service, 'delete', { runId: 'run-1' })
    await call(service, 'suggestVerifyCommand', { projectId: 'project-1' })
    await call(service, 'retryExtraction', { runId: 'run-1', generation: null })

    expect(calls).toEqual({
      get: ['run-1'],
      sourceFile: ['run-1'],
      updateRun: ['run-1', { status: 'paused' }],
      // `start` takes the optional default SDK positionally; the handler passes it as given.
      start: ['run-1', undefined],
      claimRunner: ['run-1', 'client-1'],
      sessionTurn: ['session-1'],
      prepareMerge: ['run-1', 'item-1'],
      merge: ['run-1', 'item-1'],
      verify: ['run-1'],
      rollbackMerge: ['run-1', 'item-1'],
      finalize: ['run-1'],
      cancel: ['run-1'],
      delete: ['run-1'],
      suggestVerifyCommand: ['project-1'],
      retryExtraction: [{ runId: 'run-1', generation: null }]
    })
  })

  it('hands the add-member params to the service, and refuses a bad branch or extra fields', async () => {
    const addMember = vi.fn(() => Effect.succeed(detail))
    const service = makeService({ addMember })

    await expect(
      call(service, 'addMember', { runId: 'run-1', projectId: 'mobile', baseBranch: 'develop' })
    ).resolves.toEqual(detail)
    expect(addMember).toHaveBeenCalledWith({
      runId: 'run-1',
      projectId: 'mobile',
      baseBranch: 'develop'
    })
    await call(service, 'addMember', { runId: 'run-1', projectId: 'mobile', baseBranch: null })
    expect(addMember).toHaveBeenLastCalledWith({
      runId: 'run-1',
      projectId: 'mobile',
      baseBranch: null
    })
    await call(service, 'addMember', { runId: 'run-1', projectId: 'mobile' })
    expect(addMember).toHaveBeenLastCalledWith({ runId: 'run-1', projectId: 'mobile' })

    await rejectsValidation(service, 'addMember', { runId: 'run-1' })
    await rejectsValidation(service, 'addMember', { runId: 'run-1', projectId: '' })
    await rejectsValidation(service, 'addMember', {
      runId: 'run-1',
      projectId: 'mobile',
      baseBranch: '--upload-pack=x'
    })
    await rejectsValidation(service, 'addMember', {
      runId: 'run-1',
      projectId: 'mobile',
      worktreeId: 'wt'
    })
  })

  it('passes the migration session params through positionally', async () => {
    const startMigrations = vi.fn((..._args: unknown[]) => Effect.succeed(detail))
    const endMigrations = vi.fn((..._args: unknown[]) => Effect.succeed(detail))
    const service = makeService({ startMigrations, endMigrations })

    await expect(
      call(service, 'startMigrations', { runId: 'run-1', sessionId: 'session-1' })
    ).resolves.toEqual(detail)
    await expect(
      call(service, 'endMigrations', {
        runId: 'run-1',
        sessionId: 'session-1',
        outcome: 'finished'
      })
    ).resolves.toEqual(detail)
    await call(service, 'endMigrations', {
      runId: 'run-2',
      sessionId: 'session-2',
      outcome: 'stopped'
    })

    expect(startMigrations.mock.calls).toEqual([['run-1', 'session-1']])
    expect(endMigrations.mock.calls).toEqual([
      ['run-1', 'session-1', 'finished'],
      ['run-2', 'session-2', 'stopped']
    ])
  })

  it('rejects migration session params that are incomplete, mis-shaped or carry extra fields', async () => {
    const startMigrations = vi.fn(() => Effect.succeed(detail))
    const endMigrations = vi.fn(() => Effect.succeed(detail))
    const service = makeService({ startMigrations, endMigrations })

    await rejectsValidation(service, 'startMigrations', undefined)
    await rejectsValidation(service, 'startMigrations', { runId: 'run-1' })
    await rejectsValidation(service, 'startMigrations', { sessionId: 'session-1' })
    await rejectsValidation(service, 'startMigrations', { runId: 'run-1', sessionId: '' })
    await rejectsValidation(service, 'startMigrations', { runId: '', sessionId: 'session-1' })
    await rejectsValidation(service, 'startMigrations', { runId: 'run-1', sessionId: null })
    await rejectsValidation(service, 'startMigrations', { runId: 'run-1', sessionId: 7 })
    // The outcome belongs to the end of a session, not to its start.
    await rejectsValidation(service, 'startMigrations', {
      runId: 'run-1',
      sessionId: 'session-1',
      outcome: 'finished'
    })

    await rejectsValidation(service, 'endMigrations', { runId: 'run-1', outcome: 'stopped' })
    await rejectsValidation(service, 'endMigrations', {
      sessionId: 'session-1',
      outcome: 'stopped'
    })
    await rejectsValidation(service, 'endMigrations', { runId: 'run-1', sessionId: 'session-1' })
    await rejectsValidation(service, 'endMigrations', {
      runId: 'run-1',
      sessionId: '',
      outcome: 'finished'
    })
    for (const outcome of ['cancelled', 'failed', 'Finished', '', null, true]) {
      await rejectsValidation(service, 'endMigrations', {
        runId: 'run-1',
        sessionId: 'session-1',
        outcome
      })
    }
    await rejectsValidation(service, 'endMigrations', {
      runId: 'run-1',
      sessionId: 'session-1',
      outcome: 'stopped',
      force: true
    })

    expect(startMigrations).not.toHaveBeenCalled()
    expect(endMigrations).not.toHaveBeenCalled()
  })

  it('surfaces a refused migration session to the caller', async () => {
    const service = makeService({
      startMigrations: () =>
        Effect.fail(new Error('The migrations of this run are already being executed.'))
    })

    await expect(
      call(service, 'startMigrations', { runId: 'run-1', sessionId: 'session-2' })
    ).rejects.toThrow('The migrations of this run are already being executed.')
  })

  it('rejects unknown fields, at the top level and inside patches', async () => {
    const service = makeService()

    await rejectsValidation(service, 'get', { runId: 'run-1', extra: true })
    await rejectsValidation(service, 'sourceFile', {})
    await rejectsValidation(service, 'sourceFile', { runId: 'run-1', extra: true })
    await rejectsValidation(service, 'list', { projectId: 'p', extra: 1 })
    await rejectsValidation(service, 'updateRun', {
      runId: 'run-1',
      patch: { title: 'x', report: null }
    })
    await rejectsValidation(service, 'updateRun', {
      runId: 'run-1',
      patch: { config: { unknownOption: 1 } }
    })
    await rejectsValidation(service, 'updateItem', {
      runId: 'r',
      itemId: 'i',
      patch: { position: 3 }
    })
    await rejectsValidation(service, 'updateItem', {
      runId: 'r',
      itemId: 'i',
      patch: { pre_merge_sha: 'abc' }
    })
    await rejectsValidation(service, 'updateItem', {
      runId: 'r',
      itemId: 'i',
      patch: { verdict: { ...verdict, extra: true } }
    })
    await rejectsValidation(service, 'createRun', {
      projectId: 'p',
      documentPath: '/x',
      title: 'nope'
    })
  })

  it('rejects bad enums and shapes', async () => {
    const service = makeService()

    await rejectsValidation(service, 'updateRun', {
      runId: 'run-1',
      patch: { status: 'completed' }
    })
    await rejectsValidation(service, 'updateRun', {
      runId: 'run-1',
      patch: { status: 'extracting' }
    })
    await rejectsValidation(service, 'updateItem', {
      runId: 'r',
      itemId: 'i',
      patch: { status: 'done' }
    })
    await rejectsValidation(service, 'updateItem', {
      runId: 'r',
      itemId: 'i',
      patch: { verdict: { ...verdict, status: 'maybe' } }
    })
    await rejectsValidation(service, 'updateItem', {
      runId: 'r',
      itemId: 'i',
      patch: { nudge_count: -1 }
    })
    await rejectsValidation(service, 'updateItem', {
      runId: 'r',
      itemId: 'i',
      patch: { launch_config: { sdk: 'terminal', model: null, codexFastMode: false } }
    })
    await rejectsValidation(service, 'updateRun', {
      runId: 'run-1',
      patch: { config: { generation: { provider: 'gemini' } } }
    })
    await rejectsValidation(service, 'updateRun', {
      runId: 'run-1',
      patch: { config: { promptStyle: 'medium' } }
    })
    await rejectsValidation(service, 'updateRun', {
      runId: 'run-1',
      patch: { config: { baseBranch: '--force' } }
    })
    await rejectsValidation(service, 'updateRun', {
      runId: 'run-1',
      patch: { config: { baseBranch: 'a b' } }
    })
    await rejectsValidation(service, 'createRun', {
      projectId: 'p',
      documentPath: '/x',
      generation: 'claude'
    })
    await rejectsValidation(service, 'createRun', { projectId: '', documentPath: '/x' })
    await rejectsValidation(service, 'commitIntegration', { runId: 'r', message: '' })
    await rejectsValidation(service, 'logEvent', { runId: 'r', type: '', message: 'x' })
    await rejectsValidation(service, 'claimRunner', { runId: 'r' })
    await rejectsValidation(service, 'sessionTurn', {})
  })

  it('accepts null where the contract allows it', async () => {
    const updateItem = vi.fn(() => Effect.succeed(detail.items[0]))
    const service = makeService({ updateItem })

    const patch = {
      launch_config: null,
      verdict: null,
      status_detail: null,
      session_id: null,
      retry_at: null,
      finished_at: null
    }
    await call(service, 'updateItem', { runId: 'r', itemId: 'i', patch })
    expect(updateItem).toHaveBeenCalledWith('r', 'i', patch)

    await call(service, 'updateRun', {
      runId: 'r',
      patch: { config: { verifyCommand: null, defaultLaunch: null, baseBranch: null } }
    })
    await call(service, 'updateRun', { runId: 'r', patch: { config: { promptStyle: 'small' } } })
    await call(service, 'updateRun', { runId: 'r', patch: { config: { promptStyle: 'full' } } })
    await call(service, 'createRun', { projectId: 'p', documentPath: '/x', generation: null })
    await call(service, 'classify', { runId: 'r', itemId: 'i', finalMessage: null })
    await call(service, 'logEvent', { runId: 'r', itemId: null, type: 't', message: '' })
  })

  it('passes the verification of a ticket and the run-wide skip through', async () => {
    const updateItem = vi.fn(() => Effect.succeed(detail.items[0]))
    const updateRun = vi.fn(() => Effect.succeed(run))
    const service = makeService({ updateItem, updateRun })

    await call(service, 'updateItem', {
      runId: 'run-1',
      itemId: 'item-1',
      patch: { verification: ['playwright', 'tests'] }
    })
    await call(service, 'updateItem', {
      runId: 'run-1',
      itemId: 'item-1',
      patch: { verification: [] }
    })
    expect(updateItem.mock.calls).toEqual([
      ['run-1', 'item-1', { verification: ['playwright', 'tests'] }],
      ['run-1', 'item-1', { verification: [] }]
    ])

    await call(service, 'updateRun', {
      runId: 'run-1',
      patch: { config: { verificationDisabled: true } }
    })
    await call(service, 'updateRun', {
      runId: 'run-1',
      patch: { config: { verificationDisabled: false } }
    })
    expect(updateRun.mock.calls).toEqual([
      ['run-1', { config: { verificationDisabled: true } }],
      ['run-1', { config: { verificationDisabled: false } }]
    ])
  })

  it('passes the connection-project fields of a run and its tickets through', async () => {
    const updateItem = vi.fn(() => Effect.succeed(detail.items[0]))
    const updateRun = vi.fn(() => Effect.succeed(run))
    const service = makeService({ updateItem, updateRun })
    const members = [
      {
        project_id: 'member-web',
        worktree_id: 'wt-web-a1',
        branch_name: 'a1-coupons',
        pre_merge_sha: null,
        merge_sha: null
      },
      {
        project_id: 'member-api',
        worktree_id: 'wt-api-a1',
        branch_name: 'a1-coupons',
        pre_merge_sha: 'pre1',
        merge_sha: 'merge1'
      }
    ]

    await call(service, 'updateItem', {
      runId: 'run-1',
      itemId: 'item-1',
      patch: { connection_id: 'connection-a1', members, branch_name: 'a1-coupons' }
    })
    await call(service, 'updateItem', {
      runId: 'run-1',
      itemId: 'item-1',
      patch: { connection_id: null, members: null }
    })
    expect(updateItem.mock.calls).toEqual([
      ['run-1', 'item-1', { connection_id: 'connection-a1', members, branch_name: 'a1-coupons' }],
      ['run-1', 'item-1', { connection_id: null, members: null }]
    ])

    const config = {
      memberBaseBranches: { 'member-web': 'main', 'member-api': null },
      memberVerifyCommands: { 'member-web': 'pnpm check', 'member-api': null }
    }
    await call(service, 'updateRun', { runId: 'run-1', patch: { config } })
    await call(service, 'updateRun', {
      runId: 'run-1',
      patch: { config: { memberBaseBranches: {}, memberVerifyCommands: {} } }
    })
    expect(updateRun.mock.calls).toEqual([
      ['run-1', { config }],
      ['run-1', { config: { memberBaseBranches: {}, memberVerifyCommands: {} } }]
    ])
  })

  it('rejects connection-project fields that are mis-shaped', async () => {
    const updateItem = vi.fn(() => Effect.succeed(detail.items[0]))
    const updateRun = vi.fn(() => Effect.succeed(run))
    const service = makeService({ updateItem, updateRun })
    const member = {
      project_id: 'member-web',
      worktree_id: 'wt-web-a1',
      branch_name: 'a1-coupons',
      pre_merge_sha: null,
      merge_sha: null
    }

    for (const members of [
      [{ ...member, project_id: '' }],
      [{ ...member, worktree_id: 1 }],
      [{ ...member, extra: true }],
      [{ project_id: 'member-web', worktree_id: 'wt', branch_name: 'b' }],
      'none',
      [null]
    ]) {
      await rejectsValidation(service, 'updateItem', {
        runId: 'r',
        itemId: 'i',
        patch: { members }
      })
    }
    await rejectsValidation(service, 'updateItem', {
      runId: 'r',
      itemId: 'i',
      patch: { connection_id: 7 }
    })
    // A member base branch ends up as a git argument, like the run-wide one.
    for (const memberBaseBranches of [
      { 'member-web': '--force' },
      { 'member-web': 'a b' },
      { 'member-web': 3 },
      ['main'],
      'main'
    ]) {
      await rejectsValidation(service, 'updateRun', {
        runId: 'run-1',
        patch: { config: { memberBaseBranches } }
      })
    }
    for (const memberVerifyCommands of [{ 'member-web': 1 }, ['pnpm check'], 'pnpm check']) {
      await rejectsValidation(service, 'updateRun', {
        runId: 'run-1',
        patch: { config: { memberVerifyCommands } }
      })
    }

    expect(updateItem).not.toHaveBeenCalled()
    expect(updateRun).not.toHaveBeenCalled()
  })

  it('rejects a verification that is not a list of the known methods and a skip that is not a boolean', async () => {
    const updateItem = vi.fn(() => Effect.succeed(detail.items[0]))
    const updateRun = vi.fn(() => Effect.succeed(run))
    const service = makeService({ updateItem, updateRun })

    for (const verification of [['foo'], ['tests', 'foo'], 'tests', null, [1], { tests: true }]) {
      await rejectsValidation(service, 'updateItem', {
        runId: 'r',
        itemId: 'i',
        patch: { verification }
      })
    }
    // What extraction suggested is not the caller's to change.
    await rejectsValidation(service, 'updateItem', {
      runId: 'r',
      itemId: 'i',
      patch: { verification_suggested: ['tests'] }
    })
    await rejectsValidation(service, 'updateItem', {
      runId: 'r',
      itemId: 'i',
      patch: { verification_reason: 'because' }
    })
    for (const verificationDisabled of ['yes', 1, null, 'true']) {
      await rejectsValidation(service, 'updateRun', {
        runId: 'run-1',
        patch: { config: { verificationDisabled } }
      })
    }

    expect(updateItem).not.toHaveBeenCalled()
    expect(updateRun).not.toHaveBeenCalled()
  })

  it('surfaces service failures to the caller', async () => {
    const service = makeService({
      start: () => Effect.fail(new Error('Select at least one ticket to launch.'))
    })

    await expect(call(service, 'start', { runId: 'run-1' })).rejects.toThrow(
      'Select at least one ticket to launch.'
    )
  })
})

describe('makeLiveDocumentFlowRpcService', () => {
  it('publishes service events on the documentFlow:updated channel', async () => {
    const eventBus = makeEventBus()
    const received: ServerEvent[] = []
    await Effect.runPromise(
      eventBus.subscribe(DOCUMENT_FLOW_UPDATED_CHANNEL, (event) => received.push(event))
    )
    const getDocumentFlowService = vi.fn()
    vi.doMock('../../../../main/services/document-flow/document-flow-service', () => ({
      getDocumentFlowService
    }))
    getDocumentFlowService.mockImplementation(async (publish: (event: unknown) => void) => {
      publish({ runId: 'run-1', projectId: 'project-1', reason: 'run' })
      return { get: () => detail }
    })

    const service = makeLiveDocumentFlowRpcService(eventBus)
    await expect(Effect.runPromise(service.get('run-1'))).resolves.toEqual(detail)

    expect(getDocumentFlowService).toHaveBeenCalledWith(expect.any(Function))
    await vi.waitFor(() =>
      expect(received).toEqual([
        {
          channel: DOCUMENT_FLOW_UPDATED_CHANNEL,
          payload: { runId: 'run-1', projectId: 'project-1', reason: 'run' }
        }
      ])
    )
    vi.doUnmock('../../../../main/services/document-flow/document-flow-service')
  })
})
