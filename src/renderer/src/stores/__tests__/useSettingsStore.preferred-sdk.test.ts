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

describe('preferred agent SDK', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({
      defaultAgentSdk: 'codex',
      selectedModel: null,
      selectedModelByProvider: {}
    })
  })

  afterEach(() => {
    useSettingsStore.setState(initialSettingsState, true)
  })

  describe('resolvePreferredAgentSdk', () => {
    it('is the SDK configured on the settings page', () => {
      expect(resolvePreferredAgentSdk({ defaultAgentSdk: 'codex' })).toBe('codex')
    })

    it('degrades a terminal default to opencode', () => {
      expect(resolvePreferredAgentSdk({ defaultAgentSdk: 'terminal' })).toBe('opencode')
    })

    it('reads from the store when no snapshot is given', () => {
      useSettingsStore.setState({ defaultAgentSdk: 'claude-code' })
      expect(resolvePreferredAgentSdk()).toBe('claude-code')
    })
  })

  describe('setSelectedModelForSdk', () => {
    it('sets the per-SDK default without touching the default SDK', async () => {
      await useSettingsStore.getState().setSelectedModelForSdk('claude-code-cli', claudeModel)

      const state = useSettingsStore.getState()
      expect(state.defaultAgentSdk).toBe('codex')
      expect(state.selectedModelByProvider['claude-code-cli']).toEqual(claudeModel)
      expect(resolvePreferredAgentSdk(state)).toBe('codex')
      const persisted = JSON.parse(apiMocks.dbApi.setting.set.mock.calls.at(-1)?.[1] as string)
      expect(persisted.defaultAgentSdk).toBe('codex')
      expect(persisted).not.toHaveProperty('lastUsedAgentSdk')
    })
  })
})
