// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerResponse } from 'node:http'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

// Question events flow through agentEventBus (renderer + telegram); capture them.
const { publishedEvents } = vi.hoisted(() => ({ publishedEvents: [] as Array<{ type: string; sessionId: string; data: unknown }> }))
vi.mock('../agent-event-bus', () => ({
  agentEventBus: { publish: (event: { type: string; sessionId: string; data: unknown }) => publishedEvents.push(event) }
}))

import { claudeCliTelegramBridge, type ClaudeHookBody } from '../claude-cli-telegram-bridge'
import type { OpenCodeStreamEvent } from '@shared/types/opencode'

/** Minimal fake ServerResponse capturing what the bridge writes. */
function makeRes(): ServerResponse & { body: string | null } {
  const res = {
    writableEnded: false,
    body: null as string | null,
    setTimeout: vi.fn(),
    writeHead: vi.fn(function (this: unknown) {
      return this
    }),
    end: vi.fn(function (this: { writableEnded: boolean; body: string | null }, body?: string) {
      this.writableEnded = true
      this.body = body ?? ''
    }),
    on: vi.fn(),
    removeListener: vi.fn()
  }
  return res as unknown as ServerResponse & { body: string | null }
}

const SESSION = 'cli-session-1'

afterEach(() => {
  claudeCliTelegramBridge.cancelAll()
  publishedEvents.length = 0
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('claudeCliTelegramBridge.onHook (registration gating)', () => {
  it('does not take ownership for an unregistered session', () => {
    const res = makeRes()
    const owned = claudeCliTelegramBridge.onHook(
      SESSION,
      { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Q?' }] } },
      res
    )
    expect(owned).toBe(false)
    expect(res.end).not.toHaveBeenCalled()
    expect(publishedEvents).toHaveLength(0)
  })

  it('does not hold when forwarding-registered but the tool is not a question/plan', () => {
    claudeCliTelegramBridge.register(SESSION)
    const res = makeRes()
    const owned = claudeCliTelegramBridge.onHook(
      SESSION,
      { hook_event_name: 'PostToolUse', tool_name: 'Bash' },
      res
    )
    expect(owned).toBe(false)
  })
})

describe('claudeCliTelegramBridge questions (renderer + telegram via agentEventBus)', () => {
  beforeEach(() => claudeCliTelegramBridge.register(SESSION))

  it('holds the response, publishes question.asked, and resolves with an allow + answers map', () => {
    const res = makeRes()
    const body: ClaudeHookBody = {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          { question: 'Pick a language', header: 'Lang', options: [{ label: 'TypeScript' }, { label: 'Rust' }] }
        ]
      }
    }

    const owned = claudeCliTelegramBridge.onHook(SESSION, body, res)
    expect(owned).toBe(true)
    expect(res.end).not.toHaveBeenCalled() // held open

    const asked = publishedEvents.find((e) => e.type === 'question.asked')
    expect(asked).toBeTruthy()
    const requestId = (asked!.data as { requestId: string }).requestId
    expect(claudeCliTelegramBridge.hasPendingQuestion(requestId)).toBe(true)

    claudeCliTelegramBridge.resolveQuestion(requestId, [['TypeScript']])

    expect(res.end).toHaveBeenCalledTimes(1)
    const written = JSON.parse(res.body!)
    expect(written.hookSpecificOutput.permissionDecision).toBe('allow')
    expect(written.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    // answers keyed by question TEXT, value = the selected option label
    expect(written.hookSpecificOutput.updatedInput.answers).toEqual({ 'Pick a language': 'TypeScript' })
    expect(written.hookSpecificOutput.updatedInput.questions).toEqual(body.tool_input!.questions)
    // a question.replied is published so the in-app UI + telegram message clear
    expect(publishedEvents.some((e) => e.type === 'question.replied')).toBe(true)
    expect(claudeCliTelegramBridge.hasPendingQuestion(requestId)).toBe(false)
  })

  it('rejectQuestion resolves with {} and publishes question.rejected', () => {
    const res = makeRes()
    claudeCliTelegramBridge.onHook(
      SESSION,
      { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Q?' }] } },
      res
    )
    const requestId = (publishedEvents.find((e) => e.type === 'question.asked')!.data as { requestId: string })
      .requestId
    claudeCliTelegramBridge.rejectQuestion(requestId)
    expect(res.end).toHaveBeenCalledWith('{}')
    expect(publishedEvents.some((e) => e.type === 'question.rejected')).toBe(true)
  })

  it('falls back (returns false) when AskUserQuestion has no questions', () => {
    const res = makeRes()
    const owned = claudeCliTelegramBridge.onHook(
      SESSION,
      { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [] } },
      res
    )
    expect(owned).toBe(false)
    expect(publishedEvents).toHaveLength(0)
  })
})

describe('claudeCliTelegramBridge plans (telegram-only private channel)', () => {
  let events: OpenCodeStreamEvent[]
  let unsub: () => void
  beforeEach(() => {
    events = []
    unsub = claudeCliTelegramBridge.subscribe((e) => events.push(e))
    claudeCliTelegramBridge.register(SESSION)
  })
  afterEach(() => unsub())

  it('emits plan.ready on the private channel, NOT to the renderer', () => {
    const res = makeRes()
    const owned = claudeCliTelegramBridge.onHook(
      SESSION,
      { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: '# Plan\n1. Do it' } },
      res
    )
    expect(owned).toBe(true)
    const ready = events.find((e) => e.type === 'plan.ready')!
    expect((ready.data as { plan: string }).plan).toContain('# Plan')
    // plan events must NOT reach the renderer (would collide with the CLI plan card)
    expect(publishedEvents.some((e) => e.type === 'plan.ready')).toBe(false)

    const requestId = (ready.data as { requestId: string }).requestId
    claudeCliTelegramBridge.resolvePlan(requestId, true)
    expect(JSON.parse(res.body!).hookSpecificOutput.permissionDecision).toBe('allow')
  })

  it('rejects a held plan with deny + feedback as the reason', () => {
    const res = makeRes()
    claudeCliTelegramBridge.onHook(
      SESSION,
      { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: 'plan' } },
      res
    )
    const requestId = (events.find((e) => e.type === 'plan.ready')!.data as { requestId: string }).requestId
    claudeCliTelegramBridge.resolvePlan(requestId, false, 'Please add tests')
    const written = JSON.parse(res.body!)
    expect(written.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(written.hookSpecificOutput.permissionDecisionReason).toBe('Please add tests')
  })
})

describe('claudeCliTelegramBridge Stop + busy bridging (private channel)', () => {
  it('emits assistant text + idle on Stop (both message field spellings)', () => {
    const events: OpenCodeStreamEvent[] = []
    const unsub = claudeCliTelegramBridge.subscribe((e) => events.push(e))
    claudeCliTelegramBridge.register(SESSION)

    const owned = claudeCliTelegramBridge.onHook(
      SESSION,
      { hook_event_name: 'Stop', last_assistant_message: 'All done.' },
      makeRes()
    )
    expect(owned).toBe(false)
    const msg = events.find((e) => e.type === 'message.updated')
    expect((msg!.data as { content: string }).content).toBe('All done.')
    expect(events.some((e) => e.type === 'session.idle')).toBe(true)
    expect(publishedEvents).toHaveLength(0) // never reaches the renderer
    unsub()
  })

  it('emits session.busy on UserPromptSubmit / PostToolUse', () => {
    const events: OpenCodeStreamEvent[] = []
    const unsub = claudeCliTelegramBridge.subscribe((e) => events.push(e))
    claudeCliTelegramBridge.register(SESSION)
    claudeCliTelegramBridge.onHook(SESSION, { hook_event_name: 'UserPromptSubmit' }, makeRes())
    expect(events.some((e) => e.type === 'session.busy')).toBe(true)
    unsub()
  })
})

describe('claudeCliTelegramBridge teardown', () => {
  it('cancelSession unblocks a held question with {}, clears the in-app UI, and stops intercepting', () => {
    claudeCliTelegramBridge.register(SESSION)
    const res = makeRes()
    claudeCliTelegramBridge.onHook(
      SESSION,
      { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Q?' }] } },
      res
    )
    claudeCliTelegramBridge.cancelSession(SESSION)
    expect(res.end).toHaveBeenCalledWith('{}')
    expect(publishedEvents.some((e) => e.type === 'question.rejected')).toBe(true)
    expect(claudeCliTelegramBridge.isRegistered(SESSION)).toBe(false)
  })

  it('the safety timeout resolves a held question with {} and clears the in-app UI', () => {
    vi.useFakeTimers()
    claudeCliTelegramBridge.register(SESSION)
    const res = makeRes()
    claudeCliTelegramBridge.onHook(
      SESSION,
      { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Q?' }] } },
      res
    )
    vi.advanceTimersByTime(9 * 60 * 1000 + 1000)
    expect(res.end).toHaveBeenCalledWith('{}')
    expect(publishedEvents.some((e) => e.type === 'question.rejected')).toBe(true)
  })
})
