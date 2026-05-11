import { describe, expect, it } from 'vitest'
import {
  getQuitConfirmationDecision,
  readWarnBeforeQuitting
} from '../../src/main/quit-confirmation'

describe('quit confirmation decision', () => {
  it('defaults warnBeforeQuitting to enabled when settings are missing', () => {
    expect(readWarnBeforeQuitting(null)).toBe(true)
  })

  it('reads warnBeforeQuitting=false from the app settings JSON blob', () => {
    expect(readWarnBeforeQuitting(JSON.stringify({ warnBeforeQuitting: false }))).toBe(false)
  })

  it('falls back to enabled when settings JSON is invalid', () => {
    expect(readWarnBeforeQuitting('{bad json')).toBe(true)
  })

  it('prevents the first quit attempt and records its timestamp', () => {
    expect(
      getQuitConfirmationDecision({
        now: 1000,
        lastQuitConfirmAt: null,
        warnBeforeQuitting: true,
        confirmationWindowMs: 2000
      })
    ).toEqual({ shouldPreventQuit: true, lastQuitConfirmAt: 1000 })
  })

  it('allows a second quit attempt inside the confirmation window', () => {
    expect(
      getQuitConfirmationDecision({
        now: 2500,
        lastQuitConfirmAt: 1000,
        warnBeforeQuitting: true,
        confirmationWindowMs: 2000
      })
    ).toEqual({ shouldPreventQuit: false, lastQuitConfirmAt: 1000 })
  })

  it('starts a fresh confirmation window after the previous one expires', () => {
    expect(
      getQuitConfirmationDecision({
        now: 3100,
        lastQuitConfirmAt: 1000,
        warnBeforeQuitting: true,
        confirmationWindowMs: 2000
      })
    ).toEqual({ shouldPreventQuit: true, lastQuitConfirmAt: 3100 })
  })

  it('allows quit immediately when warning is disabled', () => {
    expect(
      getQuitConfirmationDecision({
        now: 1000,
        lastQuitConfirmAt: null,
        warnBeforeQuitting: false,
        confirmationWindowMs: 2000
      })
    ).toEqual({ shouldPreventQuit: false, lastQuitConfirmAt: null })
  })
})
