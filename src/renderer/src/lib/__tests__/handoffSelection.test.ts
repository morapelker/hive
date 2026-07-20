import { afterEach, describe, expect, it } from 'vitest'
import {
  buildHandoffPrompt,
  getAvailableHandoffAgentSdks,
  getHandoffSdkDisplayName,
  resolveSessionCreationSelection,
  type HandoffSelectionOverride
} from '../handoffSelection'
import { useSettingsStore } from '@/stores/useSettingsStore'

const model = { providerID: 'codex', modelID: 'gpt-5.5' }
const initialSettingsState = useSettingsStore.getState()

afterEach(() => {
  useSettingsStore.setState(initialSettingsState, true)
})

describe('buildHandoffPrompt', () => {
  it('prefixes goal mode only for codex and Claude CLI handoffs', () => {
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
    const claudeCliGoal: HandoffSelectionOverride = {
      agentSdk: 'claude-code-cli',
      model,
      goalMode: true
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
    expect(buildHandoffPrompt(planContent, claudeCliGoal)).toBe(
      '/goal Implement the following plan\n1. Build the thing'
    )
    expect(buildHandoffPrompt(planContent, claudeGoal)).toBe(
      'Implement the following plan\n1. Build the thing'
    )
    expect(buildHandoffPrompt(planContent)).toBe('Implement the following plan\n1. Build the thing')
  })

  it('never prepends the super-plan prefix on handoff, even from a super-plan source', () => {
    const planContent = '1. Build the thing'
    // A handoff means "implement this plan", so the prompt must stay clean regardless
    // of the source session's mode. Force a stale superPlan flag through to prove it is
    // ignored (the field no longer exists on HandoffSelectionOverride).
    const cliSuper = {
      agentSdk: 'claude-code-cli',
      model,
      superPlan: true
    } as unknown as HandoffSelectionOverride
    const cliSuperGoal = {
      agentSdk: 'claude-code-cli',
      model,
      goalMode: true,
      superPlan: true
    } as unknown as HandoffSelectionOverride

    expect(buildHandoffPrompt(planContent, cliSuper)).toBe(
      'Implement the following plan\n1. Build the thing'
    )
    expect(buildHandoffPrompt(planContent, cliSuperGoal)).toBe(
      '/goal Implement the following plan\n1. Build the thing'
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

  it('rejects a foreign legacy-global default for grok sessions and falls back to the grok model', () => {
    useSettingsStore.setState({
      defaultAgentSdk: 'grok-cli',
      // Legacy config: only a global selectedModel from another SDK, no
      // per-provider entries. buildGrokCliPtySpawn would drop this model id,
      // so stamping it on the session would desync badges from the CLI.
      selectedModel: {
        providerID: 'anthropic',
        modelID: 'claude-opus-4-5-20251101',
        variant: 'max'
      },
      selectedModelByProvider: {},
      defaultModels: { build: null, plan: null, ask: null, review: null }
    })

    const selection = resolveSessionCreationSelection({})

    expect(selection.agentSdk).toBe('grok-cli')
    expect(selection.model).toMatchObject({
      providerID: 'xai',
      modelID: 'grok-4.5'
    })

    // The explicit-SDK create path (session-tab context menu) resolves through
    // a different branch — it must apply the same grok-family filter.
    const explicit = resolveSessionCreationSelection({ agentSdkOverride: 'grok-cli' })
    expect(explicit.agentSdk).toBe('grok-cli')
    expect(explicit.model).toMatchObject({
      providerID: 'xai',
      modelID: 'grok-4.5'
    })
  })

  it('rejects a legacy grok global for explicit non-grok creates', () => {
    useSettingsStore.setState({
      defaultAgentSdk: 'grok-cli',
      // Only an unstamped legacy grok global configured: an explicit opencode
      // create must not stamp it (opencode may fail to serve it; the badge
      // would desync from what actually runs).
      selectedModel: { providerID: 'xai', modelID: 'grok-4.5' },
      selectedModelByProvider: {},
      defaultModels: { build: null, plan: null, ask: null, review: null }
    })

    const selection = resolveSessionCreationSelection({ agentSdkOverride: 'opencode' })
    expect(selection.agentSdk).toBe('opencode')
    expect(selection.model?.providerID).not.toBe('xai')
  })
})

describe('handoff provider visuals', () => {
  it('orders Claude Code second and Claude CLI last', () => {
    expect(
      getAvailableHandoffAgentSdks({ opencode: true, claude: true, codex: true, grok: false })
    ).toEqual(['opencode', 'claude-code', 'codex', 'claude-code-cli'])
  })

  it('displays Claude Code without legacy wording', () => {
    expect(getHandoffSdkDisplayName('claude-code')).toBe('Claude Code')
    expect(getHandoffSdkDisplayName('claude-code-cli')).toBe('Claude Code (CLI)')
  })
})
