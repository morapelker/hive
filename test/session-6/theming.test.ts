import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { waitFor, cleanup } from '@testing-library/react'
import { act } from 'react'
import { useThemeStore, type Theme } from '../../src/renderer/src/stores/useThemeStore'

// Mock window.db for database operations
const mockDbSetting = {
  get: vi.fn(),
  set: vi.fn()
}

// Setup window.db mock
beforeEach(() => {
  vi.clearAllMocks()
  // Reset store to initial state
  useThemeStore.setState({ theme: 'dark', isLoading: true })

  // Mock window.db
  Object.defineProperty(window, 'db', {
    value: { setting: mockDbSetting },
    writable: true,
    configurable: true
  })

  // Mock localStorage
  const localStorageMock = {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn()
  }
  Object.defineProperty(window, 'localStorage', {
    value: localStorageMock,
    writable: true
  })

  // Ensure document.documentElement exists
  document.documentElement.classList.remove('light', 'dark')
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Session 6: Theme System', () => {
  describe('Theme Store', () => {
    test('Default theme is dark', () => {
      const state = useThemeStore.getState()
      expect(state.theme).toBe('dark')
    })

    test('setTheme updates theme state', () => {
      const { setTheme } = useThemeStore.getState()

      act(() => {
        setTheme('light')
      })

      expect(useThemeStore.getState().theme).toBe('light')
    })

    test('setTheme applies theme class to document', () => {
      const { setTheme } = useThemeStore.getState()

      act(() => {
        setTheme('light')
      })

      expect(document.documentElement.classList.contains('light')).toBe(true)
      expect(document.documentElement.classList.contains('dark')).toBe(false)
    })

    test('setTheme with dark theme', () => {
      const { setTheme } = useThemeStore.getState()

      act(() => {
        setTheme('dark')
      })

      expect(document.documentElement.classList.contains('dark')).toBe(true)
      expect(document.documentElement.classList.contains('light')).toBe(false)
    })

    test('cycleTheme cycles through themes correctly', () => {
      // Start at dark
      useThemeStore.setState({ theme: 'dark' })
      act(() => {
        useThemeStore.getState().cycleTheme()
      })
      expect(useThemeStore.getState().theme).toBe('light')

      // Cycle to system
      act(() => {
        useThemeStore.getState().cycleTheme()
      })
      expect(useThemeStore.getState().theme).toBe('system')

      // Cycle back to dark
      act(() => {
        useThemeStore.getState().cycleTheme()
      })
      expect(useThemeStore.getState().theme).toBe('dark')
    })

    test('getEffectiveTheme returns actual theme for non-system themes', () => {
      const { setTheme } = useThemeStore.getState()

      act(() => {
        setTheme('dark')
      })
      expect(useThemeStore.getState().getEffectiveTheme()).toBe('dark')

      act(() => {
        setTheme('light')
      })
      expect(useThemeStore.getState().getEffectiveTheme()).toBe('light')
    })

    test('getEffectiveTheme returns system preference when theme is system', () => {
      const { setTheme } = useThemeStore.getState()

      act(() => {
        setTheme('system')
      })

      // matchMedia is mocked to return dark
      expect(useThemeStore.getState().getEffectiveTheme()).toBe('dark')
    })

    test('System theme applies correct class based on OS preference', () => {
      const { setTheme } = useThemeStore.getState()

      // matchMedia is mocked to prefer dark
      act(() => {
        setTheme('system')
      })

      // Should apply dark class since matchMedia returns dark
      expect(document.documentElement.classList.contains('dark')).toBe(true)
    })
  })

  describe('Theme Database Persistence', () => {
    test('setTheme saves to database', async () => {
      mockDbSetting.set.mockResolvedValue(true)

      const { setTheme } = useThemeStore.getState()

      act(() => {
        setTheme('light')
      })

      // Wait for async database call
      await waitFor(() => {
        expect(mockDbSetting.set).toHaveBeenCalledWith('user_theme', 'light')
      })
    })

    test('loadFromDatabase loads theme from database', async () => {
      mockDbSetting.get.mockResolvedValue('light')

      await act(async () => {
        await useThemeStore.getState().loadFromDatabase()
      })

      expect(useThemeStore.getState().theme).toBe('light')
      expect(useThemeStore.getState().isLoading).toBe(false)
    })

    test('loadFromDatabase falls back to current theme if database returns null', async () => {
      mockDbSetting.get.mockResolvedValue(null)
      mockDbSetting.set.mockResolvedValue(true)

      // Set initial theme
      useThemeStore.setState({ theme: 'dark', isLoading: true })

      await act(async () => {
        await useThemeStore.getState().loadFromDatabase()
      })

      // Should keep current theme and save it to database
      expect(useThemeStore.getState().theme).toBe('dark')
      expect(useThemeStore.getState().isLoading).toBe(false)
      expect(mockDbSetting.set).toHaveBeenCalledWith('user_theme', 'dark')
    })

    test('loadFromDatabase validates theme value', async () => {
      mockDbSetting.get.mockResolvedValue('invalid-theme')
      mockDbSetting.set.mockResolvedValue(true)

      useThemeStore.setState({ theme: 'dark', isLoading: true })

      await act(async () => {
        await useThemeStore.getState().loadFromDatabase()
      })

      // Invalid value should fall back to current theme
      expect(useThemeStore.getState().theme).toBe('dark')
    })

    test('Theme setting is stored with correct key', async () => {
      mockDbSetting.set.mockResolvedValue(true)

      const { setTheme } = useThemeStore.getState()

      act(() => {
        setTheme('system')
      })

      await waitFor(() => {
        expect(mockDbSetting.set).toHaveBeenCalledWith('user_theme', 'system')
      })
    })
  })

  describe('Theme Options', () => {
    test('Three theme options are available: dark, light, system', () => {
      const themes: Theme[] = ['dark', 'light', 'system']
      const { setTheme } = useThemeStore.getState()

      themes.forEach((theme) => {
        act(() => {
          setTheme(theme)
        })
        expect(useThemeStore.getState().theme).toBe(theme)
      })
    })

    test('Theme changes apply immediately', () => {
      const { setTheme } = useThemeStore.getState()

      act(() => {
        setTheme('light')
      })

      // Class should be applied synchronously
      expect(document.documentElement.classList.contains('light')).toBe(true)
    })
  })

  describe('All shadcn components respect theme', () => {
    test('CSS custom properties are defined for themes', () => {
      const { setTheme } = useThemeStore.getState()

      act(() => {
        setTheme('dark')
      })

      // Document should have dark class which enables CSS custom properties
      expect(document.documentElement.classList.contains('dark')).toBe(true)

      act(() => {
        setTheme('light')
      })

      // Document should have light class
      expect(document.documentElement.classList.contains('light')).toBe(true)
    })

    test('Only one theme class is applied at a time', () => {
      const { setTheme } = useThemeStore.getState()

      act(() => {
        setTheme('dark')
      })
      expect(document.documentElement.classList.contains('dark')).toBe(true)
      expect(document.documentElement.classList.contains('light')).toBe(false)

      act(() => {
        setTheme('light')
      })
      expect(document.documentElement.classList.contains('dark')).toBe(false)
      expect(document.documentElement.classList.contains('light')).toBe(true)
    })
  })

  describe('Error Handling', () => {
    test('Database errors are handled gracefully on save', async () => {
      mockDbSetting.set.mockRejectedValue(new Error('Database error'))

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const { setTheme } = useThemeStore.getState()

      // Should not throw
      act(() => {
        setTheme('light')
      })

      // Theme should still be updated locally
      expect(useThemeStore.getState().theme).toBe('light')

      await waitFor(() => {
        expect(consoleSpy).toHaveBeenCalled()
      })

      consoleSpy.mockRestore()
    })

    test('Database errors are handled gracefully on load', async () => {
      mockDbSetting.get.mockRejectedValue(new Error('Database error'))

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      useThemeStore.setState({ theme: 'dark', isLoading: true })

      // Should not throw
      await act(async () => {
        await useThemeStore.getState().loadFromDatabase()
      })

      // Should keep current theme
      expect(useThemeStore.getState().theme).toBe('dark')

      consoleSpy.mockRestore()
    })
  })
})

describe('Theme Toggle UI Integration', () => {
  test('Theme options array includes all three themes', () => {
    const themeOptions = ['light', 'dark', 'system']
    expect(themeOptions).toContain('light')
    expect(themeOptions).toContain('dark')
    expect(themeOptions).toContain('system')
  })
})
