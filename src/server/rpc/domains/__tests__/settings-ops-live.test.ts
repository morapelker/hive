import { Effect } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeLiveSettingsOpsRpcService } from '../settings-ops'
import { APP_SETTINGS_DB_KEY } from '../../../../shared/types/settings'

const mocks = vi.hoisted(() => ({
  settingsValue: JSON.stringify({
    customProjectCommands: [{ id: 'old-cmd', name: 'Old command', prompt: 'Old prompt' }]
  }),
  setSetting: vi.fn(),
  loadCustomCommandsFromFile: vi.fn()
}))

vi.mock('../../../../main/db', () => ({
  getDatabase: () => ({
    getSetting: () => mocks.settingsValue,
    setSetting: mocks.setSetting
  })
}))

vi.mock('../../../../main/services/custom-commands-file-service', () => ({
  getCustomCommandsFilePath: vi.fn(() => '/Users/mor/.hive/custom-commands.json'),
  loadCustomCommandsFromFile: mocks.loadCustomCommandsFromFile
}))

describe('live settings ops custom command reload', () => {
  beforeEach(() => {
    mocks.settingsValue = JSON.stringify({
      customProjectCommands: [{ id: 'old-cmd', name: 'Old command', prompt: 'Old prompt' }]
    })
    mocks.setSetting.mockReset()
    mocks.loadCustomCommandsFromFile.mockReset()
  })

  it('persists an empty custom command file to the settings DB', async () => {
    mocks.loadCustomCommandsFromFile.mockReturnValue({ success: true, commands: [], mtime: 123 })

    const result = await Effect.runPromise(makeLiveSettingsOpsRpcService().reloadCustomCommands())

    expect(result).toEqual({ success: true, count: 0, mtime: 123 })
    expect(mocks.setSetting).toHaveBeenCalledWith(
      APP_SETTINGS_DB_KEY,
      JSON.stringify({ customProjectCommands: [] })
    )
  })
})
