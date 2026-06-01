import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  dbApi: {
    setting: {
      get: vi.fn(),
      set: vi.fn()
    },
    session: {
      create: vi.fn()
    }
  },
  settingsApi: {
    onSettingsUpdated: vi.fn()
  },
  petApi: {
    hide: vi.fn(),
    show: vi.fn(),
    updateSettings: vi.fn()
  },
  systemApi: {
    detectAgentSdks: vi.fn()
  }
}))

vi.mock('@/stores/store-coordination', () => ({
  notifyKanbanSessionSync: vi.fn(),
  notifyKanbanNewSession: vi.fn(),
  registerConnectionClear: vi.fn(),
  registerWorktreeClear: vi.fn(),
  clearConnectionSelection: vi.fn(),
  clearWorktreeSelection: vi.fn(),
  registerKanbanSessionSync: vi.fn(),
  registerKanbanNewSession: vi.fn()
}))

vi.mock('@/api/db-api', () => ({
  dbApi: apiMocks.dbApi
}))

vi.mock('@/api/settings-api', () => ({
  settingsApi: apiMocks.settingsApi
}))

vi.mock('@/api/pet-api', () => ({
  petApi: apiMocks.petApi
}))

vi.mock('@/api/system-api', () => ({
  systemApi: apiMocks.systemApi
}))

describe('useSessionStore unavailable provider guard', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()

    apiMocks.dbApi.setting.get.mockResolvedValue(null)
    apiMocks.dbApi.setting.set.mockResolvedValue(true)
    apiMocks.settingsApi.onSettingsUpdated.mockReturnValue(vi.fn())
    apiMocks.petApi.hide.mockResolvedValue(undefined)
    apiMocks.petApi.show.mockResolvedValue(undefined)
    apiMocks.petApi.updateSettings.mockResolvedValue({ success: true })
    apiMocks.systemApi.detectAgentSdks.mockResolvedValue({
      opencode: false,
      claude: true,
      codex: true
    })
  })

  it('blocks new sessions when the configured provider is unavailable', async () => {
    const { useSettingsStore } = await import('@/stores/useSettingsStore')
    const { useSessionStore } = await import('@/stores/useSessionStore')

    useSettingsStore.setState({
      defaultAgentSdk: 'opencode',
      availableAgentSdks: {
        opencode: false,
        claude: true,
        codex: true
      }
    })

    const result = await useSessionStore.getState().createSession('wt-1', 'proj-1')

    expect(result.success).toBe(false)
    expect(result.error).toContain('OpenCode is not available on this system')
    expect(apiMocks.dbApi.session.create).not.toHaveBeenCalled()
  })
})
