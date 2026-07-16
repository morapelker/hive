import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SelectedModel } from '@/stores/useSettingsStore'

// applyModeDefaultModel reads the settings store (both directly and inside
// dropForeignModelForSdk's per-SDK trust check); route every reader to this
// mutable snapshot while keeping the real resolveModelForSdk.
const settingsState: {
  defaultAgentSdk: string
  selectedModel: SelectedModel | null
  selectedModelByProvider: Record<string, SelectedModel>
  getModelForMode: (mode: string) => SelectedModel | null
} = {
  defaultAgentSdk: 'opencode',
  selectedModel: null,
  selectedModelByProvider: {},
  getModelForMode: () => null
}

vi.mock('@/stores/useSettingsStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/useSettingsStore')>()
  return {
    ...actual,
    useSettingsStore: {
      ...actual.useSettingsStore,
      getState: () => settingsState
    }
  }
})

import { useSessionStore } from '@/stores/useSessionStore'

const setSessionModel = vi.fn().mockResolvedValue(undefined)

function seedSession(agentSdk: string): void {
  useSessionStore.setState({
    sessionsByWorktree: new Map([['wt1', [{ id: 's1', agent_sdk: agentSdk }]]]),
    sessionsByConnection: new Map(),
    boardAssistantByProject: new Map(),
    orphanedSessions: new Map(),
    setSessionModel
  } as never)
}

beforeEach(() => {
  setSessionModel.mockClear()
  settingsState.defaultAgentSdk = 'opencode'
  settingsState.selectedModel = null
  settingsState.selectedModelByProvider = {}
  settingsState.getModelForMode = () => null
})

describe('applyModeDefaultModel grok/model coherence', () => {
  it('does not stamp a legacy global claude model onto a grok session', async () => {
    // Upgraded profile: empty per-SDK map, only the unstamped legacy global.
    // buildGrokCliPtySpawn would drop this model and grok would run its own
    // default, so stamping it on the row would leave badges/telemetry lying.
    seedSession('grok-cli')
    settingsState.selectedModel = { providerID: 'anthropic', modelID: 'sonnet' }

    await useSessionStore.getState().applyModeDefaultModel('s1', 'plan')
    expect(setSessionModel).not.toHaveBeenCalled()
  })

  it('applies the per-SDK grok model to a grok session', async () => {
    seedSession('grok-cli')
    const grok: SelectedModel = { providerID: 'xai', modelID: 'grok-4.5', variant: 'high' }
    settingsState.selectedModelByProvider = { 'grok-cli': grok }

    await useSessionStore.getState().applyModeDefaultModel('s1', 'plan')
    expect(setSessionModel).toHaveBeenCalledWith('s1', grok, { skipGlobalUpdate: true })
  })

  it('does not stamp a legacy global grok model onto a claude-cli session', async () => {
    seedSession('claude-code-cli')
    settingsState.selectedModel = { providerID: 'xai', modelID: 'grok-4.5' }

    await useSessionStore.getState().applyModeDefaultModel('s1', 'build')
    expect(setSessionModel).not.toHaveBeenCalled()
  })

  it('trusts an unstamped xAI model selected FOR opencode in the per-SDK map', async () => {
    seedSession('opencode')
    const xai: SelectedModel = { providerID: 'xai', modelID: 'grok-4.5' }
    settingsState.selectedModelByProvider = { opencode: xai }

    await useSessionStore.getState().applyModeDefaultModel('s1', 'plan')
    expect(setSessionModel).toHaveBeenCalledWith('s1', xai, { skipGlobalUpdate: true })
  })

  it('still applies a matching legacy global model to a non-grok session', async () => {
    seedSession('claude-code-cli')
    const sonnet: SelectedModel = { providerID: 'anthropic', modelID: 'sonnet', variant: 'high' }
    settingsState.selectedModel = sonnet

    await useSessionStore.getState().applyModeDefaultModel('s1', 'build')
    expect(setSessionModel).toHaveBeenCalledWith('s1', sonnet, { skipGlobalUpdate: true })
  })
})
