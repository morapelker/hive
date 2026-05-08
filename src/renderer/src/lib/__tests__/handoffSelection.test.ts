import { describe, expect, it } from 'vitest'
import { buildHandoffPrompt, type HandoffSelectionOverride } from '../handoffSelection'

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
})
