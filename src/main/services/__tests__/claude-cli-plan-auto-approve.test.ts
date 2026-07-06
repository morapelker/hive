// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearAllClaudeCliPlanAutoApprove,
  consumeClaudeCliPlanAutoApprove,
  isClaudeCliPlanAutoApproveArmed,
  setClaudeCliPlanAutoApprove
} from '../claude-cli-plan-auto-approve'

describe('claude-cli-plan-auto-approve registry', () => {
  beforeEach(() => {
    clearAllClaudeCliPlanAutoApprove()
  })

  it('arms and disarms a session', () => {
    expect(isClaudeCliPlanAutoApproveArmed('s1')).toBe(false)

    setClaudeCliPlanAutoApprove('s1', true)
    expect(isClaudeCliPlanAutoApproveArmed('s1')).toBe(true)
    expect(isClaudeCliPlanAutoApproveArmed('s2')).toBe(false)

    setClaudeCliPlanAutoApprove('s1', false)
    expect(isClaudeCliPlanAutoApproveArmed('s1')).toBe(false)
  })

  it('consume is one-shot: returns true once and unregisters', () => {
    setClaudeCliPlanAutoApprove('s1', true)

    expect(consumeClaudeCliPlanAutoApprove('s1')).toBe(true)
    expect(isClaudeCliPlanAutoApproveArmed('s1')).toBe(false)
    expect(consumeClaudeCliPlanAutoApprove('s1')).toBe(false)
  })

  it('consume on an unarmed session returns false', () => {
    expect(consumeClaudeCliPlanAutoApprove('never-armed')).toBe(false)
  })

  it('clearAll disarms every session', () => {
    setClaudeCliPlanAutoApprove('s1', true)
    setClaudeCliPlanAutoApprove('s2', true)

    clearAllClaudeCliPlanAutoApprove()

    expect(isClaudeCliPlanAutoApproveArmed('s1')).toBe(false)
    expect(isClaudeCliPlanAutoApproveArmed('s2')).toBe(false)
  })
})
