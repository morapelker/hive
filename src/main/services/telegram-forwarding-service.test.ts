import { describe, expect, it, vi } from 'vitest'
import {
  TELEGRAM_PLAN_IMPLEMENT_REQUESTED_CHANNEL,
  TELEGRAM_STATUS_CHANGED_CHANNEL
} from '../../shared/telegram-events'
import { TelegramForwardingService } from './telegram-forwarding-service'

vi.mock('./logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('./opencode-service', () => ({
  openCodeService: {
    questionReply: vi.fn(),
    prompt: vi.fn()
  }
}))

vi.mock('./claude-code-implementer', () => ({
  ClaudeCodeImplementer: class {}
}))

vi.mock('./codex-implementer', () => ({
  CodexImplementer: class {}
}))

vi.mock('./agent-event-bus', () => ({
  agentEventBus: {
    subscribe: vi.fn(() => vi.fn())
  }
}))

const seedForwardingState = (
  service: TelegramForwardingService,
  overrides: Record<string, unknown> = {}
): void => {
  Reflect.set(service, 'db', {
    getSetting: () =>
      JSON.stringify({ botToken: 'token', chatId: 123, chatName: 'me', contextSize: 3 }),
    getWorktree: () => ({ path: '/repo', branch_name: 'branch' }),
    getSession: () => ({ project_id: 'p1', agent_sdk: 'opencode', opencode_session_id: 'agent-1' }),
    getProject: () => ({ name: 'Project' })
  })
  Reflect.set(service, 'state', {
    sessionId: 's1',
    worktreeId: 'w1',
    connectionId: null,
    mode: 'all',
    contextSize: 3,
    recentAssistantTurns: [],
    assistantBuffer: '',
    assistantFlushTimer: null,
    currentTurnText: '',
    pendingQueuedPrompt: null,
    lastUpdateId: 0,
    startedAtSeconds: 1,
    isBusy: false,
    previousWasAssistantText: false,
    hasOutstandingInteraction: false,
    pollAbort: null,
    firstFailureSurfaced: false,
    ...overrides
  })
}

describe('TelegramForwardingService backend events', () => {
  it('publishes status changes through the backend event publisher', () => {
    const service = new TelegramForwardingService()
    const publish = vi.fn()
    seedForwardingState(service, {
      firstFailureSurfaced: true
    })
    service.setBackendEventPublisher(publish)

    const emitStatus = Reflect.get(service, 'emitStatus') as (lastError?: string) => void
    emitStatus.call(service, 'Telegram delivery failed')

    expect(publish).toHaveBeenCalledWith(
      TELEGRAM_STATUS_CHANGED_CHANNEL,
      expect.objectContaining({
        active: true,
        sessionId: 's1',
        worktreeId: 'w1',
        connectionId: null,
        mode: 'all',
        health: 'error',
        lastError: 'Telegram delivery failed'
      })
    )
  })

  it('publishes plan handoff requests through the backend event publisher', async () => {
    const service = new TelegramForwardingService()
    const publish = vi.fn()
    seedForwardingState(service)
    service.setBackendEventPublisher(publish)

    const requestPlanHandoff = Reflect.get(service, 'requestPlanHandoff') as (interaction: {
      requestId: string
      plan?: string
    }) => Promise<void>
    await requestPlanHandoff.call(service, {
      requestId: 'codex-plan:thread-1',
      plan: 'Do the work.'
    })

    expect(publish).toHaveBeenCalledWith(TELEGRAM_PLAN_IMPLEMENT_REQUESTED_CHANNEL, {
      sessionId: 's1',
      worktreeId: 'w1',
      connectionId: null,
      requestId: 'codex-plan:thread-1',
      plan: 'Do the work.'
    })
  })
})
