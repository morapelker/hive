import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  dbApi: {
    setting: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(true),
      getAll: vi.fn().mockResolvedValue([])
    }
  },
  opencodeApi: {
    setModel: vi.fn().mockResolvedValue({ success: true, value: undefined })
  }
}))

vi.mock('@/api/db-api', () => ({ dbApi: apiMocks.dbApi }))
vi.mock('@/api/opencode-api', () => ({ opencodeApi: apiMocks.opencodeApi }))

import {
  resolvePreferredAgentSdk,
  useSettingsStore,
  type SelectedModel
} from '@/stores/useSettingsStore'

const claudeModel: SelectedModel = {
  providerID: 'anthropic',
  modelID: 'sonnet',
  variant: 'high'
}

const initialSettingsState = useSettingsStore.getState()

describe('lastUsedAgentSdk', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({
      defaultAgentSdk: 'codex',
      lastUsedAgentSdk: null,
      selectedModel: null,
      selectedModelByProvider: {}
    })
  })

  afterEach(() => {
    useSettingsStore.setState(initialSettingsState, true)
  })

  describe('resolvePreferredAgentSdk', () => {
    it('falls back to the configured default SDK when nothing has been used yet', () => {
      expect(resolvePreferredAgentSdk({ lastUsedAgentSdk: null, defaultAgentSdk: 'codex' })).toBe(
        'codex'
      )
    })

    it('degrades a terminal default to opencode', () => {
      expect(
        resolvePreferredAgentSdk({ lastUsedAgentSdk: null, defaultAgentSdk: 'terminal' })
      ).toBe('opencode')
    })

    it('prefers the last-used SDK over the configured default', () => {
      expect(
        resolvePreferredAgentSdk({ lastUsedAgentSdk: 'claude-code-cli', defaultAgentSdk: 'codex' })
      ).toBe('claude-code-cli')
    })

    it('reads from the store when no snapshot is given', () => {
      useSettingsStore.setState({ lastUsedAgentSdk: 'claude-code' })
      expect(resolvePreferredAgentSdk()).toBe('claude-code')
    })
  })

  describe('setSelectedModelForSdk', () => {
    it('records the SDK a model was picked for as the last-used SDK', async () => {
      await useSettingsStore.getState().setSelectedModelForSdk('claude-code-cli', claudeModel)

      const state = useSettingsStore.getState()
      expect(state.lastUsedAgentSdk).toBe('claude-code-cli')
      expect(state.selectedModelByProvider['claude-code-cli']).toEqual(claudeModel)
      // Persisted alongside the per-SDK model so it survives a restart
      const persisted = JSON.parse(apiMocks.dbApi.setting.set.mock.calls.at(-1)?.[1] as string)
      expect(persisted.lastUsedAgentSdk).toBe('claude-code-cli')
    })

    it('leaves the last-used SDK alone when clearing a per-SDK model', async () => {
      useSettingsStore.setState({
        lastUsedAgentSdk: 'claude-code-cli',
        selectedModelByProvider: { codex: { providerID: 'codex', modelID: 'gpt-5.5' } }
      })

      await useSettingsStore.getState().setSelectedModelForSdk('codex', null)

      expect(useSettingsStore.getState().lastUsedAgentSdk).toBe('claude-code-cli')
    })

    it('routes setSelectedModel with an SDK through the same bookkeeping', async () => {
      await useSettingsStore.getState().setSelectedModel(claudeModel, 'claude-code')

      expect(useSettingsStore.getState().lastUsedAgentSdk).toBe('claude-code')
    })
  })

  describe('updateSetting', () => {
    it('clears the last-used SDK when the default SDK is chosen explicitly', async () => {
      useSettingsStore.setState({ lastUsedAgentSdk: 'claude-code-cli' })

      await useSettingsStore.getState().updateSetting('defaultAgentSdk', 'opencode')

      const state = useSettingsStore.getState()
      expect(state.defaultAgentSdk).toBe('opencode')
      expect(state.lastUsedAgentSdk).toBeNull()
      expect(resolvePreferredAgentSdk(state)).toBe('opencode')
      const persisted = JSON.parse(apiMocks.dbApi.setting.set.mock.calls.at(-1)?.[1] as string)
      expect(persisted.lastUsedAgentSdk).toBeNull()
    })

    it('keeps the last-used SDK when an unrelated setting changes', async () => {
      useSettingsStore.setState({ lastUsedAgentSdk: 'claude-code-cli' })

      await useSettingsStore.getState().updateSetting('stripAtMentions', false)

      expect(useSettingsStore.getState().lastUsedAgentSdk).toBe('claude-code-cli')
    })
  })
})
