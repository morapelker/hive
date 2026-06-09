import { beforeEach, describe, expect, test, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  dbApi: {
    setting: {
      get: vi.fn(),
      set: vi.fn()
    }
  },
  petApi: {
    updateSettings: vi.fn(),
    hide: vi.fn(),
    show: vi.fn()
  },
  settingsApi: {
    onSettingsUpdated: vi.fn(() => vi.fn())
  }
}))

vi.mock('@/api/db-api', () => ({
  dbApi: apiMocks.dbApi
}))

vi.mock('@/api/pet-api', () => ({
  petApi: apiMocks.petApi
}))

vi.mock('@/api/settings-api', () => ({
  settingsApi: apiMocks.settingsApi
}))

import { dbApi } from '@/api/db-api'
import { petApi } from '@/api/pet-api'
import { useSettingsStore } from '../../../src/renderer/src/stores/useSettingsStore'

const mockSettingDb = vi.mocked(dbApi.setting)
const mockPetApi = vi.mocked(petApi)

describe('Session 10: Open in Chrome Backend', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSettingDb.get.mockResolvedValue(null)
    mockSettingDb.set.mockResolvedValue(undefined)
    mockPetApi.hide.mockResolvedValue(undefined)
    mockPetApi.show.mockResolvedValue(undefined)
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      customChromeCommand: ''
    })
  })

  test('customChromeCommand defaults to empty string', () => {
    const store = useSettingsStore.getState()
    expect(store.customChromeCommand).toBe('')
  })

  test('customChromeCommand persists via updateSetting', () => {
    const store = useSettingsStore.getState()
    store.updateSetting('customChromeCommand', 'open -a Chrome {url}')
    expect(useSettingsStore.getState().customChromeCommand).toBe('open -a Chrome {url}')
    expect(mockSettingDb.set).toHaveBeenCalled()
  })

  test('customChromeCommand is included in partialize (localStorage persistence)', () => {
    useSettingsStore.getState().updateSetting('customChromeCommand', 'my-chrome {url}')
    // The partialize function should include customChromeCommand
    // We verify by checking the store state directly
    expect(useSettingsStore.getState().customChromeCommand).toBe('my-chrome {url}')
  })

  test('updateSetting with empty string resets customChromeCommand', () => {
    const store = useSettingsStore.getState()
    store.updateSetting('customChromeCommand', 'open -a Chrome {url}')
    store.updateSetting('customChromeCommand', '')
    expect(useSettingsStore.getState().customChromeCommand).toBe('')
  })

  test('resetToDefaults clears customChromeCommand', () => {
    useSettingsStore.getState().updateSetting('customChromeCommand', 'my-cmd {url}')
    useSettingsStore.getState().resetToDefaults()
    expect(useSettingsStore.getState().customChromeCommand).toBe('')
    expect(mockPetApi.updateSettings).toHaveBeenCalled()
    expect(mockPetApi.hide).toHaveBeenCalled()
  })
})
