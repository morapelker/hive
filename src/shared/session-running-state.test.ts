// What "running" means for a session: every status the app knows, and which of them make a
// session count as running.
import { describe, expect, it } from 'vitest'
import { runningStateOfStatus } from './session-running-state'
import { STATUS_PRIORITY, type SessionStatusType } from './types/session-status'

describe('runningStateOfStatus', () => {
  it.each<[SessionStatusType, 'working' | 'waiting' | null]>([
    ['working', 'working'],
    ['planning', 'working'],
    ['answering', 'waiting'],
    ['permission', 'waiting'],
    ['command_approval', 'waiting'],
    ['plan_ready', 'waiting'],
    ['completed', null],
    ['unread', null]
  ])('%s → %s', (status, expected) => {
    expect(runningStateOfStatus(status)).toBe(expected)
  })

  it('has an answer for every status the app knows', () => {
    for (const status of Object.keys(STATUS_PRIORITY) as SessionStatusType[]) {
      expect(['working', 'waiting', null]).toContain(runningStateOfStatus(status))
    }
  })

  it('reads no status, and a status it does not know, as not running', () => {
    expect(runningStateOfStatus(null)).toBeNull()
    expect(runningStateOfStatus(undefined)).toBeNull()
    expect(runningStateOfStatus('idle' as SessionStatusType)).toBeNull()
  })
})
