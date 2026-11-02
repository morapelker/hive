import { describe, expect, it } from 'vitest'
import {
  SHELL_COMMAND_REPLAY_END,
  SHELL_COMMAND_REPLAY_OSC,
  SHELL_COMMAND_REPLAY_START,
  SHELL_COMMAND_STATUS_CHANNEL,
  isShellCommandStatusPayload,
  wrapShellCommandReplay,
  type ShellCommandStatusPayload
} from '../shell-command-events'
import { SHELL_COMMAND_RUN_STATES } from '../lib/shell-commands'

const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)

const payload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  sessionId: 'session-1',
  runId: 'run-1',
  state: 'failed',
  exitCode: 3,
  signal: null,
  detached: false,
  reason: null,
  error: null,
  startedAt: '2026-10-05T00:00:00.000Z',
  finishedAt: '2026-10-05T00:00:05.000Z',
  ...overrides
})

const without = (key: keyof ShellCommandStatusPayload): Record<string, unknown> => {
  const copy = payload()
  delete copy[key]
  return copy
}

describe('shell-command status payload', () => {
  it('uses a dedicated channel', () => {
    expect(SHELL_COMMAND_STATUS_CHANNEL).toBe('shell-command:status')
  })

  it('accepts a full payload in every state', () => {
    expect(isShellCommandStatusPayload(payload())).toBe(true)
    for (const state of SHELL_COMMAND_RUN_STATES) {
      expect(isShellCommandStatusPayload(payload({ state }))).toBe(true)
    }
    expect(
      isShellCommandStatusPayload(
        payload({
          runId: null,
          exitCode: null,
          signal: 15,
          detached: true,
          reason: 'start-failed',
          error: 'Worktree not found',
          startedAt: null,
          finishedAt: null
        })
      )
    ).toBe(true)
    expect(isShellCommandStatusPayload(payload({ reason: 'output-limit' }))).toBe(true)
  })

  it('rejects non-objects', () => {
    for (const value of [null, undefined, 'running', 42, []]) {
      expect(isShellCommandStatusPayload(value)).toBe(false)
    }
  })

  it('rejects a wrong or missing state', () => {
    expect(isShellCommandStatusPayload(payload({ state: 'done' }))).toBe(false)
    expect(isShellCommandStatusPayload(payload({ state: 1 }))).toBe(false)
    expect(isShellCommandStatusPayload(without('state'))).toBe(false)
  })

  it('rejects a missing or non-boolean detached', () => {
    expect(isShellCommandStatusPayload(without('detached'))).toBe(false)
    expect(isShellCommandStatusPayload(payload({ detached: 'false' }))).toBe(false)
    expect(isShellCommandStatusPayload(payload({ detached: null }))).toBe(false)
  })

  it('rejects wrong field types and missing nullable fields', () => {
    expect(isShellCommandStatusPayload(without('sessionId'))).toBe(false)
    expect(isShellCommandStatusPayload(payload({ sessionId: 7 }))).toBe(false)
    expect(isShellCommandStatusPayload(payload({ runId: 7 }))).toBe(false)
    expect(isShellCommandStatusPayload(payload({ exitCode: '3' }))).toBe(false)
    expect(isShellCommandStatusPayload(payload({ signal: 'SIGTERM' }))).toBe(false)
    expect(isShellCommandStatusPayload(payload({ reason: 'because' }))).toBe(false)
    expect(isShellCommandStatusPayload(payload({ error: 5 }))).toBe(false)
    expect(isShellCommandStatusPayload(payload({ startedAt: 5 }))).toBe(false)
    expect(isShellCommandStatusPayload(payload({ finishedAt: 5 }))).toBe(false)
    for (const key of ['runId', 'exitCode', 'signal', 'reason', 'error', 'finishedAt'] as const) {
      expect(isShellCommandStatusPayload(without(key))).toBe(false)
    }
  })
})

describe('wrapShellCommandReplay', () => {
  const start = `${ESC}]7777;hive-replay-start${BEL}`
  const end = `${ESC}]7777;hive-replay-end${BEL}`

  it('exposes the protocol constants', () => {
    expect(SHELL_COMMAND_REPLAY_OSC).toBe(7777)
    expect(SHELL_COMMAND_REPLAY_START).toBe('hive-replay-start')
    expect(SHELL_COMMAND_REPLAY_END).toBe('hive-replay-end')
  })

  it('brackets the transcript: start marker, RIS, transcript, end marker', () => {
    const transcript = 'line one\r\nline two\r\n'
    const wrapped = wrapShellCommandReplay(transcript)

    expect(wrapped.startsWith(`${start}${ESC}c`)).toBe(true)
    expect(wrapped.endsWith(end)).toBe(true)
    expect(wrapped).toBe(`${start}${ESC}c${transcript}${end}`)
  })

  it('produces a bare reset for an empty transcript', () => {
    expect(wrapShellCommandReplay('')).toBe(`${start}${ESC}c${end}`)
  })
})
