import { afterEach, describe, expect, it } from 'vitest'
import {
  buildHandoffPrompt,
  resolveSessionCreationSelection,
  type HandoffSelectionOverride
} from '../handoffSelection'
import { SUPER_PLAN_MODE_PREFIX } from '../constants'
import { useSettingsStore } from '@/stores/useSettingsStore'

const model = { providerID: 'codex', modelID: 'gpt-5.5' }
const initialSettingsState = useSettingsStore.getState()

afterEach(() => {
  useSettingsStore.setState(initialSettingsState, true)
})

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

describe('resolveSessionCreationSelection', () => {
  it('preserves an explicit Claude CLI SDK even when a mode default uses Claude SDK', () => {
    useSettingsStore.setState({
      defaultAgentSdk: 'opencode',
      selectedModel: null,
      selectedModelByProvider: {
        'claude-code-cli': {
          providerID: 'anthropic',
          modelID: 'sonnet',
          variant: 'high'
        }
      },
      defaultModels: {
        build: {
          agentSdk: 'claude-code',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-5-20251101',
          variant: 'max'
        },
        plan: null,
        ask: null,
        review: null
      }
    })

    const selection = resolveSessionCreationSelection({
      agentSdkOverride: 'claude-code-cli',
      initialMode: 'build'
    })

    expect(selection.agentSdk).toBe('claude-code-cli')
    expect(selection.model).toMatchObject({
      providerID: 'anthropic',
      modelID: 'sonnet',
      variant: 'high'
    })
  })
})
