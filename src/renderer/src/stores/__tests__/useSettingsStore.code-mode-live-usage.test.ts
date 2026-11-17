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

import { APP_SETTINGS_DB_KEY } from '@shared/types/settings'
import { useSettingsStore } from '@/stores/useSettingsStore'

const PERSIST_KEY = 'hive-settings'

const initialSettingsState = useSettingsStore.getState()

const lastSavedBlob = (): Record<string, unknown> => {
  const calls = apiMocks.dbApi.setting.set.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  expect(calls[calls.length - 1][0]).toBe(APP_SETTINGS_DB_KEY)
  return JSON.parse(calls[calls.length - 1][1] as string)
}

/**
 * Settings › Advanced › "Live usage in Code Mode sessions" (CODE_MODE_TASKS.html T09) at each of
 * the store's sites: on by default, saved to the `app_settings` blob the main process reads
 * (isClaudeDebugUsageEnabled) and kept there across a save of anything else (extractSettings),
 * restored from localStorage (partialize), read back from the database after a restart, and on
 * for a blob saved before it existed.
 */
describe('useSettingsStore claudeCodeModeLiveUsage', () => {
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
    expect(useSettingsStore.getState().claudeCodeModeLiveUsage).toBe(true)
  })

  it('is saved to the settings blob, and stays there when another setting saves', async () => {
    await useSettingsStore.getState().updateSetting('claudeCodeModeLiveUsage', false)
    expect(lastSavedBlob().claudeCodeModeLiveUsage).toBe(false)

    await useSettingsStore.getState().updateSetting('showMergedColumn', true)
    expect(lastSavedBlob().claudeCodeModeLiveUsage).toBe(false)

    await useSettingsStore.getState().updateSetting('claudeCodeModeLiveUsage', true)
    expect(lastSavedBlob().claudeCodeModeLiveUsage).toBe(true)
  })

  it('writes to localStorage and comes back on rehydrate', async () => {
    await useSettingsStore.getState().updateSetting('claudeCodeModeLiveUsage', false)
    const persisted = localStorage.getItem(PERSIST_KEY) ?? '{}'
    expect(JSON.parse(persisted).state.claudeCodeModeLiveUsage).toBe(false)

    useSettingsStore.setState({ claudeCodeModeLiveUsage: true })
    localStorage.setItem(PERSIST_KEY, persisted)
    await useSettingsStore.persist.rehydrate()

    expect(useSettingsStore.getState().claudeCodeModeLiveUsage).toBe(false)
  })

  it('comes back off from the database after a restart', async () => {
    apiMocks.dbApi.setting.get.mockResolvedValue(
      JSON.stringify({ boardMode: 'toggle', claudeCodeModeLiveUsage: false })
    )

    await useSettingsStore.getState().loadFromDatabase()

    expect(useSettingsStore.getState().claudeCodeModeLiveUsage).toBe(false)
  })

  it('a blob from before the setting leaves it on', async () => {
    useSettingsStore.setState({ claudeCodeModeLiveUsage: false })
    apiMocks.dbApi.setting.get.mockResolvedValue(JSON.stringify({ boardMode: 'toggle' }))

    await useSettingsStore.getState().loadFromDatabase()

    expect(useSettingsStore.getState().claudeCodeModeLiveUsage).toBe(true)
  })
})
