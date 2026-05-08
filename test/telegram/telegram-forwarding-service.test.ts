// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

const { questionReply, prompt } = vi.hoisted(() => ({
  questionReply: vi.fn(),
  prompt: vi.fn()
}))

vi.mock('../../src/main/services/opencode-service', () => ({
  openCodeService: {
    questionReply,
    prompt
  }
}))

import {
  buildTelegramCallbackData,
  extractAssistantText,
  formatTelegramText,
  isTrackedInteractionStale,
  TelegramForwardingService
} from '../../src/main/services/telegram-forwarding-service'
import { agentEventBus } from '../../src/main/services/agent-event-bus'
import type { OpenCodeStreamEvent } from '../../src/shared/types/opencode'

type SendMessageBody = { text: string }

function createTelegramFetchMock(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as SendMessageBody : {}
    if (String(_url).endsWith('/sendMessage')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: { message_id: fetchMock.mock.calls.length, text: body.text, chat: { id: 123, type: 'private' } }
        })
      } as Response
    }
    return {
      ok: true,
      json: async () => ({ ok: true, result: true })
    } as Response
  })
  return fetchMock
}

function sentTelegramTexts(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith('/sendMessage'))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as SendMessageBody)
    .map((body) => body.text)
}

function seedForwardingState(
  service: TelegramForwardingService,
  overrides: Record<string, unknown> = {}
): void {
  Reflect.set(service, 'db', {
    getSetting: () => JSON.stringify({ botToken: 'token', chatId: 123, chatName: 'me', contextSize: 3 }),
    getWorktree: () => ({ path: '/repo', branch_name: 'branch' }),
    getSession: () => ({ project_id: 'p1', agent_sdk: 'opencode', opencode_session_id: 'agent-1' }),
    getProject: () => ({ name: 'Project' })
  })
  Reflect.set(service, 'state', {
    sessionId: 's1',
    worktreeId: 'w1',
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

function assistantDelta(text: string): OpenCodeStreamEvent {
  return {
    type: 'message.part.updated',
    sessionId: 's1',
    data: {
      role: 'assistant',
      part: { type: 'text', text }
    }
  }
}

describe('telegram forwarding helpers', () => {
  beforeEach(() => {
    questionReply.mockReset()
    prompt.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('formats Telegram plain text within the API message limit', () => {
    const raw = `hello\u0000\n${'x'.repeat(5000)}`

    const formatted = formatTelegramText(raw)

    expect(formatted).not.toContain('\u0000')
    expect(formatted.length).toBeLessThanOrEqual(4096)
    expect(formatted.endsWith('...')).toBe(true)
  })

  it('extracts only assistant text from message update events', () => {
    const text = extractAssistantText({
      type: 'message.part.updated',
      sessionId: 's1',
      data: {
        role: 'assistant',
        part: { type: 'text', text: 'assistant text' },
        delta: 'assistant text'
      }
    })

    const tool = extractAssistantText({
      type: 'message.part.updated',
      sessionId: 's1',
      data: {
        role: 'assistant',
        part: { type: 'tool', text: 'hidden' },
        delta: 'hidden'
      }
    })

    const user = extractAssistantText({
      type: 'message.part.updated',
      sessionId: 's1',
      data: {
        role: 'user',
        part: { type: 'text', text: 'user text' },
        delta: 'user text'
      }
    })

    expect(text).toBe('assistant text')
    expect(tool).toBeNull()
    expect(user).toBeNull()
  })

  it('builds compact callback payloads for Telegram inline buttons', () => {
    expect(buildTelegramCallbackData('question', 'req-123', '2')).toBe('q:req-123:2')
    expect(buildTelegramCallbackData('permission', 'req-123', 'a')).toBe('p:req-123:a')
    expect(buildTelegramCallbackData('command', 'req-123', 'b')).toBe('c:req-123:b')
    expect(buildTelegramCallbackData('plan', 'req-123', 'i')).toBe('pl:req-123:i')
  })

  it('keeps callback payloads within Telegram limits', () => {
    const payload = buildTelegramCallbackData('plan', 'x'.repeat(100), 'i')

    expect(payload.length).toBeLessThanOrEqual(64)
    expect(payload.startsWith('pl:')).toBe(true)
    expect(payload.endsWith(':i')).toBe(true)
  })

  it('marks a Telegram interaction stale when its request is no longer tracked', () => {
    const tracked = new Map<string, unknown>([['req-1', {}]])

    expect(isTrackedInteractionStale(tracked, 'req-1')).toBe(false)
    expect(isTrackedInteractionStale(tracked, 'req-2')).toBe(true)
  })

  it('forwards multi-question batches sequentially and replies only after the last answer', async () => {
    const service = new TelegramForwardingService()
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { text?: string } : {}
      if (String(_url).endsWith('/sendMessage')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            result: { message_id: fetchMock.mock.calls.length, text: body.text, chat: { id: 123, type: 'private' } }
          })
        } as Response
      }
      return {
        ok: true,
        json: async () => ({ ok: true, result: true })
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    questionReply.mockResolvedValue(undefined)

    Reflect.set(service, 'db', {
      getSetting: () => JSON.stringify({ botToken: 'token', chatId: 123, chatName: 'me', contextSize: 3 }),
      getWorktree: () => ({ path: '/repo', branch_name: 'branch' }),
      getSession: () => ({ project_id: 'p1', agent_sdk: 'opencode' }),
      getProject: () => ({ name: 'Project' })
    })
    Reflect.set(service, 'state', {
      sessionId: 's1',
      worktreeId: 'w1',
      mode: 'questions',
      contextSize: 3,
      recentAssistantTurns: ['assistant context'],
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
      firstFailureSurfaced: false
    })

    const handleAgentEvent = Reflect.get(service, 'handleAgentEvent') as (
      event: OpenCodeStreamEvent
    ) => Promise<void>
    const handleCallbackQuery = Reflect.get(service, 'handleCallbackQuery') as (query: {
      id: string
      data: string
      message: { message_id: number; chat: { id: number; type: 'private' } }
    }) => Promise<void>

    const questionEvent: OpenCodeStreamEvent = {
      type: 'question.asked',
      sessionId: 's1',
      data: {
        id: 'req-1',
        questions: [
          { header: 'First', question: 'First?', options: [{ label: 'A' }, { label: 'B' }] },
          { header: 'Second', question: 'Second?', options: [{ label: 'C' }, { label: 'D' }] }
        ]
      }
    }

    await handleAgentEvent.call(service, questionEvent)

    const sentMessages = () =>
      fetchMock.mock.calls
        .filter(([url]) => String(url).endsWith('/sendMessage'))
        .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { text: string })

    expect(sentMessages().map((body) => body.text)).toEqual([
      'Recent context:\nassistant context',
      'First (1/2)\n\nFirst?'
    ])

    await handleAgentEvent.call(service, questionEvent)
    expect(sentMessages().map((body) => body.text)).toEqual([
      'Recent context:\nassistant context',
      'First (1/2)\n\nFirst?'
    ])

    await handleCallbackQuery.call(service, {
      id: 'cb-1',
      data: 'q:req-1:0-1',
      message: { message_id: 2, chat: { id: 123, type: 'private' } }
    })

    expect(questionReply).not.toHaveBeenCalled()
    expect(sentMessages().map((body) => body.text)).toEqual([
      'Recent context:\nassistant context',
      'First (1/2)\n\nFirst?',
      'Second (2/2)\n\nSecond?'
    ])
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/answerCallbackQuery'))).toBe(true)

    const streamEvents: OpenCodeStreamEvent[] = []
    const unsubscribe = agentEventBus.subscribe((event) => streamEvents.push(event))

    await handleCallbackQuery.call(service, {
      id: 'cb-2',
      data: 'q:req-1:1-0',
      message: { message_id: 4, chat: { id: 123, type: 'private' } }
    })
    unsubscribe()

    expect(questionReply).toHaveBeenCalledWith('req-1', [['B'], ['C']], '/repo')
    expect(streamEvents).toContainEqual({
      type: 'question.replied',
      sessionId: 's1',
      data: { requestId: 'req-1', id: 'req-1' }
    })
  })

  it('handles plan handoff callbacks for request ids containing colons', async () => {
    const service = new TelegramForwardingService()
    const webContentsSend = vi.fn()
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { text?: string; reply_markup?: unknown } : {}
      if (String(_url).endsWith('/sendMessage')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            result: { message_id: fetchMock.mock.calls.length, text: body.text, chat: { id: 123, type: 'private' } }
          })
        } as Response
      }
      return {
        ok: true,
        json: async () => ({ ok: true, result: true })
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    Reflect.set(service, 'mainWindow', {
      isDestroyed: () => false,
      webContents: { send: webContentsSend }
    })
    Reflect.set(service, 'db', {
      getSetting: () => JSON.stringify({ botToken: 'token', chatId: 123, chatName: 'me', contextSize: 3 }),
      getWorktree: () => ({ path: '/repo', branch_name: 'branch' }),
      getSession: () => ({ project_id: 'p1', agent_sdk: 'codex' }),
      getProject: () => ({ name: 'Project' })
    })
    Reflect.set(service, 'state', {
      sessionId: 's1',
      worktreeId: 'w1',
      mode: 'questions',
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
      firstFailureSurfaced: false
    })

    const handleAgentEvent = Reflect.get(service, 'handleAgentEvent') as (
      event: OpenCodeStreamEvent
    ) => Promise<void>
    const handleCallbackQuery = Reflect.get(service, 'handleCallbackQuery') as (query: {
      id: string
      data: string
      message: { message_id: number; chat: { id: number; type: 'private' } }
    }) => Promise<void>

    await handleAgentEvent.call(service, {
      type: 'plan.ready',
      sessionId: 's1',
      data: {
        id: 'codex-plan:thread-1',
        plan: 'Do the work.'
      }
    })

    const sendMessageCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/sendMessage'))
    const sendBody = JSON.parse(String((sendMessageCall?.[1] as RequestInit).body)) as {
      reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
    }
    expect(sendBody.reply_markup.inline_keyboard).toEqual([
      [
        { text: 'Implement', callback_data: 'pl:codex-plan:thread-1:i' },
        { text: 'Handoff', callback_data: 'pl:codex-plan:thread-1:h' }
      ]
    ])

    await handleCallbackQuery.call(service, {
      id: 'cb-plan',
      data: 'pl:codex-plan:thread-1:h',
      message: { message_id: 1, chat: { id: 123, type: 'private' } }
    })

    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/answerCallbackQuery'))).toBe(true)
    expect(webContentsSend).toHaveBeenCalledWith(
      'telegram:planImplementRequested',
      expect.objectContaining({
        sessionId: 's1',
        worktreeId: 'w1',
        requestId: 'codex-plan:thread-1',
        plan: 'Do the work.'
      })
    )
  })

  it('implements a pending plan and publishes plan.resolved for Hive', async () => {
    const service = new TelegramForwardingService()
    const approvePlan = vi.fn().mockResolvedValue(undefined)
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { text?: string } : {}
      if (String(_url).endsWith('/sendMessage')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            result: { message_id: fetchMock.mock.calls.length, text: body.text, chat: { id: 123, type: 'private' } }
          })
        } as Response
      }
      return {
        ok: true,
        json: async () => ({ ok: true, result: true })
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    Reflect.set(service, 'approvePlan', approvePlan)
    Reflect.set(service, 'db', {
      getSetting: () => JSON.stringify({ botToken: 'token', chatId: 123, chatName: 'me', contextSize: 3 }),
      getWorktree: () => ({ path: '/repo', branch_name: 'branch' }),
      getSession: () => ({ project_id: 'p1', agent_sdk: 'claude-code' }),
      getProject: () => ({ name: 'Project' })
    })
    Reflect.set(service, 'state', {
      sessionId: 's1',
      worktreeId: 'w1',
      mode: 'questions',
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
      firstFailureSurfaced: false
    })

    const handleAgentEvent = Reflect.get(service, 'handleAgentEvent') as (
      event: OpenCodeStreamEvent
    ) => Promise<void>
    const handleCallbackQuery = Reflect.get(service, 'handleCallbackQuery') as (query: {
      id: string
      data: string
      message: { message_id: number; chat: { id: number; type: 'private' } }
    }) => Promise<void>
    const streamEvents: OpenCodeStreamEvent[] = []
    const unsubscribe = agentEventBus.subscribe((event) => streamEvents.push(event))

    await handleAgentEvent.call(service, {
      type: 'plan.ready',
      sessionId: 's1',
      data: {
        id: 'plan-1',
        plan: 'Original plan.'
      }
    })
    await handleCallbackQuery.call(service, {
      id: 'cb-implement',
      data: 'pl:plan-1:i',
      message: { message_id: 1, chat: { id: 123, type: 'private' } }
    })
    unsubscribe()

    expect(approvePlan).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'plan-1' }))
    expect(streamEvents).toContainEqual({
      type: 'plan.resolved',
      sessionId: 's1',
      data: { requestId: 'plan-1', id: 'plan-1', approved: true, resolution: 'implement' }
    })
  })

  it('sends a final Telegram confirmation when a plan implementation becomes idle', async () => {
    const service = new TelegramForwardingService()
    const approvePlan = vi.fn().mockResolvedValue(undefined)
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { text?: string } : {}
      if (String(_url).endsWith('/sendMessage')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            result: { message_id: fetchMock.mock.calls.length, text: body.text, chat: { id: 123, type: 'private' } }
          })
        } as Response
      }
      return {
        ok: true,
        json: async () => ({ ok: true, result: true })
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    Reflect.set(service, 'approvePlan', approvePlan)
    Reflect.set(service, 'db', {
      getSetting: () => JSON.stringify({ botToken: 'token', chatId: 123, chatName: 'me', contextSize: 3 }),
      getWorktree: () => ({ path: '/repo', branch_name: 'branch' }),
      getSession: () => ({ project_id: 'p1', agent_sdk: 'claude-code' }),
      getProject: () => ({ name: 'Project' })
    })
    Reflect.set(service, 'state', {
      sessionId: 's1',
      worktreeId: 'w1',
      mode: 'questions',
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
      firstFailureSurfaced: false
    })

    const handleAgentEvent = Reflect.get(service, 'handleAgentEvent') as (
      event: OpenCodeStreamEvent
    ) => Promise<void>
    const handleCallbackQuery = Reflect.get(service, 'handleCallbackQuery') as (query: {
      id: string
      data: string
      message: { message_id: number; chat: { id: number; type: 'private' } }
    }) => Promise<void>

    await handleAgentEvent.call(service, {
      type: 'plan.ready',
      sessionId: 's1',
      data: {
        id: 'plan-1',
        plan: 'Original plan.'
      }
    })
    await handleCallbackQuery.call(service, {
      id: 'cb-implement',
      data: 'pl:plan-1:i',
      message: { message_id: 1, chat: { id: 123, type: 'private' } }
    })
    await handleAgentEvent.call(service, {
      type: 'message.part.updated',
      sessionId: 's1',
      data: {
        role: 'assistant',
        part: { type: 'text', text: 'Implementation complete.' }
      }
    })
    await handleAgentEvent.call(service, {
      type: 'session.status',
      sessionId: 's1',
      statusPayload: { type: 'idle' },
      data: { status: { type: 'idle' } }
    })

    const sentTexts = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/sendMessage'))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { text: string })
      .map((body) => body.text)

    expect(sentTexts).toContain('Session idle.\n\nRecent context:\nImplementation complete.')
  })

  it('treats plain text as feedback while a plan is pending', async () => {
    const service = new TelegramForwardingService()
    const rejectPlan = vi.fn().mockResolvedValue(undefined)
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { text?: string } : {}
      if (String(_url).endsWith('/sendMessage')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            result: { message_id: fetchMock.mock.calls.length, text: body.text, chat: { id: 123, type: 'private' } }
          })
        } as Response
      }
      return {
        ok: true,
        json: async () => ({ ok: true, result: true })
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    Reflect.set(service, 'rejectPlan', rejectPlan)
    Reflect.set(service, 'db', {
      getSetting: () => JSON.stringify({ botToken: 'token', chatId: 123, chatName: 'me', contextSize: 3 }),
      getWorktree: () => ({ path: '/repo', branch_name: 'branch' }),
      getSession: () => ({ project_id: 'p1', agent_sdk: 'claude-code' }),
      getProject: () => ({ name: 'Project' })
    })
    Reflect.set(service, 'state', {
      sessionId: 's1',
      worktreeId: 'w1',
      mode: 'questions',
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
      firstFailureSurfaced: false
    })

    const handleAgentEvent = Reflect.get(service, 'handleAgentEvent') as (
      event: OpenCodeStreamEvent
    ) => Promise<void>
    const handleTextMessage = Reflect.get(service, 'handleTextMessage') as (message: {
      message_id: number
      text: string
      chat: { id: number; type: 'private' }
    }) => Promise<void>

    const streamEvents: OpenCodeStreamEvent[] = []
    const unsubscribe = agentEventBus.subscribe((event) => streamEvents.push(event))

    await handleAgentEvent.call(service, {
      type: 'plan.ready',
      sessionId: 's1',
      data: {
        id: 'plan-1',
        plan: 'Original plan.'
      }
    })
    await handleTextMessage.call(service, {
      message_id: 99,
      text: 'Please change the plan.',
      chat: { id: 123, type: 'private' }
    })

    expect(rejectPlan).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'plan', requestId: 'plan-1' }),
      'Please change the plan.'
    )
    expect(prompt).not.toHaveBeenCalled()
    unsubscribe()
    expect(streamEvents).toContainEqual({
      type: 'plan.resolved',
      sessionId: 's1',
      data: {
        requestId: 'plan-1',
        id: 'plan-1',
        approved: false,
        resolution: 'feedback',
        feedback: 'Please change the plan.'
      }
    })
  })

  it('sends plan feedback as a prompt for non-blocking plan sessions and clears Hive plan UI', async () => {
    const service = new TelegramForwardingService()
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { text?: string } : {}
      if (String(_url).endsWith('/sendMessage')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            result: { message_id: fetchMock.mock.calls.length, text: body.text, chat: { id: 123, type: 'private' } }
          })
        } as Response
      }
      return {
        ok: true,
        json: async () => ({ ok: true, result: true })
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    prompt.mockResolvedValue(undefined)
    Reflect.set(service, 'db', {
      getSetting: () => JSON.stringify({ botToken: 'token', chatId: 123, chatName: 'me', contextSize: 3 }),
      getWorktree: () => ({ path: '/repo', branch_name: 'branch' }),
      getSession: () => ({ project_id: 'p1', agent_sdk: 'opencode', opencode_session_id: 'agent-1' }),
      getProject: () => ({ name: 'Project' })
    })
    Reflect.set(service, 'state', {
      sessionId: 's1',
      worktreeId: 'w1',
      mode: 'questions',
      contextSize: 3,
      recentAssistantTurns: [],
      assistantBuffer: '',
      assistantFlushTimer: null,
      currentTurnText: '',
      pendingQueuedPrompt: null,
      lastUpdateId: 0,
      startedAtSeconds: 1,
      isBusy: true,
      previousWasAssistantText: false,
      hasOutstandingInteraction: false,
      pollAbort: null,
      firstFailureSurfaced: false
    })

    const handleAgentEvent = Reflect.get(service, 'handleAgentEvent') as (
      event: OpenCodeStreamEvent
    ) => Promise<void>
    const handleTextMessage = Reflect.get(service, 'handleTextMessage') as (message: {
      message_id: number
      text: string
      chat: { id: number; type: 'private' }
    }) => Promise<void>
    const streamEvents: OpenCodeStreamEvent[] = []
    const unsubscribe = agentEventBus.subscribe((event) => streamEvents.push(event))

    await handleAgentEvent.call(service, {
      type: 'plan.ready',
      sessionId: 's1',
      data: {
        id: 'plan-2',
        plan: 'Original plan.'
      }
    })
    await handleTextMessage.call(service, {
      message_id: 100,
      text: 'Revise this plan.',
      chat: { id: 123, type: 'private' }
    })
    unsubscribe()

    expect(prompt).toHaveBeenCalledWith('/repo', 'agent-1', [
      { type: 'text', text: 'Revise this plan.' }
    ])
    expect(streamEvents).toContainEqual({
      type: 'plan.resolved',
      sessionId: 's1',
      data: {
        requestId: 'plan-2',
        id: 'plan-2',
        approved: false,
        resolution: 'feedback',
        feedback: 'Revise this plan.'
      }
    })
  })

  it('ignores stale Telegram text updates from before forwarding started', async () => {
    const service = new TelegramForwardingService()
    prompt.mockResolvedValue(undefined)
    Reflect.set(service, 'db', {
      getSetting: () => JSON.stringify({ botToken: 'token', chatId: 123, chatName: 'me', contextSize: 3 }),
      getWorktree: () => ({ path: '/repo', branch_name: 'branch' }),
      getSession: () => ({ project_id: 'p1', agent_sdk: 'opencode', opencode_session_id: 'agent-1' }),
      getProject: () => ({ name: 'Project' })
    })
    Reflect.set(service, 'state', {
      sessionId: 's1',
      worktreeId: 'w1',
      mode: 'questions',
      contextSize: 3,
      recentAssistantTurns: [],
      assistantBuffer: '',
      assistantFlushTimer: null,
      currentTurnText: '',
      pendingQueuedPrompt: null,
      lastUpdateId: 0,
      startedAtSeconds: 100,
      isBusy: false,
      previousWasAssistantText: false,
      hasOutstandingInteraction: false,
      pollAbort: null,
      firstFailureSurfaced: false
    })

    const handleUpdate = Reflect.get(service, 'handleUpdate') as (update: {
      update_id: number
      message: {
        message_id: number
        date: number
        text: string
        chat: { id: number; type: 'private' }
      }
    }) => Promise<void>

    await handleUpdate.call(service, {
      update_id: 1,
      message: {
        message_id: 10,
        date: 50,
        text: 'old text that must not be sent',
        chat: { id: 123, type: 'private' }
      }
    })
    expect(prompt).not.toHaveBeenCalled()

    await handleUpdate.call(service, {
      update_id: 2,
      message: {
        message_id: 11,
        date: 101,
        text: 'new text',
        chat: { id: 123, type: 'private' }
      }
    })
    expect(prompt).toHaveBeenCalledWith('/repo', 'agent-1', [
      { type: 'text', text: 'new text' }
    ])
  })

  it('drains pending Telegram updates before polling a new forwarding session', async () => {
    const service = new TelegramForwardingService()
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { offset?: number } : {}
      const result =
        body.offset === undefined
          ? [
              { update_id: 3, message: { message_id: 1, date: 10, text: 'old-1', chat: { id: 123, type: 'private' } } },
              { update_id: 4, message: { message_id: 2, date: 11, text: 'old-2', chat: { id: 123, type: 'private' } } }
            ]
          : []
      return {
        ok: true,
        json: async () => ({ ok: true, result })
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    const discardPendingUpdates = Reflect.get(service, 'discardPendingUpdates') as (cfg: {
      botToken: string
      chatId: number
      chatName: string
      contextSize: number
    }) => Promise<number>
    const lastUpdateId = await discardPendingUpdates.call(service, {
      botToken: 'token',
      chatId: 123,
      chatName: 'me',
      contextSize: 3
    })

    expect(lastUpdateId).toBe(4)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throttles streaming assistant text in all mode', async () => {
    vi.useFakeTimers()
    const service = new TelegramForwardingService()
    const fetchMock = createTelegramFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    seedForwardingState(service)
    const handleAgentEvent = Reflect.get(service, 'handleAgentEvent') as (
      event: OpenCodeStreamEvent
    ) => Promise<void>

    for (let i = 0; i < 10; i++) {
      await handleAgentEvent.call(service, assistantDelta(String(i)))
    }

    expect(sentTelegramTexts(fetchMock)).toEqual([])

    await vi.advanceTimersByTimeAsync(2000)

    expect(sentTelegramTexts(fetchMock)).toEqual(['0123456789'])
  })

  it('sends separate assistant messages for separate flush windows', async () => {
    vi.useFakeTimers()
    const service = new TelegramForwardingService()
    const fetchMock = createTelegramFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    seedForwardingState(service)
    const handleAgentEvent = Reflect.get(service, 'handleAgentEvent') as (
      event: OpenCodeStreamEvent
    ) => Promise<void>

    for (const text of ['a', 'b', 'c', 'd', 'e']) {
      await handleAgentEvent.call(service, assistantDelta(text))
    }
    await vi.advanceTimersByTimeAsync(2000)

    expect(sentTelegramTexts(fetchMock)).toEqual(['abcde'])

    for (const text of ['f', 'g', 'h', 'i', 'j']) {
      await handleAgentEvent.call(service, assistantDelta(text))
    }
    await vi.advanceTimersByTimeAsync(2000)

    expect(sentTelegramTexts(fetchMock)).toEqual(['abcde', 'fghij'])
  })

  it('flushes assistant text immediately on session idle and cancels the pending timer', async () => {
    vi.useFakeTimers()
    const service = new TelegramForwardingService()
    const fetchMock = createTelegramFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    seedForwardingState(service)
    const handleAgentEvent = Reflect.get(service, 'handleAgentEvent') as (
      event: OpenCodeStreamEvent
    ) => Promise<void>

    await handleAgentEvent.call(service, assistantDelta('hel'))
    await handleAgentEvent.call(service, assistantDelta('lo'))
    await handleAgentEvent.call(service, {
      type: 'session.idle',
      sessionId: 's1'
    })

    expect(sentTelegramTexts(fetchMock)).toEqual(['hello'])

    await vi.advanceTimersByTimeAsync(2000)

    expect(sentTelegramTexts(fetchMock)).toEqual(['hello'])
  })

  it('does not send streaming text in questions mode but records one full turn for idle context', async () => {
    vi.useFakeTimers()
    const service = new TelegramForwardingService()
    const fetchMock = createTelegramFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    seedForwardingState(service, { mode: 'questions' })
    const handleAgentEvent = Reflect.get(service, 'handleAgentEvent') as (
      event: OpenCodeStreamEvent
    ) => Promise<void>

    await handleAgentEvent.call(service, assistantDelta('Readable '))
    await handleAgentEvent.call(service, assistantDelta('full '))
    await handleAgentEvent.call(service, assistantDelta('turn.'))

    expect(sentTelegramTexts(fetchMock)).toEqual([])

    await handleAgentEvent.call(service, {
      type: 'session.idle',
      sessionId: 's1'
    })

    expect(sentTelegramTexts(fetchMock)).toEqual([
      'Session idle.\n\nRecent context:\nReadable full turn.'
    ])
  })

  it('drops buffered assistant text when forwarding stops mid-stream', async () => {
    vi.useFakeTimers()
    const service = new TelegramForwardingService()
    const fetchMock = createTelegramFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    seedForwardingState(service)
    const handleAgentEvent = Reflect.get(service, 'handleAgentEvent') as (
      event: OpenCodeStreamEvent
    ) => Promise<void>

    await handleAgentEvent.call(service, assistantDelta('late text'))
    await service.stopForwarding('manual')
    await vi.advanceTimersByTimeAsync(2000)

    expect(sentTelegramTexts(fetchMock)).toEqual(['Forwarding stopped.'])
  })

  it('does not schedule a flush for empty assistant deltas', async () => {
    vi.useFakeTimers()
    const service = new TelegramForwardingService()
    const fetchMock = createTelegramFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    seedForwardingState(service)
    const handleAgentEvent = Reflect.get(service, 'handleAgentEvent') as (
      event: OpenCodeStreamEvent
    ) => Promise<void>

    await handleAgentEvent.call(service, assistantDelta('   '))

    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(2000)

    expect(sentTelegramTexts(fetchMock)).toEqual([])
  })
})
