import { describe, expect, it, vi } from 'vitest'
import type { OpenCodeStreamEvent } from '@shared/types/opencode'
import type { SessionFinalMessageUpsert } from './db-port'
import { SDK_BUSY_EVENT, SDK_IDLE_EVENT, startSdkTurnRecorder } from './sdk-turn-recorder'

function setup(sdkBySession: Record<string, string | null> = {}): {
  emit: (event: OpenCodeStreamEvent) => void
  recorded: SessionFinalMessageUpsert[]
  stop: () => void
  listenerCount: () => number
} {
  const listeners = new Set<(event: OpenCodeStreamEvent) => void>()
  const recorded: SessionFinalMessageUpsert[] = []
  const stop = startSdkTurnRecorder({
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSessionSdk: (sessionId) => sdkBySession[sessionId] ?? null,
    record: (input) => recorded.push(input)
  })
  return {
    emit: (event) => listeners.forEach((listener) => listener(event)),
    recorded,
    stop,
    listenerCount: () => listeners.size
  }
}

const status = (
  sessionId: string,
  type: 'idle' | 'busy' | 'retry',
  extra: Partial<OpenCodeStreamEvent> = {}
): OpenCodeStreamEvent => ({
  type: 'session.status',
  sessionId,
  data: { status: { type } },
  statusPayload: { type },
  ...extra
})

const idle = (sessionId: string, extra: Partial<OpenCodeStreamEvent> = {}): OpenCodeStreamEvent =>
  status(sessionId, 'idle', extra)

const ended = (sessionId: string): SessionFinalMessageUpsert => ({
  session_id: sessionId,
  state: 'ended',
  hook_event: SDK_IDLE_EVENT,
  detail: null,
  text: '',
  completion: null,
  api_error: null
})

describe('startSdkTurnRecorder', () => {
  it('records the turn end of an SDK session going idle', () => {
    const { emit, recorded } = setup({ s1: 'claude-code' })
    emit(idle('s1'))
    expect(recorded).toEqual([ended('s1')])
  })

  it('records sessions whose row is unknown, and codex and opencode ones', () => {
    const { emit, recorded } = setup({ s2: 'codex', s3: 'opencode' })
    emit(idle('s1'))
    emit(idle('s2'))
    emit(idle('s3'))
    expect(recorded.map((entry) => entry.session_id)).toEqual(['s1', 's2', 's3'])
  })

  it('records a session getting to work once, without touching the last turn end’s text', () => {
    const { emit, recorded } = setup({ s1: 'claude-code' })
    emit(status('s1', 'busy'))
    emit(status('s1', 'busy'))
    emit(status('s1', 'retry', { statusPayload: { type: 'retry', attempt: 1 } }))
    emit(status('s1', 'busy'))

    expect(recorded).toEqual([
      {
        session_id: 's1',
        state: 'working',
        hook_event: SDK_BUSY_EVENT,
        detail: null,
        completion: null,
        api_error: null
      }
    ])
    expect('text' in recorded[0]).toBe(false)
  })

  it('records a question, a permission and a plan as the session stopping for the user', () => {
    const { emit, recorded } = setup({ s1: 'codex' })
    emit({
      type: 'question.asked',
      sessionId: 's1',
      data: { id: 'q-1', questions: [{ question: ' Which currency? ', header: 'Currency' }] }
    })
    emit(status('s1', 'busy'))
    emit({
      type: 'permission.asked',
      sessionId: 's1',
      data: { id: 'p-1', sessionID: 's1', permission: 'bash', patterns: [] }
    })
    emit(status('s1', 'busy'))
    emit({ type: 'plan.ready', sessionId: 's1', data: { id: 'plan-1', plan: '# Plan' } })

    expect(
      recorded.map(({ state, hook_event, detail }) => ({ state, hook_event, detail }))
    ).toEqual([
      { state: 'blocked', hook_event: 'answering', detail: 'Which currency?' },
      { state: 'working', hook_event: SDK_BUSY_EVENT, detail: null },
      { state: 'blocked', hook_event: 'permission', detail: 'bash' },
      { state: 'working', hook_event: SDK_BUSY_EVENT, detail: null },
      { state: 'blocked', hook_event: 'plan_ready', detail: null }
    ])
  })

  it('records an answered question, permission, approval or plan as the session working again', () => {
    const { emit, recorded } = setup({ s1: 'claude-code' })
    const asked: OpenCodeStreamEvent = {
      type: 'question.asked',
      sessionId: 's1',
      data: { id: 'q-1', questions: [{ question: 'Which currency?' }] }
    }
    // A reply with no block recorded before it: the session is working, said once.
    emit({ type: 'question.replied', sessionId: 's1', data: { requestId: 'q-0' } })
    emit({ type: 'question.replied', sessionId: 's1', data: { requestId: 'q-0' } })
    emit(asked)
    emit({ type: 'question.replied', sessionId: 's1', data: { requestId: 'q-1' } })
    emit({
      type: 'permission.asked',
      sessionId: 's1',
      data: { id: 'p-1', sessionID: 's1', permission: 'bash', patterns: [] }
    })
    emit({
      type: 'permission.replied',
      sessionId: 's1',
      data: { requestId: 'p-1', decision: 'once' }
    })
    emit({
      type: 'command.approval_needed',
      sessionId: 's1',
      data: { id: 'c-1', toolName: 'Bash', commandStr: 'rm -rf dist' }
    })
    emit({ type: 'command.approval_replied', sessionId: 's1', data: { requestId: 'c-1' } })
    emit({ type: 'plan.ready', sessionId: 's1', data: { id: 'plan-1', plan: '# Plan' } })
    emit({ type: 'plan.resolved', sessionId: 's1', data: { approved: true } })
    emit(asked)
    emit({ type: 'question.rejected', sessionId: 's1', data: { requestId: 'q-1' } })
    emit(idle('s1'))

    expect(recorded.map(({ state, hook_event }) => `${state}:${hook_event}`)).toEqual([
      `working:${SDK_BUSY_EVENT}`,
      'blocked:answering',
      `working:${SDK_BUSY_EVENT}`,
      'blocked:permission',
      `working:${SDK_BUSY_EVENT}`,
      'blocked:command_approval',
      `working:${SDK_BUSY_EVENT}`,
      'blocked:plan_ready',
      `working:${SDK_BUSY_EVENT}`,
      'blocked:answering',
      `working:${SDK_BUSY_EVENT}`,
      `ended:${SDK_IDLE_EVENT}`
    ])
    expect(
      recorded.filter((entry) => entry.state === 'working').every((entry) => entry.detail === null)
    ).toBe(true)
    expect(recorded.find((entry) => entry.hook_event === 'command_approval')?.detail).toBe(
      'rm -rf dist'
    )
  })

  it('falls back to the question header, then to no text', () => {
    const { emit, recorded } = setup({ s1: 'claude-code' })
    emit({
      type: 'question.asked',
      sessionId: 's1',
      data: { id: 'q-1', questions: [{ question: '', header: 'Currency' }] }
    })
    emit({ type: 'question.asked', sessionId: 's2', data: { id: 'q-2', questions: [] } })

    expect(recorded.map((entry) => entry.detail)).toEqual(['Currency', null])
  })

  it('records every turn end, and a new state after one', () => {
    const { emit, recorded } = setup({ s1: 'claude-code' })
    emit(status('s1', 'busy'))
    emit(idle('s1'))
    emit(idle('s1'))
    emit(status('s1', 'busy'))

    expect(recorded.map((entry) => entry.state)).toEqual(['working', 'ended', 'ended', 'working'])
  })

  it('ignores a retry status and other event types', () => {
    const { emit, recorded } = setup({ s1: 'claude-code' })
    emit(status('s1', 'retry', { statusPayload: { type: 'retry', attempt: 1 } }))
    emit(idle('s1', { statusPayload: undefined }))
    emit({ type: 'session.idle', sessionId: 's1', data: {} })
    emit({ type: 'message.updated', sessionId: 's1', data: {}, statusPayload: { type: 'idle' } })
    emit({ type: 'session.updated', sessionId: 's1', data: {} })
    expect(recorded).toEqual([])
  })

  it('ignores a subagent’s events', () => {
    const { emit, recorded } = setup({ s1: 'opencode' })
    emit(idle('s1', { childSessionId: 'child-1' }))
    emit(status('s1', 'busy', { childSessionId: 'child-1' }))
    emit({ type: 'question.asked', sessionId: 's1', childSessionId: 'child-1', data: {} })
    expect(recorded).toEqual([])
  })

  it('leaves CLI sessions to their hooks', () => {
    const { emit, recorded } = setup({ s1: 'claude-code-cli', s2: 'codex-cli' })
    emit(idle('s1'))
    emit(status('s1', 'busy'))
    emit(idle('s2'))
    emit({ type: 'question.asked', sessionId: 's2', data: { id: 'q', questions: [] } })
    expect(recorded).toEqual([])
  })

  it('never throws into the stream', () => {
    const listeners: ((event: OpenCodeStreamEvent) => void)[] = []
    startSdkTurnRecorder({
      subscribe: (listener) => {
        listeners.push(listener)
        return () => undefined
      },
      getSessionSdk: () => {
        throw new Error('database is closed')
      },
      record: vi.fn()
    })
    expect(() => listeners[0](idle('s1'))).not.toThrow()
  })

  it('stops listening when stopped', () => {
    const { emit, recorded, stop, listenerCount } = setup({ s1: 'claude-code' })
    stop()
    expect(listenerCount()).toBe(0)
    emit(idle('s1'))
    expect(recorded).toEqual([])
  })
})
