// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerResponse } from 'node:http'
import {
  CliHookHoldCore,
  SAFETY_TIMEOUT_MS,
  type ClaudeHookBody
} from '../cli-hook-hold-core'
import type { OpenCodeStreamEvent } from '@shared/types/opencode'

function makeRes(): ServerResponse & { body: string | null; close: () => void } {
  let closeHandler: (() => void) | null = null
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
    on: vi.fn((_event: string, handler: () => void) => {
      closeHandler = handler
      return res
    }),
    removeListener: vi.fn(),
    close: () => closeHandler?.()
  }
  return res as unknown as ServerResponse & { body: string | null; close: () => void }
}

const makeCore = () => {
  const shared: OpenCodeStreamEvent[] = []
  const transport: OpenCodeStreamEvent[] = []
  const core = new CliHookHoldCore({
    name: 'test',
    emitShared: (event) => shared.push(event),
    emitTransport: (event) => transport.push(event)
  })
  return { core, shared, transport }
}

const SESSION = 'cli-session-1'

afterEach(() => {
  vi.useRealTimers()
})

describe('CliHookHoldCore', () => {
  it('holds AskUserQuestion and resolves with allow + answers keyed by question text', () => {
    const { core, shared } = makeCore()
    core.register(SESSION)
    const res = makeRes()
    const body: ClaudeHookBody = {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          { question: 'Pick one', header: 'Choice', options: [{ label: 'A' }, { label: 'B' }] }
        ]
      }
    }

    expect(core.onHook(SESSION, body, res)).toBe(true)
    expect(res.setTimeout).toHaveBeenCalledWith(0)
    expect(res.end).not.toHaveBeenCalled()

    const requestId = (shared.find((event) => event.type === 'question.asked')!.data as { requestId: string })
      .requestId
    expect(core.hasPendingQuestion(requestId)).toBe(true)

    core.resolveQuestion(requestId, [['B']])

    const written = JSON.parse(res.body!)
    expect(written.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Answered via test'
    })
    expect(written.hookSpecificOutput.updatedInput.answers).toEqual({ 'Pick one': 'B' })
    expect(shared.some((event) => event.type === 'question.replied')).toBe(true)
    expect(core.hasPendingQuestion(requestId)).toBe(false)
  })

  it('holds ExitPlanMode on the transport channel and denies with feedback', () => {
    const { core, transport } = makeCore()
    core.register(SESSION)
    const res = makeRes()

    expect(
      core.onHook(
        SESSION,
        { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: 'Plan' } },
        res
      )
    ).toBe(true)

    const requestId = (transport.find((event) => event.type === 'plan.ready')!.data as { requestId: string })
      .requestId
    core.resolvePlan(requestId, false, 'Add tests first')

    expect(JSON.parse(res.body!).hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Add tests first'
    })
  })

  it('expires held hooks with cleanup events so remote controls can be disabled', () => {
    vi.useFakeTimers()
    const { core, shared } = makeCore()
    core.register(SESSION)
    const res = makeRes()
    core.onHook(
      SESSION,
      { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Q?' }] } },
      res
    )

    vi.advanceTimersByTime(SAFETY_TIMEOUT_MS + 1)

    expect(res.end).toHaveBeenCalledWith('{}')
    expect(shared.some((event) => event.type === 'question.rejected')).toBe(true)
  })

  it('does not write when the held response closes and removes the pending entry', () => {
    const { core, shared } = makeCore()
    core.register(SESSION)
    const res = makeRes()
    core.onHook(
      SESSION,
      { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Q?' }] } },
      res
    )
    const requestId = (shared.find((event) => event.type === 'question.asked')!.data as { requestId: string })
      .requestId

    res.close()

    expect(res.end).not.toHaveBeenCalled()
    expect(core.hasPendingQuestion(requestId)).toBe(false)
    expect(shared.some((event) => event.type === 'question.rejected')).toBe(true)
  })

  it('Stop with ctx.suppressIdle emits neither message.updated nor session.idle', () => {
    const { core, transport } = makeCore()
    core.register(SESSION)
    const res = makeRes()

    const owned = core.onHook(
      SESSION,
      { hook_event_name: 'Stop', last_assistant_message: 'All done.' },
      res,
      { suppressIdle: true }
    )

    expect(owned).toBe(false)
    expect(transport.some((event) => event.type === 'message.updated')).toBe(false)
    expect(transport.some((event) => event.type === 'session.idle')).toBe(false)
  })

  it('Stop with no ctx / suppressIdle: false emits idle unchanged (regression)', () => {
    const { core, transport } = makeCore()
    core.register(SESSION)
    const res = makeRes()

    core.onHook(SESSION, { hook_event_name: 'Stop', last_assistant_message: 'All done.' }, res)

    expect(transport.find((event) => event.type === 'message.updated')).toBeTruthy()
    expect(transport.some((event) => event.type === 'session.idle')).toBe(true)

    const { core: core2, transport: transport2 } = makeCore()
    core2.register(SESSION)
    const res2 = makeRes()
    core2.onHook(SESSION, { hook_event_name: 'Stop', last_assistant_message: 'All done.' }, res2, {
      suppressIdle: false
    })

    expect(transport2.find((event) => event.type === 'message.updated')).toBeTruthy()
    expect(transport2.some((event) => event.type === 'session.idle')).toBe(true)
  })

  it('emitSessionIdle(sessionId, text) emits message.updated then session.idle', () => {
    const { core, transport } = makeCore()

    core.emitSessionIdle(SESSION, 'Finished the task.')

    expect(transport).toHaveLength(2)
    expect(transport[0]).toMatchObject({
      type: 'message.updated',
      sessionId: SESSION,
      data: { role: 'assistant', content: 'Finished the task.' }
    })
    expect(transport[1]).toMatchObject({ type: 'session.idle', sessionId: SESSION })
  })

  it('emitSessionIdle(sessionId) with no text emits only session.idle', () => {
    const { core, transport } = makeCore()

    core.emitSessionIdle(SESSION)

    expect(transport).toHaveLength(1)
    expect(transport[0]).toMatchObject({ type: 'session.idle', sessionId: SESSION })
  })
})
