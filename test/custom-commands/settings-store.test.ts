// test/custom-commands/settings-store.test.ts

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type { CustomProjectCommand } from '@/lib/custom-commands'

describe('Settings Store - Custom Project Commands', () => {
  beforeEach(() => {
    // Reset store to defaults before each test
    useSettingsStore.setState(useSettingsStore.getState())
    // Clear any previous console.warn spies
    vi.restoreAllMocks()
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

  it('should filter out invalid commands during settings load', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Mock the database to return settings with mixed valid/invalid commands
    const mockDb = {
      setting: {
        get: vi.fn().mockResolvedValue(
          JSON.stringify({
            customProjectCommands: [
              { id: 'valid-1', name: 'Valid Command', prompt: 'Test prompt' },
              { id: 'invalid-1', name: '', prompt: 'Test prompt' }, // Invalid: empty name
              { id: 'valid-2', name: 'Another Valid', prompt: 'Another prompt' },
              { id: 123, name: 'Invalid ID', prompt: 'Test prompt' }, // Invalid: non-string id
              null, // Invalid: null command
              { id: 'invalid-2', name: 'No Prompt' } // Invalid: missing prompt
            ]
          })
        ),
        set: vi.fn()
      }
    }

    // Temporarily override window.db
    const originalDb = (window as any).db
    ;(window as any).db = mockDb

    try {
      // Load settings from database
      await useSettingsStore.getState().loadFromDatabase()

      // Verify only valid commands were loaded
      const state = useSettingsStore.getState()
      expect(state.customProjectCommands).toHaveLength(2)
      expect(state.customProjectCommands[0].id).toBe('valid-1')
      expect(state.customProjectCommands[1].id).toBe('valid-2')

      // Verify console.warn was called for invalid commands
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Invalid custom command filtered during settings load:',
        expect.any(Array)
      )
    } finally {
      // Restore original window.db
      ;(window as any).db = originalDb
      consoleWarnSpy.mockRestore()
    }
  })

  it('should set customProjectCommands to empty array if not an array', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Mock the database to return settings with non-array customProjectCommands
    const mockDb = {
      setting: {
        get: vi.fn().mockResolvedValue(
          JSON.stringify({
            customProjectCommands: 'not-an-array'
          })
        ),
        set: vi.fn()
      }
    }

    // Temporarily override window.db
    const originalDb = (window as any).db
    ;(window as any).db = mockDb

    try {
      // Load settings from database
      await useSettingsStore.getState().loadFromDatabase()

      // Verify customProjectCommands was set to empty array
      const state = useSettingsStore.getState()
      expect(state.customProjectCommands).toEqual([])

      // Verify console.warn was called
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'customProjectCommands is not an array, setting to empty array'
      )
    } finally {
      // Restore original window.db
      ;(window as any).db = originalDb
      consoleWarnSpy.mockRestore()
    }
  })
})
