import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  dbApi: {
    setting: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(true),
      getAll: vi.fn().mockResolvedValue([])
    }
  },
  settingsApi: {
    loadCustomCommandsFile: vi.fn().mockResolvedValue({ success: true, commands: [] }),
    reloadCustomCommands: vi.fn().mockResolvedValue({ success: true, count: 0 }),
    saveCustomCommandsFile: vi.fn().mockResolvedValue(undefined),
    onSettingsUpdated: vi.fn(() => () => {})
  },
  telegramApi: { getConfig: vi.fn().mockResolvedValue(null) },
  petApi: {
    updateSettings: vi.fn(),
    show: vi.fn().mockResolvedValue(undefined),
    hide: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('@/api/db-api', () => ({ dbApi: apiMocks.dbApi }))
vi.mock('@/api/settings-api', () => ({ settingsApi: apiMocks.settingsApi }))
vi.mock('@/api/telegram-api', () => ({ telegramApi: apiMocks.telegramApi }))
vi.mock('@/api/pet-api', () => ({ petApi: apiMocks.petApi }))

import { useSettingsStore } from '@/stores/useSettingsStore'

const PERSIST_KEY = 'hive-settings'

const initialSettingsState = useSettingsStore.getState()

const lastSavedBlob = (): Record<string, unknown> => {
  const calls = apiMocks.dbApi.setting.set.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return JSON.parse(calls[calls.length - 1][1] as string)
}

/**
 * The "Pull latest from origin" switch of the New Connection dialog and the "Go to project"
 * switcher, at each of the store's sites: on by default, kept across a settings save of
 * anything else (extractSettings), restored from localStorage (partialize), and on for a blob
 * saved before it existed.
 */
describe('useSettingsStore pullBeforeConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.dbApi.setting.get.mockResolvedValue(null)
    localStorage.clear()
  })

  afterEach(() => {
    useSettingsStore.setState(initialSettingsState, true)
    localStorage.clear()
  })

  it('is on by default', () => {
    expect(useSettingsStore.getState().pullBeforeConnection).toBe(true)
  })

  it('is saved to the settings blob, and stays there when another setting saves', async () => {
    await useSettingsStore.getState().updateSetting('pullBeforeConnection', false)
    expect(lastSavedBlob().pullBeforeConnection).toBe(false)

    await useSettingsStore.getState().updateSetting('showMergedColumn', true)
    expect(lastSavedBlob().pullBeforeConnection).toBe(false)
  })

  it('writes to localStorage and comes back on rehydrate', async () => {
    await useSettingsStore.getState().updateSetting('pullBeforeConnection', false)
    const persisted = localStorage.getItem(PERSIST_KEY) ?? '{}'
    expect(JSON.parse(persisted).state.pullBeforeConnection).toBe(false)

    useSettingsStore.setState({ pullBeforeConnection: true })
    localStorage.setItem(PERSIST_KEY, persisted)
    await useSettingsStore.persist.rehydrate()

    expect(useSettingsStore.getState().pullBeforeConnection).toBe(false)
  })

  it('a blob from before the setting leaves it on', async () => {
    useSettingsStore.setState({ pullBeforeConnection: false })
    apiMocks.dbApi.setting.get.mockResolvedValue(JSON.stringify({ boardMode: 'toggle' }))

    await useSettingsStore.getState().loadFromDatabase()

    expect(useSettingsStore.getState().pullBeforeConnection).toBe(true)
  })
})
