import { describe, expect, it } from 'vitest'

import { shouldPreserveBlockingSessionStatus } from '../session-status-guards'

describe('shouldPreserveBlockingSessionStatus', () => {
  it('preserves command_approval and permission unconditionally, matching the existing guards', () => {
    expect(shouldPreserveBlockingSessionStatus('command_approval', false)).toBe(true)
    expect(shouldPreserveBlockingSessionStatus('permission', false)).toBe(true)
  })

  it('preserves answering while a question is still pending', () => {
    expect(shouldPreserveBlockingSessionStatus('answering', true)).toBe(true)
  })

  it('does not preserve a stale answering status with no pending question', () => {
    expect(shouldPreserveBlockingSessionStatus('answering', false)).toBe(false)
  })

  it('does not preserve non-blocking statuses', () => {
    expect(shouldPreserveBlockingSessionStatus('working', true)).toBe(false)
    expect(shouldPreserveBlockingSessionStatus('planning', false)).toBe(false)
    expect(shouldPreserveBlockingSessionStatus('completed', false)).toBe(false)
    expect(shouldPreserveBlockingSessionStatus(null, true)).toBe(false)
    expect(shouldPreserveBlockingSessionStatus(undefined, true)).toBe(false)
  })
})
