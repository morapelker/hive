import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { makeEventBus } from '../events/event-bus'
import type { TelegramOpsRpcService } from '../rpc/domains/telegram-ops'
import { makeRpcRouter } from '../rpc/router'

describe('telegram ops RPC mocked provider', () => {
  it('routes telegramOps.getConfig to the injected provider service', async () => {
    const config = {
      botToken: '123456:test-token',
      chatId: 42,
      chatName: 'Hive',
      contextSize: 12
    }
    const getConfig = vi.fn(() => Effect.succeed(config))
    const service = { getConfig } as unknown as TelegramOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      telegramOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'telegram-ops-get-config-1',
        method: 'telegramOps.getConfig',
        params: {}
      })
    )

    expect(getConfig).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'telegram-ops-get-config-1',
      ok: true,
      value: config
    })
  })

  it('preserves null telegramOps.getConfig results from the provider service', async () => {
    const getConfig = vi.fn(() => Effect.succeed(null))
    const service = { getConfig } as unknown as TelegramOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      telegramOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'telegram-ops-get-config-null',
        method: 'telegramOps.getConfig',
        params: null
      })
    )

    expect(getConfig).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'telegram-ops-get-config-null',
      ok: true,
      value: null
    })
  })

  it('validates telegramOps.getConfig params before calling the provider service', async () => {
    const getConfig = vi.fn(() => Effect.succeed(null))
    const service = { getConfig } as unknown as TelegramOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      telegramOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'telegram-ops-get-config-invalid',
        method: 'telegramOps.getConfig',
        params: { unexpected: true }
      })
    )

    expect(getConfig).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'telegram-ops-get-config-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes telegramOps.setConfig to the injected provider service', async () => {
    const config = {
      botToken: '123456:test-token',
      chatId: 42,
      chatName: 'Hive',
      contextSize: 12
    }
    const result = { ok: true }
    const setConfig = vi.fn(() => Effect.succeed(result))
    const service = { setConfig } as unknown as TelegramOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      telegramOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'telegram-ops-set-config-1',
        method: 'telegramOps.setConfig',
        params: { config }
      })
    )

    expect(setConfig).toHaveBeenCalledWith(config)
    expect(response).toEqual({
      id: 'telegram-ops-set-config-1',
      ok: true,
      value: result
    })
  })

  it('routes telegramOps.setConfig null config to the injected provider service', async () => {
    const result = { ok: false, error: 'Service unavailable' }
    const setConfig = vi.fn(() => Effect.succeed(result))
    const service = { setConfig } as unknown as TelegramOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      telegramOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'telegram-ops-set-config-null',
        method: 'telegramOps.setConfig',
        params: { config: null }
      })
    )

    expect(setConfig).toHaveBeenCalledWith(null)
    expect(response).toEqual({
      id: 'telegram-ops-set-config-null',
      ok: true,
      value: result
    })
  })

  it('validates telegramOps.setConfig params before calling the provider service', async () => {
    const setConfig = vi.fn(() => Effect.succeed({ ok: true }))
    const service = { setConfig } as unknown as TelegramOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      telegramOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'telegram-ops-set-config-invalid',
        method: 'telegramOps.setConfig',
        params: {
          config: {
            botToken: '123456:test-token',
            chatId: '42',
            chatName: 'Hive',
            contextSize: 12
          }
        }
      })
    )

    expect(setConfig).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'telegram-ops-set-config-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes telegramOps.verifyToken to the injected provider service', async () => {
    const result = { ok: true, botUsername: 'hive_bot' }
    const verifyToken = vi.fn(() => Effect.succeed(result))
    const service = { verifyToken } as unknown as TelegramOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      telegramOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'telegram-ops-verify-token-1',
        method: 'telegramOps.verifyToken',
        params: { botToken: '123456:test-token' }
      })
    )

    expect(verifyToken).toHaveBeenCalledWith('123456:test-token')
    expect(response).toEqual({
      id: 'telegram-ops-verify-token-1',
      ok: true,
      value: result
    })
  })

  it('preserves failed telegramOps.verifyToken results from the provider service', async () => {
    const result = { ok: false, error: 'Unauthorized' }
    const verifyToken = vi.fn(() => Effect.succeed(result))
    const service = { verifyToken } as unknown as TelegramOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      telegramOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'telegram-ops-verify-token-error',
        method: 'telegramOps.verifyToken',
        params: { botToken: '123456:test-token' }
      })
    )

    expect(verifyToken).toHaveBeenCalledWith('123456:test-token')
    expect(response).toEqual({
      id: 'telegram-ops-verify-token-error',
      ok: true,
      value: result
    })
  })

  it('validates telegramOps.verifyToken params before calling the provider service', async () => {
    const verifyToken = vi.fn(() => Effect.succeed({ ok: true }))
    const service = { verifyToken } as unknown as TelegramOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      telegramOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'telegram-ops-verify-token-invalid',
        method: 'telegramOps.verifyToken',
        params: { botToken: '' }
      })
    )

    expect(verifyToken).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'telegram-ops-verify-token-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes telegramOps.discoverChats with config to the injected provider service', async () => {
    const config = {
      botToken: '123456:test-token',
      chatId: 42,
      chatName: 'Hive',
      contextSize: 12
    }
    const chats = [
      { chatId: 42, firstName: 'Hive', type: 'group' as const },
      { chatId: 43, firstName: 'Ops', type: 'supergroup' as const }
    ]
    const discoverChats = vi.fn(() => Effect.succeed(chats))
    const service = { discoverChats } as unknown as TelegramOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      telegramOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'telegram-ops-discover-chats-1',
        method: 'telegramOps.discoverChats',
        params: { config }
      })
    )

    expect(discoverChats).toHaveBeenCalledWith(config)
    expect(response).toEqual({
      id: 'telegram-ops-discover-chats-1',
      ok: true,
      value: chats
    })
  })

  it('routes telegramOps.discoverChats without config to the injected provider service', async () => {
    const discoverChats = vi.fn(() => Effect.succeed([]))
    const service = { discoverChats } as unknown as TelegramOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      telegramOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'telegram-ops-discover-chats-stored-config',
        method: 'telegramOps.discoverChats',
        params: {}
      })
    )

    expect(discoverChats).toHaveBeenCalledWith(undefined)
    expect(response).toEqual({
      id: 'telegram-ops-discover-chats-stored-config',
      ok: true,
      value: []
    })
  })

  it('routes telegramOps.discoverChats null config to the injected provider service', async () => {
    const discoverChats = vi.fn(() => Effect.succeed([]))
    const service = { discoverChats } as unknown as TelegramOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      telegramOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'telegram-ops-discover-chats-null',
        method: 'telegramOps.discoverChats',
        params: { config: null }
      })
    )

    expect(discoverChats).toHaveBeenCalledWith(null)
    expect(response).toEqual({
      id: 'telegram-ops-discover-chats-null',
      ok: true,
      value: []
    })
  })

  it('validates telegramOps.discoverChats params before calling the provider service', async () => {
    const discoverChats = vi.fn(() => Effect.succeed([]))
    const service = { discoverChats } as unknown as TelegramOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      telegramOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'telegram-ops-discover-chats-invalid',
        method: 'telegramOps.discoverChats',
        params: {
          config: {
            botToken: '123456:test-token',
            chatId: '42',
            chatName: 'Hive',
            contextSize: 12
          }
        }
      })
    )

    expect(discoverChats).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'telegram-ops-discover-chats-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes telegramOps.sendTestMessage to the injected provider service', async () => {
    const result = { ok: true }
    const sendTestMessage = vi.fn(() => Effect.succeed(result))
    const service = { sendTestMessage } as unknown as TelegramOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      telegramOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'telegram-ops-send-test-message-1',
        method: 'telegramOps.sendTestMessage',
        params: {}
      })
    )

    expect(sendTestMessage).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'telegram-ops-send-test-message-1',
      ok: true,
      value: result
    })
  })

  it('preserves failed telegramOps.sendTestMessage results from the provider service', async () => {
    const result = { ok: false, error: 'Telegram is not configured' }
    const sendTestMessage = vi.fn(() => Effect.succeed(result))
    const service = { sendTestMessage } as unknown as TelegramOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      telegramOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'telegram-ops-send-test-message-error',
        method: 'telegramOps.sendTestMessage',
        params: null
      })
    )

    expect(sendTestMessage).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'telegram-ops-send-test-message-error',
      ok: true,
      value: result
    })
  })

  it('validates telegramOps.sendTestMessage params before calling the provider service', async () => {
    const sendTestMessage = vi.fn(() => Effect.succeed({ ok: true }))
    const service = { sendTestMessage } as unknown as TelegramOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      telegramOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'telegram-ops-send-test-message-invalid',
        method: 'telegramOps.sendTestMessage',
        params: { unexpected: true }
      })
    )

    expect(sendTestMessage).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'telegram-ops-send-test-message-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes telegramOps.startForwarding to the injected provider service', async () => {
    const params = {
      sessionId: 'session-1',
      worktreeId: 'worktree-1',
      connectionId: null,
      mode: 'questions' as const
    }
    const status = {
      active: true,
      sessionId: 'session-1',
      worktreeId: 'worktree-1',
      connectionId: null,
      mode: 'questions' as const,
      health: 'ok' as const,
      lastError: null
    }
    const result = { ok: true, status }
    const startForwarding = vi.fn(() => Effect.succeed(result))
    const service = { startForwarding } as unknown as TelegramOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      telegramOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'telegram-ops-start-forwarding-1',
        method: 'telegramOps.startForwarding',
        params: { params }
      })
    )

    expect(startForwarding).toHaveBeenCalledWith(params)
    expect(response).toEqual({
      id: 'telegram-ops-start-forwarding-1',
      ok: true,
      value: result
    })
  })

  it('preserves failed telegramOps.startForwarding results from the provider service', async () => {
    const params = {
      sessionId: 'session-1',
      worktreeId: null,
      connectionId: 'connection-1',
      mode: 'all' as const
    }
    const status = {
      active: false,
      sessionId: null,
      worktreeId: null,
      connectionId: null,
      mode: null,
      health: 'error' as const,
      lastError: 'Telegram is not configured'
    }
    const result = { ok: false, status, error: 'Telegram is not configured' }
    const startForwarding = vi.fn(() => Effect.succeed(result))
    const service = { startForwarding } as unknown as TelegramOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      telegramOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'telegram-ops-start-forwarding-error',
        method: 'telegramOps.startForwarding',
        params: { params }
      })
    )

    expect(startForwarding).toHaveBeenCalledWith(params)
    expect(response).toEqual({
      id: 'telegram-ops-start-forwarding-error',
      ok: true,
      value: result
    })
  })

  it('validates telegramOps.startForwarding params before calling the provider service', async () => {
    const status = {
      active: false,
      sessionId: null,
      worktreeId: null,
      connectionId: null,
      mode: null,
      health: 'ok' as const,
      lastError: null
    }
    const startForwarding = vi.fn(() => Effect.succeed({ ok: true, status }))
    const service = { startForwarding } as unknown as TelegramOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      telegramOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'telegram-ops-start-forwarding-invalid',
        method: 'telegramOps.startForwarding',
        params: {
          params: {
            sessionId: '',
            worktreeId: 'worktree-1',
            connectionId: null,
            mode: 'questions'
          }
        }
      })
    )

    expect(startForwarding).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'telegram-ops-start-forwarding-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes telegramOps.stopForwarding to the injected provider service', async () => {
    const status = {
      active: false,
      sessionId: null,
      worktreeId: null,
      connectionId: null,
      mode: null,
      health: 'ok' as const,
      lastError: null
    }
    const result = { status }
    const stopForwarding = vi.fn(() => Effect.succeed(result))
    const service = { stopForwarding } as unknown as TelegramOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      telegramOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'telegram-ops-stop-forwarding-1',
        method: 'telegramOps.stopForwarding',
        params: {}
      })
    )

    expect(stopForwarding).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'telegram-ops-stop-forwarding-1',
      ok: true,
      value: result
    })
  })

  it('accepts null telegramOps.stopForwarding params for the injected provider service', async () => {
    const status = {
      active: false,
      sessionId: 'session-1',
      worktreeId: null,
      connectionId: null,
      mode: 'questions' as const,
      health: 'error' as const,
      lastError: 'Stopped manually'
    }
    const result = { status }
    const stopForwarding = vi.fn(() => Effect.succeed(result))
    const service = { stopForwarding } as unknown as TelegramOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      telegramOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'telegram-ops-stop-forwarding-null',
        method: 'telegramOps.stopForwarding',
        params: null
      })
    )

    expect(stopForwarding).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'telegram-ops-stop-forwarding-null',
      ok: true,
      value: result
    })
  })

  it('validates telegramOps.stopForwarding params before calling the provider service', async () => {
    const status = {
      active: false,
      sessionId: null,
      worktreeId: null,
      connectionId: null,
      mode: null,
      health: 'ok' as const,
      lastError: null
    }
    const stopForwarding = vi.fn(() => Effect.succeed({ status }))
    const service = { stopForwarding } as unknown as TelegramOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      telegramOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'telegram-ops-stop-forwarding-invalid',
        method: 'telegramOps.stopForwarding',
        params: { unexpected: true }
      })
    )

    expect(stopForwarding).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'telegram-ops-stop-forwarding-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes telegramOps.getStatus to the injected provider service', async () => {
    const status = {
      active: true,
      sessionId: 'session-1',
      worktreeId: 'worktree-1',
      connectionId: null,
      mode: 'all' as const,
      health: 'ok' as const,
      lastError: null
    }
    const getStatus = vi.fn(() => Effect.succeed(status))
    const service = { getStatus } as unknown as TelegramOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      telegramOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'telegram-ops-get-status-1',
        method: 'telegramOps.getStatus',
        params: {}
      })
    )

    expect(getStatus).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'telegram-ops-get-status-1',
      ok: true,
      value: status
    })
  })

  it('accepts null telegramOps.getStatus params for the injected provider service', async () => {
    const status = {
      active: false,
      sessionId: null,
      worktreeId: null,
      connectionId: null,
      mode: null,
      health: 'error' as const,
      lastError: 'Telegram is not configured'
    }
    const getStatus = vi.fn(() => Effect.succeed(status))
    const service = { getStatus } as unknown as TelegramOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      telegramOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'telegram-ops-get-status-null',
        method: 'telegramOps.getStatus',
        params: null
      })
    )

    expect(getStatus).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'telegram-ops-get-status-null',
      ok: true,
      value: status
    })
  })

  it('validates telegramOps.getStatus params before calling the provider service', async () => {
    const getStatus = vi.fn(() =>
      Effect.succeed({
        active: false,
        sessionId: null,
        worktreeId: null,
        connectionId: null,
        mode: null,
        health: 'ok' as const,
        lastError: null
      })
    )
    const service = { getStatus } as unknown as TelegramOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      telegramOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'telegram-ops-get-status-invalid',
        method: 'telegramOps.getStatus',
        params: { unexpected: true }
      })
    )

    expect(getStatus).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'telegram-ops-get-status-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })
})
