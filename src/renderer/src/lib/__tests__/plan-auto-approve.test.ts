import { describe, expect, it } from 'vitest'
import { canToggleAutoApprovePlan } from '../plan-auto-approve'

function ticket(
  overrides: Partial<Parameters<typeof canToggleAutoApprovePlan>[0]> = {}
): Parameters<typeof canToggleAutoApprovePlan>[0] {
  return {
    mode: 'plan',
    goal_mode: false,
    plan_ready: false,
    current_session_id: null,
    ...overrides
  }
}

describe('canToggleAutoApprovePlan', () => {
  it('allows a plan-mode ticket with no session yet (pre-arming)', () => {
    expect(canToggleAutoApprovePlan(ticket(), null)).toBe(true)
  })

  it('allows a plan-mode ticket with a live claude-cli session', () => {
    expect(
      canToggleAutoApprovePlan(ticket({ current_session_id: 's1' }), 'claude-code-cli')
    ).toBe(true)
  })

  it('allows super-plan mode', () => {
    expect(canToggleAutoApprovePlan(ticket({ mode: 'super-plan' }), null)).toBe(true)
  })

  it('rejects build mode and null mode', () => {
    expect(canToggleAutoApprovePlan(ticket({ mode: 'build' }), null)).toBe(false)
    expect(canToggleAutoApprovePlan(ticket({ mode: null }), null)).toBe(false)
  })

  it('rejects goal-mode tickets (they have their own handoff flow)', () => {
    expect(canToggleAutoApprovePlan(ticket({ goal_mode: true }), null)).toBe(false)
  })

  it('rejects when a plan is already awaiting approval', () => {
    expect(canToggleAutoApprovePlan(ticket({ plan_ready: true }), null)).toBe(false)
  })

  it('rejects a session linked to a non-claude-cli SDK', () => {
    expect(canToggleAutoApprovePlan(ticket({ current_session_id: 's1' }), 'opencode')).toBe(false)
    expect(canToggleAutoApprovePlan(ticket({ current_session_id: 's1' }), 'claude-code')).toBe(
      false
    )
    expect(canToggleAutoApprovePlan(ticket({ current_session_id: 's1' }), null)).toBe(false)
  })
})
