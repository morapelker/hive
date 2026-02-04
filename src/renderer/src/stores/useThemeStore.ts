import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export type Theme = 'dark' | 'light' | 'system'

const THEME_SETTING_KEY = 'user_theme'

interface ThemeState {
  theme: Theme
  isLoading: boolean
  setTheme: (theme: Theme) => void
  cycleTheme: () => void
  getEffectiveTheme: () => 'dark' | 'light'
  loadFromDatabase: () => Promise<void>
}

const getSystemTheme = (): 'dark' | 'light' => {
  if (typeof window !== 'undefined') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'dark'
}

// Save theme to SQLite database
async function saveThemeToDatabase(theme: Theme): Promise<void> {
  try {
    if (typeof window !== 'undefined' && window.db?.setting) {
      await window.db.setting.set(THEME_SETTING_KEY, theme)
    }
  } catch (error) {
    console.error('Failed to save theme to database:', error)
  }
}

// Load theme from SQLite database
async function loadThemeFromDatabase(): Promise<Theme | null> {
  try {
    if (typeof window !== 'undefined' && window.db?.setting) {
      const value = await window.db.setting.get(THEME_SETTING_KEY)
      if (value && ['dark', 'light', 'system'].includes(value)) {
        return value as Theme
      }
    }
  } catch (error) {
    console.error('Failed to load theme from database:', error)
  }
  return null
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: 'dark',
      isLoading: true,

      setTheme: (theme: Theme) => {
        set({ theme })
        applyTheme(theme)
        // Persist to SQLite database (async, don't await)
        saveThemeToDatabase(theme)
      },

      cycleTheme: () => {
        const themes: Theme[] = ['dark', 'light', 'system']
        const currentIndex = themes.indexOf(get().theme)
        const nextTheme = themes[(currentIndex + 1) % themes.length]
        get().setTheme(nextTheme)
      },

      getEffectiveTheme: () => {
        const { theme } = get()
        if (theme === 'system') {
          return getSystemTheme()
        }
        return theme
      },

      loadFromDatabase: async () => {
        const dbTheme = await loadThemeFromDatabase()
        if (dbTheme) {
          set({ theme: dbTheme, isLoading: false })
          applyTheme(dbTheme)
        } else {
          // No theme in database, use current (from localStorage) and save it
          const currentTheme = get().theme
          set({ isLoading: false })
          await saveThemeToDatabase(currentTheme)
        }
      },
    }),
    {
      name: 'hive-theme',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ theme: state.theme }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          // Apply theme from localStorage first for fast loading (no flicker)
          applyTheme(state.theme)
        }
      },
    }
  )
)

function applyTheme(theme: Theme): void {
  const root = window.document.documentElement
  root.classList.remove('light', 'dark')

  if (theme === 'system') {
    const systemTheme = getSystemTheme()
    root.classList.add(systemTheme)
  } else {
    root.classList.add(theme)
  }
}

// Initialize theme and listen for system changes
if (typeof window !== 'undefined') {
  // Apply theme from localStorage immediately (fast, prevents flicker)
  const storedTheme = localStorage.getItem('hive-theme')
  if (storedTheme) {
    try {
      const parsed = JSON.parse(storedTheme)
      if (parsed.state?.theme) {
        applyTheme(parsed.state.theme)
      }
    } catch {
      applyTheme('dark')
    }
  } else {
    applyTheme('dark')
  }

  // Then load from database (source of truth) once IPC is ready
  // This is called from App.tsx on mount to ensure proper timing
  setTimeout(() => {
    useThemeStore.getState().loadFromDatabase()
  }, 100)

  // Listen for system theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const state = useThemeStore.getState()
    if (state.theme === 'system') {
      applyTheme('system')
    }
  })
}
