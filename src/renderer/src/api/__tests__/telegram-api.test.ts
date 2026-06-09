import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TELEGRAM_PLAN_IMPLEMENT_REQUESTED_CHANNEL,
  TELEGRAM_STATUS_CHANGED_CHANNEL,
  type TelegramPlanImplementRequestedPayload
} from '@shared/telegram-events'
import type { ServerEvent } from '@shared/rpc/protocol'
import type {
  TelegramConfig,
  TelegramDiscoveredChat,
  TelegramForwardingStatus,
  TelegramStartForwardingRequest
} from '@shared/types/telegram'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'
import { telegramApi } from '../telegram-api'

describe('telegramApi', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('routes getConfig through the renderer RPC client', async () => {
    const config = {
      botToken: '123:token',
      chatId: 42,
      chatName: 'Build Alerts',
      contextSize: 12
    }
    const request = vi.fn().mockResolvedValue(config)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(telegramApi.getConfig()).resolves.toEqual(config)
    expect(request).toHaveBeenCalledWith('telegramOps.getConfig', {})
  })

  it('routes setConfig through the renderer RPC client', async () => {
    const config = {
      botToken: '123:token',
      chatId: 42,
      chatName: 'Build Alerts',
      contextSize: 4
    } satisfies TelegramConfig
    const result = { ok: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(telegramApi.setConfig(config)).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('telegramOps.setConfig', { config })
  })

  it('routes verifyToken through the renderer RPC client', async () => {
    const botToken = '123:token'
    const result = { ok: true, botUsername: 'hive_bot' }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(telegramApi.verifyToken(botToken)).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('telegramOps.verifyToken', { botToken })
  })

  it('routes discoverChats through the renderer RPC client', async () => {
    const config = {
      botToken: '123:token',
      chatId: 42,
      chatName: 'Build Alerts',
      contextSize: 4
    } satisfies TelegramConfig
    const chats = [
      {
        chatId: 42,
        firstName: 'Build Alerts',
        type: 'group'
      }
    ] satisfies TelegramDiscoveredChat[]
    const request = vi.fn().mockResolvedValue(chats)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(telegramApi.discoverChats(config)).resolves.toBe(chats)
    expect(request).toHaveBeenCalledWith('telegramOps.discoverChats', { config })
  })

  it('routes sendTestMessage through the renderer RPC client', async () => {
    const result = { ok: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(telegramApi.sendTestMessage()).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('telegramOps.sendTestMessage', {})
  })

  it('routes getStatus through the renderer RPC client', async () => {
    const status = {
      active: true,
      sessionId: 'session-1',
      worktreeId: 'worktree-1',
      connectionId: null,
      mode: 'questions',
      health: 'ok',
      lastError: null
    } satisfies TelegramForwardingStatus
    const request = vi.fn().mockResolvedValue(status)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(telegramApi.getStatus()).resolves.toBe(status)
    expect(request).toHaveBeenCalledWith('telegramOps.getStatus', {})
  })

  it('routes startForwarding through the renderer RPC client', async () => {
    const params = {
      sessionId: 'session-1',
      worktreeId: null,
      connectionId: 'connection-1',
      mode: 'questions'
    } satisfies TelegramStartForwardingRequest
    const result = {
      ok: true,
      status: {
        active: true,
        sessionId: 'session-1',
        worktreeId: null,
        connectionId: 'connection-1',
        mode: 'questions',
        health: 'ok',
        lastError: null
      }
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(telegramApi.startForwarding(params)).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('telegramOps.startForwarding', { params })
  })

  it('routes stopForwarding through the renderer RPC client', async () => {
    const result = {
      status: {
        active: false,
        sessionId: null,
        worktreeId: null,
        connectionId: null,
        mode: null,
        health: 'ok',
        lastError: null
      } satisfies TelegramForwardingStatus
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(telegramApi.stopForwarding()).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('telegramOps.stopForwarding', {})
  })

  it('routes onStatusChanged through the renderer RPC client', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(
      (_channel: string, _listener: (event: ServerEvent) => void) => unsubscribe
    )
    const callback = vi.fn()
    const status = {
      active: true,
      sessionId: 'session-1',
      worktreeId: 'worktree-1',
      connectionId: null,
      mode: 'questions',
      health: 'ok',
      lastError: null
    } satisfies TelegramForwardingStatus

    setRendererRpcClient({ request, subscribe })

    const returned = telegramApi.onStatusChanged(callback)
    const listener = subscribe.mock.calls[0]?.[1]
    listener?.({
      channel: TELEGRAM_STATUS_CHANGED_CHANNEL,
      payload: status
    })
    listener?.({
      channel: TELEGRAM_STATUS_CHANGED_CHANNEL,
      payload: { ...status, active: 'yes' }
    })

    expect(subscribe).toHaveBeenCalledWith(TELEGRAM_STATUS_CHANGED_CHANNEL, expect.any(Function))
    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith(status)
    expect(returned).toBe(unsubscribe)
  })

  it('routes onPlanImplementRequested through the renderer RPC client', () => {
    const request = vi.fn()
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(
      (_channel: string, _listener: (event: ServerEvent) => void) => unsubscribe
    )
    const callback = vi.fn()
    const payload = {
      sessionId: 'session-1',
      worktreeId: 'worktree-1',
      connectionId: null,
      requestId: 'request:1',
      plan: 'Implement this plan'
    } satisfies TelegramPlanImplementRequestedPayload

    setRendererRpcClient({ request, subscribe })

    const returned = telegramApi.onPlanImplementRequested(callback)
    const listener = subscribe.mock.calls[0]?.[1]
    listener?.({
      channel: TELEGRAM_PLAN_IMPLEMENT_REQUESTED_CHANNEL,
      payload
    })
    listener?.({
      channel: TELEGRAM_PLAN_IMPLEMENT_REQUESTED_CHANNEL,
      payload: { ...payload, requestId: 1 }
    })

    expect(subscribe).toHaveBeenCalledWith(
      TELEGRAM_PLAN_IMPLEMENT_REQUESTED_CHANNEL,
      expect.any(Function)
    )
    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith(payload)
    expect(returned).toBe(unsubscribe)
  })
})
