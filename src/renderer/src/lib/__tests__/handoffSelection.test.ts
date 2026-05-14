import { describe, expect, it } from 'vitest'
import { buildHandoffPrompt, type HandoffSelectionOverride } from '../handoffSelection'
import { SUPER_PLAN_MODE_PREFIX } from '../constants'

const model = { providerID: 'codex', modelID: 'gpt-5.5' }

describe('buildHandoffPrompt', () => {
  it('prefixes goal mode only for codex handoffs', () => {
    const planContent = '1. Build the thing'
    const codexGoal: HandoffSelectionOverride = {
      agentSdk: 'codex',
      model,
      goalMode: true
    }
    const codexPlain: HandoffSelectionOverride = {
      agentSdk: 'codex',
      model,
      goalMode: false
    }
    const claudeGoal: HandoffSelectionOverride = {
      agentSdk: 'claude-code',
      model,
      goalMode: true
    }

    expect(buildHandoffPrompt(planContent, codexGoal)).toBe(
      '/goal Implement the following plan\n1. Build the thing'
    )
    expect(buildHandoffPrompt(planContent, codexPlain)).toBe(
      'Implement the following plan\n1. Build the thing'
    )
    expect(buildHandoffPrompt(planContent, claudeGoal)).toBe(
      'Implement the following plan\n1. Build the thing'
    )
    expect(buildHandoffPrompt(planContent)).toBe('Implement the following plan\n1. Build the thing')
  })

  it('prefixes super-plan instructions for Claude CLI handoffs only', () => {
    const planContent = '1. Build the thing'
    const cliSuper: HandoffSelectionOverride = {
      agentSdk: 'claude-code-cli',
      model,
      superPlan: true
    }
    const legacySuper: HandoffSelectionOverride = {
      agentSdk: 'claude-code',
      model,
      superPlan: true
    }

    expect(buildHandoffPrompt(planContent, cliSuper)).toBe(
      `${SUPER_PLAN_MODE_PREFIX}Implement the following plan\n1. Build the thing`
    )
    expect(buildHandoffPrompt(planContent, legacySuper)).toBe(
      'Implement the following plan\n1. Build the thing'
    )
  })
})
