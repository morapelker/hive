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
import { DEFAULT_AUTO_SIGN_IN_SETTINGS, type AutoSignInSettings } from '@shared/types/settings'

const PERSIST_KEY = 'hive-settings'

const configured: AutoSignInSettings = {
  enabled: true,
  codeServerUrl: 'http://claudit-dashboard:3000',
  apiToken: 'secret-token',
  codeTimeoutSeconds: 120
}

const initialSettingsState = useSettingsStore.getState()

/**
 * Simulate a fresh renderer: in-memory state is back to the defaults while the
 * persisted localStorage entry survives. The persist middleware rewrites storage on
 * every setState, so the entry is restored before rehydrating from it.
 */
async function restartRenderer(persisted: string): Promise<void> {
  useSettingsStore.setState({ autoSignIn: DEFAULT_AUTO_SIGN_IN_SETTINGS })
  localStorage.setItem(PERSIST_KEY, persisted)
  await useSettingsStore.persist.rehydrate()
}

const lastSavedBlob = (): Record<string, unknown> => {
  const calls = apiMocks.dbApi.setting.set.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return JSON.parse(calls[calls.length - 1][1] as string)
}

/**
 * Regression: autoSignIn was missing from the persist `partialize`, so a restart
 * rehydrated it as the defaults and the first settings save before (or instead of)
 * loadFromDatabase wiped the configured server from the app_settings blob.
 */
describe('useSettingsStore autoSignIn persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  afterEach(() => {
    useSettingsStore.setState(initialSettingsState, true)
    localStorage.clear()
  })

  it('writes autoSignIn to localStorage and restores it on rehydrate', async () => {
    await useSettingsStore.getState().updateSetting('autoSignIn', configured)

    const persisted = localStorage.getItem(PERSIST_KEY) ?? '{}'
    expect(JSON.parse(persisted).state?.autoSignIn).toEqual(configured)

    await restartRenderer(persisted)

    expect(useSettingsStore.getState().autoSignIn).toEqual(configured)
  })

  it('keeps the configured server in the DB blob when a save lands before the DB load', async () => {
    await useSettingsStore.getState().updateSetting('autoSignIn', configured)
    await restartRenderer(localStorage.getItem(PERSIST_KEY) ?? '{}')
    vi.clearAllMocks()

    // Any unrelated write in the startup window serializes the whole store.
    await useSettingsStore.getState().updateSetting('taskListCollapsed', true)

    expect(lastSavedBlob().autoSignIn).toEqual(configured)
  })

  it('sanitizes a malformed persisted autoSignIn instead of trusting localStorage', async () => {
    localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: { autoSignIn: { enabled: true, codeServerUrl: 'not a url', codeTimeoutSeconds: 1 } },
        version: 0
      })
    )

    await useSettingsStore.persist.rehydrate()

    expect(useSettingsStore.getState().autoSignIn).toEqual({
      enabled: false,
      codeServerUrl: 'not a url',
      apiToken: '',
      codeTimeoutSeconds: 15
    })
  })
})
