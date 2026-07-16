import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TELEGRAM_PLAN_IMPLEMENT_REQUESTED_CHANNEL,
  TELEGRAM_STATUS_CHANGED_CHANNEL
} from '../../shared/telegram-events'
import {
  DESKTOP_COMMAND_REQUEST_TYPE,
  DESKTOP_COMMAND_RESULT_TYPE,
  type DesktopCommandRequest
} from '../../shared/desktop-command'
import {
  CODEX_CLI_SUPER_PLAN_MODE_PREFIX,
  CODEX_PLAN_MODE_PREFIX
} from '../../shared/agent-mode-prefixes'
import { writeClaudeCliPrompt } from './claude-cli-pty-prompt'
import { applyCodexCliPlanPrefix, TelegramForwardingService } from './telegram-forwarding-service'

vi.mock('./claude-cli-pty-prompt', () => ({
  writeClaudeCliPrompt: vi.fn(() => ({ delivered: true }))
}))

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

const originalProcessSend = (process as NodeJS.Process & { send?: unknown }).send

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (originalProcessSend === undefined) {
    delete (process as NodeJS.Process & { send?: unknown }).send
  } else {
    Object.defineProperty(process, 'send', {
      value: originalProcessSend,
      configurable: true
    })
  }
})

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

describe('applyCodexCliPlanPrefix', () => {
  it('prefixes codex-cli plan / super-plan prompts with the codex plan prefix', () => {
    expect(applyCodexCliPlanPrefix('codex-cli', 'plan', 'do X')).toBe(
      CODEX_PLAN_MODE_PREFIX + 'do X'
    )
    expect(applyCodexCliPlanPrefix('codex-cli', 'super-plan', 'do X')).toBe(
      CODEX_CLI_SUPER_PLAN_MODE_PREFIX + 'do X'
    )
  })

  it('leaves codex-cli build/ask prompts and null mode verbatim', () => {
    expect(applyCodexCliPlanPrefix('codex-cli', 'build', 'do X')).toBe('do X')
    expect(applyCodexCliPlanPrefix('codex-cli', 'ask', 'do X')).toBe('do X')
    expect(applyCodexCliPlanPrefix('codex-cli', null, 'do X')).toBe('do X')
  })

  it('never prefixes claude-code-cli (permission-mode drives its plan) or non-CLI SDKs', () => {
    expect(applyCodexCliPlanPrefix('claude-code-cli', 'plan', 'do X')).toBe('do X')
    expect(applyCodexCliPlanPrefix('codex', 'plan', 'do X')).toBe('do X')
    expect(applyCodexCliPlanPrefix('opencode', 'super-plan', 'do X')).toBe('do X')
  })
})

describe('TelegramForwardingService.sendPrompt CLI routing', () => {
  it('injects a codex-cli plan follow-up into the PTY with the codex plan prefix', async () => {
    vi.mocked(writeClaudeCliPrompt).mockClear()
    const service = new TelegramForwardingService()
    seedForwardingState(service)
    Reflect.set(service, 'db', {
      getSession: () => ({ agent_sdk: 'codex-cli', mode: 'plan', opencode_session_id: null })
    })

    const sendPrompt = Reflect.get(service, 'sendPrompt') as (text: string) => Promise<void>
    await sendPrompt.call(service, 'add a test')

    expect(writeClaudeCliPrompt).toHaveBeenCalledWith('s1', CODEX_PLAN_MODE_PREFIX + 'add a test')
  })

  it('injects a claude-code-cli follow-up into the PTY verbatim (no plan prefix)', async () => {
    vi.mocked(writeClaudeCliPrompt).mockClear()
    const service = new TelegramForwardingService()
    seedForwardingState(service)
    Reflect.set(service, 'db', {
      getSession: () => ({ agent_sdk: 'claude-code-cli', mode: 'plan', opencode_session_id: null })
    })

    const sendPrompt = Reflect.get(service, 'sendPrompt') as (text: string) => Promise<void>
    await sendPrompt.call(service, 'add a test')

    expect(writeClaudeCliPrompt).toHaveBeenCalledWith('s1', 'add a test')
  })
})

describe('TelegramForwardingService Claude CLI forwarding bridge', () => {
  it('registers and cancels Claude CLI hook interception through desktop IPC', async () => {
    const service = new TelegramForwardingService()
    const sentCommands: DesktopCommandRequest[] = []
    const existingMessageListeners = new Set(process.listeners('message'))
    vi.stubEnv('HIVE_SERVER_MODE', 'desktop')
    vi.stubEnv('HIVE_DESKTOP_BOOTSTRAP_TOKEN', 'test-bootstrap-token')
    const send = vi.fn((message: unknown, callback?: (error: Error | null) => void) => {
      sentCommands.push(message as DesktopCommandRequest)
      queueMicrotask(() => {
        for (const listener of process.listeners('message')) {
          if (existingMessageListeners.has(listener)) continue
          listener({
            type: DESKTOP_COMMAND_RESULT_TYPE,
            id: (message as DesktopCommandRequest).id,
            ok: true,
            value: { success: true }
          })
        }
      })
      callback?.(null)
      return true
    })
    Object.defineProperty(process, 'send', {
      value: send,
      configurable: true
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () =>
          url.includes('/sendMessage')
            ? {
                ok: true,
                result: { message_id: 1, chat: { id: 123, type: 'private' }, text: 'ok' }
              }
            : { ok: true, result: [] }
      }))
    )
    service.initialize({
      db: {
        getSetting: () =>
          JSON.stringify({ botToken: 'token', chatId: 123, chatName: 'me', contextSize: 3 }),
        getWorktree: () => ({ path: '/repo', branch_name: 'branch' }),
        getSession: () => ({
          project_id: 'p1',
          agent_sdk: 'claude-code-cli',
          opencode_session_id: null
        }),
        getProject: () => ({ name: 'Project' }),
        setSetting: vi.fn(),
        deleteSetting: vi.fn()
      } as never
    })

    await service.startForwarding({
      sessionId: 'cli-session-1',
      worktreeId: 'w1',
      connectionId: null,
      mode: 'all'
    })
    await service.stopForwarding()

    expect(sentCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: DESKTOP_COMMAND_REQUEST_TYPE,
          command: 'telegramClaudeCliRegister',
          payload: { sessionId: 'cli-session-1' }
        }),
        expect.objectContaining({
          type: DESKTOP_COMMAND_REQUEST_TYPE,
          command: 'telegramClaudeCliCancel',
          payload: { sessionId: 'cli-session-1' }
        })
      ])
    )
  })
})
