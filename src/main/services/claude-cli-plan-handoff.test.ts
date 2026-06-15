import { describe, expect, it, vi } from 'vitest'
import { HANDOFF_PLAN_PROMPT_HEADER, SUPER_PLAN_MODE_PREFIX } from '@shared/agent-mode-prefixes'

vi.mock('./logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { externalizeGoalHandoffPlan } from './claude-cli-plan-handoff'

const WORKTREE = '/repo/worktree'
const RAW_PLAN = '# My Plan\n\nDo the thing.\n\n## Success criteria\nIt works.'
const SHORT_REFERENCE =
  "/goal implement PLAN_fixed-uuid.md. the goal's success criteria is written there"

describe('externalizeGoalHandoffPlan', () => {
  it('writes the raw plan to PLAN_{uuid}.md and returns the short goal reference', () => {
    const writeFile = vi.fn()
    const prompt = `/goal ${HANDOFF_PLAN_PROMPT_HEADER}${RAW_PLAN}`

    const result = externalizeGoalHandoffPlan(prompt, WORKTREE, {
      uuid: 'fixed-uuid',
      writeFile
    })

    expect(writeFile).toHaveBeenCalledTimes(1)
    expect(writeFile).toHaveBeenCalledWith('/repo/worktree/PLAN_fixed-uuid.md', RAW_PLAN)
    expect(result).toBe(SHORT_REFERENCE)
  })

  it('preserves a leading super-plan prefix while still externalizing', () => {
    const writeFile = vi.fn()
    const prompt = `${SUPER_PLAN_MODE_PREFIX}/goal ${HANDOFF_PLAN_PROMPT_HEADER}${RAW_PLAN}`

    const result = externalizeGoalHandoffPlan(prompt, WORKTREE, {
      uuid: 'fixed-uuid',
      writeFile
    })

    expect(writeFile).toHaveBeenCalledWith('/repo/worktree/PLAN_fixed-uuid.md', RAW_PLAN)
    expect(result).toBe(`${SUPER_PLAN_MODE_PREFIX}${SHORT_REFERENCE}`)
  })

  it('leaves non-goal prompts untouched and writes nothing', () => {
    const writeFile = vi.fn()
    const prompt = 'just a normal follow-up message'

    const result = externalizeGoalHandoffPlan(prompt, WORKTREE, { writeFile })

    expect(writeFile).not.toHaveBeenCalled()
    expect(result).toBe(prompt)
  })

  it('leaves a goal prompt without the handoff header untouched (scope: handoffs only)', () => {
    const writeFile = vi.fn()
    const prompt = '/goal do the thing. Goal success criteria: it works'

    const result = externalizeGoalHandoffPlan(prompt, WORKTREE, { writeFile })

    expect(writeFile).not.toHaveBeenCalled()
    expect(result).toBe(prompt)
  })

  it('falls back to the original prompt when the file write fails', () => {
    const writeFile = vi.fn(() => {
      throw new Error('disk full')
    })
    const prompt = `/goal ${HANDOFF_PLAN_PROMPT_HEADER}${RAW_PLAN}`

    const result = externalizeGoalHandoffPlan(prompt, WORKTREE, {
      uuid: 'fixed-uuid',
      writeFile
    })

    expect(result).toBe(prompt)
  })
})
