import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { makeEventBus } from '../events/event-bus'
import { makeRpcRouter } from '../rpc/router'
import type { OpenCodeOpsRpcService } from '../rpc/domains/opencode-ops'

describe('agent RPC mocked provider', () => {
  it('routes opencodeOps.connect to the injected provider service', async () => {
    const connect = vi.fn(() => Effect.succeed({ success: true, sessionId: 'agent-session-1' }))
    const service = { connect } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connect-1',
        method: 'opencodeOps.connect',
        params: { worktreePath: '/repo', hiveSessionId: 'hive-session-1' }
      })
    )

    expect(connect).toHaveBeenCalledWith('/repo', 'hive-session-1')
    expect(response).toEqual({
      id: 'connect-1',
      ok: true,
      value: { success: true, sessionId: 'agent-session-1' }
    })
  })

  it('validates opencodeOps.connect params before calling the provider service', async () => {
    const connect = vi.fn(() => Effect.succeed({ success: true, sessionId: 'unused' }))
    const service = { connect } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connect-invalid',
        method: 'opencodeOps.connect',
        params: { worktreePath: '', hiveSessionId: 'hive-session-1' }
      })
    )

    expect(connect).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'connect-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes opencodeOps.reconnect to the injected provider service', async () => {
    const reconnect = vi.fn(() =>
      Effect.succeed({
        success: true,
        sessionStatus: 'busy' as const,
        revertMessageID: 'message-1'
      })
    )
    const service = { reconnect } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'reconnect-1',
        method: 'opencodeOps.reconnect',
        params: {
          worktreePath: '/repo',
          opencodeSessionId: 'agent-session-1',
          hiveSessionId: 'hive-session-1'
        }
      })
    )

    expect(reconnect).toHaveBeenCalledWith('/repo', 'agent-session-1', 'hive-session-1')
    expect(response).toEqual({
      id: 'reconnect-1',
      ok: true,
      value: {
        success: true,
        sessionStatus: 'busy',
        revertMessageID: 'message-1'
      }
    })
  })

  it('validates opencodeOps.reconnect params before calling the provider service', async () => {
    const reconnect = vi.fn(() => Effect.succeed({ success: true }))
    const service = { reconnect } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'reconnect-invalid',
        method: 'opencodeOps.reconnect',
        params: {
          worktreePath: '/repo',
          opencodeSessionId: '',
          hiveSessionId: 'hive-session-1'
        }
      })
    )

    expect(reconnect).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'reconnect-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes opencodeOps.prompt to the injected provider service', async () => {
    const messageOrParts = [
      { type: 'text' as const, text: 'Review this file' },
      {
        type: 'file' as const,
        mime: 'text/plain',
        url: 'file:///repo/a.txt',
        filename: 'a.txt'
      }
    ]
    const model = { providerID: 'anthropic', modelID: 'sonnet', variant: 'high' }
    const options = { codexFastMode: true }
    const prompt = vi.fn(() => Effect.succeed({ success: true }))
    const service = { prompt } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'prompt-1',
        method: 'opencodeOps.prompt',
        params: {
          worktreePath: '/repo',
          opencodeSessionId: 'agent-session-1',
          messageOrParts,
          model,
          options
        }
      })
    )

    expect(prompt).toHaveBeenCalledWith(
      '/repo',
      'agent-session-1',
      messageOrParts,
      model,
      options
    )
    expect(response).toEqual({
      id: 'prompt-1',
      ok: true,
      value: { success: true }
    })
  })

  it('validates opencodeOps.prompt params before calling the provider service', async () => {
    const prompt = vi.fn(() => Effect.succeed({ success: true }))
    const service = { prompt } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'prompt-invalid',
        method: 'opencodeOps.prompt',
        params: {
          worktreePath: '/repo',
          opencodeSessionId: 'agent-session-1',
          messageOrParts: [{ type: 'file', mime: 'text/plain', url: 42 }]
        }
      })
    )

    expect(prompt).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'prompt-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes opencodeOps.abort to the injected provider service', async () => {
    const abort = vi.fn(() => Effect.succeed({ success: true }))
    const service = { abort } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'abort-1',
        method: 'opencodeOps.abort',
        params: { worktreePath: '/repo', opencodeSessionId: 'agent-session-1' }
      })
    )

    expect(abort).toHaveBeenCalledWith('/repo', 'agent-session-1')
    expect(response).toEqual({
      id: 'abort-1',
      ok: true,
      value: { success: true }
    })
  })

  it('validates opencodeOps.abort params before calling the provider service', async () => {
    const abort = vi.fn(() => Effect.succeed({ success: true }))
    const service = { abort } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'abort-invalid',
        method: 'opencodeOps.abort',
        params: { worktreePath: '/repo', opencodeSessionId: '' }
      })
    )

    expect(abort).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'abort-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes opencodeOps.steer to the injected provider service', async () => {
    const steer = vi.fn(() =>
      Effect.succeed({
        success: true,
        insertedMessageId: 'message-inserted',
        nextAssistantMessageId: 'message-next',
        turnId: 'turn-1'
      })
    )
    const service = { steer } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'steer-1',
        method: 'opencodeOps.steer',
        params: {
          worktreePath: '/repo',
          opencodeSessionId: 'agent-session-1',
          message: 'continue with the next change'
        }
      })
    )

    expect(steer).toHaveBeenCalledWith(
      '/repo',
      'agent-session-1',
      'continue with the next change'
    )
    expect(response).toEqual({
      id: 'steer-1',
      ok: true,
      value: {
        success: true,
        insertedMessageId: 'message-inserted',
        nextAssistantMessageId: 'message-next',
        turnId: 'turn-1'
      }
    })
  })

  it('validates opencodeOps.steer params before calling the provider service', async () => {
    const steer = vi.fn(() => Effect.succeed({ success: true }))
    const service = { steer } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'steer-invalid',
        method: 'opencodeOps.steer',
        params: {
          worktreePath: '/repo',
          opencodeSessionId: 'agent-session-1',
          message: 42
        }
      })
    )

    expect(steer).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'steer-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes opencodeOps.disconnect to the injected provider service', async () => {
    const disconnect = vi.fn(() => Effect.succeed({ success: true }))
    const service = { disconnect } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'disconnect-1',
        method: 'opencodeOps.disconnect',
        params: { worktreePath: '/repo', opencodeSessionId: 'agent-session-1' }
      })
    )

    expect(disconnect).toHaveBeenCalledWith('/repo', 'agent-session-1')
    expect(response).toEqual({
      id: 'disconnect-1',
      ok: true,
      value: { success: true }
    })
  })

  it('validates opencodeOps.disconnect params before calling the provider service', async () => {
    const disconnect = vi.fn(() => Effect.succeed({ success: true }))
    const service = { disconnect } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'disconnect-invalid',
        method: 'opencodeOps.disconnect',
        params: { worktreePath: '', opencodeSessionId: 'agent-session-1' }
      })
    )

    expect(disconnect).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'disconnect-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes opencodeOps.getMessages to the injected provider service', async () => {
    const messages = [
      { id: 'message-1', role: 'user', content: 'Start here' },
      { id: 'message-2', role: 'assistant', parts: [{ type: 'text', text: 'Continuing' }] }
    ]
    const getMessages = vi.fn(() => Effect.succeed({ success: true, messages }))
    const service = { getMessages } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'get-messages-1',
        method: 'opencodeOps.getMessages',
        params: { worktreePath: '/repo', opencodeSessionId: 'agent-session-1' }
      })
    )

    expect(getMessages).toHaveBeenCalledWith('/repo', 'agent-session-1')
    expect(response).toEqual({
      id: 'get-messages-1',
      ok: true,
      value: { success: true, messages }
    })
  })

  it('validates opencodeOps.getMessages params before calling the provider service', async () => {
    const getMessages = vi.fn(() => Effect.succeed({ success: true, messages: [] }))
    const service = { getMessages } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'get-messages-invalid',
        method: 'opencodeOps.getMessages',
        params: { worktreePath: '/repo', opencodeSessionId: '' }
      })
    )

    expect(getMessages).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'get-messages-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes opencodeOps.refreshFromThread to the injected provider service', async () => {
    const refreshFromThread = vi.fn(() => Effect.succeed({ success: true, count: 2 }))
    const service = { refreshFromThread } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'refresh-from-thread-1',
        method: 'opencodeOps.refreshFromThread',
        params: { worktreePath: '/repo', opencodeSessionId: 'agent-session-1' }
      })
    )

    expect(refreshFromThread).toHaveBeenCalledWith('/repo', 'agent-session-1')
    expect(response).toEqual({
      id: 'refresh-from-thread-1',
      ok: true,
      value: { success: true, count: 2 }
    })
  })

  it('validates opencodeOps.refreshFromThread params before calling the provider service', async () => {
    const refreshFromThread = vi.fn(() => Effect.succeed({ success: true }))
    const service = { refreshFromThread } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'refresh-from-thread-invalid',
        method: 'opencodeOps.refreshFromThread',
        params: { worktreePath: '/repo', opencodeSessionId: '' }
      })
    )

    expect(refreshFromThread).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'refresh-from-thread-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes opencodeOps.listModels to the injected provider service', async () => {
    const providers = [{ id: 'codex', models: { 'gpt-5': { id: 'gpt-5', name: 'GPT-5' } } }]
    const listModels = vi.fn(() => Effect.succeed({ success: true, providers }))
    const service = { listModels } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'list-models-1',
        method: 'opencodeOps.listModels',
        params: { agentSdk: 'codex' }
      })
    )

    expect(listModels).toHaveBeenCalledWith({ agentSdk: 'codex' })
    expect(response).toEqual({
      id: 'list-models-1',
      ok: true,
      value: { success: true, providers }
    })
  })

  it('validates opencodeOps.listModels params before calling the provider service', async () => {
    const listModels = vi.fn(() => Effect.succeed({ success: true, providers: {} }))
    const service = { listModels } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'list-models-invalid',
        method: 'opencodeOps.listModels',
        params: { agentSdk: 'missing-sdk' }
      })
    )

    expect(listModels).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'list-models-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes opencodeOps.setModel to the injected provider service', async () => {
    const model = {
      providerID: 'openai',
      modelID: 'gpt-5',
      variant: 'high',
      agentSdk: 'codex' as const
    }
    const setModel = vi.fn(() => Effect.succeed({ success: true }))
    const service = { setModel } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const selectResponse = await Effect.runPromise(
      router.handle({
        id: 'set-model-1',
        method: 'opencodeOps.setModel',
        params: model
      })
    )
    const resetResponse = await Effect.runPromise(
      router.handle({
        id: 'set-model-reset',
        method: 'opencodeOps.setModel',
        params: null
      })
    )

    expect(setModel).toHaveBeenNthCalledWith(1, model)
    expect(setModel).toHaveBeenNthCalledWith(2, null)
    expect(selectResponse).toEqual({
      id: 'set-model-1',
      ok: true,
      value: { success: true }
    })
    expect(resetResponse).toEqual({
      id: 'set-model-reset',
      ok: true,
      value: { success: true }
    })
  })

  it('validates opencodeOps.setModel params before calling the provider service', async () => {
    const setModel = vi.fn(() => Effect.succeed({ success: true }))
    const service = { setModel } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'set-model-invalid',
        method: 'opencodeOps.setModel',
        params: { providerID: 'openai', modelID: 'gpt-5', agentSdk: 'missing-sdk' }
      })
    )

    expect(setModel).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'set-model-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes opencodeOps.modelInfo to the injected provider service', async () => {
    const model = {
      id: 'gpt-5',
      name: 'GPT-5',
      limit: { context: 400000, input: 272000, output: 128000 }
    }
    const modelInfo = vi.fn(() => Effect.succeed({ success: true, model }))
    const service = { modelInfo } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'model-info-1',
        method: 'opencodeOps.modelInfo',
        params: { worktreePath: '/repo', modelId: 'gpt-5', agentSdk: 'codex' }
      })
    )

    expect(modelInfo).toHaveBeenCalledWith('/repo', 'gpt-5', 'codex')
    expect(response).toEqual({
      id: 'model-info-1',
      ok: true,
      value: { success: true, model }
    })
  })

  it('validates opencodeOps.modelInfo params before calling the provider service', async () => {
    const modelInfo = vi.fn(() => Effect.succeed({ success: true }))
    const service = { modelInfo } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'model-info-invalid',
        method: 'opencodeOps.modelInfo',
        params: { worktreePath: '/repo', modelId: '', agentSdk: 'codex' }
      })
    )

    expect(modelInfo).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'model-info-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes opencodeOps.questionReply to the injected provider service', async () => {
    const answers = [
      ['yes', 'run tests'],
      ['no', 'skip deploy']
    ]
    const questionReply = vi.fn(() => Effect.succeed({ success: true }))
    const service = { questionReply } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'question-reply-1',
        method: 'opencodeOps.questionReply',
        params: {
          requestId: 'question-1',
          answers,
          worktreePath: '/repo'
        }
      })
    )

    expect(questionReply).toHaveBeenCalledWith('question-1', answers, '/repo')
    expect(response).toEqual({
      id: 'question-reply-1',
      ok: true,
      value: { success: true }
    })
  })

  it('validates opencodeOps.questionReply params before calling the provider service', async () => {
    const questionReply = vi.fn(() => Effect.succeed({ success: true }))
    const service = { questionReply } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'question-reply-invalid',
        method: 'opencodeOps.questionReply',
        params: { requestId: 'question-1', answers: [['yes'], [42]], worktreePath: '/repo' }
      })
    )

    expect(questionReply).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'question-reply-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes opencodeOps.questionReject to the injected provider service', async () => {
    const questionReject = vi.fn(() => Effect.succeed({ success: true }))
    const service = { questionReject } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'question-reject-1',
        method: 'opencodeOps.questionReject',
        params: {
          requestId: 'question-1',
          worktreePath: '/repo'
        }
      })
    )

    expect(questionReject).toHaveBeenCalledWith('question-1', '/repo')
    expect(response).toEqual({
      id: 'question-reject-1',
      ok: true,
      value: { success: true }
    })
  })

  it('validates opencodeOps.questionReject params before calling the provider service', async () => {
    const questionReject = vi.fn(() => Effect.succeed({ success: true }))
    const service = { questionReject } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'question-reject-invalid',
        method: 'opencodeOps.questionReject',
        params: { requestId: '', worktreePath: '/repo' }
      })
    )

    expect(questionReject).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'question-reject-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes opencodeOps.planApprove to the injected provider service', async () => {
    const planApprove = vi.fn(() => Effect.succeed({ success: true }))
    const service = { planApprove } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'plan-approve-1',
        method: 'opencodeOps.planApprove',
        params: {
          worktreePath: '/repo',
          hiveSessionId: 'hive-session-1',
          requestId: 'plan-1'
        }
      })
    )

    expect(planApprove).toHaveBeenCalledWith('/repo', 'hive-session-1', 'plan-1')
    expect(response).toEqual({
      id: 'plan-approve-1',
      ok: true,
      value: { success: true }
    })
  })

  it('validates opencodeOps.planApprove params before calling the provider service', async () => {
    const planApprove = vi.fn(() => Effect.succeed({ success: true }))
    const service = { planApprove } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'plan-approve-invalid',
        method: 'opencodeOps.planApprove',
        params: { worktreePath: '/repo', hiveSessionId: '', requestId: 'plan-1' }
      })
    )

    expect(planApprove).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'plan-approve-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes opencodeOps.planReject to the injected provider service', async () => {
    const planReject = vi.fn(() => Effect.succeed({ success: true }))
    const service = { planReject } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'plan-reject-1',
        method: 'opencodeOps.planReject',
        params: {
          worktreePath: '/repo',
          hiveSessionId: 'hive-session-1',
          feedback: 'Need a smaller plan',
          requestId: 'plan-1'
        }
      })
    )

    expect(planReject).toHaveBeenCalledWith(
      '/repo',
      'hive-session-1',
      'Need a smaller plan',
      'plan-1'
    )
    expect(response).toEqual({
      id: 'plan-reject-1',
      ok: true,
      value: { success: true }
    })
  })

  it('validates opencodeOps.planReject params before calling the provider service', async () => {
    const planReject = vi.fn(() => Effect.succeed({ success: true }))
    const service = { planReject } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'plan-reject-invalid',
        method: 'opencodeOps.planReject',
        params: {
          worktreePath: '/repo',
          hiveSessionId: 'hive-session-1',
          requestId: 'plan-1'
        }
      })
    )

    expect(planReject).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'plan-reject-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes opencodeOps.permissionReply to the injected provider service', async () => {
    const permissionReply = vi.fn(() => Effect.succeed({ success: true }))
    const service = { permissionReply } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'permission-reply-1',
        method: 'opencodeOps.permissionReply',
        params: {
          requestId: 'permission-1',
          reply: 'once',
          worktreePath: '/repo',
          message: 'Approved for this run'
        }
      })
    )

    expect(permissionReply).toHaveBeenCalledWith(
      'permission-1',
      'once',
      '/repo',
      'Approved for this run'
    )
    expect(response).toEqual({
      id: 'permission-reply-1',
      ok: true,
      value: { success: true }
    })
  })

  it('validates opencodeOps.permissionReply params before calling the provider service', async () => {
    const permissionReply = vi.fn(() => Effect.succeed({ success: true }))
    const service = { permissionReply } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'permission-reply-invalid',
        method: 'opencodeOps.permissionReply',
        params: { requestId: 'permission-1', reply: 'later', worktreePath: '/repo' }
      })
    )

    expect(permissionReply).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'permission-reply-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes opencodeOps.permissionList to the injected provider service', async () => {
    const permissions = [{ id: 'permission-1', metadata: { tool: 'bash' } }]
    const permissionList = vi.fn(() => Effect.succeed({ success: true, permissions }))
    const service = { permissionList } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'permission-list-1',
        method: 'opencodeOps.permissionList',
        params: { worktreePath: '/repo' }
      })
    )

    expect(permissionList).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'permission-list-1',
      ok: true,
      value: { success: true, permissions }
    })
  })

  it('validates opencodeOps.permissionList params before calling the provider service', async () => {
    const permissionList = vi.fn(() => Effect.succeed({ success: true, permissions: [] }))
    const service = { permissionList } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'permission-list-invalid',
        method: 'opencodeOps.permissionList',
        params: { worktreePath: 42 }
      })
    )

    expect(permissionList).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'permission-list-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes opencodeOps.commandApprovalReply to the injected provider service', async () => {
    const commandApprovalReply = vi.fn(() => Effect.succeed({ success: true }))
    const service = { commandApprovalReply } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'command-approval-reply-1',
        method: 'opencodeOps.commandApprovalReply',
        params: {
          requestId: 'approval-1',
          approved: true,
          remember: 'allow',
          pattern: 'npm test',
          worktreePath: '/repo',
          patterns: ['npm test', 'pnpm test']
        }
      })
    )

    expect(commandApprovalReply).toHaveBeenCalledWith(
      'approval-1',
      true,
      'allow',
      'npm test',
      '/repo',
      ['npm test', 'pnpm test']
    )
    expect(response).toEqual({
      id: 'command-approval-reply-1',
      ok: true,
      value: { success: true }
    })
  })

  it('validates opencodeOps.commandApprovalReply params before calling the provider service', async () => {
    const commandApprovalReply = vi.fn(() => Effect.succeed({ success: true }))
    const service = { commandApprovalReply } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'command-approval-reply-invalid',
        method: 'opencodeOps.commandApprovalReply',
        params: { requestId: 'approval-1', approved: true, remember: 'later' }
      })
    )

    expect(commandApprovalReply).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'command-approval-reply-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes opencodeOps.sessionInfo to the injected provider service', async () => {
    const result = { success: true, revertMessageID: 'msg-2', revertDiff: 'diff --git' }
    const sessionInfo = vi.fn(() => Effect.succeed(result))
    const service = { sessionInfo } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'session-info-1',
        method: 'opencodeOps.sessionInfo',
        params: { worktreePath: '/repo', opencodeSessionId: 'session-1' }
      })
    )

    expect(sessionInfo).toHaveBeenCalledWith('/repo', 'session-1')
    expect(response).toEqual({
      id: 'session-info-1',
      ok: true,
      value: result
    })
  })

  it('validates opencodeOps.sessionInfo params before calling the provider service', async () => {
    const sessionInfo = vi.fn(() => Effect.succeed({ success: true }))
    const service = { sessionInfo } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'session-info-invalid',
        method: 'opencodeOps.sessionInfo',
        params: { worktreePath: '/repo', opencodeSessionId: '' }
      })
    )

    expect(sessionInfo).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'session-info-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes opencodeOps.undo to the injected provider service', async () => {
    const result = {
      success: true,
      revertMessageID: 'msg-2',
      restoredPrompt: 'please change it',
      revertDiff: 'diff --git'
    }
    const undo = vi.fn(() => Effect.succeed(result))
    const service = { undo } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'undo-1',
        method: 'opencodeOps.undo',
        params: { worktreePath: '/repo', opencodeSessionId: 'session-1' }
      })
    )

    expect(undo).toHaveBeenCalledWith('/repo', 'session-1')
    expect(response).toEqual({
      id: 'undo-1',
      ok: true,
      value: result
    })
  })

  it('validates opencodeOps.undo params before calling the provider service', async () => {
    const undo = vi.fn(() => Effect.succeed({ success: true }))
    const service = { undo } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'undo-invalid',
        method: 'opencodeOps.undo',
        params: { worktreePath: '', opencodeSessionId: 'session-1' }
      })
    )

    expect(undo).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'undo-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes opencodeOps.redo to the injected provider service', async () => {
    const result = { success: true, revertMessageID: null }
    const redo = vi.fn(() => Effect.succeed(result))
    const service = { redo } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'redo-1',
        method: 'opencodeOps.redo',
        params: { worktreePath: '/repo', opencodeSessionId: 'session-1' }
      })
    )

    expect(redo).toHaveBeenCalledWith('/repo', 'session-1')
    expect(response).toEqual({
      id: 'redo-1',
      ok: true,
      value: result
    })
  })

  it('validates opencodeOps.redo params before calling the provider service', async () => {
    const redo = vi.fn(() => Effect.succeed({ success: true }))
    const service = { redo } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'redo-invalid',
        method: 'opencodeOps.redo',
        params: { worktreePath: '/repo', opencodeSessionId: '' }
      })
    )

    expect(redo).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'redo-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes opencodeOps.command to the injected provider service', async () => {
    const model = { providerID: 'anthropic', modelID: 'claude-sonnet', variant: 'opus' }
    const runCommand = vi.fn(() => Effect.succeed({ success: true }))
    const service = { command: runCommand } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'command-1',
        method: 'opencodeOps.command',
        params: {
          worktreePath: '/repo',
          opencodeSessionId: 'session-1',
          command: 'review',
          args: '--fast',
          model
        }
      })
    )

    expect(runCommand).toHaveBeenCalledWith('/repo', 'session-1', 'review', '--fast', model)
    expect(response).toEqual({
      id: 'command-1',
      ok: true,
      value: { success: true }
    })
  })

  it('validates opencodeOps.command params before calling the provider service', async () => {
    const runCommand = vi.fn(() => Effect.succeed({ success: true }))
    const service = { command: runCommand } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'command-invalid',
        method: 'opencodeOps.command',
        params: {
          worktreePath: '/repo',
          opencodeSessionId: 'session-1',
          command: '',
          args: ''
        }
      })
    )

    expect(runCommand).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'command-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes opencodeOps.commands to the injected provider service', async () => {
    const result = {
      success: true,
      commands: [
        {
          name: 'review',
          description: 'Review changes',
          template: '/review $ARGUMENTS',
          agent: 'opencode',
          model: 'anthropic/claude-sonnet',
          source: 'project',
          subtask: true,
          hints: ['diff']
        }
      ]
    }
    const commands = vi.fn(() => Effect.succeed(result))
    const service = { commands } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'commands-1',
        method: 'opencodeOps.commands',
        params: { worktreePath: '/repo', sessionId: 'session-1' }
      })
    )

    expect(commands).toHaveBeenCalledWith('/repo', 'session-1')
    expect(response).toEqual({
      id: 'commands-1',
      ok: true,
      value: result
    })
  })

  it('validates opencodeOps.commands params before calling the provider service', async () => {
    const commands = vi.fn(() => Effect.succeed({ success: true, commands: [] }))
    const service = { commands } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'commands-invalid',
        method: 'opencodeOps.commands',
        params: { worktreePath: '' }
      })
    )

    expect(commands).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'commands-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes opencodeOps.renameSession to the injected provider service', async () => {
    const renameSession = vi.fn(() => Effect.succeed({ success: true }))
    const service = { renameSession } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'rename-session-1',
        method: 'opencodeOps.renameSession',
        params: {
          opencodeSessionId: 'session-1',
          title: 'New title',
          worktreePath: '/repo'
        }
      })
    )

    expect(renameSession).toHaveBeenCalledWith('session-1', 'New title', '/repo')
    expect(response).toEqual({
      id: 'rename-session-1',
      ok: true,
      value: { success: true }
    })
  })

  it('validates opencodeOps.renameSession params before calling the provider service', async () => {
    const renameSession = vi.fn(() => Effect.succeed({ success: true }))
    const service = { renameSession } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'rename-session-invalid',
        method: 'opencodeOps.renameSession',
        params: { opencodeSessionId: '', title: 'New title' }
      })
    )

    expect(renameSession).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'rename-session-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes opencodeOps.capabilities to the injected provider service', async () => {
    const result = {
      success: true,
      capabilities: {
        supportsUndo: true,
        supportsRedo: false,
        supportsCommands: true,
        supportsPermissionRequests: true,
        supportsQuestionPrompts: false,
        supportsModelSelection: true,
        supportsReconnect: true,
        supportsPartialStreaming: false,
        supportsSteer: true
      }
    }
    const capabilities = vi.fn(() => Effect.succeed(result))
    const service = { capabilities } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'capabilities-1',
        method: 'opencodeOps.capabilities',
        params: { sessionId: 'session-1' }
      })
    )

    expect(capabilities).toHaveBeenCalledWith('session-1')
    expect(response).toEqual({
      id: 'capabilities-1',
      ok: true,
      value: result
    })
  })

  it('validates opencodeOps.capabilities params before calling the provider service', async () => {
    const capabilities = vi.fn(() => Effect.succeed({ success: true, capabilities: null }))
    const service = { capabilities } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'capabilities-invalid',
        method: 'opencodeOps.capabilities',
        params: { sessionId: 42 }
      })
    )

    expect(capabilities).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'capabilities-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes opencodeOps.fork to the injected provider service', async () => {
    const result = { success: true, sessionId: 'forked-session-1' }
    const fork = vi.fn(() => Effect.succeed(result))
    const service = { fork } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'fork-1',
        method: 'opencodeOps.fork',
        params: {
          worktreePath: '/repo',
          opencodeSessionId: 'session-1',
          messageId: 'message-1'
        }
      })
    )

    expect(fork).toHaveBeenCalledWith('/repo', 'session-1', 'message-1')
    expect(response).toEqual({
      id: 'fork-1',
      ok: true,
      value: result
    })
  })

  it('validates opencodeOps.fork params before calling the provider service', async () => {
    const fork = vi.fn(() => Effect.succeed({ success: true }))
    const service = { fork } as unknown as OpenCodeOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      opencodeOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'fork-invalid',
        method: 'opencodeOps.fork',
        params: { worktreePath: '/repo', opencodeSessionId: '' }
      })
    )

    expect(fork).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'fork-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })
})
