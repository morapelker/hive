import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  publishDesktopBackendEvent: vi.fn(async () => true)
}))

vi.mock('../desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: mocks.publishDesktopBackendEvent
}))

vi.mock('./logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import {
  armClaudeCliLaunchWatch,
  clearAllClaudeCliLaunchWatches,
  clearClaudeCliLaunchWatch,
  containsClaudeTrustDialog,
  getClaudeCliLaunchState,
  normalizeClaudeCliOutput,
  noteClaudeCliLaunchHook,
  observeClaudeCliLaunchOutput
} from './claude-cli-launch-watch'

// The dialog exactly as claude 2.1.301 draws it in a PTY: every word placed
// with a cursor-column move, colours around the heading and the options.
const TRUST_DIALOG_2_1 =
  '\x1b[38;2;255;193;7m\x1b[1mAccessing\x1b[12Gworkspace:\x1b[22m\x1b[39m\r\r\n\r\r\n' +
  '\x1b[2G\x1b[1m/private/tmp/tc-trust-probe\x1b[22m\r\r\n\r\r\n' +
  '\x1b[2GQuick\x1b[8Gsafety\x1b[15Gcheck:\x1b[22GIs\x1b[25Gthis\x1b[30Ga\x1b[32Gproject\x1b[40Gyou\x1b[44Gcreated\x1b[52Gor\x1b[55Gone\x1b[59Gyou\x1b[63Gtrust?\r\r\n' +
  "\x1b[2Gtake\x1b[7Ga\x1b[9Gmoment\x1b[16Gto\x1b[19Greview\x1b[26Gwhat's\x1b[33Gin\x1b[36Gthis\x1b[41Gfolder\x1b[48Gfirst.\r\r\n\r\r\n" +
  '\x1b[2G\x1b[38;2;177;185;249m❯\x1b[4GNo,\x1b[8Gexit\x1b[39m\r\r\n' +
  '\x1b[4GYes,\x1b[9GI\x1b[11Gtrust\x1b[17Gthis\x1b[22Gfolder\r\r\n\r\r\n' +
  '\x1b[2G\x1b[38;2;153;153;153mEnter\x1b[8Gto\x1b[11Gconfirm\x1b[19G·\x1b[21GEsc\x1b[25Gto\x1b[28Gcancel'

const SESSION = 'session-1'

describe('claude-cli launch watch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.publishDesktopBackendEvent.mockClear()
  })

  afterEach(() => {
    clearAllClaudeCliLaunchWatches()
    vi.useRealTimers()
  })

  it('recognises the folder-trust dialog through cursor moves and colours', () => {
    expect(containsClaudeTrustDialog(normalizeClaudeCliOutput(TRUST_DIALOG_2_1))).toBe(true)
    // The older wording stays recognised.
    expect(
      containsClaudeTrustDialog(
        normalizeClaudeCliOutput('Do you trust the files in this folder?\r\n ❯ 1. Yes, proceed')
      )
    ).toBe(true)
    // Ordinary REPL output does not match.
    expect(
      containsClaudeTrustDialog(
        normalizeClaudeCliOutput('\x1b[2J Welcome to Claude Code! ⏵⏵ bypass permissions on')
      )
    ).toBe(false)
  })

  it('publishes awaiting_trust once when the dialog shows up, even split across chunks', () => {
    const onTrustDialog = vi.fn()
    armClaudeCliLaunchWatch(SESSION, { onTrustDialog })

    const cut = Math.floor(TRUST_DIALOG_2_1.length / 2)
    observeClaudeCliLaunchOutput(SESSION, TRUST_DIALOG_2_1.slice(0, cut))
    observeClaudeCliLaunchOutput(SESSION, TRUST_DIALOG_2_1.slice(cut))
    observeClaudeCliLaunchOutput(SESSION, TRUST_DIALOG_2_1)

    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledTimes(1)
    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith('claude-cli:launch', {
      sessionId: SESSION,
      state: 'awaiting_trust',
      detail: 'trust_dialog'
    })
    expect(onTrustDialog).toHaveBeenCalledTimes(1)
    expect(getClaudeCliLaunchState(SESSION)).toBe('awaiting_trust')

    // The dialog already explains the silence: the timeout must not add a second mark.
    vi.advanceTimersByTime(60_000)
    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledTimes(1)
  })

  it('publishes not_started when no hook arrives within the launch window', () => {
    armClaudeCliLaunchWatch(SESSION, { timeoutMs: 1_000 })
    observeClaudeCliLaunchOutput(SESSION, 'Welcome to Claude Code!')

    vi.advanceTimersByTime(999)
    expect(mocks.publishDesktopBackendEvent).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith('claude-cli:launch', {
      sessionId: SESSION,
      state: 'not_started',
      detail: 'no_session_start'
    })
  })

  it('ends the watch silently when a hook arrives in time', () => {
    armClaudeCliLaunchWatch(SESSION, { timeoutMs: 1_000 })
    noteClaudeCliLaunchHook(SESSION, 'SessionStart')
    vi.advanceTimersByTime(5_000)
    observeClaudeCliLaunchOutput(SESSION, TRUST_DIALOG_2_1)

    expect(mocks.publishDesktopBackendEvent).not.toHaveBeenCalled()
    expect(getClaudeCliLaunchState(SESSION)).toBeNull()
  })

  it('clears a published mark once the session starts after all', () => {
    armClaudeCliLaunchWatch(SESSION)
    observeClaudeCliLaunchOutput(SESSION, TRUST_DIALOG_2_1)
    noteClaudeCliLaunchHook(SESSION, 'SessionStart')

    expect(mocks.publishDesktopBackendEvent).toHaveBeenLastCalledWith('claude-cli:launch', {
      sessionId: SESSION,
      state: 'clear',
      detail: 'hook:SessionStart'
    })
  })

  it('clears a published mark when the PTY goes away, and stays quiet otherwise', () => {
    armClaudeCliLaunchWatch(SESSION, { timeoutMs: 1_000 })
    clearClaudeCliLaunchWatch(SESSION)
    vi.advanceTimersByTime(5_000)
    expect(mocks.publishDesktopBackendEvent).not.toHaveBeenCalled()

    armClaudeCliLaunchWatch(SESSION, { timeoutMs: 1_000 })
    vi.advanceTimersByTime(1_000)
    clearClaudeCliLaunchWatch(SESSION, 'pty_exit')
    expect(mocks.publishDesktopBackendEvent).toHaveBeenLastCalledWith('claude-cli:launch', {
      sessionId: SESSION,
      state: 'clear',
      detail: 'pty_exit'
    })
  })

  it('re-arming for a respawn drops the previous watch', () => {
    armClaudeCliLaunchWatch(SESSION, { timeoutMs: 1_000 })
    vi.advanceTimersByTime(900)
    armClaudeCliLaunchWatch(SESSION, { timeoutMs: 1_000 })
    vi.advanceTimersByTime(900)
    expect(mocks.publishDesktopBackendEvent).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledTimes(1)
  })
})
