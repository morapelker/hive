// test/custom-commands/settings-store.test.ts

import { describe, it, expect, beforeEach } from 'vitest'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type { CustomProjectCommand } from '@/lib/custom-commands'

describe('Settings Store - Custom Project Commands', () => {
  beforeEach(() => {
    // Reset store to defaults before each test
    useSettingsStore.setState(useSettingsStore.getState())
  })

  it('should load empty customProjectCommands array by default', () => {
    const state = useSettingsStore.getState()
    expect(state.customProjectCommands).toBeDefined()
    expect(state.customProjectCommands).toEqual([])
  })

  it('should store and retrieve custom project commands', () => {
    const testCommands: CustomProjectCommand[] = [
      {
        id: 'cmd-1',
        name: 'Test Command 1',
        prompt: 'Do something with {{project.name}}'
      },
      {
        id: 'cmd-2',
        name: 'Test Command 2',
        prompt: 'Analyze {{project.path}}'
      }
    ]

    // Set custom commands
    useSettingsStore.setState({ customProjectCommands: testCommands })

    // Retrieve and verify
    const state = useSettingsStore.getState()
    expect(state.customProjectCommands).toEqual(testCommands)
    expect(state.customProjectCommands).toHaveLength(2)
    expect(state.customProjectCommands[0].name).toBe('Test Command 1')
  })
})
