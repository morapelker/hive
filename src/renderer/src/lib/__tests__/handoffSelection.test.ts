import { afterEach, describe, expect, it } from 'vitest'
import {
  buildHandoffPrompt,
  cacheHandoffModelCatalog,
  clearHandoffModelCatalogCache,
  getAvailableHandoffAgentSdks,
  getHandoffSdkDisplayName,
  resolveSessionCreationSelection,
  type HandoffSelectionOverride
} from '../handoffSelection'
import { SUPER_PLAN_MODE_PREFIX } from '../constants'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

const model = { providerID: 'codex', modelID: 'gpt-5.5' }
const initialSettingsState = useSettingsStore.getState()
const initialWorktreeState = useWorktreeStore.getState()

afterEach(() => {
  useSettingsStore.setState(initialSettingsState, true)
  useWorktreeStore.setState(initialWorktreeState, true)
  clearHandoffModelCatalogCache()
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

  it('uses a bare mode default for an explicit SDK when it is the configured default SDK', () => {
    cacheHandoffModelCatalog('codex', {
      providers: [
        {
          id: 'codex',
          name: 'Codex',
          models: {
            'mode-default': {
              id: 'mode-default',
              name: 'Mode Default'
            }
          }
        }
      ]
    })
    useSettingsStore.setState({
      defaultAgentSdk: 'codex',
      selectedModel: null,
      selectedModelByProvider: {
        codex: {
          providerID: 'codex',
          modelID: 'fallback'
        }
      },
      defaultModels: {
        build: {
          providerID: 'codex',
          modelID: 'mode-default'
        },
        plan: null,
        ask: null,
        review: null
      }
    })

    const selection = resolveSessionCreationSelection({
      agentSdkOverride: 'codex',
      initialMode: 'build'
    })

    expect(selection.agentSdk).toBe('codex')
    expect(selection.model).toMatchObject({
      providerID: 'codex',
      modelID: 'mode-default'
    })
  })

  it('skips bare mode defaults when explicit SDK validity is unknown', () => {
    useSettingsStore.setState({
      defaultAgentSdk: 'opencode',
      selectedModel: null,
      selectedModelByProvider: {
        codex: {
          providerID: 'codex',
          modelID: 'fallback'
        }
      },
      defaultModels: {
        build: {
          providerID: 'anthropic',
          modelID: 'claude-opus'
        },
        plan: null,
        ask: null,
        review: null
      }
    })

    const selection = resolveSessionCreationSelection({
      agentSdkOverride: 'codex',
      initialMode: 'build'
    })

    expect(selection.agentSdk).toBe('codex')
    expect(selection.model).toMatchObject({
      providerID: 'codex',
      modelID: 'fallback'
    })
  })

  it('does not use worktree fallback for explicit SDK session creation', () => {
    useWorktreeStore.setState({
      worktreesByProject: new Map([
        [
          'project-1',
          [
            {
              id: 'worktree-with-anthropic-last-model',
              project_id: 'project-1',
              name: 'Main',
              branch_name: 'main',
              path: '/repo',
              is_default: true,
              status: 'active',
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-01T00:00:00.000Z',
              base_branch: null,
              branch_renamed: 0,
              last_message_at: null,
              last_model_provider_id: 'anthropic',
              last_model_id: 'opus',
              last_model_variant: null,
              pinned: 0,
              github_pr_number: null,
              github_pr_url: null
            }
          ]
        ]
      ])
    })
    useSettingsStore.setState({
      defaultAgentSdk: 'opencode',
      selectedModel: null,
      selectedModelByProvider: {},
      defaultModels: null
    })

    const selection = resolveSessionCreationSelection({
      worktreeId: 'worktree-with-anthropic-last-model',
      agentSdkOverride: 'codex',
      initialMode: 'build'
    })

    expect(selection.agentSdk).toBe('codex')
    expect(selection.model).toMatchObject({
      providerID: 'codex',
      modelID: 'gpt-5.5'
    })
  })

  it('does not use legacy selectedModel from another SDK for explicit SDK session creation', () => {
    cacheHandoffModelCatalog('codex', {
      providers: [
        {
          id: 'codex',
          name: 'Codex',
          models: {
            'catalog-codex-model': {
              id: 'catalog-codex-model',
              name: 'Catalog Codex Model'
            }
          }
        }
      ]
    })
    useSettingsStore.setState({
      defaultAgentSdk: 'opencode',
      selectedModel: {
        providerID: 'anthropic',
        modelID: 'claude-opus'
      },
      selectedModelByProvider: {},
      defaultModels: null
    })

    const selection = resolveSessionCreationSelection({
      agentSdkOverride: 'codex',
      initialMode: 'build'
    })

    expect(selection.agentSdk).toBe('codex')
    expect(selection.model).toMatchObject({
      providerID: 'codex',
      modelID: 'catalog-codex-model'
    })
  })

  it('uses a valid bare mode default for an explicit non-default SDK', () => {
    cacheHandoffModelCatalog('codex', {
      providers: [
        {
          id: 'codex',
          name: 'Codex',
          models: {
            'mode-default': {
              id: 'mode-default',
              name: 'Mode Default'
            }
          }
        }
      ]
    })
    useSettingsStore.setState({
      defaultAgentSdk: 'opencode',
      selectedModel: null,
      selectedModelByProvider: {
        codex: {
          providerID: 'codex',
          modelID: 'fallback'
        }
      },
      defaultModels: {
        build: {
          providerID: 'codex',
          modelID: 'mode-default'
        },
        plan: null,
        ask: null,
        review: null
      }
    })

    const selection = resolveSessionCreationSelection({
      agentSdkOverride: 'codex',
      initialMode: 'build'
    })

    expect(selection.agentSdk).toBe('codex')
    expect(selection.model).toMatchObject({
      providerID: 'codex',
      modelID: 'mode-default'
    })
  })
})

describe('handoff provider visuals', () => {
  it('orders Claude Code second and Claude CLI last', () => {
    expect(getAvailableHandoffAgentSdks({ opencode: true, claude: true, codex: true })).toEqual([
      'opencode',
      'claude-code',
      'codex',
      'claude-code-cli'
    ])
  })

  it('displays Claude Code without legacy wording', () => {
    expect(getHandoffSdkDisplayName('claude-code')).toBe('Claude Code')
    expect(getHandoffSdkDisplayName('claude-code-cli')).toBe('Claude Code (CLI)')
  })
})
