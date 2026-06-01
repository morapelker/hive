import { afterEach, describe, expect, it, vi } from 'vitest'
import { OPENCODE_STREAM_CHANNEL } from '@shared/opencode-events'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'
import { opencodeApi } from '../opencode-api'

describe('opencodeApi', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('routes connect through the renderer RPC client', async () => {
    const result = { success: true, sessionId: 'oc-session-1' }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(opencodeApi.connect('/tmp/hive', 'hive-session-1')).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('opencodeOps.connect', {
      worktreePath: '/tmp/hive',
      hiveSessionId: 'hive-session-1'
    })
  })

  it('routes prompt through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()
    const model = { providerID: 'anthropic', modelID: 'claude-sonnet', variant: 'latest' }
    const options = { codexFastMode: true }

    setRendererRpcClient({ request, subscribe })

    await expect(
      opencodeApi.prompt('/tmp/hive', 'oc-session-1', 'hello', model, options)
    ).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('opencodeOps.prompt', {
      worktreePath: '/tmp/hive',
      opencodeSessionId: 'oc-session-1',
      messageOrParts: [{ type: 'text', text: 'hello' }],
      model,
      options
    })
  })

  it('routes reconnect through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(
      opencodeApi.reconnect('/tmp/hive', 'oc-session-1', 'hive-session-1')
    ).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('opencodeOps.reconnect', {
      worktreePath: '/tmp/hive',
      opencodeSessionId: 'oc-session-1',
      hiveSessionId: 'hive-session-1'
    })
  })

  it('routes onStream through the renderer subscription client', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(
      (_channel: string, _listener: (event: { payload: unknown }) => void) => {
        return unsubscribe
      }
    )
    const callback = vi.fn()
    const payload = {
      type: 'session.updated',
      sessionId: 'session-1',
      data: { title: 'Updated title' }
    }

    setRendererRpcClient({ request, subscribe })

    const returned = opencodeApi.onStream(callback)
    const listener = subscribe.mock.calls[0]?.[1]
    listener?.({ payload })
    listener?.({ payload: { ...payload, sessionId: null } })

    expect(subscribe).toHaveBeenCalledWith(OPENCODE_STREAM_CHANNEL, expect.any(Function))
    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith(payload)
    expect(returned).toBe(unsubscribe)
  })

  it('routes abort through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(opencodeApi.abort('/tmp/hive', 'oc-session-1')).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('opencodeOps.abort', {
      worktreePath: '/tmp/hive',
      opencodeSessionId: 'oc-session-1'
    })
  })

  it('routes steer through the renderer RPC client', async () => {
    const result = {
      success: true,
      insertedMessageId: 'msg-user-1',
      nextAssistantMessageId: 'msg-assistant-1',
      turnId: 'turn-1'
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(opencodeApi.steer('/tmp/hive', 'oc-session-1', 'revise this')).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('opencodeOps.steer', {
      worktreePath: '/tmp/hive',
      opencodeSessionId: 'oc-session-1',
      message: 'revise this'
    })
  })

  it('routes disconnect through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(opencodeApi.disconnect('/tmp/hive', 'oc-session-1')).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('opencodeOps.disconnect', {
      worktreePath: '/tmp/hive',
      opencodeSessionId: 'oc-session-1'
    })
  })

  it('routes getMessages through the renderer RPC client', async () => {
    const result = { success: true, messages: [{ id: 'msg-1' }] }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(opencodeApi.getMessages('/tmp/hive', 'oc-session-1')).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('opencodeOps.getMessages', {
      worktreePath: '/tmp/hive',
      opencodeSessionId: 'oc-session-1'
    })
  })

  it('routes refreshFromThread through the renderer RPC client', async () => {
    const result = { success: true, count: 2 }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(opencodeApi.refreshFromThread('/tmp/hive', 'oc-session-1')).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('opencodeOps.refreshFromThread', {
      worktreePath: '/tmp/hive',
      opencodeSessionId: 'oc-session-1'
    })
  })

  it('routes listModels through the renderer RPC client', async () => {
    const result = { success: true, providers: { openai: { models: [] } } }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(opencodeApi.listModels({ agentSdk: 'codex' })).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('opencodeOps.listModels', { agentSdk: 'codex' })
  })

  it('routes listModels without options through the renderer RPC client', async () => {
    const result = { success: true, providers: {} }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(opencodeApi.listModels()).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('opencodeOps.listModels', {})
  })

  it('routes modelInfo through the renderer RPC client', async () => {
    const result = {
      success: true,
      model: { id: 'gpt-5', name: 'GPT-5', limit: { context: 400000 } }
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(opencodeApi.modelInfo('/tmp/hive', 'gpt-5', 'codex')).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('opencodeOps.modelInfo', {
      worktreePath: '/tmp/hive',
      modelId: 'gpt-5',
      agentSdk: 'codex'
    })
  })

  it('routes sessionInfo through the renderer RPC client', async () => {
    const result = { success: true, revertMessageID: 'msg-2', revertDiff: 'diff --git' }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(opencodeApi.sessionInfo('/tmp/hive', 'oc-session-1')).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('opencodeOps.sessionInfo', {
      worktreePath: '/tmp/hive',
      opencodeSessionId: 'oc-session-1'
    })
  })

  it('routes undo through the renderer RPC client', async () => {
    const result = {
      success: true,
      revertMessageID: 'msg-2',
      restoredPrompt: 'please change it',
      revertDiff: 'diff --git'
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(opencodeApi.undo('/tmp/hive', 'oc-session-1')).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('opencodeOps.undo', {
      worktreePath: '/tmp/hive',
      opencodeSessionId: 'oc-session-1'
    })
  })

  it('routes redo through the renderer RPC client', async () => {
    const result = { success: true, revertMessageID: 'msg-3' }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(opencodeApi.redo('/tmp/hive', 'oc-session-1')).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('opencodeOps.redo', {
      worktreePath: '/tmp/hive',
      opencodeSessionId: 'oc-session-1'
    })
  })

  it('routes command through the renderer RPC client', async () => {
    const result = { success: true }
    const model = { providerID: 'openai', modelID: 'gpt-5', variant: 'high' }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(
      opencodeApi.command('/tmp/hive', 'oc-session-1', 'goal', 'resume', model)
    ).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('opencodeOps.command', {
      worktreePath: '/tmp/hive',
      opencodeSessionId: 'oc-session-1',
      command: 'goal',
      args: 'resume',
      model
    })
  })

  it('routes commands through the renderer RPC client', async () => {
    const result = {
      success: true,
      commands: [{ name: 'test', description: 'Run tests', template: 'pnpm test' }]
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(opencodeApi.commands('/tmp/hive', 'hive-session-1')).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('opencodeOps.commands', {
      worktreePath: '/tmp/hive',
      sessionId: 'hive-session-1'
    })
  })

  it('routes renameSession through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(
      opencodeApi.renameSession('oc-session-1', 'New title', '/tmp/hive')
    ).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('opencodeOps.renameSession', {
      opencodeSessionId: 'oc-session-1',
      title: 'New title',
      worktreePath: '/tmp/hive'
    })
  })

  it('routes capabilities through the renderer RPC client', async () => {
    const result = {
      success: true,
      capabilities: {
        supportsUndo: true,
        supportsRedo: false,
        supportsPlanMode: true,
        supportsPermissionRequests: true,
        supportsQuestionPrompts: true,
        supportsModelSelection: true,
        supportsReconnect: true,
        supportsPartialStreaming: false,
        supportsSteer: true
      }
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(opencodeApi.capabilities('oc-session-1')).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('opencodeOps.capabilities', {
      sessionId: 'oc-session-1'
    })
  })

  it('routes permissionList through the renderer RPC client', async () => {
    const result = { success: true, permissions: [{ id: 'permission-1', permission: {} }] }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(opencodeApi.permissionList('/tmp/hive')).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('opencodeOps.permissionList', {
      worktreePath: '/tmp/hive'
    })
  })

  it('routes fork through the renderer RPC client', async () => {
    const result = { success: true, sessionId: 'fork-session-1' }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(opencodeApi.fork('/tmp/hive', 'oc-session-1', 'msg-3')).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('opencodeOps.fork', {
      worktreePath: '/tmp/hive',
      opencodeSessionId: 'oc-session-1',
      messageId: 'msg-3'
    })
  })

  it('routes planApprove through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(
      opencodeApi.planApprove('/tmp/hive', 'hive-session-1', 'request-1')
    ).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('opencodeOps.planApprove', {
      worktreePath: '/tmp/hive',
      hiveSessionId: 'hive-session-1',
      requestId: 'request-1'
    })
  })

  it('routes planReject through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(
      opencodeApi.planReject('/tmp/hive', 'hive-session-1', 'revise the plan', 'request-1')
    ).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('opencodeOps.planReject', {
      worktreePath: '/tmp/hive',
      hiveSessionId: 'hive-session-1',
      feedback: 'revise the plan',
      requestId: 'request-1'
    })
  })

  it('routes questionReply through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()
    const answers = [['Yes'], ['No', 'Maybe']]

    setRendererRpcClient({ request, subscribe })

    await expect(opencodeApi.questionReply('question-1', answers, '/tmp/hive')).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('opencodeOps.questionReply', {
      requestId: 'question-1',
      answers,
      worktreePath: '/tmp/hive'
    })
  })

  it('routes questionReject through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(opencodeApi.questionReject('question-1', '/tmp/hive')).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('opencodeOps.questionReject', {
      requestId: 'question-1',
      worktreePath: '/tmp/hive'
    })
  })

  it('routes permissionReply through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(
      opencodeApi.permissionReply('permission-1', 'always', '/tmp/hive', 'Approved')
    ).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('opencodeOps.permissionReply', {
      requestId: 'permission-1',
      reply: 'always',
      worktreePath: '/tmp/hive',
      message: 'Approved'
    })
  })

  it('routes commandApprovalReply through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(
      opencodeApi.commandApprovalReply('approval-1', true, 'allow', 'pnpm test', '/tmp/hive', [
        'pnpm test',
        'pnpm build'
      ])
    ).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('opencodeOps.commandApprovalReply', {
      requestId: 'approval-1',
      approved: true,
      remember: 'allow',
      pattern: 'pnpm test',
      worktreePath: '/tmp/hive',
      patterns: ['pnpm test', 'pnpm build']
    })
  })

  it('routes setModel through the renderer RPC client', async () => {
    const result = { success: true }
    const model = {
      providerID: 'openai',
      modelID: 'gpt-5',
      variant: 'high',
      agentSdk: 'codex' as const
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(opencodeApi.setModel(model)).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('opencodeOps.setModel', model)
  })

  it('routes setModel null through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(opencodeApi.setModel(null)).resolves.toEqual({
      success: true,
      value: result
    })
    expect(request).toHaveBeenCalledWith('opencodeOps.setModel', null)
  })
})
