import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { ptyService } = vi.hoisted(() => ({
  ptyService: { has: vi.fn(() => true), write: vi.fn() }
}))
vi.mock('./pty-service', () => ({ ptyService }))

import {
  GROK_PROMPT_AFTER_TOGGLE_MS,
  clearAllGrokCliTerminals,
  registerGrokCliTerminal,
  stampGrokModeToggle,
  unregisterGrokCliTerminal,
  writeCliTerminalPaced
} from './grok-input-pacing'

const PASTE = '\x1b[200~do the thing\x1b[201~\r'
const TOGGLE = '\x1b[Z'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  clearAllGrokCliTerminals()
  vi.clearAllMocks()
  ptyService.has.mockReturnValue(true)
  vi.useRealTimers()
})

describe('writeCliTerminalPaced', () => {
  it('writes non-grok terminal input through untouched, even paste after toggles', () => {
    writeCliTerminalPaced('claude-1', TOGGLE)
    writeCliTerminalPaced('claude-1', PASTE)
    expect(ptyService.write).toHaveBeenNthCalledWith(1, 'claude-1', TOGGLE)
    expect(ptyService.write).toHaveBeenNthCalledWith(2, 'claude-1', PASTE)
  })

  it('holds a grok paste that follows a mode toggle until the settle window elapses', () => {
    registerGrokCliTerminal('grok-1')
    writeCliTerminalPaced('grok-1', TOGGLE)
    writeCliTerminalPaced('grok-1', TOGGLE)
    expect(ptyService.write).toHaveBeenCalledTimes(2)

    writeCliTerminalPaced('grok-1', PASTE)
    // Prompt is NOT written synchronously — grok has not processed the
    // toggles yet; submitting now would run in the previous mode.
    expect(ptyService.write).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(GROK_PROMPT_AFTER_TOGGLE_MS)
    expect(ptyService.write).toHaveBeenCalledTimes(3)
    expect(ptyService.write).toHaveBeenLastCalledWith('grok-1', PASTE)
  })

  it('writes a grok paste immediately when no toggle preceded it', () => {
    registerGrokCliTerminal('grok-1')
    writeCliTerminalPaced('grok-1', PASTE)
    expect(ptyService.write).toHaveBeenCalledWith('grok-1', PASTE)
  })

  it('writes a grok paste immediately once the settle window has already passed', () => {
    registerGrokCliTerminal('grok-1')
    writeCliTerminalPaced('grok-1', TOGGLE)
    vi.advanceTimersByTime(GROK_PROMPT_AFTER_TOGGLE_MS + 1)
    writeCliTerminalPaced('grok-1', PASTE)
    expect(ptyService.write).toHaveBeenLastCalledWith('grok-1', PASTE)
  })

  it('drops a held paste if the PTY is gone when the window elapses', () => {
    registerGrokCliTerminal('grok-1')
    writeCliTerminalPaced('grok-1', TOGGLE)
    writeCliTerminalPaced('grok-1', PASTE)
    ptyService.has.mockReturnValue(false)
    vi.advanceTimersByTime(GROK_PROMPT_AFTER_TOGGLE_MS)
    // Only the toggle was ever written; nothing goes to a torn-down terminal.
    expect(ptyService.write).toHaveBeenCalledTimes(1)
  })

  it('never mistakes paste CONTENT containing the toggle sequence for a mode switch', () => {
    registerGrokCliTerminal('grok-1')
    writeCliTerminalPaced('grok-1', `\x1b[200~text with ${TOGGLE} inside\x1b[201~\r`)
    // The paste wrote through immediately (no prior toggle)…
    expect(ptyService.write).toHaveBeenCalledTimes(1)
    // …and did not stamp a toggle: the next paste is also immediate.
    writeCliTerminalPaced('grok-1', PASTE)
    expect(ptyService.write).toHaveBeenCalledTimes(2)
  })

  it('paces a renderer paste behind a launch-path toggle stamped explicitly', () => {
    registerGrokCliTerminal('grok-1')
    stampGrokModeToggle('grok-1')
    writeCliTerminalPaced('grok-1', PASTE)
    expect(ptyService.write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(GROK_PROMPT_AFTER_TOGGLE_MS)
    expect(ptyService.write).toHaveBeenCalledWith('grok-1', PASTE)
  })

  it('unregister clears pacing state for the terminal', () => {
    registerGrokCliTerminal('grok-1')
    writeCliTerminalPaced('grok-1', TOGGLE)
    unregisterGrokCliTerminal('grok-1')
    writeCliTerminalPaced('grok-1', PASTE)
    expect(ptyService.write).toHaveBeenLastCalledWith('grok-1', PASTE)
  })
})
