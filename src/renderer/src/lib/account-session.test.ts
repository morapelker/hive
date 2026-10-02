import { describe, expect, it } from 'vitest'
import { sessionEndingSoonLabel, staleAccountNotice } from './account-session'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const NOW = Date.parse('2026-10-02T12:00:00.000Z')

function refreshError(description: string): string {
  return `Token refresh failed: Anthropic refresh needs login (400): {"error": "invalid_grant", "error_description": "${description}"}`
}

describe('staleAccountNotice', () => {
  it('tells an ended session, a replaced sign-in and an account hold apart', () => {
    expect(staleAccountNotice(refreshError('Refresh token expired')).label).toBe('Session expired')
    expect(staleAccountNotice(refreshError('Refresh token not found or invalid')).label).toBe(
      'Signed out'
    )
    expect(staleAccountNotice(refreshError('account_on_hold')).label).toBe('On hold')
  })

  it('falls back to the generic notice for anything else', () => {
    expect(staleAccountNotice(null)).toEqual({ label: 'Expired', detail: 'expired - sign in again' })
    expect(staleAccountNotice('Invalid Claude credentials').label).toBe('Expired')
  })
})

describe('sessionEndingSoonLabel', () => {
  it('counts down sessions ending within a week', () => {
    expect(sessionEndingSoonLabel(NOW + 4 * DAY_MS + 5 * HOUR_MS, NOW)).toBe('Session ends in 4d')
    expect(sessionEndingSoonLabel(NOW + 5 * HOUR_MS, NOW)).toBe('Session ends in 5h')
    expect(sessionEndingSoonLabel(NOW + 10 * 60 * 1000, NOW)).toBe('Session ends in 1h')
  })

  it('stays quiet when the end is unknown, far off, or already past', () => {
    expect(sessionEndingSoonLabel(null, NOW)).toBeNull()
    expect(sessionEndingSoonLabel(undefined, NOW)).toBeNull()
    expect(sessionEndingSoonLabel(NOW + 8 * DAY_MS, NOW)).toBeNull()
    expect(sessionEndingSoonLabel(NOW - HOUR_MS, NOW)).toBeNull()
  })
})
