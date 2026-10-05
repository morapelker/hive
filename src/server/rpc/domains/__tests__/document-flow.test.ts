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
  'delete',
  'logEvent',
  'suggestVerifyCommand'
]

function makeService(overrides: Partial<DocumentFlowRpcService> = {}): DocumentFlowRpcService {
  return {
    createRun: () => Effect.succeed(detail),
    retryExtraction: () => Effect.succeed(detail),
    get: () => Effect.succeed(detail),
    list: () => Effect.succeed([detail]),
    updateRun: () => Effect.succeed(run),
    updateItem: () => Effect.succeed(detail.items[0]),
    start: () => Effect.succeed(detail),
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
      updateRun: ['run-1', { status: 'paused' }],
      start: ['run-1'],
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

  it('rejects unknown fields, at the top level and inside patches', async () => {
    const service = makeService()

    await rejectsValidation(service, 'get', { runId: 'run-1', extra: true })
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
