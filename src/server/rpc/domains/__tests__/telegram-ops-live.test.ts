import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TELEGRAM_CLAUDE_CLI_EVENT_CHANNEL } from '@shared/telegram-events'
import { makeEventBus } from '../../../events/event-bus'
import { makeLiveTelegramOpsRpcService } from '../telegram-ops'

const settings = new Map<string, string>()

vi.mock('../../../../main/db', () => ({
  getDatabase: () => ({
    getSetting: (key: string) => settings.get(key) ?? null,
    setSetting: (key: string, value: string) => {
      settings.set(key, value)
    },
    deleteSetting: (key: string) => {
      settings.delete(key)
    }
  })
}))

vi.mock('../../../../main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../../../../main/services/opencode-service', () => ({
  openCodeService: {
    permissionReply: vi.fn(),
    prompt: vi.fn(),
    questionReply: vi.fn()
  }
}))

vi.mock('../../../../main/services/claude-code-implementer', () => ({
  ClaudeCodeImplementer: class {}
}))

vi.mock('../../../../main/services/codex-implementer', () => ({
  CodexImplementer: class {}
}))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('live telegram ops RPC service', () => {
  it('initializes the server-owned forwarding service before config and test-message calls', async () => {
    settings.clear()
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        result: { message_id: 1, chat: { id: 42, type: 'private' }, text: 'Hive connected' }
      })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const service = makeLiveTelegramOpsRpcService()
    const config = {
      botToken: '123456:test-token',
      chatId: 42,
      chatName: 'Hive',
      contextSize: 3
    }

    await expect(Effect.runPromise(service.setConfig(config))).resolves.toEqual({ ok: true })
    await expect(Effect.runPromise(service.getConfig())).resolves.toEqual(config)
    await expect(Effect.runPromise(service.sendTestMessage())).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/bot123456:test-token/sendMessage',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"chat_id":42')
      })
    )
  })

  it('routes desktop-published Claude CLI Telegram events into the forwarding service', async () => {
    settings.clear()
    const eventBus = makeEventBus()
    const service = makeLiveTelegramOpsRpcService(eventBus)
    await Effect.runPromise(service.getConfig())

    const { telegramForwardingService } = await import(
      '../../../../main/services/telegram-forwarding-service'
    )
    const handleEvent = vi.spyOn(telegramForwardingService, 'handleBackendAgentEvent')
    const payload = {
      type: 'plan.ready',
      sessionId: 'cli-session-1',
      data: { requestId: 'plan-1', plan: 'Do it' }
    }

    await Effect.runPromise(
      eventBus.publish({
        channel: TELEGRAM_CLAUDE_CLI_EVENT_CHANNEL,
        payload
      })
    )

    expect(handleEvent).toHaveBeenCalledWith(payload)
  })
})
